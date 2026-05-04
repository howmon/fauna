'use strict';

const { app, BrowserWindow, Tray, Menu, nativeImage, ipcMain, clipboard, screen, dialog, shell } = require('electron');
const { spawn } = require('child_process');
const path = require('path');
const fs   = require('fs');

const WS_PORT   = 3335;
const HTTP_PORT = 3336;

let tray         = null;
let popup        = null;
let relayProcess = null;
let relayRunning = false;
let relayLogs    = [];
const MAX_LOGS   = 100;

// ── Hide dock on macOS (tray-only app) ───────────────────────────────────
if (process.platform === 'darwin') app.dock.hide();

// ── Find Node.js binary (packaged apps lose PATH) ─────────────────────────
function getNodeBin() {
  // In packaged app, process.execPath is the Electron binary — not Node.
  // Try common install locations in order.
  const candidates = [
    process.env.NODE_BINARY,                       // override via env
    '/usr/local/bin/node',                         // Homebrew / nvm default
    '/opt/homebrew/bin/node',                      // Apple-silicon Homebrew
    '/usr/bin/node',                               // system node
    `${process.env.HOME}/.nvm/versions/node/$(ls ${process.env.HOME}/.nvm/versions/node 2>/dev/null | sort -V | tail -1)/bin/node`,
  ].filter(Boolean);

  const { execSync } = require('child_process');
  for (const p of candidates) {
    try {
      execSync(`"${p}" --version`, { stdio: 'ignore', timeout: 2000 });
      return p;
    } catch (_) {}
  }

  // Last resort: ask the shell for the resolved path
  try {
    return execSync('which node || command -v node', {
      shell: '/bin/zsh', env: { ...process.env, PATH: `/usr/local/bin:/opt/homebrew/bin:/usr/bin:${process.env.PATH || ''}` },
      timeout: 3000
    }).toString().trim();
  } catch (_) {
    return 'node'; // fallback, will show ENOENT in log
  }
}

const NODE_BIN = getNodeBin();


function getRelayPath() {
  return app.isPackaged
    ? path.join(process.resourcesPath, 'mcp-server', 'server', 'index.js')
    : path.join(__dirname, '..', 'relay', 'server', 'index.js');
}

function getIconPath() {
  return app.isPackaged
    ? path.join(process.resourcesPath, 'icon.png')
    : path.join(__dirname, '..', 'assets', 'icon.png');
}

function getTrayIcon() {
  try {
    const img = nativeImage.createFromPath(getIconPath());
    return img.resize({ width: 18, height: 18 });
  } catch (_) {
    return nativeImage.createEmpty();
  }
}

function getPluginPath() {
  return app.isPackaged
    ? path.join(process.resourcesPath, 'figma-plugin')
    : path.join(__dirname, '..', 'assets', 'figma-plugin');
}

function stdioConfig() {
  const p = getRelayPath().replace(/\\/g, '\\\\');
  return `"figma-fauna": {\n  "command": "node",\n  "args": ["${p}"]\n}`;
}

// ── Folder copy helper ────────────────────────────────────────────────────
async function saveFolderTo(srcDir, defaultName) {
  const { canceled, filePaths } = await dialog.showOpenDialog(popup || null, {
    title:       'Choose destination folder',
    buttonLabel: 'Save Here',
    properties:  ['openDirectory', 'createDirectory']
  });
  if (canceled || !filePaths.length) return { ok: false, canceled: true };
  const dest = path.join(filePaths[0], defaultName);
  try {
    fs.cpSync(srcDir, dest, { recursive: true, force: true });
    return { ok: true, dest };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

// ── Relay process ─────────────────────────────────────────────────────────
function addLog(text, level = 'info') {
  const entry = { ts: Date.now(), text, level };
  relayLogs.push(entry);
  if (relayLogs.length > MAX_LOGS) relayLogs.shift();
  if (popup && !popup.isDestroyed()) popup.webContents.send('log', entry);
}

function setRunning(running) {
  relayRunning = running;
  updateTrayMenu();
  if (popup && !popup.isDestroyed()) popup.webContents.send('status', { running });
}

function startRelay() {
  if (relayProcess) return;
  const relayPath = getRelayPath();
  addLog('Starting relay…', 'info');

  relayProcess = spawn(NODE_BIN, [relayPath], {
    env: { ...process.env },
    stdio: ['ignore', 'ignore', 'pipe']
  });

  relayProcess.stderr.on('data', chunk => {
    const text = chunk.toString().trim();
    for (const line of text.split('\n')) {
      if (line.trim()) {
        const level = /error/i.test(line) ? 'err' : 'ok';
        addLog(line, level);
      }
    }
  });

  relayProcess.on('spawn', () => {
    setRunning(true);
    addLog(`Relay started (pid ${relayProcess.pid})`, 'ok');
  });

  relayProcess.on('exit', (code, signal) => {
    relayProcess = null;
    setRunning(false);
    addLog(`Relay stopped (code ${code ?? signal})`, code === 0 ? 'info' : 'err');
  });

  relayProcess.on('error', err => {
    relayProcess = null;
    setRunning(false);
    addLog(`Failed to start: ${err.message} — is Node.js installed?`, 'err');
  });
}

function stopRelay() {
  if (!relayProcess) return;
  addLog('Stopping relay…', 'info');
  relayProcess.kill('SIGTERM');
}

// ── Popup window ──────────────────────────────────────────────────────────
function createPopup() {
  popup = new BrowserWindow({
    width: 320,
    height: 382,
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
      webSecurity: false   // needed to load file:// icon from resources
    }
  });

  popup.loadFile(path.join(__dirname, 'popup.html'));

  popup.on('blur', () => {
    if (popup && !popup.isDestroyed()) popup.hide();
  });
  popup.on('closed', () => { popup = null; });
}

function showPopup() {
  if (!popup || popup.isDestroyed()) createPopup();

  if (popup.isVisible()) {
    popup.hide();
    return;
  }

  // Position near tray icon
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

  const statusLabel = relayRunning
    ? `● Running  :${WS_PORT}  ·  :${HTTP_PORT}/mcp`
    : '○ Stopped';

  const menu = Menu.buildFromTemplate([
    { label: 'FaunaFigmaMCP',   enabled: false },
    { label: statusLabel,  enabled: false },
    { type: 'separator' },
    relayRunning
      ? { label: 'Stop Relay',  click: stopRelay  }
      : { label: 'Start Relay', click: startRelay },
    { type: 'separator' },
    { label: 'Copy HTTP/MCP URL',  click: () => clipboard.writeText(`http://localhost:${HTTP_PORT}/mcp`) },
    { label: 'Copy stdio config',  click: () => clipboard.writeText(stdioConfig()) },
    { type: 'separator' },
    {
      label: 'Start at Login',
      type: 'checkbox',
      checked: app.getLoginItemSettings().openAtLogin,
      click: item => app.setLoginItemSettings({ openAtLogin: item.checked })
    },
    { type: 'separator' },
    { label: 'Quit FaunaFigmaMCP', click: () => { stopRelay(); app.quit(); } }
  ]);

  tray.setContextMenu(menu);
  tray.setToolTip(
    relayRunning
      ? `FaunaFigmaMCP ● Running\nHTTP: http://localhost:${HTTP_PORT}/mcp`
      : 'FaunaFigmaMCP ○ Stopped'
  );
}

// ── IPC handlers ──────────────────────────────────────────────────────────
ipcMain.handle('get-status', () => ({
  running:     relayRunning,
  wsUrl:       `ws://localhost:${WS_PORT}`,
  httpUrl:     `http://localhost:${HTTP_PORT}/mcp`,
  stdioConfig: stdioConfig(),
  pluginPath:  getPluginPath(),
  logs:        relayLogs.slice(-40),
  loginItem:   app.getLoginItemSettings().openAtLogin,
  iconUrl:     `file://${getIconPath().replace(/\\/g, '/')}`
}));

ipcMain.handle('start-relay',  ()       => startRelay());
ipcMain.handle('stop-relay',   ()       => stopRelay());
ipcMain.handle('copy',         (_, txt) => clipboard.writeText(txt));
ipcMain.handle('set-login',    (_, on)  => {
  app.setLoginItemSettings({ openAtLogin: on });
  updateTrayMenu();
  return app.getLoginItemSettings().openAtLogin;
});
ipcMain.handle('close-popup',  ()       => { if (popup && !popup.isDestroyed()) popup.hide(); });
ipcMain.handle('save-plugin',  ()       => saveFolderTo(getPluginPath(), 'FaunaFigmaPlugin'));
ipcMain.handle('reveal-plugin',()       => { shell.showItemInFolder(getPluginPath()); });

// ── App lifecycle ─────────────────────────────────────────────────────────
app.whenReady().then(() => {
  tray = new Tray(getTrayIcon());
  updateTrayMenu();
  tray.on('click', showPopup);
  createPopup();
  startRelay();
});

app.on('before-quit', () => { if (relayProcess) relayProcess.kill('SIGTERM'); });
app.on('window-all-closed', e => e.preventDefault()); // keep alive as tray app
