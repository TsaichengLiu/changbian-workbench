const path = require("path");
const fs = require("fs");
const os = require("os");
const { app, BrowserWindow, Menu, dialog, ipcMain } = require("electron");

const isDev = !app.isPackaged;
const DEFAULT_SHARED_WORKSPACE_FILE = path.join(os.homedir(), ".changbian-workbench", "workspace.json");
const SETTINGS_FILE = path.join(os.homedir(), ".changbian-workbench", "settings.json");
const forcedWorkspaceFile = (process.env.CHANGBIAN_MCP_STORE || "").trim();
const DEFAULT_APPEARANCE = Object.freeze({
  theme: "changbian",
  cardStyle: "changbian",
});
const UI_THEME_IDS = new Set(["changbian", "obsidian", "ocean", "graphite", "dusk", "vaporwave"]);
const UI_CARD_STYLE_IDS = new Set(["changbian", "outline", "frosted"]);

const MENU_THEME_OPTIONS = [
  { id: "changbian", label: "縹緗" },
  { id: "obsidian", label: "黑曜石" },
  { id: "ocean", label: "海藍" },
  { id: "graphite", label: "石墨" },
  { id: "dusk", label: "黃昏" },
  { id: "vaporwave", label: "蒸汽波" },
];
const MENU_CARD_OPTIONS = [
  { id: "changbian", label: "縹緗" },
  { id: "outline", label: "毛玻璃" },
  { id: "frosted", label: "金屬" },
];

function loadSettings() {
  try {
    if (!fs.existsSync(SETTINGS_FILE)) {
      return {};
    }
    const raw = fs.readFileSync(SETTINGS_FILE, "utf8");
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") {
      return {};
    }
    return parsed;
  } catch {
    return {};
  }
}

function saveSettings(settings) {
  try {
    fs.mkdirSync(path.dirname(SETTINGS_FILE), { recursive: true });
    fs.writeFileSync(SETTINGS_FILE, JSON.stringify(settings, null, 2), "utf8");
    return true;
  } catch {
    return false;
  }
}

function sanitizeAppearance(raw, fallback = DEFAULT_APPEARANCE) {
  const source = raw && typeof raw === "object" ? raw : {};
  const theme = typeof source.theme === "string" && UI_THEME_IDS.has(source.theme) ? source.theme : fallback.theme;
  const cardStyle =
    typeof source.cardStyle === "string" && UI_CARD_STYLE_IDS.has(source.cardStyle)
      ? source.cardStyle
      : fallback.cardStyle;
  return { theme, cardStyle };
}

function loadAppearanceFromSettings() {
  const settings = loadSettings();
  return sanitizeAppearance(settings.appearance, DEFAULT_APPEARANCE);
}

function resolveSharedWorkspaceFile() {
  if (forcedWorkspaceFile) {
    return forcedWorkspaceFile;
  }
  const settings = loadSettings();
  const configuredPath = typeof settings.workspacePath === "string" ? settings.workspacePath.trim() : "";
  return configuredPath || DEFAULT_SHARED_WORKSPACE_FILE;
}

let sharedWorkspaceFile = resolveSharedWorkspaceFile();
let currentAppearance = loadAppearanceFromSettings();

function broadcastAppearance() {
  const payload = { ...currentAppearance };
  for (const win of BrowserWindow.getAllWindows()) {
    if (win.isDestroyed()) {
      continue;
    }
    win.webContents.send("appearance:changed", payload);
  }
}

function applyAppearance(nextAppearance, source = "renderer") {
  const merged = sanitizeAppearance({ ...currentAppearance, ...(nextAppearance || {}) }, currentAppearance);
  const changed =
    merged.theme !== currentAppearance.theme || merged.cardStyle !== currentAppearance.cardStyle;
  if (!changed) {
    return { changed: false, appearance: currentAppearance };
  }

  currentAppearance = merged;
  const settings = loadSettings();
  settings.appearance = currentAppearance;
  saveSettings(settings);
  setApplicationMenu();

  if (source === "menu") {
    broadcastAppearance();
  }
  return { changed: true, appearance: currentAppearance };
}

function getStorageInfo() {
  return {
    path: sharedWorkspaceFile,
    defaultPath: DEFAULT_SHARED_WORKSPACE_FILE,
    envLocked: Boolean(forcedWorkspaceFile),
    envPath: forcedWorkspaceFile || null,
  };
}

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

function setSharedWorkspacePath(nextPath, workspace) {
  if (forcedWorkspaceFile) {
    return {
      ok: false,
      error: `目前由環境變數 CHANGBIAN_MCP_STORE 鎖定路徑：${forcedWorkspaceFile}`,
    };
  }

  const candidate = typeof nextPath === "string" ? nextPath.trim() : "";
  if (!candidate) {
    return { ok: false, error: "請輸入有效路徑。" };
  }

  const normalizedPath = path.resolve(candidate);
  const settings = loadSettings();
  settings.workspacePath = normalizedPath;
  if (!saveSettings(settings)) {
    return { ok: false, error: "無法保存路徑設定。" };
  }

  sharedWorkspaceFile = normalizedPath;
  if (workspace && typeof workspace === "object") {
    const saved = saveSharedWorkspace(workspace);
    if (!saved) {
      return { ok: false, error: "路徑切換成功，但寫入資料失敗。" };
    }
  }

  return { ok: true, path: sharedWorkspaceFile };
}

function resetSharedWorkspacePath(workspace) {
  if (forcedWorkspaceFile) {
    return {
      ok: false,
      error: `目前由環境變數 CHANGBIAN_MCP_STORE 鎖定路徑：${forcedWorkspaceFile}`,
    };
  }

  const settings = loadSettings();
  delete settings.workspacePath;
  if (!saveSettings(settings)) {
    return { ok: false, error: "無法重設路徑設定。" };
  }

  sharedWorkspaceFile = DEFAULT_SHARED_WORKSPACE_FILE;
  if (workspace && typeof workspace === "object") {
    const saved = saveSharedWorkspace(workspace);
    if (!saved) {
      return { ok: false, error: "路徑重設成功，但寫入資料失敗。" };
    }
  }

  return { ok: true, path: sharedWorkspaceFile };
}

function buildAppearanceSubmenu() {
  return [
    {
      label: "配色",
      submenu: MENU_THEME_OPTIONS.map((option) => ({
        label: option.label,
        type: "radio",
        checked: currentAppearance.theme === option.id,
        click: () => {
          applyAppearance({ theme: option.id }, "menu");
        },
      })),
    },
    {
      label: "卡片",
      submenu: MENU_CARD_OPTIONS.map((option) => ({
        label: option.label,
        type: "radio",
        checked: currentAppearance.cardStyle === option.id,
        click: () => {
          applyAppearance({ cardStyle: option.id }, "menu");
        },
      })),
    },
  ];
}

function buildAppMenuTemplate() {
  const base = [
    { role: "appMenu" },
    { role: "fileMenu" },
    { role: "editMenu" },
    {
      label: "外觀",
      submenu: buildAppearanceSubmenu(),
    },
    { role: "viewMenu" },
    { role: "windowMenu" },
  ];

  if (process.platform !== "darwin") {
    return [
      ...base,
      {
        role: "help",
        submenu: [],
      },
    ];
  }
  return base;
}

function setApplicationMenu() {
  const menu = Menu.buildFromTemplate(buildAppMenuTemplate());
  Menu.setApplicationMenu(menu);
}

ipcMain.handle("workspace:load-shared", () => loadSharedWorkspace());
ipcMain.handle("workspace:save-shared", (_event, workspace) => saveSharedWorkspace(workspace));
ipcMain.handle("workspace:shared-path", () => sharedWorkspaceFile);
ipcMain.handle("workspace:storage-info", () => getStorageInfo());
ipcMain.handle("workspace:set-shared-path", (_event, nextPath, workspace) =>
  setSharedWorkspacePath(nextPath, workspace),
);
ipcMain.handle("workspace:reset-shared-path", (_event, workspace) =>
  resetSharedWorkspacePath(workspace),
);
ipcMain.handle("appearance:get", () => ({ ...currentAppearance }));
ipcMain.handle("appearance:set", (_event, nextAppearance) => {
  const { appearance } = applyAppearance(nextAppearance, "renderer");
  return { ...appearance };
});
ipcMain.handle("workspace:pick-shared-path", async () => {
  const focused = BrowserWindow.getFocusedWindow() || BrowserWindow.getAllWindows()[0] || undefined;
  const result = await dialog.showSaveDialog(focused, {
    title: "選擇史料資料檔",
    defaultPath: sharedWorkspaceFile,
    filters: [{ name: "JSON", extensions: ["json"] }],
    properties: ["createDirectory", "showOverwriteConfirmation"],
  });

  if (result.canceled) {
    return null;
  }
  return result.filePath || null;
});

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

  mainWindow.webContents.on("did-finish-load", () => {
    if (!mainWindow.isDestroyed()) {
      mainWindow.webContents.send("appearance:changed", { ...currentAppearance });
    }
  });
}

app.whenReady().then(() => {
  setApplicationMenu();
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
