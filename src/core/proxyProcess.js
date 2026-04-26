import path from "node:path";
import { createRuntime } from "./runtime.js";

const rootDir = process.argv[2] || process.cwd();
const runtime = createRuntime({ rootDir: path.resolve(rootDir) });

runtime.on("event", (event) => {
  process.send?.({ type: "runtime-event", event });
});

async function handle(message) {
  const { id, command, payload } = message;
  try {
    let result;
    if (command === "start") result = await runtime.startProxy();
    else if (command === "stop") result = await runtime.stopProxy();
    else if (command === "snapshot") result = runtime.getSnapshot();
    else if (command === "clearEvents") result = runtime.clearEvents();
    else if (command === "clearChatLog") result = runtime.clearChatLog();
    else if (command === "updateChatMessage") result = runtime.updateChatMessage(payload);
    else if (command === "deleteChatMessage") result = runtime.deleteChatMessage(payload);
    else if (command === "chatMedia") result = runtime.getChatMedia(payload);
    else if (command === "saveSettings") result = runtime.saveSettings(payload);
    else if (command === "setMode") result = runtime.setMode(payload);
    else if (command === "models") result = runtime.getOpenRouterModels();
    else if (command === "refreshModels") result = await runtime.refreshOpenRouterModels();
    else throw new Error(`Unknown command: ${command}`);
    process.send?.({ type: "response", id, result });
  } catch (error) {
    process.send?.({ type: "response", id, error: error.message });
  }
}

process.on("message", (message) => {
  handle(message);
});

try {
  await runtime.startProxy();
} catch (error) {
  runtime.recordSystemEvent("Proxy did not start", error.message);
}

process.send?.({ type: "ready" });

process.on("SIGINT", async () => {
  await runtime.stopProxy();
  process.exit(0);
});

process.on("SIGTERM", async () => {
  await runtime.stopProxy();
  process.exit(0);
});
