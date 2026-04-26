import { EventEmitter } from "node:events";
import { AppStore } from "./store.js";
import { FishAudioAdapter } from "./fishAudioAdapter.js";
import { OpenRouterAdapter } from "./openRouterAdapter.js";
import { ProxyService } from "./proxyService.js";
import { getCapabilityCatalog } from "./capabilities.js";

export function createRuntime({ rootDir }) {
  const events = new EventEmitter();
  const store = new AppStore({ rootDir });
  const getSettings = () => store.getSettings();
  const proxy = new ProxyService({
    rootDir,
    store,
    getSettings,
    openRouter: new OpenRouterAdapter(getSettings),
    fishAudio: new FishAudioAdapter(getSettings),
  });
  const openRouter = new OpenRouterAdapter(getSettings);

  const record = (event) => {
    const row = store.addEvent(event);
    events.emit("event", { kind: "event", event: row });
    return row;
  };

  proxy.on("conversation", record);
  proxy.on("stored_event", (row) => events.emit("event", { kind: "event", event: row }));
  proxy.on("chat_message", (message) => events.emit("event", { kind: "chat_message", message }));
  proxy.on("chat_message_deleted", ({ id }) => events.emit("event", { kind: "chat_message_deleted", id }));
  proxy.on("chat_log_cleared", (result) => events.emit("event", { kind: "chat_log_cleared", ...result }));
  proxy.on("proxy_error", (error) => record({
    type: "warning",
    title: "Proxy notice",
    detail: error.message,
    payload: error,
  }));
  proxy.on("dns_event", record);
  proxy.on("status", (status) => events.emit("event", { kind: "status", status }));
  proxy.on("connection", (connection) => events.emit("event", { kind: "connection", connection }));

  async function refreshOpenRouterModels() {
    try {
      const models = await openRouter.listModels();
      const saved = store.replaceOpenRouterModels(models);
      events.emit("event", { kind: "models", models: saved });
      record({
        type: "mode",
        title: "Model list updated",
        detail: `${saved.length} models available`,
        payload: { count: saved.length },
      });
      return saved;
    } catch (error) {
      record({
        type: "warning",
        title: "Model list update failed",
        detail: error.message,
        payload: { message: error.message },
      });
      return store.getOpenRouterModels();
    }
  }

  refreshOpenRouterModels();

  return {
    on: (...args) => events.on(...args),
    async startProxy() {
      return proxy.start();
    },
    async stopProxy() {
      return proxy.stop();
    },
    getSnapshot() {
      return {
        settings: getSettings(),
        events: store.getRecentEvents(),
        chatMessages: proxy.getChatLog(),
        models: store.getOpenRouterModels(),
        capabilities: getCapabilityCatalog(),
      };
    },
    clearEvents() {
      const eventsCleared = store.clearEvents();
      events.emit("event", { kind: "events_cleared", eventsCleared });
      return { eventsCleared };
    },
    clearChatLog() {
      return proxy.clearChatLog();
    },
    updateChatMessage({ id, content }) {
      return proxy.updateChatMessage(id, content);
    },
    deleteChatMessage(id) {
      return proxy.deleteChatMessage(id);
    },
    getChatMedia(relativePath) {
      return proxy.getChatMedia(relativePath);
    },
    saveSettings(settings) {
      const next = store.saveSettings(settings);
      events.emit("event", { kind: "settings", settings: next });
      return next;
    },
    setMode(mode) {
      if (!["passthrough", "local"].includes(mode)) throw new Error(`Invalid mode: ${mode}`);
      const settings = store.saveSettings({ mode });
      events.emit("event", { kind: "settings", settings });
      record({
        type: "mode",
        title: mode === "local" ? "Override mode" : "Pass-through mode",
        detail: "",
        payload: { mode },
      });
      return settings;
    },
    recordSystemEvent(title, detail) {
      return record({ type: "warning", title, detail, payload: { detail } });
    },
    refreshOpenRouterModels,
    getOpenRouterModels() {
      return store.getOpenRouterModels();
    },
  };
}
