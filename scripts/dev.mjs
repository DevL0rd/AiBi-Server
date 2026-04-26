import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, "..");
const host = "127.0.0.1";
const port = 5173;
const devServerUrl = `http://${host}:${port}`;

const viteBin = path.join(rootDir, "node_modules", "vite", "bin", "vite.js");
const electronBin = path.join(rootDir, "node_modules", "electron", "cli.js");

const children = new Set();
let shuttingDown = false;

function start(command, args, options = {}) {
  const child = spawn(command, args, {
    cwd: rootDir,
    stdio: "inherit",
    env: process.env,
    ...options,
  });
  children.add(child);
  child.on("exit", () => children.delete(child));
  return child;
}

function stopAll() {
  if (shuttingDown) return;
  shuttingDown = true;
  for (const child of children) {
    if (!child.killed) child.kill();
  }
}

async function waitForServer(url, child, timeoutMs = 30000) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (child.exitCode !== null) {
      throw new Error(`Vite exited before ${url} was available.`);
    }

    try {
      const response = await fetch(url);
      if (response.ok) return;
    } catch {
      // Vite is still starting.
    }

    await new Promise((resolve) => setTimeout(resolve, 250));
  }

  throw new Error(`Timed out waiting for ${url}.`);
}

process.on("SIGINT", () => {
  stopAll();
  process.exit(130);
});

process.on("SIGTERM", () => {
  stopAll();
  process.exit(143);
});

const vite = start(process.execPath, [viteBin, "--host", host]);

try {
  await waitForServer(devServerUrl, vite);

  const electronEnv = {
    ...process.env,
    AIBI_NODE: process.env.AIBI_NODE || process.execPath,
    VITE_DEV_SERVER_URL: devServerUrl,
  };
  delete electronEnv.ELECTRON_RUN_AS_NODE;

  const electron = start(process.execPath, [electronBin, "."], {
    env: electronEnv,
  });

  electron.on("exit", (code, signal) => {
    stopAll();
    if (signal) process.exit(signal === "SIGINT" ? 130 : 1);
    else process.exit(code ?? 0);
  });
} catch (error) {
  stopAll();
  console.error(error.message);
  process.exit(1);
}
