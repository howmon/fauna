// ── Browser Action Recordings page ────────────────────────────────────────
// Record the user's actions across browser tabs (via the Fauna extension),
// view them as a visual map/timeline, edit them, replay them, and ask Fauna to
// recreate a similar flow. Live steps stream in over SSE while recording.

var _recState = { recording: false, live: [], selectedId: null, current: null, list: [] };

function openRecordingsPage() {
  _recEnsureStyles();
  var body = _openAppPage('recordings', 'Recordings');
  if (!body) return;
  body.innerHTML = '<div id="rec-page"></div>';
  _recRefreshStatus();
  _recRefreshList().then(function () { renderRecordingsPage(); });
  renderRecordingsPage();
}

function _recEnsureStyles() {
  if (document.getElementById('rec-styles')) return;
  var css = [
    '#rec-page{height:100%;overflow:hidden}',
    '.rec-layout{display:flex;height:100%;min-height:0}',
    '.rec-sidebar{width:280px;flex-shrink:0;border-right:1px solid var(--fau-border);display:flex;flex-direction:column;overflow:hidden}',
    '.rec-toolbar{padding:14px 14px 8px}',
    '.rec-btn{width:100%;display:flex;align-items:center;justify-content:center;gap:8px;padding:10px;border-radius:var(--radius);border:1px solid var(--fau-border);background:var(--fau-surface);color:var(--fau-text);font:inherit;font-weight:600;cursor:pointer;transition:all .12s}',
    '.rec-btn.rec-start:hover{border-color:var(--error);color:var(--error)}',
    '.rec-btn.rec-stop{background:color-mix(in oklab,var(--error) 16%,transparent);border-color:var(--error);color:var(--error)}',
    '.rec-dot{width:9px;height:9px;border-radius:50%;background:var(--error);display:inline-block;animation:recBlink 1.1s infinite}',
    '@keyframes recBlink{0%,100%{opacity:1}50%{opacity:.3}}',
    '.rec-hint{padding:0 14px 10px;font-size:11px;color:var(--fau-text-muted);line-height:1.4}',
    '.rec-list{flex:1;overflow-y:auto;padding:4px 8px 12px}',
    '.rec-list-item{padding:9px 10px;border-radius:var(--radius-sm);cursor:pointer;margin-bottom:2px;border:1px solid transparent}',
    '.rec-list-item:hover{background:var(--fau-surface2)}',
    '.rec-list-item.active{background:var(--accent-dim);border-color:var(--accent)}',
    '.rec-list-item.rec-live{background:color-mix(in oklab,var(--error) 10%,transparent)}',
    '.rec-list-title{font-size:13px;font-weight:600;color:var(--fau-text);display:flex;align-items:center;gap:6px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}',
    '.rec-list-meta{font-size:11px;color:var(--fau-text-muted);margin-top:2px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}',
    '.rec-empty-sm{padding:16px;color:var(--fau-text-muted);font-size:12px;text-align:center}',
    '.rec-detail{flex:1;min-width:0;overflow-y:auto;padding:20px 26px}',
    '.rec-empty{height:100%;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:12px;color:var(--fau-text-muted);text-align:center}',
    '.rec-empty .ti{font-size:40px;color:var(--fau-text-muted)}',
    '.rec-detail-head{display:flex;align-items:center;gap:12px;margin-bottom:4px}',
    '.rec-detail-title{font-size:18px;font-weight:600;display:flex;align-items:center;gap:8px;flex:1}',
    '.rec-name-input{flex:1;font-size:18px;font-weight:600;background:transparent;border:1px solid transparent;border-radius:6px;color:var(--fau-text);padding:4px 6px;font-family:var(--font)}',
    '.rec-name-input:hover{border-color:var(--fau-border)}.rec-name-input:focus{outline:none;border-color:var(--accent);background:var(--fau-surface)}',
    '.rec-detail-actions{display:flex;gap:6px;flex-shrink:0}',
    '.rec-abtn{display:inline-flex;align-items:center;gap:5px;padding:6px 11px;border-radius:var(--radius);border:1px solid var(--fau-border);background:var(--fau-surface);color:var(--fau-text);font:inherit;font-size:12px;cursor:pointer;transition:all .12s}',
    '.rec-abtn:hover{background:var(--fau-surface2);border-color:var(--fau-text-muted)}',
    '.rec-abtn.danger:hover{border-color:var(--error);color:var(--error)}',
    '.rec-detail-sub{font-size:12px;color:var(--fau-text-muted);margin:0 0 12px 6px}',
    '.rec-desc{width:100%;min-height:52px;resize:vertical;border:1px solid var(--fau-border);border-radius:var(--radius);background:var(--fau-surface);color:var(--fau-text);font:inherit;font-size:13px;padding:8px 10px;margin-bottom:18px}',
    '.rec-desc:focus{outline:none;border-color:var(--accent);box-shadow:0 0 0 3px var(--accent-glow)}',
    '.rec-map{padding-left:6px}',
    '.rec-node{display:flex;gap:12px;align-items:flex-start}',
    '.rec-node-icon{width:34px;height:34px;border-radius:9px;flex-shrink:0;display:flex;align-items:center;justify-content:center;background:var(--accent-dim);color:var(--accent2);font-size:17px}',
    '.rec-node-body{flex:1;min-width:0;padding-bottom:2px}',
    '.rec-node-title{font-size:13px;font-weight:600;color:var(--fau-text);display:flex;align-items:center;gap:8px}',
    '.rec-node-sub{font-size:11px;color:var(--fau-text-muted);margin-top:1px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;font-family:var(--mono)}',
    '.rec-shot{margin-top:8px;max-width:320px;width:100%;border-radius:8px;border:1px solid var(--fau-border);display:block}',
    '.rec-step-del{margin-left:auto;background:none;border:none;color:var(--fau-text-muted);cursor:pointer;font-size:15px;line-height:1;padding:0 4px;opacity:0;transition:opacity .1s}',
    '.rec-node:hover .rec-step-del{opacity:1}.rec-step-del:hover{color:var(--error)}',
    '.rec-connector{width:2px;height:16px;background:var(--fau-border);margin:2px 0 2px 22px}',
    '.rec-gap{font-size:10px;color:var(--fau-text-muted);margin:2px 0 2px 44px}',
  ].join('');
  var st = document.createElement('style');
  st.id = 'rec-styles';
  st.textContent = css;
  document.head.appendChild(st);
}

function _recEsc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
    return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
  });
}

function _recTypeIcon(t) {
  return ({
    navigate: 'ti-world', tabswitch: 'ti-arrows-exchange', click: 'ti-click',
    input: 'ti-keyboard', select: 'ti-select', toggle: 'ti-toggle-left',
    submit: 'ti-send', key: 'ti-command', selection: 'ti-text-caret',
    scroll: 'ti-arrows-vertical', copy: 'ti-copy', cut: 'ti-scissors', paste: 'ti-clipboard',
  })[t] || 'ti-point';
}

function _recStepPrimary(s) {
  switch (s.type) {
    case 'navigate': return 'Navigate → ' + (s.title || s.url || '');
    case 'tabswitch': return 'Switch tab → ' + (s.title || s.url || '');
    case 'click': return 'Click ' + (s.label ? '“' + s.label + '”' : (s.selector || ''));
    case 'input': return 'Type ' + (s.masked ? '••••' : '“' + (s.value || '') + '”');
    case 'select': return 'Select “' + (s.label || s.value || '') + '”';
    case 'toggle': return 'Toggle ' + (s.label || s.selector || '');
    case 'submit': return 'Submit form';
    case 'key': return 'Press ' + (s.keys || '');
    case 'copy': return 'Copy' + (s.text ? ' “' + s.text.slice(0, 40) + '”' : '');
    case 'cut': return 'Cut' + (s.text ? ' “' + s.text.slice(0, 40) + '”' : '');
    case 'paste': return 'Paste' + (s.text ? ' “' + s.text.slice(0, 40) + '”' : '');
    case 'selection': return 'Select text';
    case 'scroll': return 'Scroll';
    default: return s.type;
  }
}

function _recFmtDur(ms) {
  ms = ms || 0;
  var s = Math.round(ms / 1000);
  if (s < 60) return s + 's';
  var m = Math.floor(s / 60);
  return m + 'm ' + (s % 60) + 's';
}

function _recApi(path, opts) {
  var url = (window.faunaStreamUrl ? window.faunaStreamUrl(path) : path);
  return fetch(url, opts).then(function (r) { return r.json(); });
}

function _recRefreshStatus() {
  if (typeof executeExtAction !== 'function') return Promise.resolve();
  return executeExtAction({ action: 'record:status' }).then(function (r) {
    _recState.recording = !!(r && r.recording);
    renderRecordingsPage();
  }).catch(function () {});
}

function _recRefreshList() {
  return _recApi('/api/recordings').then(function (d) {
    if (d && d.ok) _recState.list = d.recordings || [];
  }).catch(function () {});
}

function toggleRecording() {
  if (typeof executeExtAction !== 'function') {
    alert('Connect the Fauna browser extension first.');
    return;
  }
  if (_recState.recording) {
    // Optimistic: stop flashing immediately, then tell the extension.
    _recState.recording = false;
    renderRecordingsPage();
    executeExtAction({ action: 'record:stop' }).catch(function (e) {
      if (typeof showToast === 'function') showToast('Stop failed: ' + e.message, true);
    });
  } else {
    _recState.live = [];
    _recState.selectedId = '__live__';
    _recState.recording = true;
    _recState.current = null;
    renderRecordingsPage();
    executeExtAction({ action: 'record:start' }).catch(function (e) {
      _recState.recording = false;
      renderRecordingsPage();
      alert('Start failed — is the extension connected? ' + e.message);
    });
  }
}

// SSE hook — called from browser.js _handleExtEvent for recording:* events.
function _onRecordingEvent(msg) {
  if (!msg || !msg.event) return;
  var page = document.getElementById('rec-page');
  if (msg.event === 'recording:started') {
    _recState.recording = true; _recState.live = []; _recState.selectedId = '__live__';
    if (page) renderRecordingsPage();
  } else if (msg.event === 'recording:step') {
    _recState.live.push(msg.data || {});
    if (page && _recState.selectedId === '__live__') _recRenderLiveIncremental();
  } else if (msg.event === 'recording:step-shot') {
    var st = _recState.live.find(function (s) { return s.id === msg.data.id; });
    if (st) { st.shot = msg.data.shot; if (page && _recState.selectedId === '__live__') _recRenderLiveIncremental(); }
  } else if (msg.event === 'recording:stopped') {
    _recState.recording = false;
    if (page) renderRecordingsPage();
  } else if (msg.event === 'ext:recording-saved') {
    _recState.recording = false;
    _recRefreshList().then(function () {
      if (msg.data && msg.data.id) selectRecording(msg.data.id);
      else renderRecordingsPage();
    });
  }
}

function renderRecordingsPage() {
  var el = document.getElementById('rec-page');
  if (!el) return;
  var recBtn = _recState.recording
    ? '<button class="rec-btn rec-stop" onclick="toggleRecording()"><span class="rec-dot"></span> Stop recording</button>'
    : '<button class="rec-btn rec-start" onclick="toggleRecording()"><i class="ti ti-player-record-filled"></i> Record</button>';

  var list = _recState.list.map(function (r) {
    var active = _recState.selectedId === r.id ? ' active' : '';
    return '<div class="rec-list-item' + active + '" onclick="selectRecording(\'' + r.id + '\')">' +
      '<div class="rec-list-title">' + _recEsc(r.name) + '</div>' +
      '<div class="rec-list-meta">' + r.stepCount + ' steps · ' + _recFmtDur(r.durationMs) + ' · ' + _recEsc((r.startUrl || '').replace(/^https?:\/\//, '').slice(0, 32)) + '</div>' +
    '</div>';
  }).join('') || '<div class="rec-empty-sm">No recordings yet.</div>';

  var liveItem = _recState.recording
    ? '<div class="rec-list-item rec-live' + (_recState.selectedId === '__live__' ? ' active' : '') + '" onclick="selectRecording(\'__live__\')">' +
        '<div class="rec-list-title"><span class="rec-dot"></span> Recording…</div>' +
        '<div class="rec-list-meta">' + _recState.live.length + ' steps captured</div></div>'
    : '';

  el.innerHTML =
    '<div class="rec-layout">' +
      '<div class="rec-sidebar">' +
        '<div class="rec-toolbar">' + recBtn + '</div>' +
        '<div class="rec-hint">Captures clicks, typing, navigation, tab switches, selections & shortcuts across tabs.</div>' +
        '<div class="rec-list">' + liveItem + list + '</div>' +
      '</div>' +
      '<div class="rec-detail" id="rec-detail">' + _recDetailHtml() + '</div>' +
    '</div>';
}

function _recDetailHtml() {
  if (_recState.selectedId === '__live__') {
    var flashing = _recState.recording;
    var head = flashing ? '<span class="rec-dot"></span> Live recording' : '<i class="ti ti-player-record"></i> Recording finished';
    var sub = flashing ? 'perform actions in your browser' : 'saving…';
    return '<div class="rec-detail-head"><div class="rec-detail-title">' + head + '</div>' +
      '<div class="rec-detail-sub">' + _recState.live.length + ' steps — ' + sub + '</div></div>' +
      '<div class="rec-map" id="rec-live-map">' + _recMapHtml(_recState.live) + '</div>';
  }
  var rec = _recState.current;
  if (!rec) return '<div class="rec-empty"><i class="ti ti-player-record"></i><div>Select a recording, or hit <b>Record</b> to capture browser actions.</div></div>';
  return '<div class="rec-detail-head">' +
      '<input class="rec-name-input" value="' + _recEsc(rec.name) + '" onchange="_recRename(\'' + rec.id + '\', this.value)">' +
      '<div class="rec-detail-actions">' +
        '<button class="rec-abtn" onclick="replayRecording(\'' + rec.id + '\')"><i class="ti ti-player-play"></i> Replay</button>' +
        '<button class="rec-abtn" onclick="recreateRecording(\'' + rec.id + '\')"><i class="ti ti-sparkles"></i> Ask Fauna</button>' +
        '<button class="rec-abtn danger" onclick="deleteRecording(\'' + rec.id + '\')"><i class="ti ti-trash"></i></button>' +
      '</div>' +
    '</div>' +
    '<div class="rec-detail-sub">' + rec.stepCount + ' steps · ' + _recFmtDur(rec.durationMs) + ' · used ' + (rec.useCount || 0) + '×</div>' +
    '<textarea class="rec-desc" placeholder="Describe what this flow does…" onchange="_recSaveDesc(\'' + rec.id + '\', this.value)">' + _recEsc(rec.description || '') + '</textarea>' +
    '<div class="rec-map">' + _recMapHtml(rec.steps || [], rec.id) + '</div>';
}

// The visual map: a timeline of step nodes with connectors + thumbnails.
function _recMapHtml(steps, recId) {
  if (!steps || !steps.length) return '<div class="rec-empty-sm">No steps.</div>';
  return steps.map(function (s, i) {
    var prev = steps[i - 1];
    var gap = prev ? '<div class="rec-gap">+' + _recFmtDur((s.t || 0) - (prev.t || 0)) + '</div>' : '';
    var shot = s.shot ? '<img class="rec-shot" src="' + _recEsc(s.shot) + '" loading="lazy">' : '';
    var sub = s.url ? _recEsc(String(s.url).replace(/^https?:\/\//, '').slice(0, 60)) : _recEsc(s.selector || '');
    var del = recId ? '<button class="rec-step-del" title="Delete step" onclick="_recDeleteStep(\'' + recId + '\',\'' + s.id + '\')">×</button>' : '';
    return gap +
      '<div class="rec-node">' +
        '<div class="rec-node-icon"><i class="ti ' + _recTypeIcon(s.type) + '"></i></div>' +
        '<div class="rec-node-body">' +
          '<div class="rec-node-title">' + (i + 1) + '. ' + _recEsc(_recStepPrimary(s)) + del + '</div>' +
          (sub ? '<div class="rec-node-sub">' + sub + '</div>' : '') +
          shot +
        '</div>' +
      '</div>';
  }).join('<div class="rec-connector"></div>');
}

function _recRenderLiveIncremental() {
  var map = document.getElementById('rec-live-map');
  if (map) map.innerHTML = _recMapHtml(_recState.live);
  var head = document.querySelector('.rec-detail-sub');
  // update sidebar live count
  var liveMeta = document.querySelector('.rec-list-item.rec-live .rec-list-meta');
  if (liveMeta) liveMeta.textContent = _recState.live.length + ' steps captured';
}

function selectRecording(id) {
  _recState.selectedId = id;
  if (id === '__live__') { _recState.current = null; renderRecordingsPage(); return; }
  _recApi('/api/recordings/' + id).then(function (d) {
    if (d && d.ok) _recState.current = d.recording;
    renderRecordingsPage();
  });
}

function _recRename(id, name) {
  _recApi('/api/recordings/' + id, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: name }) })
    .then(function () { _recRefreshList().then(renderRecordingsPage); });
}
function _recSaveDesc(id, desc) {
  _recApi('/api/recordings/' + id, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ description: desc }) });
}
function _recDeleteStep(id, stepId) {
  if (!_recState.current) return;
  var steps = (_recState.current.steps || []).filter(function (s) { return s.id !== stepId; });
  _recApi('/api/recordings/' + id, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ steps: steps }) })
    .then(function (d) { if (d && d.ok) { _recState.current = d.recording; renderRecordingsPage(); } });
}
function deleteRecording(id) {
  if (!confirm('Delete this recording?')) return;
  _recApi('/api/recordings/' + id, { method: 'DELETE' }).then(function () {
    if (_recState.selectedId === id) { _recState.selectedId = null; _recState.current = null; }
    _recRefreshList().then(renderRecordingsPage);
  });
}

// Replay: compile to browser-ext-action commands and run them sequentially.
function replayRecording(id) {
  if (typeof executeExtAction !== 'function') { alert('Connect the browser extension first.'); return; }
  _recApi('/api/recordings/' + id + '/compile').then(function (d) {
    if (!d || !d.ok) { alert('Compile failed'); return; }
    var actions = d.actions || [];
    if (!actions.length) { alert('Nothing replayable in this recording.'); return; }
    _recApi('/api/recordings/' + id + '/touch', { method: 'POST' });
    _recReplaySeq(actions, 0);
  });
}
function _recReplaySeq(actions, i) {
  if (i >= actions.length) { if (typeof showToast === 'function') showToast('Replay complete'); return; }
  executeExtAction(actions[i]).catch(function () {}).then(function () {
    setTimeout(function () { _recReplaySeq(actions, i + 1); }, 450);
  });
}

// Ask Fauna to recreate / adapt this flow — drop an outline into the composer.
function recreateRecording(id) {
  _recApi('/api/recordings/' + id + '/describe').then(function (d) {
    if (!d || !d.ok) { alert('Describe failed'); return; }
    var prompt = 'I recorded this browser flow. Recreate it (or adapt it as I describe) using browser-ext-action steps:\n\n' +
      '**' + d.name + '**' + (d.description ? ' — ' + d.description : '') + '\n\n' + d.outline;
    if (typeof closeAppPage === 'function') closeAppPage();
    if (!window.state || !state.currentId) { if (typeof newConversation === 'function') newConversation(); }
    var input = document.getElementById('msg-input');
    if (input) {
      input.value = prompt;
      input.dispatchEvent(new Event('input', { bubbles: true }));
      input.focus();
    }
  });
}
