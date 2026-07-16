// ── Browser Pane — per-conversation multi-tab ────────────────────────────

var _browserTabsByConv = {};  // convId → { tabs: [{id, title, url, wv}], activeTabId }
var _tabIdCounter = 0;
var _domReadyWebviews = new WeakSet(); // tracks webviews that have fired dom-ready
var _browserUA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36';

// Electron-only feature gate. `<webview>` and its .loadURL/.reload/.goBack
// methods only exist when this page is rendered by an Electron BrowserWindow
// with `webviewTag: true` in webPreferences. When the user opens Fauna in a
// plain Chrome/Safari tab pointed at http://localhost:3737, <webview>
// collapses to HTMLUnknownElement and every method call throws. Detect once
// and gate the public API — the rest of the file already null-checks the
// return value of getActiveWebview(), so making it return null is sufficient
// to defuse navigate/back/forward/refresh.
var _isElectronRenderer = (function() {
  try {
    return !!(typeof window !== 'undefined' &&
              window.process &&
              window.process.versions &&
              window.process.versions.electron);
  } catch (_) { return false; }
})();

var _shownNonElectronNotice = false;
function _noticeBrowserUnavailable(reason) {
  if (_shownNonElectronNotice) return;
  _shownNonElectronNotice = true;
  var msg = reason || 'The in-app browser only works in the Fauna desktop app. Open this URL from Fauna.app instead of a regular browser tab.';
  try { if (typeof _showToast === 'function') _showToast(msg, true); } catch (_) {}
  // Also surface inline in the browser status pill if it's mounted, so the
  // user sees why navigation is silent even with the toast dismissed.
  try {
    var status = document.getElementById('browser-status');
    if (status) status.textContent = msg;
  } catch (_) {}
  console.warn('[browser-pane]', msg);
}

function _getConvBrowser(convId) {
  var cid = convId || state.currentId;
  if (!cid) return null;
  if (!_browserTabsByConv[cid]) _browserTabsByConv[cid] = { tabs: [], activeTabId: null };
  return _browserTabsByConv[cid];
}

function _getConvTabs(convId) {
  var b = _getConvBrowser(convId);
  return b ? b.tabs : [];
}

function _getConvActiveTabId(convId) {
  var b = _getConvBrowser(convId);
  return b ? b.activeTabId : null;
}

function _setConvActiveTabId(tabId, convId) {
  var b = _getConvBrowser(convId);
  if (b) b.activeTabId = tabId;
}

function getActiveWebview(convId) {
  // Non-Electron renderer — <webview> tag has no Electron methods, so callers
  // (browserNavigateTo, browserRefresh, etc.) all bail on the null return
  // and the user gets a one-time toast explaining why instead of a cascade
  // of "wv.loadURL is not a function" exceptions.
  if (!_isElectronRenderer) {
    _noticeBrowserUnavailable();
    return null;
  }
  var tabs = _getConvTabs(convId);
  var activeId = _getConvActiveTabId(convId);
  var tab = tabs.find(function(t) { return t.id === activeId; });
  return tab ? tab.wv : null;
}

function _renderTabBar() {
  var bar = document.getElementById('browser-tab-bar');
  if (!bar) return;
  var addBtn = document.getElementById('browser-tab-add');
  bar.querySelectorAll('.browser-tab').forEach(function(el) { el.remove(); });
  var tabs = _getConvTabs();
  var activeId = _getConvActiveTabId();
  tabs.forEach(function(tab) {
    var btn = document.createElement('button');
    btn.className = 'browser-tab' + (tab.id === activeId ? ' active' : '');
    btn.dataset.tabId = tab.id;
    var label = tab.title || 'New Tab';
    btn.innerHTML = '<span class="tab-label">' + escHtml(label) + '</span>' +
      '<span class="tab-close" title="Close tab">&times;</span>';
    btn.addEventListener('click', function(e) {
      if (e.target.closest('.tab-close')) { browserCloseTab(tab.id); return; }
      browserSwitchTab(tab.id);
    });
    bar.insertBefore(btn, addBtn);
  });
}

function _initWebviewEvents(wv, tabId, convId) {
  wv.addEventListener('dom-ready', function() {
    _domReadyWebviews.add(wv);
  });
  wv.addEventListener('did-start-loading', function() {
    _domReadyWebviews.delete(wv);
    if (_getConvActiveTabId() !== tabId || state.currentId !== convId) return;
    document.getElementById('browser-loading-bar').classList.add('loading');
    document.getElementById('browser-status').textContent = 'Loading…';
    document.getElementById('antibot-banner').style.display = 'none';
  });
  wv.addEventListener('did-stop-loading', function() {
    if (_getConvActiveTabId() !== tabId || state.currentId !== convId) return;
    document.getElementById('browser-loading-bar').classList.remove('loading');
    document.getElementById('browser-status').textContent = '';
    _checkAntibotChallenge();
    document.getElementById('bp-back').disabled = !wv.canGoBack();
    document.getElementById('bp-fwd').disabled  = !wv.canGoForward();
  });
  wv.addEventListener('did-navigate', function(e) {
    var tabs = _getConvTabs(convId);
    var tab = tabs.find(function(t) { return t.id === tabId; });
    if (tab) tab.url = e.url;
    if (_getConvActiveTabId() === tabId && state.currentId === convId)
      document.getElementById('browser-url-input').value = e.url;
  });
  wv.addEventListener('did-navigate-in-page', function(e) {
    if (e.isMainFrame) {
      var tabs = _getConvTabs(convId);
      var tab = tabs.find(function(t) { return t.id === tabId; });
      if (tab) tab.url = e.url;
      if (_getConvActiveTabId() === tabId && state.currentId === convId)
        document.getElementById('browser-url-input').value = e.url;
    }
  });
  wv.addEventListener('page-title-updated', function(e) {
    var tabs = _getConvTabs(convId);
    var tab = tabs.find(function(t) { return t.id === tabId; });
    if (tab) { tab.title = e.title; if (state.currentId === convId) _renderTabBar(); }
    if (_getConvActiveTabId() === tabId && state.currentId === convId)
      document.getElementById('browser-page-title').textContent = e.title;
  });
  wv.addEventListener('did-fail-load', function(e) {
    if (e.errorCode === -3) return;
    if (_getConvActiveTabId() === tabId && state.currentId === convId) {
      document.getElementById('browser-status').textContent = 'Failed: ' + e.errorDescription;
      document.getElementById('browser-loading-bar').classList.remove('loading');
    }
  });
}

function browserAddTab(url, convId) {
  var cid = convId || state.currentId;
  if (!cid) return null;
  var b = _getConvBrowser(cid);
  var tabId = 'btab-' + (++_tabIdCounter);
  var wrap = document.getElementById('browser-webview-wrap');
  var wv = document.createElement('webview');
  wv.id = tabId;
  wv.src = 'about:blank';
  wv.setAttribute('allowpopups', '');
  wv.setAttribute('partition', 'persist:browser');
  wv.setAttribute('useragent', _browserUA);
  wv.style.cssText = 'flex:1 1 0;min-height:0;width:100%;border:none;display:none;will-change:transform;';
  wrap.appendChild(wv);
  var tab = { id: tabId, title: 'New Tab', url: '', wv: wv, convId: cid, consoleLogs: [] };
  b.tabs.push(tab);
  _initWebviewEvents(wv, tabId, cid);
  // Capture console messages from the webview (last 150 entries)
  wv.addEventListener('console-message', function(e) {
    var levelMap = {0:'debug',1:'log',2:'warn',3:'error'};
    var entry = { level: levelMap[e.level]||'log', text: (e.message||'').slice(0, 2000), line: e.line, source: e.sourceId||'' };
    tab.consoleLogs.push(entry);
    if (tab.consoleLogs.length > 150) tab.consoleLogs.shift();
  });
  // Inject a window.onerror + unhandledrejection shim on every navigation so
  // uncaught native exceptions (which DON'T flow through console-message)
  // are still captured into tab.consoleLogs via console.error.
  var _injectErrorShim = function() {
    try {
      wv.executeJavaScript(
        '(function(){' +
          'if (window.__faunaErrShim__) return;' +
          'window.__faunaErrShim__ = true;' +
          'window.addEventListener("error", function(ev){' +
            'try { console.error("[uncaught] " + ((ev.error && (ev.error.stack || ev.error.message)) || ev.message || "Error") + (ev.filename ? " @ " + ev.filename + ":" + ev.lineno + ":" + ev.colno : "")); } catch(_){ }' +
          '}, true);' +
          'window.addEventListener("unhandledrejection", function(ev){' +
            'var r = ev.reason;' +
            'try { console.error("[unhandledrejection] " + ((r && (r.stack || r.message)) || (typeof r === "string" ? r : JSON.stringify(r)) || "Unhandled rejection")); } catch(_){ }' +
          '}, true);' +
        '})();',
        false
      ).catch(function() {});
    } catch (_) {}
  };
  wv.addEventListener('dom-ready', _injectErrorShim);
  wv.addEventListener('did-navigate', _injectErrorShim);
  wv.addEventListener('did-navigate-in-page', _injectErrorShim);
  if (state.currentId === cid) browserSwitchTab(tabId, cid);
  else { b.activeTabId = tabId; wv.style.display = 'none'; }
  if (url) {
    // Accept http(s)://, file://, about:, data:; anything else gets https:// prepended.
    if (!/^(https?:|file:|about:|data:)/i.test(url)) url = 'https://' + url;
    tab.url = url;
    // Wait for dom-ready before loadURL — calling it before dom-ready throws
    _waitForDomReady(wv).then(function() { wv.loadURL(url).catch(function() {}); });
  }
  return tabId;
}

function browserCloseTab(tabId, convId) {
  var cid = convId || state.currentId;
  var b = _getConvBrowser(cid);
  if (!b) return;
  var idx = b.tabs.findIndex(function(t) { return t.id === tabId; });
  if (idx === -1) return;
  var tab = b.tabs[idx];
  tab.wv.remove();
  b.tabs.splice(idx, 1);
  if (b.tabs.length === 0) {
    b.activeTabId = null;
    if (state.currentId === cid) { closeBrowserPane(); _renderTabBar(); }
    return;
  }
  if (b.activeTabId === tabId) {
    var newIdx = Math.min(idx, b.tabs.length - 1);
    if (state.currentId === cid) browserSwitchTab(b.tabs[newIdx].id, cid);
    else b.activeTabId = b.tabs[newIdx].id;
  } else if (state.currentId === cid) {
    _renderTabBar();
  }
}

function _isLocalBrowserTaskUrl(url) {
  return /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?/i.test(url || '');
}

function _isDisposableBrowserActionSequence(widgets) {
  if (!Array.isArray(widgets) || !widgets.length) return false;
  var sawNavigate = false;
  var allowed = { navigate: true, extract: true, wait: true, eval: true };
  return widgets.every(function(w) {
    var action = w && w.action;
    if (!action || !allowed[action.action]) return false;
    if (action.keepOpen || action.autoClose === false) return false;
    if (action.action === 'navigate') {
      sawNavigate = true;
      if (_isLocalBrowserTaskUrl(action.url)) return false;
    }
    if (action.action === 'wait' && action.ms > 5000) return false;
    return true;
  }) && sawNavigate;
}

function _closeDisposableBrowserTabIfUnused(convId, initialTabIds) {
  var initial = initialTabIds || [];
  if (initial.length > 0) return;
  var tabs = _getConvTabs(convId);
  if (tabs.length !== 1) return;
  var tab = tabs[0];
  if (!tab) return;
  browserCloseTab(tab.id, convId);
}

function browserSwitchTab(tabId, convId) {
  var cid = convId || state.currentId;
  var b = _getConvBrowser(cid);
  if (!b) return;
  b.activeTabId = tabId;
  // Only show/hide webviews if this is the current conversation
  if (state.currentId === cid) {
    b.tabs.forEach(function(t) {
      t.wv.style.display = (t.id === tabId) ? 'flex' : 'none';
    });
    var tab = b.tabs.find(function(t) { return t.id === tabId; });
    if (tab) {
      document.getElementById('browser-url-input').value = tab.url || '';
      document.getElementById('browser-page-title').textContent = tab.title || '';
      tab.wv.style.opacity = '0.9999';
      requestAnimationFrame(function() { tab.wv.style.opacity = ''; });
      try {
        document.getElementById('bp-back').disabled = !tab.wv.canGoBack();
        document.getElementById('bp-fwd').disabled  = !tab.wv.canGoForward();
      } catch(_) {}
    }
    _renderTabBar();
  }
}

// Show/hide webviews when switching conversations
function _showConvBrowserTabs(convId) {
  // Hide ALL webviews across all conversations
  Object.keys(_browserTabsByConv).forEach(function(cid) {
    _browserTabsByConv[cid].tabs.forEach(function(t) { t.wv.style.display = 'none'; });
  });
  // Show the target conversation's active tab
  var b = _browserTabsByConv[convId];
  if (b && b.tabs.length > 0) {
    var activeTab = b.tabs.find(function(t) { return t.id === b.activeTabId; }) || b.tabs[0];
    if (activeTab) activeTab.wv.style.display = 'flex';
    // Open browser pane if conv has tabs
    var pane = document.getElementById('browser-pane');
    if (pane) { pane.classList.add('open'); _restoreBrowserPaneWidth(); }
  } else {
    // No tabs for this conv — close pane
    closeBrowserPane();
  }
  _renderTabBar();
  // Update URL bar etc.
  if (b && b.activeTabId) {
    var tab = b.tabs.find(function(t) { return t.id === b.activeTabId; });
    if (tab) {
      document.getElementById('browser-url-input').value = tab.url || '';
      document.getElementById('browser-page-title').textContent = tab.title || '';
    }
  }
}

// Clean up webviews when a conversation is deleted
function _destroyConvBrowserTabs(convId) {
  var b = _browserTabsByConv[convId];
  if (!b) return;
  b.tabs.forEach(function(t) { t.wv.remove(); });
  delete _browserTabsByConv[convId];
}

function _ensureBrowserTab(convId) {
  var tabs = _getConvTabs(convId);
  if (tabs.length === 0) browserAddTab(null, convId);
}

function openBrowserPane(url) {
  // Agent sandbox: check browser permission
  if (typeof isAgentActive === 'function' && isAgentActive()) {
    var perm = checkAgentPermission('browser');
    if (!perm.allowed) {
      showSandboxBlock(perm.reason);
      throw new Error(perm.reason + '. Enable Browser Access in the agent\'s permissions to allow this.');
    }
  }
  var pane = document.getElementById('browser-pane');
  if (!pane) return;
  pane.classList.add('open');
  _restoreBrowserPaneWidth();
  _ensureBrowserTab();
  if (url) browserNavigateTo(url);
  pane.addEventListener('transitionend', function onTransEnd() {
    pane.removeEventListener('transitionend', onTransEnd);
    var wv = getActiveWebview();
    if (!wv) return;
    wv.style.opacity = '0.9999';
    requestAnimationFrame(function() { wv.style.opacity = ''; });
  });
}

function closeBrowserPane() {
  var pane = document.getElementById('browser-pane');
  if (pane) pane.classList.remove('open');
}

function browserNavigateTo(url) {
  if (!url) return;
  if (!/^(https?:|file:|about:|data:)/i.test(url)) url = 'https://' + url;
  _ensureBrowserTab();
  var wv = getActiveWebview();
  if (!wv) return;
  document.getElementById('browser-url-input').value = url;
  _waitForDomReady(wv).then(function() { wv.loadURL(url).catch(function() {}); });
}

function browserGo() {
  var url = document.getElementById('browser-url-input').value.trim();
  if (url) browserNavigateTo(url);
}

function browserBack() {
  var wv = getActiveWebview();
  if (wv && wv.canGoBack()) wv.goBack().catch(function() {});
}
function browserForward() {
  var wv = getActiveWebview();
  if (wv && wv.canGoForward()) wv.goForward().catch(function() {});
}
function browserRefresh() {
  var wv = getActiveWebview();
  if (wv) wv.reload();
}

function _checkAntibotChallenge() {
  var wv = getActiveWebview();
  if (!wv) return;
  wvExec(wv, 'JSON.stringify({t:document.title,b:(document.body||{}).innerText||""})').then(function(json) {
    try {
      var d = JSON.parse(json);
      var combined = (d.t + ' ' + d.b).toLowerCase();
      var blocked = /access denied|just a moment|checking your browser|powered and protected|enable javascript|captcha|verify you are human|i am not a robot|are you a robot|ddos protection|security check|please verify/i.test(combined);
      document.getElementById('antibot-banner').style.display = blocked ? 'flex' : 'none';
    } catch(e) {}
  }).catch(function() {});
}

function antibotDone() {
  document.getElementById('antibot-banner').style.display = 'none';
  feedBrowserToAI();
}

async function feedBrowserToAI() {
  var wv = getActiveWebview();
  if (!wv) return;
  var statusEl = document.getElementById('browser-status');
  statusEl.textContent = 'Extracting…';
  try {
    var json = await wvExec(wv, 'JSON.stringify({title:document.title,url:location.href,text:(document.body||{}).innerText||""})');
    var d = JSON.parse(json);
    var text = d.text.slice(0, 15000);
    sendDirectMessage('I browsed to ' + d.url + ' in the browser panel. Here is the page content:\n\n**Title:** ' + d.title + '\n\n' + text);
    statusEl.textContent = 'Sent to AI';
    setTimeout(function() { statusEl.textContent = ''; }, 2000);
  } catch(e) {
    statusEl.textContent = 'Extract failed: ' + e.message;
    dbg('feedBrowserToAI error: ' + e.message, 'err');
  }
}

async function browserScreenshot() {
  var wv = getActiveWebview();
  if (!wv) return;
  var statusEl = document.getElementById('browser-status');
  statusEl.textContent = 'Screenshotting…';
  try {
    var url = wv.getURL ? wv.getURL() : '';
    // Use Electron webview capturePage — works cross-platform, captures just the webview content
    var nativeImage = await wv.capturePage();
    var pngDataUrl = nativeImage.toDataURL();
    // pngDataUrl is "data:image/png;base64,..."
    if (!pngDataUrl || !pngDataUrl.includes(',')) throw new Error('capturePage returned empty image');
    sendDirectMessage('[Browser screenshot from: ' + (url || 'browser panel') + ']',
      { image: pngDataUrl });
    statusEl.textContent = '';
  } catch(e) {
    statusEl.textContent = 'Failed';
    dbg('browserScreenshot error: ' + e.message, 'err');
  }
}

// Resize — same pattern as artifact pane
(function() {
  var STORAGE_KEY = 'fauna-browser-pane-width';
  var MIN = 340, MAX = 1100;

  function _restoreBrowserPaneWidthInner() {
    var saved = parseInt(localStorage.getItem(STORAGE_KEY), 10);
    if (saved && saved >= MIN && saved <= MAX) {
      var el = document.getElementById('browser-pane-width-override');
      if (!el) {
        el = document.createElement('style');
        el.id = 'browser-pane-width-override';
        document.head.appendChild(el);
      }
      el.textContent = '#browser-pane.open { width: ' + saved + 'px !important; }';
    }
  }
  window._restoreBrowserPaneWidth = _restoreBrowserPaneWidthInner;

  function setWidth(w) {
    w = Math.max(MIN, Math.min(MAX, w));
    var el = document.getElementById('browser-pane-width-override');
    if (!el) { el = document.createElement('style'); el.id = 'browser-pane-width-override'; document.head.appendChild(el); }
    el.textContent = '#browser-pane.open { width: ' + w + 'px !important; }';
    localStorage.setItem(STORAGE_KEY, w);
  }

  document.addEventListener('DOMContentLoaded', function() {
    _restoreBrowserPaneWidthInner();
    var handle = document.getElementById('browser-resize-handle');
    if (!handle) return;
    var pane = document.getElementById('browser-pane');

    window.installPaneResize({
      handle: handle,
      classTarget: pane,
      getStartWidth: function () { return pane.getBoundingClientRect().width; },
      onMove: function (dx, startW) {
        // Handle is on the left edge — dragging left widens the pane.
        setWidth(startW - dx);
      },
    });

    handle.addEventListener('dblclick', function() {
      localStorage.removeItem(STORAGE_KEY);
      var el = document.getElementById('browser-pane-width-override');
      if (el) el.textContent = '#browser-pane.open { width: 560px !important; }';
    });
  });
}());

// ── browser-action block: execute a single action in the webview ───────────

// executeJavaScript wrapper with timeout + retry.
// Timeout prevents hangs when the webview JS never resolves (e.g. infinite loop, stuck page).
// Retry handles GUEST_VIEW_MANAGER_CALL errors when the renderer is mid-navigation.
function _waitForDomReady(wv) {
  if (_domReadyWebviews.has(wv)) return Promise.resolve();
  return new Promise(function(resolve) {
    function onReady() {
      wv.removeEventListener('dom-ready', onReady);
      clearTimeout(fallback);
      resolve();
    }
    wv.addEventListener('dom-ready', onReady);
    // Safety fallback — if dom-ready already fired and WeakSet missed it
    var fallback = setTimeout(function() {
      wv.removeEventListener('dom-ready', onReady);
      resolve();
    }, 5000);
  });
}

async function wvExec(wv, js, retries) {
  retries = retries === undefined ? 3 : retries;
  var TIMEOUT_MS = 8000;
  for (var attempt = 0; attempt <= retries; attempt++) {
    try {
      var result = await Promise.race([
        wv.executeJavaScript(js),
        new Promise(function(_, reject) {
          setTimeout(function() { reject(new Error('executeJavaScript timed out after ' + TIMEOUT_MS + 'ms')); }, TIMEOUT_MS);
        })
      ]);
      return result;
    } catch(e) {
      if (/must be attached|dom-ready|dom_ready/i.test(e.message)) {
        // WebView not ready yet — wait for dom-ready then retry
        await _waitForDomReady(wv);
      } else {
        if (attempt === retries) throw e;
        await new Promise(function(r) { setTimeout(r, 600 + attempt * 400); });
      }
    }
  }
}

function _normalizeBrowserAction(action) {
  if (!action || typeof action.action !== 'string') return action;
  var normalized = Object.assign({}, action);
  var actionMap = {
    'evaluate': 'eval',
    'press-key': 'keyboard',
    'press': 'keyboard',
    'key': 'keyboard',
    'tab-list': 'list-tabs',
    'tab-new': 'new-tab',
    'tab-switch': 'switch-tab',
    'tab-close': 'close-tab',
    'navigate-back': 'back',
    'navigate-forward': 'forward',
    'refresh': 'reload'
  };
  normalized.action = actionMap[normalized.action] || normalized.action;
  if (normalized.js && !normalized.text) normalized.text = normalized.js;
  if (normalized.waitMs != null && normalized.ms == null) normalized.ms = normalized.waitMs;
  if (normalized.timeoutMs != null && normalized.ms == null) normalized.ms = normalized.timeoutMs;
  return normalized;
}

function _mapBrowserActionToExtAction(action) {
  if (!action || typeof action.action !== 'string') return null;
  var mapped = _normalizeBrowserAction(action);
  var actionMap = {
    'new-tab': 'tab:new',
    'switch-tab': 'tab:switch',
    'close-tab': 'tab:close',
    'list-tabs': 'tab:list',
    'screenshot': 'snapshot',
    'press': 'key'
  };
  mapped.action = actionMap[mapped.action] || mapped.action;
  return mapped;
}

async function _executeBrowserActionViaPlaywright(action) {
  var tool, args;
  console.log('[Playwright MCP] attempting action:', action.action);

  switch (action.action) {
    case 'navigate':
      tool = 'browser_navigate';
      args = { url: action.url };
      break;

    case 'back':
      tool = 'browser_navigate_back';
      args = {};
      break;

    case 'forward':
      tool = 'browser_navigate_forward';
      args = {};
      break;

    case 'reload':
      tool = 'browser_reload';
      args = {};
      break;

    case 'click':
      tool = 'browser_click';
      args = {};
      // @playwright/mcp v0.0.73 uses 'element' (human description) + 'target' (snapshot ref).
      // We map our action's selector/text/label fields to these.
      if (action.selector) args.target = action.selector;
      if (action.label || action.text) args.element = action.label || action.text;
      if (!args.target && !args.element) return null;
      break;

    case 'type':
      tool = 'browser_type';
      args = { text: action.value || action.text || '' };
      if (action.selector) args.target = action.selector;
      if (action.label) args.element = action.label;
      break;

    case 'extract':
    case 'snapshot':
      // browser_get_content does not exist — the correct tool is browser_snapshot
      tool = 'browser_snapshot';
      args = {};
      break;

    case 'screenshot':
      tool = 'browser_take_screenshot';
      args = {};
      break;

    case 'scroll':
      // browser_scroll does not exist — use browser_mouse_wheel with deltaX/deltaY
      tool = 'browser_mouse_wheel';
      var scrollDown = (action.direction || 'down') !== 'up';
      var scrollAmount = action.amount || 300;
      args = {
        deltaX: 0,
        deltaY: scrollDown ? scrollAmount : -scrollAmount
      };
      break;

    case 'eval':
      // browser_evaluate takes 'function' not 'js' — wrap as an arrow function if needed
      tool = 'browser_evaluate';
      var jsCode = action.js || 'document.title';
      // If it's an expression (not already a function), wrap it
      args = { function: jsCode.trim().startsWith('(') || jsCode.trim().startsWith('function') ? jsCode : '() => ' + jsCode };
      break;

    case 'new-tab':
      // browser_new_tab does not exist — use browser_tabs action:"new"
      tool = 'browser_tabs';
      args = { action: 'new' };
      if (action.url) args.url = action.url;
      break;

    case 'list-tabs':
      // browser_list_tabs does not exist — use browser_tabs action:"list"
      tool = 'browser_tabs';
      args = { action: 'list' };
      break;

    case 'switch-tab':
      // browser_switch_tab does not exist — use browser_tabs action:"select"
      tool = 'browser_tabs';
      args = { action: 'select', index: typeof action.index === 'number' ? action.index : 0 };
      break;

    case 'close-tab':
      // browser_close_tab does not exist — use browser_tabs action:"close"
      tool = 'browser_tabs';
      args = { action: 'close' };
      if (typeof action.index === 'number') args.index = action.index;
      break;

    case 'console-logs':
      tool = 'browser_console_messages';
      args = {};
      break;

    case 'clear-console':
      tool = 'browser_console_clear';
      args = {};
      break;

    case 'wait':
      await new Promise(function(r) { setTimeout(r, action.ms || 1500); });
      return { ok: true, _browserActionSource: 'playwright' };

    case 'ask-user':
      return { ok: true, manual: true, message: action.message || action.label, _browserActionSource: 'playwright' };

    default:
      return null;
  }

  try {
    var r = await fetch('/api/playwright-mcp/call', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ tool: tool, args: args })
    });
    if (!r.ok) {
      var errBody = await r.json().catch(function() { return {}; });
      console.warn('[Playwright MCP] tool call failed (' + tool + '):', errBody.error || r.status);
      return null;
    }
    var d = await r.json();
    if (!d.ok) {
      console.warn('[Playwright MCP] relay returned not-ok for', tool, d.error || '');
      return null;
    }
    console.log('[Playwright MCP] ✅', tool, 'ok');

    var content = d.content || [];

    // Screenshot: extract image data
    if (action.action === 'screenshot') {
      var img = content.find(function(c) { return c.type === 'image'; });
      if (img) return { ok: true, screenshot: img.data, mime: img.mimeType || 'image/png', _browserActionSource: 'playwright' };
      return null; // no image — fall through
    }

    // Text content
    var text = content.filter(function(c) { return c.type === 'text'; }).map(function(c) { return c.text; }).join('\n');
    var result = { ok: true, result: text, _browserActionSource: 'playwright' };
    if (action.action === 'extract' || action.action === 'snapshot' || action.action === 'navigate') {
      // @playwright/mcp renders tab headers as:
      //   "- Page URL: https://..."
      //   "- Page Title: ..."
      // Parse them out so bot-detection and feed summaries have accurate data.
      var urlMatch   = text.match(/^-\s*Page URL:\s*(.+)$/m);
      var titleMatch = text.match(/^-\s*Page Title:\s*(.+)$/m);
      result.text  = text;
      result.url   = urlMatch   ? urlMatch[1].trim()   : (action.url || '');
      result.title = titleMatch ? titleMatch[1].trim() : '';
    }
    return result;
  } catch (e) {
    console.warn('[Playwright MCP] fetch error for', tool, ':', e.message);
    return null; // Playwright unavailable — fall through to extension/webview
  }
}

async function _executeBrowserActionViaExtension(action) {
  if (!_extConnectedBrowsers.length) return null;
  var mapped = _mapBrowserActionToExtAction(action);
  if (!mapped) return null;
  var supported = new Set([
    'navigate', 'extract', 'extract-forms', 'fill', 'click', 'type', 'drag', 'scroll', 'hover', 'select',
    'keyboard', 'wait', 'eval', 'snapshot', 'snapshot-full', 'tab:list', 'tab:new', 'tab:switch', 'tab:close', 'tab:info',
    'key', 'copy', 'cut', 'paste', 'mouse-click', 'clipboard-read', 'clipboard-write',
    'download', 'download:list', 'tab:group', 'tab:ungroup', 'wait-navigation'
  ]);
  if (!supported.has(mapped.action)) return null;
  var result = await executeExtAction(mapped);
  if (result && typeof result === 'object' && !result._browserActionSource) result._browserActionSource = 'extension';
  return result;
}

async function executeBrowserAction(action) {
  action = _normalizeBrowserAction(action);
  // Routing order mirrors VS Code/Copilot's lower-risk web flow:
  // 1. Built-in browser webview for normal browser-action blocks.
  // 2. Playwright MCP only when explicitly enabled, or as a final fallback for
  //    actions the webview cannot perform. Shared real-browser tabs are handled
  //    through browser-ext-action, not by hijacking browser-action.
  var preferPlaywright = !!(typeof state !== 'undefined' && state.playwrightMCPEnabled);
  if (preferPlaywright) {
    var preferredPwResult = await _executeBrowserActionViaPlaywright(action);
    if (preferredPwResult) return preferredPwResult;
  }

  // ── Browser extension + internal webview + optional Playwright fallback ──
  var wv = getActiveWebview();

  if (action.action === 'navigate') {
    if (!wv && _extConnectedBrowsers.length && action.preferExtension) {
      var extNav = await _executeBrowserActionViaExtension(action);
      if (extNav) return extNav;
    }
    openBrowserPane(); // opens pane + ensures a tab exists
    wv = getActiveWebview();
    if (!wv) throw new Error('No browser tab available');

    var navConv = (typeof getConv === 'function') ? getConv() : null;
    // Wait for did-stop-loading (or 15s timeout) then a flat settle for SPA JS to run.
    // Also resolve early if the user pressed Stop — stopActiveBrowserWorkForCurrentConversation
    // already calls wv.stop() (which fires did-stop-loading), but poll _cancelled as a
    // belt-and-braces guard in case the event was missed.
    var loadDone = new Promise(function(resolve) {
      var done = false;
      var finish = function() { if (done) return; done = true; resolve(); };
      var onStop = function() { wv.removeEventListener('did-stop-loading', onStop); finish(); };
      wv.addEventListener('did-stop-loading', onStop);
      var cancelPoll = setInterval(function() {
        if (navConv && navConv._cancelled) { clearInterval(cancelPoll); finish(); }
      }, 100);
      setTimeout(function() { clearInterval(cancelPoll); finish(); }, 15000);
    });
    browserNavigateTo(action.url);
    await loadDone;
    if (navConv && navConv._cancelled) return { ok: false, cancelled: true };
    // Brief settle for SPA hydration, but bail fast if the user hits Stop.
    await new Promise(function(r) {
      var t = setTimeout(function() { clearInterval(p); r(); }, 1200);
      var p = setInterval(function() {
        if (navConv && navConv._cancelled) { clearInterval(p); clearTimeout(t); r(); }
      }, 100);
    });
    if (navConv && navConv._cancelled) return { ok: false, cancelled: true };
    return { ok: true, url: wv.getURL() };

  } else if (!wv) {
    if (!preferPlaywright) {
      var fallbackPwResult = await _executeBrowserActionViaPlaywright(action);
      if (fallbackPwResult) return fallbackPwResult;
    }
    throw new Error('Browser pane not open and no browser extension tab is available — send a navigate action first');

  } else if (action.action === 'back') {
    if (wv.canGoBack && wv.canGoBack()) await wv.goBack().catch(function() {});
    return { ok: true, url: wv.getURL ? wv.getURL() : '' };

  } else if (action.action === 'forward') {
    if (wv.canGoForward && wv.canGoForward()) await wv.goForward().catch(function() {});
    return { ok: true, url: wv.getURL ? wv.getURL() : '' };

  } else if (action.action === 'reload') {
    if (wv.reload) wv.reload();
    return { ok: true, url: wv.getURL ? wv.getURL() : '' };

  } else if (action.action === 'type') {
    var js =
      'var el=document.querySelector(' + JSON.stringify(action.selector) + ');' +
      'if(!el)throw new Error("Not found: '+action.selector+'");' +
      'el.scrollIntoView();el.focus();' +
      'var setter=Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype,"value")' +
      '||Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype,"value");' +
      'if(setter&&setter.set){setter.set.call(el,' + JSON.stringify(action.value||action.text||'') + ');}' +
      'else{el.value=' + JSON.stringify(action.value||action.text||'') + ';}' +
      'el.dispatchEvent(new Event("input",{bubbles:true}));' +
      'el.dispatchEvent(new Event("change",{bubbles:true}));' +
      '"ok"';
    var r = await wvExec(wv, js);
    return { ok: true, result: r };

  } else if (action.action === 'click') {
    // Use a JS snippet that never throws inside the webview — returns a status string instead.
    // Falls back to text-content match if the CSS selector finds nothing.
    var clickSel = JSON.stringify(action.selector);
    var clickText = JSON.stringify((action.text || action.selector || '').toLowerCase());
    var js2 =
      '(function(){' +
        'var el=null;' +
        // Primary: CSS selector (querySelector handles comma-separated fallback lists natively)
        'try{el=document.querySelector(' + clickSel + ');}catch(_){}' +
        // Secondary: visible text match across all clickable elements
        'if(!el){' +
          'var txt=' + clickText + ';' +
          'var cands=Array.from(document.querySelectorAll("a,button,[role=button],[role=tab],[role=menuitem],[role=option],[role=listitem],[data-slug],[data-id]"));' +
          'el=cands.find(function(c){return (c.innerText||c.textContent||"").toLowerCase().includes(txt);});' +
        '}' +
        'if(!el) return "NOT_FOUND";' +
        'el.scrollIntoView();' +
        'if(el.tagName==="A"&&el.href&&!el.href.startsWith("javascript")) return "HREF:"+el.href;' +
        'el.focus();el.click();' +
        'return "ok";' +
      '})()';
    var clickResult;
    try {
      clickResult = await wvExec(wv, js2);
    } catch(e) {
      throw new Error('Click script error: ' + e.message);
    }
    if (clickResult === 'NOT_FOUND') {
      // Collect a list of interactive elements so the error message gives the AI
      // enough info to pick a corrected selector without an extra round-trip.
      var interactiveJs =
        'JSON.stringify(Array.from(document.querySelectorAll(' +
          '"a[href],button,[role=button],[role=tab],[data-slug],[data-id],[role=menuitem],[role=option]"' +
        ')).slice(0,60).map(function(el){' +
          'var attrs={};' +
          'for(var i=0;i<el.attributes.length;i++){var a=el.attributes[i];if(a.name!=="class"&&a.name!=="style")attrs[a.name]=a.value;}' +
          'return {tag:el.tagName.toLowerCase(),text:(el.innerText||el.textContent||"").trim().slice(0,60),attrs:attrs};' +
        '}))';
      var interactive = '';
      try { interactive = await wvExec(wv, interactiveJs); } catch(_) {}
      var msg = 'Element not found: ' + action.selector;
      if (interactive) {
        try { msg += '\n\nInteractive elements on page:\n' + JSON.parse(interactive).map(function(e) {
          var attrStr = Object.entries(e.attrs).map(function(kv){return kv[0]+'="'+kv[1]+'"';}).join(' ');
          return '<' + e.tag + (attrStr?' '+attrStr:'') + '> ' + e.text;
        }).join('\n'); } catch(_) {}
      }
      throw new Error(msg);
    }
    // If click target was a real link, navigate properly instead of relying on the click
    if (typeof clickResult === 'string' && clickResult.startsWith('HREF:')) {
      var href = clickResult.slice(5);
      var navDone = new Promise(function(resolve) {
        var onStop = function() { wv.removeEventListener('did-stop-loading', onStop); resolve(); };
        wv.addEventListener('did-stop-loading', onStop);
        setTimeout(resolve, 15000);
      });
      browserNavigateTo(href);
      await navDone;
      await new Promise(function(r) { setTimeout(r, 600); });
    } else {
      // Non-link click — wait briefly for any DOM reaction
      await new Promise(function(r) { setTimeout(r, 500); });
    }
    return { ok: true, url: wv.getURL() };

  } else if (action.action === 'wait') {
    await new Promise(function(r) { setTimeout(r, action.ms || 1500); });
    return { ok: true };

  } else if (action.action === 'scroll') {
    var dy = Number(action.amount || action.deltaY || action.y || 0) || 600;
    if ((action.direction || '').toLowerCase() === 'up') dy = -Math.abs(dy);
    var scrollResult = await wvExec(wv,
      '(function(){window.scrollBy({top:' + JSON.stringify(dy) + ',left:0,behavior:"instant"});return JSON.stringify({x:window.scrollX,y:window.scrollY});})()'
    );
    return { ok: true, result: scrollResult, url: wv.getURL ? wv.getURL() : '' };

  } else if (action.action === 'extract') {
    // Poll from our side using bare executeJavaScript (NOT wvExec).
    // wvExec retries add up to 3s per attempt × 14 attempts = 42s of dead time.
    // Bare calls fail-fast (<50ms) so 14 × 600ms ≈ 8.4s max.
    var extractOneShot =
      'JSON.stringify((function(){\n' +
      '  var body = document.body || {};\n' +
      '  var txt = body.innerText || body.textContent || "";\n' +
      '  var links = Array.from(document.querySelectorAll("a[href]")).slice(0,150)\n' +
      '    .map(function(a){ return {text:(a.innerText||a.textContent||"").trim().replace(/\\s+/g," ").slice(0,80),href:a.href}; })\n' +
      '    .filter(function(l){ return l.href && !l.href.startsWith("javascript") && !l.href.startsWith("data:"); });\n' +
      '  return { title:document.title, url:location.href, text:txt, links:links, ready:(txt.trim().length>80||links.length>2) };\n' +
      '})())';
    var d = null;
    for (var pollTry = 0; pollTry < 14; pollTry++) {
      try {
        var snap = await wv.executeJavaScript(extractOneShot); // bare — fast fail, no retry overhead
        d = JSON.parse(snap);
        if (d.ready) break;
      } catch(_) { /* webview mid-load — try next tick */ }
      await new Promise(function(r) { setTimeout(r, 600); });
    }
    if (!d) d = { title: '', url: wv.getURL ? wv.getURL() : '', text: '', links: [] };
    var linkLines = (d.links || []).map(function(l) {
      return '  [' + (l.text || '(no text)') + '] → ' + l.href;
    });
    var linksBlock = linkLines.length
      ? '\n\n### Page links (use these EXACT URLs in navigate — do not modify them):\n' + linkLines.join('\n')
      : '\n\n### Page links: none found';
    return { ok: true, title: d.title, url: d.url, text: d.text.slice(0, 10000) + linksBlock };

  } else if (action.action === 'extract-forms') {
    var extForms = await _executeBrowserActionViaExtension(action);
    if (extForms) return extForms;
    throw new Error('extract-forms is only available through the browser extension');

  } else if (action.action === 'eval') {
    // Run arbitrary JS in the webview and return the result as a string.
    var currentUrl = '';
    try { currentUrl = wv.getURL ? wv.getURL() : ''; } catch(_) {}
    if (!currentUrl || currentUrl === 'about:blank') {
      return { ok: true, result: 'ERROR: No page loaded in browser panel — navigate first.' };
    }
    // Approach 1: base64 + new Function — handles syntax errors in user code as caught
    // exceptions rather than crashing executeJavaScript itself.
    var b64Code = btoa(unescape(encodeURIComponent(action.js || '')));
    var safeEval =
      '(async function(){' +
        'try{' +
          'var __code__=decodeURIComponent(escape(atob("' + b64Code + '")));' +
          'var __fn__=new Function("return (async function(){"+__code__+"})()");' +
          'var __r__=await __fn__();' +
          'return String(__r__===undefined?"(undefined)":__r__);' +
        '}catch(e){return "ERROR: "+e.message;}' +
      '})()';
    try {
      var evalResult = await wvExec(wv, safeEval, 1);
      return { ok: true, result: String(evalResult) };
    } catch(_evalErr) {
      // Approach 2: simpler synchronous IIFE — no new Function, wider compatibility.
      // Backticks in user code are escaped to prevent breaking the template.
      var jsCode = (action.js || '').replace(/\\/g, '\\\\').replace(/'/g, "\\'");
      var directEval = "(function(){try{return String((function(){" + jsCode + "})());}catch(e){return 'ERROR: '+e.message;}})()";
      try {
        var directResult = await wvExec(wv, directEval, 1);
        return { ok: true, result: String(directResult) };
      } catch(directErr) {
        // Both approaches failed — return as a result (not a throw) so the AI sees it
        return { ok: true, result: 'ERROR: eval failed on this page — ' + directErr.message +
          '. Try using the extract action instead, or add a wait action before retrying.' };
      }
    }

  } else if (action.action === 'new-tab') {
    // AI creates a new tab, optionally navigating to a URL
    openBrowserPane();
    var newTabId = browserAddTab(action.url || null);
    if (action.url) {
      // Wait for page to load
      var newWv = getActiveWebview();
      if (newWv) {
        var ntLoadDone = new Promise(function(resolve) {
          var onStop = function() { newWv.removeEventListener('did-stop-loading', onStop); resolve(); };
          newWv.addEventListener('did-stop-loading', onStop);
          setTimeout(resolve, 15000);
        });
        await ntLoadDone;
        await new Promise(function(r) { setTimeout(r, 800); });
      }
    }
    var tabs = _getConvTabs();
    return { ok: true, tabId: newTabId, tabIndex: tabs.length - 1, totalTabs: tabs.length };

  } else if (action.action === 'switch-tab') {
    // AI switches to a specific tab by index (0-based) or by tabId
    var convTabs = _getConvTabs();
    var targetTab;
    if (typeof action.index === 'number') {
      targetTab = convTabs[action.index];
    } else if (action.tabId) {
      targetTab = convTabs.find(function(t) { return t.id === action.tabId; });
    }
    if (!targetTab) throw new Error('Tab not found — index: ' + action.index + ', tabId: ' + action.tabId + ', available: ' + convTabs.length + ' tabs');
    browserSwitchTab(targetTab.id);
    return { ok: true, tabId: targetTab.id, title: targetTab.title, url: targetTab.url };

  } else if (action.action === 'close-tab') {
    // AI closes a tab by index or tabId
    var ct = _getConvTabs();
    var toClose;
    if (typeof action.index === 'number') {
      toClose = ct[action.index];
    } else if (action.tabId) {
      toClose = ct.find(function(t) { return t.id === action.tabId; });
    } else {
      // Close active tab
      toClose = ct.find(function(t) { return t.id === _getConvActiveTabId(); });
    }
    if (!toClose) throw new Error('Tab not found to close');
    browserCloseTab(toClose.id);
    return { ok: true, closed: toClose.id, remainingTabs: _getConvTabs().length };

  } else if (action.action === 'list-tabs') {
    // AI lists all open tabs for the current conversation
    var lt = _getConvTabs();
    var activeId = _getConvActiveTabId();
    var tabList = lt.map(function(t, i) {
      return { index: i, tabId: t.id, title: t.title || 'New Tab', url: t.url || 'about:blank', active: t.id === activeId };
    });
    return { ok: true, tabs: tabList, totalTabs: lt.length };

  } else if (action.action === 'extract-all') {
    // AI extracts content from ALL tabs in the current conversation
    var allTabs = _getConvTabs();
    var extractResults = [];
    for (var eti = 0; eti < allTabs.length; eti++) {
      var et = allTabs[eti];
      try {
        var etSnap = await et.wv.executeJavaScript(
          'JSON.stringify({title:document.title,url:location.href,text:(document.body||{}).innerText||""})'
        );
        var etD = JSON.parse(etSnap);
        extractResults.push({ index: eti, tabId: et.id, title: etD.title, url: etD.url, text: etD.text.slice(0, 5000) });
      } catch(_) {
        extractResults.push({ index: eti, tabId: et.id, title: et.title, url: et.url, text: '(could not extract — page may still be loading)' });
      }
    }
    return { ok: true, tabs: extractResults, totalTabs: allTabs.length };

  } else if (action.action === 'console-logs') {
    // AI reads console output (errors, warnings, logs) from the active tab
    var clTabs = _getConvTabs();
    var clActiveId = _getConvActiveTabId();
    var clTab;
    if (typeof action.index === 'number') {
      clTab = clTabs[action.index];
    } else if (action.tabId) {
      clTab = clTabs.find(function(t) { return t.id === action.tabId; });
    } else {
      clTab = clTabs.find(function(t) { return t.id === clActiveId; });
    }
    if (!clTab) throw new Error('Tab not found for console-logs');
    var logs = clTab.consoleLogs || [];
    // Filter by level if requested
    if (action.level) {
      logs = logs.filter(function(l) { return l.level === action.level; });
    }
    // Default: return last 50 entries (or action.limit)
    var clLimit = action.limit || 50;
    var recentLogs = logs.slice(-clLimit);
    var logLines = recentLogs.map(function(l) {
      return '[' + l.level.toUpperCase() + '] ' + l.text + (l.line ? ' (line ' + l.line + ')' : '');
    });
    return { ok: true, logs: logLines, totalLogs: logs.length, returned: recentLogs.length };

  } else if (action.action === 'clear-console') {
    // Clear console logs for the active tab
    var ccTabs = _getConvTabs();
    var ccTab = ccTabs.find(function(t) { return t.id === _getConvActiveTabId(); });
    if (ccTab) ccTab.consoleLogs = [];
    return { ok: true, cleared: true };

  } else if (action.action === 'ask-user') {
    return { ok: true, manual: true, message: action.message || action.label };

  } else if (action.action === 'screenshot') {
    // Capture the current webview as a PNG and return base64 — same as clicking the camera button
    if (!wv) throw new Error('Browser pane not open — send a navigate action first');
    var nativeImg = await wv.capturePage();
    var pngDataUrl = nativeImg.toDataURL();
    if (!pngDataUrl || !pngDataUrl.includes(',')) throw new Error('capturePage returned empty image');
    var b64 = pngDataUrl.split(',')[1];
    return { ok: true, screenshot: b64, mime: 'image/png', url: wv.getURL ? wv.getURL() : '' };
  }

  throw new Error('Unknown action: ' + action.action);
}

// ── browser-action rendering (like shell-exec but for webview) ─────────────

function extractAndRenderBrowserActions(html, messageEl, isHistoryLoad, convId) {
  var container = messageEl.querySelector('.prose') || messageEl;
  var codeBlocks = container.querySelectorAll('code.language-browser-action, code.language-browser_action');
  if (!codeBlocks.length) return;
  dbg('extractAndRenderBrowserActions: ' + codeBlocks.length + ' block(s)', 'info');

  var actions = [];
  var widgets = [];

  var iconMap = { navigate:'ti-world-www', type:'ti-keyboard', click:'ti-cursor-text',
                  wait:'ti-clock', extract:'ti-text-scan-2', screenshot:'ti-camera',
                  'ask-user':'ti-message-chatbot', 'new-tab':'ti-plus', 'switch-tab':'ti-arrow-right',
                  'close-tab':'ti-x', 'list-tabs':'ti-list', 'extract-all':'ti-text-scan-2',
                  'console-logs':'ti-terminal', 'clear-console':'ti-eraser' };
  var labelMap = { navigate:'Navigate', type:'Type', click:'Click',
                   wait:'Wait', extract:'Extract', screenshot:'Screenshot',
                   'ask-user':'User Input', 'new-tab':'New Tab', 'switch-tab':'Switch Tab',
                   'close-tab':'Close Tab', 'list-tabs':'List Tabs', 'extract-all':'Extract All Tabs',
                   'console-logs':'Console Logs', 'clear-console':'Clear Console' };

  function makeWidgetEl(action, rawLine) {
    var baId = 'ba-' + Date.now() + '-' + Math.random().toString(36).slice(2);
    var icon  = iconMap[action.action]  || 'ti-browser';
    var label = labelMap[action.action] || action.action;
    var desc  = action.url || action.selector || (action.value||'').slice(0,40) || action.message || (typeof action.index==='number' ? 'Tab '+action.index : '') || '';
    var el = document.createElement('div');
    el.className = 'ba-block';
    el.id = baId;
    el.dataset.action = rawLine;
    el.innerHTML =
      '<div class="ba-header">' +
        '<i class="ti ' + icon + '"></i>' +
        '<span class="ba-label">' + escHtml(label) + '</span>' +
        (desc ? '<span class="ba-desc">' + escHtml(desc) + '</span>' : '') +
        '<span class="ba-status" id="' + baId + '-status"></span>' +
      '</div>';
    return { el: el, id: baId, action: action };
  }

  // Dedupe key: collapses two identical browser-action blocks in the same message
  // into a single widget. The LLM occasionally emits the same `navigate` block
  // twice (e.g. once before writing the file, then again after), which used to
  // render two widgets pointing at the same URL.
  var _seenKeys = Object.create(null);
  function _actionKey(a) {
    if (!a || typeof a !== 'object') return '';
    try { return (a.action || '') + '|' + JSON.stringify(a); } catch(_) { return ''; }
  }

  codeBlocks.forEach(function(code) {
    var pre = code.parentElement;
    var raw = code.textContent.trim();

    // Support JSONL (multiple JSON objects, one per line) as well as single JSON.
    // When the LLM emits adjacent fenced blocks the closing ``` of block N and
    // opening ``` of block N+1 merge into ``````browser-action — marked.js treats
    // that as a non-closing fence and collapses everything into one code block.
    // Strip those fence-separator lines before parsing.
    var lines = raw.split('\n').map(function(l) { return l.trim(); })
      .filter(function(l) { return l && !/^`{3,}/.test(l); });
    var parsedLines = [];
    var allJsonl = lines.length > 1 && lines.every(function(l) {
      try { JSON.parse(l); return true; } catch(_) { return false; }
    });

    if (allJsonl) {
      lines.forEach(function(l) {
        try { parsedLines.push({ raw: l, action: JSON.parse(l) }); } catch(_) {}
      });
    } else {
      try { parsedLines.push({ raw: raw, action: JSON.parse(raw) }); } catch(e) {
        dbg('browser-action parse error: ' + e.message, 'err');
        pre.remove(); return;
      }
    }

    // Drop duplicates of any action we've already created a widget for in this message.
    parsedLines = parsedLines.filter(function(entry) {
      var k = _actionKey(entry.action);
      if (!k) return true;
      if (_seenKeys[k]) { dbg('browser-action: dropping duplicate ' + k, 'info'); return false; }
      _seenKeys[k] = true;
      return true;
    });
    if (!parsedLines.length) { pre.remove(); return; }

    // Replace <pre> with first widget, then insert remaining widgets after it
    var insertAfter = null;
    parsedLines.forEach(function(entry, idx) {
      var w = makeWidgetEl(entry.action, entry.raw);
      if (idx === 0) {
        pre.parentNode.replaceChild(w.el, pre);
      } else {
        insertAfter.el.parentNode.insertBefore(w.el, insertAfter.el.nextSibling);
      }
      insertAfter = w;
      actions.push(entry.action);
      widgets.push({ id: w.id, action: entry.action });
    });
  });

  if (!actions.length || isHistoryLoad) return;

  var initialBrowserTabIds = _getConvTabs(convId).map(function(t) { return t.id; });

  // Only skip pre-opening the internal browser pane when Playwright MCP is explicitly enabled.
  // Installation/running status alone should not hijack ordinary browser-action requests.
  var hasNav = actions.some(function(a) { return a.action === 'navigate' || a.action === 'new-tab'; });
  if (hasNav) {
    if (!(typeof state !== 'undefined' && state.playwrightMCPEnabled)) {
      try { openBrowserPane(); } catch(e) { dbg('openBrowserPane: ' + e.message, 'err'); }
    }
  }

  // In chain messages (auto-fed responses), hide narration prose — only show the action widgets
  if (messageEl.classList.contains('chain-msg') && container) {
    Array.from(container.children).forEach(function(child) {
      if (!child.classList || !child.classList.contains('ba-block')) {
        child.style.display = 'none';
      }
    });
    messageEl.classList.add('chain-ba-only');
  }

  // Run all actions sequentially
  _runBrowserActionSequence(widgets, convId, initialBrowserTabIds);
}

function _markRemainingCancelled(widgets, fromIndex) {
  for (var j = fromIndex; j < widgets.length; j++) {
    var sEl = document.getElementById(widgets[j].id + '-status');
    var bEl = document.getElementById(widgets[j].id);
    if (sEl) { sEl.className = 'ba-status err'; sEl.textContent = 'Cancelled'; }
    if (bEl) { bEl.classList.remove('running'); }
  }
}

function _collapseCompletedChainActionMessage(widgets) {
  if (!widgets || !widgets.length) return;
  var firstBlock = document.getElementById(widgets[0].id);
  var msgEl = firstBlock && firstBlock.closest ? firstBlock.closest('.msg.chain-ba-only') : null;
  if (!msgEl) return;

  var allDone = widgets.every(function(w) {
    var statusEl = document.getElementById(w.id + '-status');
    return statusEl && statusEl.classList.contains('ok');
  });
  if (!allDone) return;

  msgEl.classList.add('chain-action-complete');
  msgEl.setAttribute('aria-hidden', 'true');
}

async function _runBrowserActionSequence(widgets, convId, initialBrowserTabIds) {
  var conv = getConv(convId || state.currentId);
  var initialTabIds = Array.isArray(initialBrowserTabIds)
    ? initialBrowserTabIds.slice()
    : _getConvTabs(convId).map(function(t) { return t.id; });
  var shouldCloseDisposableTab = initialTabIds.length === 0 && _isDisposableBrowserActionSequence(widgets);
  var keepBrowserOpen = false;
  var i = 0;
  for (; i < widgets.length; i++) {
    if (conv && conv._cancelled) { _markRemainingCancelled(widgets, i); return; }
    var w = widgets[i];
    var statusEl = document.getElementById(w.id + '-status');
    var blockEl  = document.getElementById(w.id);

    if (statusEl) { statusEl.className = 'ba-status running'; statusEl.textContent = '⏳ Running…'; }
    if (blockEl)  { blockEl.classList.add('running'); }

    try {
      var result = await executeBrowserAction(w.action);
      if (statusEl) {
        if (result.manual) {
          statusEl.className = 'ba-status manual';
          statusEl.textContent = (result.message || 'Please act in browser');
        } else {
          statusEl.className = 'ba-status ok';
          statusEl.textContent = 'Done';
        }
      }
      if (blockEl) blockEl.classList.remove('running');

      // If it was a navigate and there's no following extract in this sequence,
      // auto-extract the loaded page and feed it to the AI so the chain continues.
      if (w.action.action === 'navigate') {
        var hasFollowingExtract = widgets.slice(i + 1).some(function(fw) { return fw.action.action === 'extract'; });
        if (!hasFollowingExtract) {
          try {
            var navExtract = await executeBrowserAction({ action: 'extract' });

            // Bot-block detection — pause and let the user decide before feeding AI
            var navBotChoice = await _handleBotBlockIfNeeded(navExtract, w.action.url, convId);
            if (navBotChoice) {
              if (navBotChoice === 'stop') { break; }
              if (navBotChoice === 'retry') { i--; continue; }
              if (navBotChoice === 'skip') {
                await browserFeedAI('The site at ' + (navExtract.url || w.action.url || 'the URL') + ' blocked automated access (bot protection). The user chose to skip it. Continue the task without that page.', convId);
                continue;
              }
              if (navBotChoice === 'login') {
                keepBrowserOpen = true;
                appendAINotice('**Action needed:** Please log in or solve the CAPTCHA in the browser panel, then say "done" or "continue".', convId);
                break;
              }
              if (navBotChoice === 'extension') {
                await browserFeedAI('The site blocked the headless browser. The user wants to use the real browser extension instead. Re-emit the navigate action targeting the extension.', convId);
                break;
              }
              if (navBotChoice === 'headers') {
                await browserFeedAI('The site at ' + (navExtract.url || w.action.url || 'the URL') + ' blocked the request. The user wants you to retry with a custom user-agent or headers. Re-emit the browser action with an appropriate approach.', convId);
                break;
              }
            }

            var navSrc  = navExtract && navExtract._browserActionSource;
            var navFrom = navSrc === 'playwright' ? 'Playwright MCP' : navSrc === 'extension' ? 'real browser tab' : 'browser panel';
            var navFeed = (navExtract.text
              ? 'Navigated and extracted page via ' + navFrom + ':\n\n**Title:** ' + navExtract.title + '\n**URL:** ' + navExtract.url + '\n\n' + navExtract.text
              : 'Navigated to page via ' + navFrom + ' (no text content):\n**Title:** ' + navExtract.title + '\n**URL:** ' + navExtract.url);
            // For localhost URLs, wait for console errors/warnings to accumulate then include them
            var navUrl = (w.action.url || '').toLowerCase();
            if (/^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?/i.test(navUrl)) {
              await new Promise(function(r) { setTimeout(r, 2500); });
              var navTabs = _getConvTabs(convId);
              var navActiveId = _getConvActiveTabId(convId);
              var navTab = navTabs.find(function(t) { return t.id === navActiveId; });
              if (navTab && navTab.consoleLogs.length > 0) {
                var errLogs = navTab.consoleLogs.filter(function(l) { return l.level === 'error' || l.level === 'warn'; });
                if (errLogs.length > 0) {
                  navFeed += '\n\n**Console errors/warnings (' + errLogs.length + '):**\n```\n'
                    + errLogs.map(function(l) { return '[' + l.level.toUpperCase() + '] ' + l.text; }).join('\n').slice(0, 6000)
                    + '\n```';
                }
              }
            }
            await browserFeedAI(navFeed, convId);
          } catch(_) {}
        }
      }

      // If it was an extract, always feed result back to AI so it can continue
      if (w.action.action === 'extract') {
        // Bot-block detection — pause before feeding AI
        var extBotChoice = await _handleBotBlockIfNeeded(result, null, convId);
        if (extBotChoice) {
          if (extBotChoice === 'stop') { break; }
          if (extBotChoice === 'retry') { i--; continue; }
          if (extBotChoice === 'skip') {
            await browserFeedAI('The site blocked automated access (bot protection). The user chose to skip it. Continue the task without that page\'s content.', convId);
            continue;
          }
          if (extBotChoice === 'login') {
            keepBrowserOpen = true;
            appendAINotice('**Action needed:** Please log in or solve the CAPTCHA in the browser panel, then say "done" or "continue".', convId);
            break;
          }
          if (extBotChoice === 'extension') {
            await browserFeedAI('The site blocked the headless browser. The user wants to use the real browser extension instead. Re-emit the navigate/extract targeting the extension.', convId);
            break;
          }
          if (extBotChoice === 'headers') {
            await browserFeedAI('The site blocked the request. The user wants you to retry with a custom user-agent or different headers. Re-emit the browser action with an appropriate approach.', convId);
            break;
          }
        }
        var fromExt = result && result._browserActionSource === 'extension';
        var fromPw  = result && result._browserActionSource === 'playwright';
        var feedPrefix  = fromExt ? 'Extracted page from real browser tab:'
                        : fromPw  ? 'Extracted page via Playwright MCP:'
                        :           'Extracted page from browser panel:';
        var emptyPrefix = fromExt ? 'Page loaded in real browser tab (no text content):'
                        : fromPw  ? 'Page loaded via Playwright MCP (no text content):'
                        :           'Page loaded in browser panel (no text content):';
        var feedContent = (result.text
          ? feedPrefix + '\n\n**Title:** ' + result.title + '\n**URL:** ' + result.url + '\n\n' + result.text
          : emptyPrefix + '\n**Title:** ' + result.title + '\n**URL:** ' + result.url)
;
        await browserFeedAI(feedContent, convId);
      }
      if (w.action.action === 'extract-forms') {
        var formsFeed = 'Form fields extracted from ' + ((result && result._browserActionSource === 'extension') ? 'real browser tab' : (result && result._browserActionSource === 'playwright') ? 'Playwright MCP' : 'browser panel') + ' (' + (((result && result.fields) || []).length) + ' fields):\n\n```json\n' +
          JSON.stringify(result.forms || result, null, 2).slice(0, 10000) + '\n```' +
          '\n\nUse the selector values above for the next browser-action blocks.';
        await browserFeedAI(formsFeed, convId);
      }
      // If it was a screenshot, feed the image back to the AI
      if (w.action.action === 'screenshot' && result.screenshot) {
        var imgDataUrl = 'data:' + (result.mime || 'image/png') + ';base64,' + result.screenshot;
        sendDirectMessage('[Browser screenshot from: ' + (result.url || 'browser panel') + ']',
          { image: imgDataUrl, fromAutoFeed: true });
      }
      // If it was an eval, feed result back too
      if (w.action.action === 'eval') {
        var evalFeed = 'Eval result from ' + ((result && result._browserActionSource === 'playwright') ? 'Playwright MCP' : 'browser panel') + ':\n```\n' + (result.result || '(empty)').slice(0, 8000) + '\n```';
        await browserFeedAI(evalFeed, convId);
      }
      // If it was a click or wait and this is the last action (or no following extract),
      // auto-extract so the AI sees the resulting page and can keep going.
      if ((w.action.action === 'click' || w.action.action === 'wait') && !result.manual) {
        var hasLaterExtract = widgets.slice(i + 1).some(function(fw) { return fw.action.action === 'extract'; });
        if (!hasLaterExtract) {
          try {
            var clickExtract = await executeBrowserAction({ action: 'extract' });
            var clickSrc  = clickExtract && clickExtract._browserActionSource;
            var clickFrom = clickSrc === 'playwright' ? 'Playwright MCP' : 'browser panel';
            var clickFeed = (clickExtract.text
              ? 'Page after ' + w.action.action + ' in ' + clickFrom + ':\n\n**Title:** ' + clickExtract.title + '\n**URL:** ' + clickExtract.url + '\n\n' + clickExtract.text
              : 'Page after ' + w.action.action + ' in ' + clickFrom + ' (no text content):\n**URL:** ' + clickExtract.url);
            await browserFeedAI(clickFeed, convId);
          } catch(_) {}
        }
      }
      // new-tab with URL — auto-extract the loaded page
      if (w.action.action === 'new-tab' && w.action.url) {
        try {
          var ntExtract = await executeBrowserAction({ action: 'extract' });
          var ntFeed = 'Opened new tab and extracted page:\n\n**Title:** ' + (ntExtract.title||'') + '\n**URL:** ' + (ntExtract.url||'') + '\n\n' + (ntExtract.text||'').slice(0, 10000)
;
          await browserFeedAI(ntFeed, convId);
        } catch(_) {}
      }
      // switch-tab — tell AI which tab is now active + auto-extract
      if (w.action.action === 'switch-tab') {
        try {
          var stExtract = await executeBrowserAction({ action: 'extract' });
          var stFeed = 'Switched to tab: **' + (result.title||'') + '** (' + (result.url||'') + ')\n\n' + (stExtract.text||'').slice(0, 10000)
;
          await browserFeedAI(stFeed, convId);
        } catch(_) {}
      }
      // list-tabs — feed the tab list back
      if (w.action.action === 'list-tabs') {
        var ltLines = (result.tabs || []).map(function(t) {
          return '  [' + t.index + '] ' + (t.active ? '→ ' : '  ') + t.title + ' — ' + t.url;
        });
        var ltFeed = 'Browser tabs (' + result.totalTabs + '):\n' + ltLines.join('\n')
;
        await browserFeedAI(ltFeed, convId);
      }
      // extract-all — feed all tab contents back
      if (w.action.action === 'extract-all') {
        var eaLines = (result.tabs || []).map(function(t) {
          return '### Tab ' + t.index + ': ' + t.title + '\n**URL:** ' + t.url + '\n\n' + t.text;
        });
        var eaFeed = 'Extracted content from ' + result.totalTabs + ' tab(s):\n\n' + eaLines.join('\n\n---\n\n')
;
        await browserFeedAI(eaFeed, convId);
      }
      // console-logs — feed console output back to AI
      if (w.action.action === 'console-logs') {
        var clFeed = 'Console logs (' + result.returned + ' of ' + result.totalLogs + ' entries):\n```\n' + (result.logs||[]).join('\n') + '\n```'
;
        await browserFeedAI(clFeed, convId);
      }
      // If ask-user, show message in chat and stop sequence for manual step
      if (result.manual) {
        keepBrowserOpen = true;
        var notice = '**Action needed:** ' + (result.message || 'Please complete the step in the browser panel, then say "done" or "continue".');
        appendAINotice(notice, convId);
        break;
      }
    } catch(e) {
      keepBrowserOpen = true;
      if (statusEl) { statusEl.className = 'ba-status err'; statusEl.textContent = 'Error: ' + e.message; }
      if (blockEl)  { blockEl.classList.remove('running'); }
      dbg('browser-action error: ' + e.message, 'err');
      // For all action types: auto-extract the current page and feed the error back
      // to the AI so it can recover (correct selectors, try a different approach, etc.)
      var wvErr = getActiveWebview();
      if (wvErr) {
        try {
          var errJson = await wvErr.executeJavaScript('JSON.stringify({title:document.title,url:location.href,text:(document.body||{}).innerText||""})' );
          var errD = JSON.parse(errJson);
          var errIntro = w.action.action === 'eval'
            ? 'browser-action `eval` failed (' + e.message + '). The page may be blocking script execution.\n\nCurrent page state:\n\n'
            : 'browser-action `' + w.action.action + '` failed (' + e.message + ').\n\nAuto-extracted current page:\n\n';
          var errFeed = errIntro +
            '**Title:** ' + errD.title + '\n**URL:** ' + errD.url + '\n\n' + errD.text.slice(0, 10000);
          await browserFeedAI(errFeed, convId);
        } catch(_) {}
      }
      break; // Stop sequence on error
    }
  }
  if (i >= widgets.length) _collapseCompletedChainActionMessage(widgets);
  if (shouldCloseDisposableTab && !keepBrowserOpen && i >= widgets.length) {
    _closeDisposableBrowserTabIfUnused(convId, initialTabIds);
  }
}

// ── Bot / CAPTCHA / block detection ───────────────────────────────────────

/**
 * Return true when the extracted page text / title looks like an anti-bot wall.
 * We check the most common patterns: Cloudflare, Akamai, PerimeterX, Imperva,
 * reCAPTCHA, hCaptcha, DataDome, and generic "access denied" pages.
 */
function _detectBotBlock(text, title) {
  var t = (title || '').toLowerCase();
  var b = (text  || '').toLowerCase().slice(0, 4000); // only check the top of the page
  // Title-based signals
  var titleHits = [
    'just a moment', 'attention required', 'access denied', 'forbidden',
    'security check', 'please verify', 'are you human', 'bot check',
    'one more step', 'checking your browser', 'ddos protection',
  ];
  for (var ti = 0; ti < titleHits.length; ti++) {
    if (t.includes(titleHits[ti])) return true;
  }
  // Body-based signals
  var bodyHits = [
    'enable javascript and cookies', 'checking if the site connection is secure',
    'why do i have to complete a captcha', 'cloudflare ray id',
    'please complete the security check', 'your browser does not support javascript',
    'automated access to this service', 'your ip address has been blocked',
    'access to this page has been denied', 'please stand by',
    'verify you are human', 'complete a brief security check',
    'this site is protected by recaptcha', 'please verify you are a human',
    'datadome', 'perimeterx', 'px-captcha', 'imperva',
    'akamai bot manager', 'radware bot manager',
    'we have been receiving a large volume of requests',
    'unusual traffic from your computer network',
    'to continue, please prove you are not a robot',
  ];
  for (var bi = 0; bi < bodyHits.length; bi++) {
    if (b.includes(bodyHits[bi])) return true;
  }
  return false;
}

/**
 * Show an interactive "site is blocking bots" card in the chat.
 * Returns a Promise that resolves with the user's choice:
 *   'retry'      – retry the navigate action
 *   'extension'  – open in real browser (extension)
 *   'headers'    – tell AI to add custom headers / user-agent
 *   'login'      – user will log in manually then say done
 *   'skip'       – skip this site and continue
 *   'stop'       – stop the sequence entirely
 */
function _showBotBlockOptions(url, title, convId) {
  return new Promise(function(resolve) {
    var inner = getConvInner(convId || state.currentId);
    if (!inner) { resolve('stop'); return; }

    var cardId = 'bot-block-' + Date.now();
    var el = document.createElement('div');
    el.className = 'msg ai';
    el.id = cardId;
    el.innerHTML = [
      '<div class="msg-body">',
        '<div class="prose">',
          '<p><strong>Bot protection detected</strong></p>',
          '<p>The site <strong>' + escHtml(title || url || 'this page') + '</strong> appears to be blocking automated access',
          url ? ' (<code>' + escHtml(url) + '</code>).' : '.', '</p>',
          '<p>What would you like to do?</p>',
          '<div class="bot-block-options">',
            '<button class="bot-block-btn" data-choice="retry">Retry — try loading again</button>',
            '<button class="bot-block-btn" data-choice="extension">Open in real browser — use your connected Chrome/Edge extension</button>',
            '<button class="bot-block-btn" data-choice="headers">Try with custom headers — ask AI to retry with a different user-agent / headers</button>',
            '<button class="bot-block-btn" data-choice="login">Log in manually — open the page, solve the CAPTCHA or log in, then click Done</button>',
            '<button class="bot-block-btn" data-choice="skip">Skip this site — continue the task without this page</button>',
            '<button class="bot-block-btn bot-block-btn-danger" data-choice="stop">Stop — cancel the current task</button>',
          '</div>',
        '</div>',
      '</div>',
    ].join('');

    inner.appendChild(el);
    scrollBottom();

    // Wire up buttons
    el.querySelectorAll('.bot-block-btn').forEach(function(btn) {
      btn.addEventListener('click', function() {
        var choice = btn.getAttribute('data-choice');
        // Replace the card with a confirmation line
        el.querySelector('.bot-block-options').innerHTML =
          '<p style="color:var(--text-muted);font-size:12px">Selected: <strong>' + escHtml(btn.textContent.trim()) + '</strong></p>';
        // Disable all remaining buttons
        el.querySelectorAll('.bot-block-btn').forEach(function(b) { b.disabled = true; });
        resolve(choice);
      });
    });
  });
}

/**
 * Check extracted content for bot-blocks and, if found, pause the sequence
 * to let the user decide what to do.  Returns the user's choice string, or
 * null if no block was detected (normal path continues).
 */
async function _handleBotBlockIfNeeded(extractResult, url, convId) {
  if (!extractResult) return null;
  var text = extractResult.text || '';
  var title = extractResult.title || '';
  var pageUrl = extractResult.url || url || '';
  if (!_detectBotBlock(text, title)) return null;

  var choice = await _showBotBlockOptions(pageUrl, title, convId);
  return choice;
}

// Interrupt any active browser work (webview loads, in-flight ext-action
// requests) so the user's Stop press actually unsticks long-running navigates
// or page evals. Called by stopGeneration() in chat.js. Returns the number
// of webviews stopped, so the toast can reflect that the action was useful.
function stopActiveBrowserWorkForCurrentConversation(convId) {
  var stopped = 0;
  try {
    // 1) Stop any in-progress loads on this conv's webview tabs. This fires
    //    did-stop-loading, which unsticks the navigate() await in
    //    executeBrowserAction so _runBrowserActionSequence can see _cancelled
    //    and mark the remaining widgets as cancelled.
    var tabs = (typeof _getConvTabs === 'function') ? _getConvTabs(convId) : [];
    tabs.forEach(function(t) {
      if (t && t.wv && typeof t.wv.stop === 'function') {
        try { t.wv.stop(); stopped++; } catch (_) {}
      }
    });
    // 2) Fallback: stop any other webview elements in the DOM in case a tab
    //    wasn't registered yet (e.g. mid-creation).
    Array.from(document.querySelectorAll('webview')).forEach(function(wv) {
      if (typeof wv.stop === 'function') {
        try { wv.stop(); } catch (_) {}
      }
    });
  } catch (_) {}
  return stopped;
}

// Send browser page/eval result to AI. Retries if the conv is still streaming.
// Awaiting this ensures the AI's response (and its new browser-action blocks) fully
// complete before the calling sequence considers itself done.
async function browserFeedAI(content, convId) {
  var targetId = convId || state.currentId;
  var conv = getConv(targetId);
  if (!conv) return;
  if (conv._cancelled) return;
  // Wait up to 6s for any in-flight stream to finish before we push the next message
  for (var w = 0; w < 12 && conv._streaming; w++) {
    if (conv._cancelled) return;
    await new Promise(function(r) { setTimeout(r, 500); });
  }
  if (conv._streaming) return; // give up — don't block forever
  if (conv._cancelled) return;
  await sendDirectMessage(content, { targetConvId: targetId, isBrowserFeed: true });
}

// ── browser-ext-action: execute an action via the Browser Extension ────────

/**
 * Send a browser-ext-action command to Fauna's backend, which relays it to
 * the connected Chrome/Edge extension via WebSocket.
 * @param {object} action - the parsed action object from the code block
 * @returns {object} result from extension
 */
async function executeExtAction(action) {
  if (!action || typeof action.action !== 'string' || !action.action.trim()) {
    throw new Error('Invalid browser action payload');
  }
  action = _mapBrowserActionToExtAction(action) || action;
  var target = _getLastBrowserExtTarget();
  var tabId = action.tabId || target.tabId || null;
  var clientId = action.clientId || target.clientId || null;
  var browser = action.browser || target.browser || null;
  var endpoint;
  if (action.action === 'snapshot' || action.action === 'snapshot-full') {
    endpoint = '/api/ext/snapshot';
    var snapBody = { full: action.action === 'snapshot-full', tabId: tabId };
    if (clientId) snapBody.clientId = clientId;
    else if (browser) snapBody.browser = browser;
    var snapR = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(snapBody)
    });
    var snapD = await snapR.json();
    if (!snapR.ok || !snapD.ok) throw new Error(snapD.error || 'Snapshot failed');
    return snapD;
  }

  // All other actions go through /api/ext/command
  var body = { action: action.action, params: action, tabId: tabId };
  if (clientId) body.clientId = clientId;
  else if (browser) body.browser = browser;
  var r = await fetch('/api/ext/command', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
  var d = await r.json();
  if (!r.ok || (d && d.ok === false)) throw new Error((d && d.error) || 'Extension command failed');
  return d;
}

function _getLastBrowserExtTarget() {
  var conv = typeof getConv === 'function' ? getConv(state.currentId) : null;
  if (!conv || !Array.isArray(conv.messages)) return {};
  for (var i = conv.messages.length - 1; i >= 0; i--) {
    var atts = conv.messages[i] && conv.messages[i].attachments;
    if (!Array.isArray(atts)) continue;
    for (var j = atts.length - 1; j >= 0; j--) {
      var att = atts[j];
      if (att && att.extSource && (att.tabId || att.clientId || att.browser)) {
        return {
          tabId: att.tabId || null,
          clientId: att.clientId || null,
          browser: att.browser || null
        };
      }
    }
  }
  return {};
}

function _parseBrowserExtActionJson(raw) {
  if (!raw || typeof raw !== 'string') return { ok: false, error: new Error('Empty browser-ext-action payload') };
  try {
    return { ok: true, value: JSON.parse(raw), recovered: false, note: '' };
  } catch (err) {
    // Common model failure mode: invalid JSON escape for single quote inside a
    // JS string (e.g. \' in JSON). Strip that escape and retry.
    var fixed = raw.replace(/\\'/g, "'");
    if (fixed !== raw) {
      try {
        return { ok: true, value: JSON.parse(fixed), recovered: true, note: "Replaced invalid \\' escapes in JSON string values." };
      } catch (_) {}
    }
    return { ok: false, error: err };
  }
}

// Detect an illustrative browser-ext-action block that contains placeholders
// rather than a runnable command (so we don't execute it or nag the model with
// a parse error). Matches unquoted ALL_CAPS tokens, <angle> or {{mustache}}
// placeholders in a value position, plus a few well-known names.
function _isBrowserExtTemplate(raw) {
  var s = String(raw || '');
  if (/\b(SOURCE_TAB_ID|DEST_TAB_ID|TAB_ID|SOURCE_TAB|DEST_TAB|PLACEHOLDER|YOUR_[A-Z_]+)\b/.test(s)) return true;
  if (/:\s*(?:<[^>]+>|\{\{[^}]+\}\})/.test(s)) return true;
  if (/:\s*[A-Z][A-Z0-9_]{2,}\s*[,}\n]/.test(s)) return true;
  return false;
}

// Render a placeholder template block as a passive, non-executed example.
function _renderBrowserExtTemplate(pre) {
  if (!pre || !pre.parentNode) return;
  var badge = document.createElement('div');
  badge.className = 'ba-block ba-ext ba-template';
  badge.innerHTML =
    '<div class="ba-header">' +
      '<i class="ti ti-template"></i>' +
      '<span class="ba-label">Example (not run)</span>' +
      '<span class="ba-desc">Template with placeholders — fill in real tab ids to run</span>' +
    '</div>';
  pre.parentNode.insertBefore(badge, pre); // keep the code block visible below the badge
}

function _renderBrowserExtParseError(pre, msg) {
  if (!pre || !pre.parentNode) return;
  var el = document.createElement('div');
  el.className = 'ba-block ba-ext ba-parse-error';
  el.innerHTML =
    '<div class="ba-header">' +
      '<i class="ti ti-alert-triangle"></i>' +
      '<span class="ba-label">Browser Action Parse Error</span>' +
      '<span class="ba-status err">Invalid JSON</span>' +
    '</div>' +
    '<div class="ba-output" style="padding:.45rem .6rem;color:#fca5a5;white-space:pre-wrap">' + escHtml(msg) + '</div>';
  pre.parentNode.replaceChild(el, pre);
}

function _feedBrowserExtParseError(raw, err, convId) {
  var reason = (err && err.message) ? err.message : String(err || 'JSON parse failed');
  var preview = String(raw || '').slice(0, 600);
  var feedback = 'browser-ext-action parse error: ' + reason + '\n\n' +
    'Re-emit ONE valid JSON object only (no prose in the code block).\n' +
    "Recovery hint: avoid invalid JSON escapes like \\\\' inside strings; if needed, simplify eval JS or build regex via new RegExp().\n\n" +
    'Failed block preview:\n```json\n' + preview + '\n```';
  browserFeedAI(feedback, convId).catch(function(){});
}

function extractAndRenderBrowserExtActions(html, messageEl, isHistoryLoad, convId) {
  var container = messageEl.querySelector('.prose') || messageEl;
  var codeBlocks = container.querySelectorAll('code.language-browser-ext-action, code.language-browser_ext_action');
  if (!codeBlocks.length) return;
  dbg('extractAndRenderBrowserExtActions: ' + codeBlocks.length + ' block(s)', 'info');

  var actions = [];
  var widgets = [];

  var iconMap = {
    navigate:'ti-world-www', extract:'ti-text-scan-2', 'extract-forms':'ti-forms',
    fill:'ti-edit', click:'ti-cursor-text', type:'ti-keyboard', drag:'ti-arrows-move', scroll:'ti-arrows-down-up', hover:'ti-hand-finger',
    select:'ti-list', keyboard:'ti-keyboard', wait:'ti-clock', eval:'ti-terminal-2',
    snapshot:'ti-camera', 'snapshot-full':'ti-camera-plus',
    'tab:list':'ti-list', 'tab:new':'ti-plus', 'tab:switch':'ti-arrow-right',
    'tab:close':'ti-x', 'tab:info':'ti-info-circle'
  };
  var labelMap = {
    navigate:'Navigate (ext)', extract:'Extract (ext)', 'extract-forms':'Extract Forms (ext)',
    fill:'Fill Form (ext)', click:'Click (ext)', type:'Type (ext)', drag:'Drag (ext)', scroll:'Scroll (ext)', hover:'Hover (ext)',
    select:'Select (ext)', keyboard:'Keyboard (ext)', wait:'Wait', eval:'Eval (ext)',
    snapshot:'Snapshot (ext)', 'snapshot-full':'Full-Page Snapshot (ext)',
    'tab:list':'List Tabs', 'tab:new':'New Tab', 'tab:switch':'Switch Tab',
    'tab:close':'Close Tab', 'tab:info':'Tab Info'
  };

  function makeWidgetEl(action, rawLine) {
    var baId  = 'bea-' + Date.now() + '-' + Math.random().toString(36).slice(2);
    var icon  = iconMap[action.action]  || 'ti-browser';
    var label = labelMap[action.action] || action.action;
    var desc  = action.url || action.selector || (action.text||'').slice(0,40) || (typeof action.tabId==='number'?'Tab '+action.tabId:'') || '';
    var el = document.createElement('div');
    el.className = 'ba-block ba-ext';
    el.id = baId;
    el.dataset.action = rawLine;
    el.innerHTML =
      '<div class="ba-header">' +
        '<i class="ti ' + icon + '"></i>' +
        '<span class="ba-label">' + escHtml(label) + '</span>' +
        (desc ? '<span class="ba-desc">' + escHtml(desc) + '</span>' : '') +
        '<span class="ba-status" id="' + baId + '-status"></span>' +
      '</div>';
    return { el: el, id: baId, action: action };
  }

  codeBlocks.forEach(function(code) {
    var pre  = code.parentElement;
    var raw  = code.textContent.trim();
    var lines = raw.split('\n').map(function(l) { return l.trim(); })
      .filter(function(l) { return l && !/^`{3,}/.test(l); });
    var parsedLines = [];
    var parseResults = lines.map(function(l) { return _parseBrowserExtActionJson(l); });
    var allJsonl = lines.length > 1 && parseResults.every(function(r) { return r.ok; });
    if (allJsonl) {
      lines.forEach(function(l, idx) {
        var parsed = parseResults[idx];
        if (!parsed || !parsed.ok) return;
        var parsedAction = _mapBrowserActionToExtAction(parsed.value);
        if (parsedAction) parsedLines.push({ raw: l, action: parsedAction });
        if (parsed && parsed.recovered) {
          dbg('browser-ext-action parse recovered: ' + (parsed.note || 'sanitized JSON'), 'warn');
        }
      });
    } else {
      var parsedSingle = _parseBrowserExtActionJson(raw);
      if (parsedSingle.ok) {
        var parsedAction = _mapBrowserActionToExtAction(parsedSingle.value);
        if (parsedAction) parsedLines.push({ raw: raw, action: parsedAction });
        if (parsedSingle.recovered) {
          dbg('browser-ext-action parse recovered: ' + (parsedSingle.note || 'sanitized JSON'), 'warn');
        }
      } else {
        var e = parsedSingle.error;
        // Illustrative template with placeholders (e.g. tabId:SOURCE_TAB_ID,
        // <TAB_ID>, {{id}}) — NOT a real command. Render it as a passive example
        // and do NOT auto-execute or feed a parse error back (that caused a
        // re-emit loop when the model showed a "reusable flow" template).
        if (_isBrowserExtTemplate(raw)) {
          dbg('browser-ext-action: template/example block (placeholders) — not executed', 'info');
          _renderBrowserExtTemplate(pre);
          return;
        }
        dbg('browser-ext-action parse error: ' + e.message, 'err');
        _renderBrowserExtParseError(pre, e.message || 'Invalid JSON payload');
        if (!isHistoryLoad) _feedBrowserExtParseError(raw, e, convId);
        return;
      }
    }

    var insertAfter = null;
    parsedLines.forEach(function(entry, idx) {
      var w = makeWidgetEl(entry.action, entry.raw);
      if (idx === 0) {
        pre.parentNode.replaceChild(w.el, pre);
      } else {
        insertAfter.el.parentNode.insertBefore(w.el, insertAfter.el.nextSibling);
      }
      insertAfter = w;
      actions.push(entry.action);
      widgets.push({ id: w.id, action: entry.action });
    });
  });

  if (!actions.length || isHistoryLoad) return;

  // In chain messages (auto-fed responses), hide narration prose — only show the action widgets
  if (messageEl.classList.contains('chain-msg') && container) {
    Array.from(container.children).forEach(function(child) {
      if (!child.classList || !child.classList.contains('ba-block')) {
        child.style.display = 'none';
      }
    });
    messageEl.classList.add('chain-ba-only');
  }

  _runExtActionSequence(widgets, convId);
}

// True when a later action in the same block produces a definitive result the
// model actually wants (page text, form fields, screenshot, or eval output).
// Intermediate steps (tab:new, navigate, wait, click, scroll…) must SKIP their
// own auto-extract feed in that case — otherwise the intermediate feed starts a
// new AI stream and the real result (snapshot-full/eval) gets dropped because
// browserFeedAI/sendDirectMessage bail out while a stream is already running.
function _hasDefinitiveFollowUp(widgets, i) {
  for (var k = i + 1; k < widgets.length; k++) {
    var a = widgets[k] && widgets[k].action && widgets[k].action.action;
    if (a === 'extract' || a === 'extract-forms' ||
        a === 'snapshot' || a === 'snapshot-full' || a === 'eval') {
      return true;
    }
  }
  return false;
}

async function _runExtActionSequence(widgets, convId) {
  var conv = getConv(convId || state.currentId);
  var i = 0;
  for (; i < widgets.length; i++) {
    if (conv && conv._cancelled) { _markRemainingCancelled(widgets, i); return; }
    var w        = widgets[i];
    var statusEl = document.getElementById(w.id + '-status');
    var blockEl  = document.getElementById(w.id);

    if (statusEl) { statusEl.className = 'ba-status running'; statusEl.textContent = '⏳ Running…'; }
    if (blockEl)  { blockEl.classList.add('running'); }

    try {
      var result = await executeExtAction(w.action);

      if (statusEl) { statusEl.className = 'ba-status ok'; statusEl.textContent = 'Done'; }
      if (blockEl)  { blockEl.classList.remove('running'); }

      // ── Auto-feed results back to AI ──────────────────────────────────

      if (w.action.action === 'extract') {
        var exFeed = 'Extracted real browser tab:\n\n**Title:** ' + (result.title||'') +
          '\n**URL:** ' + (result.url||'') + '\n\n' + (result.text||'').slice(0, 12000) +
          '';
        await browserFeedAI(exFeed, convId);
      }

      if (w.action.action === 'extract-forms') {
        var frmFeed = 'Form fields extracted from real browser tab (' + (result.fields||[]).length + ' fields):\n\n```json\n' +
          JSON.stringify(result.forms || result, null, 2).slice(0, 10000) + '\n```' +
          '\n\nUse the selector values from the above to fill fields with browser-ext-action fill blocks.';
        await browserFeedAI(frmFeed, convId);
      }

      if (w.action.action === 'fill') {
        var failedFills = (result.filled||[]).filter(function(f) { return !f.ok; });
        var fillFeed = 'Fill result — ' + (result.filled||[]).length + ' field(s) processed' +
          (failedFills.length ? ', ' + failedFills.length + ' failed: ' + JSON.stringify(failedFills) : ', all ok') +
          '';
        await browserFeedAI(fillFeed, convId);
      }

      if (w.action.action === 'navigate') {
        var hasFollowExt = _hasDefinitiveFollowUp(widgets, i);
        if (!hasFollowExt) {
          try {
            var navRes = await executeExtAction({ action: 'extract' });
            var navFeed = 'Navigated (ext) and extracted page:\n\n**Title:** ' + (navRes.title||'') +
              '\n**URL:** ' + (navRes.url||'') + '\n\n' + (navRes.text||'').slice(0, 12000) +
              '';
            await browserFeedAI(navFeed, convId);
          } catch(_) {}
        }
      }

      if (w.action.action === 'click') {
        var hasFollowClick = _hasDefinitiveFollowUp(widgets, i);
        if (!hasFollowClick) {
          try {
            // Wait for the page to settle before checking — SPA routes and full-page
            // navigations both need time; 1000 ms covers most cases.
            await new Promise(function(r) { setTimeout(r, 1000); });
            var clkRes = await executeExtAction({ action: 'extract' });
            var clkFeed = 'After click (ext) — page state (waited 1 s for navigation/SPA update):\n\n' +
              '**Title:** ' + (clkRes.title||'') + '\n**URL:** ' + (clkRes.url||'') +
              '\n\n' + (clkRes.text||'').slice(0, 12000) +
              '\n\nNote: if the URL is unchanged the click may have triggered a client-side ' +
              'action (modal, SPA transition, dynamic load). Use snapshot or eval to visually verify.' +
              '';
            await browserFeedAI(clkFeed, convId);
          } catch(_) {}
        }
      }

      if (w.action.action === 'scroll' || w.action.action === 'hover' || w.action.action === 'select' || w.action.action === 'keyboard' || w.action.action === 'drag' || w.action.action === 'type') {
        var hasFollowScroll = _hasDefinitiveFollowUp(widgets, i);
        if (!hasFollowScroll) {
          try {
            var feedDelay = (w.action.action === 'type') ? 1000 : 500;
            await new Promise(function(r) { setTimeout(r, feedDelay); });
            var scrRes = await executeExtAction({ action: 'extract' });
            var scrFeed = 'After ' + w.action.action + ' (ext) — page state:\n\n' +
              '**Title:** ' + (scrRes.title||'') + '\n**URL:** ' + (scrRes.url||'') +
              '\n\n' + (scrRes.text||'').slice(0, 12000) +
              '';
            await browserFeedAI(scrFeed, convId);
          } catch(_) {}
        }
      }

      if (w.action.action === 'eval') {
        var evalFeed = 'Eval result from real browser tab:\n```\n' + (result.result||'(empty)').slice(0, 8000) + '\n```' +
'';
        await browserFeedAI(evalFeed, convId);
      }

      // snapshot — show thumbnail + inject image into AI
      if (w.action.action === 'snapshot' || w.action.action === 'snapshot-full') {
        if (result.base64) {
          var snapMime = result.mime || 'image/jpeg';
          var snapTabInfo = await executeExtAction({ action: 'tab:info' }).catch(function() { return {}; });
          var snapUrl = snapTabInfo.url || 'browser';
          var snapLabel = snapUrl.length > 60 ? snapUrl.slice(0, 57) + '…' : snapUrl;

          // Optional savePath: persist the screenshot to disk so the model can
          // reference it as a real file (e.g. in case-study folders, README
          // images, etc.) instead of falling back to fabricated SVG mockups.
          var savedPath = '';
          var saveError = '';
          if (w.action.savePath) {
            try {
              var saveRes = await fetch('/api/write-file', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                  path: w.action.savePath,
                  content: result.base64,
                  encoding: 'base64'
                })
              });
              var saveJson = await saveRes.json().catch(function() { return {}; });
              if (saveRes.ok && saveJson.ok) {
                savedPath = saveJson.path || w.action.savePath;
              } else {
                saveError = saveJson.error || ('HTTP ' + saveRes.status);
              }
            } catch (e) { saveError = e.message || String(e); }
          }

          // Show thumbnail in chat
          var thumbEl = document.createElement('div');
          thumbEl.className = 'msg system-msg';
          thumbEl.innerHTML = '<div class="msg-body" style="display:flex;align-items:center;gap:8px;font-size:11px">' +
            '<img src="data:' + snapMime + ';base64,' + result.base64 + '" ' +
            'style="max-width:120px;max-height:80px;border-radius:6px;border:1px solid rgba(255,255,255,.1);cursor:pointer" ' +
            'onclick="window.open(this.src,\'_blank\')" title="Click to enlarge">' +
            '<span style="opacity:.7"><i class="ti ti-camera" style="margin-right:4px"></i>Snapshot from ' + escHtml(snapLabel) +
            (savedPath ? ' → saved to <code>' + escHtml(savedPath) + '</code>' : '') +
            (saveError ? ' <span style="color:#f87171">save failed: ' + escHtml(saveError) + '</span>' : '') +
            '</span></div>';
          var convInner = document.getElementById('conv-' + (convId || state.currentId));
          if (convInner) { convInner.appendChild(thumbEl); scrollBottom(); }

          var feedText = '[Browser extension snapshot' + (w.action.action === 'snapshot-full' ? ' (full page)' : '') +
            '] from: ' + snapUrl;
          if (savedPath) feedText += '\nSaved to disk at: ' + savedPath;
          else if (saveError) feedText += '\nSave to disk FAILED (' + saveError + ') — only available as vision attachment.';

          await sendDirectMessage(
            feedText,
            { image: 'data:' + snapMime + ';base64,' + result.base64, isBrowserFeed: true, targetConvId: convId }
          );
        }
      }

      if (w.action.action === 'tab:list') {
        var tlLines = (result.tabs||[]).map(function(t) {
          return '  [id:' + t.id + '] ' + (t.active ? '→ ' : '  ') + t.title + ' — ' + t.url;
        });
        var tlFeed = 'Browser tabs in real browser (' + (result.tabs||[]).length + '):\n' + tlLines.join('\n') +
          '';
        await browserFeedAI(tlFeed, convId);
      }

      if (w.action.action === 'tab:switch' || w.action.action === 'tab:new') {
        // Skip the auto-extract feed when a later action (snapshot/eval/extract)
        // in the same block will produce the real result. Otherwise this
        // intermediate feed starts a stream and the later result is dropped.
        if (!_hasDefinitiveFollowUp(widgets, i)) {
          try {
            var swRes = await executeExtAction({ action: 'extract' });
            var swFeed = (w.action.action === 'tab:switch' ? 'Switched to tab (ext)' : 'Opened new tab (ext)') +
              ':\n\n**Title:** ' + (swRes.title||'') + '\n**URL:** ' + (swRes.url||'') + '\n\n' + (swRes.text||'').slice(0, 12000) +
              '';
            await browserFeedAI(swFeed, convId);
          } catch(_) {}
        }
      }

      if (w.action.action === 'tab:close') {
        var closeFeed = 'Tab closed (ext). ' + (result.error ? 'Error: ' + result.error : 'OK.') +
          '';
        await browserFeedAI(closeFeed, convId);
      }

      if (w.action.action === 'wait') {
        var hasFollowWait = _hasDefinitiveFollowUp(widgets, i);
        if (!hasFollowWait) {
          try {
            var waitRes = await executeExtAction({ action: 'extract' });
            var waitFeed = 'After wait (ext) — page state:\n\n' +
              '**Title:** ' + (waitRes.title||'') + '\n**URL:** ' + (waitRes.url||'') +
              '\n\n' + (waitRes.text||'').slice(0, 12000) +
              '';
            await browserFeedAI(waitFeed, convId);
          } catch(_) {}
        }
      }

    } catch(e) {
      if (statusEl) { statusEl.className = 'ba-status err'; statusEl.textContent = 'Error: ' + e.message; }
      if (blockEl)  { blockEl.classList.remove('running'); }
      dbg('browser-ext-action error: ' + e.message, 'err');
      var errFeed = 'browser-ext-action `' + w.action.action + '` failed: ' + e.message +
        '\nDo NOT claim completion. Take a corrective browser-ext-action step next (retry, re-target tab, or extract current state).';
      try { await browserFeedAI(errFeed, convId); } catch(_) {}
      break;
    }
  }
  if (i >= widgets.length) _collapseCompletedChainActionMessage(widgets);
}

// ── Extension connection badge ─────────────────────────────────────────────
// Polls /api/ext/status every 5 s and updates the badge in the browser action bar
// + the input toolbar badge. Supports multiple simultaneous browsers.
// Also opens an SSE channel to /api/ext/events so push events (send-page, snapshot,
// selection) from the extension arrive as pending attachment chips in the input bar.

var _extConnectedBrowsers = []; // [{id, browser, version, connectedAt}]

(function() {
  var _wasConnected = false;

  function _updateExtBadge(browsers) {
    _extConnectedBrowsers = browsers || [];
    var connected = _extConnectedBrowsers.length > 0;
    var browserNames = _extConnectedBrowsers.map(function(b) { return b.browser; });
    var label = connected ? browserNames.join(' · ') : 'Web Browser MCP offline';

    // Browser action bar badge (inside browser pane)
    var dot   = document.getElementById('browser-ext-dot');
    var lbl   = document.getElementById('browser-ext-label');
    var badge = document.getElementById('browser-ext-badge');
    if (dot && lbl && badge) {
      if (connected) {
        dot.style.background = '#10b981';
        dot.style.boxShadow  = '0 0 5px #10b98166';
        lbl.textContent = label;
        badge.style.color       = '#10b981';
        badge.style.borderColor = '#10b98133';
        badge.style.background  = '#0d2b1f';
        badge.title = 'Connected: ' + label;
      } else {
        dot.style.background = '#444';
        dot.style.boxShadow  = 'none';
        lbl.textContent = 'Web Browser MCP offline';
        badge.style.color       = '#555';
        badge.style.borderColor = '#2a2a2a';
        badge.style.background  = '#111';
        badge.title = 'Web Browser MCP not connected';
      }
    }

    // Input toolbar badge
    var tbBadge = document.getElementById('ext-toolbar-badge');
    var tbLabel = document.getElementById('ext-toolbar-label');
    if (tbBadge) {
      if (connected) {
        tbBadge.classList.add('ext-connected');
        tbBadge.title = 'Connected: ' + label + ' — click to insert page context';
        if (tbLabel) tbLabel.textContent = browserNames.length > 1 ? browserNames.length + ' browsers' : browserNames[0];
      } else {
        tbBadge.classList.remove('ext-connected');
        tbBadge.title = 'Web Browser MCP not connected';
        if (tbLabel) tbLabel.textContent = 'Web Browser MCP';
      }
    }

    _wasConnected = connected;
  }

  async function _pollExtStatus() {
    try {
      var r = await fetch('/api/ext/status');
      var d = await r.json();
      _updateExtBadge(d.browsers || []);
    } catch (_) {
      _updateExtBadge([]);
    }
  }

  // ── Extension push events → pending attachment chips ──────────────────

  function _showExtToast(msg) {
    var toast = document.createElement('div');
    toast.className = 'ext-toast';
    toast.textContent = msg;
    document.body.appendChild(toast);
    requestAnimationFrame(function() { toast.classList.add('ext-toast-show'); });
    setTimeout(function() {
      toast.classList.remove('ext-toast-show');
      setTimeout(function() { if (toast.parentNode) toast.parentNode.removeChild(toast); }, 300);
    }, 3000);
  }

  function _handleExtEvent(evt) {
    var msg;
    try { msg = JSON.parse(evt.data); } catch (_) { return; }
    var d = msg.data || {};
    var bName = msg.browser || 'Browser';

    // Action recorder events → forward to the Recordings page if it's listening.
    if (msg.event && (msg.event.indexOf('recording:') === 0 || msg.event.indexOf('ext:recording-') === 0)) {
      if (typeof _onRecordingEvent === 'function') { try { _onRecordingEvent(msg); } catch (_) {} }
      return;
    }

    // Server pushes status-changed when a browser connects/disconnects
    if (msg.event === 'ext:status-changed') {
      _pollExtStatus();
      return;
    }

    if (msg.event === 'user:send-page') {
      var title   = d.title || d.url || bName + ' page';
      var short   = title.length > 45 ? title.slice(0, 42) + '…' : title;
      var content = (d.url   ? 'Source: ' + d.url + '\n' : '') +
                    (d.title ? 'Title: '  + d.title + '\n\n' : '') +
                    (d.text  || '');
      if (typeof addAttachment === 'function') {
        // Replace any prior unsent send-page from the same browser to avoid pileup
        if (state && Array.isArray(state.pendingAttachments)) {
          for (var _i = state.pendingAttachments.length - 1; _i >= 0; _i--) {
            var _a = state.pendingAttachments[_i];
            if (_a && _a.extSource === 'page' && _a.browser === bName) {
              if (typeof removeAttachment === 'function') removeAttachment(_i);
              else state.pendingAttachments.splice(_i, 1);
            }
          }
        }
        addAttachment({ type: 'url', extSource: 'page', name: bName + ': ' + short,
                        content: content, sourceUri: d.url, tabId: d.tabId, clientId: msg.id, browser: bName });
      }
      _showExtToast('Page from ' + bName + ' added — type your question');
    }

    if (msg.event === 'user:snapshot') {
      if (!d.base64) return;
      var _snapB64 = d.base64;
      var _snapMime = d.mime || 'image/png';
      // Strip any accidental `data:` prefix so the chip's <img> src doesn't
      // get a double-prefixed (broken) data URL.
      if (typeof _snapB64 === 'string') {
        var _snapM = _snapB64.match(/^data:([^;]+);base64,(.+)$/);
        if (_snapM) { _snapMime = _snapM[1]; _snapB64 = _snapM[2]; }
      }
      var snapTitle = d.title || d.url || bName + ' tab';
      var shortSnap = snapTitle.length > 40 ? snapTitle.slice(0, 37) + '…' : snapTitle;
      if (typeof addAttachment === 'function') {
        // Replace any prior unsent ext snapshot from the same browser. Repeated
        // snapshots accumulating in state.pendingAttachments (each ~100-500KB
        // base64) were ballooning memory and freezing the renderer.
        if (state && Array.isArray(state.pendingAttachments)) {
          for (var _j = state.pendingAttachments.length - 1; _j >= 0; _j--) {
            var _b = state.pendingAttachments[_j];
            if (_b && _b.extSource === 'snapshot') {
              if (typeof removeAttachment === 'function') removeAttachment(_j);
              else state.pendingAttachments.splice(_j, 1);
            }
          }
        }
        addAttachment({ type: 'image', extSource: 'snapshot', name: 'Snapshot — ' + shortSnap,
                        base64: _snapB64, mime: _snapMime, browser: bName });
      }
      _showExtToast('Snapshot from ' + bName + ' added');
    }

    if (msg.event === 'user:selection') {
      if (!d.text) return;
      var domain = '';
      try { domain = ' · ' + new URL(d.url).hostname; } catch (_) {}
      var selContent = (d.url   ? 'Source: ' + d.url + '\n' : '') +
                       (d.title ? 'Page: '   + d.title + '\n\n' : '') +
                       'Selected text:\n' + d.text;
      if (typeof addAttachment === 'function') {
        addAttachment({ type: 'url', extSource: 'selection',
                        name: 'Selection from ' + bName + domain,
                        content: selContent, sourceUri: d.url, tabId: d.tabId, clientId: msg.id, browser: bName });
      }
      _showExtToast('Selection from ' + bName + ' added');
    }
  }

  function _connectExtEvents() {
    var retries = 0;
    var current = null;
    var retryTimer = null;
    function connect() {
      if (current) { try { current.close(); } catch (_) {} current = null; }
      if (retryTimer) { clearTimeout(retryTimer); retryTimer = null; }
      var es = new EventSource(window.faunaStreamUrl ? window.faunaStreamUrl('/api/ext/events') : '/api/ext/events');
      current = es;
      es.onmessage = function(e) { retries = 0; _handleExtEvent(e); };
      es.onerror = function() {
        es.close();
        if (current === es) current = null;
        var delay = Math.min(1000 * Math.pow(2, retries), 30000);
        retries++;
        retryTimer = setTimeout(connect, delay);
      };
    }
    connect();
    // On wake/restore: close stale connection and reconnect immediately.
    // Covers both tab-visibility flips and OS network-suspend wake.
    document.addEventListener('visibilitychange', function() {
      if (document.visibilityState === 'visible') {
        retries = 0;
        connect();
      }
    });
    window.addEventListener('online', function () {
      retries = 0;
      connect();
    });
  }

  document.addEventListener('DOMContentLoaded', function() {
    _pollExtStatus();
    setInterval(_pollExtStatus, 5000);
    _connectExtEvents();
  });
  // Expose for external callers (e.g. + menu open refresh)
  window.refreshExtStatus = _pollExtStatus;
}());

// ── Extension tab menu (input toolbar) ────────────────────────────────────

var _extTabMenuOpen = false;

function toggleExtTabMenu() {
  _extTabMenuOpen = !_extTabMenuOpen;
  var menu = document.getElementById('ext-tab-menu');
  if (!menu) return;
  if (_extTabMenuOpen) {
    menu.style.display = '';
    _loadExtTabs();
    // Close on outside click
    setTimeout(function() {
      document.addEventListener('click', _closeExtTabMenuOutside, { once: true, capture: true });
    }, 0);
  } else {
    menu.style.display = 'none';
  }
}

function _closeExtTabMenuOutside(e) {
  var menu = document.getElementById('ext-tab-menu');
  var badge = document.getElementById('ext-toolbar-badge');
  if (menu && !menu.contains(e.target) && badge && !badge.contains(e.target)) {
    _extTabMenuOpen = false;
    menu.style.display = 'none';
  } else if (_extTabMenuOpen) {
    setTimeout(function() {
      document.addEventListener('click', _closeExtTabMenuOutside, { once: true, capture: true });
    }, 0);
  }
}

async function _loadExtTabs() {
  var menu = document.getElementById('ext-tab-menu');
  if (!menu) return;

  if (!_extConnectedBrowsers.length) {
    menu.innerHTML = '<div class="ext-menu-header">Web Browser MCP</div>' +
      '<div class="ext-menu-empty"><i class="ti ti-plug-off" style="font-size:16px;display:block;margin-bottom:4px"></i>' +
      'Extension not connected<br><span style="font-size:10px;color:var(--fau-text-muted)">Install from Plugins &amp; Extensions panel</span></div>';
    return;
  }

  menu.innerHTML = '<div class="ext-menu-header">Loading tabs…</div>' +
    '<div class="ext-menu-empty" style="padding:10px"><i class="ti ti-loader" style="animation:spin 1s linear infinite"></i></div>';

  try {
    // Prefer direct extension clients when available to avoid relay-vs-direct mismatches.
    var hasDirectClients = _extConnectedBrowsers.some(function(b) {
      var id = String((b && b.id) || '');
      return id && !id.startsWith('relay-') && id !== 'faunamcp';
    });
    var tabSources = hasDirectClients
      ? _extConnectedBrowsers.filter(function(b) {
          var id = String((b && b.id) || '');
          return id && !id.startsWith('relay-') && id !== 'faunamcp';
        })
      : _extConnectedBrowsers;

    // Fetch tabs from all selected browsers in parallel (route by unique clientId)
    // Count browser name occurrences to label duplicates (e.g. "Edge (1)", "Edge (2)")
    var _browserCounts = {};
    tabSources.forEach(function(b) { _browserCounts[b.browser] = (_browserCounts[b.browser] || 0) + 1; });
    var _browserSeen = {};
    var results = await Promise.all(tabSources.map(function(b) {
      _browserSeen[b.browser] = (_browserSeen[b.browser] || 0) + 1;
      var displayName = _browserCounts[b.browser] > 1
        ? b.browser + ' (' + _browserSeen[b.browser] + ')'
        : b.browser;
      return fetch('/api/ext/command', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'tab:list', clientId: b.id })
      }).then(function(r) { return r.json(); }).then(function(d) {
        return { browser: displayName, clientId: b.id, tabs: (d.ok && d.tabs) ? d.tabs : [] };
      }).catch(function() { return { browser: displayName, clientId: b.id, tabs: [] }; });
    }));

    var totalTabs = results.reduce(function(sum, r) { return sum + r.tabs.length; }, 0);
    if (totalTabs === 0) {
      menu.innerHTML = '<div class="ext-menu-header">Browser Tabs</div>' +
        '<div class="ext-menu-empty">No tabs found</div>';
      return;
    }

    var multiBrowser = results.length > 1;
    var html = '<div class="ext-menu-search-wrap">' +
      '<i class="ti ti-search" style="font-size:11px;color:var(--fau-text-muted);flex-shrink:0"></i>' +
      '<input id="ext-tab-search" type="text" placeholder="Filter tabs…" autocomplete="off" ' +
        'style="flex:1;background:none;border:none;outline:none;font-size:12px;color:var(--fau-text);padding:0" ' +
        'oninput="_filterExtTabs(this.value)">' +
    '</div>';

    results.forEach(function(res) {
      if (!res.tabs.length) return;
      html += '<div class="ext-menu-header">' +
        '<i class="ti ti-brand-' + res.browser.toLowerCase() + '" style="font-size:11px"></i> ' +
        escHtml(res.browser) + (multiBrowser ? ' (' + res.tabs.length + ')' : ' — ' + res.tabs.length + ' tabs') +
      '</div>';
      var cId = res.clientId || '';

      // Group tabs by windowId so each browser window appears as a separate block
      var windowMap = {};
      var windowOrder = [];
      res.tabs.forEach(function(tab) {
        var wid = tab.windowId != null ? tab.windowId : '__single__';
        if (!windowMap[wid]) { windowMap[wid] = []; windowOrder.push(wid); }
        windowMap[wid].push(tab);
      });

      var multiWindow = windowOrder.length > 1;
      windowOrder.forEach(function(wid, widx) {
        if (multiWindow) {
          html += '<div class="ext-menu-window-header" data-browser="' + escHtml(res.browser) + '">' +
            '<i class="ti ti-app-window" style="font-size:10px;opacity:0.55"></i> Window ' + (widx + 1) +
            ' <span style="opacity:0.45;font-weight:400">(' + windowMap[wid].length + ')</span>' +
          '</div>';
        }
        windowMap[wid].forEach(function(tab) {
          var title = tab.title || 'Untitled';
          var shortTitle = title.length > 38 ? title.slice(0, 35) + '…' : title;
          var domain = '';
          try { domain = new URL(tab.url).hostname; } catch (_) { domain = tab.url || ''; }
          var shortDomain = domain.length > 35 ? domain.slice(0, 32) + '…' : domain;
          var bAttr = ' data-browser="' + escHtml(res.browser) + '" data-client-id="' + escHtml(cId) + '"';
          var rowClick = 'extGrabPage(' + tab.id + ',\'' + escHtml(res.browser) + '\',\'' + escHtml(cId) + '\')';
          var snapClick = 'extGrabSnapshot(' + tab.id + ',\'' + escHtml(res.browser) + '\',\'' + escHtml(cId) + '\')';

          html += '<div class="ext-tab-item"' + bAttr + ' onclick="' + rowClick + '" title="Insert page content">' +
            (tab.active ? '<span class="ext-tab-active-dot" title="Active tab"></span>' : '<span style="width:5px;flex-shrink:0"></span>') +
            '<div class="ext-tab-info">' +
              '<div class="ext-tab-title">' + escHtml(shortTitle) + '</div>' +
              '<div class="ext-tab-url">' + escHtml(shortDomain) + '</div>' +
            '</div>' +
            '<div class="ext-tab-actions">' +
              '<button onclick="event.stopPropagation();' + rowClick + '" title="Insert page content"><i class="ti ti-file-text"></i></button>' +
              '<button onclick="event.stopPropagation();' + snapClick + '" title="Insert screenshot"><i class="ti ti-camera"></i></button>' +
            '</div>' +
          '</div>';
        });
      });
    });

    menu.innerHTML = html;
    // Autofocus search and keep focus inside menu (prevent outside-click from firing)
    setTimeout(function() {
      var inp = document.getElementById('ext-tab-search');
      if (inp) inp.focus();
    }, 0);
  } catch (e) {
    menu.innerHTML = '<div class="ext-menu-header">Browser Tabs</div>' +
      '<div class="ext-menu-empty" style="color:var(--error)">Error: ' + escHtml(e.message) + '</div>';
  }
}

function _filterExtTabs(query) {
  var q = query.trim().toLowerCase();
  var items = document.querySelectorAll('#ext-tab-menu .ext-tab-item');
  var headers = document.querySelectorAll('#ext-tab-menu .ext-menu-header');
  var windowHeaders = document.querySelectorAll('#ext-tab-menu .ext-menu-window-header');
  items.forEach(function(item) {
    var text = item.textContent.toLowerCase();
    item.style.display = (!q || text.includes(q)) ? '' : 'none';
  });
  // Hide window sub-headers when all their tabs are hidden
  windowHeaders.forEach(function(wh) {
    var next = wh.nextElementSibling;
    var hasVisible = false;
    while (next && (next.classList.contains('ext-tab-item') || next.classList.contains('ext-menu-window-header'))) {
      if (next.classList.contains('ext-tab-item') && next.style.display !== 'none') hasVisible = true;
      if (next.classList.contains('ext-menu-window-header')) break;
      next = next.nextElementSibling;
    }
    wh.style.display = hasVisible ? '' : 'none';
  });
  // Hide section headers when all their tabs are hidden
  headers.forEach(function(header) {
    var next = header.nextElementSibling;
    var hasVisible = false;
    while (next && (next.classList.contains('ext-tab-item') || next.classList.contains('ext-menu-window-header'))) {
      if (next.classList.contains('ext-tab-item') && next.style.display !== 'none') hasVisible = true;
      next = next.nextElementSibling;
    }
    header.style.display = hasVisible ? '' : 'none';
  });
}

async function extGrabPage(tabId, browser, clientId) {
  _extTabMenuOpen = false;
  var menu = document.getElementById('ext-tab-menu');
  if (menu) menu.style.display = 'none';

  try {
    var requestBrowser = String(browser || '').replace(/\s+\(\d+\)$/, '');
    // Cap the primary extract at 10s. If the content script is stuck (PDF
    // viewer, restricted page, slow SPA), we want to fall through to the
    // metadata fallback quickly instead of blocking the UI on the full
    // server-side 30s ceiling.
    var body = { action: 'extract', timeout: 10000 };
    if (tabId) body.tabId = tabId;
    if (clientId) body.clientId = clientId;
    else if (requestBrowser) body.browser = requestBrowser;
    var r = await fetch('/api/ext/command', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });
    var d = await r.json();
    if ((!d || d.ok === false) && clientId && String(clientId).startsWith('relay-')) {
      // Relay route failed: retry via direct route to match manual "Send page to Fauna" behavior.
      var retryBody = { action: 'extract', timeout: 10000 };
      if (tabId) retryBody.tabId = tabId;
      if (requestBrowser) retryBody.browser = requestBrowser;
      var r2 = await fetch('/api/ext/command', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(retryBody)
      });
      var d2 = await r2.json();
      if (d2 && d2.ok) d = d2;
    }
    if (!d.ok && d.error) throw new Error(d.error);

    var title   = d.title || d.url || 'Browser page';
    var short   = title.length > 45 ? title.slice(0, 42) + '…' : title;
    var prefix  = browser ? browser + ': ' : '';
    var content = (d.url   ? 'Source: ' + d.url + '\n' : '') +
                  (d.title ? 'Title: '  + d.title + '\n\n' : '') +
                  (d.content || d.text || '');

    if (typeof addAttachment === 'function') {
      addAttachment({ type: 'url', extSource: 'page', name: prefix + short, content: content, sourceUri: d.url, tabId: tabId, clientId: clientId, browser: browser });
    }
    if (typeof showToast === 'function') showToast('Page content added to context');
  } catch (e) {
    // Fallback path: when text extraction is blocked for this tab, attach
    // just the tab metadata so tab selection still yields useful context.
    // We deliberately do NOT pull a snapshot here — the user picked "Attach
    // tab", not "Attach snapshot"; that's a separate menu action. Attaching
    // both used to double-attach and roughly double the latency.
    try {
      var infoBody = { action: 'tab:info', timeout: 6000 };
      if (tabId) infoBody.tabId = tabId;
      if (clientId) infoBody.clientId = clientId;
      else if (browser) infoBody.browser = browser;
      var infoR = await fetch('/api/ext/command', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(infoBody)
      });
      var infoD = await infoR.json().catch(function() { return {}; });

      if (typeof addAttachment === 'function') {
        var url = (infoD && infoD.url) || '';
        var title = (infoD && infoD.title) || url || 'Browser tab';
        var infoText =
          (url ? 'Source: ' + url + '\n' : '') +
          (title ? 'Title: ' + title + '\n\n' : '') +
          'Full page text extraction was blocked for this tab. Use the "Attach snapshot" action if you need a screenshot.';
        addAttachment({ type: 'url', extSource: 'page', name: (browser ? browser + ': ' : '') + title, content: infoText, sourceUri: url, tabId: tabId, clientId: clientId, browser: browser });
      }

      if (typeof showToast === 'function') showToast('Tab added (metadata only — extraction blocked).');
      return;
    } catch (_) {}

    var msg = (e && e.message) ? e.message : String(e || 'Unknown error');
    if (/Cannot access this page\. Grant site access to the extension/i.test(msg)) {
      msg = 'Tab picker could not read this tab. In browser extension settings set Site access to On all sites (not On click), then retry.';
    }
    if (typeof showToast === 'function') showToast('Failed: ' + msg);
  }
}

async function extGrabSnapshot(tabId, browser, clientId) {
  _extTabMenuOpen = false;
  var menu = document.getElementById('ext-tab-menu');
  if (menu) menu.style.display = 'none';

  try {
    var body = { full: false };
    if (tabId) body.tabId = tabId;
    if (clientId) body.clientId = clientId;
    else if (browser) body.browser = browser;
    var r = await fetch('/api/ext/snapshot', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });
    var d = await r.json();
    if (!d.ok && d.error) throw new Error(d.error);

    var b64 = d.screenshot || d.base64;
    var mime = d.mime || 'image/png';
    // Some paths (older extensions, debugger CDP) may include a full
    // `data:image/...;base64,` prefix. Strip it so the chip doesn't end up
    // building `data:image/png;base64,data:image/jpeg;base64,...` which
    // renders as a broken image.
    if (typeof b64 === 'string') {
      var m = b64.match(/^data:([^;]+);base64,(.+)$/);
      if (m) { mime = m[1]; b64 = m[2]; }
    }
    if (!b64) throw new Error('No image data returned');

    var snapTitle = d.title || d.url || 'Browser tab';
    var shortSnap = snapTitle.length > 40 ? snapTitle.slice(0, 37) + '…' : snapTitle;

    if (typeof addAttachment === 'function') {
      addAttachment({ type: 'image', extSource: 'snapshot', name: 'Snapshot — ' + shortSnap, base64: b64, mime: mime });
    }
    if (typeof showToast === 'function') showToast('Screenshot added to context');
  } catch (e) {
    if (typeof showToast === 'function') showToast('Failed: ' + e.message);
  }
}
