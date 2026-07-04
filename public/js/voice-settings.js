// ── Voice settings renderer (Phase 7) ────────────────────────────────────
// Talks to /api/voice-settings. Pure DOM, no framework.

const $ = (id) => document.getElementById(id);
const status = $('status');

// Renderer-only prefs that live in localStorage (shared per-origin with the
// main window where voice.js reads them via getVoiceSetting). These cover
// UX toggles that don't need to touch the on-disk JSON.
const LOCAL_KEY = 'fauna-voice-settings';
const LOCAL_DEFAULTS = {
  dictSilenceMs:  1500,
  dictPTTEnabled: true,
  dictPTTAutoSend: false,
  voiceAudioCues: true,
};
function _localStore() {
  try { return JSON.parse(localStorage.getItem(LOCAL_KEY) || '{}'); }
  catch (_) { return {}; }
}
function _localGet(key) {
  const s = _localStore();
  return s[key] === undefined ? LOCAL_DEFAULTS[key] : s[key];
}
function _localSet(patch) {
  const s = _localStore();
  Object.assign(s, patch);
  localStorage.setItem(LOCAL_KEY, JSON.stringify(s));
}

function setStatus(msg, ok = true) {
  status.textContent = msg;
  status.style.color = ok ? 'var(--ok)' : 'var(--err)';
  if (msg) setTimeout(() => { if (status.textContent === msg) status.textContent = ''; }, 3500);
}

async function loadVoices(selected) {
  try {
    const r = await fetch('/api/voice-settings/voices');
    const j = await r.json();
    const sel = $('ttsVoice');
    while (sel.options.length > 1) sel.remove(1);
    for (const v of (j.voices || [])) {
      const opt = document.createElement('option');
      opt.value = v.name;
      opt.textContent = v.language ? `${v.name} (${v.language})` : v.name;
      sel.appendChild(opt);
    }
    if (selected) sel.value = selected;
  } catch (e) {
    console.warn('failed to load voices:', e);
  }
}

function fillForm(s) {
  $('wakeWords').value         = (s.wakeWords || []).join('\n');
  $('wakeRequired').checked    = !!s.wakeRequired;
  $('followUpWindowMs').value  = s.followUpWindowMs;
  $('ttsEnabled').checked      = !!s.ttsEnabled;
  $('ttsRate').value            = s.ttsRate ?? '';
  $('dictationAccel').value    = s.dictationAccel || '';
  $('dictationPasteOnFinish').checked = !!s.dictationPasteOnFinish;
  _pendingDeviceId = s.dictationDeviceId || '';
  refreshMicList();
  $('whisperLanguage').value    = s.whisperLanguage || 'auto';
  $('whisperHotWords').value    = s.whisperHotWords || '';
  // Whisper model dropdown gets populated by refreshWhisperModels(); we just
  // remember the desired alias so refreshWhisperModels can select it once
  // the model list arrives.
  _pendingWhisperModel = s.whisperModel || 'base.en';
  refreshWhisperModels();
  // STT engine + Parakeet model
  $('sttEngine').value = s.sttEngine || 'whisper';
  _pendingParakeetModel = s.parakeetModel || 'parakeet-tdt-0.6b-v2';
  refreshParakeetModels();
  applyEngineVisibility();
  $('redactEmail').checked      = !!s.redactEmail;
  $('redactPhone').checked      = !!s.redactPhone;
  $('redactCreditCard').checked = !!s.redactCreditCard;
  $('toolTopK').value           = s.toolTopK;
  $('toolMustKeep').value       = (s.toolMustKeep || []).join(', ');
  loadVoices(s.ttsVoice || '');
  // Renderer-only prefs (PTT, audio cues, silence threshold)
  fillLocalForm();
}

function fillLocalForm() {
  $('dictSilenceMs').value      = _localGet('dictSilenceMs');
  $('dictPTTEnabled').checked   = !!_localGet('dictPTTEnabled');
  $('dictPTTAutoSend').checked  = !!_localGet('dictPTTAutoSend');
  $('voiceAudioCues').checked   = !!_localGet('voiceAudioCues');
}

function saveLocalForm() {
  const raw = $('dictSilenceMs').value.trim();
  const ms  = raw === '' ? LOCAL_DEFAULTS.dictSilenceMs : Math.max(0, Math.min(10000, parseInt(raw, 10) || 0));
  _localSet({
    dictSilenceMs:  ms,
    dictPTTEnabled: $('dictPTTEnabled').checked,
    dictPTTAutoSend:$('dictPTTAutoSend').checked,
    voiceAudioCues: $('voiceAudioCues').checked,
  });
}

function readForm() {
  const rate = $('ttsRate').value.trim();
  return {
    wakeWords:        $('wakeWords').value.split('\n').map(w => w.trim()).filter(Boolean),
    wakeRequired:     $('wakeRequired').checked,
    followUpWindowMs: parseInt($('followUpWindowMs').value, 10) || undefined,
    ttsEnabled:       $('ttsEnabled').checked,
    ttsVoice:         $('ttsVoice').value,
    ttsRate:          rate === '' ? null : Number(rate),
    dictationAccel:   $('dictationAccel').value.trim(),
    dictationPasteOnFinish: $('dictationPasteOnFinish').checked,
    dictationDeviceId: $('dictationDeviceId').value || '',
    whisperModel:     $('whisperModel').value || undefined,
    whisperLanguage:  $('whisperLanguage').value || undefined,
    whisperHotWords:  $('whisperHotWords').value,
    sttEngine:        $('sttEngine').value || undefined,
    parakeetModel:    $('parakeetModel').value || undefined,
    redactEmail:      $('redactEmail').checked,
    redactPhone:      $('redactPhone').checked,
    redactCreditCard: $('redactCreditCard').checked,
    toolTopK:         parseInt($('toolTopK').value, 10) || undefined,
    toolMustKeep:     $('toolMustKeep').value.split(',').map(s => s.trim()).filter(Boolean),
  };
}

async function load() {
  const r = await fetch('/api/voice-settings');
  const j = await r.json();
  if (j.ok) fillForm(j.settings);
  // Make sure renderer-only fields populate even if the server call failed.
  fillLocalForm();
}

async function save() {
  const btn = $('save');
  btn.disabled = true;
  try {
    // Renderer-only prefs first — they're cheap and even if the server PATCH
    // fails the user keeps the PTT/cue choices.
    saveLocalForm();
    const r = await fetch('/api/voice-settings', {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body:    JSON.stringify(readForm()),
    });
    const j = await r.json();
    if (j.ok) {
      fillForm(j.settings);
      setStatus('Saved ✓');
      // If the main window is open, push the new accelerator into its PTT
      // listener without a reload. (Same-origin → window.opener may be null,
      // so we BroadcastChannel it.)
      try {
        const bc = new BroadcastChannel('fauna-voice');
        bc.postMessage({ type: 'dictationAccel',   value: j.settings.dictationAccel });
        bc.postMessage({ type: 'dictationDeviceId', value: j.settings.dictationDeviceId || '' });
        bc.close();
      } catch (_) {}
    } else {
      setStatus('Save failed: ' + (j.error || 'unknown'), false);
    }
  } catch (e) {
    setStatus('Save failed: ' + e.message, false);
  } finally {
    btn.disabled = false;
  }
}

async function reset() {
  if (!confirm('Reset all voice settings to defaults?')) return;
  // Wipe renderer-only prefs too so the form fully resets.
  try { localStorage.removeItem(LOCAL_KEY); } catch (_) {}
  const r = await fetch('/api/voice-settings/reset', { method: 'POST' });
  const j = await r.json();
  if (j.ok) { fillForm(j.settings); setStatus('Reset ✓'); }
}

async function testVoice() {
  // Save first so the new voice/rate are picked up by TTS defaults.
  await save();
  // Then ping a tiny utterance through the existing /api endpoint surface
  // by leaning on the chat route's TTS isn't available here; for a quick
  // smoke check we just rely on the user enabling "Listen in background"
  // and triggering a real reply. Fallback: speak via Web Speech API if
  // present so the user gets *some* feedback.
  try {
    const u = new SpeechSynthesisUtterance('This is Fauna with your selected voice.');
    const v = $('ttsVoice').value;
    if (v) {
      const match = speechSynthesis.getVoices().find(x => x.name === v);
      if (match) u.voice = match;
    }
    speechSynthesis.speak(u);
    setStatus('Playing sample…');
  } catch (e) {
    setStatus('Preview unavailable in this window', false);
  }
}

$('save').addEventListener('click', save);
$('reset').addEventListener('click', reset);
$('testVoice').addEventListener('click', testVoice);
$('refreshMics').addEventListener('click', () => refreshMicList(true));

// ── Microphone picker ───────────────────────────────────────────────────
// enumerateDevices() only returns labels after mic permission has been
// granted to the origin. If we don't see any labels, prompt for permission
// the first time the user clicks Re-scan.
let _pendingDeviceId = '';

async function refreshMicList(askPermission) {
  const sel  = $('dictationDeviceId');
  const hint = $('micHint');
  if (!sel) return;
  try {
    if (askPermission) {
      // Quick permission ping; we immediately stop the tracks.
      try {
        const s = await navigator.mediaDevices.getUserMedia({ audio: true });
        s.getTracks().forEach(t => t.stop());
      } catch (_) { /* user denied — labels stay empty */ }
    }
    const all = await navigator.mediaDevices.enumerateDevices();
    const mics = all.filter(d => d.kind === 'audioinput');
    // Keep first option (System default), replace the rest.
    while (sel.options.length > 1) sel.remove(1);
    let hasLabels = false;
    for (const d of mics) {
      const opt = document.createElement('option');
      opt.value = d.deviceId;
      opt.textContent = d.label || ('Microphone ' + (d.deviceId || '').slice(0, 8));
      if (d.label) hasLabels = true;
      sel.appendChild(opt);
    }
    // Restore selection if it still exists.
    if (_pendingDeviceId && mics.some(d => d.deviceId === _pendingDeviceId)) {
      sel.value = _pendingDeviceId;
    } else if (_pendingDeviceId) {
      // Saved device gone — fall back to default and tell the user.
      sel.value = '';
      if (hint) hint.textContent = 'Previously-selected microphone is no longer connected. Reverted to system default.';
      return;
    }
    if (hint) {
      hint.textContent = hasLabels
        ? (mics.length + ' input device' + (mics.length === 1 ? '' : 's') + ' detected.')
        : 'Click Re-scan and grant microphone permission to see device names.';
    }
  } catch (e) {
    if (hint) hint.textContent = 'Failed to list microphones: ' + e.message;
  }
}

// ── Whisper model picker ──────────────────────────────────────────────
// Renders the list of available Whisper.cpp models from
// GET /api/whisper-model-status and lets the user download / delete each.
let _pendingWhisperModel = null;

function _fmtBytes(n) {
  if (!n) return '—';
  if (n < 1024 * 1024) return Math.round(n / 1024) + ' KB';
  if (n < 1024 * 1024 * 1024) return (n / (1024 * 1024)).toFixed(1) + ' MB';
  return (n / (1024 * 1024 * 1024)).toFixed(2) + ' GB';
}

async function refreshWhisperModels() {
  const dropdown = $('whisperModel');
  const list     = $('whisperModelList');
  const hint     = $('whisperModelHint');
  if (!dropdown || !list) return;
  let data;
  try {
    const r = await fetch('/api/whisper-model-status');
    data = await r.json();
  } catch (e) {
    list.innerHTML = '<p class="hint" style="color:var(--err)">Failed to load model list: ' + e.message + '</p>';
    return;
  }
  const models = Array.isArray(data.models) ? data.models : [];

  // Repopulate the <select>. We only let the user pick installed models
  // (selecting an uninstalled one would silently fall back to whatever's
  // already on disk — confusing). Uninstalled ones go in an optgroup with
  // a hint to download them below.
  while (dropdown.options.length) dropdown.remove(0);
  const installed = models.filter(m => m.installed);
  const missing   = models.filter(m => !m.installed);
  for (const m of installed) {
    const opt = document.createElement('option');
    opt.value = m.alias;
    opt.textContent = m.label + (m.sizeBytes ? '  —  ' + _fmtBytes(m.sizeBytes) : '');
    dropdown.appendChild(opt);
  }
  if (!installed.length) {
    const opt = document.createElement('option');
    opt.value = '';
    opt.textContent = '(no models installed — download one below)';
    dropdown.appendChild(opt);
  }

  // Try to honour the saved selection if it's installed.
  const wantedRaw = _pendingWhisperModel || data.model;
  const wanted = wantedRaw && installed.some(m => m.alias === wantedRaw) ? wantedRaw
               : (installed[0] && installed[0].alias) || '';
  if (wanted) dropdown.value = wanted;
  _pendingWhisperModel = null;

  if (hint) {
    const sel = installed.find(m => m.alias === dropdown.value);
    hint.textContent = sel ? (sel.speed + ' — ' + _fmtBytes(sel.sizeBytes)) : '';
  }

  // Render install/delete rows for the full catalogue.
  list.innerHTML = '';
  const header = document.createElement('p');
  header.className = 'hint';
  header.style.marginBottom = '8px';
  header.textContent = 'Available models:';
  list.appendChild(header);

  for (const m of models) {
    const row = document.createElement('div');
    row.style.cssText = 'display:flex;align-items:center;gap:10px;padding:6px 0;border-top:1px solid var(--border)';
    const label = document.createElement('div');
    label.style.cssText = 'flex:1;min-width:0';
    label.innerHTML = '<div><strong>' + m.label + '</strong></div>' +
      '<div class="hint">~' + m.sizeMB + ' MB — ' + m.speed +
      (m.installed ? ' — <span style="color:var(--ok)">installed (' + _fmtBytes(m.sizeBytes) + ')</span>' : '') +
      '</div>';
    row.appendChild(label);
    if (m.installed) {
      const del = document.createElement('button');
      del.type = 'button';
      del.className = 'ghost';
      del.textContent = 'Delete';
      del.addEventListener('click', () => deleteWhisperModel(m.alias));
      row.appendChild(del);
    } else {
      const dl = document.createElement('button');
      dl.type = 'button';
      dl.textContent = 'Download';
      dl.addEventListener('click', () => downloadWhisperModel(m.alias, dl));
      row.appendChild(dl);
    }
    list.appendChild(row);
  }
}

async function deleteWhisperModel(alias) {
  if (!confirm('Delete the ' + alias + ' model file?')) return;
  try {
    const r = await fetch('/api/whisper-model-delete', {
      method:  'POST',
      headers: { 'content-type': 'application/json' },
      body:    JSON.stringify({ model: alias }),
    });
    const j = await r.json();
    if (j.ok) {
      setStatus('Deleted ' + alias);
      refreshWhisperModels();
    } else {
      setStatus('Delete failed: ' + (j.error || 'unknown'), false);
    }
  } catch (e) {
    setStatus('Delete failed: ' + e.message, false);
  }
}

function downloadWhisperModel(alias, btn) {
  const origLabel = btn ? btn.textContent : '';
  if (btn) { btn.disabled = true; btn.textContent = '0%'; }
  // SSE — stream curl progress events.
  const es = new EventSource('/api/whisper-model-download?model=' + encodeURIComponent(alias));
  es.onmessage = (ev) => {
    try {
      const data = JSON.parse(ev.data);
      if (data.error) {
        if (btn) { btn.disabled = false; btn.textContent = origLabel || 'Download'; }
        setStatus('Download failed: ' + data.error, false);
        es.close();
        return;
      }
      if (typeof data.pct === 'number' && btn) btn.textContent = data.pct + '%';
      if (data.ready) {
        es.close();
        if (btn) { btn.disabled = false; btn.textContent = 'Installed'; }
        setStatus(alias + ' installed ✓');
        refreshWhisperModels();
      }
    } catch (_) { /* ignore parse errors */ }
  };
  es.onerror = () => {
    es.close();
    if (btn) { btn.disabled = false; btn.textContent = origLabel || 'Download'; }
    setStatus('Download stream interrupted', false);
  };
}

// Update hint when user changes selection
$('whisperModel').addEventListener('change', () => {
  const hint = $('whisperModelHint');
  if (!hint) return;
  // We don't keep the full catalogue around, so just clear; refresh on save.
  hint.textContent = '';
});

// ── STT engine selector ───────────────────────────────────────────────
// Toggles which model section is visible and describes the active engine.
function applyEngineVisibility() {
  const engine = $('sttEngine') ? $('sttEngine').value : 'whisper';
  const wsec = $('whisperSection');
  const psec = $('parakeetSection');
  if (wsec) wsec.style.display = engine === 'whisper' ? '' : 'none';
  if (psec) psec.style.display = engine === 'parakeet' ? '' : 'none';
  const hint = $('sttEngineHint');
  if (hint) {
    hint.textContent = engine === 'parakeet'
      ? 'Parakeet transcribes in-process with near-zero latency. Works the same on macOS, Windows, and Linux.'
      : 'Whisper runs the bundled whisper.cpp binary. Broad language coverage; slightly higher latency.';
  }
}

if ($('sttEngine')) {
  $('sttEngine').addEventListener('change', applyEngineVisibility);
}

// ── Parakeet model picker ─────────────────────────────────────────────
// Mirrors the Whisper picker against /api/parakeet-model-status. Each model
// is four files, so progress/state comes from the whole-folder install check.
let _pendingParakeetModel = null;

async function refreshParakeetModels() {
  const dropdown = $('parakeetModel');
  const list     = $('parakeetModelList');
  const hint     = $('parakeetModelHint');
  if (!dropdown || !list) return;
  let data;
  try {
    const r = await fetch('/api/parakeet-model-status');
    data = await r.json();
  } catch (e) {
    list.innerHTML = '<p class="hint" style="color:var(--err)">Failed to load model list: ' + e.message + '</p>';
    return;
  }
  const models = Array.isArray(data.models) ? data.models : [];

  while (dropdown.options.length) dropdown.remove(0);
  const installed = models.filter(m => m.installed);
  for (const m of installed) {
    const opt = document.createElement('option');
    opt.value = m.alias;
    opt.textContent = m.label;
    dropdown.appendChild(opt);
  }
  if (!installed.length) {
    const opt = document.createElement('option');
    opt.value = '';
    opt.textContent = '(no models installed — download one below)';
    dropdown.appendChild(opt);
  }

  const wantedRaw = _pendingParakeetModel || data.model;
  const wanted = wantedRaw && installed.some(m => m.alias === wantedRaw) ? wantedRaw
               : (installed[0] && installed[0].alias) || '';
  if (wanted) dropdown.value = wanted;
  _pendingParakeetModel = null;

  if (hint) {
    const sel = installed.find(m => m.alias === dropdown.value);
    hint.textContent = sel ? (sel.langs + ' — ' + sel.speed + ' — ~' + sel.sizeMB + ' MB') : '';
  }

  list.innerHTML = '';
  const header = document.createElement('p');
  header.className = 'hint';
  header.style.marginBottom = '8px';
  header.textContent = 'Available models:';
  list.appendChild(header);

  for (const m of models) {
    const row = document.createElement('div');
    row.style.cssText = 'display:flex;align-items:center;gap:10px;padding:6px 0;border-top:1px solid var(--border)';
    const label = document.createElement('div');
    label.style.cssText = 'flex:1;min-width:0';
    label.innerHTML = '<div><strong>' + m.label + '</strong></div>' +
      '<div class="hint">' + m.langs + ' — ~' + m.sizeMB + ' MB — ' + m.speed +
      (m.installed ? ' — <span style="color:var(--ok)">installed</span>' : '') +
      '</div>';
    row.appendChild(label);
    if (m.installed) {
      const del = document.createElement('button');
      del.type = 'button';
      del.className = 'ghost';
      del.textContent = 'Delete';
      del.addEventListener('click', () => deleteParakeetModel(m.alias));
      row.appendChild(del);
    } else {
      const dl = document.createElement('button');
      dl.type = 'button';
      dl.textContent = 'Download';
      dl.addEventListener('click', () => downloadParakeetModel(m.alias, dl));
      row.appendChild(dl);
    }
    list.appendChild(row);
  }
}

async function deleteParakeetModel(alias) {
  if (!confirm('Delete the ' + alias + ' model (all four files)?')) return;
  try {
    const r = await fetch('/api/parakeet-model-delete', {
      method:  'POST',
      headers: { 'content-type': 'application/json' },
      body:    JSON.stringify({ model: alias }),
    });
    const j = await r.json();
    if (j.ok) {
      setStatus('Deleted ' + alias);
      refreshParakeetModels();
    } else {
      setStatus('Delete failed: ' + (j.error || 'unknown'), false);
    }
  } catch (e) {
    setStatus('Delete failed: ' + e.message, false);
  }
}

function downloadParakeetModel(alias, btn) {
  const origLabel = btn ? btn.textContent : '';
  if (btn) { btn.disabled = true; btn.textContent = '0%'; }
  const es = new EventSource('/api/parakeet-model-download?model=' + encodeURIComponent(alias));
  es.onmessage = (ev) => {
    try {
      const data = JSON.parse(ev.data);
      if (data.error) {
        if (btn) { btn.disabled = false; btn.textContent = origLabel || 'Download'; }
        setStatus('Download failed: ' + data.error, false);
        es.close();
        return;
      }
      if (typeof data.pct === 'number' && btn) btn.textContent = data.pct + '%';
      if (data.ready) {
        es.close();
        if (btn) { btn.disabled = false; btn.textContent = 'Installed'; }
        setStatus(alias + ' installed ✓');
        refreshParakeetModels();
      }
    } catch (_) { /* ignore parse errors */ }
  };
  es.onerror = () => {
    es.close();
    if (btn) { btn.disabled = false; btn.textContent = origLabel || 'Download'; }
    setStatus('Download stream interrupted', false);
  };
}

load();
