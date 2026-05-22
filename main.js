import { app, BrowserWindow, Menu, Tray, globalShortcut, ipcMain, shell, nativeImage, nativeTheme, Notification, dialog, screen } from 'electron';
import path     from 'path';
import fs       from 'fs';
import os       from 'os';
import { fileURLToPath } from 'url';
import { startServer }   from './server.js';

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

async function createWindow({ convId, projectId, bounds } = {}) {
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
        { label: 'New Window',       accelerator: 'Cmd+Shift+N', click: () => createWindow() },
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

  // Create overlay window for region selection
  const overlay = new BrowserWindow({
    x: 0, y: 0, width, height,
    frame: false,
    transparent: true,
    alwaysOnTop: true,
    fullscreen: true,
    skipTaskbar: true,
    resizable: false,
    hasShadow: false,
    webPreferences: { nodeIntegration: true, contextIsolation: false },
  });

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

  return Menu.buildFromTemplate([
    { label: 'Windows', enabled: false },
    ...windowItems,
    { type: 'separator' },
    { label: 'New Window', accelerator: IS_MAC ? 'Cmd+Shift+N' : 'Ctrl+Shift+N', click: () => createWindow() },
    { label: 'Toggle Task Widget', click: () => toggleWidget() },
    { type: 'separator' },
    { label: 'Quit Fauna', click: () => { app.isQuitting = true; app.quit(); } },
  ]);
}

function refreshTray() {
  if (!tray || tray.isDestroyed?.()) return;
  tray.setContextMenu(_buildTrayMenu());
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

  // Global shortcut: Ctrl+Shift+T (Cmd+Shift+T is used by the menu for the in-app panel)
  globalShortcut.register('Ctrl+Shift+Space', () => toggleWidget());

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
  const { convId, projectId } = payload || {};
  createWindow({ convId, projectId });
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
