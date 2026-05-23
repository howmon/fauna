// ── In-conversation text-selection menu ───────────────────────────────────
// Shows a small floating bubble above selected text inside conversation
// message bodies. Provides quick actions: Copy, Quote in chat, Ask Fauna,
// Search Google.

(function () {
  var bubble = null;
  var lastSelectionText = '';
  var hideTimer = null;

  function ensureBubble() {
    if (bubble) return bubble;
    bubble = document.createElement('div');
    bubble.id = 'selection-menu';
    bubble.className = 'selection-menu hidden';
    bubble.setAttribute('role', 'toolbar');
    bubble.innerHTML =
      '<button type="button" data-act="copy"   title="Copy selection (\u2318C)"><i class="ti ti-copy"></i><span>Copy</span></button>' +
      '<button type="button" data-act="quote"  title="Quote in chat input"><i class="ti ti-quote"></i><span>Quote</span></button>' +
      '<button type="button" data-act="ask"    title="Ask Fauna about this"><i class="ti ti-sparkles"></i><span>Ask</span></button>' +
      '<button type="button" data-act="search" title="Search Google in your browser"><i class="ti ti-search"></i><span>Google</span></button>';
    document.body.appendChild(bubble);

    // Prevent the menu's own mousedown from collapsing the selection before
    // the click handler fires.
    bubble.addEventListener('mousedown', function (e) { e.preventDefault(); });
    bubble.addEventListener('click', onAction);
    return bubble;
  }

  function hide() {
    if (!bubble) return;
    bubble.classList.add('hidden');
  }

  function scheduleHide() {
    if (hideTimer) clearTimeout(hideTimer);
    hideTimer = setTimeout(hide, 60);
  }

  function isInsideMsgBody(node) {
    var el = node && node.nodeType === 1 ? node : node && node.parentElement;
    while (el && el !== document.body) {
      // Skip editable controls (chat input, code editors, textareas).
      if (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA') return false;
      if (el.isContentEditable) return false;
      if (el.classList && el.classList.contains('msg-body')) return true;
      el = el.parentElement;
    }
    return false;
  }

  function position(rect) {
    var el = ensureBubble();
    el.classList.remove('hidden');
    var bw = el.offsetWidth || 220;
    var bh = el.offsetHeight || 32;
    var margin = 8;

    // Default: above the selection, horizontally centered.
    var left = rect.left + rect.width / 2 - bw / 2;
    var top  = rect.top - bh - margin;

    // Flip below if there isn't room above.
    if (top < 8) top = rect.bottom + margin;

    // Clamp to viewport.
    var vw = window.innerWidth, vh = window.innerHeight;
    left = Math.max(8, Math.min(vw - bw - 8, left));
    top  = Math.max(8, Math.min(vh - bh - 8, top));

    el.style.left = left + 'px';
    el.style.top  = top  + 'px';
  }

  function updateForSelection() {
    var sel = window.getSelection && window.getSelection();
    if (!sel || sel.isCollapsed || sel.rangeCount === 0) { hide(); return; }
    var text = sel.toString();
    if (!text || !text.trim()) { hide(); return; }
    var range = sel.getRangeAt(0);
    if (!isInsideMsgBody(range.startContainer) && !isInsideMsgBody(range.endContainer)) {
      hide(); return;
    }
    var rect = range.getBoundingClientRect();
    if (!rect || (rect.width === 0 && rect.height === 0)) { hide(); return; }
    lastSelectionText = text;
    position(rect);
  }

  function onAction(e) {
    var btn = e.target.closest('button[data-act]');
    if (!btn) return;
    var act  = btn.getAttribute('data-act');
    var text = lastSelectionText || '';
    if (!text.trim()) return;

    if (act === 'copy') {
      try {
        if (navigator.clipboard && navigator.clipboard.writeText) {
          navigator.clipboard.writeText(text);
        } else {
          document.execCommand && document.execCommand('copy');
        }
        if (typeof toast === 'function') toast('Copied');
      } catch (_) { /* noop */ }
    } else if (act === 'quote') {
      insertIntoInput('> ' + text.replace(/\n/g, '\n> ') + '\n\n');
    } else if (act === 'ask') {
      var prompt = text.length > 240
        ? 'Please explain or comment on this selection:\n\n"""\n' + text + '\n"""\n\n'
        : 'About this: "' + text + '"\n\n';
      insertIntoInput(prompt);
    } else if (act === 'search') {
      var url = 'https://www.google.com/search?q=' + encodeURIComponent(text);
      if (typeof electronAPI !== 'undefined' && electronAPI.openExternal) {
        electronAPI.openExternal(url);
      } else {
        window.open(url, '_blank', 'noopener');
      }
    }
    hide();
  }

  function insertIntoInput(prefix) {
    var input = document.getElementById('msg-input');
    if (!input) return;
    var cur = input.value || '';
    var sep = cur && !/\n$/.test(cur) ? '\n' : '';
    input.value = cur + sep + prefix;
    // Match the textarea auto-grow used elsewhere.
    if (typeof resizeTextarea === 'function') resizeTextarea(input);
    input.focus();
    // Place caret at the end so the user can type immediately.
    try {
      var end = input.value.length;
      input.setSelectionRange(end, end);
    } catch (_) {}
  }

  // ── Wire-up ──────────────────────────────────────────────────────────────
  document.addEventListener('mouseup', function (e) {
    // Ignore clicks inside the bubble itself (handled by its own listener).
    if (bubble && bubble.contains(e.target)) return;
    // Defer so the browser has finalized the selection.
    setTimeout(updateForSelection, 0);
  });

  document.addEventListener('keyup', function (e) {
    // Keyboard-driven selections (Shift+Arrow, Ctrl+A inside a message).
    if (e.shiftKey || e.key === 'Shift' || e.key === 'a' || e.key === 'A') {
      setTimeout(updateForSelection, 0);
    }
  });

  // Hide when the user starts a new mousedown outside the bubble (about to
  // collapse the selection or click somewhere else).
  document.addEventListener('mousedown', function (e) {
    if (bubble && bubble.contains(e.target)) return;
    scheduleHide();
  });

  // Hide on scroll inside the conversation area — the rect would otherwise
  // become stale and the bubble would float in the wrong place.
  document.addEventListener('scroll', function () { hide(); }, true);

  window.addEventListener('resize', hide);
  window.addEventListener('blur', hide);
}());
