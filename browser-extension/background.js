/**
 * Fauna Browser Bridge — background service worker
 *
 * Maintains two persistent WebSocket connections:
 *   1. ws://localhost:3737/ext  — Fauna main server
 *   2. ws://localhost:3340      — FaunaMCP relay (shares same dispatch logic)
 *
 * Commands arriving on either connection are routed through dispatchCommand()
 * and results are sent back on the same connection.
 */

const FAUNA_WS_URL  = 'ws://localhost:3737/ext';
const FAUNA_ORIGIN  = 'http://localhost:3737';
const MCP_WS_URL    = 'ws://localhost:3340';
const RECONNECT_BASE_MS  = 1500;
const RECONNECT_MAX_MS   = 30000;
const PING_INTERVAL_MS   = 20000;

// ── State — main Fauna server ─────────────────────────────────────────────

let ws              = null;
let reconnectTimer  = null;
let reconnectDelay  = RECONNECT_BASE_MS;
let pingTimer       = null;
let connected       = false;
let pendingCmds     = new Map(); // cmdId → { resolve, reject, timeoutId }
let preflightInFlight = false;

// ── State — FaunaMCP relay ────────────────────────────────────────────────

let mcpWs             = null;
let mcpReconnectTimer = null;
let mcpReconnectDelay = RECONNECT_BASE_MS;
let mcpPingTimer      = null;
let mcpConnected      = false;
let contextMenusReady = Promise.resolve();

// ── WebSocket lifecycle ───────────────────────────────────────────────────

function connect() {
  if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) return;
  if (preflightInFlight) return;

  clearTimeout(reconnectTimer);

  // Avoid noisy ws:// connection-refused errors when Fauna is not running.
  // Preflight localhost first, then open WS only when reachable.
  preflightInFlight = true;
  fetch(FAUNA_ORIGIN + '/api/ext/status', { method: 'GET' })
    .then(() => {
      ws = new WebSocket(FAUNA_WS_URL);

      ws.addEventListener('open', () => {
        connected = true;
        reconnectDelay = RECONNECT_BASE_MS;
        console.log('[fauna-ext] connected to Fauna');
        updateBadge(true);
        sendHello();
        startPing();
        broadcastStatus();
      });

      ws.addEventListener('message', async (evt) => {
        let msg;
        try { msg = JSON.parse(evt.data); } catch { return; }
        await handleServerMessage(msg);
      });

      ws.addEventListener('close', () => {
        connected = false;
        ws = null;
        stopPing();
        updateBadge(false);
        broadcastStatus();
        scheduleReconnect();
      });

      ws.addEventListener('error', () => {
        // close fires after error — reconnect handled there
      });
    })
    .catch(() => {
      connected = false;
      updateBadge(false);
      broadcastStatus();
      scheduleReconnect();
    })
    .finally(() => {
      preflightInFlight = false;
    });
}

function scheduleReconnect() {
  clearTimeout(reconnectTimer);
  reconnectTimer = setTimeout(() => {
    connect();
    reconnectDelay = Math.min(reconnectDelay * 1.5, RECONNECT_MAX_MS);
  }, reconnectDelay);
}

function startPing() {
  stopPing();
  pingTimer = setInterval(() => {
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: 'ping' }));
    }
  }, PING_INTERVAL_MS);
}

function stopPing() {
  clearInterval(pingTimer);
  pingTimer = null;
}

function send(obj) {
  if (!ws || ws.readyState !== WebSocket.OPEN) return false;
  ws.send(JSON.stringify(obj));
  return true;
}

// ── FaunaMCP relay connection ─────────────────────────────────────────────

function connectMcp() {
  if (mcpWs && (mcpWs.readyState === WebSocket.OPEN || mcpWs.readyState === WebSocket.CONNECTING)) return;

  clearTimeout(mcpReconnectTimer);
  mcpWs = new WebSocket(MCP_WS_URL);

  mcpWs.addEventListener('open', () => {
    mcpConnected      = true;
    mcpReconnectDelay = RECONNECT_BASE_MS;
    console.log('[fauna-ext] connected to FaunaMCP relay');
    updateBadge(true);
    // Send hello so the relay knows an extension is available
    const hello = { type: 'ext:hello', version: chrome.runtime.getManifest().version, userAgent: navigator.userAgent };
    mcpWs.send(JSON.stringify(hello));
    startMcpPing();
    broadcastStatus();
  });

  mcpWs.addEventListener('message', async (evt) => {
    let msg;
    try { msg = JSON.parse(evt.data); } catch { return; }
    if (msg.type === 'pong') return;
    if (msg.type === 'cmd') {
      let result;
      try   { result = await dispatchCommand(msg); }
      catch (e) { result = { ok: false, error: e.message || String(e) }; }
      mcpWs.send(JSON.stringify({ ...result, type: 'result', id: msg.id }));
    }
  });

  mcpWs.addEventListener('close', () => {
    mcpConnected = false;
    mcpWs = null;
    stopMcpPing();
    updateBadge(connected); // badge stays green if main server still up
    broadcastStatus();
    scheduleMcpReconnect();
  });

  mcpWs.addEventListener('error', () => {
    // 'close' fires after error — handled there
  });
}

function scheduleMcpReconnect() {
  clearTimeout(mcpReconnectTimer);
  mcpReconnectTimer = setTimeout(() => {
    connectMcp();
    mcpReconnectDelay = Math.min(mcpReconnectDelay * 1.5, RECONNECT_MAX_MS);
  }, mcpReconnectDelay);
}

function startMcpPing() {
  stopMcpPing();
  mcpPingTimer = setInterval(() => {
    if (mcpWs && mcpWs.readyState === WebSocket.OPEN) {
      mcpWs.send(JSON.stringify({ type: 'ping' }));
    }
  }, PING_INTERVAL_MS);
}

function stopMcpPing() {
  clearInterval(mcpPingTimer);
  mcpPingTimer = null;
}

function disconnectMcp() {
  clearTimeout(mcpReconnectTimer);
  mcpReconnectTimer = null;
  stopMcpPing();
  if (mcpWs) {
    try { mcpWs.close(); } catch (_) {}
  }
  mcpWs = null;
  mcpConnected = false;
}

function createContextMenus() {
  contextMenusReady = contextMenusReady.catch(() => {}).then(async () => {
    await chrome.contextMenus.removeAll().catch(() => {});
    chrome.contextMenus.create({
      id: 'fauna-send-selection',
      title: 'Send to Fauna',
      contexts: ['selection']
    });
    chrome.contextMenus.create({
      id: 'fauna-send-page',
      title: 'Send page to Fauna',
      contexts: ['page', 'frame']
    });
    chrome.contextMenus.create({
      id: 'fauna-snapshot',
      title: 'Take Fauna snapshot',
      contexts: ['page', 'frame']
    });
  });
  return contextMenusReady;
}

// ── Hello handshake ───────────────────────────────────────────────────────

async function sendHello() {
  let activeTab = null;
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    activeTab = tab ? { id: tab.id, url: tab.url, title: tab.title } : null;
  } catch (_) {}

  send({
    type: 'ext:hello',
    version: chrome.runtime.getManifest().version,
    activeTab,
    userAgent: navigator.userAgent
  });
}

// ── Server message handler ────────────────────────────────────────────────

async function handleServerMessage(msg) {
  const { type, id } = msg;

  if (type === 'pong') return;

  // Server → extension: show a system notification
  if (type === 'notify') {
    showNotification(msg.id, msg.title, msg.message, msg.icon);
    return;
  }

  // Server → extension: mark a tab as active/idle
  if (type === 'tab:working') {
    if (msg.tabId != null) setTabActive(msg.tabId); else if (_activeTabId) clearTabActive(_activeTabId);
    return;
  }

  // Command dispatch
  if (type === 'cmd') {
    let result;
    try {
      result = await dispatchCommand(msg);
    } catch (err) {
      result = { ok: false, error: err.message || String(err) };
    }
    send({ ...result, type: 'result', id });
    return;
  }

  // Pending promise resolution (for fire-and-collect flows)
  if (type === 'ack' && id && pendingCmds.has(id)) {
    const p = pendingCmds.get(id);
    pendingCmds.delete(id);
    clearTimeout(p.timeoutId);
    p.resolve(msg.data);
  }
}

// ── Command router ────────────────────────────────────────────────────────

async function dispatchCommand(msg) {
  const { action, params = {}, tabId: targetTabId } = msg;

  try {
    // Resolve which tab to operate on. Priority:
    //   1. explicit per-command tabId (server can target any tab directly)
    //   2. the sticky "working tab" set by the last tab:switch / tab:new
    //   3. the browser's active tab (hardened fallback)
    // The sticky tab is what fixes cross-tab copy/paste: once the agent
    // switches to a tab, every follow-up command keeps targeting it even if
    // OS window focus never actually moves to Chrome (an MV3 service worker
    // cannot rely on {active,currentWindow} to reflect the intended tab).
    const tab = await resolveOperatingTab(targetTabId);

    switch (action) {
      case 'tab:list':     return await cmdTabList();
      case 'tab:new':      return await cmdTabNew(params);
      case 'tab:switch':   return await cmdTabSwitch(params);
      case 'tab:close':    return await cmdTabClose(params, tab);
      case 'tab:info':     return await cmdTabInfo(tab);
      case 'navigate':     return await cmdNavigate(params, tab);
      case 'extract':          return await cmdExtract(params, tab);
      case 'extract-forms':    return await cmdExtractForms(params, tab);
      case 'extract-assets':   return await cmdExtractAssets(params, tab);
      case 'devtools:console': return await cmdDevtoolsConsole(params, tab);
      case 'devtools:network': return await cmdDevtoolsNetwork(params, tab);
      case 'devtools:har':     return await cmdDevtoolsHar(params, tab);
      case 'devtools:security':return await cmdDevtoolsSecurity(params, tab);
      case 'devtools:cookies': return await cmdDevtoolsCookies(params, tab);
      case 'devtools:storage': return await cmdDevtoolsStorage(params, tab);
      case 'fill':         return await cmdFill(params, tab);
      case 'click':        return await cmdClick(params, tab);
      case 'scroll':       return await cmdScroll(params, tab);
      case 'eval':         return await cmdEval(params, tab);
      case 'snapshot':     return await cmdSnapshot(params, tab);
      case 'snapshot-full':return await cmdSnapshotFull(params, tab);
      case 'wait':         return await cmdWait(params);
      case 'hover':        return await cmdHover(params, tab);
      case 'select':       return await cmdSelect(params, tab);
      case 'keyboard':     return await cmdKeyboard(params, tab);
      case 'type':         return await cmdType(params, tab);
      case 'drag':         return await cmdDrag(params, tab);
      // Trusted input (CDP) — required for Figma / canvas clipboard & shortcuts.
      case 'key':          return await cmdKey(params, tab);
      case 'copy':         return await cmdClipboardShortcut('copy', params, tab);
      case 'cut':          return await cmdClipboardShortcut('cut', params, tab);
      case 'paste':        return await cmdClipboardShortcut('paste', params, tab);
      case 'mouse-click':  return await cmdMouseClick(params, tab);
      case 'clipboard-read':  return await cmdClipboardRead(params, tab);
      case 'clipboard-write': return await cmdClipboardWrite(params, tab);
      // Downloads
      case 'download':      return await cmdDownload(params);
      case 'download:list': return await cmdDownloadList(params);
      // Tab groups
      case 'tab:group':    return await cmdTabGroup(params);
      case 'tab:ungroup':  return await cmdTabUngroup(params);
      // Navigation lifecycle
      case 'wait-navigation': return await cmdWaitNavigation(params, tab);
      // Action recorder
      case 'record:start':  return await cmdRecordStart(params);
      case 'record:stop':   return await cmdRecordStop(params);
      case 'record:status': return cmdRecordStatus();
      default:
        return { ok: false, error: 'Unknown action: ' + action };
    }
  } catch (err) {
    return { ok: false, error: err.message || String(err) };
  }
}

// ── Tab commands ──────────────────────────────────────────────────────────

// The "working tab" Fauna targets by default. Set by tab:switch / tab:new and
// by manual tab activation, cleared when that tab closes. Decouples Fauna's
// operating tab from unreliable OS window focus so cross-tab flows (e.g. copy
// from one tab, switch, paste into another) resolve against the intended tab.
let _targetTabId = null;

// Resolve the tab a command should act on (see dispatchCommand for priority).
async function resolveOperatingTab(explicitId) {
  if (explicitId != null) {
    const t = await chrome.tabs.get(explicitId).catch(() => null);
    if (t) return t;
  }
  if (_targetTabId != null) {
    const t = await chrome.tabs.get(_targetTabId).catch(() => null);
    if (t) return t;
    _targetTabId = null; // sticky tab was closed — drop it
  }
  let [active] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  if (!active) [active] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!active) [active] = await chrome.tabs.query({ active: true });
  return active || null;
}

async function cmdTabList() {
  const tabs = await chrome.tabs.query({});
  return {
    ok: true,
    tabs: tabs.map(t => ({ id: t.id, index: t.index, url: t.url, title: t.title, active: t.active, windowId: t.windowId }))
  };
}

async function cmdTabNew({ url } = {}) {
  const tab = await chrome.tabs.create({ url: url || 'about:blank', active: true });
  if (url) await waitForTabLoad(tab.id);
  _targetTabId = tab.id; // newly opened tab becomes the working tab
  return { ok: true, tabId: tab.id, url: tab.url };
}

async function cmdTabSwitch({ tabId, index } = {}) {
  let tab;
  if (tabId) {
    tab = await chrome.tabs.get(tabId).catch(() => null);
  } else if (typeof index === 'number') {
    const tabs = await chrome.tabs.query({ currentWindow: true });
    tab = tabs[index] || null;
  }
  if (!tab) return { ok: false, error: 'Tab not found' };
  await chrome.tabs.update(tab.id, { active: true });
  await chrome.windows.update(tab.windowId, { focused: true }).catch(() => {});
  _targetTabId = tab.id; // make the switched-to tab sticky for follow-up commands
  return { ok: true, tabId: tab.id, url: tab.url, title: tab.title };
}

async function cmdTabClose({ tabId } = {}, activeTab) {
  const id = tabId || activeTab?.id;
  if (!id) return { ok: false, error: 'No tab to close' };
  await chrome.tabs.remove(id);
  return { ok: true, closed: id };
}

async function cmdTabInfo(tab) {
  if (!tab) return { ok: false, error: 'No active tab' };
  return { ok: true, tabId: tab.id, url: tab.url, title: tab.title };
}

// ── Navigation ────────────────────────────────────────────────────────────

async function cmdNavigate({ url } = {}, tab) {
  if (!url) return { ok: false, error: 'url required' };
  if (!tab) {
    const t = await chrome.tabs.create({ url, active: true });
    await waitForTabLoad(t.id);
    return { ok: true, tabId: t.id, url };
  }
  await chrome.tabs.update(tab.id, { url, active: true });
  await waitForTabLoad(tab.id);
  const updated = await chrome.tabs.get(tab.id).catch(() => tab);
  return { ok: true, tabId: tab.id, url: updated.url, title: updated.title };
}

function waitForTabLoad(tabId, timeoutMs = 20000) {
  return new Promise((resolve) => {
    const deadline = setTimeout(resolve, timeoutMs);
    const listener = (id, info) => {
      if (id === tabId && info.status === 'complete') {
        clearTimeout(deadline);
        chrome.tabs.onUpdated.removeListener(listener);
        setTimeout(resolve, 600); // settle SPA hydration
      }
    };
    chrome.tabs.onUpdated.addListener(listener);
  });
}

// ── Content-script relay ──────────────────────────────────────────────────

async function execInTab(tabId, func, args = []) {
  try {
    const results = await chrome.scripting.executeScript({
      target: { tabId, allFrames: false },
      func,
      args
    });
    return results?.[0]?.result;
  } catch (err) {
    throw new Error('Script injection failed: ' + err.message);
  }
}

function _isHostAccessError(err) {
  var msg = String((err && err.message) || err || '');
  return /Cannot access contents of the page|host permission|Missing host permission|Cannot access a chrome:\/\/ URL/i.test(msg);
}

function _isConnectError(err) {
  var msg = String((err && err.message) || err || '');
  return /Receiving end does not exist|Could not establish connection|No tab with id/i.test(msg);
}

function _permissionPatternFromUrl(url) {
  try {
    var u = new URL(url);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
    return u.protocol + '//' + u.hostname + '/*';
  } catch (_) {
    return null;
  }
}

async function _ensureTabHostPermission(tab) {
  var pattern = _permissionPatternFromUrl(tab && tab.url);
  if (!pattern) {
    throw new Error('Cannot access this page. Open an http(s) site or grant extension access for this page type.');
  }
  if (!chrome.permissions || typeof chrome.permissions.contains !== 'function' || typeof chrome.permissions.request !== 'function') {
    return;
  }
  var has = await chrome.permissions.contains({ origins: [pattern] }).catch(function() { return false; });
  if (has) return;
  var granted = await chrome.permissions.request({ origins: [pattern] }).catch(function() { return false; });
  if (!granted) {
    throw new Error('Site access not granted for ' + pattern + '. In extension settings, allow access on this site or on all sites.');
  }
}

async function _injectContentScript(tab) {
  try {
    await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ['content.js'] });
  } catch (err) {
    if (_isHostAccessError(err)) {
      await _ensureTabHostPermission(tab);
      await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ['content.js'] });
      return;
    }
    throw err;
  }
}

async function msgTab(tab, msg) {
  if (!tab) throw new Error('No active tab');
  try {
    return await chrome.tabs.sendMessage(tab.id, msg);
  } catch (err) {
    if (_isConnectError(err)) {
      await _injectContentScript(tab);
      return await chrome.tabs.sendMessage(tab.id, msg);
    }
    throw err;
  }
}

// ── Extract ───────────────────────────────────────────────────────────────

async function cmdExtract({ maxChars = 12000 } = {}, tab) {
  if (!tab) return { ok: false, error: 'No active tab' };
  try {
    var data = await msgTab(tab, { action: 'extract', maxChars });
    return { ok: true, ...data };
  } catch (err1) {
    try {
      return await _extractViaDebugger(tab, maxChars);
    } catch (err2) {
      if (_isHostAccessError(err1) || _isHostAccessError(err2)) {
        return { ok: false, error: 'Cannot access this page. Grant site access to the extension for this site and try again.' };
      }
      return { ok: false, error: (err2 && err2.message) || (err1 && err1.message) || 'Page extraction failed' };
    }
  }
}

async function _extractViaDebugger(tab, maxChars) {
  var limit = Math.max(500, Math.min(Number(maxChars) || 12000, 50000));
  return await _debuggerSession(tab.id, async (target) => {
    await chrome.debugger.sendCommand(target, 'Runtime.enable', {});
    const evalResult = await chrome.debugger.sendCommand(target, 'Runtime.evaluate', {
      expression: `(function(){
        var txt = '';
        try { txt = ((document.body && document.body.innerText) || '').trim(); } catch (_) {}
        if (!txt) {
          try { txt = ((document.documentElement && document.documentElement.innerText) || '').trim(); } catch (_) {}
        }
        var links = [];
        try {
          links = Array.from(document.querySelectorAll('a[href]')).slice(0, 30).map(function(a){
            return { text: (a.innerText || '').trim().slice(0, 120), href: a.href };
          });
        } catch (_) {}
        return JSON.stringify({
          title: document.title || '',
          url: location.href || '',
          text: (txt || '').slice(0, ${limit}),
          links: links
        });
      })()`,
      returnByValue: true,
      awaitPromise: false,
    });
    var data = {};
    try { data = JSON.parse(evalResult?.result?.value || '{}'); } catch (_) { data = {}; }
    return {
      ok: true,
      title: data.title || tab.title || '',
      url: data.url || tab.url || '',
      text: data.text || '',
      links: Array.isArray(data.links) ? data.links : [],
      method: 'debugger'
    };
  });
}

async function cmdExtractForms({} = {}, tab) {
  if (!tab) return { ok: false, error: 'No active tab' };
  const data = await msgTab(tab, { action: 'extract-forms' }).catch(() => ({ fields: [] }));
  return { ok: true, ...data };
}

async function cmdExtractAssets({} = {}, tab) {
  if (!tab) return { ok: false, error: 'No active tab' };
  try {
    var data = await msgTab(tab, { action: 'extract-assets' });
    return { ok: true, ...data };
  } catch (err) {
    if (_isHostAccessError(err)) {
      return { ok: false, error: 'Cannot access this page. Grant site access to the extension for this site and try again.' };
    }
    throw err;
  }
}

// ── DevTools helpers — all use chrome.debugger CDP ────────────────────────

// CDP attachment manager. Keeps ONE persistent debugger attachment per tab,
// reused across commands and auto-detached after a short idle period, with
// per-tab serialization. This eliminates the attach/detach races that produced
// "Detached while handling command" and "Debugger is not attached" when the
// agent ran a batch of CDP actions (the old per-command fire-and-forget detach
// tore down the next command's freshly-attached session). On attach we also
// enable focus emulation so clipboard (copy/paste) and canvas apps like Figma
// work even when Chrome is not the OS-focused window.
const _cdpAttached = new Map();    // tabId → true
const _cdpIdleTimers = new Map();  // tabId → timeout id
const _cdpQueues = new Map();      // tabId → tail Promise (serialization)
const _CDP_IDLE_MS = 6000;

async function _cdpEnsureAttached(tabId) {
  if (_cdpAttached.get(tabId)) return;
  try {
    await chrome.debugger.attach({ tabId }, '1.3');
  } catch (e) {
    if (!/already attached/i.test(String(e && e.message))) throw e;
  }
  _cdpAttached.set(tabId, true);
  // Make the page believe it is focused & active so clipboard read/write and
  // canvas focus work without Chrome being the OS-focused window.
  try { await chrome.debugger.sendCommand({ tabId }, 'Emulation.setFocusEmulationEnabled', { enabled: true }); } catch (_) {}
}

function _cdpScheduleIdleDetach(tabId) {
  clearTimeout(_cdpIdleTimers.get(tabId));
  _cdpIdleTimers.set(tabId, setTimeout(async () => {
    _cdpIdleTimers.delete(tabId);
    if (!_cdpAttached.get(tabId)) return;
    _cdpAttached.delete(tabId);
    try { await chrome.debugger.sendCommand({ tabId }, 'Emulation.setFocusEmulationEnabled', { enabled: false }); } catch (_) {}
    try { await chrome.debugger.detach({ tabId }); } catch (_) {}
  }, _CDP_IDLE_MS));
}

// Run CDP work on a tab through the shared attachment, serialized per tab and
// bounded by a timeout. The attachment is kept alive and detached only after an
// idle gap, so consecutive commands in a batch reuse it instead of thrashing.
function _cdpRun(tabId, fn, timeoutMs = 15000) {
  const prev = _cdpQueues.get(tabId) || Promise.resolve();
  const run = prev.catch(() => {}).then(async () => {
    clearTimeout(_cdpIdleTimers.get(tabId)); // cancel pending idle-detach while in use
    await _cdpEnsureAttached(tabId);
    try {
      return await Promise.race([
        fn({ tabId }),
        new Promise((_, rej) => setTimeout(() => rej(new Error('DevTools session timed out')), timeoutMs)),
      ]);
    } finally {
      _cdpScheduleIdleDetach(tabId);
    }
  });
  _cdpQueues.set(tabId, run.catch(() => {}));
  return run;
}

// Backwards-compatible wrapper — all existing CDP commands route through here.
function _debuggerSession(tabId, fn, timeoutMs = 15000) {
  return _cdpRun(tabId, fn, timeoutMs);
}

// Keep tracked state correct if the debugger detaches for any reason
// (tab closed, DevTools opened, target crash, "Cancel" on the CDP banner).
chrome.debugger.onDetach.addListener((source) => {
  if (source && source.tabId != null) {
    _cdpAttached.delete(source.tabId);
    clearTimeout(_cdpIdleTimers.get(source.tabId));
    _cdpIdleTimers.delete(source.tabId);
  }
});

// Capture console messages by injecting a shim that hooks console.*,
// window.onerror, and unhandledrejection — plus subscribing to CDP
// Runtime.exceptionThrown so native exceptions that never flow through
// console.error are still captured.
async function cmdDevtoolsConsole({ limit = 100 } = {}, tab) {
  if (!tab) return { ok: false, error: 'No active tab' };
  return await _debuggerSession(tab.id, async (target) => {
    await chrome.debugger.sendCommand(target, 'Runtime.enable', {});
    await chrome.debugger.sendCommand(target, 'Log.enable', {});

    // Subscribe to native Runtime.exceptionThrown / Log.entryAdded events
    // for the duration of this call and push them into the page-side
    // buffer via Runtime.evaluate. Listener stays scoped to this session.
    const onEvent = (source, method, params) => {
      if (!source || source.tabId !== tab.id) return;
      let entry = null;
      if (method === 'Runtime.exceptionThrown' && params && params.exceptionDetails) {
        const d = params.exceptionDetails;
        const msg = (d.exception && (d.exception.description || d.exception.value)) || d.text || 'Uncaught exception';
        entry = {
          level: 'error',
          source: 'runtime.exception',
          args: [String(msg)],
          line: d.lineNumber || 0,
          col: d.columnNumber || 0,
          url: d.url || '',
          ts: Date.now(),
        };
      } else if (method === 'Log.entryAdded' && params && params.entry) {
        const e = params.entry;
        // Surface browser-level warnings/errors (network, deprecation,
        // security, CSP, etc.) that don't appear via console.*.
        if (e.level === 'error' || e.level === 'warning') {
          entry = {
            level: e.level === 'warning' ? 'warn' : 'error',
            source: 'log.' + (e.source || 'other'),
            args: [String(e.text || '')],
            line: e.lineNumber || 0,
            url: e.url || '',
            ts: e.timestamp ? Math.round(e.timestamp) : Date.now(),
          };
        }
      }
      if (!entry) return;
      // Push asynchronously; ignore failures (page may be navigating).
      chrome.debugger.sendCommand(target, 'Runtime.evaluate', {
        expression: `(function(e){try{(window.__faunaConsoleBuf__=window.__faunaConsoleBuf__||[]).push(e);if(window.__faunaConsoleBuf__.length>500)window.__faunaConsoleBuf__.shift();}catch(_){}})(${JSON.stringify(entry)})`,
        returnByValue: false,
      }).catch(() => {});
    };
    chrome.debugger.onEvent.addListener(onEvent);

    try {
      // Inject a shim that hooks console.*, window.onerror, and
      // unhandledrejection. Idempotent — second call is a no-op.
      await chrome.debugger.sendCommand(target, 'Runtime.evaluate', {
        expression: `(function(){
          if (window.__faunaConsoleShimInstalled__) return;
          window.__faunaConsoleShimInstalled__ = true;
          window.__faunaConsoleBuf__ = window.__faunaConsoleBuf__ || [];
          var BUF = window.__faunaConsoleBuf__;
          var push = function(entry){
            BUF.push(entry);
            if (BUF.length > 500) BUF.shift();
          };
          var fmt = function(a){
            try {
              if (a instanceof Error) return (a.stack || a.message || String(a));
              if (typeof a === 'string') return a;
              return JSON.stringify(a);
            } catch (_) { return String(a); }
          };
          var _orig = {log:console.log,warn:console.warn,error:console.error,info:console.info,debug:console.debug};
          ['log','warn','error','info','debug'].forEach(function(l){
            console[l] = function(){
              push({level:l, source:'console.'+l, args:Array.from(arguments).map(fmt), ts:Date.now()});
              try { _orig[l].apply(console, arguments); } catch (_) {}
            };
          });
          window.addEventListener('error', function(ev){
            push({
              level: 'error',
              source: 'window.onerror',
              args: [String((ev.error && (ev.error.stack || ev.error.message)) || ev.message || 'Uncaught error')],
              line: ev.lineno || 0,
              col:  ev.colno || 0,
              url:  ev.filename || '',
              ts:   Date.now(),
            });
          }, true);
          window.addEventListener('unhandledrejection', function(ev){
            var r = ev.reason;
            push({
              level: 'error',
              source: 'unhandledrejection',
              args: [String((r && (r.stack || r.message)) || (typeof r === 'string' ? r : JSON.stringify(r)) || 'Unhandled rejection')],
              ts: Date.now(),
            });
          }, true);
        })()`,
        returnByValue: false,
      });

      // Give native CDP events a brief tick to deliver any pending entries
      // (e.g. exceptions thrown right at the moment of attach).
      await new Promise((r) => setTimeout(r, 120));

      // Read the buffer back out.
      const lim = Math.min(Math.max(Number(limit) || 100, 1), 500);
      const read = await chrome.debugger.sendCommand(target, 'Runtime.evaluate', {
        expression: `JSON.stringify((window.__faunaConsoleBuf__||[]).slice(-${lim}))`,
        returnByValue: true, awaitPromise: false,
      });
      const entries = JSON.parse(read?.result?.value || '[]');
      return { ok: true, entries, count: entries.length, url: tab.url };
    } finally {
      try { chrome.debugger.onEvent.removeListener(onEvent); } catch (_) {}
    }
  });
}

// Network: enable network domain, capture a snapshot of current requests
// (requests made before devtools attach aren't available — attach early or
// use performance.getEntriesByType for a retrospective list)
async function cmdDevtoolsNetwork({ includeHeaders = true, includeBodies = false, filter } = {}, tab) {
  if (!tab) return { ok: false, error: 'No active tab' };
  return await _debuggerSession(tab.id, async (target) => {
    await chrome.debugger.sendCommand(target, 'Network.enable', {});
    // Retrospective: read from window.performance.getEntriesByType('resource')
    const perfResult = await chrome.debugger.sendCommand(target, 'Runtime.evaluate', {
      expression: `JSON.stringify(performance.getEntriesByType('resource').slice(0,200).map(function(e){
        return {name:e.name,type:e.initiatorType,method:'GET',status:0,
          transferSize:e.transferSize,duration:Math.round(e.duration),
          startTime:Math.round(e.startTime)};
      }))`,
      returnByValue: true,
    });
    const resources = JSON.parse(perfResult?.result?.value || '[]');
    // Also grab navigation timing
    const navResult = await chrome.debugger.sendCommand(target, 'Runtime.evaluate', {
      expression: `JSON.stringify((function(){var t=performance.timing;return t?{domContentLoaded:t.domContentLoadedEventEnd-t.navigationStart,load:t.loadEventEnd-t.navigationStart,ttfb:t.responseStart-t.navigationStart}:null;})())`,
      returnByValue: true,
    });
    const navTiming = JSON.parse(navResult?.result?.value || 'null');
    const filtered = filter ? resources.filter(r => r.name.includes(filter)) : resources;
    return { ok: true, resources: filtered, count: filtered.length, navTiming, url: tab.url };
  });
}

// HAR export: builds a minimal HAR 1.2 object from performance entries
async function cmdDevtoolsHar({} = {}, tab) {
  if (!tab) return { ok: false, error: 'No active tab' };
  return await _debuggerSession(tab.id, async (target) => {
    await chrome.debugger.sendCommand(target, 'Network.enable', {});
    const result = await chrome.debugger.sendCommand(target, 'Runtime.evaluate', {
      expression: `JSON.stringify((function(){
        var entries = performance.getEntriesByType('resource').slice(0,500);
        var nav = performance.getEntriesByType('navigation')[0];
        var all = nav ? [{name:location.href,initiatorType:'navigation',transferSize:nav.transferSize||0,duration:nav.duration,startTime:0,decodedBodySize:nav.decodedBodySize||0,encodedBodySize:nav.encodedBodySize||0}].concat(entries) : entries;
        return {
          log: {
            version:'1.2',
            creator:{name:'Fauna Browser Bridge',version:'1.0'},
            pages:[{startedDateTime:new Date(performance.timeOrigin).toISOString(),id:'page_1',title:document.title,pageTimings:{onContentLoad:performance.timing?performance.timing.domContentLoadedEventEnd-performance.timing.navigationStart:-1,onLoad:performance.timing?performance.timing.loadEventEnd-performance.timing.navigationStart:-1}}],
            entries: all.map(function(e,i){return {
              startedDateTime: new Date(performance.timeOrigin+e.startTime).toISOString(),
              time: Math.round(e.duration),
              request:{method:'GET',url:e.name,httpVersion:'h2',headers:[],queryString:[],cookies:[],headersSize:-1,bodySize:0,postData:undefined},
              response:{status:0,statusText:'',httpVersion:'h2',headers:[],cookies:[],content:{size:e.decodedBodySize||0,mimeType:''},redirectURL:'',headersSize:-1,bodySize:e.encodedBodySize||e.transferSize||0},
              cache:{},
              timings:{send:0,wait:Math.round(e.duration*0.6),receive:Math.round(e.duration*0.4)},
              pageref:'page_1'
            };})
          }
        };
      })())`,
      returnByValue: true,
    });
    const har = JSON.parse(result?.result?.value || 'null');
    return { ok: true, har, entryCount: har?.log?.entries?.length || 0, url: tab.url };
  });
}

// Security: TLS cert info + mixed content + CSP headers via Security domain
async function cmdDevtoolsSecurity({} = {}, tab) {
  if (!tab) return { ok: false, error: 'No active tab' };
  return await _debuggerSession(tab.id, async (target) => {
    await chrome.debugger.sendCommand(target, 'Network.enable', {});
    await chrome.debugger.sendCommand(target, 'Security.enable', {});
    // Get security state
    const state = await chrome.debugger.sendCommand(target, 'Security.getSecurityState', {}).catch(() => null);
    // Read meta CSP + headers via JS
    const cspResult = await chrome.debugger.sendCommand(target, 'Runtime.evaluate', {
      expression: `JSON.stringify((function(){
        var metas = Array.from(document.querySelectorAll('meta[http-equiv]')).map(function(m){return {httpEquiv:m.httpEquiv,content:m.content};});
        var isHttps = location.protocol==='https:';
        var mixedContent = Array.from(document.querySelectorAll('[src],[href]')).filter(function(e){
          var u=(e.src||e.href||''); return isHttps && u.startsWith('http:');
        }).slice(0,20).map(function(e){return {tag:e.tagName,url:(e.src||e.href)};});
        var cookies = document.cookie.split(';').filter(Boolean).map(function(c){return c.trim().split('=')[0];});
        return {protocol:location.protocol,host:location.host,metaHeaders:metas,mixedContent:mixedContent,visibleCookieNames:cookies.slice(0,30)};
      })())`,
      returnByValue: true,
    });
    const pageInfo = JSON.parse(cspResult?.result?.value || '{}');
    return { ok: true, securityState: state, ...pageInfo, url: tab.url };
  });
}

// Cookies: read all cookies for the current tab via CDP
async function cmdDevtoolsCookies({} = {}, tab) {
  if (!tab) return { ok: false, error: 'No active tab' };
  return await _debuggerSession(tab.id, async (target) => {
    await chrome.debugger.sendCommand(target, 'Network.enable', {});
    const result = await chrome.debugger.sendCommand(target, 'Network.getCookies', { urls: [tab.url] });
    return { ok: true, cookies: result.cookies, count: result.cookies.length, url: tab.url };
  });
}

// Storage: localStorage, sessionStorage, IndexedDB database names
async function cmdDevtoolsStorage({} = {}, tab) {
  if (!tab) return { ok: false, error: 'No active tab' };
  return await _debuggerSession(tab.id, async (target) => {
    const result = await chrome.debugger.sendCommand(target, 'Runtime.evaluate', {
      expression: `JSON.stringify((function(){
        var ls={},ss={};
        try{for(var i=0;i<localStorage.length;i++){var k=localStorage.key(i);ls[k]=localStorage.getItem(k).slice(0,500);}}catch(e){}
        try{for(var i=0;i<sessionStorage.length;i++){var k=sessionStorage.key(i);ss[k]=sessionStorage.getItem(k).slice(0,500);}}catch(e){}
        var idbDbs=[];
        try{indexedDB.databases().then(function(dbs){idbDbs=dbs.map(function(d){return d.name;});});}catch(e){}
        return {localStorage:ls,sessionStorage:ss,localStorageCount:Object.keys(ls).length,sessionStorageCount:Object.keys(ss).length};
      })())`,
      returnByValue: true, awaitPromise: true,
    });
    const storage = JSON.parse(result?.result?.value || '{}');
    return { ok: true, ...storage, url: tab.url };
  });
}

// ── Interaction ───────────────────────────────────────────────────────────

async function cmdFill({ fields = [], selector, value } = {}, tab) {
  if (!tab) return { ok: false, error: 'No active tab' };
  // Support single-field shorthand { selector, value } or batch { fields: [...] }
  const batch = fields.length ? fields : (selector ? [{ selector, value }] : []);
  if (!batch.length) return { ok: false, error: 'fields or selector+value required' };
  const result = await msgTab(tab, { action: 'fill', fields: batch });
  return { ok: true, ...result };
}

async function cmdClick({ selector, text, x, y } = {}, tab) {
  if (!tab) return { ok: false, error: 'No active tab' };
  const result = await msgTab(tab, { action: 'click', selector, text, x, y });
  return { ok: true, ...result };
}

async function cmdScroll({ direction = 'down', px, selector, behavior = 'smooth' } = {}, tab) {
  if (!tab) return { ok: false, error: 'No active tab' };
  const result = await msgTab(tab, { action: 'scroll', direction, px, selector, behavior });
  return { ok: true, ...result };
}

async function cmdHover({ selector } = {}, tab) {
  if (!tab) return { ok: false, error: 'No active tab' };
  const result = await msgTab(tab, { action: 'hover', selector });
  return { ok: true, ...result };
}

async function cmdSelect({ selector, value, label } = {}, tab) {
  if (!tab) return { ok: false, error: 'No active tab' };
  const result = await msgTab(tab, { action: 'select', selector, value, label });
  return { ok: true, ...result };
}

async function cmdKeyboard({ key, selector } = {}, tab) {
  if (!tab) return { ok: false, error: 'No active tab' };
  // A chord (contains a modifier, e.g. "Meta+c") needs a TRUSTED event to work
  // in Figma / the browser — route it through the CDP path instead of the
  // synthetic content-script dispatch, which apps ignore for shortcuts.
  if (typeof key === 'string' && key.includes('+')) {
    return await cmdKey({ keys: key, selector }, tab);
  }
  const result = await msgTab(tab, { action: 'keyboard', key, selector });
  return { ok: true, ...result };
}

async function cmdType({ selector, text, delay, pressEnter } = {}, tab) {
  if (!tab) return { ok: false, error: 'No active tab' };
  const result = await msgTab(tab, { action: 'type', selector, text, delay, pressEnter });
  return { ok: true, ...result };
}

async function cmdDrag({ source, target, sourceX, sourceY, targetX, targetY, steps } = {}, tab) {
  if (!tab) return { ok: false, error: 'No active tab' };
  const result = await msgTab(tab, { action: 'drag', source, target, sourceX, sourceY, targetX, targetY, steps });
  return { ok: true, ...result };
}

async function cmdEval({ js } = {}, tab) {
  if (!tab) return { ok: false, error: 'No active tab' };
  if (!js) return { ok: false, error: 'js required' };
  // Use DevTools Protocol Runtime.evaluate — bypasses both the page's CSP and
  // the extension's own MV3 CSP that blocks new Function() / eval in content
  // scripts. Routes through the shared attachment manager so it never races
  // with other CDP commands (input, snapshots, devtools) on the same tab.
  try {
    return await _debuggerSession(tab.id, async (target) => {
      const evalResult = await chrome.debugger.sendCommand(target, 'Runtime.evaluate', {
        expression: js,
        returnByValue: true,
        awaitPromise: true,
        userGesture: true,
      });
      if (evalResult.exceptionDetails) {
        const desc = evalResult.exceptionDetails.exception?.description ||
                     evalResult.exceptionDetails.text || 'JS exception';
        return { ok: true, result: 'ERROR: ' + desc };
      }
      const val = evalResult.result?.value;
      return { ok: true, result: val === undefined ? '(undefined)' : String(val) };
    });
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

async function cmdWait({ ms = 1000 } = {}) {
  await new Promise(r => setTimeout(r, Math.min(ms, 15000)));
  return { ok: true };
}

// ── Trusted input via CDP (Input domain) ──────────────────────────────────
// Synthetic DOM events dispatched from a content script are isTrusted:false,
// so the browser and apps like Figma IGNORE them for clipboard shortcuts
// (⌘C/⌘V), drag, and many canvas interactions. CDP Input.dispatchKeyEvent /
// dispatchMouseEvent produce TRUSTED events that behave exactly like real
// user input — this is what makes cross-tab Figma copy/paste actually work.

// CDP modifier bitmask — Alt=1, Ctrl=2, Meta=4, Shift=8.
const _CDP_MODS = { alt: 1, control: 2, ctrl: 2, meta: 4, cmd: 4, command: 4, shift: 8 };
const _CDP_MOD_KEYS = {
  alt:     { key: 'Alt',     code: 'AltLeft',     keyCode: 18 },
  control: { key: 'Control', code: 'ControlLeft', keyCode: 17 },
  ctrl:    { key: 'Control', code: 'ControlLeft', keyCode: 17 },
  meta:    { key: 'Meta',    code: 'MetaLeft',    keyCode: 91 },
  cmd:     { key: 'Meta',    code: 'MetaLeft',    keyCode: 91 },
  command: { key: 'Meta',    code: 'MetaLeft',    keyCode: 91 },
  shift:   { key: 'Shift',   code: 'ShiftLeft',   keyCode: 16 },
};
const _CDP_NAMED = {
  enter: { key: 'Enter', code: 'Enter', keyCode: 13 },
  tab: { key: 'Tab', code: 'Tab', keyCode: 9 },
  escape: { key: 'Escape', code: 'Escape', keyCode: 27 },
  esc: { key: 'Escape', code: 'Escape', keyCode: 27 },
  backspace: { key: 'Backspace', code: 'Backspace', keyCode: 8 },
  delete: { key: 'Delete', code: 'Delete', keyCode: 46 },
  space: { key: ' ', code: 'Space', keyCode: 32 },
  arrowup: { key: 'ArrowUp', code: 'ArrowUp', keyCode: 38 },
  arrowdown: { key: 'ArrowDown', code: 'ArrowDown', keyCode: 40 },
  arrowleft: { key: 'ArrowLeft', code: 'ArrowLeft', keyCode: 37 },
  arrowright: { key: 'ArrowRight', code: 'ArrowRight', keyCode: 39 },
  home: { key: 'Home', code: 'Home', keyCode: 36 },
  end: { key: 'End', code: 'End', keyCode: 35 },
};

function _isMac() { return /mac|iphone|ipad/i.test(navigator.userAgent || ''); }
function _primaryMod() { return _isMac() ? 'meta' : 'control'; }

function _cdpKeyDef(token) {
  const t = String(token).toLowerCase();
  if (_CDP_NAMED[t]) return _CDP_NAMED[t];
  if (String(token).length === 1) {
    const upper = t.toUpperCase();
    if (t >= 'a' && t <= 'z') return { key: token, code: 'Key' + upper, keyCode: upper.charCodeAt(0) };
    if (t >= '0' && t <= '9') return { key: token, code: 'Digit' + t, keyCode: t.charCodeAt(0) };
    return { key: token, code: '', keyCode: t.toUpperCase().charCodeAt(0) };
  }
  return { key: token, code: '', keyCode: 0 };
}

// Dispatch a trusted key chord like "Meta+c", "Control+Shift+v", "Enter".
async function _cdpKeyChord(target, spec) {
  const parts = String(spec).split('+').map(s => s.trim()).filter(Boolean);
  const mods = [], mains = [];
  for (const p of parts) {
    if (_CDP_MODS[p.toLowerCase()] != null) mods.push(p.toLowerCase());
    else mains.push(p);
  }
  let active = 0;
  for (const m of mods) {
    active |= _CDP_MODS[m];
    const d = _CDP_MOD_KEYS[m];
    await chrome.debugger.sendCommand(target, 'Input.dispatchKeyEvent', {
      type: 'rawKeyDown', modifiers: active, key: d.key, code: d.code,
      windowsVirtualKeyCode: d.keyCode, nativeVirtualKeyCode: d.keyCode,
    });
  }
  const main = mains[0] ? _cdpKeyDef(mains[0]) : null;
  if (main) {
    await chrome.debugger.sendCommand(target, 'Input.dispatchKeyEvent', {
      type: 'keyDown', modifiers: active, key: main.key, code: main.code,
      windowsVirtualKeyCode: main.keyCode, nativeVirtualKeyCode: main.keyCode,
    });
    await chrome.debugger.sendCommand(target, 'Input.dispatchKeyEvent', {
      type: 'keyUp', modifiers: active, key: main.key, code: main.code,
      windowsVirtualKeyCode: main.keyCode, nativeVirtualKeyCode: main.keyCode,
    });
  }
  for (const m of mods.reverse()) {
    active &= ~_CDP_MODS[m];
    const d = _CDP_MOD_KEYS[m];
    await chrome.debugger.sendCommand(target, 'Input.dispatchKeyEvent', {
      type: 'keyUp', modifiers: active, key: d.key, code: d.code,
      windowsVirtualKeyCode: d.keyCode, nativeVirtualKeyCode: d.keyCode,
    });
  }
}

// Trusted left click at viewport coordinates (focuses canvas, places cursor).
async function _cdpClickXY(target, x, y, clickCount = 1) {
  await chrome.debugger.sendCommand(target, 'Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, button: 'none', buttons: 0 });
  await chrome.debugger.sendCommand(target, 'Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', buttons: 1, clickCount });
  await chrome.debugger.sendCommand(target, 'Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', buttons: 0, clickCount });
}

// Resolve click coordinates from a CSS selector (center of its bounding box).
async function _cdpCoordsForSelector(target, selector) {
  const r = await chrome.debugger.sendCommand(target, 'Runtime.evaluate', {
    expression: `(function(){var e=document.querySelector(${JSON.stringify(selector)});if(!e)return null;var b=e.getBoundingClientRect();return JSON.stringify({x:b.left+b.width/2,y:b.top+b.height/2});})()`,
    returnByValue: true,
  }).catch(() => null);
  try { return JSON.parse(r?.result?.value || 'null'); } catch (_) { return null; }
}

async function _cdpViewportCenter(target) {
  const r = await chrome.debugger.sendCommand(target, 'Runtime.evaluate', {
    expression: `JSON.stringify({x:Math.round(innerWidth/2),y:Math.round(innerHeight/2)})`,
    returnByValue: true,
  }).catch(() => null);
  try { return JSON.parse(r?.result?.value || '{"x":400,"y":300}'); } catch (_) { return { x: 400, y: 300 }; }
}

// Bring the page's document into focus so keyboard shortcuts land on the
// canvas and not a stale element. CDP key events target the focused frame,
// so this maximises reliability without a click.
async function _cdpFocusPage(target) {
  await chrome.debugger.sendCommand(target, 'Runtime.evaluate', {
    expression: `(function(){try{window.focus();var el=document.querySelector('canvas');if(el&&el.focus)el.focus();}catch(_){}return true;})()`,
    returnByValue: true, userGesture: true,
  }).catch(() => {});
}

// key — dispatch a trusted key or chord (optionally focusing first).
// params: { keys | combo | key, selector?, x?, y?, focus? }
async function cmdKey({ keys, combo, key, selector, x, y, focus } = {}, tab) {
  if (!tab) return { ok: false, error: 'No active tab' };
  const spec = keys || combo || key;
  if (!spec) return { ok: false, error: 'keys required (e.g. "Meta+c" or "Enter")' };
  return await _debuggerSession(tab.id, async (target) => {
    if (focus !== false) {
      if (x != null && y != null) { await _cdpClickXY(target, Number(x), Number(y)); await new Promise(r => setTimeout(r, 60)); }
      else if (selector) { const c = await _cdpCoordsForSelector(target, selector); if (c) { await _cdpClickXY(target, c.x, c.y); await new Promise(r => setTimeout(r, 60)); } }
      else await _cdpFocusPage(target);
    }
    await _cdpKeyChord(target, spec);
    return { ok: true, dispatched: spec, url: tab.url, title: tab.title };
  });
}

// copy / cut / paste — trusted clipboard shortcuts (platform-aware modifier).
// COPY/CUT do NOT click by default (a click would clear Figma's selection);
// pass x/y or selector to place the cursor for PASTE.
async function cmdClipboardShortcut(kind, params = {}, tab) {
  if (!tab) return { ok: false, error: 'No active tab' };
  const letter = kind === 'copy' ? 'c' : kind === 'cut' ? 'x' : 'v';
  const spec = _primaryMod() + '+' + letter;
  const wantsClick = params.x != null || params.selector;
  return await _debuggerSession(tab.id, async (target) => {
    if (wantsClick) {
      if (params.x != null && params.y != null) { await _cdpClickXY(target, Number(params.x), Number(params.y)); await new Promise(r => setTimeout(r, 80)); }
      else if (params.selector) { const c = await _cdpCoordsForSelector(target, params.selector); if (c) { await _cdpClickXY(target, c.x, c.y); await new Promise(r => setTimeout(r, 80)); } }
    } else {
      await _cdpFocusPage(target);
    }
    await _cdpKeyChord(target, spec);
    // Let the async clipboard write/read settle before the next action (e.g. a
    // tab switch) can interrupt it.
    await new Promise(r => setTimeout(r, 150));
    return { ok: true, action: kind, dispatched: spec, url: tab.url, title: tab.title };
  });
}

// mouse-click — trusted click at coordinates or a selector's center.
async function cmdMouseClick({ x, y, selector, clickCount = 1 } = {}, tab) {
  if (!tab) return { ok: false, error: 'No active tab' };
  return await _debuggerSession(tab.id, async (target) => {
    let cx = x, cy = y;
    if ((cx == null || cy == null) && selector) {
      const c = await _cdpCoordsForSelector(target, selector);
      if (!c) return { ok: false, error: 'Selector not found: ' + selector };
      cx = c.x; cy = c.y;
    }
    if (cx == null || cy == null) { const c = await _cdpViewportCenter(target); cx = c.x; cy = c.y; }
    await _cdpClickXY(target, Number(cx), Number(cy), Number(clickCount) || 1);
    return { ok: true, x: cx, y: cy, url: tab.url };
  });
}

// clipboard-read / clipboard-write — plain-text clipboard access for
// verification. Prefers the offscreen document (no tab focus required); falls
// back to CDP on the tab. (Rich Figma payloads are handled by the OS during
// copy/paste — this text path is for verification / plain-text transfer.)
async function cmdClipboardRead({} = {}, tab) {
  try {
    const r = await _offscreenClipboard('read');
    if (r && r.ok) return { ok: true, text: r.text || '', length: (r.text || '').length, via: 'offscreen' };
  } catch (_) {}
  if (!tab) return { ok: false, error: 'No active tab (offscreen clipboard unavailable)' };
  return await _debuggerSession(tab.id, async (target) => {
    await _cdpFocusPage(target);
    const r = await chrome.debugger.sendCommand(target, 'Runtime.evaluate', {
      expression: `navigator.clipboard.readText().then(t=>t).catch(e=>'ERR:'+e.message)`,
      returnByValue: true, awaitPromise: true, userGesture: true,
    });
    const text = r?.result?.value ?? '';
    if (typeof text === 'string' && text.startsWith('ERR:')) return { ok: false, error: text.slice(4) };
    return { ok: true, text, length: (text || '').length, via: 'cdp' };
  });
}

async function cmdClipboardWrite({ text = '' } = {}, tab) {
  try {
    const r = await _offscreenClipboard('write', String(text));
    if (r && r.ok) return { ok: true, written: String(text).length, via: 'offscreen' };
  } catch (_) {}
  if (!tab) return { ok: false, error: 'No active tab (offscreen clipboard unavailable)' };
  return await _debuggerSession(tab.id, async (target) => {
    await _cdpFocusPage(target);
    const r = await chrome.debugger.sendCommand(target, 'Runtime.evaluate', {
      expression: `navigator.clipboard.writeText(${JSON.stringify(String(text))}).then(()=>'ok').catch(e=>'ERR:'+e.message)`,
      returnByValue: true, awaitPromise: true, userGesture: true,
    });
    const v = r?.result?.value || '';
    if (v.startsWith('ERR:')) return { ok: false, error: v.slice(4) };
    return { ok: true, written: String(text).length, via: 'cdp' };
  });
}

// ── Offscreen document (clipboard without tab focus) ──────────────────────
let _offscreenReady = null;
async function _ensureOffscreen() {
  if (!chrome.offscreen) throw new Error('offscreen API unavailable');
  if (_offscreenReady) return _offscreenReady;
  _offscreenReady = (async () => {
    try {
      const has = chrome.offscreen.hasDocument ? await chrome.offscreen.hasDocument() : false;
      if (has) return;
      await chrome.offscreen.createDocument({
        url: 'offscreen.html',
        reasons: ['CLIPBOARD'],
        justification: 'Read/write the system clipboard for copy/paste actions.',
      });
    } catch (e) {
      if (!/single offscreen|already/i.test(String(e && e.message))) { _offscreenReady = null; throw e; }
    }
  })();
  return _offscreenReady;
}
async function _offscreenClipboard(op, text) {
  await _ensureOffscreen();
  return await chrome.runtime.sendMessage({ target: 'offscreen-clipboard', op, text });
}

// ── Downloads ─────────────────────────────────────────────────────────────
async function cmdDownload({ url, filename, saveAs } = {}) {
  if (!url) return { ok: false, error: 'url required' };
  let id;
  try {
    id = await chrome.downloads.download({ url, filename: filename || undefined, saveAs: !!saveAs, conflictAction: 'uniquify' });
  } catch (e) {
    return { ok: false, error: e.message || String(e) };
  }
  const item = await _waitDownload(id, 60000);
  return {
    ok: !item || item.state !== 'interrupted',
    downloadId: id,
    state: item?.state || 'in_progress',
    path: item?.filename || null,
    bytes: item?.totalBytes,
    url,
    error: item?.error || null,
  };
}
function _waitDownload(id, timeoutMs) {
  return new Promise((resolve) => {
    const finish = () => { cleanup(); chrome.downloads.search({ id }).then(items => resolve(items && items[0])).catch(() => resolve(null)); };
    const onChanged = (delta) => {
      if (delta.id !== id) return;
      if (delta.state && (delta.state.current === 'complete' || delta.state.current === 'interrupted')) finish();
    };
    const to = setTimeout(finish, timeoutMs);
    function cleanup() { clearTimeout(to); chrome.downloads.onChanged.removeListener(onChanged); }
    chrome.downloads.onChanged.addListener(onChanged);
  });
}
async function cmdDownloadList({ limit = 20 } = {}) {
  const items = await chrome.downloads.search({ limit: Math.min(Number(limit) || 20, 100), orderBy: ['-startTime'] });
  return { ok: true, downloads: items.map(d => ({ id: d.id, url: d.url, filename: d.filename, state: d.state, bytes: d.totalBytes, mime: d.mime })) };
}

// ── Tab groups ────────────────────────────────────────────────────────────
async function cmdTabGroup({ tabIds, tabId, title, color, collapsed } = {}) {
  let ids = Array.isArray(tabIds) ? tabIds.slice() : [];
  if (!ids.length && tabId != null) ids = [tabId];
  if (!ids.length) return { ok: false, error: 'tabIds required' };
  const groupId = await chrome.tabs.group({ tabIds: ids });
  const upd = {};
  if (title != null) upd.title = String(title);
  if (color) upd.color = color; // grey|blue|red|yellow|green|pink|purple|cyan|orange
  if (collapsed != null) upd.collapsed = !!collapsed;
  if (Object.keys(upd).length && chrome.tabGroups) { try { await chrome.tabGroups.update(groupId, upd); } catch (_) {} }
  return { ok: true, groupId, tabIds: ids, title: title || null, color: color || null };
}
async function cmdTabUngroup({ tabIds, tabId } = {}) {
  let ids = Array.isArray(tabIds) ? tabIds.slice() : [];
  if (!ids.length && tabId != null) ids = [tabId];
  if (!ids.length) return { ok: false, error: 'tabIds required' };
  await chrome.tabs.ungroup(ids);
  return { ok: true, ungrouped: ids };
}

// ── Navigation lifecycle (webNavigation) ──────────────────────────────────
// Resolve when the tab's top frame finishes its next navigation — more reliable
// than polling for SPA route changes / redirects than tabs.onUpdated.
function cmdWaitNavigation({ timeoutMs = 15000 } = {}, tab) {
  if (!tab) return Promise.resolve({ ok: false, error: 'No active tab' });
  const tabId = tab.id;
  return new Promise((resolve) => {
    let settled = false;
    const finish = (data) => { if (settled) return; settled = true; cleanup(); resolve(data); };
    const onCompleted = (details) => {
      if (details.tabId === tabId && details.frameId === 0) {
        chrome.tabs.get(tabId).then(t => finish({ ok: true, url: t.url, title: t.title }))
          .catch(() => finish({ ok: true, url: details.url }));
      }
    };
    const to = setTimeout(() => finish({ ok: false, error: 'wait-navigation timed out', timedOut: true }), Math.min(Number(timeoutMs) || 15000, 60000));
    function cleanup() { clearTimeout(to); chrome.webNavigation.onCompleted.removeListener(onCompleted); }
    chrome.webNavigation.onCompleted.addListener(onCompleted);
  });
}

// ── Action recorder ───────────────────────────────────────────────────────
// Records the user's interactions ACROSS tabs into a session: DOM events
// (relayed from content.js), navigations, tab switches, selections, plus
// throttled screenshots. Streams each step to Fauna live (pushEvent) and on
// stop sends the complete recording over the socket for the app to persist.
let _rec = { active: false };

async function cmdRecordStart({ name } = {}) {
  _rec = { active: true, startedAt: Date.now(), seq: 0, steps: [], lastShotAt: 0, name: name || '' };
  const tabs = await chrome.tabs.query({});
  for (const t of tabs) {
    if (!t.id || !/^https?:|^file:/.test(t.url || '')) continue;
    // Content scripts only auto-inject into pages loaded AFTER the extension
    // started, so tabs already open (e.g. the user's Figma tabs) have no
    // recorder. Inject it now (idempotent) so every tab is actually armed.
    try { await chrome.scripting.executeScript({ target: { tabId: t.id, allFrames: false }, files: ['content.js'] }); } catch (_) {}
    chrome.tabs.sendMessage(t.id, { action: 'recorder:on' }).catch(() => {});
  }
  const [active] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  if (active) _recorderOnStep({ type: 'navigate', url: active.url, title: active.title }, { tab: active });
  pushEvent('recording:started', { name: _rec.name, startedAt: _rec.startedAt });
  return { ok: true, recording: true };
}

async function cmdRecordStop() {
  if (!_rec.active) return { ok: true, recording: false, stepCount: 0 };
  _rec.active = false;
  const tabs = await chrome.tabs.query({});
  for (const t of tabs) { chrome.tabs.sendMessage(t.id, { action: 'recorder:off' }).catch(() => {}); }
  const recording = {
    name: _rec.name || ('Recording — ' + new Date().toLocaleString()),
    startedAt: _rec.startedAt,
    endedAt: Date.now(),
    durationMs: Date.now() - _rec.startedAt,
    steps: _rec.steps,
    stepCount: _rec.steps.length,
  };
  send({ type: 'recording:complete', recording }); // app persists it
  pushEvent('recording:stopped', { stepCount: recording.stepCount, durationMs: recording.durationMs });
  return { ok: true, recording: false, stepCount: recording.stepCount };
}

function cmdRecordStatus() {
  return { ok: true, recording: !!_rec.active, stepCount: _rec.active ? _rec.steps.length : 0, name: _rec.active ? _rec.name : null };
}

// Enrich a raw step (from content.js or from tab events) with timing + tab
// context, buffer it, stream it live, and grab a throttled screenshot.
function _recorderOnStep(step, sender) {
  if (!_rec.active) return;
  const tab = sender && sender.tab;
  const enriched = Object.assign({}, step, {
    id: 'st_' + (_rec.seq++),
    t: Date.now() - _rec.startedAt,
    tabId: tab ? tab.id : (step.tabId ?? null),
    url: tab ? tab.url : (step.url ?? null),
    title: tab ? tab.title : (step.title ?? null),
  });
  _rec.steps.push(enriched);
  pushEvent('recording:step', enriched);
  if (tab) _recMaybeShot(tab, enriched);
}

// Grab a small JPEG of the active tab (no debugger — captureVisibleTab), at
// most every ~1.6s, and attach/stream it for the step's map thumbnail.
function _recMaybeShot(tab, step) {
  const now = Date.now();
  if (now - _rec.lastShotAt < 1600) return;
  _rec.lastShotAt = now;
  try {
    chrome.tabs.captureVisibleTab(tab.windowId, { format: 'jpeg', quality: 40 }, (dataUrl) => {
      if (chrome.runtime.lastError || !dataUrl || dataUrl.length > 500000) return;
      const s = _rec.active && _rec.steps.find((x) => x.id === step.id);
      if (s) s.shot = dataUrl;
      pushEvent('recording:step-shot', { id: step.id, shot: dataUrl });
    });
  } catch (_) {}
}

// ── Screenshots ───────────────────────────────────────────────────────────

// ── chrome.debugger screenshot (focus-independent) ──────────────────────
// Uses the DevTools Protocol to capture a JPEG regardless of which app has
// OS focus.  Attaches, captures, detaches.  Chrome shows a brief infobar
// during the capture but it is the only reliable headless-friendly method.
// Optional viewport: { width, height, deviceScaleFactor=1, mobile=false }
// overrides device metrics for the capture so the model can request a
// specific viewport (e.g. 1440×900 desktop or 375×812 mobile) without
// resorting to html2canvas via eval.
async function captureViaDebugger(tabId, timeoutMs = 3000, viewport = null) {
  return _cdpRun(tabId, async (target) => {
    let metricsOverridden = false;
    try {
      if (viewport && viewport.width && viewport.height) {
        await chrome.debugger.sendCommand(target, 'Emulation.setDeviceMetricsOverride', {
          width: Math.floor(viewport.width),
          height: Math.floor(viewport.height),
          deviceScaleFactor: viewport.deviceScaleFactor || 1,
          mobile: !!viewport.mobile
        });
        metricsOverridden = true;
        // Give the page a tick to relayout at the new viewport.
        await new Promise(r => setTimeout(r, 250));
      }
      const result = await Promise.race([
        chrome.debugger.sendCommand(target, 'Page.captureScreenshot', { format: 'jpeg', quality: 75 }),
        new Promise((_, rej) => setTimeout(() => rej(new Error('debugger captureScreenshot timed out')), timeoutMs))
      ]);
      return result.data; // base64 JPEG
    } finally {
      if (metricsOverridden) {
        try { await chrome.debugger.sendCommand(target, 'Emulation.clearDeviceMetricsOverride', {}); } catch (_) {}
      }
    }
  }, Math.max(timeoutMs + 3000, 15000));
}

async function cmdSnapshot(params = {}, tab) {
  if (!tab) return { ok: false, error: 'No active tab' };
  const errors = [];
  const viewport = (params && (params.width || params.height))
    ? { width: params.width, height: params.height, deviceScaleFactor: params.deviceScaleFactor, mobile: params.mobile }
    : null;

  // Helper: captureVisibleTab with hard timeout — hangs when OS focus is elsewhere
  function captureWithTimeout(windowId, timeoutMs) {
    return Promise.race([
      chrome.tabs.captureVisibleTab(windowId, { format: 'png' }),
      new Promise((_, rej) =>
        setTimeout(() => rej(new Error('captureVisibleTab timed out')), timeoutMs)
      )
    ]);
  }

  console.log('[Fauna] cmdSnapshot starting for tab', tab.id, tab.url, viewport ? `viewport=${viewport.width}x${viewport.height}` : '');

  // Attempt 1: chrome.debugger DevTools Protocol — most reliable, works without OS focus
  // 3s attach + 3s capture = 6s max. ALSO the only path that supports viewport override.
  try {
    const base64 = await captureViaDebugger(tab.id, 3000, viewport);
    if (base64) {
      console.log('[Fauna] cmdSnapshot succeeded via debugger');
      return { ok: true, base64, mime: 'image/jpeg', type: 'viewport', method: 'debugger', viewport: viewport || undefined };
    }
  } catch (e) {
    console.log('[Fauna] debugger attempt failed:', e.message);
    errors.push('debugger: ' + e.message);
  }

  // Viewport overrides only work via debugger — if that failed and a viewport
  // was requested, don't fall back to captureVisibleTab (it would capture at
  // the user's actual window size, not the requested viewport).
  if (viewport) {
    return { ok: false, error: 'Viewport-sized snapshot requires the debugger path: ' + errors.join('; ') };
  }

  // Attempt 2: captureVisibleTab without touching focus (2s)
  try {
    const dataUrl = await captureWithTimeout(tab.windowId, 2000);
    const png = dataUrl.replace(/^data:image\/png;base64,/, '');
    const base64 = await compressToJpeg(png);
    console.log('[Fauna] cmdSnapshot succeeded via captureVisibleTab');
    return { ok: true, base64, mime: 'image/jpeg', type: 'viewport', method: 'captureVisibleTab' };
  } catch (e) {
    console.log('[Fauna] captureVisibleTab attempt failed:', e.message);
    errors.push('capture: ' + e.message);
  }

  // Attempt 3: bring window to front then captureVisibleTab (0.3s + 2s = 2.3s)
  try {
    await chrome.tabs.update(tab.id, { active: true }).catch(() => {});
    await chrome.windows.update(tab.windowId, { focused: true }).catch(() => {});
    await new Promise(r => setTimeout(r, 300));
    const dataUrl = await captureWithTimeout(tab.windowId, 2000);
    const png = dataUrl.replace(/^data:image\/png;base64,/, '');
    const base64 = await compressToJpeg(png);
    console.log('[Fauna] cmdSnapshot succeeded via focused captureVisibleTab');
    return { ok: true, base64, mime: 'image/jpeg', type: 'viewport', method: 'captureVisibleTab-focused' };
  } catch (e) {
    console.log('[Fauna] focused captureVisibleTab attempt failed:', e.message);
    errors.push('focused: ' + e.message);
  }

  console.log('[Fauna] cmdSnapshot ALL attempts failed:', errors.join('; '));
  return { ok: false, error: 'All snapshot methods failed: ' + errors.join('; ') };
}

// Compress a raw PNG base64 string to a smaller JPEG using OffscreenCanvas.
// Runs entirely inside the service worker — no server-side deps needed.
async function compressToJpeg(base64png, maxWidth = 1280, quality = 0.75) {
  try {
    const blob = await fetch('data:image/png;base64,' + base64png).then(r => r.blob());
    const bitmap = await createImageBitmap(blob);
    const w = Math.min(bitmap.width, maxWidth);
    const h = Math.round(bitmap.height * (w / bitmap.width));
    const canvas = new OffscreenCanvas(w, h);
    canvas.getContext('2d').drawImage(bitmap, 0, 0, w, h);
    bitmap.close();
    const outBlob = await canvas.convertToBlob({ type: 'image/jpeg', quality });
    const buf = await outBlob.arrayBuffer();
    const bytes = new Uint8Array(buf);
    let binary = '';
    for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
    return btoa(binary);
  } catch (_) {
    return base64png; // fallback: return original if compression fails
  }
}

async function cmdSnapshotFull(params = {}, tab) {
  if (!tab) return { ok: false, error: 'No active tab' };

  const viewport = (params && (params.width || params.height))
    ? { width: params.width, height: params.height, deviceScaleFactor: params.deviceScaleFactor, mobile: params.mobile }
    : null;

  // Viewport-sized full capture: use debugger Emulation override and
  // CDP's built-in full-page capture (captureBeyondViewport) so we don't
  // need scroll-stitch at a forced viewport — far more reliable than
  // html2canvas via eval.
  if (viewport && viewport.width && viewport.height) {
    try {
      return await _cdpRun(tab.id, async (target) => {
        try {
          await chrome.debugger.sendCommand(target, 'Emulation.setDeviceMetricsOverride', {
            width: Math.floor(viewport.width),
            height: Math.floor(viewport.height),
            deviceScaleFactor: viewport.deviceScaleFactor || 1,
            mobile: !!viewport.mobile
          });
          await new Promise(r => setTimeout(r, 350)); // let the page relayout
          const result = await chrome.debugger.sendCommand(target, 'Page.captureScreenshot', {
            format: 'jpeg', quality: 80, captureBeyondViewport: true
          });
          return { ok: true, base64: result.data, mime: 'image/jpeg', type: 'full-page', viewport };
        } finally {
          try { await chrome.debugger.sendCommand(target, 'Emulation.clearDeviceMetricsOverride', {}); } catch (_) {}
        }
      });
    } catch (e) {
      return { ok: false, error: 'Viewport full-snapshot failed: ' + (e.message || e) };
    }
  }

  // Get page dimensions (no viewport override path)
  let dims;
  try {
    dims = await msgTab(tab, { action: 'get-dims' });
  } catch (_) {
    return await cmdSnapshot({}, tab); // fallback to viewport
  }

  const { scrollHeight, scrollWidth, viewportHeight } = dims;
  if (scrollHeight <= viewportHeight * 1.5) {
    // Page fits in viewport — single capture
    return await cmdSnapshot({}, tab);
  }

  // Scroll-stitch: scroll to each viewport height, capture, build strips
  const strips = [];
  let scrollY = 0;
  const step = viewportHeight;

  while (scrollY < scrollHeight) {
    // Scroll
    await msgTab(tab, { action: 'scroll-to', y: scrollY });
    await new Promise(r => setTimeout(r, 200));

    // Capture viewport — use debugger API so focus doesn't matter
    let dataUrl;
    try {
      const b64 = await captureViaDebugger(tab.id);
      dataUrl = 'data:image/jpeg;base64,' + b64;
    } catch (_) {
      // fall back to captureVisibleTab
      await chrome.windows.update(tab.windowId, { focused: true }).catch(() => {});
      dataUrl = await chrome.tabs.captureVisibleTab(tab.windowId, { format: 'png' });
    }
    strips.push({ dataUrl, scrollY, height: Math.min(step, scrollHeight - scrollY) });
    scrollY += step;
  }

  // Scroll back to top
  await msgTab(tab, { action: 'scroll-to', y: 0 });

  // Stitch strips on an offscreen canvas via content script
  const stitched = await msgTab(tab, { action: 'stitch-strips', strips, totalHeight: scrollHeight, viewportHeight });

  if (stitched && stitched.base64) {
    return { ok: true, base64: stitched.base64, mime: 'image/png', type: 'full-page', height: scrollHeight };
  }
  // Fallback: return first strip
  const fb = strips[0]?.dataUrl?.replace(/^data:image\/png;base64,/, '') || '';
  return { ok: true, base64: fb, mime: 'image/png', type: 'viewport-fallback' };
}

// ── Badge & status ────────────────────────────────────────────────────────

// Track which tab Fauna is currently working on
let _activeTabId = null;

function updateBadge(online) {
  chrome.action.setBadgeText({ text: online ? 'ON' : '' });
  chrome.action.setBadgeBackgroundColor({ color: online ? '#10b981' : '#6b7280' });
  chrome.action.setBadgeTextColor({ color: '#ffffff' });
}

// Show a working indicator on the tab Fauna is operating on
function setTabActive(tabId) {
  if (_activeTabId && _activeTabId !== tabId) clearTabActive(_activeTabId);
  _activeTabId = tabId;
  if (tabId == null) return;
  chrome.action.setBadgeText({ text: '▶', tabId });
  chrome.action.setBadgeBackgroundColor({ color: '#0ea5e9', tabId });
  chrome.action.setBadgeTextColor({ color: '#ffffff', tabId });
}

function clearTabActive(tabId) {
  if (tabId == null) return;
  // Restore to global badge state
  chrome.action.setBadgeText({ text: connected ? 'ON' : '', tabId });
  chrome.action.setBadgeBackgroundColor({ color: connected ? '#10b981' : '#6b7280', tabId });
  if (_activeTabId === tabId) _activeTabId = null;
}

function broadcastStatus() {
  chrome.runtime.sendMessage({ type: 'fauna:status', connected, mcpConnected }).catch(() => {});
}

// ── Notifications ─────────────────────────────────────────────────────────

function showNotification(id, title, message, iconUrl) {
  chrome.notifications.create('fauna-' + (id || Date.now()), {
    type: 'basic',
    iconUrl: iconUrl || chrome.runtime.getURL('icons/icon48.png'),
    title: title || 'Fauna',
    message: message || '',
    silent: false
  });
}

// ── Push events (tab → Fauna) ─────────────────────────────────────────────

// Strip large fields (base64 snapshot, full HTML/text dumps) before broadcasting
// to the sidepanel. The activity log only needs lightweight metadata; passing
// multi-hundred-KB payloads through chrome.runtime.sendMessage every event
// causes the sidepanel UI to freeze under repeated snapshots.
function _liteForSidebar(data) {
  if (!data || typeof data !== 'object') return data;
  var out = {};
  for (var k in data) {
    if (!Object.prototype.hasOwnProperty.call(data, k)) continue;
    if (k === 'base64' || k === 'html' || k === 'rawHtml' || k === 'screenshot') continue;
    var v = data[k];
    // Truncate very long strings (e.g. full page text)
    if (typeof v === 'string' && v.length > 4000) {
      out[k] = v.slice(0, 4000);
    } else {
      out[k] = v;
    }
  }
  return out;
}

function pushEvent(eventType, data) {
  send({ type: 'event', event: eventType, data });
  // Broadcast a LIGHTWEIGHT copy to the sidebar — never the base64/HTML blobs.
  chrome.runtime.sendMessage({ type: 'fauna:event', event: eventType, data: _liteForSidebar(data) }).catch(() => {});
}

chrome.tabs.onActivated.addListener(async ({ tabId }) => {
  // Follow manual tab switches so Fauna's working tab tracks what the user is
  // looking at (until the agent explicitly switches via tab:switch).
  _targetTabId = tabId;
  if (!connected) return;
  const tab = await chrome.tabs.get(tabId).catch(() => null);
  if (!tab) return;
  pushEvent('tab:activated', { tabId, url: tab.url, title: tab.title });
  if (_rec.active) _recorderOnStep({ type: 'tabswitch', url: tab.url, title: tab.title }, { tab });
});

chrome.tabs.onRemoved.addListener((tabId) => {
  if (_targetTabId === tabId) _targetTabId = null;
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (!connected) return;
  if (changeInfo.status === 'complete') {
    pushEvent('page:loaded', { tabId, url: tab.url, title: tab.title });
    if (_rec.active) {
      _recorderOnStep({ type: 'navigate', url: tab.url, title: tab.title }, { tab });
      chrome.tabs.sendMessage(tabId, { action: 'recorder:on' }).catch(() => {}); // arm newly-loaded tabs
    }
  }
});

// ── Context menu ──────────────────────────────────────────────────────────

// Open the side panel when the toolbar icon is clicked
chrome.action.onClicked.addListener((tab) => {
  chrome.sidePanel.open({ windowId: tab.windowId }).catch(() => {});
});

// Keyboard shortcut — Ctrl+Shift+F / MacCtrl+Shift+F — toggle sidebar
chrome.commands.onCommand.addListener(async (command) => {
  if (command === 'toggle-sidebar') {
    const [win] = await chrome.windows.getAll({ windowTypes: ['normal'] }).then(ws => ws.filter(w => w.focused)).catch(() => [null]);
    if (win) chrome.sidePanel.open({ windowId: win.id }).catch(() => {});
  }
});

chrome.runtime.onInstalled.addListener(() => {
  createContextMenus();
  connect();
});

chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  if (info.menuItemId === 'fauna-send-selection' && info.selectionText) {
    pushEvent('user:selection', {
      text: info.selectionText,
      url: tab?.url,
      title: tab?.title,
      tabId: tab?.id
    });
  } else if (info.menuItemId === 'fauna-send-page' && tab) {
    const data = await cmdExtract({}, tab).catch(e => ({ ok: false, error: e.message }));
    pushEvent('user:send-page', { tabId: tab.id, url: tab.url, title: tab.title, ...data });
  } else if (info.menuItemId === 'fauna-snapshot' && tab) {
    const snap = await cmdSnapshot({}, tab).catch(e => ({ ok: false, error: e.message }));
    pushEvent('user:snapshot', { tabId: tab.id, url: tab.url, title: tab.title, ...snap });
  }
});

// ── Message bus (popup → background) ─────────────────────────────────────

if (chrome.runtime && chrome.runtime.onMessage && typeof chrome.runtime.onMessage.addListener === 'function') {
chrome.runtime.onMessage.addListener((msg, _sender, reply) => {
  if (msg.type === 'fauna:record-step') { _recorderOnStep(msg.step, _sender); return; }
  if (msg.type === 'get-status') {
    reply({ connected, mcpConnected });
    return true;
  }
  if (msg.type === 'connect') {
    connect();
    reply({ ok: true });
    return true;
  }
  if (msg.type === 'connect-mcp') {
    connectMcp();
    reply({ ok: true });
    return true;
  }
  if (msg.type === 'disconnect-mcp') {
    disconnectMcp();
    broadcastStatus();
    reply({ ok: true });
    return true;
  }
  if (msg.type === 'send-page-to-fauna') {
    chrome.tabs.query({ active: true, currentWindow: true }, async ([tab]) => {
      if (!tab) return;
      const data = await cmdExtract({}, tab).catch(e => ({ ok: false, error: e.message }));
      pushEvent('user:send-page', { tabId: tab.id, url: tab.url, title: tab.title, ...data });
    });
    reply({ ok: true });
    return true;
  }
  if (msg.type === 'snapshot-to-fauna') {
    chrome.tabs.query({ active: true, currentWindow: true }, async ([tab]) => {
      if (!tab) return;
      const snap = await cmdSnapshot({}, tab).catch(e => ({ ok: false, error: e.message }));
      pushEvent('user:snapshot', { tabId: tab.id, url: tab.url, title: tab.title, ...snap });
    });
    reply({ ok: true });
    return true;
  }
  // Element picker — activate crosshair mode in the active tab
  if (msg.type === 'pick-element') {
    chrome.tabs.query({ active: true, currentWindow: true }, async ([tab]) => {
      if (!tab) { reply({ ok: false, error: 'No active tab' }); return; }
      try {
        await chrome.tabs.sendMessage(tab.id, { action: 'picker:start' });
      } catch (_) {
        await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ['content.js'] });
        await chrome.tabs.sendMessage(tab.id, { action: 'picker:start' });
      }
      reply({ ok: true });
    });
    return true;
  }
  // Picker result relayed from content script → forward to sidebar + Fauna server
  if (msg.type === 'picker:selected') {
    chrome.runtime.sendMessage({ type: 'fauna:picker-selected', data: msg.data }).catch(() => {});
    // Push to Fauna server as a contextual event so the AI can reference it
    send({ type: 'event', event: 'user:element-picked', data: msg.data });
    reply({ ok: true });
    return true;
  }
  if (msg.type === 'picker:cancelled') {
    chrome.runtime.sendMessage({ type: 'fauna:picker-cancelled' }).catch(() => {});
    reply({ ok: true });
    return true;
  }
  return false;
});
}

// ── Service worker keepalive (alarms) ─────────────────────────────────────

chrome.alarms.create('fauna-keepalive', { periodInMinutes: 0.4 });
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === 'fauna-keepalive') {
    if (!connected) connect();
  }
});

// ── Boot ──────────────────────────────────────────────────────────────────

createContextMenus();
connect();
