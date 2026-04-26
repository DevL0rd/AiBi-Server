import { EventEmitter } from "node:events";
import crypto from "node:crypto";
import fs from "node:fs";
import net from "node:net";
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
import { supportsModality } from "./openRouterAdapter.js";
import { TtsCache } from "./ttsCache.js";
import { FIRMWARE_ACTION_PARAMS, FIRMWARE_ANIMATIONS, FIRMWARE_BEHAVIORS } from "./firmwareCapabilities.js";

export class ProxyService extends EventEmitter {
  constructor({ rootDir, getSettings, store, openRouter, fishAudio }) {
    super();
    this.rootDir = rootDir;
    this.getSettings = getSettings;
    this.store = store;
    this.openRouter = openRouter;
    this.fishAudio = fishAudio;
    this.captureDir = path.join(rootDir, "captures");
    this.firmwareDir = path.join(this.captureDir, "firmware");
    this.ttsDir = path.join(rootDir, "tts");
    this.ttsCache = new TtsCache();
    this.chatHistory = [];
    this.chatMode = false;
    this.nextConnectionId = 1;
    this.servers = [];
    fs.mkdirSync(this.captureDir, { recursive: true });
    fs.mkdirSync(this.firmwareDir, { recursive: true });
    fs.mkdirSync(this.ttsDir, { recursive: true });
  }

  async start() {
    if (this.servers.length) return { running: true };
    const settings = this.getSettings();
    const key = fs.readFileSync(path.join(this.rootDir, "aibi.key"));
    const cert = fs.readFileSync(path.join(this.rootDir, "aibi.crt"));

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
    this.emit("status", { running: true });
    return { running: true };
  }

  async stop() {
    await Promise.all(this.servers.map((server) => closeServer(server)));
    this.servers = [];
    this.emit("status", { running: false });
    return { running: false };
  }

  wireConnection({ client, upstream, scheme }) {
    const id = this.nextConnectionId++;
    const context = { id, scheme, pendingRequests: [] };
    const clientInspector = new HttpInspector({ id, side: "client", captureDir: this.captureDir, emit: (event) => this.handleObservedEvent(context, event) });
    const upstreamInspector = new HttpInspector({ id, side: "upstream", captureDir: this.captureDir, emit: (event) => this.handleObservedEvent(context, event) });

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
          client.write(response);
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
    const clientInspector = new HttpInspector({ id, side: "client", captureDir: this.captureDir, emit: (event) => this.handleObservedEvent(context, event) });
    const upstreamInspector = new HttpInspector({ id, side: "upstream", captureDir: this.captureDir, emit: (event) => this.handleObservedEvent(context, event) });
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
    this.recordHttpEvent(event);
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
          detail: "Robot started a conversation",
          payload: { ttsUrl: json.url, responseTag: json.responsetag || "", request: matchedRequest.startLine },
        });
        return;
      }

      if (json?.queryResult) {
        this.store.learnFromDetectIntent(json);
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
      detail: localFirmware ? `Serving ${localFirmware.relativePath}` : (urls.length ? `${urls.length} firmware URL(s) captured and hidden from robot` : "OTA response captured; no firmware URL found"),
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
        this.store.addEvent({
          type: "warning",
          title: "HTTP parser skipped a message",
          detail: event.error,
          payload: event,
        });
        return;
      }

      const body = event.body;
      const detail = body?.kind === "text"
        ? body.text.slice(0, 500)
        : body?.filePath || "";
      this.store.addEvent({
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
    const audioPath = path.join(this.captureDir, `local-${id}.bin`);
    fs.writeFileSync(audioPath, request.body);
    const settings = this.getSettings();
    const query = new URL(`http://local${target}`).searchParams;
    const requestChatMode = query.get("role") === "chatgpt" || this.chatMode;
    const modelInfo = this.store.getOpenRouterModel(settings.openRouterModel);
    const preparedAudio = prepareAudio(request.body);
    const audioFormat = preparedAudio.format;
    const useNativeAudio = supportsModality(modelInfo, "input", "audio") && Boolean(audioFormat);

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

    let transcript = "";
    if (!useNativeAudio && audioFormat) {
      try {
        const sttPath = preparedAudio.buffer === request.body ? audioPath : path.join(this.captureDir, `local-${id}.${audioFormat}`);
        if (preparedAudio.buffer !== request.body) fs.writeFileSync(sttPath, preparedAudio.buffer);
        transcript = await this.fishAudio.transcribe(sttPath);
      } catch (error) {
        this.emitDetailedError({ id, side: "fish-audio", error });
      }
    }

    const capabilities = buildCapabilities(this.store.getLearned());
    let localError = false;
    let intent = {
      speech: { text: settings.localTextFallback || "I heard you.", listen: 0 },
      mode: { chat: "unchanged" },
      action: { behavior: "" },
      recognition: { enabled: false },
      animation: { pre: "", post: "", post_behavior: "" },
    };
    try {
      intent = await this.openRouter.generateLocalIntent({
        transcript,
        audio: preparedAudio.buffer,
        audioFormat,
        capabilities,
        history: this.chatHistory,
        chatMode: requestChatMode,
        modelInfo,
      });
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
    this.rememberTurn({ transcript, responseJson });
    this.emit("conversation", {
      type: responseJson.queryResult?.rec_behavior === "interact_speak" ? "local_response" : "action",
      title: responseJson.queryResult?.behavior_paras?.txt || responseJson.queryResult?.rec_behavior || "Local response",
      detail: transcript || "Local replacement generated a response",
      payload: summarizeDetectIntent(responseJson),
    });
    return responseBuffer("HTTP/1.1 200 OK", responseJson);
  }

  async buildLocalProactiveResponse() {
    const modelInfo = this.store.getOpenRouterModel(this.getSettings().openRouterModel);
    const capabilities = buildCapabilities(this.store.getLearned());
    let intent = {
      speech: { text: "Hi, want to chat for a bit?", listen: 0 },
      mode: { chat: "unchanged" },
      action: { behavior: "" },
      recognition: { enabled: false },
      animation: { pre: "", post: "", post_behavior: "" },
    };
    try {
      intent = await this.openRouter.generateLocalIntent({
        transcript: "Start a short proactive conversation with the user.",
        capabilities,
        history: this.chatHistory,
        chatMode: this.chatMode,
        modelInfo,
        proactive: true,
      });
    } catch (error) {
      this.emitDetailedError({ id: "proactive", side: "openrouter", error });
    }
    const text = intent.speech?.text || this.getSettings().localTextFallback || "Hi there.";
    const ttsUrl = this.queueLocalTts({ text, modelInfo });
    const responseJson = buildProactiveChatResponse({ ttsUrl });
    this.chatHistory.push({ role: "assistant", content: text });
    this.trimChatHistory();
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
        title: "Robot status",
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
      const text = settings.localTextFallback || "Hi.";
      const ttsUrl = this.queueLocalTts({ text, modelInfo }).replace("/tts/dl/", "/poweron/dl/");
      return responseBuffer("HTTP/1.1 200 OK", okTagged("poweronvoice", { url: ttsUrl }));
    }

    if (method === "GET" && pathname === "/aibi/speech/tts") {
      const text = url.searchParams.get("q") || settings.localTextFallback || "OK.";
      const ttsUrl = this.queueLocalTts({ text, modelInfo });
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
      const canUseImage = supportsModality(modelInfo, "input", "image");
      const capabilities = buildCapabilities(this.store.getLearned());
      let transcript = canUseImage ? "The user sent an image." : "";
      let localError = false;
      let intent = {
        speech: { text: settings.localTextFallback || "I heard you.", listen: 0 },
        mode: { chat: "unchanged" },
        action: { behavior: "" },
        recognition: { enabled: false },
        animation: { pre: "", post: "", post_behavior: "" },
      };

      try {
        if (!canUseImage) {
          const description = await this.openRouter.describeImage({ image: request.body, mimeType: imageMimeType });
          transcript = description ? `The user sent an image. Image description: ${description}` : "The user sent an image, but image description failed.";
        }
        intent = await this.openRouter.generateLocalIntent({
          transcript,
          image: canUseImage ? request.body : null,
          imageMimeType,
          capabilities,
          history: this.chatHistory,
          chatMode: this.chatMode,
          modelInfo,
        });
      } catch (error) {
        localError = true;
        this.emitDetailedError({ id: "image-recognition", side: "openrouter", error });
      }

      if (localError) {
        intent = this.chatMode
          ? { ...intent, speech: { text: "", listen: 0 }, mode: { chat: "quit" }, action: { behavior: "" }, recognition: { enabled: false }, animation: { pre: "", post: "", post_behavior: "" } }
          : { ...intent, speech: { text: "Error occurred.", listen: 0 } };
      }

      const responseJson = await this.buildProtocolResponseFromIntent({
        intent,
        transcript,
        index: 0,
        modelInfo,
      });
      this.rememberTurn({ transcript, responseJson });
      this.emit("conversation", {
        type: responseJson.queryResult?.rec_behavior === "interact_speak" ? "local_response" : "action",
        title: responseJson.queryResult?.behavior_paras?.txt || responseJson.queryResult?.rec_behavior || "Image response",
        detail: canUseImage ? "Image sent to selected chat model" : "Image described by Gemini, then sent to selected chat model",
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
    const postBehaviorNames = new Set(buildCapabilities().native_animations.post_behavior);
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
      const ttsUrl = this.queueLocalTts({ text: intent.speech.text, modelInfo });
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
    const fallbackText = this.getSettings().localTextFallback || "I heard you.";
    const fallbackTtsUrl = this.queueLocalTts({ text: fallbackText, modelInfo });
    return buildSpeakResponse({
      text: fallbackText,
      ttsUrl: fallbackTtsUrl,
      queryText: transcript,
      index,
    });
  }

  queueLocalTts({ text, modelInfo }) {
    const ttsId = this.ttsCache.reserve();
    this.generateLocalTts({ id: ttsId, text, modelInfo });
    return `http://api.aibipocket.com/tts/dl/${ttsId}`;
  }

  async generateLocalTts({ id, text, modelInfo }) {
    let audio = null;
    if (supportsModality(modelInfo, "output", "audio")) {
      try {
        audio = await this.openRouter.synthesizeSpeechStream({ text });
      } catch (error) {
        this.emitDetailedError({ id: "tts", side: "openrouter", error });
      }
    }
    if (!audio) {
      try {
        audio = await this.fishAudio.synthesizeToStream({ text });
      } catch (error) {
        this.emitDetailedError({ id: "tts", side: "fish-audio", error });
      }
    }
    if (!audio) {
      this.ttsCache.fail(id, new Error("tts_generation_failed"));
      return;
    }
    this.ttsCache.fulfill(id, audio);
  }

  rememberTurn({ transcript, responseJson }) {
    if (transcript) this.chatHistory.push({ role: "user", content: transcript });
    const text = responseJson.queryResult?.behavior_paras?.txt;
    if (text) this.chatHistory.push({ role: "assistant", content: text });
    this.trimChatHistory();
  }

  trimChatHistory() {
    this.chatHistory = this.chatHistory.slice(-24);
  }

  resetChatHistory({ emitEvent = true } = {}) {
    const cleared = this.chatHistory.length;
    this.chatHistory = [];
    if (emitEvent) this.emit("conversation", {
      type: "mode",
      title: "Chat history reset",
      detail: `${cleared} messages cleared`,
      payload: { cleared },
    });
    return { cleared };
  }

  emitDetailedError({ id, side, error }) {
    const detail = serializeError(error);
    console.error(`[${side}]`, JSON.stringify(detail, null, 2));
    this.emit("proxy_error", { id, side, message: `${side} request failed` });
  }

  async serveLocalTts(client, id) {
    const clean = path.basename(id);
    try {
      const cached = await this.ttsCache.takeWhenReady(clean);
      if (!cached) throw new Error("tts_not_found");
      if (Buffer.isBuffer(cached.body)) {
        writeAudioResponse(client, cached.body, cached.contentType);
      } else {
        await writeAudioStreamResponse(client, cached.body, cached.contentType);
      }
      return;
    } catch {
      // Fall through to old on-disk cache for files from earlier runs.
    }

    const filePath = path.join(this.ttsDir, clean);
    if (!fs.existsSync(filePath)) {
      client.write(responseBuffer("HTTP/1.1 404 Not Found", { error: "tts_not_found" }, { Connection: "close" }));
      return;
    }

    const body = fs.readFileSync(filePath);
    writeAudioResponse(client, body, "audio/mpeg");
  }
}

function writeAudioResponse(client, body, contentType) {
  const headers = [
    "HTTP/1.1 200 OK",
    `Content-Type: ${contentType}`,
    `Content-Length: ${body.length}`,
    "Connection: close",
    "",
    "",
  ].join("\r\n");
  client.end(Buffer.concat([Buffer.from(headers, "utf8"), body]));
}

async function writeAudioStreamResponse(client, stream, contentType) {
  const headers = [
    "HTTP/1.1 200 OK",
    `Content-Type: ${contentType}`,
    "Transfer-Encoding: chunked",
    "Connection: close",
    "",
    "",
  ].join("\r\n");
  client.write(headers);

  try {
    for await (const chunk of toAsyncIterable(stream)) {
      if (!chunk?.length) continue;
      const buffer = Buffer.from(chunk);
      client.write(Buffer.from(`${buffer.length.toString(16)}\r\n`, "ascii"));
      client.write(buffer);
      client.write(Buffer.from("\r\n", "ascii"));
    }
    client.end("0\r\n\r\n");
  } catch (error) {
    client.destroy(error);
  }
}

function toAsyncIterable(stream) {
  if (stream?.[Symbol.asyncIterator]) return stream;
  if (stream?.getReader) return readWebStream(stream);
  return readWebStream(new Response(stream).body);
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

function buildCapabilities(learned) {
  const nativeBehaviors = [...new Set(FIRMWARE_BEHAVIORS)]
    .filter((name) => name && !["interact_speak", "interact_answer_with_animation"].includes(name))
    .sort();
  return {
    native_behaviors: nativeBehaviors,
    action_param_schemas: FIRMWARE_ACTION_PARAMS,
    firmware_animation_names: FIRMWARE_ANIMATIONS,
    native_animations: {
      pre_animation: FIRMWARE_ANIMATIONS,
      post_animation: FIRMWARE_ANIMATIONS,
      post_behavior: nativeBehaviors,
    },
  };
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
