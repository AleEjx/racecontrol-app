const { app, BrowserWindow, globalShortcut, ipcMain, Tray, Menu, nativeImage, shell } = require("electron");
const path = require("path");
const fs   = require("fs");
const { autoUpdater } = require("electron-updater");

// Store app data on D: drive
app.setPath("userData", "D:\\RaceLeagueData\\racecontrol-driver");
const CONFIG_FILE = path.join(app.getPath("userData"), "config.json");

function loadConfig() {
  try { if (fs.existsSync(CONFIG_FILE)) return JSON.parse(fs.readFileSync(CONFIG_FILE, "utf8")); } catch {}
  return { apiUrl: "", alwaysOnTop: true, keybinds: { blue_flag: "F1", next_lap: "F2", pitting: "F3" } };
}
function saveConfig(cfg) { fs.writeFileSync(CONFIG_FILE, JSON.stringify(cfg, null, 2)); }

let config     = loadConfig();
let mainWindow = null;
let tray       = null;
let inPits     = false;
let onCooldown = false;

// ── Single instance lock — kill previous zombie if already running ────────
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  // Another instance is running — focus it and quit this one
  app.quit();
  process.exit(0);
}
app.on("second-instance", () => {
  if (mainWindow) { if (mainWindow.isMinimized()) mainWindow.restore(); mainWindow.focus(); }
});

// ── Local OAuth redirect server ───────────────────────────────────────────
const http = require("http");
const OAUTH_PORT = 7823;
let oauthResolve = null;
const oauthServer = http.createServer((req, res) => {
  const url  = new URL(req.url, `http://localhost:${OAUTH_PORT}`);
  const code = url.searchParams.get("code");
  res.writeHead(200, { "Content-Type": "text/html" });
  res.end("<html><body style='background:#0a0a0f;color:#e8e8f0;font-family:sans-serif;display:flex;align-items:center;justify-content:center;height:100vh;margin:0;'><h2>✅ Logged in! You can close this window.</h2></body></html>");
  if (code && oauthResolve) { oauthResolve(code); oauthResolve = null; }
});

// Start OAuth server — handle port conflict gracefully instead of crashing
oauthServer.on("error", (err) => {
  if (err.code === "EADDRINUSE") {
    console.warn(`[OAuth] Port ${OAUTH_PORT} already in use — another instance may be running.`);
    // Still usable; the existing server on that port belongs to the old instance
    // which the single-instance lock above should have already prevented.
  } else {
    console.error("[OAuth] Server error:", err.message);
  }
});
oauthServer.listen(OAUTH_PORT);

app.whenReady().then(() => {
  createWindow();
  createTray();
  setupAutoUpdater();
});

// ── Fully quit when all windows closed ───────────────────────────────────
app.on("window-all-closed", () => app.quit());

function setupAutoUpdater() {
  autoUpdater.autoDownload         = true;
  autoUpdater.autoInstallOnAppQuit = false;
  autoUpdater.on("update-available",  (info) => { mainWindow?.webContents.send("update-available",  info.version); console.log(`[Updater] Available: v${info.version}`); });
  autoUpdater.on("update-downloaded", (info) => { mainWindow?.webContents.send("update-downloaded", info.version); console.log(`[Updater] Downloaded: v${info.version}`); });
  autoUpdater.on("error", (err) => console.log("[Updater] Error:", err.message));
  setTimeout(() => autoUpdater.checkForUpdates().catch(() => {}), 5000);
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 440, height: 740, minWidth: 380, minHeight: 500,
    alwaysOnTop: config.alwaysOnTop,
    frame: false, transparent: false, backgroundColor: "#0a0a0f",
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      autoplayPolicy: "no-user-gesture-required",
    },
    icon:  path.join(__dirname, "../assets/icon.png"),
    title: "RaceLeague Control",
  });

  mainWindow.loadFile(path.join(__dirname, "renderer.html"));

  // ── Close button fully quits ──────────────────────────────────────────
  mainWindow.on("close", () => {
    globalShortcut.unregisterAll();
    app.quit();
  });

  mainWindow.on("closed", () => { mainWindow = null; });
}

function createTray() {
  const iconPath = path.join(__dirname, "../assets/tray.png");
  const icon = fs.existsSync(iconPath)
    ? nativeImage.createFromPath(iconPath).resize({ width: 16, height: 16 })
    : nativeImage.createEmpty();

  tray = new Tray(icon);
  tray.setToolTip("RaceLeague Control");

  const menu = Menu.buildFromTemplate([
    { label: "Show", click: () => { mainWindow?.show(); mainWindow?.focus(); } },
    { label: "Always on Top", type: "checkbox", checked: config.alwaysOnTop, click: (item) => {
      config.alwaysOnTop = item.checked;
      mainWindow?.setAlwaysOnTop(item.checked);
      saveConfig(config);
    }},
    { type: "separator" },
    { label: "Quit", click: () => { globalShortcut.unregisterAll(); app.quit(); } },
  ]);

  tray.setContextMenu(menu);
  tray.on("click", () => { mainWindow?.show(); mainWindow?.focus(); });
}

function registerHotkeys(keybinds) {
  globalShortcut.unregisterAll();
  const { blue_flag, next_lap, pitting } = keybinds || {};
  if (blue_flag) globalShortcut.register(blue_flag, () => sendDriverAction("blue_flag"));
  if (next_lap)  globalShortcut.register(next_lap,  () => sendDriverAction("next_lap"));
  if (pitting)   globalShortcut.register(pitting,   () => {
    inPits = !inPits;
    sendDriverAction(inPits ? "pitting" : "in_race");
    mainWindow?.webContents.send("pit-state-changed", inPits);
  });
}

async function sendDriverAction(action) {
  if (!config.apiUrl || !config.driver) {
    mainWindow?.webContents.send("toast", { msg: "⚠️ Not configured", type: "err" });
    return;
  }
  if (onCooldown) {
    mainWindow?.webContents.send("toast", { msg: "⏳ Cooldown active", type: "err" });
    return;
  }
  try {
    const res = await fetch(`${config.apiUrl}/driver/action`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        action,
        driver:    config.driver,
        callsign:  config.callsign,
        number:    config.number,
        discordId: config.discordId,
        username:  config.driver,
        engineer:  config.engineer || false,
      }),
    });
    if (res.ok) {
      const labels = { blue_flag:"🔵 Blue Flag", next_lap:"🏁 Next Lap", pitting:"🔧 Pitting", in_race:"🏎️ Back on Track" };
      mainWindow?.webContents.send("toast", { msg: `✓ ${labels[action]}`, type: "ok" });
      onCooldown = true;
      mainWindow?.webContents.send("cooldown-start", 7);
      setTimeout(() => { onCooldown = false; mainWindow?.webContents.send("cooldown-end"); }, 7000);
    }
  } catch {
    mainWindow?.webContents.send("toast", { msg: "✗ Bot unreachable", type: "err" });
  }
}

// ── OAuth window ──────────────────────────────────────────────────────────
ipcMain.handle("open-oauth", (_, _url) => {
  return new Promise((resolve) => {
    oauthResolve = (code) => { if (authWin && !authWin.isDestroyed()) authWin.destroy(); resolve(code); };
    const CLIENT_ID  = "1467595519718195473";
    const REDIRECT   = encodeURIComponent(`http://localhost:${OAUTH_PORT}`);
    const discordUrl = `https://discord.com/oauth2/authorize?client_id=${CLIENT_ID}&redirect_uri=${REDIRECT}&response_type=code&scope=identify`;
    const authWin = new BrowserWindow({
      width: 520, height: 720, show: true, alwaysOnTop: true,
      webPreferences: { nodeIntegration: false, contextIsolation: true },
      title: "Login with Discord", autoHideMenuBar: true,
    });
    authWin.loadURL(discordUrl);
    authWin.show(); authWin.focus();
    authWin.on("closed", () => { if (oauthResolve) { oauthResolve = null; resolve(null); } });
  });
});

// ── IPC handlers ──────────────────────────────────────────────────────────
ipcMain.handle("get-config",     ()      => config);
ipcMain.handle("save-config",    (_, cfg) => { config = { ...config, ...cfg }; saveConfig(config); if (cfg.keybinds) registerHotkeys(cfg.keybinds); return true; });
ipcMain.handle("send-action",    (_, action) => sendDriverAction(action));
ipcMain.handle("toggle-pitting", () => { inPits = !inPits; sendDriverAction(inPits ? "pitting" : "in_race"); mainWindow?.webContents.send("pit-state-changed", inPits); return inPits; });
ipcMain.handle("minimize-app",   () => mainWindow?.minimize());
ipcMain.handle("close-app",      () => { globalShortcut.unregisterAll(); app.quit(); });
ipcMain.handle("toggle-top",     () => { config.alwaysOnTop = !config.alwaysOnTop; mainWindow?.setAlwaysOnTop(config.alwaysOnTop); saveConfig(config); return config.alwaysOnTop; });
ipcMain.handle("open-devtools",  () => mainWindow?.webContents.openDevTools());
ipcMain.handle("install-update", () => autoUpdater.quitAndInstall());
ipcMain.handle("check-version",  () => app.getVersion());
ipcMain.handle("flag-broadcast", (_, data) => mainWindow?.webContents.send("flag-event", data));
ipcMain.handle("register-hotkeys", (_, keybinds) => { registerHotkeys(keybinds); return true; });

app.on("will-quit", () => globalShortcut.unregisterAll());
