'use strict';

const { app, BrowserWindow, Tray, Menu, nativeImage, ipcMain, clipboard, screen, dialog, shell } = require('electron');
const { spawn } = require('child_process');
const path = require('path');
const fs   = require('fs');
const https = require('https');

// ── Ports ─────────────────────────────────────────────────────────────────
const BROWSER_WS_PORT   = 3340;
const BROWSER_HTTP_PORT = 3341;
const FIGMA_WS_PORT     = 3335;
const FIGMA_HTTP_PORT   = 3336;
const REPO_URL          = 'https://github.com/howmon/faunaMCP';
const BRANCH_API_URL    = 'https://api.github.com/repos/howmon/faunaMCP/commits/main';
const SOURCE_ZIP_URL    = 'https://github.com/howmon/faunaMCP/archive/refs/heads/main.zip';
const MAC_APP_PATH      = '/Applications/FaunaMCP.app';

// ── State ─────────────────────────────────────────────────────────────────
let tray  = null;
let popup = null;

const gotSingleInstanceLock = app.requestSingleInstanceLock();
if (!gotSingleInstanceLock) app.quit();

app.on('second-instance', () => {
  showPopup();
});

// Per-relay state: browser + figma
const relay = {
  browser: { proc: null, running: false, logs: [], enabled: true },
  figma:   { proc: null, running: false, logs: [], enabled: true },
};

const MAX_LOGS = 100;

// ── Self update state ────────────────────────────────────────────────────
let updateState = {
  checking: false,
  running: false,
  phase: 'idle',
  message: 'Idle',
  error: null,
  currentSha: null,
  latestSha: null,
  updateAvailable: false,
  sourceDir: null,
  installerPath: null,
  logs: [],
};

// ── Find command-line tools ───────────────────────────────────────────────
const DEFAULT_CLI_PATH = [
  '/opt/homebrew/bin',
  '/usr/local/bin',
  '/usr/bin',
  '/bin',
  '/usr/sbin',
  '/sbin',
].join(':');

function cliEnv(extra = {}) {
  const env = { ...process.env, ...extra };
  env.PATH = `${DEFAULT_CLI_PATH}:${env.PATH || ''}`;
  return env;
}

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
      env: cliEnv(),
      timeout: 3000
    }).toString().trim();
  } catch (_) { return 'node'; }
}
const NODE_BIN = getNodeBin();

function getNpmBin() {
  if (process.platform === 'win32') return process.env.NPM_BINARY || 'npm.cmd';

  const candidates = [
    process.env.NPM_BINARY,
    '/opt/homebrew/bin/npm',
    '/usr/local/bin/npm',
  ].filter(Boolean);

  const { execSync } = require('child_process');
  for (const p of candidates) {
    try { execSync(`"${p}" --version`, { stdio: 'ignore', timeout: 2000, env: cliEnv() }); return p; } catch (_) {}
  }
  try {
    return execSync('which npm || command -v npm', {
      shell: '/bin/zsh',
      env: cliEnv(),
      timeout: 3000
    }).toString().trim();
  } catch (_) { return 'npm'; }
}
const NPM_BIN = getNpmBin();

function emitUpdateState() {
  if (popup && !popup.isDestroyed()) popup.webContents.send('update-status', updateState);
  updateTrayMenu();
}

function updateLog(message, phase = null) {
  if (phase) updateState.phase = phase;
  updateState.message = message;
  updateState.logs.push({ ts: Date.now(), message });
  if (updateState.logs.length > 160) updateState.logs.shift();
  console.log('[Update]', message);
  emitUpdateState();
}

function updateRoot() { return path.join(app.getPath('userData'), 'self-update'); }
function updateStatePath() { return path.join(app.getPath('userData'), 'update-state.json'); }
function updateSourceDir() { return path.join(updateRoot(), 'source'); }
function updateZipPath() { return path.join(updateRoot(), 'faunaMCP-main.zip'); }
function npmCommand() { return NPM_BIN; }

function installedAppPath() {
  if (process.platform === 'darwin') return MAC_APP_PATH;
  if (process.platform === 'win32') return path.join(process.env.LOCALAPPDATA || path.join(require('os').homedir(), 'AppData', 'Local'), 'Programs', 'FaunaMCP', 'FaunaMCP.exe');
  return null;
}

function loadInstalledSha() {
  try { return JSON.parse(fs.readFileSync(updateStatePath(), 'utf8')).installedSha || null; }
  catch (_) { return null; }
}

function saveInstalledSha(sha) {
  fs.mkdirSync(path.dirname(updateStatePath()), { recursive: true });
  fs.writeFileSync(updateStatePath(), JSON.stringify({ installedSha: sha, updatedAt: new Date().toISOString() }, null, 2));
}

function requestJson(url) {
  return new Promise((resolve, reject) => {
    https.get(url, { headers: { 'User-Agent': 'FaunaMCP', 'Accept': 'application/vnd.github+json' } }, res => {
      let body = '';
      res.on('data', chunk => { body += chunk; });
      res.on('end', () => {
        if (res.statusCode < 200 || res.statusCode >= 300) return reject(new Error(`HTTP ${res.statusCode}: ${body.slice(0, 200)}`));
        try { resolve(JSON.parse(body)); } catch (e) { reject(e); }
      });
    }).on('error', reject);
  });
}

function downloadFile(url, dest, redirects = 0) {
  return new Promise((resolve, reject) => {
    https.get(url, { headers: { 'User-Agent': 'FaunaMCP' } }, res => {
      if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location) {
        res.resume();
        if (redirects > 5) return reject(new Error('Too many redirects'));
        return resolve(downloadFile(new URL(res.headers.location, url).toString(), dest, redirects + 1));
      }
      if (res.statusCode < 200 || res.statusCode >= 300) {
        res.resume();
        return reject(new Error(`Download failed with HTTP ${res.statusCode}`));
      }
      const file = fs.createWriteStream(dest);
      res.pipe(file);
      file.on('finish', () => file.close(resolve));
      file.on('error', reject);
    }).on('error', reject);
  });
}

function runProcess(command, args, opts = {}) {
  return new Promise((resolve, reject) => {
    const proc = spawn(command, args, { ...opts, env: cliEnv(opts.env), stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    proc.stdout.on('data', chunk => {
      const text = chunk.toString();
      stdout += text;
      for (const line of text.split('\n').filter(Boolean)) updateLog(line.slice(0, 500));
    });
    proc.stderr.on('data', chunk => {
      const text = chunk.toString();
      stderr += text;
      for (const line of text.split('\n').filter(Boolean)) updateLog(line.slice(0, 500));
    });
    proc.on('error', reject);
    proc.on('close', code => code === 0 ? resolve({ stdout, stderr }) : reject(new Error(`${command} ${args.join(' ')} exited ${code}: ${(stderr || stdout).slice(-1000)}`)));
  });
}

function findFile(root, predicate) {
  if (!fs.existsSync(root)) return null;
  for (const name of fs.readdirSync(root)) {
    const fullPath = path.join(root, name);
    const stat = fs.statSync(fullPath);
    if (stat.isDirectory()) {
      const found = findFile(fullPath, predicate);
      if (found) return found;
    } else if (predicate(fullPath, name)) return fullPath;
  }
  return null;
}

async function checkForUpdates(showResult = true) {
  if (updateState.checking || updateState.running) return updateState;
  updateState.checking = true;
  updateState.error = null;
  updateState.currentSha = loadInstalledSha();
  updateLog('Checking main branch for updates...', 'checking');
  try {
    const data = await requestJson(BRANCH_API_URL);
    updateState.latestSha = data.sha || null;
    updateState.updateAvailable = !!updateState.latestSha && updateState.latestSha !== updateState.currentSha;
    updateState.phase = updateState.updateAvailable ? 'available' : 'current';
    updateState.message = updateState.updateAvailable
      ? `Update available: ${updateState.latestSha.slice(0, 7)}`
      : showResult ? 'FaunaMCP is up to date' : 'Idle';
  } catch (e) {
    updateState.error = e.message;
    updateState.phase = 'error';
    updateState.message = 'Update check failed: ' + e.message;
  } finally {
    updateState.checking = false;
    emitUpdateState();
  }
  return updateState;
}

async function installUpdate() {
  if (updateState.running) return updateState;
  updateState = { ...updateState, running: true, checking: false, phase: 'starting', message: 'Starting update', error: null, logs: [] };
  emitUpdateState();
  try {
    if (!updateState.latestSha) await checkForUpdates(false);
    const targetSha = updateState.latestSha;
    if (!targetSha) throw new Error('No main branch SHA available');

    fs.mkdirSync(updateRoot(), { recursive: true });
    updateLog('Downloading FaunaMCP main branch...', 'download');
    await downloadFile(SOURCE_ZIP_URL, updateZipPath());

    updateLog('Extracting source...', 'extract');
    fs.rmSync(updateSourceDir(), { recursive: true, force: true });
    const extracted = path.join(updateRoot(), 'faunaMCP-main');
    fs.rmSync(extracted, { recursive: true, force: true });
    if (process.platform === 'win32') {
      await runProcess('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', `Expand-Archive -LiteralPath ${JSON.stringify(updateZipPath())} -DestinationPath ${JSON.stringify(updateRoot())} -Force`]);
    } else {
      await runProcess('unzip', ['-q', '-o', updateZipPath(), '-d', updateRoot()]);
    }
    if (!fs.existsSync(extracted)) throw new Error('Downloaded zip did not contain faunaMCP-main');
    fs.renameSync(extracted, updateSourceDir());
    updateState.sourceDir = updateSourceDir();

    updateLog('Installing dependencies...', 'dependencies');
    await runProcess(npmCommand(), ['install'], { cwd: updateSourceDir(), env: { ...process.env } });

    const buildScript = process.platform === 'darwin' ? 'dist:mac' : process.platform === 'win32' ? 'dist:win' : 'dist';
    updateLog(`Building update with npm run ${buildScript}...`, 'build');
    await runProcess(npmCommand(), ['run', buildScript], { cwd: updateSourceDir(), env: { ...process.env } });

    updateLog('Installing update...', 'install');
    if (process.platform === 'darwin') {
      const builtApp = path.join(updateSourceDir(), 'dist', 'mac', 'FaunaMCP.app');
      if (!fs.existsSync(builtApp)) throw new Error('Build completed, but dist/mac/FaunaMCP.app was not found');
      const scriptPath = path.join(updateRoot(), 'install-mac.sh');
      fs.writeFileSync(scriptPath, `#!/bin/zsh\nsleep 1\nrm -rf ${JSON.stringify(MAC_APP_PATH)}\ncp -R ${JSON.stringify(builtApp)} ${JSON.stringify(MAC_APP_PATH)}\nopen ${JSON.stringify(MAC_APP_PATH)}\n`, { mode: 0o755 });
      saveInstalledSha(targetSha);
      updateLog('Relaunching into updated app...', 'relaunch');
      spawn('/bin/zsh', [scriptPath], { detached: true, stdio: 'ignore' }).unref();
      app.quit();
      return updateState;
    }

    if (process.platform === 'win32') {
      const installer = findFile(path.join(updateSourceDir(), 'dist'), (_fullPath, name) => /\.exe$/i.test(name) && /setup|faunamcp/i.test(name));
      if (!installer) throw new Error('Build completed, but no Windows installer .exe was found in dist');
      updateState.installerPath = installer;
      saveInstalledSha(targetSha);
      updateLog('Launching Windows installer...', 'relaunch');
      spawn(installer, ['/S'], { detached: true, stdio: 'ignore' }).unref();
      app.quit();
      return updateState;
    }

    saveInstalledSha(targetSha);
    updateLog(`Update built at ${updateSourceDir()}`, 'complete');
    updateState.running = false;
  } catch (e) {
    updateState.running = false;
    updateState.phase = 'error';
    updateState.error = e.message;
    updateState.message = 'Update failed: ' + e.message;
    emitUpdateState();
  }
  return updateState;
}

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
    : path.join(__dirname, 'assets', 'icon.png');
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
  r.enabled = true;   // user explicitly wants this running
  if (r.proc) return;

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
  r.portInUse = false;

  r.proc = spawn(NODE_BIN, [relayPath], {
    env: cliEnv(),
    stdio: ['pipe', 'ignore', 'pipe']
  });
  // Keep stdin open (prevent EOF on the relay's StdioServerTransport)
  r.proc.stdin.resume();

  r.spawnedAt = Date.now();

  r.proc.stderr.on('data', chunk => {
    const text = chunk.toString().trim();
    for (const line of text.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      if (/EADDRINUSE|already in use|port \d+ is already in use/i.test(trimmed)) r.portInUse = true;
      addLog(which, trimmed, /error|EADDRINUSE|already in use/i.test(trimmed) ? 'err' : 'ok');
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
    if (r.portInUse) {
      r.enabled = false;
      addLog(which, 'Port is already occupied — not retrying this relay automatically.', 'err');
      return;
    }
    // Only auto-retry if enabled (i.e. not manually stopped) and it died too fast
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
  r.enabled = false;  // user explicitly stopped — don't auto-restart
  if (!r.proc) return;
  addLog(which, `Stopping ${which} relay…`, 'info');
  r.proc.kill('SIGTERM');
}

// ── Popup window ──────────────────────────────────────────────────────────
function createPopup() {
  popup = new BrowserWindow({
    width: 360,
    height: 560,
    show: false,
    frame: false,
    resizable: false,
    alwaysOnTop: true,
    skipTaskbar: false,
    roundedCorners: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      webSecurity: false
    }
  });

  popup.loadFile(path.join(__dirname, 'popup.html'));
  popup.on('closed', () => { popup = null; });
}

function showPopup() {
  if (!tray) return;
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
    { label: updateState.updateAvailable ? 'Install Update...' : 'Check for Updates...', enabled: !updateState.running && !updateState.checking, click: () => updateState.updateAvailable ? installUpdate() : checkForUpdates(true) },
    { label: 'Open FaunaMCP Repository', click: () => shell.openExternal(REPO_URL) },
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
  version:    app.getVersion(),
  repoUrl:    REPO_URL,
  update:     updateState,
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
ipcMain.handle('check-update',      ()  => checkForUpdates(true));
ipcMain.handle('install-update',    ()  => installUpdate());
ipcMain.handle('open-repo',         ()  => shell.openExternal(REPO_URL));

// ── App lifecycle ─────────────────────────────────────────────────────────
app.whenReady().then(() => {
  tray = new Tray(getTrayIcon());
  updateTrayMenu();
  tray.on('click', showPopup);
  createPopup();
  startRelay('browser');
  startRelay('figma');
  showPopup();
  setTimeout(() => checkForUpdates(false), 2500);
});

app.on('activate', showPopup);

app.on('before-quit', () => { stopRelay('browser'); stopRelay('figma'); });
app.on('window-all-closed', e => e.preventDefault());
