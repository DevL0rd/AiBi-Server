import { EventEmitter } from "node:events";
import { AppStore } from "./store.js";
import { FishAudioAdapter } from "./fishAudioAdapter.js";
import { OpenRouterAdapter } from "./openRouterAdapter.js";
import { ProxyService } from "./proxyService.js";

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
  proxy.on("proxy_error", (error) => record({
    type: "warning",
    title: "Proxy notice",
    detail: error.message,
    payload: error,
  }));
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
        learned: store.getLearned(),
        models: store.getOpenRouterModels(),
      };
    },
    resetChatHistory() {
      const history = proxy.resetChatHistory({ emitEvent: false });
      const eventsCleared = store.clearEvents();
      const row = record({
        type: "mode",
        title: "History reset",
        detail: `${history.cleared} chat messages and ${eventsCleared} log entries cleared`,
        payload: { chatMessagesCleared: history.cleared, eventsCleared },
      });
      return { ...history, eventsCleared, event: row };
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
        title: mode === "local" ? "Local AI mode" : "Pass-through mode",
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
