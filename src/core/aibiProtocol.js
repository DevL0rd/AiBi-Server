import crypto from "node:crypto";

export function parseRequestLine(startLine) {
  const [method = "", target = "", protocol = ""] = startLine.split(" ");
  return { method, target, protocol };
}

export function parseResponseJson(body) {
  try {
    return JSON.parse(body.toString("utf8"));
  } catch {
    return null;
  }
}

export function summarizeDetectIntent(json) {
  const result = json?.queryResult || {};
  const params = result.behavior_paras && !Array.isArray(result.behavior_paras) ? result.behavior_paras : {};
  return {
    queryText: result.queryText || "",
    responseText: params.txt || "",
    behavior: result.rec_behavior || "",
    intent: result.intent?.name || "",
    confidence: result.intent?.confidence || "",
    behaviorParams: params,
    chatModeType: result.rec_behavior === "ability_chatgpt" ? params.type || "" : "",
    ttsUrl: params.url || "",
    listen: params.listen ?? null,
    index: json?.index,
  };
}

export function buildSpeakResponse({
  text,
  ttsUrl,
  queryText = "",
  index = 0,
  behavior = "interact_speak",
  preAnimation = "",
  postAnimation = "",
  postBehavior = "",
  listen = 0,
}) {
  return {
    queryId: crypto.randomUUID(),
    queryResult: {
      rec_behavior: behavior,
      behavior_paras: {
        txt: text,
        url: ttsUrl,
        pre_animation: preAnimation,
        post_animation: postAnimation,
        post_behavior: postBehavior,
        sentiment: "",
        listen,
      },
      resultCode: crypto.randomUUID(),
      queryText,
      intent: {
        name: "local_ai_speak",
        confidence: 1,
      },
    },
    languageCode: "en",
    index,
  };
}

export function buildChatModeResponse({ type, queryText = "", index = 0 }) {
  return {
    queryId: crypto.randomUUID(),
    queryResult: {
      resultCode: crypto.randomUUID(),
      queryText,
      intent: {
        name: "ability_chatgpt",
        confidence: 1,
      },
      rec_behavior: "ability_chatgpt",
      behavior_paras: { type },
    },
    languageCode: "en",
    index,
  };
}

export function buildRecognizeResponse({ queryText = "", index = 0 }) {
  return {
    queryId: crypto.randomUUID(),
    queryResult: {
      resultCode: crypto.randomUUID(),
      queryText,
      intent: {
        name: "ability_photo_recog",
        confidence: 1,
      },
      rec_behavior: "interact_recognize",
      behavior_paras: [],
    },
    languageCode: "en",
    index,
  };
}

export function buildProactiveChatResponse({ ttsUrl }) {
  return {
    errcode: 0,
    url: ttsUrl,
    errmsg: "OK",
    responsetag: "chatstart",
  };
}

export function buildActionResponse({ action, params = [], queryText = "", index = 0 }) {
  return {
    queryId: crypto.randomUUID(),
    queryResult: {
      resultCode: crypto.randomUUID(),
      queryText,
      intent: {
        name: action,
        confidence: 1,
      },
      rec_behavior: action,
      behavior_paras: params,
    },
    languageCode: "en",
    index,
  };
}

export function responseBuffer(statusLine, body, extraHeaders = {}) {
  const payload = Buffer.isBuffer(body) ? body : Buffer.from(JSON.stringify(body), "utf8");
  const headers = {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": String(payload.length),
    "Connection": "keep-alive",
    ...extraHeaders,
  };
  const lines = [statusLine, ...Object.entries(headers).map(([k, v]) => `${k}: ${v}`), "", ""];
  return Buffer.concat([Buffer.from(lines.join("\r\n"), "utf8"), payload]);
}
