'use strict';

const { app, BrowserWindow, Tray, Menu, nativeImage, ipcMain, clipboard, screen, dialog, shell } = require('electron');
const { spawn } = require('child_process');
const path = require('path');
const fs   = require('fs');

// ── Ports ─────────────────────────────────────────────────────────────────
const BROWSER_WS_PORT   = 3340;
const BROWSER_HTTP_PORT = 3341;
const FIGMA_WS_PORT     = 3335;
const FIGMA_HTTP_PORT   = 3336;

// ── State ─────────────────────────────────────────────────────────────────
let tray  = null;
let popup = null;

// Per-relay state: browser + figma
const relay = {
  browser: { proc: null, running: false, logs: [], enabled: true },
  figma:   { proc: null, running: false, logs: [], enabled: true },
};

const MAX_LOGS = 100;

// ── Hide dock on macOS (tray-only app) ───────────────────────────────────
if (process.platform === 'darwin') app.dock.hide();

// ── Find Node.js binary ───────────────────────────────────────────────────
function getNodeBin() {
  const candidates = [
    process.env.NODE_BINARY,
    '/usr/local/bin/node',
    '/opt/homebrew/bin/node',
    '/usr/bin/node',
  ].filter(Boolean);

  const { execSync } = require('child_process');
  for (const p of candidates) {
    try { execSync(`"${p}" --version`, { stdio: 'ignore', timeout: 2000 }); return p; } catch (_) {}
  }
  try {
    return execSync('which node || command -v node', {
      shell: '/bin/zsh',
      env: { ...process.env, PATH: `/usr/local/bin:/opt/homebrew/bin:/usr/bin:${process.env.PATH || ''}` },
      timeout: 3000
    }).toString().trim();
  } catch (_) { return 'node'; }
}
const NODE_BIN = getNodeBin();

// ── Resource paths ────────────────────────────────────────────────────────
function getBrowserRelayPath() {
  return app.isPackaged
    ? path.join(process.resourcesPath, 'browser-server', 'index.js')
    : path.join(__dirname, 'browser-server', 'index.js');
}

function getBrowserExtensionPath() {
  return app.isPackaged
    ? path.join(process.resourcesPath, 'extension')
    : path.join(__dirname, 'extension');
}

function getFigmaRelayPath() {
  return app.isPackaged
    ? path.join(process.resourcesPath, 'figma-server', 'index.js')
    : path.join(__dirname, 'figma-server', 'index.js');
}

function getFigmaPluginPath() {
  return app.isPackaged
    ? path.join(process.resourcesPath, 'figma-plugin')
    : path.join(__dirname, 'figma-plugin');
}

function getIconPath() {
  return app.isPackaged
    ? path.join(process.resourcesPath, 'icon.png')
    : path.join(__dirname, '..', 'assets', 'icon.png'); // assets stays in main repo
}

function getTrayIcon() {
  try {
    const img = nativeImage.createFromPath(getIconPath());
    return img.resize({ width: 18, height: 18 });
  } catch (_) { return nativeImage.createEmpty(); }
}

function browserStdioConfig() {
  const p = getBrowserRelayPath().replace(/\\/g, '\\\\');
  return `"fauna-browser-mcp": {\n  "command": "node",\n  "args": ["${p}"]\n}`;
}

function figmaStdioConfig() {
  const p = getFigmaRelayPath().replace(/\\/g, '\\\\');
  return `"figma-fauna": {\n  "command": "node",\n  "args": ["${p}"]\n}`;
}

// ── Relay management ──────────────────────────────────────────────────────

function addLog(which, text, level = 'info') {
  const entry = { ts: Date.now(), text, level };
  relay[which].logs.push(entry);
  if (relay[which].logs.length > MAX_LOGS) relay[which].logs.shift();
  if (popup && !popup.isDestroyed()) popup.webContents.send('log', { which, entry });
}

function setRunning(which, running) {
  relay[which].running = running;
  updateTrayMenu();
  if (popup && !popup.isDestroyed()) popup.webContents.send('status', {
    which,
    running,
    browserRunning: relay.browser.running,
    figmaRunning:   relay.figma.running,
  });
}

function startRelay(which, _retryCount = 0) {
  const r = relay[which];
  if (r.proc || !r.enabled) return;

  // If we stopped recently, wait for ports to release before respawning
  const elapsed = r.stoppedAt ? Date.now() - r.stoppedAt : Infinity;
  if (elapsed < 1200) {
    const wait = 1200 - elapsed;
    addLog(which, `Waiting ${wait}ms for ports to release…`, 'info');
    setTimeout(() => startRelay(which, _retryCount), wait);
    return;
  }

  const relayPath = which === 'browser' ? getBrowserRelayPath() : getFigmaRelayPath();
  addLog(which, `Starting ${which} relay…`, 'info');

  r.proc = spawn(NODE_BIN, [relayPath], {
    env: { ...process.env },
    stdio: ['pipe', 'ignore', 'pipe']
  });
  // Keep stdin open (prevent EOF on the relay's StdioServerTransport)
  r.proc.stdin.resume();

  r.spawnedAt = Date.now();

  r.proc.stderr.on('data', chunk => {
    const text = chunk.toString().trim();
    for (const line of text.split('\n')) {
      if (line.trim()) addLog(which, line, /error/i.test(line) ? 'err' : 'ok');
    }
  });

  r.proc.on('spawn', () => {
    setRunning(which, true);
    addLog(which, `Relay started (pid ${r.proc.pid})`, 'ok');
  });

  r.proc.on('exit', (code, signal) => {
    const uptime = Date.now() - (r.spawnedAt || 0);
    r.proc = null;
    r.stoppedAt = Date.now();
    setRunning(which, false);
    addLog(which, `Relay stopped (code ${code ?? signal})`, code === 0 ? 'info' : 'err');
    // If it died within 3 s of spawning and user still wants it enabled, retry once
    if (r.enabled && uptime < 3000 && _retryCount < 1) {
      addLog(which, 'Died too quickly — retrying in 1.5 s…', 'info');
      setTimeout(() => startRelay(which, _retryCount + 1), 1500);
    }
  });

  r.proc.on('error', err => {
    r.proc = null;
    r.stoppedAt = Date.now();
    setRunning(which, false);
    addLog(which, `Failed to start: ${err.message} — is Node.js installed?`, 'err');
  });
}

function stopRelay(which) {
  const r = relay[which];
  if (!r.proc) return;
  addLog(which, `Stopping ${which} relay…`, 'info');
  r.proc.kill('SIGTERM');
}

// ── Popup window ──────────────────────────────────────────────────────────
function createPopup() {
  popup = new BrowserWindow({
    width: 360,
    height: 520,
    show: false,
    frame: false,
    resizable: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    roundedCorners: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      webSecurity: false
    }
  });

  popup.loadFile(path.join(__dirname, 'popup.html'));
  popup.on('blur',   () => { if (popup && !popup.isDestroyed()) popup.hide(); });
  popup.on('closed', () => { popup = null; });
}

function showPopup() {
  if (!popup || popup.isDestroyed()) createPopup();
  if (popup.isVisible()) { popup.hide(); return; }

  const trayBounds = tray.getBounds();
  const winBounds  = popup.getBounds();
  const display    = screen.getDisplayMatching(trayBounds);
  const wa         = display.workArea;

  let x = Math.round(trayBounds.x + trayBounds.width / 2 - winBounds.width / 2);
  let y = process.platform === 'darwin'
    ? trayBounds.y + trayBounds.height + 4
    : trayBounds.y - winBounds.height - 4;

  x = Math.max(wa.x, Math.min(x, wa.x + wa.width  - winBounds.width));
  y = Math.max(wa.y, Math.min(y, wa.y + wa.height - winBounds.height));

  popup.setPosition(x, y);
  popup.show();
  popup.focus();
}

// ── Tray context menu ─────────────────────────────────────────────────────
function updateTrayMenu() {
  if (!tray) return;

  const bStatus = relay.browser.running ? `● Browser  :${BROWSER_HTTP_PORT}/mcp` : '○ Browser stopped';
  const fStatus = relay.figma.running   ? `● Figma    :${FIGMA_HTTP_PORT}/mcp`   : '○ Figma stopped';

  const menu = Menu.buildFromTemplate([
    { label: 'FaunaMCP', enabled: false },
    { label: bStatus,    enabled: false },
    { label: fStatus,    enabled: false },
    { type: 'separator' },
    relay.browser.running
      ? { label: 'Stop Browser Relay',  click: () => stopRelay('browser')  }
      : { label: 'Start Browser Relay', click: () => startRelay('browser') },
    relay.figma.running
      ? { label: 'Stop Figma Relay',    click: () => stopRelay('figma')    }
      : { label: 'Start Figma Relay',   click: () => startRelay('figma')   },
    { type: 'separator' },
    { label: 'Copy Browser MCP URL', click: () => clipboard.writeText(`http://localhost:${BROWSER_HTTP_PORT}/mcp`) },
    { label: 'Copy Figma MCP URL',   click: () => clipboard.writeText(`http://localhost:${FIGMA_HTTP_PORT}/mcp`)   },
    { type: 'separator' },
    {
      label: 'Start at Login',
      type: 'checkbox',
      checked: app.getLoginItemSettings().openAtLogin,
      click: item => app.setLoginItemSettings({ openAtLogin: item.checked })
    },
    { type: 'separator' },
    { label: 'Quit FaunaMCP', click: () => { stopRelay('browser'); stopRelay('figma'); app.quit(); } }
  ]);

  tray.setContextMenu(menu);

  const running = [
    relay.browser.running ? 'Browser' : null,
    relay.figma.running   ? 'Figma'   : null,
  ].filter(Boolean);
  tray.setToolTip(running.length ? `FaunaMCP — ${running.join(', ')} running` : 'FaunaMCP — all stopped');
}

// ── Folder copy helper ────────────────────────────────────────────────────
async function saveFolderTo(srcDir, defaultName) {
  const { canceled, filePaths } = await dialog.showOpenDialog(popup || null, {
    title: 'Choose destination folder', buttonLabel: 'Save Here',
    properties: ['openDirectory', 'createDirectory']
  });
  if (canceled || !filePaths.length) return { ok: false, canceled: true };
  const dest = path.join(filePaths[0], defaultName);
  try {
    fs.cpSync(srcDir, dest, { recursive: true, force: true });
    return { ok: true, dest };
  } catch (err) { return { ok: false, error: err.message }; }
}

// ── IPC handlers ──────────────────────────────────────────────────────────

ipcMain.handle('get-status', () => ({
  browserRunning:   relay.browser.running,
  browserEnabled:   relay.browser.enabled,
  browserWsUrl:     `ws://localhost:${BROWSER_WS_PORT}`,
  browserHttpUrl:   `http://localhost:${BROWSER_HTTP_PORT}/mcp`,
  browserStdio:     browserStdioConfig(),
  browserExtPath:   getBrowserExtensionPath(),
  browserLogs:      relay.browser.logs.slice(-40),

  figmaRunning:     relay.figma.running,
  figmaEnabled:     relay.figma.enabled,
  figmaWsUrl:       `ws://localhost:${FIGMA_WS_PORT}`,
  figmaHttpUrl:     `http://localhost:${FIGMA_HTTP_PORT}/mcp`,
  figmaStdio:       figmaStdioConfig(),
  figmaPluginPath:  getFigmaPluginPath(),
  figmaLogs:        relay.figma.logs.slice(-40),

  loginItem:  app.getLoginItemSettings().openAtLogin,
  iconUrl:    `file://${getIconPath().replace(/\\/g, '/')}`,
  version:    app.getVersion()
}));

ipcMain.handle('start-relay',  (_, which) => startRelay(which));
ipcMain.handle('stop-relay',   (_, which) => stopRelay(which));

ipcMain.handle('set-enabled', (_, which, enabled) => {
  relay[which].enabled = enabled;
  if (!enabled) stopRelay(which);
  else if (!relay[which].running) startRelay(which);
  updateTrayMenu();
  return { browserEnabled: relay.browser.enabled, figmaEnabled: relay.figma.enabled };
});

ipcMain.handle('copy',       (_, txt) => clipboard.writeText(txt));
ipcMain.handle('set-login',  (_, on)  => {
  app.setLoginItemSettings({ openAtLogin: on });
  updateTrayMenu();
  return app.getLoginItemSettings().openAtLogin;
});
ipcMain.handle('close-popup',       ()  => { if (popup && !popup.isDestroyed()) popup.hide(); });
ipcMain.handle('save-extension',    ()  => saveFolderTo(getBrowserExtensionPath(), 'FaunaBrowserMCP-extension'));
ipcMain.handle('reveal-extension',  ()  => shell.showItemInFolder(getBrowserExtensionPath()));
ipcMain.handle('save-plugin',       ()  => saveFolderTo(getFigmaPluginPath(), 'FaunaFigmaPlugin'));
ipcMain.handle('reveal-plugin',     ()  => shell.showItemInFolder(getFigmaPluginPath()));

// ── App lifecycle ─────────────────────────────────────────────────────────
app.whenReady().then(() => {
  tray = new Tray(getTrayIcon());
  updateTrayMenu();
  tray.on('click', showPopup);
  createPopup();
  startRelay('browser');
  startRelay('figma');
});

app.on('before-quit', () => { stopRelay('browser'); stopRelay('figma'); });
app.on('window-all-closed', e => e.preventDefault());
