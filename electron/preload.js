import { contextBridge, ipcRenderer } from "electron";

contextBridge.exposeInMainWorld("aibi", {
  getSnapshot: () => ipcRenderer.invoke("aibi:snapshot"),
  clearConsoleEvents: () => ipcRenderer.invoke("aibi:events:clear"),
  clearChatLog: () => ipcRenderer.invoke("aibi:chat:clear"),
  updateChatMessage: (id, content) => ipcRenderer.invoke("aibi:chat:update", { id, content }),
  deleteChatMessage: (id) => ipcRenderer.invoke("aibi:chat:delete", id),
  getChatMedia: (path) => ipcRenderer.invoke("aibi:chat:media", path),
  saveSettings: (settings) => ipcRenderer.invoke("aibi:settings:save", settings),
  setMode: (mode) => ipcRenderer.invoke("aibi:mode:set", mode),
  getModels: () => ipcRenderer.invoke("aibi:models"),
  refreshModels: () => ipcRenderer.invoke("aibi:models:refresh"),
  startProxy: () => ipcRenderer.invoke("aibi:proxy:start"),
  stopProxy: () => ipcRenderer.invoke("aibi:proxy:stop"),
  minimizeWindow: () => ipcRenderer.invoke("aibi:window:minimize"),
  toggleMaximizeWindow: () => ipcRenderer.invoke("aibi:window:maximize-toggle"),
  closeWindow: () => ipcRenderer.invoke("aibi:window:close"),
  onEvent: (handler) => {
    const listener = (_event, payload) => handler(payload);
    ipcRenderer.on("aibi:event", listener);
    return () => ipcRenderer.removeListener("aibi:event", listener);
  },
});
