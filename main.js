import { app, BrowserWindow, Menu, Tray, globalShortcut, ipcMain, shell, nativeImage, nativeTheme, Notification, dialog, screen, clipboard } from 'electron';
import path     from 'path';
import fs       from 'fs';
import os       from 'os';
import { fileURLToPath } from 'url';
import crypto   from 'crypto';
import { startServer }   from './server.js';
import { getResidentAudio } from './server/voice/resident-audio.js';
import { getUtterancePipeline } from './server/voice/utterance-pipeline.js';
import { getTts } from './server/voice/tts.js';
import { getVoiceChat } from './server/voice/voice-chat.js';
import { getDictation } from './server/voice/dictation.js';
import { getSettings, onSettingsChange, DEFAULT_DICTATION_ACCEL_MAC, DEFAULT_DICTATION_ACCEL_OTHER } from './server/voice/settings.js';
import { setDefaultScrubOpts } from './server/lib/redactor.js';
import { buildShellEnv } from './server/lib/shell-env.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT      = 3737;
const IS_WIN    = process.platform === 'win32';
const IS_MAC    = process.platform === 'darwin';
const FAUNAMCP_REPO_URL = 'https://github.com/howmon/faunaMCP';

nativeTheme.themeSource = 'dark';

// Enable Web Speech API (backed by SFSpeechRecognizer on macOS)
app.commandLine.appendSwitch('enable-features', 'WebSpeechAPI');
app.commandLine.appendSwitch('auto-select-desktop-capture-source', 'Entire screen');

// On Windows, hardware acceleration can prevent the renderer from starting
// (ICU data file-descriptor handoff to the GPU process fails).
if (IS_WIN) app.disableHardwareAcceleration();

let mainWindow;
const windows = new Set();
let widgetWindow = null;
let tray = null;
let audioWindow = null;     // hidden BrowserWindow that owns the mic
let residentAudio = null;   // ResidentAudio EventEmitter (Phase 1)
let utterancePipeline = null; // UtterancePipeline (Phase 2)
let tts = null;             // Tts engine (Phase 4)
let voiceChat = null;       // VoiceChat dispatcher (Phase 4b)
let dictation = null;       // Dictation orchestrator (Phase 5)
let dictationWindow = null; // hidden BrowserWindow for the dictation mic

// ── Window state persistence ─────────────────────────────────────
// Persists the set of open windows (active conversation, project, bounds)
// so relaunching Fauna restores the previous workspace.
const WINDOW_STATE_FILE = path.join(os.homedir(), '.config', 'fauna', 'window-state.json');

function _readWindowState() {
  try {
    const raw = JSON.parse(fs.readFileSync(WINDOW_STATE_FILE, 'utf8'));
    if (Array.isArray(raw)) return raw;
    if (raw && Array.isArray(raw.windows)) return raw.windows;
  } catch (_) {}
  return [];
}

function _writeWindowState(entries) {
  try {
    const dir = path.dirname(WINDOW_STATE_FILE);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(WINDOW_STATE_FILE, JSON.stringify({ windows: entries }, null, 2));
  } catch (e) {
    console.warn('[fauna] failed to write window state:', e.message);
  }
}

function _snapshotWindows() {
  const out = [];
  for (const win of windows) {
    if (!win || win.isDestroyed()) continue;
    let bounds = null;
    try { bounds = win.getNormalBounds ? win.getNormalBounds() : win.getBounds(); } catch (_) {}
    const st = win._faunaState || {};
    out.push({
      convId:    st.convId    || null,
      projectId: st.projectId || null,
      bounds,
    });
  }
  return out;
}

function persistWindowState() {
  _writeWindowState(_snapshotWindows());
}

// ── Window ────────────────────────────────────────────────────────────────

async function createWindow({ convId, projectId, bounds, blank } = {}) {
  const winOpts = {
    width:  1260,
    height:  840,
    minWidth:  740,
    minHeight: 520,
    // macOS: hiddenInset gives the traffic-light buttons; Windows: use 'hidden' for frameless
    titleBarStyle: IS_WIN ? 'hidden' : 'hiddenInset',
    ...(IS_WIN ? {} : { trafficLightPosition: { x: 16, y: 18 } }),
    backgroundColor:   '#0d0d1a',
    // vibrancy + visualEffectState are macOS-only
    ...(IS_WIN ? {} : { vibrancy: 'under-window', visualEffectState: 'active' }),
    icon: path.join(__dirname, 'assets', 'icon.png'),
    webPreferences: {
      contextIsolation: true,
      nodeIntegration:  false,
      webviewTag:       true,
      spellcheck:       true,
      preload:          path.join(__dirname, 'main-preload.js'),
    },
    show: false,
  };
  // Restore saved geometry if it's still on a visible display
  if (bounds && Number.isFinite(bounds.x) && Number.isFinite(bounds.y) &&
      Number.isFinite(bounds.width) && Number.isFinite(bounds.height)) {
    try {
      const display = screen.getDisplayMatching(bounds);
      if (display) {
        winOpts.x = bounds.x;
        winOpts.y = bounds.y;
        winOpts.width  = Math.max(bounds.width,  winOpts.minWidth);
        winOpts.height = Math.max(bounds.height, winOpts.minHeight);
      }
    } catch (_) {}
  }
  const win = new BrowserWindow(winOpts);

  windows.add(win);
  mainWindow = win;
  win._faunaState = { convId: convId || null, projectId: projectId || null };

  // Grant microphone permission for localhost (required for Web Speech API / voice control)
  win.webContents.session.setPermissionRequestHandler((webContents, permission, callback) => {
    const allowed = ['media', 'microphone', 'audioCapture', 'clipboard-read', 'clipboard-write', 'clipboard-sanitized-write'];
    callback(allowed.includes(permission));
  });

  const params = new URLSearchParams();
  if (convId)    params.set('conv',    convId);
  if (projectId) params.set('project', projectId);
  if (blank)     params.set('blank',   '1');
  const qs = params.toString();
  win.loadURL(`http://localhost:${PORT}${qs ? '?' + qs : ''}`);

  win.once('ready-to-show', () => {
    win.show();
    win.focus();
  });
  // Fallback: if ready-to-show is delayed (common on Windows), show after 4 s
  setTimeout(() => { if (!win.isDestroyed() && !win.isVisible()) win.show(); }, 4000);

  // Open external links in the default browser, not in Electron
  win.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });

  win.webContents.on('will-navigate', (e, url) => {
    if (!url.startsWith(`http://localhost:${PORT}`)) {
      e.preventDefault();
      shell.openExternal(url);
    }
  });

  // Track focus so menu actions target the most recently used window
  win.on('focus', () => { mainWindow = win; refreshTray(); });

  // Persist geometry whenever it changes (debounced)
  let _saveTimer = null;
  const _scheduleSave = () => {
    if (_saveTimer) clearTimeout(_saveTimer);
    _saveTimer = setTimeout(persistWindowState, 500);
  };
  win.on('move',   _scheduleSave);
  win.on('resize', _scheduleSave);

  // Clear the reference when the window is destroyed so stale calls don't throw
  win.on('closed', () => {
    windows.delete(win);
    if (mainWindow === win) {
      mainWindow = [...windows].pop() || null;
    }
    refreshTray();
    // Don't overwrite the file while the user is quitting (before-quit handles it)
    if (!app.isQuitting) persistWindowState();
  });

  // Rebuild the tray menu when the page title changes (conversation switch)
  win.webContents.on('page-title-updated', () => refreshTray());

  return win;
}

// ── Native menu ───────────────────────────────────────────────────────────

function js(code) {
  const target = BrowserWindow.getFocusedWindow() || mainWindow;
  target?.webContents?.executeJavaScript(code).catch(() => {});
}

function toggleDetachedDevTools() {
  const target = BrowserWindow.getFocusedWindow() || mainWindow;
  if (!target || target.isDestroyed()) return;
  const wc = target.webContents;
  if (wc.isDevToolsOpened()) wc.closeDevTools();
  else wc.openDevTools({ mode: 'detach' });
}

function buildMenu() {
  return Menu.buildFromTemplate([
    {
      label: 'Fauna',
      submenu: [
        { label: 'About Fauna', role: 'about' },
        { type: 'separator' },
        {
          label: 'Preferences…', accelerator: 'Cmd+,',
          click: () => js('if(!settingsOpen) toggleSettings()')
        },
        {
          label: 'Permissions & Setup…', accelerator: 'Cmd+Shift+O',
          click: () => js('openOnboarding()')
        },
        { type: 'separator' },
        { label: 'Hide Fauna', accelerator: 'Cmd+H', role: 'hide' },
        { label: 'Hide Others',       accelerator: 'Cmd+Alt+H', role: 'hideOthers' },
        { label: 'Show All',          role: 'unhide' },
        { type: 'separator' },
        { label: 'Quit Fauna', accelerator: 'Cmd+Q', role: 'quit' }
      ]
    },
    {
      label: 'File',
      submenu: [
        { label: 'New Conversation', accelerator: 'Cmd+N', click: () => js('newConversation()') },
        { label: 'New Window',       accelerator: 'Cmd+Shift+N', click: () => createWindow({ blank: true }) },
        { type: 'separator' },
        { label: 'Clear Conversation', accelerator: 'Cmd+K', click: () => js('clearConversation()') },
        { type: 'separator' },
        { label: 'Attach File…', accelerator: 'Cmd+O', click: () => js('openFileAttach()') },
        { label: 'Add URL Context…',  accelerator: 'Cmd+L', click: () => js('openUrlModal()') },
      ]
    },
    {
      label: 'Edit',
      submenu: [
        { label: 'Undo',       accelerator: 'Cmd+Z',         role: 'undo' },
        { label: 'Redo',       accelerator: 'Shift+Cmd+Z',   role: 'redo' },
        { type: 'separator' },
        { label: 'Cut',        accelerator: 'Cmd+X',         role: 'cut' },
        { label: 'Copy',       accelerator: 'Cmd+C',         role: 'copy' },
        { label: 'Paste',      accelerator: 'Cmd+V',         role: 'paste' },
        { label: 'Select All', accelerator: 'Cmd+A',         role: 'selectAll' },
        { type: 'separator' },
        { label: 'Find…',      accelerator: 'Cmd+F',         click: () => js('document.getElementById("msg-input").focus()') },
      ]
    },
    {
      label: 'View',
      submenu: [
        { label: 'Toggle Sidebar',      accelerator: 'Cmd+B',     click: () => js('toggleSidebar()') },
        { label: 'System Prompt',       accelerator: 'Cmd+Shift+P', click: () => js('toggleSysPanel()') },
        { label: 'Tasks',               accelerator: 'Cmd+Shift+T', click: () => js('toggleTasksPanel()') },
        { label: 'Task Widget',          accelerator: 'Ctrl+Shift+Space', click: () => toggleWidget() },
        { type: 'separator' },
        { label: 'Reload',              role: 'reload' },
        { label: 'Toggle DevTools',     accelerator: 'Alt+Cmd+I', click: () => toggleDetachedDevTools() },
        { type: 'separator' },
        { label: 'Actual Size',         role: 'resetZoom' },
        { label: 'Zoom In',             role: 'zoomIn' },
        { label: 'Zoom Out',            role: 'zoomOut' },
        { type: 'separator' },
        { label: 'Enter Full Screen',   role: 'togglefullscreen' },
      ]
    },
    {
      label: 'Window',
      role: 'window',
      submenu: [
        { role: 'minimize' },
        { role: 'zoom' },
        { type: 'separator' },
        { role: 'front' },
        { role: 'close' },
      ]
    },
    {
      label: 'Figma',
      submenu: [
        {
          label: 'Connect to Figma Bridge', accelerator: 'Cmd+Shift+F',
          click: () => js('figmaConnect()')
        },
        {
          label: 'Toggle Figma Panel',
          click: () => js('if(!figmaSectionOpen) toggleFigmaSection(); else toggleFigmaSection()')
        },
        { type: 'separator' },
        {
          label: 'Figma Rules…',
          click: () => js('if(!figmaRulesOpen) toggleFigmaRules()')
        },
        {
          label: 'Figma Plugin Setup & Help…',
          click: () => js('if(!figmaSetupOpen) toggleFigmaSetup()')
        },
        { type: 'separator' },
        {
          label: 'Open FaunaMCP Plugin in Figma',
          click: () => shell.openExternal('figma://plugin/start?plugin_id=com.fauna.mcp')
        },
      ]
    },
    {
      label: 'Help',
      role: 'help',
      submenu: [
        { label: 'Documentation', click: () => shell.openExternal('https://github.com/howmon/fauna') },
        { label: 'Check for Fauna Updates', click: () => js("switchSettingsPage('about', document.querySelector('.settings-nav-item[data-page=about]')); if(!settingsOpen) toggleSettings(); _checkFaunaUpdate();") },
        { label: 'Get FaunaMCP Standalone', click: () => shell.openExternal(FAUNAMCP_REPO_URL) },
        { label: 'Report Issue', click: () => shell.openExternal('https://github.com/howmon/fauna/issues') },
      ]
    }
  ]);
}

// ── Task Widget — Floating BrowserWindow ──────────────────────────────

const WIDGET_PREFS_FILE = path.join(os.homedir(), '.config', 'fauna', 'widget-prefs.json');

function readWidgetPrefs() {
  try { return JSON.parse(fs.readFileSync(WIDGET_PREFS_FILE, 'utf8')); }
  catch (_) { return {}; }
}
function writeWidgetPrefs(prefs) {
  const dir = path.dirname(WIDGET_PREFS_FILE);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(WIDGET_PREFS_FILE, JSON.stringify(prefs, null, 2));
}

function createWidget() {
  if (widgetWindow && !widgetWindow.isDestroyed()) {
    widgetWindow.show();
    widgetWindow.focus();
    return;
  }

  const prefs = readWidgetPrefs();
  const x = prefs.x ?? undefined;
  const y = prefs.y ?? undefined;
  const w = prefs.width  ?? 380;
  const h = prefs.height ?? 560;
  const pinned = prefs.pinned ?? true;

  widgetWindow = new BrowserWindow({
    width: w,
    height: h,
    ...(x !== undefined && y !== undefined ? { x, y } : {}),
    minWidth: 240,
    minHeight: 200,
    maxWidth: 600,
    frame: false,
    transparent: IS_MAC,
    alwaysOnTop: pinned,
    skipTaskbar: true,
    resizable: true,
    hasShadow: true,
    backgroundColor: '#1b1b1b',
    titleBarStyle: 'customButtonsOnHover',
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      preload: path.join(__dirname, 'widget-preload.js'),
    },
    show: false,
  });

  widgetWindow.loadURL(`http://localhost:${PORT}/widget.html`);

  widgetWindow.once('ready-to-show', () => {
    widgetWindow.show();
  });

  // Persist position/size on move/resize
  const savePos = () => {
    if (!widgetWindow || widgetWindow.isDestroyed()) return;
    const bounds = widgetWindow.getBounds();
    const old = readWidgetPrefs();
    writeWidgetPrefs({ ...old, x: bounds.x, y: bounds.y, width: bounds.width, height: bounds.height });
  };
  widgetWindow.on('moved', savePos);
  widgetWindow.on('resized', savePos);

  // Hide instead of close (so it can be toggled quickly)
  widgetWindow.on('close', (e) => {
    if (!app.isQuitting) {
      e.preventDefault();
      widgetWindow.hide();
    }
  });

  widgetWindow.on('closed', () => { widgetWindow = null; });

  // Send initial pin state
  widgetWindow.webContents.once('did-finish-load', () => {
    widgetWindow?.webContents.send('widget:pin-changed', pinned);
  });
}

function toggleWidget() {
  if (widgetWindow && !widgetWindow.isDestroyed() && widgetWindow.isVisible()) {
    widgetWindow.hide();
  } else {
    createWidget();
  }
}

// Widget IPC handlers
ipcMain.on('widget:toggle-pin', () => {
  if (!widgetWindow || widgetWindow.isDestroyed()) return;
  const current = widgetWindow.isAlwaysOnTop();
  const next = !current;
  widgetWindow.setAlwaysOnTop(next);
  widgetWindow.webContents.send('widget:pin-changed', next);
  const prefs = readWidgetPrefs();
  writeWidgetPrefs({ ...prefs, pinned: next });
});

ipcMain.on('widget:hide', () => {
  widgetWindow?.hide();
});

ipcMain.on('widget:open-in-app', () => {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.show();
    mainWindow.focus();
    // Open the Automations panel inside the main app
    mainWindow.webContents.executeJavaScript(
      'typeof toggleTasksPanel === "function" && !tasksPanelOpen && toggleTasksPanel()'
    ).catch(() => {});
  }
});

// ── Widget: Ask Fauna (Clippy-style quick prompt) ────────────────────
// Companion mode runs ENTIRELY in the widget — it streams /api/chat
// directly from the widget renderer (same localhost origin) so the
// main app window stays out of the user's way. This IPC is kept only
// as an opt-in escape hatch: pass openMain:true to surface the main
// window (e.g. for long answers the user wants to inspect later).
ipcMain.on('widget:ask', (_e, payload) => {
  if (!payload?.openMain) return;
  const text = (payload?.text || '').toString().trim();
  if (!text) return;
  const withContext = payload?.withContext !== false;
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.show();
    mainWindow.focus();
    const safe = JSON.stringify({ text, withContext });
    mainWindow.webContents.executeJavaScript(
      `window.dispatchEvent(new CustomEvent('fauna:ask-prompt', { detail: ${safe} }))`
    ).catch(() => {});
  }
});

// ── Click-preview HUD ───────────────────────────────────────────────
// A frameless, transparent, click-through overlay window that briefly
// flashes a target ring at (x,y) in screen coords before fauna_mouse
// click / double_click / right_click / drag fires. Gives the user a
// visible "Fauna is about to click here" cue — Clippy-style safety.
let clickHudWindow = null;
function _ensureClickHud() {
  if (clickHudWindow && !clickHudWindow.isDestroyed()) return clickHudWindow;
  const primary = screen.getPrimaryDisplay();
  const { x, y, width, height } = primary.bounds;
  clickHudWindow = new BrowserWindow({
    x, y, width, height,
    frame: false,
    transparent: true,
    alwaysOnTop: true,
    skipTaskbar: true,
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    focusable: false,
    hasShadow: false,
    backgroundColor: '#00000000',
    show: false,
    webPreferences: { contextIsolation: true, nodeIntegration: false },
  });
  clickHudWindow.setIgnoreMouseEvents(true, { forward: false });
  if (typeof clickHudWindow.setVisibleOnAllWorkspaces === 'function') {
    clickHudWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  }
  if (typeof clickHudWindow.setAlwaysOnTop === 'function') {
    clickHudWindow.setAlwaysOnTop(true, 'screen-saver');
  }
  // Tiny inline HTML — no external network.
  const html = `<!doctype html><html><head><meta charset="utf-8"><style>
    html,body{margin:0;padding:0;width:100%;height:100%;background:transparent;overflow:hidden;pointer-events:none;}
    .ring{position:absolute;border-radius:50%;pointer-events:none;
      box-shadow:0 0 0 3px rgba(0,200,255,.9),0 0 20px rgba(0,200,255,.6),inset 0 0 0 2px rgba(255,255,255,.9);
      animation:pop .28s ease-out forwards;}
    .ring.right{box-shadow:0 0 0 3px rgba(255,120,80,.9),0 0 20px rgba(255,120,80,.6),inset 0 0 0 2px rgba(255,255,255,.9);}
    .ring.drag{box-shadow:0 0 0 3px rgba(160,255,120,.9),0 0 20px rgba(160,255,120,.6),inset 0 0 0 2px rgba(255,255,255,.9);}
    @keyframes pop{0%{transform:scale(.4);opacity:.2}40%{transform:scale(1.2);opacity:1}100%{transform:scale(1);opacity:0}}
    .line{position:absolute;height:3px;background:linear-gradient(90deg,rgba(160,255,120,.9),rgba(0,200,255,.9));pointer-events:none;
      box-shadow:0 0 8px rgba(160,255,120,.7);transform-origin:0 50%;animation:fade .35s ease-out forwards;}
    @keyframes fade{0%{opacity:0}30%{opacity:1}100%{opacity:0}}
  </style></head><body>
  <script>
    const SIZE = 44;
    window.faunaShowClick = function(x, y, kind){
      const r = document.createElement('div');
      r.className = 'ring' + (kind ? ' ' + kind : '');
      r.style.left = (x - SIZE/2) + 'px';
      r.style.top  = (y - SIZE/2) + 'px';
      r.style.width = SIZE + 'px';
      r.style.height = SIZE + 'px';
      document.body.appendChild(r);
      setTimeout(() => r.remove(), 400);
    };
    window.faunaShowDrag = function(x1, y1, x2, y2){
      window.faunaShowClick(x1, y1, 'drag');
      window.faunaShowClick(x2, y2, 'drag');
      const dx = x2 - x1, dy = y2 - y1;
      const len = Math.sqrt(dx*dx + dy*dy);
      const ang = Math.atan2(dy, dx) * 180 / Math.PI;
      const l = document.createElement('div');
      l.className = 'line';
      l.style.left = x1 + 'px';
      l.style.top  = (y1 - 1) + 'px';
      l.style.width = len + 'px';
      l.style.transform = 'rotate(' + ang + 'deg)';
      document.body.appendChild(l);
      setTimeout(() => l.remove(), 450);
    };
  </script>
  </body></html>`;
  clickHudWindow.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html));
  clickHudWindow.on('closed', () => { clickHudWindow = null; });
  return clickHudWindow;
}

ipcMain.on('fauna:click-preview', (_e, payload) => {
  showClickPreview(payload);
});

// Direct in-process hook so self-tools.js (loaded in this same main process)
// can flash the HUD without going through IPC. Returns a Promise that
// resolves after the visual delay (~280ms) so callers can `await` before
// issuing the actual click.
function showClickPreview(payload) {
  try {
    const w = _ensureClickHud();
    const kind = String(payload?.kind || 'click');
    const displays = screen.getAllDisplays();
    const minX = Math.min(...displays.map(d => d.bounds.x));
    const minY = Math.min(...displays.map(d => d.bounds.y));
    const maxX = Math.max(...displays.map(d => d.bounds.x + d.bounds.width));
    const maxY = Math.max(...displays.map(d => d.bounds.y + d.bounds.height));
    w.setBounds({ x: minX, y: minY, width: maxX - minX, height: maxY - minY });
    if (!w.isVisible()) w.showInactive();
    const x = Number(payload?.x) - minX;
    const y = Number(payload?.y) - minY;
    if (kind === 'drag') {
      const tx = Number(payload?.toX) - minX;
      const ty = Number(payload?.toY) - minY;
      w.webContents.executeJavaScript(`faunaShowDrag(${x},${y},${tx},${ty})`).catch(() => {});
    } else {
      w.webContents.executeJavaScript(`faunaShowClick(${x},${y},${JSON.stringify(kind)})`).catch(() => {});
    }
  } catch (e) {
    console.warn('[click-preview] failed:', e.message);
  }
}
global.__faunaShowClickPreview = showClickPreview;

// ── Show native notification (from server / self-tools) ──────────────
ipcMain.on('show-notification', (event, { title, body }) => {
  new Notification({ title: title || 'Fauna', body: body || '' }).show();
});

// ── Permission dialog (show native dialog for dangerous commands) ─────
ipcMain.handle('show-permission-dialog', async (event, { command, explanation }) => {
  const result = dialog.showMessageBoxSync(mainWindow, {
    type: 'warning',
    title: 'Permission Request',
    message: `The AI wants to run a command:`,
    detail: `${command}\n\n${explanation || ''}`,
    buttons: ['Deny', 'Allow Once', 'Always Allow'],
    defaultId: 0,
    cancelId: 0,
  });
  // 0 = Deny, 1 = Allow Once, 2 = Always Allow
  return ['deny', 'allow', 'auto-allow'][result] || 'deny';
});

// ── Region capture (overlay window for screen area selection) ─────────
ipcMain.handle('capture-region', async () => {
  const primaryDisplay = screen.getPrimaryDisplay();
  const { width, height } = primaryDisplay.size;
  const scaleFactor = primaryDisplay.scaleFactor;

  // Hide main window briefly
  const wasVisible = mainWindow?.isVisible();
  if (wasVisible) mainWindow.hide();

  // Wait a moment for window to hide
  await new Promise(r => setTimeout(r, 200));

  // Take a full screenshot using desktopCapturer
  const { desktopCapturer: dc } = await import('electron');
  const sources = await dc.getSources({ types: ['screen'], thumbnailSize: { width: width * scaleFactor, height: height * scaleFactor } });
  const primarySource = sources[0];
  if (!primarySource) {
    if (wasVisible) mainWindow.show();
    return { ok: false, error: 'No screen source found' };
  }

  const fullScreenshot = primarySource.thumbnail;

  // Create overlay window for region selection.
  // NOTE: do NOT use `fullscreen: true` on macOS — it triggers the native
  // Spaces fullscreen zoom animation. `simpleFullscreen` is borderless and
  // appears instantly without animation.
  const overlay = new BrowserWindow({
    x: 0, y: 0, width, height,
    frame: false,
    transparent: true,
    alwaysOnTop: true,
    simpleFullscreen: true,
    skipTaskbar: true,
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    hasShadow: false,
    enableLargerThanScreen: true,
    webPreferences: { nodeIntegration: true, contextIsolation: false },
  });
  overlay.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });

  const overlayPath = path.join(__dirname, 'public', 'capture-overlay.html');
  await overlay.loadFile(overlayPath);
  overlay.webContents.send('set-screenshot', fullScreenshot.toDataURL());

  return new Promise((resolve) => {
    ipcMain.once('capture-region-result', (event, rect) => {
      overlay.close();
      if (wasVisible) mainWindow.show();

      if (!rect) {
        resolve({ ok: false, cancelled: true });
        return;
      }

      // Crop the screenshot
      const cropRect = {
        x: Math.round(rect.x * scaleFactor),
        y: Math.round(rect.y * scaleFactor),
        width: Math.round(rect.width * scaleFactor),
        height: Math.round(rect.height * scaleFactor),
      };
      const cropped = fullScreenshot.crop(cropRect);
      resolve({ ok: true, image: cropped.toDataURL(), width: rect.width, height: rect.height });
    });

    // Cancel on Escape
    overlay.webContents.on('before-input-event', (event, input) => {
      if (input.key === 'Escape') {
        ipcMain.emit('capture-region-result', null, null);
      }
    });
  });
});

// ── Tray ──────────────────────────────────────────────────────────────────

function _windowLabel(win) {
  let title = '';
  try { title = win.webContents?.getTitle() || ''; } catch (_) {}
  // Strip the leading "Fauna — " so the menu stays compact
  title = title.replace(/^Fauna\s*[—-]\s*/, '').trim();
  if (!title || /^Fauna$/i.test(title)) title = 'Untitled';
  if (title.length > 48) title = title.slice(0, 45) + '…';
  return title;
}

function _buildTrayMenu() {
  const wins = [...windows].filter(w => w && !w.isDestroyed());
  const windowItems = wins.length
    ? wins.map((w, i) => ({
        label: (i + 1) + '. ' + _windowLabel(w),
        type: 'checkbox',
        checked: w === BrowserWindow.getFocusedWindow(),
        click: () => { if (w.isMinimized()) w.restore(); w.show(); w.focus(); },
      }))
    : [{ label: 'No windows open', enabled: false }];

  const voiceEnabled = !!residentAudio?.isEnabled();
  const ttsSpeaking  = !!tts?.isSpeaking();
  return Menu.buildFromTemplate([
    { label: 'Windows', enabled: false },
    ...windowItems,
    { type: 'separator' },
    { label: 'New Window', accelerator: IS_MAC ? 'Cmd+Shift+N' : 'Ctrl+Shift+N', click: () => createWindow({ blank: true }) },
    { label: 'Toggle Task Widget', click: () => toggleWidget() },
    { type: 'separator' },
    { label: 'Listen in background', type: 'checkbox', checked: voiceEnabled, click: () => toggleResidentVoice() },
    { label: 'Dictate (' + ((getSettings().dictationAccel || '').trim() || (IS_MAC ? 'Cmd+Opt+D' : 'Ctrl+Alt+D')) + ')',
      enabled: !dictation?.isActive(),
      click: () => { try { dictation?.start(); } catch (_) {} } },
    { label: 'Stop speaking', enabled: ttsSpeaking, click: () => { try { tts?.stop(); } catch (_) {} } },
    { type: 'separator' },
    { label: 'Voice settings…', click: () => openVoiceSettingsWindow() },
    { type: 'separator' },
    { label: 'Quit Fauna', click: () => { app.isQuitting = true; app.quit(); } },
  ]);
}

function refreshTray() {
  if (!tray || tray.isDestroyed?.()) return;
  tray.setContextMenu(_buildTrayMenu());
}

// ── Voice settings window (Phase 7) ──────────────────────────────────────
let voiceSettingsWindow = null;
function openVoiceSettingsWindow() {
  if (voiceSettingsWindow && !voiceSettingsWindow.isDestroyed()) {
    voiceSettingsWindow.show();
    voiceSettingsWindow.focus();
    return voiceSettingsWindow;
  }
  const win = new BrowserWindow({
    width: 760,
    height: 760,
    title: 'Fauna — Voice settings',
    backgroundColor: '#0d1117',
    autoHideMenuBar: true,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration:  false,
      sandbox:          true,
    },
  });
  win.loadURL(`http://127.0.0.1:${PORT}/voice-settings.html`);
  win.on('closed', () => { if (voiceSettingsWindow === win) voiceSettingsWindow = null; });
  voiceSettingsWindow = win;
  return win;
}

// ── Hidden audio-capture window (resident voice, Phase 1) ────────────────
function createAudioWindow() {
  if (audioWindow && !audioWindow.isDestroyed()) return audioWindow;
  const win = new BrowserWindow({
    width: 320,
    height: 60,
    show: false,            // never visible to the user
    skipTaskbar: true,
    focusable: false,
    frame: false,
    resizable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration:  false,
      sandbox:          false,
      backgroundThrottling: false,   // critical: keep mic running when no UI focused
      preload:          path.join(__dirname, 'audio-preload.js'),
    },
  });
  // Grant mic permission for this window's session
  win.webContents.session.setPermissionRequestHandler((_wc, permission, callback) => {
    callback(['media', 'microphone', 'audioCapture'].includes(permission));
  });
  win.loadFile(path.join(__dirname, 'public', 'audio-capture.html'));
  win.on('closed', () => { if (audioWindow === win) audioWindow = null; });
  audioWindow = win;
  return win;
}

function _initResidentAudio() {
  if (residentAudio) return residentAudio;
  residentAudio = getResidentAudio({ appDir: __dirname });
  residentAudio.attachWindowFactory(() => createAudioWindow());

  // Forward IPC from the hidden audio window into the broker. The same
  // `ipcMain.on` handler receives messages from both `ipcRenderer.send` and
  // `ipcRenderer.postMessage` — only postMessage can transfer ArrayBuffers
  // without a copy, which is why audio-preload uses postMessage for frames.
  const channels = ['voice:ready', 'voice:frame', 'voice:speech-start', 'voice:speech-end', 'voice:error'];
  for (const ch of channels) {
    ipcMain.on(ch, (_event, payload) => residentAudio.handleIpc(ch, payload));
  }

  // Surface state changes to the tray menu.
  residentAudio.on('state', () => refreshTray());

  // Phase-2: build the utterance pipeline (Whisper transcribe + wake word).
  // It subscribes to `speech-end` on residentAudio internally.
  // Phase-3: provide live context (TTS state) so the intent judge can
  // classify interrupts and follow-ups correctly.
  const { augmentedPath } = buildShellEnv(IS_WIN);
  const _vs0 = getSettings();
  utterancePipeline = getUtterancePipeline({
    residentAudio,
    appDir: __dirname,
    augmentedPath,
    wakeWords:        _vs0.wakeWords,
    wakeRequired:     _vs0.wakeRequired,
    followUpWindowMs: _vs0.followUpWindowMs,
    getContext: () => ({ ttsSpeaking: !!tts?.isSpeaking() }),
  });
  utterancePipeline.on('utterance:transcribed', ({ text, intent, command, durationMs }) => {
    console.log('[voice] transcribed', `(${durationMs}ms)`, JSON.stringify(text), '→', intent, intent !== 'ignore' && command ? `cmd=${JSON.stringify(command)}` : '');
  });
  utterancePipeline.on('error', (e) => console.warn('[voice] pipeline error:', e.message));

  // Phase-4: TTS engine. The onStateChange callback auto-mutes the resident
  // mic while Fauna is speaking so it can't transcribe its own voice.
  tts = getTts({
    onStateChange: (speaking) => {
      try { residentAudio?.setMuted(!!speaking); } catch (_) {}
      refreshTray();
    },
  });
  try {
    tts.setDefaults({ voice: _vs0.ttsVoice, rate: _vs0.ttsRate, enabled: _vs0.ttsEnabled });
  } catch (_) {}
  try {
    setDefaultScrubOpts({
      email:      !!_vs0.redactEmail,
      phone:      !!_vs0.redactPhone,
      creditCard: !!_vs0.redactCreditCard,
    });
  } catch (_) {}

  // Phase-4b: voice-chat dispatcher — bridges addressed utterances into
  // the real /api/chat SSE endpoint, streams the reply sentence-by-sentence
  // into TTS so playback starts as soon as the first sentence is ready.
  voiceChat = getVoiceChat({ port: PORT, tts });
  voiceChat.on('first-token', () => console.log('[voice] first-token'));
  voiceChat.on('done',        ({ reply }) => console.log('[voice] reply done:', (reply || '').slice(0, 120)));
  voiceChat.on('aborted',     ()         => console.log('[voice] reply aborted'));
  voiceChat.on('error',       ({ error }) => console.warn('[voice] reply error:', error));

  // Phase-4 placeholder dispatch: until the chat router is wired in, just
  // confirm we heard the user. Replace this handler with the agent call
  // when Phase 4b lands.
  utterancePipeline.on('utterance:addressed', ({ command, followUp }) => {
    if (!command) {
      // Bare wake word with no command: short acknowledgement so the user
      // knows Fauna is listening.
      tts.speak('Yes?').catch(() => {});
      return;
    }
    console.log('[voice] dispatch', followUp ? '(follow-up)' : '(addressed)', JSON.stringify(command));
    voiceChat.ask(command).catch((e) => console.warn('[voice] ask failed:', e.message));
  });

  // Phase-3: an interrupt utterance ('stop', 'wait', 'cancel'...) while
  // Fauna is speaking immediately kills TTS playback and aborts any
  // in-flight upstream chat request. The TTS state change unmutes the mic,
  // so the user can keep talking right after.
  utterancePipeline.on('utterance:interrupt', () => {
    console.log('[voice] interrupt');
    try { voiceChat?.cancel(); } catch (_) {}
    try { tts?.stop(); } catch (_) {}
  });

  // Phase-1 visibility: log raw VAD events too (helpful while tuning).
  residentAudio.on('speech-start', ({ ts }) => console.log('[voice] speech-start', new Date(ts).toISOString()));
  residentAudio.on('speech-end',   ({ ts, durationMs }) => console.log('[voice] speech-end', new Date(ts).toISOString(), durationMs + 'ms'));

  // Auto-start if user previously enabled it.
  if (residentAudio.isEnabled()) residentAudio.setEnabled(true);
  return residentAudio;
}

// ── Hidden dictation-capture window (Phase 5) ────────────────────────────
function createDictationWindow() {
  // Always fresh — the dictation orchestrator closes it after each pass.
  if (dictationWindow && !dictationWindow.isDestroyed()) return dictationWindow;
  const win = new BrowserWindow({
    width: 320,
    height: 60,
    show: false,
    skipTaskbar: true,
    focusable: false,
    frame: false,
    resizable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration:  false,
      sandbox:          false,
      backgroundThrottling: false,
      preload:          path.join(__dirname, 'dictation-preload.js'),
    },
  });
  win.webContents.session.setPermissionRequestHandler((_wc, permission, callback) => {
    callback(['media', 'microphone', 'audioCapture'].includes(permission));
  });
  win.loadFile(path.join(__dirname, 'public', 'dictation-capture.html'));
  win.on('closed', () => { if (dictationWindow === win) dictationWindow = null; });
  dictationWindow = win;
  return win;
}

function _initDictation() {
  if (dictation) return dictation;
  const { augmentedPath } = buildShellEnv(IS_WIN);
  dictation = getDictation({ appDir: __dirname, augmentedPath, residentAudio });
  dictation.attachWindowFactory(() => createDictationWindow());

  // Renderer → main IPC fan-in. Result channel uses postMessage to transfer
  // the PCM ArrayBuffer; the same `ipcMain.on` handler receives both kinds.
  const channels = ['dictation:ready', 'dictation:level', 'dictation:result', 'dictation:error'];
  for (const ch of channels) {
    ipcMain.on(ch, (_event, payload) => dictation.handleIpc(ch, payload));
  }

  dictation.on('state', ({ state }) => {
    console.log('[dictation] state =', state);
    refreshTray();
  });
  dictation.on('error', (e) => {
    console.warn('[dictation] error:', e.message);
    try { new Notification({ title: 'Dictation error', body: e.message }).show(); } catch (_) {}
  });
  dictation.on('transcribed', ({ text, empty, durationMs, elapsedMs }) => {
    console.log('[dictation] transcribed', `(${durationMs}ms rec / ${elapsedMs}ms whisper)`, JSON.stringify(text));
    if (empty || !text) {
      try { new Notification({ title: 'Dictation', body: 'Nothing transcribed.' }).show(); } catch (_) {}
      return;
    }
    try { clipboard.writeText(text); } catch (_) {}
    try {
      const preview = text.length > 90 ? text.slice(0, 87) + '…' : text;
      new Notification({ title: 'Dictation — copied to clipboard', body: preview }).show();
    } catch (_) {}
  });
  return dictation;
}

function toggleResidentVoice() {
  if (!residentAudio) _initResidentAudio();
  residentAudio.setEnabled(!residentAudio.isEnabled());
}

function createTray() {
  // Use a small template image for the tray (16x16)
  const iconPath = path.join(__dirname, 'assets', 'icon.png');
  let img = nativeImage.createFromPath(iconPath);
  img = img.resize({ width: 16, height: 16 });
  if (IS_MAC) img.setTemplateImage(true);

  tray = new Tray(img);
  tray.setToolTip('Fauna');
  refreshTray();

  // Click tray icon to toggle widget
  tray.on('click', () => toggleWidget());
}

// ── App lifecycle ─────────────────────────────────────────────────────────

// Default Fauna documents folder — a single, predictable place on disk for
// non-project files Fauna generates for the user (markdown reports, exports,
// scratch HTML, downloads, etc.). Created once on first launch. Exposed via
// /api/system-context so the chat prompt knows the canonical path.
function ensureFaunaDocsFolder() {
  try {
    const docs = app.getPath('documents') || path.join(os.homedir(), 'Documents');
    const fauna = path.join(docs, 'Fauna');
    if (!fs.existsSync(fauna)) {
      fs.mkdirSync(fauna, { recursive: true });
      // First-run README so the folder is obviously discoverable.
      const readme = path.join(fauna, 'README.md');
      if (!fs.existsSync(readme)) {
        fs.writeFileSync(readme,
          '# Fauna\n\n' +
          'This folder is the default save location for files Fauna generates ' +
          'outside of any specific project \u2014 reports, markdown notes, exports, ' +
          'scratch HTML, screenshots, etc.\n\n' +
          'You can rename or move files here freely. Fauna will keep writing new ' +
          'untitled files into this folder unless you set a project root.\n',
          'utf8'
        );
      }
    }
    return fauna;
  } catch (e) {
    console.warn('[fauna] could not create Documents/Fauna folder:', e.message);
    return null;
  }
}

app.whenReady().then(async () => {
  Menu.setApplicationMenu(buildMenu());

  // Ensure ~/Documents/Fauna exists and stash the path for the server route.
  const faunaDocs = ensureFaunaDocsFolder();
  if (faunaDocs) process.env.FAUNA_DOCS = faunaDocs;

  // Mint a per-process nonce that gates privileged UI-only routes (e.g.
  // /api/agent-builder/*). Exposed to renderers via main-preload.js so
  // only the in-app UI can read it — not the LAN, not the localtunnel,
  // not the resident voice path, not any other localhost browser tab.
  process.env.FAUNA_UI_NONCE = crypto.randomBytes(32).toString('hex');

  await startServer(PORT).catch(err => {
    console.error('[Electron] Server failed to start:', err.message);
    app.quit();
    throw err;
  });

  // Restore previously open windows; fall back to a single new window.
  const saved = _readWindowState();
  if (saved.length) {
    for (const entry of saved) {
      await createWindow({
        convId:    entry.convId    || null,
        projectId: entry.projectId || null,
        bounds:    entry.bounds    || null,
      });
    }
  } else {
    await createWindow();
  }

  // Create tray icon and task widget
  createTray();

  // Initialise resident voice broker (auto-starts mic if user enabled it previously)
  _initResidentAudio();

  // Initialise dictation orchestrator (idle until shortcut fires)
  _initDictation();

  // Global shortcut: Ctrl+Shift+T (Cmd+Shift+T is used by the menu for the in-app panel)
  globalShortcut.register('Ctrl+Shift+Space', () => toggleWidget());

  // Companion "Ask Fauna" hotkey — opens the widget and focuses the ask input.
  globalShortcut.register('CommandOrControl+Shift+J', () => {
    createWidget();
    setTimeout(() => {
      try {
        widgetWindow?.show();
        widgetWindow?.focus();
        widgetWindow?.webContents.send('widget:focus-ask');
      } catch (_) {}
    }, 50);
  });

  // Phase-5/7: dictation hotkey, sourced from voice-settings (live editable
  // via the settings UI). Falls back to platform default if user cleared it.
  let _dictateAccel = (getSettings().dictationAccel || '').trim() ||
    (IS_MAC ? DEFAULT_DICTATION_ACCEL_MAC : DEFAULT_DICTATION_ACCEL_OTHER);
  function _registerDictateAccel(accel) {
    if (!accel) return false;
    return globalShortcut.register(accel, () => {
      try { dictation?.toggle(); } catch (e) { console.warn('[dictation] toggle failed:', e.message); }
    });
  }
  if (!_registerDictateAccel(_dictateAccel)) {
    console.warn('[dictation] failed to register hotkey:', _dictateAccel);
  }

  // Phase-7: hot-apply voice settings changes (TTS voice/rate/enabled,
  // wake config, dictation accel, redaction defaults).
  onSettingsChange((s) => {
    try { utterancePipeline?.setWakeWords(s.wakeWords); } catch (_) {}
    try { utterancePipeline?.setWakeRequired(s.wakeRequired); } catch (_) {}
    try { utterancePipeline?.setFollowUpWindowMs(s.followUpWindowMs); } catch (_) {}
    try { tts?.setDefaults({ voice: s.ttsVoice, rate: s.ttsRate, enabled: s.ttsEnabled }); } catch (_) {}
    try {
      setDefaultScrubOpts({
        email:      !!s.redactEmail,
        phone:      !!s.redactPhone,
        creditCard: !!s.redactCreditCard,
      });
    } catch (_) {}
    const desired = (s.dictationAccel || '').trim() ||
      (IS_MAC ? DEFAULT_DICTATION_ACCEL_MAC : DEFAULT_DICTATION_ACCEL_OTHER);
    if (desired !== _dictateAccel) {
      try { globalShortcut.unregister(_dictateAccel); } catch (_) {}
      if (_registerDictateAccel(desired)) {
        _dictateAccel = desired;
        console.log('[dictation] hotkey changed to', desired);
      } else {
        console.warn('[dictation] failed to register new hotkey:', desired);
      }
    }
    refreshTray();
  });

  // macOS: re-open window when dock icon is clicked
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
    else mainWindow?.show();
  });
});

app.on('window-all-closed', () => {
  // On macOS, keep the process alive (standard behaviour)
  if (process.platform !== 'darwin') app.quit();
});

// Force a clean exit when the user quits so lingering timers (e.g. Figma
// reconnect loop) cannot keep the process alive and cause a phantom restart.
app.on('before-quit', () => {
  app.isQuitting = true;
  // Snapshot which windows were open + their conv/project so we restore them next launch
  try { persistWindowState(); } catch (_) {}
  try { voiceChat?.cancel(); } catch (_) {}
  try { tts?.shutdown(); } catch (_) {}
  try { dictation?.shutdown(); } catch (_) {}
  try { utterancePipeline?.shutdown(); } catch (_) {}
  try { residentAudio?.shutdown(); } catch (_) {}
  if (app.isReady()) globalShortcut.unregisterAll();
  // Give Electron ~300 ms to close windows, then hard-exit the Node process.
  setTimeout(() => process.exit(0), 300);
});

// Prevent multiple instances
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    } else {
      createWindow();
    }
  });
}

// Renderer-driven request to open another window (multi-window support).
ipcMain.on('fauna:open-window', (_event, payload) => {
  const { convId, projectId, blank } = payload || {};
  createWindow({ convId, projectId, blank });
});

// Renderer reports the active conversation / project for its window so we can
// restore the same workspace next launch.
ipcMain.on('fauna:report-window-state', (event, payload) => {
  const win = BrowserWindow.fromWebContents(event.sender);
  if (!win) return;
  const { convId, projectId } = payload || {};
  win._faunaState = {
    convId:    typeof convId    === 'string' ? convId    : null,
    projectId: typeof projectId === 'string' ? projectId : null,
  };
  persistWindowState();
});
