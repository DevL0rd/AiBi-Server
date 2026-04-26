import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRuntime } from "./src/core/runtime.js";

const rootDir = path.dirname(fileURLToPath(import.meta.url));
const runtime = createRuntime({ rootDir });

runtime.on("event", (event) => {
  if (event.kind === "event") {
    process.stdout.write(`[${event.event.created_at}] ${event.event.type}: ${event.event.title}\n`);
    if (event.event.detail) process.stdout.write(`  ${event.event.detail}\n`);
  }
});

await runtime.startProxy();
process.stdout.write("AiBi proxy running on HTTP :80 and HTTPS :443\n");

process.on("SIGINT", async () => {
  await runtime.stopProxy();
  process.exit(0);
});
