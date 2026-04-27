const path = require("path");
const fs = require("fs");
const os = require("os");
const { app, BrowserWindow, ipcMain } = require("electron");

const isDev = !app.isPackaged;
const sharedWorkspaceFile =
  process.env.CHANGBIAN_MCP_STORE ||
  path.join(os.homedir(), ".changbian-workbench", "workspace.json");

function loadSharedWorkspace() {
  try {
    if (!fs.existsSync(sharedWorkspaceFile)) {
      return null;
    }
    const raw = fs.readFileSync(sharedWorkspaceFile, "utf8");
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function saveSharedWorkspace(workspace) {
  try {
    fs.mkdirSync(path.dirname(sharedWorkspaceFile), { recursive: true });
    fs.writeFileSync(sharedWorkspaceFile, JSON.stringify(workspace, null, 2), "utf8");
    return true;
  } catch {
    return false;
  }
}

ipcMain.handle("workspace:load-shared", () => loadSharedWorkspace());
ipcMain.handle("workspace:save-shared", (_event, workspace) => saveSharedWorkspace(workspace));
ipcMain.handle("workspace:shared-path", () => sharedWorkspaceFile);

function createWindow() {
  const mainWindow = new BrowserWindow({
    width: 1600,
    height: 960,
    minWidth: 1180,
    minHeight: 760,
    titleBarStyle: "hiddenInset",
    backgroundColor: "#0f1114",
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      spellcheck: false,
    },
  });

  if (isDev) {
    mainWindow.loadURL("http://localhost:5173");
  } else {
    mainWindow.loadFile(path.join(__dirname, "..", "dist", "index.html"));
  }
}

app.whenReady().then(() => {
  createWindow();

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
  }
});
