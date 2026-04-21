/**
 * Fauna Browser Bridge — background service worker
 *
 * Maintains a persistent WebSocket connection to Fauna's local server
 * (ws://localhost:3737/ext) and routes commands to the appropriate
 * tab's content script. Results and push events flow back over the
 * same WS channel.
 */

const FAUNA_WS_URL  = 'ws://localhost:3737/ext';
const FAUNA_ORIGIN  = 'http://localhost:3737';
const RECONNECT_BASE_MS  = 1500;
const RECONNECT_MAX_MS   = 30000;
const PING_INTERVAL_MS   = 20000;

// ── State ─────────────────────────────────────────────────────────────────

let ws              = null;
let reconnectTimer  = null;
let reconnectDelay  = RECONNECT_BASE_MS;
let pingTimer       = null;
let connected       = false;
let pendingCmds     = new Map(); // cmdId → { resolve, reject, timeoutId }

// ── WebSocket lifecycle ───────────────────────────────────────────────────

function connect() {
  if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) return;

  clearTimeout(reconnectTimer);
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

  // Command dispatch
  if (type === 'cmd') {
    const result = await dispatchCommand(msg);
    send({ type: 'result', id, ...result });
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
    // Resolve which tab to operate on
    let tab = null;
    if (targetTabId) {
      tab = await chrome.tabs.get(targetTabId).catch(() => null);
    }
    if (!tab) {
      const [active] = await chrome.tabs.query({ active: true, currentWindow: true });
      tab = active || null;
    }

    switch (action) {
      case 'tab:list':     return await cmdTabList();
      case 'tab:new':      return await cmdTabNew(params);
      case 'tab:switch':   return await cmdTabSwitch(params);
      case 'tab:close':    return await cmdTabClose(params, tab);
      case 'tab:info':     return await cmdTabInfo(tab);
      case 'navigate':     return await cmdNavigate(params, tab);
      case 'extract':      return await cmdExtract(params, tab);
      case 'extract-forms':return await cmdExtractForms(params, tab);
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
      default:
        return { ok: false, error: 'Unknown action: ' + action };
    }
  } catch (err) {
    return { ok: false, error: err.message || String(err) };
  }
}

// ── Tab commands ──────────────────────────────────────────────────────────

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

async function msgTab(tab, msg) {
  if (!tab) throw new Error('No active tab');
  return await chrome.tabs.sendMessage(tab.id, msg);
}

// ── Extract ───────────────────────────────────────────────────────────────

async function cmdExtract({ maxChars = 12000 } = {}, tab) {
  if (!tab) return { ok: false, error: 'No active tab' };
  let data;
  try {
    data = await msgTab(tab, { action: 'extract', maxChars });
  } catch (_) {
    // Content script not yet injected (extension freshly installed) — inject and retry
    await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ['content.js'] });
    data = await msgTab(tab, { action: 'extract', maxChars });
  }
  return { ok: true, ...data };
}

async function cmdExtractForms({} = {}, tab) {
  if (!tab) return { ok: false, error: 'No active tab' };
  const data = await msgTab(tab, { action: 'extract-forms' }).catch(() => ({ fields: [] }));
  return { ok: true, ...data };
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
  const result = await msgTab(tab, { action: 'keyboard', key, selector });
  return { ok: true, ...result };
}

async function cmdEval({ js } = {}, tab) {
  if (!tab) return { ok: false, error: 'No active tab' };
  if (!js) return { ok: false, error: 'js required' };
  const result = await msgTab(tab, { action: 'eval', js });
  return { ok: true, ...result };
}

async function cmdWait({ ms = 1000 } = {}) {
  await new Promise(r => setTimeout(r, Math.min(ms, 15000)));
  return { ok: true };
}

// ── Screenshots ───────────────────────────────────────────────────────────

async function cmdSnapshot({} = {}, tab) {
  if (!tab) return { ok: false, error: 'No active tab' };
  await chrome.windows.update(tab.windowId, { focused: true }).catch(() => {});
  // Small delay so the focused window is on screen
  await new Promise(r => setTimeout(r, 150));
  const dataUrl = await chrome.tabs.captureVisibleTab(tab.windowId, { format: 'png' });
  const base64 = dataUrl.replace(/^data:image\/png;base64,/, '');
  return { ok: true, base64, mime: 'image/png', type: 'viewport' };
}

async function cmdSnapshotFull({} = {}, tab) {
  if (!tab) return { ok: false, error: 'No active tab' };

  // Get page dimensions
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

    // Capture viewport
    await chrome.windows.update(tab.windowId, { focused: true }).catch(() => {});
    const dataUrl = await chrome.tabs.captureVisibleTab(tab.windowId, { format: 'png' });
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

function updateBadge(online) {
  chrome.action.setBadgeText({ text: online ? 'ON' : '' });
  chrome.action.setBadgeBackgroundColor({ color: online ? '#10b981' : '#6b7280' });
}

function broadcastStatus() {
  chrome.runtime.sendMessage({ type: 'fauna:status', connected }).catch(() => {});
}

// ── Push events (tab → Fauna) ─────────────────────────────────────────────

function pushEvent(eventType, data) {
  send({ type: 'event', event: eventType, data });
  // Also broadcast to the sidebar so it can update its activity feed
  chrome.runtime.sendMessage({ type: 'fauna:event', event: eventType, data }).catch(() => {});
}

chrome.tabs.onActivated.addListener(async ({ tabId }) => {
  if (!connected) return;
  const tab = await chrome.tabs.get(tabId).catch(() => null);
  if (!tab) return;
  pushEvent('tab:activated', { tabId, url: tab.url, title: tab.title });
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (!connected) return;
  if (changeInfo.status === 'complete') {
    pushEvent('page:loaded', { tabId, url: tab.url, title: tab.title });
  }
});

// ── Context menu ──────────────────────────────────────────────────────────

// Open the side panel when the toolbar icon is clicked
chrome.action.onClicked.addListener((tab) => {
  chrome.sidePanel.open({ windowId: tab.windowId }).catch(() => {});
});

chrome.runtime.onInstalled.addListener(() => {
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

chrome.runtime.onMessage.addListener((msg, _sender, reply) => {
  if (msg.type === 'get-status') {
    reply({ connected });
    return true;
  }
  if (msg.type === 'connect') {
    connect();
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
  return false;
});

// ── Service worker keepalive (alarms) ─────────────────────────────────────

chrome.alarms.create('fauna-keepalive', { periodInMinutes: 0.4 });
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === 'fauna-keepalive' && !connected) connect();
});

// ── Boot ──────────────────────────────────────────────────────────────────

connect();
