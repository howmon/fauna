// ── Resident (background) voice settings — Phase 7 ──────────────────────
// Talks to /api/voice-settings (the Electron-side Whisper voice stack).
// Distinct from voice.js, which controls the in-page Chromium voice control.

(function () {
  const $ = (id) => document.getElementById(id);

  function setStatus(msg, ok = true) {
    const el = $('rv-status');
    if (!el) return;
    el.textContent = msg || '';
    el.style.color = ok ? 'var(--fau-text-dim)' : 'var(--err, #f85149)';
    if (msg) setTimeout(() => { if (el.textContent === msg) el.textContent = ''; }, 3500);
  }

  async function loadVoices(selected) {
    try {
      const r = await fetch('/api/voice-settings/voices');
      const j = await r.json();
      const sel = $('rv-ttsVoice');
      if (!sel) return;
      while (sel.options.length > 1) sel.remove(1);
      for (const v of (j.voices || [])) {
        const opt = document.createElement('option');
        opt.value = v.name;
        opt.textContent = v.language ? `${v.name} (${v.language})` : v.name;
        sel.appendChild(opt);
      }
      if (selected) sel.value = selected;
    } catch (e) {
      console.warn('[rv] voices fetch failed', e);
    }
  }

  function fill(s) {
    if (!$('rv-wakeWords')) return; // page not in DOM yet
    $('rv-wakeWords').value         = (s.wakeWords || []).join('\n');
    $('rv-wakeRequired').checked    = !!s.wakeRequired;
    $('rv-followUpWindowMs').value  = s.followUpWindowMs;
    $('rv-ttsEnabled').checked      = !!s.ttsEnabled;
    $('rv-ttsRate').value            = s.ttsRate ?? '';
    $('rv-dictationAccel').value    = s.dictationAccel || '';
    $('rv-dictationPasteOnFinish').checked = !!s.dictationPasteOnFinish;
    $('rv-redactEmail').checked      = !!s.redactEmail;
    $('rv-redactPhone').checked      = !!s.redactPhone;
    $('rv-redactCreditCard').checked = !!s.redactCreditCard;
    $('rv-toolTopK').value           = s.toolTopK;
    $('rv-toolMustKeep').value       = (s.toolMustKeep || []).join(', ');
    loadVoices(s.ttsVoice || '');
  }

  function read() {
    const rate = $('rv-ttsRate').value.trim();
    return {
      wakeWords:        $('rv-wakeWords').value.split('\n').map(w => w.trim()).filter(Boolean),
      wakeRequired:     $('rv-wakeRequired').checked,
      followUpWindowMs: parseInt($('rv-followUpWindowMs').value, 10) || undefined,
      ttsEnabled:       $('rv-ttsEnabled').checked,
      ttsVoice:         $('rv-ttsVoice').value,
      ttsRate:          rate === '' ? null : Number(rate),
      dictationAccel:   $('rv-dictationAccel').value.trim(),
      dictationPasteOnFinish: $('rv-dictationPasteOnFinish').checked,
      redactEmail:      $('rv-redactEmail').checked,
      redactPhone:      $('rv-redactPhone').checked,
      redactCreditCard: $('rv-redactCreditCard').checked,
      toolTopK:         parseInt($('rv-toolTopK').value, 10) || undefined,
      toolMustKeep:     $('rv-toolMustKeep').value.split(',').map(s => s.trim()).filter(Boolean),
    };
  }

  async function load() {
    try {
      const r = await fetch('/api/voice-settings');
      const j = await r.json();
      if (j && j.ok) fill(j.settings);
    } catch (e) {
      console.warn('[rv] load failed', e);
    }
  }

  async function save() {
    try {
      const r = await fetch('/api/voice-settings', {
        method:  'PATCH',
        headers: { 'content-type': 'application/json' },
        body:    JSON.stringify(read()),
      });
      const j = await r.json();
      if (j && j.ok) { fill(j.settings); setStatus('Saved ✓'); }
      else            { setStatus('Save failed: ' + (j && j.error || 'unknown'), false); }
    } catch (e) {
      setStatus('Save failed: ' + e.message, false);
    }
  }

  async function reset() {
    if (!confirm('Reset background voice settings to defaults?')) return;
    try {
      const r = await fetch('/api/voice-settings/reset', { method: 'POST' });
      const j = await r.json();
      if (j && j.ok) { fill(j.settings); setStatus('Reset ✓'); }
    } catch (e) {
      setStatus('Reset failed: ' + e.message, false);
    }
  }

  window.rvSaveSettings  = save;
  window.rvResetSettings = reset;
  window.rvLoadSettings  = load;

  // Initial load when the Voice settings page is reachable. Re-run when
  // the user navigates to it (Settings sidebar uses data-page="voice").
  function init() {
    if (!document.querySelector('[data-resident-voice]')) return;
    load();
  }
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

  // Reload whenever the Voice settings page becomes visible (sidebar click).
  // The sidebar uses inline onclick="switchSettingsPage('voice', this)" — wrap it.
  const _origSwitch = window.switchSettingsPage;
  if (typeof _origSwitch === 'function') {
    window.switchSettingsPage = function (page, el) {
      const r = _origSwitch.apply(this, arguments);
      if (page === 'voice') setTimeout(load, 50);
      return r;
    };
  } else {
    // switchSettingsPage may be defined after this script. Fall back to a
    // delegated click listener on the nav button.
    document.addEventListener('click', (e) => {
      const t = e.target.closest('button[data-page="voice"]');
      if (t) setTimeout(load, 50);
    });
  }
})();
