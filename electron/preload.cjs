const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("desktopMeta", {
  isDesktop: true,
  platform: process.platform,
});

contextBridge.exposeInMainWorld("workspaceBridge", {
  loadSharedWorkspace: () => ipcRenderer.invoke("workspace:load-shared"),
  saveSharedWorkspace: (workspace) => ipcRenderer.invoke("workspace:save-shared", workspace),
  getSharedWorkspacePath: () => ipcRenderer.invoke("workspace:shared-path"),
});
