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

// ── DevTools helpers — all use chrome.debugger CDP ────────────────────────

async function _debuggerSession(tabId, fn, timeoutMs = 15000) {
  const target = { tabId };
  let attached = false;
  try {
    try { await chrome.debugger.attach(target, '1.3'); attached = true; }
    catch (e) { if (!String(e.message).includes('already')) throw e; attached = true; }
    return await Promise.race([
      fn(target),
      new Promise((_, rej) => setTimeout(() => rej(new Error('DevTools session timed out')), timeoutMs)),
    ]);
  } finally {
    if (attached) chrome.debugger.detach(target).catch(() => {});
  }
}

// Capture console messages by injecting a Runtime listener, loading the page,
// then reading buffered entries via Log.enable + Runtime.getProperties trick.
// Simplest reliable approach: evaluate a log-capture shim and read it back.
async function cmdDevtoolsConsole({ limit = 100 } = {}, tab) {
  if (!tab) return { ok: false, error: 'No active tab' };
  return await _debuggerSession(tab.id, async (target) => {
    await chrome.debugger.sendCommand(target, 'Runtime.enable', {});
    // Read existing console entries via Log domain
    await chrome.debugger.sendCommand(target, 'Log.enable', {});
    // Inject a shim to collect future + past entries via console override
    const shimResult = await chrome.debugger.sendCommand(target, 'Runtime.evaluate', {
      expression: `(function(){
        if (!window.__faunaConsoleBuf__) {
          window.__faunaConsoleBuf__ = [];
          var _orig = {log:console.log,warn:console.warn,error:console.error,info:console.info,debug:console.debug};
          ['log','warn','error','info','debug'].forEach(function(l){
            console[l] = function(){
              window.__faunaConsoleBuf__.push({level:l, args:Array.from(arguments).map(function(a){try{return JSON.stringify(a);}catch(e){return String(a);}}), ts:Date.now()});
              if(window.__faunaConsoleBuf__.length > 500) window.__faunaConsoleBuf__.shift();
              _orig[l].apply(console,arguments);
            };
          });
        }
        return JSON.stringify(window.__faunaConsoleBuf__.slice(-${Math.min(limit,500)}));
      })()`,
      returnByValue: true, awaitPromise: false,
    });
    const entries = JSON.parse(shimResult?.result?.value || '[]');
    return { ok: true, entries, count: entries.length, url: tab.url };
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
  // the extension's own MV3 CSP that blocks new Function() / eval in content scripts.
  const target = { tabId: tab.id };
  let attached = false;
  try {
    try {
      await chrome.debugger.attach(target, '1.3');
      attached = true;
    } catch (e) {
      if (!String(e.message).includes('already')) throw e;
      attached = true;
    }
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

// ── chrome.debugger screenshot (focus-independent) ──────────────────────
// Uses the DevTools Protocol to capture a JPEG regardless of which app has
// OS focus.  Attaches, captures, detaches.  Chrome shows a brief infobar
// during the capture but it is the only reliable headless-friendly method.
async function captureViaDebugger(tabId, timeoutMs = 3000) {
  const target = { tabId };
  let attached = false;
  try {
    await Promise.race([
      chrome.debugger.attach(target, '1.3').then(() => { attached = true; }),
      new Promise((_, rej) => setTimeout(() => rej(new Error('debugger attach timed out')), timeoutMs))
    ]);
  } catch (attachErr) {
    // Already attached by another caller — proceed anyway
    if (!String(attachErr.message).includes('already')) throw attachErr;
    attached = true;
  }
  try {
    const result = await Promise.race([
      chrome.debugger.sendCommand(target, 'Page.captureScreenshot', { format: 'jpeg', quality: 75 }),
      new Promise((_, rej) => setTimeout(() => rej(new Error('debugger captureScreenshot timed out')), timeoutMs))
    ]);
    return result.data; // base64 JPEG
  } finally {
    if (attached) chrome.debugger.detach(target).catch(() => {});
  }
}

async function cmdSnapshot({} = {}, tab) {
  if (!tab) return { ok: false, error: 'No active tab' };
  const errors = [];

  // Helper: captureVisibleTab with hard timeout — hangs when OS focus is elsewhere
  function captureWithTimeout(windowId, timeoutMs) {
    return Promise.race([
      chrome.tabs.captureVisibleTab(windowId, { format: 'png' }),
      new Promise((_, rej) =>
        setTimeout(() => rej(new Error('captureVisibleTab timed out')), timeoutMs)
      )
    ]);
  }

  console.log('[Fauna] cmdSnapshot starting for tab', tab.id, tab.url);

  // Attempt 1: chrome.debugger DevTools Protocol — most reliable, works without OS focus
  // 3s attach + 3s capture = 6s max
  try {
    const base64 = await captureViaDebugger(tab.id, 3000);
    if (base64) {
      console.log('[Fauna] cmdSnapshot succeeded via debugger');
      return { ok: true, base64, mime: 'image/jpeg', type: 'viewport', method: 'debugger' };
    }
  } catch (e) {
    console.log('[Fauna] debugger attempt failed:', e.message);
    errors.push('debugger: ' + e.message);
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
  chrome.runtime.sendMessage({ type: 'fauna:status', connected }).catch(() => {});
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

// Keyboard shortcut — Ctrl+Shift+F / MacCtrl+Shift+F — toggle sidebar
chrome.commands.onCommand.addListener(async (command) => {
  if (command === 'toggle-sidebar') {
    const [win] = await chrome.windows.getAll({ windowTypes: ['normal'] }).then(ws => ws.filter(w => w.focused)).catch(() => [null]);
    if (win) chrome.sidePanel.open({ windowId: win.id }).catch(() => {});
  }
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

// ── Service worker keepalive (alarms) ─────────────────────────────────────

chrome.alarms.create('fauna-keepalive', { periodInMinutes: 0.4 });
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === 'fauna-keepalive' && !connected) connect();
});

// ── Boot ──────────────────────────────────────────────────────────────────

connect();
