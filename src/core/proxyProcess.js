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
    else if (command === "resetChatHistory") result = runtime.resetChatHistory();
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

await runtime.startProxy();
process.send?.({ type: "ready" });

process.on("SIGINT", async () => {
  await runtime.stopProxy();
  process.exit(0);
});

process.on("SIGTERM", async () => {
  await runtime.stopProxy();
  process.exit(0);
});
