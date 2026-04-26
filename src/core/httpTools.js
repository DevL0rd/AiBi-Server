import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";

let captureSequence = 1;

export function isTextLike(contentType = "") {
  const value = contentType.toLowerCase();
  return (
    value.startsWith("text/") ||
    value.includes("json") ||
    value.includes("xml") ||
    value.includes("javascript") ||
    value.includes("x-www-form-urlencoded")
  );
}

export function decodeBody(body, contentEncoding = "") {
  const encoding = contentEncoding.toLowerCase();
  if (!encoding || encoding === "identity") return body;
  if (encoding.includes("gzip")) return zlib.gunzipSync(body);
  if (encoding.includes("deflate")) return zlib.inflateSync(body);
  if (encoding.includes("br")) return zlib.brotliDecompressSync(body);
  return body;
}

export function decodeHeaders(headerText) {
  const lines = headerText.split("\r\n");
  const startLine = lines.shift() || "";
  const headers = {};
  for (const line of lines) {
    const idx = line.indexOf(":");
    if (idx !== -1) headers[line.slice(0, idx).trim().toLowerCase()] = line.slice(idx + 1).trim();
  }
  return { startLine, headers };
}

export function encodeHeaders(startLine, headers) {
  return `${[startLine, ...Object.entries(headers).map(([key, value]) => `${key}: ${value}`)].join("\r\n")}\r\n\r\n`;
}

export function readChunkedBody(buffer, offset) {
  let cursor = offset;
  const chunks = [];

  while (true) {
    while (buffer.subarray(cursor, cursor + 2).equals(Buffer.from("\r\n"))) {
      cursor += 2;
    }

    const lineEnd = buffer.indexOf("\r\n", cursor);
    if (lineEnd === -1) return null;

    const sizeLine = buffer.subarray(cursor, lineEnd).toString("utf8");
    const size = Number.parseInt(sizeLine.split(";")[0].trim(), 16);
    if (Number.isNaN(size)) throw new Error(`invalid chunk size ${JSON.stringify(sizeLine)}`);

    const chunkStart = lineEnd + 2;
    const chunkEnd = chunkStart + size;
    if (buffer.length < chunkEnd + 2) return null;

    if (size === 0) {
      if (buffer.subarray(chunkStart, chunkStart + 2).equals(Buffer.from("\r\n"))) {
        return { body: Buffer.concat(chunks), endOffset: chunkStart + 2 };
      }

      const trailerEnd = buffer.indexOf("\r\n\r\n", chunkStart);
      if (trailerEnd !== -1) return { body: Buffer.concat(chunks), endOffset: trailerEnd + 4 };
      return null;
    }

    if (buffer[chunkEnd] !== 13 || buffer[chunkEnd + 1] !== 10) return null;
    chunks.push(buffer.subarray(chunkStart, chunkEnd));
    cursor = chunkEnd + 2;
  }
}

export function buildHttpMessage(startLine, headers, body) {
  const normalized = { ...headers };
  delete normalized["transfer-encoding"];
  normalized["content-length"] = String(body.length);
  return Buffer.concat([Buffer.from(encodeHeaders(startLine, normalized), "utf8"), body]);
}

export function parseHttpMessages(buffer) {
  const messages = [];
  let current = buffer;

  while (true) {
    while (current.subarray(0, 2).equals(Buffer.from("\r\n"))) {
      current = current.subarray(2);
    }

    const headerEnd = current.indexOf("\r\n\r\n");
    if (headerEnd === -1) break;

    const { startLine, headers } = decodeHeaders(current.subarray(0, headerEnd).toString("utf8"));
    if (!startLine.trim()) {
      current = current.subarray(headerEnd + 4);
      continue;
    }

    const bodyOffset = headerEnd + 4;
    let parsed = null;

    if (/\bchunked\b/i.test(headers["transfer-encoding"] || "")) {
      parsed = readChunkedBody(current, bodyOffset);
    } else if (headers["content-length"]) {
      const length = Number(headers["content-length"]);
      if (current.length < bodyOffset + length) break;
      parsed = { body: current.subarray(bodyOffset, bodyOffset + length), endOffset: bodyOffset + length };
    } else {
      parsed = { body: Buffer.alloc(0), endOffset: bodyOffset };
    }

    if (!parsed) break;
    messages.push({ startLine, headers, body: parsed.body, raw: current.subarray(0, parsed.endOffset) });
    current = current.subarray(parsed.endOffset);
  }

  return { messages, remainder: current };
}

export class HttpInspector {
  constructor({ id, side, bodyDir, emit }) {
    this.id = id;
    this.side = side;
    this.bodyDir = bodyDir;
    this.emit = emit;
    this.buffer = Buffer.alloc(0);
    this.count = 0;
  }

  push(chunk) {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    try {
      const parsed = parseHttpMessages(this.buffer);
      this.buffer = parsed.remainder;
      for (const message of parsed.messages) this.inspect(message);
    } catch (error) {
      this.emit({
        type: "http_parse_error",
        connectionId: this.id,
        side: this.side,
        error: error.message,
      });
      this.buffer = Buffer.alloc(0);
    }
  }

  inspect(message) {
    this.count += 1;
    const kind = message.startLine.startsWith("HTTP/") ? "response" : "request";
    const contentType = message.headers["content-type"] || "";
    const contentEncoding = message.headers["content-encoding"] || "";
    let bodySummary = null;

    if (message.body.length && isTextLike(contentType)) {
      try {
        bodySummary = {
          kind: "text",
          bytes: message.body.length,
          text: decodeBody(message.body, contentEncoding).toString("utf8"),
        };
      } catch (error) {
        bodySummary = { kind: "decode_error", bytes: message.body.length, error: error.message };
      }
    } else if (message.body.length) {
      const ext = contentType.includes("mpeg") ? ".mp3" : contentType.includes("octet-stream") ? ".bin" : ".dat";
      const stamp = `${Date.now()}-${process.pid}-${captureSequence++}`;
      const filePath = path.join(this.bodyDir, `${stamp}-${this.id}-${this.side}-${this.count}${ext}`);
      try {
        fs.writeFileSync(filePath, message.body);
        bodySummary = { kind: "binary", bytes: message.body.length, contentType: contentType || "unknown", filePath };
      } catch (error) {
        bodySummary = { kind: "binary", bytes: message.body.length, contentType: contentType || "unknown", error: error.message };
      }
    }

    this.emit({
      type: "http_message",
      connectionId: this.id,
      side: this.side,
      kind,
      startLine: message.startLine,
      headers: message.headers,
      body: bodySummary,
    });
  }
}
