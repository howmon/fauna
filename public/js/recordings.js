// ── Browser Action Recordings page ────────────────────────────────────────
// Record the user's actions across browser tabs (via the Fauna extension),
// view them as a visual map/timeline, edit them, replay them, and ask Fauna to
// recreate a similar flow. Live steps stream in over SSE while recording.

var _recState = { recording: false, paused: false, live: [], selectedId: null, current: null, list: [] };

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
    '.rec-btn.rec-pause{margin-top:8px}',
    '.rec-btn.rec-resume{margin-top:8px;background:color-mix(in oklab,var(--accent,#4c8bf5) 16%,transparent);border-color:var(--accent,#4c8bf5)}',
    '.rec-shots-opt{display:flex;align-items:center;gap:6px;font-size:11px;color:var(--fau-text-muted);margin:2px 0 2px;cursor:pointer}',
    '.rec-paused-badge{display:inline-flex;align-items:center;gap:5px;font-size:11px;font-weight:600;color:var(--fau-text-muted)}',
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
    '.rec-node-caret{font-size:13px;margin-right:2px;color:var(--fau-text-muted)}',
    '.rec-node.editing{background:var(--fau-surface2);border-radius:10px;padding:8px;margin-left:-8px}',
    '.rec-editor{margin-top:10px;display:flex;flex-direction:column;gap:8px;max-width:460px}',
    '.rec-editor-type{font-size:11px;color:var(--fau-text-dim)}',
    '.rec-field{display:flex;flex-direction:column;gap:3px}',
    '.rec-field>span{font-size:11px;color:var(--fau-text-muted)}',
    '.rec-field-input{border:1px solid var(--fau-border);border-radius:6px;background:var(--fau-surface);color:var(--fau-text);font:inherit;font-size:12px;padding:6px 8px}',
    '.rec-field-input:focus{outline:none;border-color:var(--accent);box-shadow:0 0 0 3px var(--accent-glow)}',
    '.rec-editor-actions{display:flex;gap:6px;margin-top:4px}',
    '.rec-ask-wrap{margin:2px 0 18px;padding:12px;border:1px solid var(--fau-border);border-radius:10px;background:var(--fau-surface2)}',
    '.rec-ask-label{display:flex;align-items:center;gap:6px;font-size:12px;font-weight:600;color:var(--fau-text);margin-bottom:7px}',
    '.rec-ask-label .ti{color:var(--accent2)}',
    '.rec-ask{width:100%;min-height:46px;resize:vertical;border:1px solid var(--fau-border);border-radius:8px;background:var(--fau-surface);color:var(--fau-text);font:inherit;font-size:13px;padding:8px 10px;margin-bottom:8px}',
    '.rec-ask:focus{outline:none;border-color:var(--accent);box-shadow:0 0 0 3px var(--accent-glow)}',
    '.rec-abtn.primary{background:var(--accent);border-color:var(--accent);color:#fff;font-weight:600}',
    '.rec-abtn.primary:hover{filter:brightness(1.07);background:var(--accent)}',
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
  // NOTE: plain same-origin path — do NOT use faunaStreamUrl here (that rewrites
  // to the alternate loopback host for SSE streams and would make these regular
  // API calls cross-origin → CORS-blocked).
  return fetch(path, opts).then(function (r) {
    if (typeof console !== 'undefined') console.log('[recorder] ' + ((opts && opts.method) || 'GET') + ' ' + path + ' → ' + r.status);
    if (!r.ok) return r.text().then(function (t) { console.warn('[recorder] ' + path + ' body:', String(t).slice(0, 300)); return { ok: false, error: 'HTTP ' + r.status }; });
    return r.json();
  }).catch(function (e) {
    if (typeof console !== 'undefined') console.error('[recorder] ' + path + ' fetch error:', e && e.message);
    throw e;
  });
}

function _recRefreshStatus() {
  if (typeof executeExtAction !== 'function') return Promise.resolve();
  return executeExtAction({ action: 'record:status' }).then(function (r) {
    _recState.recording = !!(r && r.recording);
    _recState.paused = !!(r && r.paused);
    renderRecordingsPage();
  }).catch(function () {});
}

// Save the renderer's own captured steps (incl. streamed screenshots) right
// away, deduped with the extension's copy via sessionId. This is the primary,
// reliable save path so a recording never gets stuck on “saving…”.
//   - First try WITH screenshots.
//   - If that fails/hangs, retry WITHOUT screenshots (a tiny, fast payload) so
//     the recording ALWAYS saves; the extension's socket copy (recording:complete)
//     upserts the screenshots back in by sessionId when it arrives.
function _recPostJson(path, obj, timeoutMs) {
  // Same-origin only (see _recApi note about faunaStreamUrl / CORS).
  var body = JSON.stringify(obj);
  if (typeof console !== 'undefined') console.log('[recorder] POST ' + path + ' (' + body.length + ' bytes, ' + (obj.steps ? obj.steps.length : 0) + ' steps)');
  var ctrl = (typeof AbortController !== 'undefined') ? new AbortController() : null;
  var to = ctrl ? setTimeout(function () { try { ctrl.abort(); } catch (_) {} }, timeoutMs || 15000) : null;
  return fetch(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: body, signal: ctrl ? ctrl.signal : undefined })
    .then(function (r) {
      if (to) clearTimeout(to);
      if (typeof console !== 'undefined') console.log('[recorder] POST ' + path + ' → ' + r.status);
      if (!r.ok) return r.text().then(function (t) { console.warn('[recorder] POST body:', String(t).slice(0, 300)); return { ok: false, error: 'HTTP ' + r.status }; });
      return r.json();
    })
    .catch(function (e) {
      if (to) clearTimeout(to);
      if (typeof console !== 'undefined') console.error('[recorder] POST ' + path + ' error:', (e && e.name) + ' ' + (e && e.message));
      throw e;
    });
}

function _recSaveLiveNow(retries, lite) {
  var steps = _recState.live || [];
  if (!steps.length) {
    if ((retries || 0) < 4) { setTimeout(function () { _recSaveFallback(0); }, 400); }
    return;
  }
  var dur = steps[steps.length - 1].t || 0;
  var payloadSteps = lite
    ? steps.map(function (s) { var o = {}; for (var k in s) { if (k !== 'shot') o[k] = s[k]; } return o; })
    : steps;
  if (typeof dbg === 'function') dbg('recorder: saving ' + payloadSteps.length + ' steps' + (lite ? ' (no screenshots)' : ''), 'info');
  _recPostJson('/api/recordings', {
    sessionId: _recState.sessionId || null,
    name: 'Recording — ' + new Date().toLocaleString(),
    startedAt: Date.now() - dur, endedAt: Date.now(), durationMs: dur, steps: payloadSteps,
  }, 15000).then(function (d) {
    if (d && d.ok && d.recording) {
      _recState.saveError = false;
      if (typeof dbg === 'function') dbg('recorder: saved ' + d.recording.id, 'ok');
      _recRefreshList().then(function () {
        if (_recState.selectedId === '__live__') selectRecording(d.recording.id);
      });
    } else {
      _recSaveRetry(retries, lite, 'bad-response');
    }
  }).catch(function (err) {
    _recSaveRetry(retries, lite, (err && err.name === 'AbortError') ? 'timeout' : ((err && err.message) || 'error'));
  });
}

function _recSaveRetry(retries, lite, why) {
  retries = retries || 0;
  if (typeof dbg === 'function') dbg('recorder: save failed (' + why + ')' + (lite ? '' : ' — retrying without screenshots'), 'warn');
  if (!lite) { setTimeout(function () { _recSaveLiveNow(retries, true); }, 300); return; }
  if (retries < 2) { setTimeout(function () { _recSaveLiveNow(retries + 1, true); }, 700); return; }
  _recState.saveError = true;
  renderRecordingsPage();
  if (typeof showToast === 'function') showToast('Could not save recording (' + why + ') — click Retry save', true);
}

// Manual retry from the "Save failed" state.
function _recRetrySave() {
  _recState.saveError = false;
  renderRecordingsPage();
  _recSaveLiveNow(0);
}

function _recRefreshList() {
  return _recApi('/api/recordings').then(function (d) {
    if (d && d.ok) _recState.list = d.recordings || [];
  }).catch(function () {});
}

// After Stop, the extension ships the recording to the app over the socket and
// the app broadcasts ext:recording-saved. If that SSE is missed, poll the list
// a few times and open the newest recording so we never get stuck on "saving…".
function _recSaveFallback(attempt) {
  if (_recState.selectedId !== '__live__') return; // already resolved (SSE won)
  var known = (_recState.list || []).map(function (r) { return r.id; });
  _recRefreshList().then(function () {
    if (_recState.selectedId !== '__live__') return;
    var fresh = (_recState.list || []).find(function (r) { return known.indexOf(r.id) === -1; });
    if (fresh) { selectRecording(fresh.id); return; }
    if (attempt < 4) { setTimeout(function () { _recSaveFallback(attempt + 1); }, 500 + attempt * 400); return; }
    // Extension's save never materialised — persist the renderer's own live
    // copy (includes streamed screenshots) so the recording is not lost.
    var steps = _recState.live || [];
    if (steps.length) {
      var dur = steps[steps.length - 1].t || 0;
      _recApi('/api/recordings', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'Recording — ' + new Date().toLocaleString(), startedAt: Date.now() - dur, endedAt: Date.now(), durationMs: dur, steps: steps }),
      }).then(function (d) {
        if (d && d.ok && d.recording) { _recRefreshList().then(function () { selectRecording(d.recording.id); }); }
        else { _recState.selectedId = null; renderRecordingsPage(); }
      });
    } else { _recState.selectedId = null; renderRecordingsPage(); }
  });
}

function toggleRecording() {
  if (typeof executeExtAction !== 'function') {
    alert('Connect the Fauna browser extension first.');
    return;
  }
  if (_recState.recording) {
    // Optimistic: stop flashing immediately. Tell the extension to stop, and
    // ALSO save our own live copy right away (with screenshots) so persistence
    // never depends on the extension→socket→save round-trip. Both saves dedupe
    // to one entry via sessionId.
    _recState.recording = false;
    _recState.paused = false;
    renderRecordingsPage();
    executeExtAction({ action: 'record:stop' }).catch(function () {});
    _recSaveLiveNow();
  } else {
    _recState.live = [];
    _recState.selectedId = '__live__';
    _recState.recording = true;
    _recState.paused = false;
    _recState.current = null;
    _recState.saveError = false;
    renderRecordingsPage();
    executeExtAction({ action: 'record:start' }).catch(function (e) {
      _recState.recording = false;
      renderRecordingsPage();
      var m = String((e && e.message) || e);
      if (/unknown action/i.test(m)) {
        alert('Your Fauna Browser Bridge extension is out of date.\n\nOpen chrome://extensions → enable Developer mode → click Reload on "Fauna Browser Bridge" (loaded from the repo\'s browser-extension/ folder). Remove the older "FaunaBrowserMCP" extension if it is also installed.\n\nNote: rebuilding the desktop app does NOT update the browser extension — reload it separately.');
      } else {
        alert('Start failed — is the browser extension connected? ' + m);
      }
    });
  }
}

// Pause / resume — keep the session open but stop (or restart) capturing.
function pauseResumeRecording() {
  if (typeof executeExtAction !== 'function' || !_recState.recording) return;
  var resume = _recState.paused;
  _recState.paused = !resume; // optimistic
  renderRecordingsPage();
  executeExtAction({ action: resume ? 'record:resume' : 'record:pause' }).catch(function (e) {
    _recState.paused = resume; // revert on failure
    renderRecordingsPage();
    var m = String((e && e.message) || e);
    if (/unknown action/i.test(m)) {
      alert('Your Fauna Browser Bridge extension is out of date — reload it in chrome://extensions to enable pause/resume.');
    }
  });
}

// SSE hook — called from browser.js _handleExtEvent for recording:* events.
function _onRecordingEvent(msg) {
  var page0 = document.getElementById('rec-page');
  if (msg.event === 'ext:recording-error') {
    _recState.recording = false;
    if (typeof showToast === 'function') showToast('Recording save failed: ' + ((msg.data && msg.data.error) || ''), true);
    if (_recState.selectedId === '__live__') { _recState.selectedId = null; }
    if (page0) renderRecordingsPage();
    return;
  }
  var page = document.getElementById('rec-page');
  if (msg.event === 'recording:started') {
    _recState.recording = true; _recState.live = []; _recState.selectedId = '__live__'; _recState.saveError = false;
    _recState.paused = false;
    _recState.sessionId = (msg.data && msg.data.sessionId) || null;
    if (page) renderRecordingsPage();
  } else if (msg.event === 'recording:paused') {
    _recState.paused = true;
    if (page) renderRecordingsPage();
  } else if (msg.event === 'recording:resumed') {
    _recState.paused = false;
    if (page) renderRecordingsPage();
  } else if (msg.event === 'recording:step') {
    _recState.live.push(msg.data || {});
    if (page && _recState.selectedId === '__live__') _recRenderLiveIncremental();
  } else if (msg.event === 'recording:step-shot') {
    var st = _recState.live.find(function (s) { return s.id === msg.data.id; });
    if (st) { st.shot = msg.data.shot; if (page && _recState.selectedId === '__live__') _recRenderLiveIncremental(); }
  } else if (msg.event === 'recording:stopped') {
    _recState.recording = false;
    _recState.paused = false;
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
    ? '<button class="rec-btn rec-stop" onclick="toggleRecording()"><span class="rec-dot"></span> Stop recording</button>' +
      (_recState.paused
        ? '<button class="rec-btn rec-resume" onclick="pauseResumeRecording()"><i class="ti ti-player-play-filled"></i> Resume</button>'
        : '<button class="rec-btn rec-pause" onclick="pauseResumeRecording()"><i class="ti ti-player-pause-filled"></i> Pause</button>')
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
        '<div class="rec-list-title">' + (_recState.paused ? '<i class="ti ti-player-pause-filled"></i> Paused' : '<span class="rec-dot"></span> Recording…') + '</div>' +
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
    var head, sub;
    if (flashing) {
      head = _recState.paused ? '<i class="ti ti-player-pause-filled"></i> Paused' : '<span class="rec-dot"></span> Live recording';
      sub = _recState.live.length + (_recState.paused ? ' steps — resume to keep capturing' : ' steps — perform actions in your browser');
    } else if (_recState.saveError) {
      head = '<i class="ti ti-alert-triangle" style="color:var(--error)"></i> Save failed';
      sub = _recState.live.length + ' steps — <button class="rec-abtn" onclick="_recRetrySave()"><i class="ti ti-refresh"></i> Retry save</button>';
    } else {
      head = '<i class="ti ti-player-record"></i> Recording finished';
      sub = _recState.live.length + ' steps — saving…';
    }
    return '<div class="rec-detail-head"><div class="rec-detail-title">' + head + '</div></div>' +
      '<div class="rec-detail-sub">' + sub + '</div>' +
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
    '<div class="rec-ask-wrap">' +
      '<label class="rec-ask-label"><i class="ti ti-wand"></i> Instructions for Fauna (run this, or adapt it)</label>' +
      '<textarea class="rec-ask" id="rec-ask-input" placeholder="Optional — tell Fauna how to adapt this flow. e.g. “Do the same but on the Artifact panel page.” or “Use the Marketing file as the destination.” Leave blank to just recreate it as recorded.">' + _recEsc(_recState.askText || '') + '</textarea>' +
      '<label class="rec-shots-opt"><input type="checkbox" id="rec-include-shots"> Include step screenshots as context (uses more tokens)</label>' +
      '<button class="rec-abtn primary" onclick="recreateRecording(\'' + rec.id + '\')"><i class="ti ti-sparkles"></i> Ask Fauna to run / adapt</button>' +
    '</div>' +
    '<div class="rec-map">' + _recMapHtml(rec.steps || [], rec.id) + '</div>';
}

// The visual map: a timeline of step nodes with connectors + thumbnails.
// For saved recordings (recId set), clicking a node expands an editable panel.
function _recMapHtml(steps, recId) {
  if (!steps || !steps.length) return '<div class="rec-empty-sm">No steps.</div>';
  return steps.map(function (s, i) {
    var prev = steps[i - 1];
    var gap = prev ? '<div class="rec-gap">+' + _recFmtDur((s.t || 0) - (prev.t || 0)) + '</div>' : '';
    var shot = s.shot ? '<img class="rec-shot" src="' + _recEsc(s.shot) + '" loading="lazy">' : '';
    var sub = s.url ? _recEsc(String(s.url).replace(/^https?:\/\//, '').slice(0, 60)) : _recEsc(s.selector || '');
    var editable = !!recId;
    var open = editable && _recState.editingStep === s.id;
    var del = editable ? '<button class="rec-step-del" title="Delete step" onclick="event.stopPropagation();_recDeleteStep(\'' + recId + '\',\'' + s.id + '\')">×</button>' : '';
    var caret = editable ? '<i class="ti ti-' + (open ? 'chevron-down' : 'chevron-right') + ' rec-node-caret"></i>' : '';
    var click = editable ? ' onclick="_recToggleStepEdit(\'' + s.id + '\')" style="cursor:pointer"' : '';
    return gap +
      '<div class="rec-node' + (open ? ' editing' : '') + '"' + click + '>' +
        '<div class="rec-node-icon"><i class="ti ' + _recTypeIcon(s.type) + '"></i></div>' +
        '<div class="rec-node-body">' +
          '<div class="rec-node-title">' + caret + (i + 1) + '. ' + _recEsc(_recStepPrimary(s)) + del + '</div>' +
          (sub ? '<div class="rec-node-sub">' + sub + '</div>' : '') +
          shot +
          (open ? _recStepEditorHtml(recId, s) : '') +
        '</div>' +
      '</div>';
  }).join('<div class="rec-connector"></div>');
}

// Editable fields per step type. Renders a small form; edits are saved on click.
function _recStepFields(type) {
  switch (type) {
    case 'navigate': case 'tabswitch': return [['url', 'URL'], ['title', 'Title']];
    case 'click': return [['selector', 'Selector'], ['label', 'Label'], ['x', 'X'], ['y', 'Y']];
    case 'input': return [['selector', 'Selector'], ['label', 'Label'], ['value', 'Value']];
    case 'select': return [['selector', 'Selector'], ['value', 'Value'], ['label', 'Label']];
    case 'toggle': case 'submit': return [['selector', 'Selector']];
    case 'key': return [['keys', 'Keys (e.g. Meta+c)']];
    case 'copy': case 'cut': case 'paste': case 'selection': return [['text', 'Text']];
    default: return [['selector', 'Selector']];
  }
}

function _recStepEditorHtml(recId, s) {
  var rows = _recStepFields(s.type).map(function (f) {
    var key = f[0], label = f[1];
    var val = s[key] != null ? s[key] : '';
    return '<label class="rec-field"><span>' + label + '</span>' +
      '<input class="rec-field-input" data-field="' + key + '" value="' + _recEsc(val) + '"></label>';
  }).join('');
  rows += '<label class="rec-field"><span>Note</span>' +
    '<input class="rec-field-input" data-field="note" value="' + _recEsc(s.note || '') + '" placeholder="Optional note"></label>';
  return '<div class="rec-editor" id="rec-editor-' + s.id + '" onclick="event.stopPropagation()">' +
    '<div class="rec-editor-type">Type: <b>' + _recEsc(s.type) + '</b> · <span class="muted">+' + _recFmtDur(s.t || 0) + '</span></div>' +
    rows +
    '<div class="rec-editor-actions">' +
      '<button class="rec-abtn" onclick="_recSaveStep(\'' + recId + '\',\'' + s.id + '\')"><i class="ti ti-check"></i> Save step</button>' +
      '<button class="rec-abtn" onclick="_recToggleStepEdit(\'' + s.id + '\')">Cancel</button>' +
      '<button class="rec-abtn danger" onclick="_recDeleteStep(\'' + recId + '\',\'' + s.id + '\')"><i class="ti ti-trash"></i> Delete</button>' +
    '</div>' +
  '</div>';
}

function _recToggleStepEdit(stepId) {
  _recState.editingStep = (_recState.editingStep === stepId) ? null : stepId;
  renderRecordingsPage();
}

function _recSaveStep(recId, stepId) {
  if (!_recState.current) return;
  var box = document.getElementById('rec-editor-' + stepId);
  if (!box) return;
  var patch = {};
  box.querySelectorAll('[data-field]').forEach(function (inp) { patch[inp.getAttribute('data-field')] = inp.value; });
  var steps = (_recState.current.steps || []).map(function (st) {
    if (st.id !== stepId) return st;
    var n = Object.assign({}, st);
    for (var k in patch) {
      if (k === 'x' || k === 'y') n[k] = Number(patch[k]) || 0;
      else if (patch[k] === '') delete n[k];
      else n[k] = patch[k];
    }
    return n;
  });
  _recApi('/api/recordings/' + recId, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ steps: steps }) })
    .then(function (d) {
      if (d && d.ok) { _recState.current = d.recording; _recState.editingStep = null; renderRecordingsPage(); if (typeof showToast === 'function') showToast('Step updated'); }
    });
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
  // Repaint right away (leave any "saving…" state); fill in details when loaded.
  _recState.current = (_recState.list || []).find(function (r) { return r.id === id; }) || null;
  renderRecordingsPage();
  _recApi('/api/recordings/' + id).then(function (d) {
    if (d && d.ok) { _recState.current = d.recording; renderRecordingsPage(); }
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
  var adaptEl = document.getElementById('rec-ask-input');
  var adapt = adaptEl ? adaptEl.value.trim() : '';
  var shotsEl = document.getElementById('rec-include-shots');
  var includeShots = !!(shotsEl && shotsEl.checked);
  _recApi('/api/recordings/' + id + '/describe').then(function (d) {
    if (!d || !d.ok) { alert('Describe failed'); return; }
    var intro = adapt
      ? 'Adapt this recorded browser flow as follows: ' + adapt + '\n\nOriginal flow:\n'
      : 'Recreate this recorded browser flow in my real browser.\n\n';
    var prompt = intro +
      '**' + d.name + '**' + (d.description ? ' — ' + d.description : '') + '\n\n' + d.outline + '\n\n' +
      'EXECUTE this now — actually run the steps in my real browser via `browser-ext-action`. Do NOT just describe the plan; do the work.\n\n' +
      'Rules:\n' +
      '1. First emit a `browser-ext-action` block `{"action":"tab:list"}` to get the real numeric tab ids, then keep going.\n' +
      '2. Use the REAL browser extension via `browser-ext-action` ONLY. Do NOT call the `fauna_browser` tool — that drives the in-app webview which cannot see my real Chrome tabs and will be blank.\n' +
      '3. Use those REAL numeric tabIds in every action — never placeholders like SOURCE_TAB_ID.\n' +
      '4. One JSON object per line, no prose inside the code block.\n' +
      '5. For Figma/canvas use `mouse-click`, `key`, `copy`, `paste` (not plain click/keyboard).\n' +
      '6. Do it SAFELY (don\'t refuse — just do it the safe way): click into the CANVAS and select the actual frame/content before copy, click the destination CANVAS before paste. Do NOT select-all/copy/paste while the Pages panel or a page row is focused (that deletes/overwrites pages).\n' +
      '7. VERIFY with `snapshot` (a screenshot), NOT `extract` — for Figma/canvas apps `extract` only reads the DOM sidebar text and does NOT reflect canvas changes, so it will look unchanged even when a paste worked. Take a snapshot after each paste to actually see the result.\n' +
      '8. Continue through ALL the requested items one by one — don\'t stop after one to explain.\n' +
      'If Figma has an MCP/plugin available, prefer `figma_execute` (cloning nodes via the plugin API is far more reliable than pixel-clicking the canvas).';
    if (typeof closeAppPage === 'function') closeAppPage();
    if (!window.state || !state.currentId) { if (typeof newConversation === 'function') newConversation(); }
    var input = document.getElementById('msg-input');
    if (input) {
      input.value = prompt;
      input.dispatchEvent(new Event('input', { bubbles: true }));
      input.focus();
    }
    // Screenshots are saved with the recording (visible in the map) but are NOT
    // sent to the model by default — only attach them if the user opts in.
    if (includeShots) _recAttachShots(id);
  });
}

// Attach the recording's step screenshots as image attachments so the AI can
// SEE the flow (vision context), not just the text outline.
function _recAttachShots(id) {
  var rec = (_recState.current && _recState.current.id === id) ? _recState.current : null;
  if (rec) { _recAttachShotList((rec.steps || []).filter(function (s) { return s.shot; })); return; }
  _recApi('/api/recordings/' + id).then(function (d) {
    if (d && d.ok && d.recording) _recAttachShotList((d.recording.steps || []).filter(function (s) { return s.shot; }));
  });
}

function _recAttachShotList(withShots) {
  if (typeof addAttachment !== 'function' || !withShots || !withShots.length) return;
  // Cap to a handful so we don't blow the attachment limit / context window.
  var pick = withShots.slice(0, 6);
  var n = 0;
  pick.forEach(function (s, i) {
    var m = String(s.shot || '').match(/^data:([^;]+);base64,(.+)$/);
    if (!m) return;
    addAttachment({ type: 'image', extSource: 'recording', name: 'Step ' + (i + 1) + ' — ' + (s.type || 'action'), base64: m[2], mime: m[1] });
    n++;
  });
  if (n && typeof showToast === 'function') showToast(n + ' screenshot' + (n > 1 ? 's' : '') + ' attached to chat');
}
