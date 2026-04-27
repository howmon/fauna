// ── Debug logger ──────────────────────────────────────────────────────────
var _debugLogs = [];
function dbg(msg, type) {
  var ts = new Date().toISOString().slice(11,23);
  var colors = { info:'#58a6ff', ok:'#3fb950', warn:'#d29922', err:'#f85149', cmd:'#bc8cff' };
  var color = colors[type] || '#8b949e';
  var entry = { ts, msg, color };
  _debugLogs.push(ts + ' ' + msg);
  var el = document.getElementById('debug-log');
  if (el) {
    var row = document.createElement('div');
    row.style.cssText = 'color:' + color + ';word-break:break-all';
    row.textContent = ts + '  ' + msg;
    el.appendChild(row);
    el.scrollTop = el.scrollHeight;
  }
  console.debug('[dbg]', msg);
}
function toggleDebugLog() {
  var p = document.getElementById('debug-panel');
  var isVisible = p.style.display !== 'none' && p.style.display !== '';
  p.style.display = isVisible ? 'none' : 'flex';
}
function copyDebugLog() {
  navigator.clipboard.writeText(_debugLogs.join('\n')).then(function() {
    var btn = document.querySelector('#debug-panel button');
    if (btn) { var old = btn.textContent; btn.textContent = 'Copied!'; setTimeout(function(){ btn.textContent = old; }, 1500); }
  });
}
function clearDebugLog() {
  _debugLogs = [];
  var el = document.getElementById('debug-log');
  if (el) el.innerHTML = '';
}

// ── Theme toggle (light / dark / system) ──────────────────────────────────
function getPreferredTheme() {
  var stored = localStorage.getItem('fauna-theme');
  if (stored === 'light' || stored === 'dark') return stored;
  return window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
}

function applyTheme(theme) {
  document.documentElement.setAttribute('data-theme', theme);
  // Swap highlight.js stylesheet
  var hljsLink = document.getElementById('hljs-theme');
  if (hljsLink) {
    hljsLink.href = theme === 'light'
      ? 'https://cdnjs.cloudflare.com/ajax/libs/highlight.js/11.11.1/styles/github.min.css'
      : 'https://cdnjs.cloudflare.com/ajax/libs/highlight.js/11.11.1/styles/github-dark.min.css';
  }
  // Update toggle button icon
  var btn = document.getElementById('theme-toggle-btn');
  if (btn) {
    var icon = btn.querySelector('i');
    if (icon) {
      icon.className = theme === 'light' ? 'ti ti-sun' : 'ti ti-moon';
    }
    btn.title = theme === 'light' ? 'Switch to dark mode' : 'Switch to light mode';
  }
}

function toggleTheme() {
  document.documentElement.classList.add('theme-transition');
  var current = document.documentElement.getAttribute('data-theme') || 'dark';
  var next = current === 'dark' ? 'light' : 'dark';
  localStorage.setItem('fauna-theme', next);
  applyTheme(next);
  setTimeout(function() { document.documentElement.classList.remove('theme-transition'); }, 250);
}

// Apply theme on load
applyTheme(getPreferredTheme());

// Listen for system theme changes
window.matchMedia('(prefers-color-scheme: light)').addEventListener('change', function() {
  if (!localStorage.getItem('fauna-theme')) applyTheme(getPreferredTheme());
});


var allModels = [];

async function loadModels() {
  try {
    const r = await fetch('/api/models');
    const d = await r.json();
    allModels = d.models || [];
  } catch (e) {}
  if (!allModels.length) allModels = [
    { id: 'claude-sonnet-4.6', name: 'Claude Sonnet 4.6', vendor: 'Anthropic' },
    { id: 'gpt-4.1',           name: 'GPT-4.1',           vendor: 'OpenAI' },
    { id: 'gpt-4.1-mini',      name: 'GPT-4.1 mini',      vendor: 'OpenAI' },
    { id: 'gemini-2.0-flash',  name: 'Gemini 2.0 Flash',  vendor: 'Google' },
  ];
  populateModelSelect();
}

function populateModelSelect() {
  var sel = document.getElementById('model-select');
  sel.innerHTML = '';

  // 4 groups: GitHub CLI, OpenAI, Anthropic, Google
  var groups = {
    'GitHub CLI':  allModels.filter(m => m.provider === 'copilot'),
    'OpenAI':      allModels.filter(m => m.provider === 'openai'),
    'Anthropic':   allModels.filter(m => m.provider === 'anthropic'),
    'Google':      allModels.filter(m => m.provider === 'google'),
  };

  Object.entries(groups).forEach(([label, models]) => {
    if (!models.length) return;
    var grp = document.createElement('optgroup');
    grp.label = label;
    models.forEach(m => {
      var opt = document.createElement('option');
      opt.value = m.id;
      opt.textContent = m.name + (m.fast ? ' ·' : '');
      opt.selected = m.id === state.model;
      grp.appendChild(opt);
    });
    sel.appendChild(grp);
  });
}

function onModelChange(id) {
  state.model = id;
  localStorage.setItem('fauna-model', id);
  var m = allModels.find(m => m.id === id);
  if (m) showToast('Model: ' + m.name);
}

// ── Auth & Settings ───────────────────────────────────────────────────────

var settingsOpen = false;

function toggleSettings() {
  settingsOpen = !settingsOpen;
  document.getElementById('settings-panel').classList.toggle('open', settingsOpen);
  if (settingsOpen) loadSettingsState();
}

// ── More overflow menu ────────────────────────────────────────────────────
function toggleMoreMenu(e) {
  if (e) e.stopPropagation();
  var m = document.getElementById('more-menu');
  var vis = m.style.display !== 'none';
  m.style.display = vis ? 'none' : '';
  if (!vis) {
    // Close on next click anywhere
    setTimeout(function() {
      document.addEventListener('click', _closeMoreOnce, { once: true });
    }, 0);
  }
}
function hideMoreMenu() {
  document.getElementById('more-menu').style.display = 'none';
}
function _closeMoreOnce() { hideMoreMenu(); }

// ── Mobile QR pairing (in Settings panel) ────────────────────────────────
async function loadMobilePairQR() {
  var canvas = document.getElementById('mobile-qr-canvas');
  var status = document.getElementById('mobile-qr-status');
  var info = document.getElementById('mobile-pair-info');
  if (!canvas) return;
  status.textContent = 'Loading…';
  try {
    var res = await fetch('/api/mobile/pair');
    var data = await res.json();
    var url = data.primaryQr;
    if (!url) { status.textContent = 'No network interfaces found'; return; }
    // Use server-generated QR data URL (works offline in Electron)
    if (data.qrImage) {
      // Replace canvas with img if needed
      var img = document.getElementById('mobile-qr-img');
      if (!img) {
        img = document.createElement('img');
        img.id = 'mobile-qr-img';
        img.style.cssText = 'width:200px;height:200px;border-radius:8px;image-rendering:pixelated';
        canvas.parentNode.insertBefore(img, canvas);
        canvas.style.display = 'none';
      }
      img.src = data.qrImage;
    } else if (typeof QRCode !== 'undefined' && QRCode.toCanvas) {
      // Fallback to client-side rendering if CDN loaded
      await QRCode.toCanvas(canvas, url, { width: 200, margin: 2, color: { dark: '#000', light: '#fff' } });
    } else {
      status.textContent = 'QR generation failed';
      return;
    }
    status.textContent = 'Scan with Fauna mobile app';
    // Show connection info
    var ipList = (data.ips || []).map(function(ip) { return ip + ':' + data.port; }).join(', ');
    info.innerHTML = '<strong>Server:</strong> ' + (data.hostname || 'unknown') + '<br>' +
      '<strong>Address:</strong> ' + ipList + '<br>' +
      '<strong>Token:</strong> <code style="font-size:10px;background:var(--surface3);padding:1px 4px;border-radius:3px">' + data.token.slice(0,8) + '…</code>';
  } catch (e) {
    status.textContent = 'Failed to load pairing info';
  }
}

async function resetMobilePairToken() {
  if (!confirm('Reset pairing token? All connected mobile devices will need to re-pair.')) return;
  try {
    await fetch('/api/mobile/pair/reset', { method: 'POST' });
    loadMobilePairQR();
  } catch (e) {
    alert('Failed: ' + e.message);
  }
}

async function loadSettingsState() {
  // Sync auto-run checkbox
  var cb = document.getElementById('autorun-toggle');
  if (cb) cb.checked = state.autoRunShell;

  // Sync thinking budget
  var tb = document.getElementById('thinking-budget-select');
  if (tb) tb.value = state.thinkingBudget;
  var hint = document.getElementById('thinking-budget-hint');
  if (hint) hint.textContent = _thinkingHints[state.thinkingBudget] || '';

  // Sync max context turns
  var range = document.getElementById('max-turns-range');
  if (range) range.value = state.maxContextTurns;
  var lbl = document.getElementById('max-turns-label');
  if (lbl) lbl.textContent = state.maxContextTurns === 100 ? 'Max' : state.maxContextTurns;

  // Load current PAT status
  const tokenRes = await fetch('/api/token').catch(() => ({}));
  const tokenData = tokenRes.ok ? await tokenRes.json() : {};
  if (tokenData.hasPat) {
    document.getElementById('pat-input').placeholder = 'Saved: ' + tokenData.preview;
    document.getElementById('clear-pat-btn').style.display = '';
  } else {
    document.getElementById('pat-input').placeholder = 'ghp_… or github_pat_…';
    document.getElementById('clear-pat-btn').style.display = 'none';
  }
  checkAuth();
  loadProviderStatus();
  loadMobilePairQR();
}async function checkAuth() {
  var pill  = document.getElementById('auth-pill');
  var badge = document.getElementById('auth-badge');
  try {
    var r = await fetch('/api/auth');
    var d = await r.json();
    if (d.authenticated) {
      const sourceLabel = { pat: 'PAT', keychain: 'Keychain', env: 'Env', direct: 'API Key' }[d.source] || d.source || '';
      const directInfo = d.directProviders && d.directProviders.length ? ' + ' + d.directProviders.join(', ') : '';
      if (pill) {
        pill.className = 'ok';
        pill.innerHTML = '<i class="ti ti-circle-check"></i> ' + (sourceLabel || 'Auth OK');
      }
      if (badge) {
        badge.className = 'auth-source-badge ok';
        badge.innerHTML = '<i class="ti ti-check"></i> ' + sourceLabel + directInfo + (d.source !== 'direct' && d.preview ? ' · ' + d.preview : '');
      }
    } else {
      if (pill) {
        pill.className = 'err';
        pill.innerHTML = '<i class="ti ti-alert-circle"></i> Not authenticated';
      }
      if (badge) {
        badge.className = 'auth-source-badge err';
        badge.innerHTML = '<i class="ti ti-x"></i> ' + (d.error || 'Not authenticated');
      }
    }
  } catch (e) {
    if (pill) {
      pill.className = 'dim';
      pill.innerHTML = '<i class="ti ti-wifi-off"></i> Offline';
    }
    if (badge) { badge.className = 'auth-source-badge err'; badge.innerHTML = '<i class="ti ti-x"></i> Server offline'; }
  }
}

async function savePat() {
  var input  = document.getElementById('pat-input');
  var status = document.getElementById('pat-status');
  var pat    = input.value.trim();
  if (!pat) { status.className = 'settings-status err'; status.textContent = 'Please enter a token.'; return; }

  status.className = 'settings-status'; status.textContent = 'Saving…';

  try {
    var r = await fetch('/api/token', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ pat })
    });
    var d = await r.json();
    if (!r.ok || d.error) throw new Error(d.error || 'Failed');

    status.className = 'settings-status ok';
    status.innerHTML = '<i class="ti ti-check"></i> Token saved (' + d.preview + ')';
    input.value = '';
    input.placeholder = 'Saved: ' + d.preview;
    document.getElementById('clear-pat-btn').style.display = '';
    checkAuth();
    showToast('Token saved');
  } catch (err) {
    status.className = 'settings-status err';
    status.innerHTML = '<i class="ti ti-x"></i> ' + err.message;
  }
}

async function clearPat() {
  await fetch('/api/token', { method: 'DELETE' });
  document.getElementById('pat-input').placeholder = 'ghp_… or github_pat_…';
  document.getElementById('pat-input').value = '';
  document.getElementById('clear-pat-btn').style.display = 'none';
  document.getElementById('pat-status').textContent = '';
  checkAuth();
  showToast('Token removed');
}

function togglePatVisibility() {
  var input = document.getElementById('pat-input');
  input.type = input.type === 'password' ? 'text' : 'password';
}

function openGithubTokenPage() {
  // Works in Electron (opens in default browser via main.js handler) and normal browser
  window.open('https://github.com/settings/tokens/new?scopes=&description=Fauna', '_blank');
}

// ── Direct provider key management ────────────────────────────────────────

async function loadProviderStatus() {
  try {
    var r = await fetch('/api/providers');
    var d = await r.json();
    (d.providers || []).forEach(function(p) {
      var status = document.getElementById('provider-' + p.id + '-status');
      var clear  = document.getElementById('provider-' + p.id + '-clear');
      var input  = document.getElementById('provider-' + p.id + '-input');
      if (p.configured) {
        if (status) { status.className = 'settings-status ok'; status.innerHTML = '<i class="ti ti-check"></i> Configured (' + p.preview + ')'; }
        if (clear)  clear.style.display = '';
        if (input)  input.placeholder = 'Saved: ' + p.preview;
      } else {
        if (status) { status.className = 'settings-status'; status.textContent = ''; }
        if (clear)  clear.style.display = 'none';
      }
    });
  } catch (_) {}
}

async function saveProviderKey(provider) {
  var input  = document.getElementById('provider-' + provider + '-input');
  var status = document.getElementById('provider-' + provider + '-status');
  var key    = input.value.trim();
  if (!key) { status.className = 'settings-status err'; status.textContent = 'Please enter an API key.'; return; }
  status.className = 'settings-status'; status.textContent = 'Saving…';
  try {
    var r = await fetch('/api/providers/' + provider + '/key', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ key: key })
    });
    var d = await r.json();
    if (!r.ok || d.error) throw new Error(d.error || 'Failed');
    status.className = 'settings-status ok';
    status.innerHTML = '<i class="ti ti-check"></i> Saved (' + d.preview + ')';
    input.value = '';
    input.placeholder = 'Saved: ' + d.preview;
    document.getElementById('provider-' + provider + '-clear').style.display = '';
    showToast(provider.charAt(0).toUpperCase() + provider.slice(1) + ' key saved');
    checkAuth();
    refreshModelList();
  } catch (err) {
    status.className = 'settings-status err';
    status.innerHTML = '<i class="ti ti-x"></i> ' + err.message;
  }
}

async function clearProviderKey(provider) {
  await fetch('/api/providers/' + provider + '/key', { method: 'DELETE' });
  var input = document.getElementById('provider-' + provider + '-input');
  input.placeholder = input.dataset.defaultPlaceholder || '';
  input.value = '';
  document.getElementById('provider-' + provider + '-clear').style.display = 'none';
  document.getElementById('provider-' + provider + '-status').textContent = '';
  showToast(provider.charAt(0).toUpperCase() + provider.slice(1) + ' key removed');
  checkAuth();
  refreshModelList();
}

function toggleProviderKeyVisibility(provider) {
  var input = document.getElementById('provider-' + provider + '-input');
  input.type = input.type === 'password' ? 'text' : 'password';
}

function switchAuthTab(tab) {
  document.querySelectorAll('.auth-tab').forEach(t => t.classList.remove('active'));
  document.getElementById('auth-tab-cli').style.display = tab === 'cli' ? '' : 'none';
  document.getElementById('auth-tab-keys').style.display = tab === 'keys' ? '' : 'none';
  event.target.classList.add('active');
}

async function refreshModelList() {
  // Re-fetch model list from server and update the dropdown
  await loadModels();
}


// ── DOM helpers ───────────────────────────────────────────────────────────

function createMessageEl(role, agentInfo) {
  var div = document.createElement('div');
  div.className = 'msg ' + role;
  var avatar, name;
  if (role === 'user') {
    avatar = '<i class="ti ti-user"></i>';
    name = 'You';
  } else if (agentInfo && agentInfo.displayName) {
    avatar = '<i class="ti ' + escHtml(agentInfo.icon || 'ti-robot') + '"></i>';
    name = escHtml(agentInfo.displayName);
    div.dataset.agentName = agentInfo.name || '';
  } else {
    avatar = '<i class="ti ti-sparkles"></i>';
    name = 'Fauna';
  }
  var time   = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  div.innerHTML =
    '<div class="msg-header">' +
      '<div class="msg-avatar">' + avatar + '</div>' +
      '<span class="msg-name">' + name + '</span>' +
      '<span class="msg-time">' + time + '</span>' +
      '<div class="msg-actions">' +
        '<button class="msg-action-btn" onclick="copyMsg(this)">Copy</button>' +
        (role === 'assistant' ? '<button class="msg-action-btn" onclick="regenMsg(this)">↺ Regen</button>' : '') +
      '</div>' +
    '</div>' +
    '<div class="msg-body"></div>';
  return div;
}

function appendMessageDOM(role, content, attachments, animate, agentInfo, isHTML) {
  var el     = createMessageEl(role, agentInfo);
  var body   = el.querySelector('.msg-body');
  if (!animate) el.style.animation = 'none';

  if (attachments && attachments.length) {
    var chips = attachments.map(a => {
      if (a.type === 'image') {
        return '<span class="attach-chip attach-chip-image">' +
          (a.base64 ? '<img class="attach-img-thumb" src="data:' + (a.mime||'image/png') + ';base64,' + a.base64 + '">' : '<i class="ti ti-photo"></i>') +
          '<span>' + escHtml(a.name) + '</span></span>';
      }
      return '<span class="attach-chip"><span class="chip-icon">' + (a.type === 'url' ? '<i class="ti ti-link"></i>' : '<i class="ti ti-paperclip"></i>') + '</span>' + escHtml(a.name) + '</span>';
    }).join('');
    body.innerHTML = '<div class="msg-attachments">' + chips + '</div>';
  }

  if (role === 'user') {
    // Split off attachment fences for display
    var display = content.split(/\n\n```\n\/\/ (File|URL):/)[0].trim();
    body.innerHTML += (display ? escHtml(display).replace(/\n/g, '<br>') : '');
  } else if (isHTML) {
    body.innerHTML += content;
  } else {
    // Sanitize write-file blocks — re-populates _wfContentStore from saved message content
    var renderContent = sanitizeWriteFileBlocks(content);
    body.innerHTML += renderMarkdown(renderContent);
    extractAndRenderFigmaExec(content, el);
    extractAndRenderShellExec(content, el, true); // history load — never auto-run old commands
    extractAndRenderBrowserActions(content, el, true);
    if (typeof extractAndRenderBrowserExtActions === 'function') extractAndRenderBrowserExtActions(content, el, true);
    extractAndRenderWriteFile(el, true);
    extractAndRenderSaveInstruction(content, el, true);
    extractArtifactsFromBuffer(content, el, false);
    wrapInChainOfThought(el);
  }

  getConvInner(state.currentId).appendChild(el);
}

function setBusy(busy) {
  document.getElementById('send-btn').disabled = busy;
  var stopEl = document.getElementById('stop-btn');
  stopEl.className = busy ? 'show' : '';
}

function showMessages() {
  document.getElementById('empty-state').classList.add('hidden');
  document.getElementById('messages').style.display = 'block';
}

function showEmpty() {
  document.getElementById('empty-state').classList.remove('hidden');
  document.getElementById('messages').style.display = 'none';
}

function scrollBottom() {
  var el = document.getElementById('messages');
  el.scrollTop = el.scrollHeight;
}

// ── Copy & Regen ──────────────────────────────────────────────────────────

function copyMsg(btn) {
  var body = btn.closest('.msg').querySelector('.msg-body').innerText;
  navigator.clipboard.writeText(body).then(() => showToast('Copied!'));
}

function regenMsg(btn) {
  var conv = getConv(state.currentId);
  if (!conv || conv._streaming) return;
  // Remove last AI message
  var lastAI = conv.messages.findLastIndex ? conv.messages.findLastIndex(m => m.role === 'assistant') : -1;
  if (lastAI < 0) {
    for (var i = conv.messages.length - 1; i >= 0; i--) {
      if (conv.messages[i].role === 'assistant') { lastAI = i; break; }
    }
  }
  if (lastAI >= 0) {
    conv.messages.splice(lastAI, 1);
    saveConversations();
    // Remove from DOM
    var convInner = getConvInner(state.currentId);
    var allMsgEls = convInner.querySelectorAll('.msg.ai');
    var last = allMsgEls[allMsgEls.length - 1];
    if (last) last.remove();
    streamResponse(conv);
  }
}

function copyCode(btn) {
  var code = btn.closest('pre').querySelector('code').innerText;
  navigator.clipboard.writeText(code).then(() => {
    btn.textContent = 'Copied!';
    btn.classList.add('copied');
    setTimeout(() => { btn.textContent = 'Copy'; btn.classList.remove('copied'); }, 2000);
  });
}

// ── File attachment ───────────────────────────────────────────────────────

function openFileAttach() { document.getElementById('file-input').click(); }

function _toBase64(buffer) {
  var bytes = new Uint8Array(buffer);
  var chunk = 0x8000;
  var binary = '';
  for (var i = 0; i < bytes.length; i += chunk) {
    var part = bytes.subarray(i, i + chunk);
    binary += String.fromCharCode.apply(null, part);
  }
  return btoa(binary);
}

function _readTextFile(file) {
  return new Promise(function(resolve, reject) {
    var reader = new FileReader();
    reader.onload = function(e) { resolve((e.target.result || '').slice(0, 80000)); };
    reader.onerror = function() { reject(reader.error || new Error('Failed to read file')); };
    reader.readAsText(file);
  });
}

async function _extractDocumentText(file) {
  var name = file.name || ('document-' + Date.now());
  var mime = file.type || 'application/octet-stream';
  var ref = 'attachment://' + encodeURIComponent(name);

  // Fast path for plain text files
  if ((mime && mime.indexOf('text/') === 0) || /\.(txt|md|js|jsx|ts|tsx|py|go|rs|java|c|cpp|h|css|html|htm|json|yaml|yml|toml|xml|csv|log|sql|graphql|sh|env)$/i.test(name)) {
    var text = await _readTextFile(file);
    return { text: text, ref: ref, mime: mime, size: file.size || 0, warning: '' };
  }

  var ab = await file.arrayBuffer();
  var payload = {
    name: name,
    mime: mime,
    base64: _toBase64(ab)
  };

  var r = await fetch('/api/extract-attachment', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  });
  var d = await r.json();
  if (!r.ok || d.error) throw new Error(d.error || 'Failed to extract document');
  return {
    text: d.text || '',
    ref: d.ref || ref,
    mime: d.mime || mime,
    size: d.size || file.size || 0,
    warning: d.warning || ''
  };
}

async function _processSingleAttachment(file) {
  if (file.type && file.type.startsWith('image/')) {
    var mime = file.type || 'image/png';
    var name = file.name || ('image-' + Date.now() + '.png');
    var reader = new FileReader();
    reader.onload = function(ev) {
      var base64 = ev.target.result.split(',')[1];
      addAttachment({ type: 'image', name: name, base64: base64, mime: mime });
    };
    reader.readAsDataURL(file);
    return;
  }

  try {
    var extracted = await _extractDocumentText(file);
    var body = extracted.text;
    if (!body && extracted.warning) {
      body = '[Attachment note] ' + extracted.warning;
    }
    addAttachment({
      type: 'file',
      name: file.name,
      content: body,
      sourceUri: extracted.ref,
      size: extracted.size,
      mime: extracted.mime,
      warning: extracted.warning
    });
  } catch (err) {
    addAttachment({
      type: 'file',
      name: file.name,
      content: '[Attachment note] Failed to extract text: ' + err.message,
      sourceUri: 'attachment://' + encodeURIComponent(file.name || ('file-' + Date.now())),
      size: file.size || 0,
      mime: file.type || 'application/octet-stream',
      warning: err.message
    });
  }
}

async function handleFiles(files) {
  var list = Array.from(files || []);
  for (var i = 0; i < list.length; i++) {
    await _processSingleAttachment(list[i]);
  }
  document.getElementById('file-input').value = '';
}

function addAttachment(att) {
  state.pendingAttachments.push(att);
  renderAttachBar();
}

function removeAttachment(idx) {
  state.pendingAttachments.splice(idx, 1);
  renderAttachBar();
}

function clearAttachments() {
  state.pendingAttachments = [];
  _attachBarExpanded = false;
  renderAttachBar();
}

var _attachBarExpanded = false;
var ATTACH_BAR_MAX = 3;

function renderAttachBar() {
  var bar = document.getElementById('attach-bar');
  var atts = state.pendingAttachments;
  if (!atts.length) { bar.innerHTML = ''; return; }

  var showAll = _attachBarExpanded || atts.length <= ATTACH_BAR_MAX;
  var visible = showAll ? atts : atts.slice(0, ATTACH_BAR_MAX);
  var html = visible.map(function(att, i) {
    return _renderChip(att, i);
  }).join('');

  if (!showAll) {
    var remaining = atts.length - ATTACH_BAR_MAX;
    html += '<button class="attach-overflow-btn" onclick="_attachBarExpanded=true;renderAttachBar()" title="Show all ' + atts.length + ' attachments">+' + remaining + ' more</button>';
  } else if (atts.length > ATTACH_BAR_MAX) {
    html += '<button class="attach-overflow-btn" onclick="_attachBarExpanded=false;renderAttachBar()" title="Collapse">show less</button>';
  }

  if (atts.length > 1) {
    html += '<button class="attach-clear-btn" onclick="clearAttachments()" title="Remove all"><i class="ti ti-x"></i> Clear all</button>';
  }

  bar.innerHTML = html;
}

function _renderChip(att, i) {
  var extCls = att.extSource ? ' pending-chip-ext' : '';
  if (att.type === 'image') {
    return '<div class="pending-chip pending-chip-image' + extCls + '">' +
      '<img class="pending-img-thumb" src="data:' + att.mime + ';base64,' + att.base64 + '" title="' + escHtml(att.name) + '">' +
      '<span class="chip-name" style="max-width:120px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">' + escHtml(att.name) + '</span>' +
      '<button class="chip-remove" onclick="removeAttachment(' + i + ')"><i class="ti ti-x"></i></button>' +
    '</div>';
  }
  var icon = att.extSource === 'page'      ? '<i class="ti ti-world-www"></i>'
           : att.extSource === 'selection' ? '<i class="ti ti-text-scan-2"></i>'
           : att.type === 'url'            ? '<i class="ti ti-link"></i>'
           : '<i class="ti ti-paperclip"></i>';
  return '<div class="pending-chip' + extCls + '">' +
    '<span class="chip-icon">' + icon + '</span>' +
    '<span class="chip-name">' + escHtml(att.name) + '</span>' +
    '<button class="chip-remove" onclick="removeAttachment(' + i + ')"><i class="ti ti-x"></i></button>' +
  '</div>';
}

// ── URL modal ─────────────────────────────────────────────────────────────

function openUrlModal() {
  document.getElementById('url-modal').classList.add('show');
  document.getElementById('url-input').focus();
  document.getElementById('url-modal-status').textContent = '';
  document.getElementById('url-input').value = '';
}

function closeUrlModal(e) {
  if (e && e.target !== document.getElementById('url-modal')) return;
  document.getElementById('url-modal').classList.remove('show');
}

async function fetchUrl() {
  var url = document.getElementById('url-input').value.trim();
  if (!url) return;
  var status = document.getElementById('url-modal-status');
  status.innerHTML = '<i class="ti ti-loader"></i> Fetching…';
  status.style.color = 'var(--text-dim)';
  try {
    var r = await fetch('/api/fetch-url', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url })
    });
    var d = await r.json();
    if (d.error) throw new Error(d.error);
    status.innerHTML = '<i class="ti ti-check"></i> ' + d.title + ' (' + Math.round(d.chars/1000) + 'k chars)';
    status.style.color = 'var(--success)';
    addAttachment({ type: 'url', name: d.title || url, content: `Source: ${url}\n\n${d.content}` });
    setTimeout(() => document.getElementById('url-modal').classList.remove('show'), 1200);
  } catch (err) {
    status.innerHTML = '<i class="ti ti-x"></i> ' + err.message;
    status.style.color = 'var(--error)';
  }
}

document.getElementById('url-input').addEventListener('keydown', e => {
  if (e.key === 'Enter') fetchUrl();
  if (e.key === 'Escape') closeUrlModal();
});

document.getElementById('pat-input').addEventListener('keydown', e => {
  if (e.key === 'Enter') savePat();
});

// ── System prompt panel ───────────────────────────────────────────────────

function toggleSysPanel() {
  var panel = document.getElementById('sys-panel');
  var btn = document.getElementById('sys-btn');
  if (!panel) return;
  panel.classList.toggle('open');
  if (btn) btn.classList.toggle('active');
  if (panel.classList.contains('open')) updateSysScopeHint();
}

// Legacy — kept for any older callers
function saveSysPrompt() { saveSysPromptGlobal(); }

// Save only to the current conversation (not globally)
function saveSysPromptForConv() {
  var val = document.getElementById('sys-prompt-input').value;
  var conv = getConv(state.currentId);
  if (!conv) { showToast('No active conversation'); return; }
  conv.systemPrompt = val;
  saveConversations();
  toggleSysPanel();
  showToast('Saved for this chat');
}

// Save globally — applies to all new chats and updates current conversation
function saveSysPromptGlobal() {
  var val = document.getElementById('sys-prompt-input').value;
  state.systemPrompt = val;
  localStorage.setItem('fauna-sys', val);
  var conv = getConv(state.currentId);
  if (conv) { conv.systemPrompt = val; saveConversations(); }
  toggleSysPanel();
  showToast('System prompt saved globally');
}

// Push current text into Agent Rules for permanent global enforcement
function addPromptAsRule() {
  var text = document.getElementById('sys-prompt-input').value.trim();
  if (!text) { showToast('Nothing to add — type a rule first'); return; }
  var rules = loadAgentRules();
  rules.push({ id: 'ar-' + Date.now(), text: text, enabled: true });
  saveAgentRules(rules);
  toggleSysPanel();
  showToast('Added to global rules');
}

function clearSysPrompt() {
  document.getElementById('sys-prompt-input').value = '';
  updateSysScopeHint();
}

// Show a subtle label indicating whether the displayed text differs from global
function updateSysScopeHint() {
  var hint = document.getElementById('sys-scope-hint');
  if (!hint) return;
  var conv = getConv(state.currentId);
  var convPrompt  = conv ? (conv.systemPrompt || '') : '';
  var globalPrompt = state.systemPrompt || '';
  var current = document.getElementById('sys-prompt-input').value || '';
  if (!current) { hint.textContent = ''; hint.className = ''; return; }
  if (convPrompt && convPrompt !== globalPrompt && current === convPrompt) {
    hint.textContent = 'Custom prompt for this chat only';
    hint.className = 'conv';
  } else if (current === globalPrompt && globalPrompt) {
    hint.textContent = 'Applied to all chats';
    hint.className = 'global';
  } else {
    hint.textContent = 'Unsaved changes';
    hint.className = '';
  }
}

// ── Sidebar ───────────────────────────────────────────────────────────────

var sidebarVisible = true;
function toggleSidebar() {
  sidebarVisible = !sidebarVisible;
  document.getElementById('sidebar').classList.toggle('collapsed', !sidebarVisible);
}

// ── Sidebar resize ───────────────────────────────────────────────────────
(function() {
  var SIDEBAR_MIN = 180, SIDEBAR_MAX = 480, SIDEBAR_DEFAULT = 230;
  var STORAGE_KEY = 'fauna-sidebar-width';

  function applySidebarWidth(w) {
    var sb = document.getElementById('sidebar');
    if (!sb) return;
    sb.style.width = w + 'px';
    sb.style.minWidth = w + 'px';
  }

  document.addEventListener('DOMContentLoaded', function() {
    var saved = parseInt(localStorage.getItem(STORAGE_KEY), 10);
    if (saved && saved >= SIDEBAR_MIN && saved <= SIDEBAR_MAX) applySidebarWidth(saved);

    var handle = document.getElementById('sidebar-resize-handle');
    if (!handle) return;

    handle.addEventListener('mousedown', function(e) {
      e.preventDefault();
      var sb = document.getElementById('sidebar');
      var startX = e.clientX;
      var startW = sb.getBoundingClientRect().width;
      sb.classList.add('resizing');

      function onMove(e) {
        var w = Math.min(SIDEBAR_MAX, Math.max(SIDEBAR_MIN, startW + (e.clientX - startX)));
        applySidebarWidth(w);
      }
      function onUp(e) {
        sb.classList.remove('resizing');
        var finalW = sb.getBoundingClientRect().width;
        localStorage.setItem(STORAGE_KEY, Math.round(finalW));
        document.removeEventListener('mousemove', onMove);
        document.removeEventListener('mouseup', onUp);
      }
      document.addEventListener('mousemove', onMove);
      document.addEventListener('mouseup', onUp);
    });

    handle.addEventListener('dblclick', function() {
      applySidebarWidth(SIDEBAR_DEFAULT);
      localStorage.removeItem(STORAGE_KEY);
    });
  });
}());

// ── Empty state prompts ───────────────────────────────────────────────────

var promptMap = {
  'What\'s using my disk?':  'What\'s using the most disk space on my Mac? Check my home folder and show the top offenders.',
  'Open a website':          'Open https://github.com in the browser panel.',
  'Register on a site':      'I want to register on a website. The URL is: ',
  'Build a dashboard':       'Build an interactive dashboard as an HTML artifact. It should include a chart and some stats. The data is:\n\n',
  'Explain code':            'Please explain the following code:\n\n```\n// Paste your code here\n```',
  'Write a script':          'Write and run a script that ',
  'Search the web':          'Search the web and give me a summary of: ',
  'Debug an error':          'I\'m getting this error:\n\n```\n// Paste error here\n```\n\nHere\'s my code:\n\n```\n// Paste code here\n```',
};

function usePrompt(card) {
  var title = card.querySelector('strong').textContent;
  var text  = promptMap[title] || '';
  var input = document.getElementById('msg-input');
  input.value = text;
  resizeTextarea(input);
  input.focus();
  input.setSelectionRange(input.value.length, input.value.length);
  if (!state.currentId) newConversation();
  showMessages();
}

// ── Toast ─────────────────────────────────────────────────────────────────

var toastTimer = null;
function showToast(msg) {
  var t = document.getElementById('toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('show'), 2200);
}

// ── Generic Prompt / Confirm dialogs (Electron-safe) ──────────────────────

var _dlgResolveFn = null;
var _dlgMode = 'prompt'; // 'prompt' or 'confirm'

function _dlgResolve(val) {
  var modal = document.getElementById('dlg-modal');
  modal.classList.remove('show');
  if (_dlgResolveFn) { _dlgResolveFn(val); _dlgResolveFn = null; }
}

function _dlgOk() {
  if (_dlgMode === 'confirm') {
    _dlgResolve(true);
  } else {
    _dlgResolve(document.getElementById('dlg-modal-input').value);
  }
}

function showPrompt(title, defaultVal) {
  return new Promise(function(resolve) {
    _dlgResolveFn = resolve;
    _dlgMode = 'prompt';
    var modal = document.getElementById('dlg-modal');
    document.getElementById('dlg-modal-title').textContent = title;
    document.getElementById('dlg-modal-msg').style.display = 'none';
    var inp = document.getElementById('dlg-modal-input');
    inp.style.display = '';
    inp.value = defaultVal || '';
    inp.onkeydown = function(e) { if (e.key === 'Enter') _dlgOk(); };
    document.getElementById('dlg-modal-ok').textContent = 'OK';
    modal.classList.add('show');
    inp.focus();
    inp.select();
  });
}

function showConfirm(message) {
  return new Promise(function(resolve) {
    _dlgResolveFn = resolve;
    _dlgMode = 'confirm';
    var modal = document.getElementById('dlg-modal');
    document.getElementById('dlg-modal-title').textContent = message;
    document.getElementById('dlg-modal-msg').style.display = 'none';
    document.getElementById('dlg-modal-input').style.display = 'none';
    document.getElementById('dlg-modal-ok').textContent = 'OK';
    modal.classList.add('show');
    document.getElementById('dlg-modal-ok').focus();
  });
}

// ── Context meter ─────────────────────────────────────────────────────────

var MODEL_CONTEXT_LIMITS = {
  'gpt-4o': 128000, 'gpt-4o-mini': 128000, 'gpt-4-turbo': 128000,
  'gpt-4': 8192, 'gpt-3.5-turbo': 16385, 'gpt-4.1': 1000000,
  'o1': 200000, 'o1-mini': 128000, 'o1-pro': 200000, 'o3': 200000, 'o3-mini': 200000, 'o4-mini': 200000,
  'gpt-5': 1000000,
  'claude-sonnet-4-20250514': 200000, 'claude-opus-4-20250514': 200000,
  'claude-3.5-sonnet': 200000, 'claude-3-opus': 200000, 'claude-3-haiku': 200000,
};

function getModelLimit(model) {
  if (MODEL_CONTEXT_LIMITS[model]) return MODEL_CONTEXT_LIMITS[model];
  // Fuzzy match
  for (var key in MODEL_CONTEXT_LIMITS) {
    if (model.indexOf(key) !== -1) return MODEL_CONTEXT_LIMITS[key];
  }
  return 128000; // safe default
}

function formatTokens(n) {
  if (n >= 1000) return (n / 1000).toFixed(1).replace(/\.0$/, '') + 'K';
  return '' + n;
}

function updateContextMeter(data) {
  var meter = document.getElementById('ctx-meter');
  var fill = document.getElementById('ctx-meter-fill');
  var label = document.getElementById('ctx-meter-label');
  if (!meter || !fill || !label) return;

  var limit = getModelLimit(data.model || '');
  var promptTokens, completionTokens;

  if (data.usage) {
    promptTokens = data.usage.prompt_tokens || 0;
    completionTokens = data.usage.completion_tokens || 0;
  } else {
    // Estimate: ~4 chars per token
    promptTokens = Math.round((data.sysChars + data.msgChars) / 4);
    completionTokens = data.outputTokens || 0;
  }

  var totalUsed = promptTokens + completionTokens;
  var pct = Math.min((totalUsed / limit) * 100, 100);

  fill.style.width = pct + '%';
  fill.className = '';
  if (pct > 80) fill.className = 'ctx-meter-danger';
  else if (pct > 50) fill.className = 'ctx-meter-warn';

  label.textContent = formatTokens(promptTokens) + ' in + ' + formatTokens(completionTokens) + ' out = ' + formatTokens(totalUsed) + ' / ' + formatTokens(limit) + (data.usage ? '' : ' (est.)');
  meter.style.display = 'flex';
}

// ── Textarea resize ───────────────────────────────────────────────────────

var input = document.getElementById('msg-input');
function resizeTextarea(el) {
  el.style.height = 'auto';
  el.style.height = Math.min(el.scrollHeight, 200) + 'px';
}
input.addEventListener('input', () => { resizeTextarea(input); _promptHistIdx = -1; });
input.addEventListener('paste', function(e) {
  var items = (e.clipboardData || {}).items;
  if (!items) return;
  for (var i = 0; i < items.length; i++) {
    if (items[i].kind === 'file' && items[i].type.startsWith('image/')) {
      e.preventDefault();
      var blob = items[i].getAsFile();
      var mime = items[i].type;
      var ext  = mime.split('/')[1] || 'png';
      var name = 'image-' + Date.now() + '.' + ext;
      var reader = new FileReader();
      reader.onload = function(ev) {
        var base64 = ev.target.result.split(',')[1];
        addAttachment({ type: 'image', name: name, base64: base64, mime: mime });
      };
      reader.readAsDataURL(blob);
      return;
    }
  }
});


// ── Drag-and-drop files onto the input wrap ──────────────────────────────
(function() {
  var wrap = document.getElementById('input-wrap');
  var dragCounter = 0;

  function hasFileItem(dt) {
    if (!dt) return false;
    if (dt.types && (dt.types.indexOf('Files') !== -1 || dt.types.indexOf('files') !== -1)) return true;
    if (dt.items) {
      for (var i = 0; i < dt.items.length; i++) {
        if (dt.items[i].kind === 'file') return true;
      }
    }
    return false;
  }

  wrap.addEventListener('dragenter', function(e) {
    if (!hasFileItem(e.dataTransfer)) return;
    e.preventDefault();
    dragCounter++;
    wrap.classList.add('drag-over');
  });
  wrap.addEventListener('dragleave', function(e) {
    dragCounter--;
    if (dragCounter <= 0) { dragCounter = 0; wrap.classList.remove('drag-over'); }
  });
  wrap.addEventListener('dragover', function(e) {
    if (!hasFileItem(e.dataTransfer)) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'copy';
  });
  wrap.addEventListener('drop', function(e) {
    e.preventDefault();
    dragCounter = 0;
    wrap.classList.remove('drag-over');
    handleFiles(e.dataTransfer.files);
  });
})();

function openImageAttach() {
  var inp = document.createElement('input');
  inp.type = 'file';
  inp.accept = 'image/*';
  inp.multiple = true;
  inp.onchange = function() {
    Array.from(inp.files).forEach(function(file) {
      var mime = file.type || 'image/png';
      var name = file.name || ('image-' + Date.now() + '.png');
      var reader = new FileReader();
      reader.onload = function(ev) {
        var base64 = ev.target.result.split(',')[1];
        addAttachment({ type: 'image', name: name, base64: base64, mime: mime });
      };
      reader.readAsDataURL(file);
    });
  };
  inp.click();
}

input.addEventListener('keydown', e => {
  if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); _promptHistIdx = -1; _promptHistDraft = ''; sendMessage(); return; }

  // Arrow-up/down prompt history cycling (only when cursor is at start/end)
  if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
    var handled = handlePromptHistory(e.key, input);
    if (handled) { e.preventDefault(); return; }
  }

  if (e.key === 'Escape') {
    if (obOpen) closeOnboarding();
    else if (document.getElementById('sys-panel').classList.contains('open'))      toggleSysPanel();
    else if (document.getElementById('settings-panel').classList.contains('open')) toggleSettings();
  }
});

function handlePromptHistory(key, input) {
  // Only cycle when autocomplete dropdowns are closed
  if (typeof slashAutocompleteOpen !== 'undefined' && slashAutocompleteOpen) return false;
  if (typeof agentAutocompleteOpen !== 'undefined' && agentAutocompleteOpen) return false;

  var conv = getConv(state.currentId);
  if (!conv) return false;

  // Collect user messages in order (oldest first) — exclude auto-feed/browser-feed
  var userMsgs = conv.messages.filter(function(m) { return m.role === 'user' && !m._isBrowserFeed && !m._isAutoFeed; });
  if (!userMsgs.length) return false;

  if (key === 'ArrowUp') {
    // Only trigger when cursor is at position 0 (or input is empty)
    if (input.selectionStart !== 0 && input.value.length > 0) return false;

    if (_promptHistIdx === -1) {
      // Stash current draft
      _promptHistDraft = input.value;
      _promptHistIdx = userMsgs.length - 1; // most recent
    } else if (_promptHistIdx > 0) {
      _promptHistIdx--;
    } else {
      return true; // already at oldest, consume the key
    }
  } else { // ArrowDown
    if (_promptHistIdx === -1) return false; // not in history mode

    // Only trigger when cursor is at end
    if (input.selectionStart !== input.value.length && input.value.length > 0) return false;

    if (_promptHistIdx < userMsgs.length - 1) {
      _promptHistIdx++;
    } else {
      // Back to draft
      _promptHistIdx = -1;
      input.value = _promptHistDraft;
      resizeTextarea(input);
      _restoreHistoryAttachments(null);
      return true;
    }
  }

  var msg = userMsgs[_promptHistIdx];
  // Use stored display text if available, else strip appended file/url fences and system context
  var displayText = msg._displayText || msg.content.split(/\n\n(```\n\/\/ (File|URL):|\[System context)/)[0].trim();
  input.value = displayText;
  resizeTextarea(input);

  // Restore attachments if any
  _restoreHistoryAttachments(msg.attachments);

  // Place cursor at start for ArrowUp, end for ArrowDown
  if (key === 'ArrowUp') {
    input.selectionStart = input.selectionEnd = 0;
  } else {
    input.selectionStart = input.selectionEnd = input.value.length;
  }
  return true;
}

function _restoreHistoryAttachments(attachments) {
  // Clear current attachments and restore from history message
  state.pendingAttachments = [];
  if (attachments && attachments.length) {
    attachments.forEach(function(a) {
      state.pendingAttachments.push({
        type: a.type,
        name: a.name,
        base64: a.base64 || undefined,
        mime: a.mime || undefined,
        content: a.content || undefined,
        sourceUri: a.sourceUri || undefined,
        size: a.size || undefined,
        warning: a.warning || undefined
      });
    });
  }
  renderAttachBar();
}

// ── Figma integration ─────────────────────────────────────────────────────

// ── Desktop Organizer Card ────────────────────────────────────────────────
// When AI responds to a desktop task but leaves code blocks empty,
// inject a ready-to-use organizer action card.

async function injectOrganizerCard(msgEl, buffer) {
  // Only inject if the response specifically describes a desktop file organization plan
  var isOrgPlan = /\b(organis|organiz)[ez]?\s+(your|the|these)?\s*(desktop|files|folder|downloads)/i.test(buffer)
    || /\bmov(e|ing)\s+(files?|screenshots?|images?)\s+(to|into)\s+/i.test(buffer);
  if (!isOrgPlan) return;

  // Fetch a dry-run preview from the server
  var preview;
  try {
    var r = await fetch('/api/organize-desktop', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ dryRun: true })
    });
    preview = await r.json();
  } catch (_) { return; }

  if (!preview.ok || !preview.moves || !preview.moves.length) return;

  // Build folder summary
  var byFolder = {};
  preview.moves.forEach(function(m) {
    byFolder[m.folder] = (byFolder[m.folder] || 0) + 1;
  });
  var summaryHtml = Object.entries(byFolder)
    .map(function(e) { return '<b>' + escHtml(e[0]) + '</b> — ' + e[1] + ' file' + (e[1] > 1 ? 's' : ''); })
    .join('<br>');

  var cardId = 'org-' + Date.now();
  var card   = document.createElement('div');
  card.className = 'organizer-card';
  card.id = cardId;
  card.innerHTML =
    '<div class="organizer-card-header">' +
      '<i class="ti ti-folders"></i> Desktop Organizer — Ready to Run' +
    '</div>' +
    '<div class="organizer-preview">' +
      summaryHtml +
      '<br><span style="color:var(--text-muted);font-size:11px">' + preview.moves.length + ' files · ' + (preview.skipped || []).length + ' folders/unmatched skipped</span>' +
    '</div>' +
    '<div class="organizer-actions">' +
      '<button class="organizer-btn primary" onclick="runOrganizerCard(\'' + cardId + '\')"><i class="ti ti-player-play"></i> Organise Now</button>' +
      '<button class="organizer-btn secondary" onclick="previewOrganizerCard(\'' + cardId + '\')"><i class="ti ti-list"></i> Preview files</button>' +
    '</div>' +
    '<div class="organizer-result" id="' + cardId + '-result"></div>';

  card.dataset.preview = JSON.stringify(preview);
  msgEl.querySelector('.msg-body').appendChild(card);

  // Also replace any empty code blocks in this message
  msgEl.querySelectorAll('pre').forEach(function(pre) {
    var code = pre.querySelector('code');
    if (code && !code.textContent.trim()) pre.style.display = 'none';
  });

  scrollBottom();
}

async function runOrganizerCard(cardId) {
  var card   = document.getElementById(cardId);
  var result = document.getElementById(cardId + '-result');
  var btn    = card.querySelector('.organizer-btn.primary');
  btn.disabled = true; btn.innerHTML = '<i class="ti ti-loader"></i> Organising…';
  result.style.display = 'block'; result.textContent = 'Moving files…';

  try {
    var r = await fetch('/api/organize-desktop', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ dryRun: false })
    });
    var d = await r.json();
    if (d.ok) {
      result.innerHTML =
        '<span style="color:#1ec882"><i class="ti ti-check"></i> Done — ' + d.moved + ' files organised.</span>' +
        (d.errors && d.errors.length ? '<br><span style="color:#f97316">' + d.errors.length + ' errors: ' + d.errors.map(function(e){ return escHtml(e.file); }).join(', ') + '</span>' : '') +
        '<br><span style="color:#6e7681;font-size:11px"><a href="#" onclick="feedOrgResult(this);return false" style="color:var(--accent2)">Feed result to AI</a></span>';
      result.dataset.summary = JSON.stringify(d);
      btn.innerHTML = '<i class="ti ti-check"></i> Done';
      showToast('Desktop organised!');
    } else {
      result.innerHTML = '<span style="color:#f87171">Error: ' + escHtml(d.error || 'Unknown') + '</span>';
      btn.disabled = false; btn.innerHTML = '<i class="ti ti-player-play"></i> Organise Now';
    }
  } catch (e) {
    result.innerHTML = '<span style="color:#f87171">' + escHtml(e.message) + '</span>';
    btn.disabled = false; btn.innerHTML = '<i class="ti ti-player-play"></i> Organise Now';
  }
  scrollBottom();
}

function previewOrganizerCard(cardId) {
  var card    = document.getElementById(cardId);
  var preview = JSON.parse(card.dataset.preview || '{}');
  var result  = document.getElementById(cardId + '-result');
  if (!preview.moves) return;
  result.style.display = 'block';
  result.innerHTML = preview.moves.map(function(m) {
    return '<span style="color:#6e7681">→ </span>' + escHtml(m.file) + ' <span style="color:#6e7681">→ ' + escHtml(m.folder) + '</span>';
  }).join('<br>');
  scrollBottom();
}

async function feedOrgResult(a) {
  var result = a.closest('.organizer-result');
  var d = result.dataset.summary ? JSON.parse(result.dataset.summary) : null;
  if (!d) return;
  var lines = ['Desktop organised successfully: ' + d.moved + ' files moved.'];
  if (d.errors && d.errors.length) lines.push(d.errors.length + ' errors: ' + d.errors.map(function(e){ return e.file + ': ' + e.error; }).join(', '));
  if (d.done) {
    var byFolder = {};
    d.done.forEach(function(m) { byFolder[m.folder] = (byFolder[m.folder]||[]).concat(m.file); });
    Object.entries(byFolder).forEach(function(e) { lines.push(e[0] + ': ' + e[1].join(', ')); });
  }
  document.getElementById('msg-input').value = lines.join('\n');
  await sendMessage();
}
async function feedCodeResult(a) {
  var resultEl = a.closest('.code-run-result');
  if (!resultEl || !resultEl.dataset.result) return;
  var d = JSON.parse(resultEl.dataset.result);
  var lines = ['**Command result:**', '```', '$ ' + d.command, ''];
  if (d.stdout && d.stdout.trim()) lines.push(d.stdout.trimEnd());
  if (d.stderr && d.stderr.trim()) lines.push('[stderr] ' + d.stderr.trimEnd());
  lines.push('exit ' + d.exitCode);
  lines.push('```', 'Please continue based on this output.');
  document.getElementById('msg-input').value = lines.join('\n');
  await sendMessage();
}

// Toggle auto-run from Settings (called by settings checkbox)
function setAutoRunShell(val) {
  state.autoRunShell = val;
  localStorage.setItem('fauna-autorun-shell', val ? 'true' : 'false');
}

var _thinkingHints = {
  off:    'Model will not use extended thinking.',
  low:    'Quick reasoning pass (~1K tokens). Faster and cheaper.',
  medium: 'Balanced thinking (~5K tokens). Good for most tasks.',
  high:   'Deep analysis (~10K tokens). Best for complex problems.',
  max:    'Exhaustive reasoning (~32K tokens). Slowest and most expensive.'
};
function setThinkingBudget(val) {
  state.thinkingBudget = val;
  localStorage.setItem('fauna-thinking-budget', val);
  var hint = document.getElementById('thinking-budget-hint');
  if (hint) hint.textContent = _thinkingHints[val] || '';
}
function setMaxTurns(val) {
  state.maxContextTurns = val;
  localStorage.setItem('fauna-max-turns', String(val));
  var lbl = document.getElementById('max-turns-label');
  if (lbl) lbl.textContent = val === 100 ? 'Max' : val;
}

// ── Windows platform detection + window controls ──────────────────────────
(function() {
  var isWin = navigator.userAgent.includes('Windows') ||
              (typeof process !== 'undefined' && process.platform === 'win32');
  if (isWin) {
    document.body.classList.add('win-platform');
    var wc = document.getElementById('win-controls');
    if (wc) wc.style.display = 'flex';
  }
})();

function winCtrl(action) {
  fetch('/api/window/' + action, { method: 'POST' }).catch(function() {});
}


// ── Onboarding / Permissions ──────────────────────────────────────────────

var obOpen = false;

var PERMISSIONS_DEF_MAC = [
  {
    id: 'auth',
    icon: '<i class="ti ti-key"></i>',
    name: 'Authentication',
    desc: 'Required to send messages. Use a GitHub PAT (via gh CLI or manual entry) or add a direct API key in Settings.',
    required: true,
  },
  {
    id: 'fullDiskAccess',
    icon: '<i class="ti ti-folders"></i>',
    name: 'Full Disk Access',
    desc: 'Read and write files anywhere — Desktop, Documents, external drives.',
    required: true,
    action: 'settings',
    settingsUrl: 'x-apple.systempreferences:com.apple.preference.security?Privacy_AllFiles',
    actionLabel: 'Open Settings',
  },
  {
    id: 'screenRecording',
    icon: '<i class="ti ti-screenshot"></i>',
    name: 'Screen Recording',
    desc: 'Capture screenshots and screen content of other apps.',
    required: false,
    action: 'request-screen',
    actionLabel: 'Enable',
  },
  {
    id: 'accessibility',
    icon: '<i class="ti ti-accessible"></i>',
    name: 'Accessibility',
    desc: 'Control the mouse, simulate keyboard input, and navigate other apps.',
    required: false,
    action: 'settings',
    settingsUrl: 'x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility',
    actionLabel: 'Open Settings',
  },
  {
    id: 'automation',
    icon: '<i class="ti ti-robot"></i>',
    name: 'Automation',
    desc: 'Switch between apps and control Finder via AppleScript. Prompted on first use — no action needed.',
    required: false,
    action: 'info',
    actionLabel: 'Auto-prompted',
  },
];

var PERMISSIONS_DEF_WIN = [
  {
    id: 'auth',
    icon: '<i class="ti ti-key"></i>',
    name: 'Authentication',
    desc: 'Required to send messages. Use a GitHub PAT (via gh CLI or manual entry) or add a direct API key in Settings.',
    required: true,
  },
];

var PERMISSIONS_DEF = navigator.userAgent.includes('Windows') ? PERMISSIONS_DEF_WIN : PERMISSIONS_DEF_MAC;

function openOnboarding() {
  obOpen = true;
  var el = document.getElementById('onboarding-overlay');
  el.style.display = 'flex';
  refreshPermissions();
  window.addEventListener('focus', onWindowFocus);
}

function closeOnboarding() {
  obOpen = false;
  document.getElementById('onboarding-overlay').style.display = 'none';
  window.removeEventListener('focus', onWindowFocus);
  localStorage.setItem('fauna-chat-onboarding-done', '1');
}

function onWindowFocus() {
  if (obOpen) refreshPermissions();
}

async function refreshPermissions() {
  document.getElementById('ob-checking-hint').textContent = 'Checking…';
  try {
    var [permsRes, authRes] = await Promise.all([
      fetch('/api/permissions'),
      fetch('/api/auth'),
    ]);
    var perms = await permsRes.json();
    var auth  = await authRes.json();
    perms.auth = auth.authenticated ? 'granted' : 'denied';
    renderPermissions(perms);
    var allReqOk = PERMISSIONS_DEF
      .filter(p => p.required)
      .every(p => perms[p.id] === 'granted');
    document.getElementById('ob-checking-hint').textContent =
      allReqOk ? 'All required permissions granted' : 'Some permissions need your attention'; // plain text hint
    document.getElementById('ob-checking-hint').style.color =
      allReqOk ? 'var(--success)' : 'var(--text-muted)';
  } catch (e) {
    document.getElementById('ob-checking-hint').textContent = 'Could not check permissions';
  }
}

function renderPermissions(perms) {
  var list = document.getElementById('permission-list');
  list.innerHTML = PERMISSIONS_DEF.map(function(p) {
    var raw = perms[p.id];

    // Normalise status
    var statusKey, statusLabel;
    if (raw === 'granted') {
      statusKey = 'ok'; statusLabel = '<i class="ti ti-check"></i> Granted';
    } else if (raw === 'denied' || raw === 'not-determined') {
      statusKey = 'err'; statusLabel = '<i class="ti ti-x"></i> Not granted';
    } else if (raw === 'auto-prompted') {
      statusKey = 'dim'; statusLabel = '<i class="ti ti-refresh"></i> On first use';
    } else {
      statusKey = 'warn'; statusLabel = '? Unknown';
    }

    var rowClass = raw === 'granted' ? 'granted' : (raw === 'denied' || raw === 'not-determined') ? 'denied' : '';
    var badgeClass = p.required ? 'req' : 'opt';
    var badgeLabel = p.required ? 'Required' : 'Optional';

    // Auth row: show inline PAT form when not granted
    if (p.id === 'auth') {
      var patForm = '';
      if (raw !== 'granted') {
        patForm =
          '<div class="perm-pat-form">' +
            '<div class="perm-pat-form-row">' +
              '<input class="perm-pat-input" id="ob-pat-input" type="password" ' +
                'placeholder="ghp_…  or  github_pat_…" autocomplete="off" spellcheck="false" ' +
                'onkeydown="if(event.key===\'Enter\')savePatFromOnboarding()">' +
              '<button class="perm-pat-save" id="ob-pat-save" onclick="savePatFromOnboarding()">' +
                '<i class="ti ti-check"></i> Save' +
              '</button>' +
            '</div>' +
            '<div class="perm-pat-status" id="ob-pat-status"></div>' +
            '<div class="perm-pat-hint">' +
              'Already logged in via <code>gh auth login</code>? Click ' +
              '<a href="#" onclick="refreshPermissions();return false">Check again</a>.<br>' +
              'Or generate a PAT at ' +
              '<a href="#" onclick="window.open(\'https://github.com/settings/tokens\');return false">' +
                'github.com/settings/tokens' +
              '</a> with the <strong>copilot</strong> scope.' +
            '</div>' +
          '</div>';
      }
      return '<div class="perm-row auth-row ' + rowClass + '">' +
        '<div class="perm-icon">' + p.icon + '</div>' +
        '<div class="perm-info">' +
          '<div class="perm-name">' + escHtml(p.name) +
            '<span class="perm-req-badge ' + badgeClass + '">' + badgeLabel + '</span>' +
          '</div>' +
          '<div class="perm-desc">' + escHtml(p.desc) + '</div>' +
        '</div>' +
        '<div class="perm-status ' + statusKey + '">' + statusLabel + '</div>' +
        (raw === 'granted'
          ? '<button class="perm-action" disabled><i class="ti ti-check"></i> Done</button>'
          : '') +
        patForm +
      '</div>';
    }

    // Action button for other rows
    var btnHtml = '';
    if (raw === 'granted') {
      btnHtml = '<button class="perm-action" disabled><i class="ti ti-check"></i> Done</button>';
    } else if (p.action === 'settings') {
      btnHtml = '<button class="perm-action" onclick="window.open(\'' + p.settingsUrl + '\')">' + escHtml(p.actionLabel) + '</button>';
    } else if (p.action === 'request-screen') {
      btnHtml = '<button class="perm-action primary" onclick="requestScreenPermission(this)">Enable</button>';
    } else if (p.action === 'info') {
      btnHtml = '<button class="perm-action" disabled>' + escHtml(p.actionLabel) + '</button>';
    }

    return '<div class="perm-row ' + rowClass + '">' +
      '<div class="perm-icon">' + p.icon + '</div>' +
      '<div class="perm-info">' +
        '<div class="perm-name">' + escHtml(p.name) +
          '<span class="perm-req-badge ' + badgeClass + '">' + badgeLabel + '</span>' +
        '</div>' +
        '<div class="perm-desc">' + escHtml(p.desc) + '</div>' +
      '</div>' +
      '<div class="perm-status ' + statusKey + '">' + statusLabel + '</div>' +
      btnHtml +
    '</div>';
  }).join('');
}

async function savePatFromOnboarding() {
  var input  = document.getElementById('ob-pat-input');
  var btn    = document.getElementById('ob-pat-save');
  var status = document.getElementById('ob-pat-status');
  if (!input || !input.value.trim()) return;

  var pat = input.value.trim();
  btn.disabled = true;
  status.className = 'perm-pat-status';
  status.textContent = 'Saving…';

  try {
    var r = await fetch('/api/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ pat })
    });
    var d = await r.json();
    if (d.ok) {
      status.className = 'perm-pat-status ok';
      status.innerHTML = '<i class="ti ti-check"></i> Saved — checking auth…';
      input.value = '';
      // Sync to the settings panel too
      document.getElementById('pat-input').placeholder = 'Saved: ' + d.preview;
      document.getElementById('clear-pat-btn').style.display = '';
      await refreshPermissions();
    } else {
      status.className = 'perm-pat-status err';
      status.textContent = d.error || 'Failed to save token';
      btn.disabled = false;
    }
  } catch (e) {
    status.className = 'perm-pat-status err';
    status.textContent = e.message;
    btn.disabled = false;
  }
}

async function requestScreenPermission(btn) {
  btn.disabled = true; btn.textContent = 'Requesting…';
  try {
    var r = await fetch('/api/permissions/request-screen', { method: 'POST' });
    var d = await r.json();
    if (d.status === 'granted') {
      btn.innerHTML = '<i class="ti ti-check"></i> Granted';
    } else {
      // macOS shows the system prompt; after user grants, they can click Check again
      btn.disabled = false; btn.textContent = 'Open Settings';
      btn.onclick = function() {
        window.open('x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture');
      };
    }
  } catch (_) { btn.disabled = false; btn.textContent = 'Enable'; }
  refreshPermissions();
}

// Auto-show on first launch
document.addEventListener('DOMContentLoaded', function() {
  if (!localStorage.getItem('fauna-chat-onboarding-done')) {
    // Short delay so the main UI is visible behind the overlay
    setTimeout(openOnboarding, 600);
  }
});
