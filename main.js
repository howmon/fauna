import { app, BrowserWindow, Menu, Tray, globalShortcut, ipcMain, shell, nativeImage, nativeTheme } from 'electron';
import path     from 'path';
import fs       from 'fs';
import os       from 'os';
import { fileURLToPath } from 'url';
import { startServer }   from './server.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT      = 3737;
const IS_WIN    = process.platform === 'win32';
const IS_MAC    = process.platform === 'darwin';

nativeTheme.themeSource = 'dark';

// Enable Web Speech API (backed by SFSpeechRecognizer on macOS)
app.commandLine.appendSwitch('enable-features', 'WebSpeechAPI');
app.commandLine.appendSwitch('auto-select-desktop-capture-source', 'Entire screen');

// On Windows, hardware acceleration can prevent the renderer from starting
// (ICU data file-descriptor handoff to the GPU process fails).
if (IS_WIN) app.disableHardwareAcceleration();

let mainWindow;
let widgetWindow = null;
let tray = null;

// ── Window ────────────────────────────────────────────────────────────────

async function createWindow() {
  mainWindow = new BrowserWindow({
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
    },
    show: false,
  });

  // Grant microphone permission for localhost (required for Web Speech API / voice control)
  mainWindow.webContents.session.setPermissionRequestHandler((webContents, permission, callback) => {
    const allowed = ['media', 'microphone', 'audioCapture', 'clipboard-read', 'clipboard-write', 'clipboard-sanitized-write'];
    callback(allowed.includes(permission));
  });

  mainWindow.loadURL(`http://localhost:${PORT}`);

  mainWindow.once('ready-to-show', () => {
    mainWindow.show();
    mainWindow.focus();
  });
  // Fallback: if ready-to-show is delayed (common on Windows), show after 4 s
  setTimeout(() => { if (mainWindow && !mainWindow.isVisible()) mainWindow.show(); }, 4000);

  // Open external links in the default browser, not in Electron
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });

  mainWindow.webContents.on('will-navigate', (e, url) => {
    if (!url.startsWith(`http://localhost:${PORT}`)) {
      e.preventDefault();
      shell.openExternal(url);
    }
  });

  // Clear the reference when the window is destroyed so stale calls don't throw
  mainWindow.on('closed', () => { mainWindow = null; });
}

// ── Native menu ───────────────────────────────────────────────────────────

function js(code) {
  mainWindow?.webContents?.executeJavaScript(code).catch(() => {});
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
        { label: 'Toggle DevTools',     accelerator: 'Alt+Cmd+I', role: 'toggleDevTools' },
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
  const w = prefs.width  ?? 320;
  const h = prefs.height ?? 420;
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

// ── Tray ──────────────────────────────────────────────────────────────────

function createTray() {
  // Use a small template image for the tray (16x16)
  const iconPath = path.join(__dirname, 'assets', 'icon.png');
  let img = nativeImage.createFromPath(iconPath);
  img = img.resize({ width: 16, height: 16 });
  if (IS_MAC) img.setTemplateImage(true);

  tray = new Tray(img);
  tray.setToolTip('Fauna');

  const contextMenu = Menu.buildFromTemplate([
    { label: 'Show Fauna', click: () => { mainWindow?.show(); mainWindow?.focus(); } },
    { label: 'Toggle Task Widget', click: () => toggleWidget() },
    { type: 'separator' },
    { label: 'Quit', click: () => { app.isQuitting = true; app.quit(); } },
  ]);
  tray.setContextMenu(contextMenu);

  // Click tray icon to toggle widget
  tray.on('click', () => toggleWidget());
}

// ── App lifecycle ─────────────────────────────────────────────────────────

app.whenReady().then(async () => {
  Menu.setApplicationMenu(buildMenu());

  try {
    await startServer(PORT);
  } catch (err) {
    console.error('[Electron] Server failed to start:', err.message);
    app.quit();
    return;
  }

  await createWindow();

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
  globalShortcut.unregisterAll();
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
