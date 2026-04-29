const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("desktopMeta", {
  isDesktop: true,
  platform: process.platform,
});

contextBridge.exposeInMainWorld("workspaceBridge", {
  loadSharedWorkspace: () => ipcRenderer.invoke("workspace:load-shared"),
  saveSharedWorkspace: (workspace) => ipcRenderer.invoke("workspace:save-shared", workspace),
  getSharedWorkspacePath: () => ipcRenderer.invoke("workspace:shared-path"),
  getWorkspaceStorageInfo: () => ipcRenderer.invoke("workspace:storage-info"),
  setSharedWorkspacePath: (nextPath, workspace) =>
    ipcRenderer.invoke("workspace:set-shared-path", nextPath, workspace),
  resetSharedWorkspacePath: (workspace) =>
    ipcRenderer.invoke("workspace:reset-shared-path", workspace),
  pickSharedWorkspacePath: () => ipcRenderer.invoke("workspace:pick-shared-path"),
});

contextBridge.exposeInMainWorld("appearanceBridge", {
  getAppearance: () => ipcRenderer.invoke("appearance:get"),
  setAppearance: (appearance) => ipcRenderer.invoke("appearance:set", appearance),
  onAppearanceChanged: (handler) => {
    if (typeof handler !== "function") {
      return () => {};
    }
    const listener = (_event, appearance) => {
      handler(appearance);
    };
    ipcRenderer.on("appearance:changed", listener);
    return () => {
      ipcRenderer.removeListener("appearance:changed", listener);
    };
  },
});

contextBridge.exposeInMainWorld("searchBridge", {
  query: (criteria) => ipcRenderer.invoke("search:query", criteria),
  getStatus: () => ipcRenderer.invoke("search:status"),
});
