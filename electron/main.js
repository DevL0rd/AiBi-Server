import { app, BrowserWindow, ipcMain, Menu } from "electron";
import { fork } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, "..");

app.disableHardwareAcceleration();

let windowRef = null;
let proxyChild = null;
let nextRequestId = 1;
const pending = new Map();

function emitToRenderer(event) {
  if (windowRef && !windowRef.isDestroyed()) {
    windowRef.webContents.send("aibi:event", event);
  }
}

function startProxyChild() {
  if (proxyChild && !proxyChild.killed) return;

  proxyChild = fork(path.join(rootDir, "src/core/proxyProcess.js"), [rootDir], {
    execPath: process.env.AIBI_NODE || process.env.npm_node_execpath || "node",
    stdio: ["pipe", "pipe", "pipe", "ipc"],
  });

  proxyChild.stdout?.on("data", (chunk) => process.stdout.write(chunk));
  proxyChild.stderr?.on("data", (chunk) => process.stderr.write(chunk));
  proxyChild.on("message", (message) => {
    if (message.type === "runtime-event") {
      emitToRenderer(message.event);
      return;
    }

    if (message.type === "response") {
      const request = pending.get(message.id);
      if (!request) return;
      pending.delete(message.id);
      if (message.error) request.reject(new Error(message.error));
      else request.resolve(message.result);
    }
  });

  proxyChild.on("exit", (code, signal) => {
    emitToRenderer({
      kind: "event",
      event: {
        id: Date.now(),
        created_at: new Date().toISOString(),
        type: "warning",
        title: "Proxy stopped",
        detail: signal || String(code || 0),
        payload: { code, signal },
      },
    });
    proxyChild = null;
  });
}

function proxyCall(command, payload) {
  startProxyChild();
  const id = nextRequestId++;
  const timeoutMs = command === "refreshModels" ? 30000 : 8000;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    proxyChild.send({ id, command, payload });
    setTimeout(() => {
      if (!pending.has(id)) return;
      pending.delete(id);
      reject(new Error(`Proxy command timed out: ${command}`));
    }, timeoutMs);
  });
}

async function createWindow() {
  Menu.setApplicationMenu(null);

  windowRef = new BrowserWindow({
    width: 1220,
    height: 820,
    minWidth: 980,
    minHeight: 680,
    title: "AIBI Console",
    frame: false,
    autoHideMenuBar: true,
    backgroundColor: "#0b1118",
    show: false,
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  windowRef.once("ready-to-show", () => {
    if (windowRef && !windowRef.isDestroyed()) windowRef.show();
  });

  if (process.env.VITE_DEV_SERVER_URL) {
    await windowRef.loadURL(process.env.VITE_DEV_SERVER_URL);
  } else {
    await windowRef.loadFile(path.resolve(rootDir, "dist/index.html"));
  }
}

app.whenReady().then(async () => {
  startProxyChild();
  await createWindow();
});

app.on("window-all-closed", async () => {
  if (proxyChild && !proxyChild.killed) proxyChild.kill("SIGTERM");
  if (process.platform !== "darwin") app.quit();
});

ipcMain.handle("aibi:snapshot", () => proxyCall("snapshot"));
ipcMain.handle("aibi:events:clear", () => proxyCall("clearEvents"));
ipcMain.handle("aibi:chat:clear", () => proxyCall("clearChatLog"));
ipcMain.handle("aibi:chat:update", (_event, payload) => proxyCall("updateChatMessage", payload));
ipcMain.handle("aibi:chat:delete", (_event, id) => proxyCall("deleteChatMessage", id));
ipcMain.handle("aibi:chat:media", (_event, path) => proxyCall("chatMedia", path));
ipcMain.handle("aibi:settings:save", (_event, settings) => proxyCall("saveSettings", settings));
ipcMain.handle("aibi:mode:set", (_event, mode) => proxyCall("setMode", mode));
ipcMain.handle("aibi:models", () => proxyCall("models"));
ipcMain.handle("aibi:models:refresh", () => proxyCall("refreshModels"));
ipcMain.handle("aibi:proxy:start", () => proxyCall("start"));
ipcMain.handle("aibi:proxy:stop", () => proxyCall("stop"));
ipcMain.handle("aibi:window:minimize", () => windowRef?.minimize());
ipcMain.handle("aibi:window:maximize-toggle", () => {
  if (!windowRef) return false;
  if (windowRef.isMaximized()) windowRef.unmaximize();
  else windowRef.maximize();
  return windowRef.isMaximized();
});
ipcMain.handle("aibi:window:close", () => windowRef?.close());
