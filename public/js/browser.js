// ── Browser Pane — per-conversation multi-tab ────────────────────────────

var _browserTabsByConv = {};  // convId → { tabs: [{id, title, url, wv}], activeTabId }
var _tabIdCounter = 0;
var _browserUA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36';

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
  wv.addEventListener('did-start-loading', function() {
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
  if (state.currentId === cid) browserSwitchTab(tabId, cid);
  else { b.activeTabId = tabId; wv.style.display = 'none'; }
  if (url) {
    if (!/^https?:\/\//i.test(url)) url = 'https://' + url;
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
  if (!/^https?:\/\//i.test(url)) url = 'https://' + url;
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

    handle.addEventListener('mousedown', function(e) {
      e.preventDefault();
      var pane = document.getElementById('browser-pane');
      var startX = e.clientX;
      var startW = pane.getBoundingClientRect().width;
      pane.classList.add('resizing');

      function onMove(e) {
        setWidth(startW + (startX - e.clientX));
      }
      function onUp() {
        document.getElementById('browser-pane').classList.remove('resizing');
        document.removeEventListener('mousemove', onMove);
        document.removeEventListener('mouseup', onUp);
      }
      document.addEventListener('mousemove', onMove);
      document.addEventListener('mouseup', onUp);
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
  return new Promise(function(resolve) {
    wv.addEventListener('dom-ready', function onReady() {
      wv.removeEventListener('dom-ready', onReady);
      resolve();
    });
    // Resolve immediately if already loaded (dom-ready won't fire again) — safety fallback 5s
    setTimeout(resolve, 5000);
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

async function executeBrowserAction(action) {
  var wv = getActiveWebview();

  if (action.action === 'navigate') {
    openBrowserPane(); // opens pane + ensures a tab exists
    wv = getActiveWebview();
    if (!wv) throw new Error('No browser tab available');

    // Wait for did-stop-loading (or 15s timeout) then a flat settle for SPA JS to run
    var loadDone = new Promise(function(resolve) {
      var onStop = function() { wv.removeEventListener('did-stop-loading', onStop); resolve(); };
      wv.addEventListener('did-stop-loading', onStop);
      setTimeout(resolve, 15000);
    });
    browserNavigateTo(action.url);
    await loadDone;
    await new Promise(function(r) { setTimeout(r, 1200); }); // flat settle for SPA hydration
    return { ok: true, url: wv.getURL() };

  } else if (!wv) {
    throw new Error('Browser pane not open — send a navigate action first');

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

  // Open browser pane now so user sees it immediately.
  // Don't pre-navigate — let the action sequence handle it to avoid a double load.
  var hasNav = actions.some(function(a) { return a.action === 'navigate' || a.action === 'new-tab'; });
  if (hasNav) { try { openBrowserPane(); } catch(e) { dbg('openBrowserPane: ' + e.message, 'err'); } }

  // Run all actions sequentially
  _runBrowserActionSequence(widgets, convId);
}

async function _runBrowserActionSequence(widgets, convId) {
  for (var i = 0; i < widgets.length; i++) {
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
            var navFeed = (navExtract.text
              ? 'Navigated and extracted page from browser panel:\n\n**Title:** ' + navExtract.title + '\n**URL:** ' + navExtract.url + '\n\n' + navExtract.text
              : 'Navigated to page in browser panel (no text content):\n**Title:** ' + navExtract.title + '\n**URL:** ' + navExtract.url);
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
            navFeed += '\n\nContinue your task immediately — emit the next browser-action blocks now.';
            await browserFeedAI(navFeed, convId);
          } catch(_) {}
        }
      }

      // If it was an extract, always feed result back to AI so it can continue
      if (w.action.action === 'extract') {
        var feedContent = (result.text
          ? 'Extracted page from browser panel:\n\n**Title:** ' + result.title + '\n**URL:** ' + result.url + '\n\n' + result.text
          : 'Page loaded in browser panel (no text content):\n**Title:** ' + result.title + '\n**URL:** ' + result.url)
          + '\n\nContinue your task immediately — emit the next browser-action blocks now.';
        await browserFeedAI(feedContent, convId);
      }
      // If it was an eval, feed result back too
      if (w.action.action === 'eval') {
        var evalFeed = 'Eval result from browser panel:\n```\n' + (result.result || '(empty)').slice(0, 8000) + '\n```'
          + '\n\nUse this information and continue your task immediately — emit the next browser-action blocks now.';
        await browserFeedAI(evalFeed, convId);
      }
      // If it was a click or wait and this is the last action (or no following extract),
      // auto-extract so the AI sees the resulting page and can keep going.
      if ((w.action.action === 'click' || w.action.action === 'wait') && !result.manual) {
        var hasLaterExtract = widgets.slice(i + 1).some(function(fw) { return fw.action.action === 'extract'; });
        if (!hasLaterExtract) {
          try {
            var clickExtract = await executeBrowserAction({ action: 'extract' });
            var clickFeed = (clickExtract.text
              ? 'Page after ' + w.action.action + ' in browser panel:\n\n**Title:** ' + clickExtract.title + '\n**URL:** ' + clickExtract.url + '\n\n' + clickExtract.text
              : 'Page after ' + w.action.action + ' in browser panel (no text content):\n**URL:** ' + clickExtract.url)
              + '\n\nContinue your task immediately — emit the next browser-action blocks now.';
            await browserFeedAI(clickFeed, convId);
          } catch(_) {}
        }
      }
      // new-tab with URL — auto-extract the loaded page
      if (w.action.action === 'new-tab' && w.action.url) {
        try {
          var ntExtract = await executeBrowserAction({ action: 'extract' });
          var ntFeed = 'Opened new tab and extracted page:\n\n**Title:** ' + (ntExtract.title||'') + '\n**URL:** ' + (ntExtract.url||'') + '\n\n' + (ntExtract.text||'').slice(0, 10000)
            + '\n\nContinue your task — emit the next browser-action blocks now.';
          await browserFeedAI(ntFeed, convId);
        } catch(_) {}
      }
      // switch-tab — tell AI which tab is now active + auto-extract
      if (w.action.action === 'switch-tab') {
        try {
          var stExtract = await executeBrowserAction({ action: 'extract' });
          var stFeed = 'Switched to tab: **' + (result.title||'') + '** (' + (result.url||'') + ')\n\n' + (stExtract.text||'').slice(0, 10000)
            + '\n\nContinue your task — emit the next browser-action blocks now.';
          await browserFeedAI(stFeed, convId);
        } catch(_) {}
      }
      // list-tabs — feed the tab list back
      if (w.action.action === 'list-tabs') {
        var ltLines = (result.tabs || []).map(function(t) {
          return '  [' + t.index + '] ' + (t.active ? '→ ' : '  ') + t.title + ' — ' + t.url;
        });
        var ltFeed = 'Browser tabs (' + result.totalTabs + '):\n' + ltLines.join('\n')
          + '\n\nContinue your task — emit the next browser-action blocks now.';
        await browserFeedAI(ltFeed, convId);
      }
      // extract-all — feed all tab contents back
      if (w.action.action === 'extract-all') {
        var eaLines = (result.tabs || []).map(function(t) {
          return '### Tab ' + t.index + ': ' + t.title + '\n**URL:** ' + t.url + '\n\n' + t.text;
        });
        var eaFeed = 'Extracted content from ' + result.totalTabs + ' tab(s):\n\n' + eaLines.join('\n\n---\n\n')
          + '\n\nContinue your task — emit the next browser-action blocks now.';
        await browserFeedAI(eaFeed, convId);
      }
      // console-logs — feed console output back to AI
      if (w.action.action === 'console-logs') {
        var clFeed = 'Console logs (' + result.returned + ' of ' + result.totalLogs + ' entries):\n```\n' + (result.logs||[]).join('\n') + '\n```'
          + '\n\nUse these logs to diagnose issues — emit the next browser-action blocks or fix the code now.';
        await browserFeedAI(clFeed, convId);
      }
      // If ask-user, show message in chat and stop sequence for manual step
      if (result.manual) {
        var notice = '**Action needed:** ' + (result.message || 'Please complete the step in the browser panel, then say "done" or "continue".');
        appendAINotice(notice, convId);
        break;
      }
    } catch(e) {
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
            '**Title:** ' + errD.title + '\n**URL:** ' + errD.url + '\n\n' + errD.text.slice(0, 10000) +
            '\n\nTry a different approach — emit the next browser-action blocks now.';
          await browserFeedAI(errFeed, convId);
        } catch(_) {}
      }
      break; // Stop sequence on error
    }
  }
}

// Send browser page/eval result to AI. Retries if the conv is still streaming.
// Awaiting this ensures the AI's response (and its new browser-action blocks) fully
// complete before the calling sequence considers itself done.
async function browserFeedAI(content, convId) {
  var targetId = convId || state.currentId;
  var conv = getConv(targetId);
  if (!conv) return;
  // Wait up to 6s for any in-flight stream to finish before we push the next message
  for (var w = 0; w < 12 && conv._streaming; w++) {
    await new Promise(function(r) { setTimeout(r, 500); });
  }
  if (conv._streaming) return; // give up — don't block forever
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
  var endpoint;
  if (action.action === 'snapshot' || action.action === 'snapshot-full') {
    endpoint = '/api/ext/snapshot';
    var snapR = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ full: action.action === 'snapshot-full', tabId: action.tabId || null })
    });
    var snapD = await snapR.json();
    if (!snapR.ok || !snapD.ok) throw new Error(snapD.error || 'Snapshot failed');
    return snapD;
  }

  // All other actions go through /api/ext/command
  var r = await fetch('/api/ext/command', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action: action.action, params: action, tabId: action.tabId || null })
  });
  var d = await r.json();
  if (!r.ok) throw new Error(d.error || 'Extension command failed');
  return d;
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
    fill:'ti-edit', click:'ti-cursor-text', scroll:'ti-arrows-down-up', hover:'ti-hand-finger',
    select:'ti-list', keyboard:'ti-keyboard', wait:'ti-clock', eval:'ti-terminal-2',
    snapshot:'ti-camera', 'snapshot-full':'ti-camera-plus',
    'tab:list':'ti-list', 'tab:new':'ti-plus', 'tab:switch':'ti-arrow-right',
    'tab:close':'ti-x', 'tab:info':'ti-info-circle'
  };
  var labelMap = {
    navigate:'Navigate (ext)', extract:'Extract (ext)', 'extract-forms':'Extract Forms (ext)',
    fill:'Fill Form (ext)', click:'Click (ext)', scroll:'Scroll (ext)', hover:'Hover (ext)',
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
    var allJsonl = lines.length > 1 && lines.every(function(l) {
      try { JSON.parse(l); return true; } catch(_) { return false; }
    });
    if (allJsonl) {
      lines.forEach(function(l) {
        try { parsedLines.push({ raw: l, action: JSON.parse(l) }); } catch(_) {}
      });
    } else {
      try { parsedLines.push({ raw: raw, action: JSON.parse(raw) }); } catch(e) {
        dbg('browser-ext-action parse error: ' + e.message, 'err');
        pre.remove(); return;
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
  _runExtActionSequence(widgets, convId);
}

async function _runExtActionSequence(widgets, convId) {
  for (var i = 0; i < widgets.length; i++) {
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
          '\n\nContinue your task — emit the next browser-ext-action blocks now.';
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
          '\n\nContinue your task — emit the next browser-ext-action blocks now.';
        await browserFeedAI(fillFeed, convId);
      }

      if (w.action.action === 'navigate') {
        var hasFollowExt = widgets.slice(i + 1).some(function(fw) { return fw.action.action === 'extract'; });
        if (!hasFollowExt) {
          try {
            var navRes = await executeExtAction({ action: 'extract' });
            var navFeed = 'Navigated (ext) and extracted page:\n\n**Title:** ' + (navRes.title||'') +
              '\n**URL:** ' + (navRes.url||'') + '\n\n' + (navRes.text||'').slice(0, 12000) +
              '\n\nContinue your task — emit the next browser-ext-action blocks now.';
            await browserFeedAI(navFeed, convId);
          } catch(_) {}
        }
      }

      if (w.action.action === 'click') {
        var hasFollowClick = widgets.slice(i + 1).some(function(fw) {
          return fw.action.action === 'extract' || fw.action.action === 'snapshot';
        });
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
              '\n\nContinue your task — emit the next browser-ext-action blocks now.';
            await browserFeedAI(clkFeed, convId);
          } catch(_) {}
        }
      }

      if (w.action.action === 'eval') {
        var evalFeed = 'Eval result from real browser tab:\n```\n' + (result.result||'(empty)').slice(0, 8000) + '\n```' +
          '\n\nUse this information and continue your task immediately.';
        await browserFeedAI(evalFeed, convId);
      }

      // snapshot — inject image into AI
      if (w.action.action === 'snapshot' || w.action.action === 'snapshot-full') {
        if (result.base64) {
          var snapTabInfo = await executeExtAction({ action: 'tab:info' }).catch(function() { return {}; });
          await sendDirectMessage(
            '[Browser extension snapshot' + (w.action.action === 'snapshot-full' ? ' (full page)' : '') +
            '] from: ' + (snapTabInfo.url || 'browser'),
            { image: 'data:image/png;base64,' + result.base64 }
          );
        }
      }

      if (w.action.action === 'tab:list') {
        var tlLines = (result.tabs||[]).map(function(t) {
          return '  [id:' + t.id + '] ' + (t.active ? '→ ' : '  ') + t.title + ' — ' + t.url;
        });
        var tlFeed = 'Browser tabs in real browser (' + (result.tabs||[]).length + '):\n' + tlLines.join('\n') +
          '\n\nContinue your task — emit the next browser-ext-action blocks now.';
        await browserFeedAI(tlFeed, convId);
      }

      if (w.action.action === 'tab:switch' || w.action.action === 'tab:new') {
        try {
          var swRes = await executeExtAction({ action: 'extract' });
          var swFeed = (w.action.action === 'tab:switch' ? 'Switched to tab (ext)' : 'Opened new tab (ext)') +
            ':\n\n**Title:** ' + (swRes.title||'') + '\n**URL:** ' + (swRes.url||'') + '\n\n' + (swRes.text||'').slice(0, 12000) +
            '\n\nContinue your task — emit the next browser-ext-action blocks now.';
          await browserFeedAI(swFeed, convId);
        } catch(_) {}
      }

    } catch(e) {
      if (statusEl) { statusEl.className = 'ba-status err'; statusEl.textContent = 'Error: ' + e.message; }
      if (blockEl)  { blockEl.classList.remove('running'); }
      dbg('browser-ext-action error: ' + e.message, 'err');
      var errFeed = 'browser-ext-action `' + w.action.action + '` failed: ' + e.message +
        '\n\nTry a different approach — emit corrected browser-ext-action blocks now.';
      try { await browserFeedAI(errFeed, convId); } catch(_) {}
      break;
    }
  }
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
    var label = connected ? browserNames.join(' · ') : 'Ext offline';

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
        lbl.textContent = 'Ext offline';
        badge.style.color       = '#555';
        badge.style.borderColor = '#2a2a2a';
        badge.style.background  = '#111';
        badge.title = 'Browser extension not connected';
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
        tbBadge.title = 'Browser extension offline';
        if (tbLabel) tbLabel.textContent = 'Ext';
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
        addAttachment({ type: 'url', extSource: 'page', name: bName + ': ' + short,
                        content: content, sourceUri: d.url });
      }
      _showExtToast('Page from ' + bName + ' added — type your question');
    }

    if (msg.event === 'user:snapshot') {
      if (!d.base64) return;
      var snapTitle = d.title || d.url || bName + ' tab';
      var shortSnap = snapTitle.length > 40 ? snapTitle.slice(0, 37) + '…' : snapTitle;
      if (typeof addAttachment === 'function') {
        addAttachment({ type: 'image', extSource: 'snapshot', name: 'Snapshot — ' + shortSnap,
                        base64: d.base64, mime: d.mime || 'image/png' });
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
                        content: selContent, sourceUri: d.url });
      }
      _showExtToast('Selection from ' + bName + ' added');
    }
  }

  function _connectExtEvents() {
    var es = new EventSource('/api/ext/events');
    es.onmessage = _handleExtEvent;
    es.onerror = function() {
      es.close();
      setTimeout(_connectExtEvents, 5000);
    };
  }

  document.addEventListener('DOMContentLoaded', function() {
    _pollExtStatus();
    setInterval(_pollExtStatus, 5000);
    _connectExtEvents();
  });
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
    menu.innerHTML = '<div class="ext-menu-header">Browser Extension</div>' +
      '<div class="ext-menu-empty"><i class="ti ti-plug-off" style="font-size:16px;display:block;margin-bottom:4px"></i>' +
      'Extension not connected<br><span style="font-size:10px;color:var(--text-muted)">Install from Plugins &amp; Extensions panel</span></div>';
    return;
  }

  menu.innerHTML = '<div class="ext-menu-header">Loading tabs…</div>' +
    '<div class="ext-menu-empty" style="padding:10px"><i class="ti ti-loader" style="animation:spin 1s linear infinite"></i></div>';

  try {
    // Fetch tabs from all connected browsers in parallel
    var results = await Promise.all(_extConnectedBrowsers.map(function(b) {
      return fetch('/api/ext/command', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'tab:list', browser: b.browser })
      }).then(function(r) { return r.json(); }).then(function(d) {
        return { browser: b.browser, tabs: (d.ok && d.tabs) ? d.tabs : [] };
      }).catch(function() { return { browser: b.browser, tabs: [] }; });
    }));

    var totalTabs = results.reduce(function(sum, r) { return sum + r.tabs.length; }, 0);
    if (totalTabs === 0) {
      menu.innerHTML = '<div class="ext-menu-header">Browser Tabs</div>' +
        '<div class="ext-menu-empty">No tabs found</div>';
      return;
    }

    var multiBrowser = results.length > 1;
    var html = '';

    results.forEach(function(res) {
      if (!res.tabs.length) return;
      html += '<div class="ext-menu-header">' +
        '<i class="ti ti-brand-' + res.browser.toLowerCase() + '" style="font-size:11px"></i> ' +
        escHtml(res.browser) + (multiBrowser ? ' (' + res.tabs.length + ')' : ' — ' + res.tabs.length + ' tabs') +
      '</div>';
      res.tabs.forEach(function(tab) {
        var title = tab.title || 'Untitled';
        var shortTitle = title.length > 38 ? title.slice(0, 35) + '…' : title;
        var domain = '';
        try { domain = new URL(tab.url).hostname; } catch (_) { domain = tab.url || ''; }
        var shortDomain = domain.length > 35 ? domain.slice(0, 32) + '…' : domain;
        var bAttr = ' data-browser="' + escHtml(res.browser) + '"';

        html += '<div class="ext-tab-item"' + bAttr + '>' +
          (tab.active ? '<span class="ext-tab-active-dot" title="Active tab"></span>' : '<span style="width:5px;flex-shrink:0"></span>') +
          '<div class="ext-tab-info">' +
            '<div class="ext-tab-title">' + escHtml(shortTitle) + '</div>' +
            '<div class="ext-tab-url">' + escHtml(shortDomain) + '</div>' +
          '</div>' +
          '<div class="ext-tab-actions">' +
            '<button onclick="extGrabPage(' + tab.id + ',\'' + escHtml(res.browser) + '\')" title="Insert page content"><i class="ti ti-file-text"></i></button>' +
            '<button onclick="extGrabSnapshot(' + tab.id + ',\'' + escHtml(res.browser) + '\')" title="Insert screenshot"><i class="ti ti-camera"></i></button>' +
          '</div>' +
        '</div>';
      });
    });

    menu.innerHTML = html;
  } catch (e) {
    menu.innerHTML = '<div class="ext-menu-header">Browser Tabs</div>' +
      '<div class="ext-menu-empty" style="color:var(--error)">Error: ' + escHtml(e.message) + '</div>';
  }
}

async function extGrabPage(tabId, browser) {
  _extTabMenuOpen = false;
  var menu = document.getElementById('ext-tab-menu');
  if (menu) menu.style.display = 'none';

  try {
    var body = { action: 'extract' };
    if (tabId) body.tabId = tabId;
    if (browser) body.browser = browser;
    var r = await fetch('/api/ext/command', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });
    var d = await r.json();
    if (!d.ok && d.error) throw new Error(d.error);

    var title   = d.title || d.url || 'Browser page';
    var short   = title.length > 45 ? title.slice(0, 42) + '…' : title;
    var prefix  = browser ? browser + ': ' : '';
    var content = (d.url   ? 'Source: ' + d.url + '\n' : '') +
                  (d.title ? 'Title: '  + d.title + '\n\n' : '') +
                  (d.content || d.text || '');

    if (typeof addAttachment === 'function') {
      addAttachment({ type: 'url', extSource: 'page', name: prefix + short, content: content, sourceUri: d.url });
    }
    if (typeof showToast === 'function') showToast('Page content added to context');
  } catch (e) {
    if (typeof showToast === 'function') showToast('Failed: ' + e.message);
  }
}

async function extGrabSnapshot(tabId, browser) {
  _extTabMenuOpen = false;
  var menu = document.getElementById('ext-tab-menu');
  if (menu) menu.style.display = 'none';

  try {
    var body = { full: false };
    if (tabId) body.tabId = tabId;
    if (browser) body.browser = browser;
    var r = await fetch('/api/ext/snapshot', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });
    var d = await r.json();
    if (!d.ok && d.error) throw new Error(d.error);

    var b64 = d.screenshot || d.base64;
    var mime = d.mime || 'image/png';
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
