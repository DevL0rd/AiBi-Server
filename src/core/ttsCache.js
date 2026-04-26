import crypto from "node:crypto";

export class TtsCache {
  constructor({ ttlMs = 120000 } = {}) {
    this.ttlMs = ttlMs;
    this.items = new Map();
  }

  reserve(contentType = "audio/mpeg") {
    const id = `local-${crypto.randomUUID()}.mp3`;
    const expiresAt = Date.now() + this.ttlMs;
    let resolve;
    let reject;
    const ready = new Promise((res, rej) => {
      resolve = res;
      reject = rej;
    });
    this.items.set(id, { body: null, contentType, expiresAt, ready, resolve, reject });
    setTimeout(() => this.expire(id), this.ttlMs).unref?.();
    return id;
  }

  fulfill(id, body, contentType = "audio/mpeg") {
    const item = this.items.get(id);
    if (!item) return;
    item.body = body;
    item.contentType = contentType;
    item.resolve(item);
  }

  fail(id, error) {
    const item = this.items.get(id);
    if (!item) return;
    this.items.delete(id);
    item.reject(error);
  }

  async takeWhenReady(id, timeoutMs = 15000) {
    const item = this.items.get(id);
    if (!item) return null;
    if (item.expiresAt < Date.now()) {
      this.items.delete(id);
      return null;
    }

    const ready = item.body ? item : await withTimeout(item.ready, timeoutMs);
    this.items.delete(id);
    return ready;
  }

  expire(id) {
    const item = this.items.get(id);
    if (item?.expiresAt <= Date.now()) {
      this.items.delete(id);
      item.reject(new Error("tts_expired"));
    }
  }
}

function withTimeout(promise, timeoutMs) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("tts_timeout")), timeoutMs);
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
