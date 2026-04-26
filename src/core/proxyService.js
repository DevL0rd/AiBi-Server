import { EventEmitter } from "node:events";
import crypto from "node:crypto";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import tls from "node:tls";
import { buildHttpMessage, decodeBody, encodeHeaders, HttpInspector, parseHttpMessages } from "./httpTools.js";
import {
  buildActionResponse,
  buildChatModeResponse,
  buildProactiveChatResponse,
  buildRecognizeResponse,
  buildSpeakResponse,
  parseRequestLine,
  parseResponseJson,
  responseBuffer,
  summarizeDetectIntent,
} from "./aibiProtocol.js";
import { DnsService } from "./dnsService.js";
import { getCapabilities } from "./capabilities.js";

const POWER_ON_TEXT = "Hi.";

export class ProxyService extends EventEmitter {
  constructor({ rootDir, getSettings, store, openRouter, fishAudio }) {
    super();
    this.rootDir = rootDir;
    this.getSettings = getSettings;
    this.store = store;
    this.openRouter = openRouter;
    this.fishAudio = fishAudio;
    this.tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "aibi-server-"));
    this.firmwareDir = path.join(rootDir, "firmware");
    this.chatMediaDir = path.join(rootDir, "chat-media");
    this.pendingTtsStreams = new Map();
    this.ttsLogTargets = new Map();
    this.pendingTtsMedia = new Map();
    this.chatHistory = this.store.getChatMessages().map(chatMessageToHistoryItem).filter(Boolean).slice(-24);
    this.chatMode = false;
    this.nextConnectionId = 1;
    this.servers = [];
    this.dns = new DnsService({
      emit: (event) => this.emit("dns_event", event),
    });
    fs.mkdirSync(this.firmwareDir, { recursive: true });
    fs.mkdirSync(this.chatMediaDir, { recursive: true });
  }

  async start() {
    if (this.servers.length) return { running: true };
    const settings = this.getSettings();
    const keyPath = path.join(this.rootDir, "aibi.key");
    const certPath = path.join(this.rootDir, "aibi.crt");
    if (!fs.existsSync(keyPath) || !fs.existsSync(certPath)) {
      throw new Error("Missing aibi.key or aibi.crt in the project root. Add them before starting the AIBI proxy.");
    }

    const key = fs.readFileSync(keyPath);
    const cert = fs.readFileSync(certPath);

    const tlsServer = tls.createServer({ key, cert, minVersion: "TLSv1.2" }, (socket) => {
      const upstream = tls.connect({
        host: "api.aibipocket.com",
        port: 443,
        servername: "api.aibipocket.com",
        minVersion: "TLSv1.2",
      });
      this.wireConnection({ client: socket, upstream, scheme: "https" });
    });

    const httpServer = net.createServer((socket) => {
      this.wireHttpConnection(socket);
    });

    await Promise.all([
      listen(tlsServer, Number(settings.tlsPort || 443), "0.0.0.0"),
      listen(httpServer, Number(settings.httpPort || 80), "0.0.0.0"),
    ]);

    this.servers = [tlsServer, httpServer];
    try {
      await this.dns.start();
    } catch (error) {
      this.emit("dns_event", {
        type: "warning",
        title: "DNS server did not start",
        detail: error.message,
        payload: { message: error.message, code: error.code },
      });
    }
    this.emit("status", { running: true });
    return { running: true };
  }

  async stop() {
    await this.dns.stop();
    await Promise.all(this.servers.map((server) => closeServer(server)));
    this.servers = [];
    fs.rmSync(this.tempDir, { recursive: true, force: true });
    this.tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "aibi-server-"));
    this.emit("status", { running: false });
    return { running: false };
  }

  wireConnection({ client, upstream, scheme }) {
    const id = this.nextConnectionId++;
    const context = { id, scheme, pendingRequests: [] };
    const clientInspector = new HttpInspector({ id, side: "client", bodyDir: this.tempDir, emit: (event) => this.handleObservedEvent(context, event) });
    const upstreamInspector = new HttpInspector({ id, side: "upstream", bodyDir: this.tempDir, emit: (event) => this.handleObservedEvent(context, event) });

    this.emit("connection", { id, scheme, remote: `${client.remoteAddress}:${client.remotePort}` });

    client.on("data", async (chunk) => {
      clientInspector.push(chunk);
      if (this.getSettings().mode !== "local") {
        context.passthroughClientBuffer = Buffer.concat([context.passthroughClientBuffer || Buffer.alloc(0), chunk]);
        const parsed = parseHttpMessages(context.passthroughClientBuffer);
        context.passthroughClientBuffer = parsed.remainder;
        for (const request of parsed.messages) {
          const { method, target } = parseRequestLine(request.startLine);
          const localFirmwareResponse = await this.buildLocalFirmwareEndpointResponse({ request, target, method });
          if (localFirmwareResponse && isLocalOtaResponseTarget(target)) {
            client.end(localFirmwareResponse);
            continue;
          }
          if (method === "GET" && target.startsWith("/ota-blocked/")) {
            client.write(responseBuffer("HTTP/1.1 403 Forbidden", { errcode: 403, errmsg: "Firmware download blocked by local capture trap" }, { Connection: "close" }));
            continue;
          }
          context.passthroughRequests ||= [];
          const outboundRequest = this.rewriteOutgoingOtaRequest(request) || request;
          context.passthroughRequests.push(outboundRequest);
          if (!upstream.destroyed) upstream.write(outboundRequest.raw);
        }
        return;
      }

      context.clientBuffer = Buffer.concat([context.clientBuffer || Buffer.alloc(0), chunk]);
      const parsed = parseHttpMessages(context.clientBuffer);
      context.clientBuffer = parsed.remainder;

      for (const request of parsed.messages) {
        const { method, target } = parseRequestLine(request.startLine);
        if (method === "POST" && target.startsWith("/aibi/voice/detectintent")) {
          const response = await this.buildLocalDetectIntentResponse({ request, target });
          if (response) client.write(response);
          else if (!upstream.destroyed) upstream.write(request.raw);
        } else if (method === "GET" && target.startsWith("/aibi/chat/start")) {
          const response = await this.buildLocalProactiveResponse({ target });
          client.write(response);
        } else {
          const response = await this.buildLocalFirmwareEndpointResponse({ request, target, method });
          if (response) client.write(response);
          else if (!upstream.destroyed) upstream.write(request.raw);
        }
      }
    });

    upstream.on("data", (chunk) => {
      upstreamInspector.push(chunk);
      if (client.destroyed) return;
      if (this.getSettings().mode === "passthrough") {
        context.passthroughUpstreamBuffer = Buffer.concat([context.passthroughUpstreamBuffer || Buffer.alloc(0), chunk]);
        const parsed = parseHttpMessages(context.passthroughUpstreamBuffer);
        context.passthroughUpstreamBuffer = parsed.remainder;
        for (const response of parsed.messages) {
          const request = context.passthroughRequests?.shift();
          const rewritten = this.rewriteOtaResponse({ request, response });
          client.write(rewritten || response.raw);
        }
        return;
      }
      client.write(chunk);
    });

    client.on("error", (error) => this.emit("proxy_error", { id, side: "client", message: error.message }));
    upstream.on("error", (error) => this.emit("proxy_error", { id, side: "upstream", message: error.message }));
    client.on("end", () => upstream.end());
    upstream.on("end", () => client.end());
    client.on("close", () => upstream.destroy());
    upstream.on("close", () => client.destroy());
  }

  wireHttpConnection(client) {
    const id = this.nextConnectionId++;
    const context = { id, scheme: "http" };
    const clientInspector = new HttpInspector({ id, side: "client", bodyDir: this.tempDir, emit: (event) => this.handleObservedEvent(context, event) });
    const upstreamInspector = new HttpInspector({ id, side: "upstream", bodyDir: this.tempDir, emit: (event) => this.handleObservedEvent(context, event) });
    let clientBuffer = Buffer.alloc(0);
    const upstream = net.connect({ host: "api.aibipocket.com", port: 80 });

    this.emit("connection", { id, scheme: "http", remote: `${client.remoteAddress}:${client.remotePort}` });

    client.on("data", async (chunk) => {
      clientInspector.push(chunk);
      clientBuffer = Buffer.concat([clientBuffer, chunk]);
      const parsed = parseHttpMessages(clientBuffer);
      clientBuffer = parsed.remainder;
      for (const request of parsed.messages) {
        const { method, target } = parseRequestLine(request.startLine);
        const mediaDownload = target.match(/^\/(?:tts|poweron)\/dl\/(.+)/);
        const localFirmwareResponse = await this.buildLocalFirmwareEndpointResponse({ request, target, method });
        if (localFirmwareResponse && isLocalOtaResponseTarget(target)) {
          client.end(localFirmwareResponse);
        } else if (method === "GET" && target.startsWith("/ota-blocked/")) {
          client.write(responseBuffer("HTTP/1.1 403 Forbidden", { errcode: 403, errmsg: "Firmware download blocked by local capture trap" }, { Connection: "close" }));
        } else if (this.getSettings().mode === "local" && method === "GET" && mediaDownload) {
          this.serveLocalTts(client, mediaDownload[1]);
        } else if (this.getSettings().mode === "local") {
          const response = await this.buildLocalFirmwareEndpointResponse({ request, target, method });
          if (response) client.write(response);
          else upstream.write(request.raw);
        } else if (!upstream.destroyed) {
          upstream.write(request.raw);
        }
      }
    });

    upstream.on("data", (chunk) => {
      upstreamInspector.push(chunk);
      if (client.destroyed) return;
      if (this.getSettings().mode === "passthrough") {
        context.passthroughUpstreamBuffer = Buffer.concat([context.passthroughUpstreamBuffer || Buffer.alloc(0), chunk]);
        const parsed = parseHttpMessages(context.passthroughUpstreamBuffer);
        context.passthroughUpstreamBuffer = parsed.remainder;
        for (const response of parsed.messages) {
          const request = context.passthroughRequests?.shift();
          const rewritten = this.rewriteOtaResponse({ request, response });
          client.write(rewritten || response.raw);
        }
        return;
      }
      client.write(chunk);
    });

    client.on("error", (error) => this.emit("proxy_error", { id, side: "client", message: error.message }));
    upstream.on("error", (error) => this.emit("proxy_error", { id, side: "upstream", message: error.message }));
    client.on("end", () => upstream.end());
    upstream.on("end", () => client.end());
    client.on("close", () => upstream.destroy());
    upstream.on("close", () => client.destroy());
  }

  handleObservedEvent(context, event) {
    if (event.side === "client" && event.kind === "request") context.pendingRequests?.push(event);
    const matchedRequest = event.side === "upstream" && event.kind === "response" ? context.pendingRequests?.shift() : null;
    const storedEvent = this.recordHttpEvent(event);
    if (storedEvent) this.emit("stored_event", storedEvent);
    this.emit("http_message", event);

    if (event.side === "client" && event.kind === "request" && event.startLine.includes("/aibi/voice/detectintent")) {
      const { target } = parseRequestLine(event.startLine);
      const query = new URL(`http://local${target}`).searchParams;
      const isChatTurn = query.get("role") === "chatgpt";
      this.emit("conversation", {
        type: "voice_request",
        title: isChatTurn ? "Conversation turn" : "Listening",
        detail: isChatTurn ? "No wake word needed" : "Voice request received",
        payload: { connectionId: event.connectionId, chatMode: isChatTurn },
      });
    }

    if (event.side === "upstream" && event.kind === "response" && event.body?.kind === "text") {
      const json = parseResponseJson(Buffer.from(event.body.text));

      if (matchedRequest?.startLine.includes("/aibi/chat/start") && json?.url) {
        this.emit("conversation", {
          type: "proactive_reachout",
          title: "Proactive reachout",
          detail: "AIBI started a conversation",
          payload: { ttsUrl: json.url, responseTag: json.responsetag || "", request: matchedRequest.startLine },
        });
        return;
      }

      if (json?.queryResult) {
        const summary = summarizeDetectIntent(json);
        const chatEvent = getChatModeEvent(summary);
        if (chatEvent) {
          this.emit("conversation", chatEvent);
          return;
        }
        this.emit("conversation", {
          type: summary.behavior === "interact_speak" ? "speech_response" : "action",
          title: summary.behavior === "interact_speak" ? summary.responseText || "Speech response" : summary.behavior,
          detail: summary.queryText,
          payload: summary,
        });
      }
    }
  }

  rewriteOutgoingOtaRequest(request) {
    const startLine = rewriteOtaRequestStartLine(request.startLine);
    if (!startLine || startLine === request.startLine) return null;
    const raw = Buffer.concat([Buffer.from(encodeHeaders(startLine, request.headers), "utf8"), request.body]);
    this.store.addEvent({
      type: "firmware_capture",
      title: "OTA request rewritten",
      detail: `${request.startLine} -> ${startLine}`,
      payload: {
        original: request.startLine,
        rewritten: startLine,
      },
    });
    return { ...request, startLine, raw };
  }

  rewriteOtaResponse({ request, response }) {
    if (!isOtaResponseTarget(request?.startLine || "")) return null;
    const contentType = response.headers["content-type"] || "";
    if (!contentType.toLowerCase().includes("json")) return null;

    let json = null;
    try {
      json = JSON.parse(decodeBody(response.body, response.headers["content-encoding"] || "").toString("utf8"));
    } catch (error) {
      this.emit("proxy_error", { id: "ota", side: "capture", message: `OTA response parse failed: ${error.message}` });
      return null;
    }

    const urls = collectUrls(json);
    for (const firmwareUrl of urls) this.downloadFirmwareUrl({ firmwareUrl, request });
    const localFirmware = this.getPatchedFirmware();
    const rewritten = localFirmware
      ? rewriteOtaJsonToPatchedFirmware(json, localFirmware)
      : cloneAndRewriteUrls(json, (firmwareUrl) => {
        const encoded = Buffer.from(firmwareUrl, "utf8").toString("base64url");
        return `http://api.aibipocket.com/ota-blocked/${encoded}`;
      });

    this.store.addEvent({
      type: "firmware_capture",
      title: localFirmware ? "OTA response replaced" : "OTA response trapped",
      detail: localFirmware ? `Serving ${localFirmware.relativePath}` : (urls.length ? `${urls.length} firmware URL(s) captured and hidden from AIBI` : "OTA response captured; no firmware URL found"),
      payload: {
        request: request.startLine,
        urls,
        original: json,
        rewritten,
      },
    });

    const headers = { ...response.headers };
    delete headers["content-encoding"];
    delete headers["transfer-encoding"];
    return buildHttpMessage(response.startLine, headers, Buffer.from(JSON.stringify(rewritten), "utf8"));
  }

  getPatchedFirmware() {
    const metadata = this.getPatchedFirmwareMetadata();
    if (!metadata) return null;
    const filePath = metadata.filePath;
    if (!fs.existsSync(filePath)) return null;
    const bytes = fs.readFileSync(filePath);
    return {
      ...metadata,
      filePath,
      bytes,
      md5: crypto.createHash("md5").update(bytes).digest("hex"),
      relativePath: path.relative(this.rootDir, filePath),
    };
  }

  getPatchedFirmwareMetadata() {
    const patchedDir = path.join(this.firmwareDir, "patched");
    if (!fs.existsSync(patchedDir)) return null;
    const patchedZip = fs.readdirSync(patchedDir)
      .filter((name) => name.endsWith("-patched.zip"))
      .sort()
      .at(-1);
    if (!patchedZip) return null;

    const fallback = readJsonIfExists(path.join(patchedDir, "metadata.json"));
    const latest = readJsonIfExists(path.join(this.firmwareDir, "latest-firmware.json"));
    const update = latest?.update || fallback || {};
    const originalFirmwarePath = update.firmware || new URL(update.url || "https://local/aibi/version/public/0/unknown/unknown/firmware.zip").pathname;
    const urlPath = replacePathBasename(originalFirmwarePath, patchedZip);

    return {
      filePath: path.join(patchedDir, patchedZip),
      filename: patchedZip,
      urlPath,
      versionNum: String(update.versionNum || ""),
      versionName: String(update.versionName || patchedZip.replace(/-patched\.zip$/, "")),
      responseTag: String(update.responseTag || "otares"),
      original: update,
    };
  }

  async downloadFirmwareUrl({ firmwareUrl, request }) {
    try {
      const url = new URL(firmwareUrl);
      const headers = {};
      if (url.hostname === "api.aibipocket.com") {
        for (const name of ["authorization", "secret", "user-agent"]) {
          if (request.headers[name]) headers[name] = request.headers[name];
        }
      }
      const response = await fetch(firmwareUrl, { headers });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const bytes = Buffer.from(await response.arrayBuffer());
      const filename = firmwareFilename(url, response.headers.get("content-type") || "");
      const filePath = path.join(this.firmwareDir, filename);
      fs.writeFileSync(filePath, bytes);
      this.store.addEvent({
        type: "firmware_capture",
        title: "Firmware downloaded",
        detail: filePath,
        payload: {
          url: firmwareUrl,
          status: response.status,
          contentType: response.headers.get("content-type") || "",
          bytes: bytes.length,
          filePath,
        },
      });
    } catch (error) {
      this.emitDetailedError({ id: "ota", side: "firmware-download", error });
    }
  }

  recordHttpEvent(event) {
    try {
      if (event.type === "http_parse_error") {
        return this.store.addEvent({
          type: "warning",
          title: "HTTP parser skipped a message",
          detail: event.error,
          payload: event,
        });
      }

      const body = event.body;
      const detail = body?.kind === "text"
        ? body.text.slice(0, 500)
        : body?.filePath || "";
      return this.store.addEvent({
        type: "http_message",
        title: event.startLine,
        detail,
        payload: event,
      });
    } catch (error) {
      this.emit("proxy_error", { id: event.connectionId, side: "store", message: error.message });
    }
  }

  async buildLocalDetectIntentResponse({ request, target }) {
    const id = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
    const settings = this.getSettings();
    const query = new URL(`http://local${target}`).searchParams;
    const requestChatMode = query.get("role") === "chatgpt" || this.chatMode;
    const modelInfo = this.store.getOpenRouterModel(settings.openRouterModel);
    const preparedAudio = prepareAudio(request.body);
    const audioFormat = preparedAudio.format;
    const userMedia = preparedAudio.buffer?.length && audioFormat
      ? [this.saveChatMedia({
          buffer: preparedAudio.buffer,
          type: "audio",
          mimeType: audioMimeType(audioFormat),
          extension: audioFormat,
          label: "User",
        })]
      : [];

    if (requestChatMode && audioLooksSilent(request.body)) {
      const responseJson = await this.buildProtocolResponseFromIntent({
        intent: {
          speech: { text: "", listen: 0 },
          mode: { chat: "quit" },
          action: { behavior: "" },
          recognition: { enabled: false },
          animation: { pre: "", post: "", post_behavior: "" },
        },
        transcript: "",
        index: Number(query.get("index") || 0),
        modelInfo,
      });
      this.emit("conversation", {
        type: "chat_mode_end",
        title: "Chat mode ended",
        detail: "No speech detected",
        payload: summarizeDetectIntent(responseJson),
      });
      return responseBuffer("HTTP/1.1 200 OK", responseJson);
    }

    const capabilities = getCapabilities(this.getSettings());
    let transcript = "";
    let localError = false;
    let userContent = "";
    let intent = {
      speech: { text: settings.localTextFallback, listen: 0 },
      mode: { chat: "unchanged" },
      action: { behavior: "" },
      recognition: { enabled: false },
      animation: { pre: "", post: "", post_behavior: "" },
    };
    try {
      const turn = await this.openRouter.generateLocalIntent({
        audio: preparedAudio.buffer,
        audioFormat,
        capabilities,
        history: this.chatHistory,
        chatMode: requestChatMode,
        modelInfo,
        transcribeAudio: async ({ audio, audioFormat: format }) => {
          try {
            return await this.transcribeAudioBuffer({ id, audio, audioFormat: format });
          } catch (error) {
            this.emitDetailedError({ id, side: "fish-audio", error });
            return "";
          }
        },
      });
      intent = turn.intent;
      transcript = turn.inputText;
      userContent = formatChatContentForLog(turn.latestUserContent || turn.inputText);
    } catch (error) {
      localError = true;
      this.emitDetailedError({ id, side: "openrouter", error });
    }

    if (localError) {
      intent = requestChatMode
        ? { ...intent, speech: { text: "", listen: 0 }, mode: { chat: "quit" }, action: { behavior: "" }, recognition: { enabled: false }, animation: { pre: "", post: "", post_behavior: "" } }
        : { ...intent, speech: { text: "Error occurred.", listen: 0 } };
    }
    intent = coerceUpdateIntent(intent);

    const responseJson = await this.buildProtocolResponseFromIntent({
      intent,
      transcript,
      index: Number(query.get("index") || 0),
      modelInfo,
    });
    this.rememberTurn({ transcript, responseJson, userContent, userMedia });
    this.emit("conversation", {
      type: responseJson.queryResult?.rec_behavior === "interact_speak" ? "override_response" : "action",
      title: responseJson.queryResult?.behavior_paras?.txt || responseJson.queryResult?.rec_behavior || "Override response",
      detail: transcript || "Override generated a response",
      payload: summarizeDetectIntent(responseJson),
    });
    return responseBuffer("HTTP/1.1 200 OK", responseJson);
  }

  async buildLocalProactiveResponse() {
    const modelInfo = this.store.getOpenRouterModel(this.getSettings().openRouterModel);
    const capabilities = getCapabilities(this.getSettings());
    const stageDirections = ["You decided to proactively reach out to the user."];
    let intent = {
      speech: { text: "Hi, want to chat for a bit?", listen: 0 },
      mode: { chat: "unchanged" },
      action: { behavior: "" },
      recognition: { enabled: false },
      animation: { pre: "", post: "", post_behavior: "" },
    };
    try {
      const turn = await this.openRouter.generateLocalIntent({
        capabilities,
        history: this.chatHistory,
        chatMode: this.chatMode,
        modelInfo,
        stageDirections,
        responseMode: "speech",
      });
      intent = turn.intent;
    } catch (error) {
      this.emitDetailedError({ id: "proactive", side: "openrouter", error });
    }
    const text = intent.speech?.text || this.getSettings().localTextFallback || "Hi there.";
    const ttsUrl = await this.queueLocalTtsReady({ text, modelInfo });
    const responseJson = buildProactiveChatResponse({ ttsUrl });
    this.addChatTurn({ userContent: formatStageHistory(stageDirections), assistantText: text, assistantTtsUrl: ttsUrl });
    this.emit("conversation", {
      type: "proactive_reachout",
      title: "Proactive reachout",
      detail: text,
      payload: { ttsUrl, responseTag: "chatstart" },
    });
    return responseBuffer("HTTP/1.1 200 OK", responseJson);
  }

  async buildLocalFirmwareEndpointResponse({ request, target, method }) {
    const url = new URL(`http://local${target}`);
    const pathname = url.pathname;
    const settings = this.getSettings();
    const modelInfo = this.store.getOpenRouterModel(settings.openRouterModel);

    if (method === "GET" && pathname === "/aibi/permission") {
      return responseBuffer("HTTP/1.1 200 OK", okTagged("permission", { permission: true }));
    }

    if (method === "POST" && pathname === "/aibi/report/status") {
      this.emit("conversation", {
        type: "robot_status",
        title: "AIBI status",
        detail: summarizeStatusPayload(request.body, request.headers),
        payload: summarizeRequestBody(request.body, request.headers),
      });
      return responseBuffer("HTTP/1.1 200 OK", okTagged("status"));
    }

    if (method === "POST" && pathname === "/aibi/messages/send") {
      return responseBuffer("HTTP/1.1 200 OK", okTagged("sendmessage"));
    }

    if (method === "GET" && pathname === "/aibi/messages/receive") {
      return responseBuffer("HTTP/1.1 200 OK", okTagged("getmessage", { m_list: [] }));
    }

    if (method === "GET" && pathname === "/aibi/messages/confirm") {
      return responseBuffer("HTTP/1.1 200 OK", okTagged("get message"));
    }

    if (method === "GET" && pathname === "/aibi/poweron/voice") {
      const stageDirections = ["You just powered on again."];
      let text = POWER_ON_TEXT;
      if (settings.openRouterApiKey) {
        try {
          const turn = await this.openRouter.generateLocalIntent({
            capabilities: getCapabilities(this.getSettings()),
            history: this.chatHistory,
            chatMode: this.chatMode,
            modelInfo,
            stageDirections,
            responseMode: "speech",
          });
          text = turn.intent.speech?.text || text;
        } catch (error) {
          this.emitDetailedError({ id: "poweron", side: "openrouter", error });
        }
      }
      const ttsUrl = (await this.queueLocalTtsReady({ text, modelInfo })).replace("/tts/dl/", "/poweron/dl/");
      this.addChatTurn({ userContent: formatStageHistory(stageDirections), assistantText: text, assistantTtsUrl: ttsUrl });
      return responseBuffer("HTTP/1.1 200 OK", okTagged("poweronvoice", { url: ttsUrl }));
    }

    if (method === "GET" && pathname === "/aibi/speech/tts") {
      const text = url.searchParams.get("q") || settings.localTextFallback || "OK.";
      const ttsUrl = await this.queueLocalTtsReady({ text, modelInfo });
      return responseBuffer("HTTP/1.1 200 OK", okTagged("tts", { url: ttsUrl }));
    }

    const patchedFirmware = this.getPatchedFirmware();
    if (method === "GET" && patchedFirmware && pathname === patchedFirmware.urlPath) {
      this.store.addEvent({
        type: "firmware_capture",
        title: "Patched firmware served",
        detail: patchedFirmware.relativePath,
        payload: { path: patchedFirmware.relativePath, md5: patchedFirmware.md5, bytes: patchedFirmware.bytes.length },
      });
      return responseBuffer("HTTP/1.1 200 OK", patchedFirmware.bytes, {
        "Content-Type": "application/zip",
        "Content-Disposition": `attachment; filename="${patchedFirmware.filename}"`,
      });
    }

    if (method === "POST" && pathname === "/aibi/ai/imgrecog") {
      const imageMimeType = guessImageMimeType(request.body);
      const userMedia = request.body?.length
        ? [this.saveChatMedia({
            buffer: request.body,
            type: "image",
            mimeType: imageMimeType,
            extension: imageExtension(imageMimeType),
            label: "AIBI camera image",
          })]
        : [];
      const capabilities = getCapabilities(this.getSettings());
      const stageDirections = ["User sent a image."];
      let transcript = "";
      let userContent = "";
      let localError = false;
      let intent = {
        speech: { text: settings.localTextFallback, listen: 0 },
        mode: { chat: "unchanged" },
        action: { behavior: "" },
        recognition: { enabled: false },
        animation: { pre: "", post: "", post_behavior: "" },
      };

      try {
        const turn = await this.openRouter.generateLocalIntent({
          image: request.body,
          imageMimeType,
          capabilities,
          history: this.chatHistory,
          chatMode: this.chatMode,
          modelInfo,
          stageDirections,
          responseMode: "speech",
        });
        intent = turn.intent;
        transcript = turn.inputText;
        userContent = formatChatContentForLog(turn.latestUserContent || turn.inputText);
      } catch (error) {
        localError = true;
        this.emitDetailedError({ id: "image-recognition", side: "openrouter", error });
      }

      if (localError) {
        intent = this.chatMode
          ? { ...intent, speech: { text: "", listen: 0 }, mode: { chat: "quit" }, action: { behavior: "" }, recognition: { enabled: false }, animation: { pre: "", post: "", post_behavior: "" } }
          : { ...intent, speech: { text: "Error occurred.", listen: 0 } };
      }

      const responseJson = await this.buildImageRecognitionResponseFromIntent({
        intent,
        transcript,
        modelInfo,
      });
      this.rememberTurn({ transcript, responseJson, userContent, userMedia });
      this.emit("conversation", {
        type: responseJson.queryResult?.rec_behavior === "interact_speak" ? "override_response" : "action",
        title: responseJson.queryResult?.behavior_paras?.txt || responseJson.queryResult?.rec_behavior || "Image response",
        detail: "Image handled through the override path",
        payload: summarizeDetectIntent(responseJson),
      });
      return responseBuffer("HTTP/1.1 200 OK", responseJson);
    }

    if (method === "POST" && pathname === "/aibi/ai/rockpaper") {
      return null;
    }

    if (method === "GET" && pathname === "/aibi/ota/version") {
      if (!patchedFirmware) return null;
      return responseBuffer("HTTP/1.1 200 OK", buildPatchedOtaResponse(patchedFirmware));
    }

    return null;
  }

  async buildImageRecognitionResponseFromIntent({ intent, transcript, modelInfo }) {
    const text = intent.speech?.text || this.getSettings().localTextFallback || "I can't see much from that image.";
    const ttsUrl = await this.queueLocalTtsReady({ text, modelInfo });
    const response = buildSpeakResponse({
      text,
      ttsUrl,
      queryText: transcript,
      index: 0,
      listen: intent.speech?.listen || 0,
    });
    response.queryResult.intent = { name: "chatgpt_speak", confidence: 1 };
    response.queryResult.photo_type = "";
    delete response.index;
    return response;
  }

  async buildProtocolResponseFromIntent({ intent, transcript, index, modelInfo }) {
    if (intent.mode?.chat === "connect") {
      this.chatMode = true;
      return buildChatModeResponse({ type: "connect", queryText: transcript, index });
    }
    if (intent.mode?.chat === "quit") {
      this.chatMode = false;
      return buildChatModeResponse({ type: "quit", queryText: transcript, index });
    }
    if (intent.recognition?.enabled && !intent.speech?.text) {
      return buildRecognizeResponse({ queryText: transcript, index });
    }
    const actionAfterSpeech = this.getSettings().actionAfterSpeech;
    const postBehaviorNames = new Set(getCapabilities(this.getSettings()).native_animations.post_behavior);
    const canPostAction = actionAfterSpeech && postBehaviorNames.has(intent.action?.behavior);
    if (intent.action?.behavior && !canPostAction) {
      return buildActionResponse({ action: intent.action.behavior, params: actionParams(intent), queryText: transcript, index });
    }
    const params = actionParams(intent);
    const hasActionParams = !Array.isArray(params) && Object.keys(params).length > 0;
    if (intent.action?.behavior && intent.speech?.text && hasActionParams) {
      return buildActionResponse({ action: intent.action.behavior, params, queryText: transcript, index });
    }
    if (intent.speech?.text) {
      const ttsUrl = await this.queueLocalTtsReady({ text: intent.speech.text, modelInfo });
      return buildSpeakResponse({
        text: intent.speech.text,
        ttsUrl,
        queryText: transcript,
        index,
        preAnimation: intent.animation?.pre || "",
        postAnimation: intent.animation?.post || "",
        postBehavior: canPostAction ? intent.action?.behavior || intent.animation?.post_behavior || "" : intent.animation?.post_behavior || "",
        listen: intent.speech.listen || 0,
      });
    }
    if (intent.recognition?.enabled) return buildRecognizeResponse({ queryText: transcript, index });
    if (intent.action?.behavior) return buildActionResponse({ action: intent.action.behavior, params: actionParams(intent), queryText: transcript, index });
    const fallbackText = this.getSettings().localTextFallback;
    const fallbackTtsUrl = await this.queueLocalTtsReady({ text: fallbackText, modelInfo });
    return buildSpeakResponse({
      text: fallbackText,
      ttsUrl: fallbackTtsUrl,
      queryText: transcript,
      index,
    });
  }

  async queueLocalTtsReady({ text, modelInfo }) {
    const ttsId = `local-${crypto.randomUUID()}.mp3`;
    try {
      const stream = await this.openLocalTtsStream({ text, modelInfo });
      const iterator = toAsyncIterable(stream)[Symbol.asyncIterator]();
      const first = await withTimeout(iterator.next(), 15000);
      if (first.done) throw new Error("tts_stream_empty");
      this.pendingTtsStreams.set(ttsId, {
        iterator,
        firstChunk: Buffer.from(first.value),
        contentType: "audio/mpeg",
        expiresAt: Date.now() + 120000,
      });
    } catch (error) {
      this.emitDetailedError({ id: "tts", side: "fish-audio", error });
      this.pendingTtsStreams.set(ttsId, {
        error,
        contentType: "audio/mpeg",
        expiresAt: Date.now() + 120000,
      });
    }
    setTimeout(() => this.pendingTtsStreams.delete(ttsId), 120000).unref?.();
    return `http://api.aibipocket.com/tts/dl/${ttsId}`;
  }

  async openLocalTtsStream({ text }) {
    const audio = await this.fishAudio.synthesizeToStream({ text });
    if (!audio) throw new Error("tts_generation_failed");
    return audio;
  }

  async transcribeAudioBuffer({ id, audio, audioFormat }) {
    const extension = audioFormat || "bin";
    const sttPath = path.join(this.tempDir, `local-${id}.${extension}`);
    fs.writeFileSync(sttPath, audio);
    return this.fishAudio.transcribe(sttPath);
  }

  rememberTurn({ transcript, responseJson, userContent = "", userMedia = [] }) {
    const userText = userContent || transcript;
    if (userText || userMedia.length) this.addChatMessage("user", userText, { media: userMedia });
    const text = responseJson.queryResult?.behavior_paras?.txt;
    const ttsUrl = responseJson.queryResult?.behavior_paras?.url;
    if (text) this.addChatMessage("assistant", text, { ttsUrl }, ttsUrl);
  }

  addChatTurn({ userContent, assistantText, assistantTtsUrl = "", userMedia = [] }) {
    if (userContent || userMedia.length) this.addChatMessage("user", userContent, { media: userMedia });
    if (assistantText) this.addChatMessage("assistant", assistantText, { ttsUrl: assistantTtsUrl }, assistantTtsUrl);
  }

  addChatMessage(role, content, payload = {}, ttsUrl = "") {
    const row = this.store.addChatMessage({ role, content, payload });
    this.chatHistory.push(chatMessageToHistoryItem(row));
    this.trimChatHistory();
    this.emit("chat_message", row);
    const ttsId = ttsUrl ? path.basename(new URL(ttsUrl, "http://local").pathname) : "";
    if (ttsId) this.registerTtsLogTarget(ttsId, row.id);
    return row;
  }

  registerTtsLogTarget(ttsId, messageId) {
    this.ttsLogTargets.set(ttsId, messageId);
    const pending = this.pendingTtsMedia.get(ttsId);
    if (pending) {
      this.pendingTtsMedia.delete(ttsId);
      const media = this.saveChatMedia({
        buffer: pending.body,
        type: "audio",
        mimeType: pending.mimeType,
        extension: mediaExtension(pending.mimeType),
        label: "AIBI",
      });
      this.appendChatMessageMedia(messageId, media);
    }
  }

  trimChatHistory() {
    this.chatHistory = this.chatHistory.slice(-24);
  }

  refreshChatHistory() {
    this.chatHistory = this.store.getChatMessages().map(chatMessageToHistoryItem).filter(Boolean).slice(-24);
  }

  getChatLog() {
    return this.store.getChatMessages();
  }

  updateChatMessage(id, content) {
    const row = this.store.updateChatMessage(id, content);
    this.refreshChatHistory();
    if (row) this.emit("chat_message", row);
    return row;
  }

  deleteChatMessage(id) {
    const row = this.store.deleteChatMessage(id);
    if (row) {
      this.deleteChatMessageMedia(row);
      this.refreshChatHistory();
      this.emit("chat_message_deleted", { id: row.id });
    }
    return row;
  }

  clearChatLog() {
    const { rows, cleared } = this.store.clearChatMessages();
    for (const row of rows) this.deleteChatMessageMedia(row);
    fs.rmSync(this.chatMediaDir, { recursive: true, force: true });
    fs.mkdirSync(this.chatMediaDir, { recursive: true });
    this.chatHistory = [];
    this.ttsLogTargets.clear();
    this.pendingTtsMedia.clear();
    this.emit("chat_log_cleared", { cleared });
    return { cleared };
  }

  saveChatMedia({ buffer, type, mimeType, extension, label }) {
    const safeExtension = String(extension || mediaExtension(mimeType) || "bin").replace(/[^a-zA-Z0-9]/g, "") || "bin";
    const filename = `${Date.now()}-${crypto.randomUUID()}.${safeExtension}`;
    const filePath = path.join(this.chatMediaDir, filename);
    fs.writeFileSync(filePath, buffer);
    return {
      type,
      label,
      mimeType,
      path: `chat-media/${filename}`,
      bytes: buffer.length,
    };
  }

  captureTtsForChat(ttsId, body, mimeType) {
    const messageId = this.ttsLogTargets.get(ttsId);
    if (messageId) {
      const media = this.saveChatMedia({
        buffer: body,
        type: "audio",
        mimeType,
        extension: mediaExtension(mimeType),
        label: "AIBI",
      });
      this.appendChatMessageMedia(messageId, media);
      return;
    }
    this.pendingTtsMedia.set(ttsId, { body, mimeType });
    setTimeout(() => this.pendingTtsMedia.delete(ttsId), 120000).unref?.();
  }

  appendChatMessageMedia(messageId, media) {
    const row = this.store.getChatMessage(messageId);
    if (!row) return null;
    const payload = row.payload || {};
    payload.media = [...(payload.media || []), media];
    const updated = this.store.updateChatMessagePayload(messageId, payload);
    if (updated) this.emit("chat_message", updated);
    return updated;
  }

  deleteChatMessageMedia(row) {
    for (const media of row?.payload?.media || []) {
      this.deleteChatMediaFile(media.path);
    }
  }

  deleteChatMediaFile(relativePath) {
    const safePath = safeMediaPath(this.rootDir, relativePath);
    if (!safePath) return;
    fs.rmSync(safePath, { force: true });
  }

  getChatMedia(relativePath) {
    const safePath = safeMediaPath(this.rootDir, relativePath);
    if (!safePath || !fs.existsSync(safePath)) {
      throw new Error("chat_media_not_found");
    }
    const body = fs.readFileSync(safePath);
    return {
      contentType: mimeTypeFromPath(safePath),
      data: body.toString("base64"),
    };
  }

  emitDetailedError({ id, side, error }) {
    const detail = serializeError(error);
    console.error(`[${side}]`, JSON.stringify(detail, null, 2));
    this.emit("proxy_error", { id, side, message: `${side} request failed` });
  }

  async serveLocalTts(client, id) {
    const clean = path.basename(id);
    const pending = this.pendingTtsStreams.get(clean);
    if (!pending || pending.expiresAt < Date.now()) {
      this.pendingTtsStreams.delete(clean);
      client.write(responseBuffer("HTTP/1.1 404 Not Found", { error: "tts_not_found" }, { Connection: "close" }));
      return;
    }
    if (pending.error) {
      this.pendingTtsStreams.delete(clean);
      client.write(responseBuffer("HTTP/1.1 502 Bad Gateway", { error: "tts_generation_failed" }, { Connection: "close" }));
      return;
    }

    this.pendingTtsStreams.delete(clean);
    const chunks = [];
    await writeLiveTtsResponse(client, pending, (chunk) => chunks.push(Buffer.from(chunk)));
    if (chunks.length) this.captureTtsForChat(clean, Buffer.concat(chunks), pending.contentType);
  }
}

async function writeLiveTtsResponse(client, pending, recordChunk) {
  const headers = [
    "HTTP/1.1 200 OK",
    `Content-Type: ${pending.contentType}`,
    "Transfer-Encoding: chunked",
    "Connection: close",
    "",
    "",
  ].join("\r\n");
  client.write(headers);

  try {
    if (pending.firstChunk?.length) {
      writeChunk(client, pending.firstChunk);
      recordChunk(pending.firstChunk);
    }
    while (true) {
      const next = await pending.iterator.next();
      if (next.done) break;
      const chunk = Buffer.from(next.value);
      if (!chunk.length) continue;
      writeChunk(client, chunk);
      recordChunk(chunk);
    }
    client.end("0\r\n\r\n");
  } catch (error) {
    client.destroy(error);
  }
}

function writeChunk(client, buffer) {
  client.write(Buffer.from(`${buffer.length.toString(16)}\r\n`, "ascii"));
  client.write(buffer);
  client.write(Buffer.from("\r\n", "ascii"));
}

function toAsyncIterable(stream) {
  if (stream?.[Symbol.asyncIterator]) return stream;
  if (stream?.getReader) return readWebStream(stream);
  return readWebStream(new Response(stream).body);
}

function withTimeout(promise, timeoutMs) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("tts_stream_timeout")), timeoutMs);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

async function* readWebStream(stream) {
  const reader = stream.getReader();
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) return;
      yield value;
    }
  } finally {
    reader.releaseLock();
  }
}

function chatMessageToHistoryItem(row) {
  if (!row?.role || !row.content) return null;
  return { role: row.role, content: row.content };
}

function formatChatContentForLog(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.map((part) => {
    if (part?.type === "text") return part.text || "";
    if (part?.type === "image_url") return "[image attached]";
    if (part?.type === "input_audio") return "[audio attached]";
    return "";
  }).filter(Boolean).join("\n");
}

function coerceUpdateIntent(intent) {
  if (intent?.action?.behavior) return intent;
  const text = String(intent?.speech?.text || "").toLowerCase();
  if (!text.includes("update")) return intent;
  const type = /\b(start|download|install|begin|run)\b/.test(text) ? "start" : "check";
  return {
    ...intent,
    speech: { text: "", listen: 0 },
    mode: { chat: "unchanged" },
    action: { behavior: "function_update", params: { type } },
    recognition: { enabled: false },
    animation: { pre: "", post: "", post_behavior: "" },
  };
}

function okTagged(responsetag, extra = {}) {
  return {
    errcode: 0,
    errmsg: "OK",
    responsetag,
    ...extra,
  };
}

function actionParams(intent) {
  return intent.action?.params && Object.keys(intent.action.params).length ? intent.action.params : [];
}

function formatStageHistory(stageDirections = []) {
  return stageDirections.map((value) => `[${String(value).replace(/^\[|\]$/g, "")}]`).join("\n");
}

function guessAudioFormat(buffer) {
  if (!buffer?.length) return "";
  if (buffer.subarray(0, 3).toString("ascii") === "ID3") return "mp3";
  if (buffer.length > 2 && buffer[0] === 0xff && (buffer[1] & 0xe0) === 0xe0) return "mp3";
  if (buffer.subarray(0, 4).toString("ascii") === "RIFF") return "wav";
  if (buffer.subarray(0, 4).toString("ascii") === "OggS") return "ogg";
  if (buffer.subarray(4, 8).toString("ascii") === "ftyp") return "m4a";
  return "";
}

function guessImageMimeType(buffer) {
  if (buffer?.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return "image/jpeg";
  if (buffer?.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return "image/png";
  if (buffer?.subarray(0, 4).toString("ascii") === "RIFF" && buffer.subarray(8, 12).toString("ascii") === "WEBP") return "image/webp";
  return "image/jpeg";
}

function audioMimeType(format) {
  if (format === "mp3") return "audio/mpeg";
  if (format === "wav") return "audio/wav";
  if (format === "ogg") return "audio/ogg";
  if (format === "m4a") return "audio/mp4";
  return "application/octet-stream";
}

function imageExtension(mimeType) {
  if (mimeType === "image/png") return "png";
  if (mimeType === "image/webp") return "webp";
  return "jpg";
}

function mediaExtension(mimeType = "") {
  if (mimeType.includes("mpeg")) return "mp3";
  if (mimeType.includes("wav")) return "wav";
  if (mimeType.includes("ogg")) return "ogg";
  if (mimeType.includes("mp4")) return "m4a";
  if (mimeType.includes("png")) return "png";
  if (mimeType.includes("webp")) return "webp";
  if (mimeType.includes("jpeg") || mimeType.includes("jpg")) return "jpg";
  return "bin";
}

function mimeTypeFromPath(filePath) {
  const extension = path.extname(filePath).toLowerCase();
  if (extension === ".mp3") return "audio/mpeg";
  if (extension === ".wav") return "audio/wav";
  if (extension === ".ogg") return "audio/ogg";
  if (extension === ".m4a") return "audio/mp4";
  if (extension === ".png") return "image/png";
  if (extension === ".webp") return "image/webp";
  if (extension === ".jpg" || extension === ".jpeg") return "image/jpeg";
  return "application/octet-stream";
}

function safeMediaPath(rootDir, relativePath) {
  if (!relativePath || typeof relativePath !== "string") return "";
  const normalized = relativePath.replace(/\\/g, "/");
  if (!normalized.startsWith("chat-media/")) return "";
  const resolved = path.resolve(rootDir, normalized);
  const mediaRoot = path.resolve(rootDir, "chat-media");
  return resolved === mediaRoot || resolved.startsWith(`${mediaRoot}${path.sep}`) ? resolved : "";
}

function summarizeRequestBody(body, headers = {}) {
  const contentType = headers["content-type"] || "";
  if (!body?.length) return { contentType, bytes: 0 };
  if (contentType.includes("json")) {
    try {
      return { contentType, bytes: body.length, json: JSON.parse(body.toString("utf8")) };
    } catch {
      return { contentType, bytes: body.length, text: body.toString("utf8").slice(0, 1000) };
    }
  }
  if (contentType.includes("x-www-form-urlencoded")) {
    return {
      contentType,
      bytes: body.length,
      form: Object.fromEntries(new URLSearchParams(body.toString("utf8"))),
    };
  }
  const text = body.toString("utf8");
  if (/^[\x09\x0a\x0d\x20-\x7e]*$/.test(text)) return { contentType, bytes: body.length, text: text.slice(0, 1000) };
  return { contentType, bytes: body.length };
}

function summarizeStatusPayload(body, headers = {}) {
  const payload = summarizeRequestBody(body, headers);
  if (payload.json) return Object.entries(payload.json).map(([key, value]) => `${key}: ${formatStatusValue(value)}`).slice(0, 4).join(" | ");
  if (payload.form) return Object.entries(payload.form).map(([key, value]) => `${key}: ${formatStatusValue(value)}`).slice(0, 4).join(" | ");
  if (payload.text) return payload.text.slice(0, 120);
  return `${payload.bytes} bytes`;
}

function formatStatusValue(value) {
  if (value && typeof value === "object") return JSON.stringify(value);
  return String(value);
}

function prepareAudio(buffer) {
  const format = guessAudioFormat(buffer);
  if (format) return { buffer, format };
  if (!looksLikeRawPcm(buffer)) return { buffer, format: "" };
  return { buffer: wrapPcm16BeAsWav(buffer), format: "wav" };
}

function looksLikeRawPcm(buffer) {
  return Boolean(buffer?.length && buffer.length >= 3200 && buffer.length % 2 === 0);
}

function isOtaResponseTarget(startLine) {
  return startLine.startsWith("GET /aibi/ota/version");
}

function isPatchedFirmwareRequest(target) {
  try {
    return new URL(`http://local${target}`).pathname.endsWith("-patched.zip");
  } catch {
    return false;
  }
}

function isLocalOtaResponseTarget(target) {
  try {
    const pathname = new URL(`http://local${target}`).pathname;
    return pathname === "/aibi/ota/version" || pathname.endsWith("-patched.zip");
  } catch {
    return false;
  }
}

function rewriteOtaRequestStartLine(startLine) {
  const { method, target, protocol } = parseRequestLine(startLine);
  if (method !== "GET") return "";
  if (target.startsWith("/aibi/ota/version")) {
    const url = new URL(`http://local${target}`);
    url.searchParams.set("version_num", "8");
    url.searchParams.set("current_name", "1.5.0");
    return `${method} ${url.pathname}?${url.searchParams.toString()} ${protocol}`;
  }
  return "";
}

function collectUrls(value, urls = []) {
  if (typeof value === "string") {
    if (/^https?:\/\//i.test(value) && looksLikeFirmwareUrl(value)) urls.push(value);
    return urls;
  }
  if (Array.isArray(value)) {
    for (const item of value) collectUrls(item, urls);
    return urls;
  }
  if (value && typeof value === "object") {
    for (const item of Object.values(value)) collectUrls(item, urls);
  }
  return [...new Set(urls)];
}

function cloneAndRewriteUrls(value, rewrite) {
  if (typeof value === "string") return /^https?:\/\//i.test(value) && looksLikeFirmwareUrl(value) ? rewrite(value) : value;
  if (Array.isArray(value)) return value.map((item) => cloneAndRewriteUrls(item, rewrite));
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, cloneAndRewriteUrls(item, rewrite)]));
  }
  return value;
}

function buildPatchedOtaResponse(firmware) {
  return {
    "version-num": firmware.versionNum,
    "version-name": firmware.versionName,
    updates: {
      host: "api.aibipocket.com",
      firmware: firmware.urlPath,
      md5: firmware.md5,
    },
    responsetag: firmware.responseTag,
  };
}

function rewriteOtaJsonToPatchedFirmware(json, firmware) {
  const rewritten = cloneAndRewriteUrls(json, () => `http://api.aibipocket.com${firmware.urlPath}`);
  if (rewritten?.updates && typeof rewritten.updates === "object") {
    rewritten.updates = {
      ...rewritten.updates,
      host: "api.aibipocket.com",
      firmware: firmware.urlPath,
      md5: firmware.md5,
    };
  }
  if (firmware.versionNum) rewritten["version-num"] = firmware.versionNum;
  if (firmware.versionName) rewritten["version-name"] = firmware.versionName;
  if (firmware.responseTag) rewritten.responsetag = firmware.responseTag;
  return rewritten;
}

function replacePathBasename(sourcePath, basename) {
  const normalized = sourcePath.startsWith("/") ? sourcePath : `/${sourcePath}`;
  const directory = path.posix.dirname(normalized);
  return path.posix.join(directory, basename);
}

function readJsonIfExists(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    return null;
  }
}

function looksLikeFirmwareUrl(value) {
  return /(?:ota|firmware|fw|update|\.bin|\.zip|\.img|\.ota)(?:[/?#]|$)/i.test(value);
}

function firmwareFilename(url, contentType) {
  const basename = path.basename(url.pathname) || "firmware";
  const safeBase = basename.replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 80);
  const ext = path.extname(safeBase) || (contentType.includes("zip") ? ".zip" : contentType.includes("json") ? ".json" : ".bin");
  const stem = path.extname(safeBase) ? safeBase.slice(0, -path.extname(safeBase).length) : safeBase;
  return `${Date.now()}-${stem || "firmware"}${ext}`;
}

function audioLooksSilent(buffer) {
  if (!looksLikeRawPcm(buffer)) return false;
  let sumSquares = 0;
  let sampleCount = 0;
  for (let offset = 0; offset + 1 < buffer.length; offset += 2) {
    const sample = buffer.readInt16BE(offset);
    sumSquares += sample * sample;
    sampleCount += 1;
  }
  const rms = Math.sqrt(sumSquares / Math.max(1, sampleCount));
  return rms < 1000;
}

function wrapPcm16BeAsWav(pcm, sampleRate = 16000, channels = 1) {
  const littleEndianPcm = Buffer.allocUnsafe(pcm.length);
  for (let offset = 0; offset + 1 < pcm.length; offset += 2) {
    littleEndianPcm[offset] = pcm[offset + 1];
    littleEndianPcm[offset + 1] = pcm[offset];
  }

  const header = Buffer.alloc(44);
  const byteRate = sampleRate * channels * 2;
  header.write("RIFF", 0);
  header.writeUInt32LE(36 + littleEndianPcm.length, 4);
  header.write("WAVE", 8);
  header.write("fmt ", 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(channels, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(byteRate, 28);
  header.writeUInt16LE(channels * 2, 32);
  header.writeUInt16LE(16, 34);
  header.write("data", 36);
  header.writeUInt32LE(littleEndianPcm.length, 40);
  return Buffer.concat([header, littleEndianPcm]);
}

function serializeError(error) {
  if (!error || typeof error !== "object") return { message: String(error) };
  const detail = {};
  for (const key of Reflect.ownKeys(error)) {
    detail[key] = safeErrorValue(error[key]);
  }
  for (const key of ["name", "message", "stack", "status", "statusCode", "code", "body", "rawValue", "cause"]) {
    if (detail[key] === undefined && error[key] !== undefined) detail[key] = safeErrorValue(error[key]);
  }
  return detail;
}

function safeErrorValue(value) {
  if (value instanceof Error) return serializeError(value);
  if (Buffer.isBuffer(value)) return value.toString("utf8");
  if (typeof value === "function") return `[Function ${value.name || "anonymous"}]`;
  try {
    JSON.stringify(value);
    return value;
  } catch {
    return String(value);
  }
}

function getChatModeEvent(summary) {
  if (summary.behavior !== "ability_chatgpt") return null;
  if (summary.chatModeType === "connect") {
    return {
      type: "chat_mode_start",
      title: "Chat mode started",
      detail: summary.queryText || "Conversation mode is active",
      payload: summary,
    };
  }
  if (summary.chatModeType === "quit") {
    return {
      type: "chat_mode_end",
      title: "Chat mode ended",
      detail: summary.queryText || "Back to wake-word mode",
      payload: summary,
    };
  }
  return {
    type: "action",
    title: summary.behavior,
    detail: summary.queryText,
    payload: summary,
  };
}

function listen(server, port, host) {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => {
      server.off("error", reject);
      resolve();
    });
  });
}

function closeServer(server) {
  return new Promise((resolve) => server.close(() => resolve()));
}
