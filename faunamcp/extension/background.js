/**
 * FaunaBrowserMCP — background service worker
 *
 * Connects to the FaunaBrowserMCP relay at ws://localhost:3340
 * and routes MCP tool commands to the active tab's content script.
 *
 * Full sidebar experience:
 *   - Side panel opens on toolbar click / Ctrl+Shift+M
 *   - Context menus for Snapshot and Extract page
 *   - Activity feed broadcast to sidebar
 *   - Element picker relay
 *   - Alarms keepalive
 *   - Tab event listeners push events to sidebar
 */

const RELAY_WS_URL       = 'ws://localhost:3340';
const RECONNECT_BASE_MS  = 1500;
const RECONNECT_MAX_MS   = 30000;
const PING_INTERVAL_MS   = 20000;

// ── State ─────────────────────────────────────────────────────────────────

let ws             = null;
let reconnectTimer = null;
let reconnectDelay = RECONNECT_BASE_MS;
let pingTimer      = null;
let connected      = false;
let _activeTabId   = null;

// ── WebSocket lifecycle ───────────────────────────────────────────────────

function connect() {
  if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) return;
  clearTimeout(reconnectTimer);
  ws = new WebSocket(RELAY_WS_URL);

  ws.addEventListener('open', () => {
    connected     = true;
    reconnectDelay = RECONNECT_BASE_MS;
    updateBadge(true);
    sendHello();
    startPing();
    broadcastStatus();
  });

  ws.addEventListener('message', async (evt) => {
    let msg;
    try { msg = JSON.parse(evt.data); } catch { return; }
    await handleMessage(msg);
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
    // 'close' fires after error — handled there
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
    if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'ping' }));
  }, PING_INTERVAL_MS);
}
function stopPing() { clearInterval(pingTimer); pingTimer = null; }

function send(obj) {
  if (!ws || ws.readyState !== WebSocket.OPEN) return;
  ws.send(JSON.stringify(obj));
}

// ── Handshake ─────────────────────────────────────────────────────────────

async function sendHello() {
  let activeTab = null;
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (tab) activeTab = { id: tab.id, url: tab.url, title: tab.title };
  } catch (_) {}
  send({ type: 'ext:hello', version: chrome.runtime.getManifest().version, activeTab, userAgent: navigator.userAgent });
}

// ── Message handler ───────────────────────────────────────────────────────

async function handleMessage(msg) {
  const { type, id } = msg;
  if (type === 'pong') return;
  if (type === 'cmd') {
    let result;
    try   { result = await dispatch(msg); }
    catch (e) { result = { ok: false, error: e.message || String(e) }; }
    send({ ...result, type: 'result', id });
  }
}

// ── Command router ────────────────────────────────────────────────────────

async function dispatch(msg) {
  const { action, params = {}, tabId: targetId } = msg;

  let tab = null;
  if (targetId) tab = await chrome.tabs.get(targetId).catch(() => null);
  if (!tab) {
    const [t] = await chrome.tabs.query({ active: true, currentWindow: true });
    tab = t || null;
  }

  switch (action) {
    case 'tab:list':          return cmdTabList();
    case 'tab:new':           return cmdTabNew(params);
    case 'tab:switch':        return cmdTabSwitch(params);
    case 'tab:close':         return cmdTabClose(params, tab);
    case 'tab:info':          return cmdTabInfo(tab);
    case 'navigate':          return cmdNavigate(params, tab);
    case 'extract':           return cmdExtract(params, tab);
    case 'extract-forms':     return cmdExtractForms(params, tab);
    case 'extract-assets':    return cmdExtractAssets(params, tab);
    case 'devtools:console':  return cmdDevtoolsConsole(params, tab);
    case 'devtools:network':  return cmdDevtoolsNetwork(params, tab);
    case 'devtools:har':      return cmdDevtoolsHar(params, tab);
    case 'devtools:security': return cmdDevtoolsSecurity(params, tab);
    case 'devtools:cookies':  return cmdDevtoolsCookies(params, tab);
    case 'devtools:storage':  return cmdDevtoolsStorage(params, tab);
    case 'fill':              return cmdFill(params, tab);
    case 'click':             return cmdClick(params, tab);
    case 'scroll':            return cmdScroll(params, tab);
    case 'scroll-to':         return cmdScrollTo(params, tab);
    case 'get-dims':          return cmdGetDims(params, tab);
    case 'stitch-strips':     return cmdStitchStrips(params, tab);
    case 'eval':              return cmdEval(params, tab);
    case 'snapshot':          return cmdSnapshot(params, tab);
    case 'snapshot-full':     return cmdSnapshotFull(params, tab);
    case 'wait':              return cmdWait(params);
    case 'hover':             return cmdHover(params, tab);
    case 'select':            return cmdSelect(params, tab);
    case 'keyboard':          return cmdKeyboard(params, tab);
    case 'type':              return cmdType(params, tab);
    case 'drag':              return cmdDrag(params, tab);
    default: return { ok: false, error: 'Unknown action: ' + action };
  }
}

// ── Tab commands ──────────────────────────────────────────────────────────

async function cmdTabList() {
  const tabs = await chrome.tabs.query({});
  return { ok: true, tabs: tabs.map(t => ({ id: t.id, index: t.index, url: t.url, title: t.title, active: t.active, windowId: t.windowId })) };
}

async function cmdTabNew({ url } = {}) {
  const tab = await chrome.tabs.create({ url: url || 'about:blank', active: true });
  if (url) await waitForTabLoad(tab.id);
  return { ok: true, tabId: tab.id, url: tab.url };
}

async function cmdTabSwitch({ tabId, index } = {}) {
  let tab;
  if (tabId) tab = await chrome.tabs.get(tabId).catch(() => null);
  else if (typeof index === 'number') {
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
  return new Promise(resolve => {
    const deadline = setTimeout(resolve, timeoutMs);
    const listener = (id, info) => {
      if (id === tabId && info.status === 'complete') {
        clearTimeout(deadline);
        chrome.tabs.onUpdated.removeListener(listener);
        setTimeout(resolve, 600);
      }
    };
    chrome.tabs.onUpdated.addListener(listener);
  });
}

// ── Content script relay ──────────────────────────────────────────────────

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

async function cmdExtractAssets({} = {}, tab) {
  if (!tab) return { ok: false, error: 'No active tab' };
  let data;
  try {
    data = await msgTab(tab, { action: 'extract-assets' });
  } catch (_) {
    await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ['content.js'] });
    data = await msgTab(tab, { action: 'extract-assets' });
  }
  return { ok: true, ...data };
}

async function cmdGetDims({} = {}, tab) {
  if (!tab) return { ok: false, error: 'No active tab' };
  const data = await msgTab(tab, { action: 'get-dims' });
  return { ok: true, ...data };
}

async function cmdScrollTo({ y = 0 } = {}, tab) {
  if (!tab) return { ok: false, error: 'No active tab' };
  await msgTab(tab, { action: 'scroll-to', y });
  return { ok: true };
}

async function cmdStitchStrips(params, tab) {
  if (!tab) return { ok: false, error: 'No active tab' };
  const data = await msgTab(tab, { action: 'stitch-strips', ...params });
  return { ok: true, ...data };
}

// ── DevTools (CDP) ────────────────────────────────────────────────────────

async function _dbgSession(tabId, fn, timeoutMs = 15000) {
  const target = { tabId };
  let attached = false;
  try {
    try { await chrome.debugger.attach(target, '1.3'); attached = true; }
    catch (e) { if (!String(e.message).includes('already')) throw e; attached = true; }
    return await Promise.race([fn(target), new Promise((_, r) => setTimeout(() => r(new Error('Debugger timed out')), timeoutMs))]);
  } finally {
    if (attached) chrome.debugger.detach(target).catch(() => {});
  }
}

async function cmdDevtoolsConsole({ limit = 100 } = {}, tab) {
  if (!tab) return { ok: false, error: 'No active tab' };
  return _dbgSession(tab.id, async (target) => {
    await chrome.debugger.sendCommand(target, 'Runtime.enable', {});
    await chrome.debugger.sendCommand(target, 'Log.enable', {});
    const r = await chrome.debugger.sendCommand(target, 'Runtime.evaluate', {
      expression: `(function(){if(!window.__faunaBuf__){window.__faunaBuf__=[];var o={log:console.log,warn:console.warn,error:console.error,info:console.info,debug:console.debug};['log','warn','error','info','debug'].forEach(function(l){console[l]=function(){window.__faunaBuf__.push({level:l,args:Array.from(arguments).map(function(a){try{return JSON.stringify(a);}catch(e){return String(a);}}),ts:Date.now()});if(window.__faunaBuf__.length>500)window.__faunaBuf__.shift();o[l].apply(console,arguments);};});}return JSON.stringify(window.__faunaBuf__.slice(-${Math.min(limit,500)}));})()`,
      returnByValue: true
    });
    const entries = JSON.parse(r?.result?.value || '[]');
    return { ok: true, entries, count: entries.length, url: tab.url };
  });
}

async function cmdDevtoolsNetwork({ filter } = {}, tab) {
  if (!tab) return { ok: false, error: 'No active tab' };
  return _dbgSession(tab.id, async (target) => {
    await chrome.debugger.sendCommand(target, 'Network.enable', {});
    const pr = await chrome.debugger.sendCommand(target, 'Runtime.evaluate', {
      expression: `JSON.stringify(performance.getEntriesByType('resource').slice(0,200).map(function(e){return{name:e.name,type:e.initiatorType,transferSize:e.transferSize,duration:Math.round(e.duration),startTime:Math.round(e.startTime)};}))`,
      returnByValue: true
    });
    let resources = JSON.parse(pr?.result?.value || '[]');
    if (filter) resources = resources.filter(r => r.name.includes(filter));
    return { ok: true, resources, count: resources.length, url: tab.url };
  });
}

async function cmdDevtoolsHar({} = {}, tab) {
  if (!tab) return { ok: false, error: 'No active tab' };
  return _dbgSession(tab.id, async (target) => {
    await chrome.debugger.sendCommand(target, 'Network.enable', {});
    const result = await chrome.debugger.sendCommand(target, 'Runtime.evaluate', {
      expression: `JSON.stringify((function(){var entries=performance.getEntriesByType('resource').slice(0,500);var nav=performance.getEntriesByType('navigation')[0];var all=nav?[{name:location.href,initiatorType:'navigation',transferSize:nav.transferSize||0,duration:nav.duration,startTime:0,decodedBodySize:nav.decodedBodySize||0,encodedBodySize:nav.encodedBodySize||0}].concat(entries):entries;return{log:{version:'1.2',creator:{name:'FaunaBrowserMCP',version:'1.0'},pages:[{startedDateTime:new Date(performance.timeOrigin).toISOString(),id:'page_1',title:document.title,pageTimings:{}}],entries:all.map(function(e){return{startedDateTime:new Date(performance.timeOrigin+e.startTime).toISOString(),time:Math.round(e.duration),request:{method:'GET',url:e.name,httpVersion:'h2',headers:[],queryString:[],cookies:[],headersSize:-1,bodySize:0},response:{status:0,statusText:'',httpVersion:'h2',headers:[],cookies:[],content:{size:e.decodedBodySize||0,mimeType:''},redirectURL:'',headersSize:-1,bodySize:e.encodedBodySize||e.transferSize||0},cache:{},timings:{send:0,wait:Math.round(e.duration*.6),receive:Math.round(e.duration*.4)},pageref:'page_1'};})}};})()\``,
      returnByValue: true
    });
    const har = JSON.parse(result?.result?.value || 'null');
    return { ok: true, har, entryCount: har?.log?.entries?.length || 0, url: tab.url };
  });
}

async function cmdDevtoolsSecurity({} = {}, tab) {
  if (!tab) return { ok: false, error: 'No active tab' };
  return _dbgSession(tab.id, async (target) => {
    await chrome.debugger.sendCommand(target, 'Network.enable', {});
    await chrome.debugger.sendCommand(target, 'Security.enable', {});
    const state = await chrome.debugger.sendCommand(target, 'Security.getSecurityState', {}).catch(() => null);
    const r = await chrome.debugger.sendCommand(target, 'Runtime.evaluate', {
      expression: `JSON.stringify((function(){var metas=Array.from(document.querySelectorAll('meta[http-equiv]')).map(function(m){return{httpEquiv:m.httpEquiv,content:m.content};});var isHttps=location.protocol==='https:';var mixedContent=Array.from(document.querySelectorAll('[src],[href]')).filter(function(e){var u=(e.src||e.href||'');return isHttps&&u.startsWith('http:');}).slice(0,20).map(function(e){return{tag:e.tagName,url:(e.src||e.href)};});var cookies=document.cookie.split(';').filter(Boolean).map(function(c){return c.trim().split('=')[0];});return{protocol:location.protocol,host:location.host,metaHeaders:metas,mixedContent:mixedContent,visibleCookieNames:cookies.slice(0,30)};})())`,
      returnByValue: true
    });
    const pageInfo = JSON.parse(r?.result?.value || '{}');
    return { ok: true, securityState: state, ...pageInfo, url: tab.url };
  });
}

async function cmdDevtoolsCookies({} = {}, tab) {
  if (!tab) return { ok: false, error: 'No active tab' };
  return _dbgSession(tab.id, async (target) => {
    await chrome.debugger.sendCommand(target, 'Network.enable', {});
    const result = await chrome.debugger.sendCommand(target, 'Network.getCookies', { urls: [tab.url] });
    return { ok: true, cookies: result.cookies, count: result.cookies.length, url: tab.url };
  });
}

async function cmdDevtoolsStorage({} = {}, tab) {
  if (!tab) return { ok: false, error: 'No active tab' };
  return _dbgSession(tab.id, async (target) => {
    const result = await chrome.debugger.sendCommand(target, 'Runtime.evaluate', {
      expression: `JSON.stringify((function(){var ls={},ss={};try{for(var i=0;i<localStorage.length;i++){var k=localStorage.key(i);ls[k]=localStorage.getItem(k).slice(0,500);}}catch(e){}try{for(var i=0;i<sessionStorage.length;i++){var k=sessionStorage.key(i);ss[k]=sessionStorage.getItem(k).slice(0,500);}}catch(e){}return{localStorage:ls,sessionStorage:ss,localStorageCount:Object.keys(ls).length,sessionStorageCount:Object.keys(ss).length};})())`,
      returnByValue: true, awaitPromise: true
    });
    const storage = JSON.parse(result?.result?.value || '{}');
    return { ok: true, ...storage, url: tab.url };
  });
}

// ── Interaction ───────────────────────────────────────────────────────────

async function cmdFill({ fields = [], selector, value } = {}, tab) {
  if (!tab) return { ok: false, error: 'No active tab' };
  const batch = fields.length ? fields : (selector ? [{ selector, value }] : []);
  if (!batch.length) return { ok: false, error: 'fields or selector+value required' };
  const result = await msgTab(tab, { action: 'fill', fields: batch });
  return { ok: true, ...result };
}

async function cmdClick(params, tab) {
  if (!tab) return { ok: false, error: 'No active tab' };
  const result = await msgTab(tab, { action: 'click', ...params });
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

async function cmdType({ selector, text, delay, pressEnter } = {}, tab) {
  if (!tab) return { ok: false, error: 'No active tab' };
  const result = await msgTab(tab, { action: 'type', selector, text, delay, pressEnter });
  return { ok: true, ...result };
}

async function cmdDrag(params, tab) {
  if (!tab) return { ok: false, error: 'No active tab' };
  const result = await msgTab(tab, { action: 'drag', ...params });
  return { ok: true, ...result };
}

async function cmdEval({ js } = {}, tab) {
  if (!tab) return { ok: false, error: 'No active tab' };
  if (!js) return { ok: false, error: 'js required' };
  const target = { tabId: tab.id };
  let attached = false;
  try {
    try { await chrome.debugger.attach(target, '1.3'); attached = true; }
    catch (e) { if (!String(e.message).includes('already')) throw e; attached = true; }
    const r = await chrome.debugger.sendCommand(target, 'Runtime.evaluate', {
      expression: js, returnByValue: true, awaitPromise: true, userGesture: true
    });
    if (r.exceptionDetails) return { ok: true, result: 'ERROR: ' + (r.exceptionDetails.exception?.description || r.exceptionDetails.text) };
    const val = r.result?.value;
    return { ok: true, result: val === undefined ? '(undefined)' : String(val) };
  } catch (err) {
    return { ok: false, error: err.message };
  } finally {
    if (attached) chrome.debugger.detach(target).catch(() => {});
  }
}

async function cmdWait({ ms = 1000 } = {}) {
  await new Promise(r => setTimeout(r, Math.min(ms, 15000)));
  return { ok: true };
}

// ── Screenshots ───────────────────────────────────────────────────────────

async function captureViaDebugger(tabId, timeoutMs = 4000) {
  const target = { tabId };
  let attached = false;
  try {
    try { await chrome.debugger.attach(target, '1.3'); attached = true; }
    catch (e) { if (!String(e.message).includes('already')) throw e; attached = true; }
    const result = await Promise.race([
      chrome.debugger.sendCommand(target, 'Page.captureScreenshot', { format: 'jpeg', quality: 75 }),
      new Promise((_, r) => setTimeout(() => r(new Error('captureScreenshot timed out')), timeoutMs))
    ]);
    return result.data;
  } finally {
    if (attached) chrome.debugger.detach(target).catch(() => {});
  }
}

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
  } catch (_) { return base64png; }
}

async function cmdSnapshot({} = {}, tab) {
  if (!tab) return { ok: false, error: 'No active tab' };
  const errors = [];

  try {
    const base64 = await captureViaDebugger(tab.id);
    if (base64) return { ok: true, base64, mime: 'image/jpeg', type: 'viewport', method: 'debugger' };
  } catch (e) { errors.push('debugger: ' + e.message); }

  try {
    const dataUrl = await Promise.race([
      chrome.tabs.captureVisibleTab(tab.windowId, { format: 'png' }),
      new Promise((_, r) => setTimeout(() => r(new Error('timeout')), 2000))
    ]);
    const base64 = await compressToJpeg(dataUrl.replace(/^data:image\/png;base64,/, ''));
    return { ok: true, base64, mime: 'image/jpeg', type: 'viewport', method: 'captureVisibleTab' };
  } catch (e) { errors.push('capture: ' + e.message); }

  try {
    await chrome.tabs.update(tab.id, { active: true }).catch(() => {});
    await chrome.windows.update(tab.windowId, { focused: true }).catch(() => {});
    await new Promise(r => setTimeout(r, 300));
    const dataUrl = await Promise.race([
      chrome.tabs.captureVisibleTab(tab.windowId, { format: 'png' }),
      new Promise((_, r) => setTimeout(() => r(new Error('timeout')), 2000))
    ]);
    const base64 = await compressToJpeg(dataUrl.replace(/^data:image\/png;base64,/, ''));
    return { ok: true, base64, mime: 'image/jpeg', type: 'viewport', method: 'captureVisibleTab-focused' };
  } catch (e) { errors.push('focused: ' + e.message); }

  return { ok: false, error: 'All snapshot methods failed: ' + errors.join('; ') };
}

async function cmdSnapshotFull({} = {}, tab) {
  if (!tab) return { ok: false, error: 'No active tab' };
  let dims;
  try { dims = await msgTab(tab, { action: 'get-dims' }); }
  catch (_) { return cmdSnapshot({}, tab); }

  const { scrollHeight, viewportHeight } = dims;
  if (scrollHeight <= viewportHeight * 1.5) return cmdSnapshot({}, tab);

  const strips = [];
  let scrollY = 0;
  while (scrollY < scrollHeight) {
    await msgTab(tab, { action: 'scroll-to', y: scrollY });
    await new Promise(r => setTimeout(r, 200));
    let dataUrl;
    try {
      const b64 = await captureViaDebugger(tab.id);
      dataUrl = 'data:image/jpeg;base64,' + b64;
    } catch (_) {
      await chrome.windows.update(tab.windowId, { focused: true }).catch(() => {});
      dataUrl = await chrome.tabs.captureVisibleTab(tab.windowId, { format: 'png' });
    }
    strips.push({ dataUrl, scrollY, height: Math.min(viewportHeight, scrollHeight - scrollY) });
    scrollY += viewportHeight;
  }
  await msgTab(tab, { action: 'scroll-to', y: 0 });
  const stitched = await msgTab(tab, { action: 'stitch-strips', strips, totalHeight: scrollHeight, viewportHeight });
  if (stitched?.base64) return { ok: true, base64: stitched.base64, mime: 'image/png', type: 'full-page', height: scrollHeight };
  const fb = strips[0]?.dataUrl?.replace(/^data:image\/png;base64,/, '') || '';
  return { ok: true, base64: fb, mime: 'image/png', type: 'viewport-fallback' };
}

// ── Badge ─────────────────────────────────────────────────────────────────

function updateBadge(online) {
  chrome.action.setBadgeText({ text: online ? 'ON' : '' });
  chrome.action.setBadgeBackgroundColor({ color: online ? '#10b981' : '#6b7280' });
  chrome.action.setBadgeTextColor({ color: '#ffffff' });
}

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
  chrome.action.setBadgeText({ text: connected ? 'ON' : '', tabId });
  chrome.action.setBadgeBackgroundColor({ color: connected ? '#10b981' : '#6b7280', tabId });
  if (_activeTabId === tabId) _activeTabId = null;
}

function broadcastStatus() {
  chrome.runtime.sendMessage({ type: 'fauna:status', connected }).catch(() => {});
}

// ── Push events to sidebar ────────────────────────────────────────────────

function pushEvent(eventType, data) {
  chrome.runtime.sendMessage({ type: 'fauna:event', event: eventType, data }).catch(() => {});
}

// ── Notifications ─────────────────────────────────────────────────────────

function showNotification(id, title, message, iconUrl) {
  chrome.notifications.create('faunamcp-' + (id || Date.now()), {
    type: 'basic',
    iconUrl: iconUrl || chrome.runtime.getURL('icons/icon48.png'),
    title: title || 'FaunaBrowserMCP',
    message: message || '',
    silent: false
  });
}

// ── Tab event listeners ───────────────────────────────────────────────────

chrome.tabs.onActivated.addListener(async ({ tabId }) => {
  const tab = await chrome.tabs.get(tabId).catch(() => null);
  if (!tab) return;
  pushEvent('tab:activated', { tabId, url: tab.url, title: tab.title });
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (changeInfo.status === 'complete') {
    pushEvent('page:loaded', { tabId, url: tab.url, title: tab.title });
  }
});

// ── Sidebar: open on toolbar click ────────────────────────────────────────

chrome.action.onClicked.addListener((tab) => {
  chrome.sidePanel.open({ windowId: tab.windowId }).catch(() => {});
});

// ── Keyboard shortcut ─────────────────────────────────────────────────────

chrome.commands.onCommand.addListener(async (command) => {
  if (command === 'toggle-sidebar') {
    const wins = await chrome.windows.getAll({ windowTypes: ['normal'] }).catch(() => []);
    const win = wins.find(w => w.focused) || null;
    if (win) chrome.sidePanel.open({ windowId: win.id }).catch(() => {});
  }
});

// ── Context menus ─────────────────────────────────────────────────────────

chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.create({
    id: 'mcp-extract-page',
    title: 'Extract page (MCP)',
    contexts: ['page', 'frame']
  });
  chrome.contextMenus.create({
    id: 'mcp-snapshot',
    title: 'Snapshot page (MCP)',
    contexts: ['page', 'frame']
  });
  connect();
});

chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  if (info.menuItemId === 'mcp-extract-page' && tab) {
    const data = await cmdExtract({}, tab).catch(e => ({ ok: false, error: e.message }));
    pushEvent('user:extract-page', { tabId: tab.id, url: tab.url, title: tab.title, ...data });
  } else if (info.menuItemId === 'mcp-snapshot' && tab) {
    const snap = await cmdSnapshot({}, tab).catch(e => ({ ok: false, error: e.message }));
    pushEvent('user:snapshot', { tabId: tab.id, url: tab.url, title: tab.title, ...snap });
  }
});

// ── Service worker keepalive (alarms) ─────────────────────────────────────

chrome.alarms.create('mcp-keepalive', { periodInMinutes: 0.4 });
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === 'mcp-keepalive' && !connected) connect();
});

// ── Extension message bus (sidebar / popup → background) ─────────────────

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
  if (msg.type === 'snapshot-to-mcp') {
    chrome.tabs.query({ active: true, currentWindow: true }, async ([tab]) => {
      if (!tab) return;
      const snap = await cmdSnapshot({}, tab).catch(e => ({ ok: false, error: e.message }));
      pushEvent('user:snapshot', { tabId: tab.id, url: tab.url, title: tab.title, ...snap });
    });
    reply({ ok: true });
    return true;
  }
  if (msg.type === 'extract-page') {
    chrome.tabs.query({ active: true, currentWindow: true }, async ([tab]) => {
      if (!tab) return;
      const data = await cmdExtract({}, tab).catch(e => ({ ok: false, error: e.message }));
      pushEvent('user:extract-page', { tabId: tab.id, url: tab.url, title: tab.title, ...data });
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
  // Picker result relayed from content script → forward to sidebar
  if (msg.type === 'picker:selected') {
    chrome.runtime.sendMessage({ type: 'fauna:picker-selected', data: msg.data }).catch(() => {});
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

// ── Bootstrap ─────────────────────────────────────────────────────────────

connect();
