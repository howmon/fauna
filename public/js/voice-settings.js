// ── Voice settings renderer (Phase 7) ────────────────────────────────────
// Talks to /api/voice-settings. Pure DOM, no framework.

const $ = (id) => document.getElementById(id);
const status = $('status');

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
}

async function save() {
  const btn = $('save');
  btn.disabled = true;
  try {
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
