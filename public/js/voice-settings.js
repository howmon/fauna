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
    if (j.ok) { fillForm(j.settings); setStatus('Saved ✓'); }
    else      { setStatus('Save failed: ' + (j.error || 'unknown'), false); }
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

load();
