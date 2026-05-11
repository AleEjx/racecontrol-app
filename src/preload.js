const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("api", {
  getConfig:        ()        => ipcRenderer.invoke("get-config"),
  saveConfig:       (cfg)     => ipcRenderer.invoke("save-config", cfg),
  sendAction:       (a)       => ipcRenderer.invoke("send-action", a),
  togglePitting:    ()        => ipcRenderer.invoke("toggle-pitting"),
  minimize:         ()        => ipcRenderer.invoke("minimize-app"),
  close:            ()        => ipcRenderer.invoke("close-app"),
  toggleTop:        ()        => ipcRenderer.invoke("toggle-top"),
  openDevTools:     ()        => ipcRenderer.invoke("open-devtools"),
  openOAuth:        (url)     => ipcRenderer.invoke("open-oauth", url),
  installUpdate:    ()        => ipcRenderer.invoke("install-update"),
  checkVersion:     ()        => ipcRenderer.invoke("check-version"),
  registerHotkeys:  (kb)      => ipcRenderer.invoke("register-hotkeys", kb),

  onUpdateAvailable:  (cb) => ipcRenderer.on("update-available",  (_, v) => cb(v)),
  onUpdateDownloaded: (cb) => ipcRenderer.on("update-downloaded", (_, v) => cb(v)),
  onToast:            (cb) => ipcRenderer.on("toast",             (_, d) => cb(d)),
  onCooldownStart:    (cb) => ipcRenderer.on("cooldown-start",    (_, s) => cb(s)),
  onCooldownEnd:      (cb) => ipcRenderer.on("cooldown-end",      ()     => cb()),
  onPitStateChanged:  (cb) => ipcRenderer.on("pit-state-changed", (_, v) => cb(v)),
  onFlagEvent:        (cb) => ipcRenderer.on("flag-event",        (_, d) => cb(d)),
});
