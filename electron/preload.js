import { contextBridge, ipcRenderer } from "electron";

contextBridge.exposeInMainWorld("aibi", {
  getSnapshot: () => ipcRenderer.invoke("aibi:snapshot"),
  resetChatHistory: () => ipcRenderer.invoke("aibi:history:reset"),
  saveSettings: (settings) => ipcRenderer.invoke("aibi:settings:save", settings),
  setMode: (mode) => ipcRenderer.invoke("aibi:mode:set", mode),
  getModels: () => ipcRenderer.invoke("aibi:models"),
  refreshModels: () => ipcRenderer.invoke("aibi:models:refresh"),
  startProxy: () => ipcRenderer.invoke("aibi:proxy:start"),
  stopProxy: () => ipcRenderer.invoke("aibi:proxy:stop"),
  onEvent: (handler) => {
    const listener = (_event, payload) => handler(payload);
    ipcRenderer.on("aibi:event", listener);
    return () => ipcRenderer.removeListener("aibi:event", listener);
  },
});
