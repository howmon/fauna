// ── AI inline autocomplete (ghost text) ──────────────────────────────────
// Copilot-style suggestions in the chat composer. As the user types, after a
// short idle, we ask the server for a SHORT continuation and render it as muted
// "ghost text" immediately after the caret. Tab accepts the whole suggestion,
// → accepts one word, Esc dismisses, and any divergent keystroke clears it.
//
// Deliberately unobtrusive:
//   • only fires when the caret is at the END of a non-trivial draft
//   • never while a slash/agent menu is open or the model is streaming
//   • debounced, rate-limited, and cancelable (stale requests are aborted)
//   • predictive: if the user types the next char(s) of the ghost, it just
//     shrinks the ghost locally — no network round-trip — so it feels instant
//
// Public surface (consumed by app.js wiring and the settings toggle):
//   window.aiAutocompleteOnInput(e)      — call on the composer 'input' event
//   window.aiAutocompleteOnKeydown(e)    — call on 'keydown'; returns true if
//                                          the key was consumed
//   window.aiAutocompleteSetEnabled(on)  — persist + apply the on/off setting
//   window.aiAutocompleteIsEnabled()
//   window.aiAutocompleteClear()         — drop any visible ghost (e.g. on send)

(function () {
  'use strict';

  var MIN_CHARS = 10;            // skip trivially short drafts
  var DEBOUNCE_MS = 500;         // idle time before asking the server
  var MIN_REQUEST_GAP_MS = 250;  // floor between network requests
  var ESC_COOLDOWN_MS = 1500;    // suppress re-suggesting right after Esc

  var enabled = localStorage.getItem('fauna-ai-autocomplete') !== '0';
  var suggestion = '';           // current ghost text (the part after the caret)
  var anchorValue = '';          // input value the suggestion was computed for
  var controller = null;         // in-flight fetch AbortController
  var timer = null;              // debounce timer
  var cooldownUntil = 0;
  var lastReqAt = 0;
  var cache = Object.create(null);   // draft text -> suggestion (or '')
  var overlay = null;
  var _origHint = null;

  function input() { return document.getElementById('msg-input'); }

  function menusOpen() {
    return (typeof slashAutocompleteOpen !== 'undefined' && slashAutocompleteOpen) ||
           (typeof agentAutocompleteOpen !== 'undefined' && agentAutocompleteOpen);
  }

  function streaming() {
    try {
      var conv = (typeof getConv === 'function' && typeof state !== 'undefined')
        ? getConv(state.currentId) : null;
      return !!(conv && conv._streaming);
    } catch (_) { return false; }
  }

  // ── Overlay (the mirror that paints the ghost) ──────────────────────────

  function ensureOverlay() {
    if (overlay) return overlay;
    var wrap = document.getElementById('input-wrap');
    var ta = input();
    if (!wrap || !ta) return null;
    overlay = document.createElement('div');
    overlay.id = 'ghost-text-overlay';
    overlay.setAttribute('aria-hidden', 'true');
    wrap.appendChild(overlay);
    ta.addEventListener('scroll', function () { if (overlay) overlay.scrollTop = ta.scrollTop; });
    ta.addEventListener('blur', clearSuggestion);
    window.addEventListener('resize', function () { if (suggestion) render(); });
    return overlay;
  }

  function positionOverlay() {
    if (!overlay) return;
    var ta = input();
    var wrap = document.getElementById('input-wrap');
    if (!ta || !wrap) return;
    var tr = ta.getBoundingClientRect();
    var wr = wrap.getBoundingClientRect();
    var cs = getComputedStyle(ta);
    overlay.style.left = (tr.left - wr.left) + 'px';
    overlay.style.top = (tr.top - wr.top) + 'px';
    overlay.style.width = tr.width + 'px';
    overlay.style.height = tr.height + 'px';
    // Mirror typography + padding exactly so the ghost lands on the caret.
    var props = ['fontFamily', 'fontSize', 'fontWeight', 'fontStyle', 'letterSpacing',
      'lineHeight', 'paddingTop', 'paddingRight', 'paddingBottom', 'paddingLeft',
      'textIndent', 'wordSpacing'];
    for (var i = 0; i < props.length; i++) overlay.style[props[i]] = cs[props[i]];
    overlay.scrollTop = ta.scrollTop;
  }

  function render() {
    var ta = input();
    if (!ta) return;
    // Guard against a stale ghost after a programmatic value change (e.g. send).
    if (!suggestion || ta.value !== anchorValue) {
      if (overlay) overlay.style.display = 'none';
      updateHint(false);
      return;
    }
    var ov = ensureOverlay();
    if (!ov) return;
    positionOverlay();
    ov.style.display = 'block';
    // Typed text is painted invisibly so the real textarea text shows through;
    // only the ghost continuation is painted (muted) at the caret position.
    ov.textContent = '';
    var typed = document.createElement('span');
    typed.className = 'ghost-typed';
    typed.textContent = ta.value;
    var ghost = document.createElement('span');
    ghost.className = 'ghost-suggestion';
    ghost.textContent = suggestion;
    ov.appendChild(typed);
    ov.appendChild(ghost);
    ov.scrollTop = ta.scrollTop;
    updateHint(true);
  }

  function clearSuggestion() {
    suggestion = '';
    anchorValue = '';
    if (controller) { try { controller.abort(); } catch (_) {} controller = null; }
    if (timer) { clearTimeout(timer); timer = null; }
    if (overlay) overlay.style.display = 'none';
    updateHint(false);
  }

  function updateHint(showing) {
    var h = document.getElementById('hint-text');
    if (!h) return;
    if (showing) {
      if (_origHint === null) _origHint = h.textContent;
      h.textContent = '⇥ accept · → word · esc dismiss';
    } else if (_origHint !== null) {
      h.textContent = _origHint;
      _origHint = null;
    }
  }

  // ── Trigger logic ───────────────────────────────────────────────────────

  function eligible(ta) {
    if (!enabled || !ta) return false;
    if (menusOpen() || streaming()) return false;
    if (Date.now() < cooldownUntil) return false;
    // Caret must be a collapsed selection at the very end of the draft.
    if (ta.selectionStart !== ta.value.length || ta.selectionEnd !== ta.value.length) return false;
    if (ta.value.trim().length < MIN_CHARS) return false;
    return true;
  }

  function onInput() {
    var ta = input();
    if (!ta) return;
    // Predictive consume: if the user typed exactly the next char(s) of the
    // current ghost, shrink the ghost locally instead of refetching.
    if (suggestion && anchorValue && ta.value.length > anchorValue.length &&
        ta.value.slice(0, anchorValue.length) === anchorValue) {
      var added = ta.value.slice(anchorValue.length);
      if (suggestion.slice(0, added.length) === added) {
        suggestion = suggestion.slice(added.length);
        anchorValue = ta.value;
        if (suggestion) { render(); return; }
      }
    }
    clearSuggestion();
    if (!eligible(ta)) return;
    var draft = ta.value;
    if (Object.prototype.hasOwnProperty.call(cache, draft)) {
      var cached = cache[draft];
      if (cached) { suggestion = cached; anchorValue = draft; render(); }
      return;
    }
    if (timer) clearTimeout(timer);
    timer = setTimeout(function () { fetchSuggestion(draft); }, DEBOUNCE_MS);
  }

  function recentContext() {
    try {
      var conv = getConv(state.currentId);
      if (!conv || !Array.isArray(conv.messages)) return [];
      return conv.messages
        .filter(function (m) { return m && (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string' && m.content.trim(); })
        .slice(-4)
        .map(function (m) { return { role: m.role, content: m.content }; });
    } catch (_) { return []; }
  }

  function fetchSuggestion(draft) {
    var ta = input();
    if (!ta || ta.value !== draft || !eligible(ta)) return;
    var now = Date.now();
    if (now - lastReqAt < MIN_REQUEST_GAP_MS) {
      timer = setTimeout(function () { fetchSuggestion(draft); }, MIN_REQUEST_GAP_MS);
      return;
    }
    lastReqAt = now;
    if (controller) { try { controller.abort(); } catch (_) {} }
    controller = new AbortController();
    fetch('/api/compose/suggest', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: draft, context: recentContext() }),
      signal: controller.signal,
    }).then(function (r) { return r.json(); }).then(function (data) {
      controller = null;
      var s = (data && data.suggestion) ? String(data.suggestion) : '';
      cache[draft] = s;
      var ta2 = input();
      if (!s || !ta2 || ta2.value !== draft || !eligible(ta2)) return;
      suggestion = s;
      anchorValue = draft;
      render();
    }).catch(function () { controller = null; });
  }

  // ── Acceptance ──────────────────────────────────────────────────────────

  function accept() {
    var ta = input();
    if (!ta || !suggestion) return false;
    var v = ta.value + suggestion;
    ta.value = v;
    ta.setSelectionRange(v.length, v.length);
    cache[anchorValue] = '';
    clearSuggestion();
    if (typeof resizeTextarea === 'function') resizeTextarea(ta);
    onInput(); // offer a follow-on suggestion from the new end
    return true;
  }

  function acceptWord() {
    var ta = input();
    if (!ta || !suggestion) return false;
    var m = suggestion.match(/^\s*\S+/);
    var chunk = m ? m[0] : suggestion;
    var v = ta.value + chunk;
    ta.value = v;
    ta.setSelectionRange(v.length, v.length);
    suggestion = suggestion.slice(chunk.length);
    anchorValue = v;
    if (typeof resizeTextarea === 'function') resizeTextarea(ta);
    if (suggestion) render(); else clearSuggestion();
    return true;
  }

  // Returns true if the key was consumed by the autocomplete.
  function onKeydown(e) {
    if (!suggestion || menusOpen()) return false;
    if (e.key === 'Tab' && !e.shiftKey && !e.ctrlKey && !e.metaKey && !e.altKey) {
      e.preventDefault();
      return accept();
    }
    if (e.key === 'Escape') {
      e.preventDefault();
      cooldownUntil = Date.now() + ESC_COOLDOWN_MS;
      clearSuggestion();
      return true;
    }
    if (e.key === 'ArrowRight') {
      var ta = input();
      if (ta && ta.selectionStart === ta.value.length) {
        e.preventDefault();
        return acceptWord();
      }
    }
    return false;
  }

  function setEnabled(on) {
    enabled = !!on;
    localStorage.setItem('fauna-ai-autocomplete', enabled ? '1' : '0');
    if (!enabled) clearSuggestion();
    if (typeof showToast === 'function') showToast('Inline AI suggestions ' + (enabled ? 'enabled' : 'disabled'));
  }

  window.aiAutocompleteOnInput = onInput;
  window.aiAutocompleteOnKeydown = onKeydown;
  window.aiAutocompleteSetEnabled = setEnabled;
  window.aiAutocompleteIsEnabled = function () { return enabled; };
  window.aiAutocompleteClear = clearSuggestion;
})();
