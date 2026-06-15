// ── Find in conversation ─────────────────────────────────────────────────
// Cmd/Ctrl+F opens an in-page search bar that highlights matches inside the
// currently visible conversation. Esc closes it. Enter / Shift+Enter cycle
// through matches. The bar is rendered lazily once, then re-used.
//
// Implementation notes:
//   * We don't lean on the browser's native find (which Electron disables in
//     packaged apps and also can't scope to the visible conv DOM).
//   * Highlighting wraps text nodes in <mark class="find-hit">. We restore
//     each modified element with a saved innerHTML snapshot when closing
//     or re-searching — cheaper than walking the tree to unwrap.
//   * Search is plain-substring, case-insensitive. No regex (too easy to
//     foot-gun for a chat search) but we strip diacritics on both sides so
//     "cafe" finds "café".

(function () {
  'use strict';

  // Elements where highlighting could break behaviour. We skip them entirely.
  var SKIP_SELECTOR = 'script, style, .find-bar, mark.find-hit, button, input, textarea, select, code .hljs-keyword, .copy-btn, .ti';

  var bar           = null;
  var input         = null;
  var counter       = null;
  var prevBtn       = null;
  var nextBtn       = null;
  var closeBtn      = null;

  // Highlight bookkeeping
  var hits          = [];                 // Array<HTMLElement> (mark.find-hit)
  var currentIdx    = -1;
  var modified      = [];                 // Array<{el, html}> for unhighlight
  var searchDebounce = null;

  function _norm(s) {
    return String(s || '')
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .toLowerCase();
  }

  function _activeConvInner() {
    var inner = document.getElementById('messages-inner');
    if (!inner) return null;
    // Conversation containers are direct children, hidden via display:none.
    var visible = Array.from(inner.children).find(function (c) {
      return c.style.display !== 'none';
    });
    return visible || null;
  }

  function _ensureBar() {
    if (bar) return bar;
    bar = document.createElement('div');
    bar.className = 'find-bar hidden';
    bar.setAttribute('role', 'search');
    bar.innerHTML =
      '<i class="ti ti-search"></i>' +
      '<input type="search" placeholder="Find in conversation" aria-label="Find in conversation" autocomplete="off" />' +
      '<span class="find-count" aria-live="polite">0/0</span>' +
      '<button type="button" class="find-btn" data-act="prev" title="Previous (Shift+Enter)" aria-label="Previous match"><i class="ti ti-chevron-up"></i></button>' +
      '<button type="button" class="find-btn" data-act="next" title="Next (Enter)" aria-label="Next match"><i class="ti ti-chevron-down"></i></button>' +
      '<button type="button" class="find-btn" data-act="close" title="Close (Esc)" aria-label="Close find"><i class="ti ti-x"></i></button>';
    // Mount over the messages pane so it's visible from any conversation.
    var host = document.getElementById('messages') || document.body;
    host.appendChild(bar);

    input    = bar.querySelector('input');
    counter  = bar.querySelector('.find-count');
    prevBtn  = bar.querySelector('[data-act="prev"]');
    nextBtn  = bar.querySelector('[data-act="next"]');
    closeBtn = bar.querySelector('[data-act="close"]');

    input.addEventListener('input', function () {
      clearTimeout(searchDebounce);
      searchDebounce = setTimeout(_runSearch, 80);
    });
    input.addEventListener('keydown', function (ev) {
      if (ev.key === 'Escape') { ev.preventDefault(); close(); return; }
      if (ev.key === 'Enter') {
        ev.preventDefault();
        if (ev.shiftKey) _step(-1); else _step(1);
      }
    });
    prevBtn .addEventListener('click', function () { _step(-1); input.focus(); });
    nextBtn .addEventListener('click', function () { _step( 1); input.focus(); });
    closeBtn.addEventListener('click', close);

    return bar;
  }

  function _clearHighlights() {
    // Restore original HTML for every element we touched. Walking the live
    // DOM to unwrap <mark> nodes is more code and slower than restoring a
    // snapshot.
    for (var i = 0; i < modified.length; i++) {
      try { modified[i].el.innerHTML = modified[i].html; } catch (_) {}
    }
    modified = [];
    hits     = [];
    currentIdx = -1;
  }

  function _highlight(root, needle) {
    if (!root || !needle) return;
    var needleNorm = _norm(needle);
    if (!needleNorm) return;

    // Collect candidate elements: any element holding text inside a message
    // body. We snapshot innerHTML before mutating so we can restore on close.
    var bodies = root.querySelectorAll('.msg-body, .reasoning-panel, .think-text');
    if (!bodies.length) {
      // Fall back to direct children in case the conv has custom markup.
      bodies = root.querySelectorAll('*');
    }
    bodies.forEach(function (body) {
      // Walk text nodes within this body.
      var walker = document.createTreeWalker(body, NodeFilter.SHOW_TEXT, {
        acceptNode: function (n) {
          if (!n.nodeValue || !n.nodeValue.trim()) return NodeFilter.FILTER_REJECT;
          // Skip nodes inside elements we shouldn't touch.
          var p = n.parentElement;
          while (p && p !== body) {
            if (p.matches && p.matches(SKIP_SELECTOR)) return NodeFilter.FILTER_REJECT;
            p = p.parentElement;
          }
          return NodeFilter.FILTER_ACCEPT;
        },
      });
      var nodes = [];
      while (walker.nextNode()) nodes.push(walker.currentNode);
      if (!nodes.length) return;

      var anyHit = false;
      for (var i = 0; i < nodes.length; i++) {
        var node = nodes[i];
        var text = node.nodeValue;
        var textNorm = _norm(text);
        if (textNorm.indexOf(needleNorm) < 0) continue;
        if (!anyHit) {
          modified.push({ el: body, html: body.innerHTML });
          anyHit = true;
        }
        // Walk through this single text node and wrap matches. Because we
        // just snapshotted the parent's innerHTML, mutating is safe.
        var frag = document.createDocumentFragment();
        var rest = text;
        var restNorm = textNorm;
        while (true) {
          var idx = restNorm.indexOf(needleNorm);
          if (idx < 0) {
            if (rest) frag.appendChild(document.createTextNode(rest));
            break;
          }
          if (idx > 0) frag.appendChild(document.createTextNode(rest.slice(0, idx)));
          var mk = document.createElement('mark');
          mk.className = 'find-hit';
          mk.textContent = rest.substr(idx, needle.length);
          frag.appendChild(mk);
          rest     = rest.slice(idx + needle.length);
          restNorm = restNorm.slice(idx + needleNorm.length);
        }
        try { node.parentNode.replaceChild(frag, node); } catch (_) {}
      }
    });

    hits = Array.from(root.querySelectorAll('mark.find-hit'));
  }

  function _runSearch() {
    if (!bar) return;
    _clearHighlights();
    var needle = (input.value || '').trim();
    var root   = _activeConvInner();
    if (!needle || !root) {
      counter.textContent = needle ? '0/0' : '';
      counter.classList.toggle('find-no-hits', !!needle);
      return;
    }
    _highlight(root, needle);
    if (!hits.length) {
      counter.textContent = '0/0';
      counter.classList.add('find-no-hits');
      return;
    }
    counter.classList.remove('find-no-hits');
    currentIdx = 0;
    _focusCurrent();
  }

  function _step(dir) {
    if (!hits.length) return;
    currentIdx = (currentIdx + dir + hits.length) % hits.length;
    _focusCurrent();
  }

  function _focusCurrent() {
    if (!hits.length) return;
    for (var i = 0; i < hits.length; i++) hits[i].classList.remove('find-hit-active');
    var cur = hits[currentIdx];
    if (!cur) return;
    cur.classList.add('find-hit-active');
    counter.textContent = (currentIdx + 1) + '/' + hits.length;
    try { cur.scrollIntoView({ block: 'center', behavior: 'smooth' }); } catch (_) {
      try { cur.scrollIntoView(); } catch (__) {}
    }
  }

  function open() {
    _ensureBar();
    bar.classList.remove('hidden');
    // Pre-fill with selection if the user had text selected.
    try {
      var sel = window.getSelection && window.getSelection().toString();
      if (sel && sel.length && sel.length <= 100) input.value = sel;
    } catch (_) {}
    input.focus();
    input.select();
    if (input.value) _runSearch();
  }

  function close() {
    if (!bar) return;
    bar.classList.add('hidden');
    _clearHighlights();
    if (counter) { counter.textContent = ''; counter.classList.remove('find-no-hits'); }
    // Return focus to the composer if available so typing keeps working.
    var composer = document.getElementById('chat-input');
    if (composer && typeof composer.focus === 'function') composer.focus();
  }

  function toggle() {
    if (bar && !bar.classList.contains('hidden')) close();
    else open();
  }

  // Global Cmd/Ctrl+F handler. We swallow the event so Electron's default
  // browser find (which isn't wired up anyway) doesn't fire.
  document.addEventListener('keydown', function (ev) {
    var isFindKey = (ev.key === 'f' || ev.key === 'F') && (ev.metaKey || ev.ctrlKey) && !ev.altKey;
    if (!isFindKey) return;
    // Don't hijack when the user is in a different context (e.g. agent
    // builder modal with its own search field). Allow opt-out via
    // data-find-opt-out on any ancestor.
    var t = ev.target;
    while (t && t !== document.body) {
      if (t.dataset && t.dataset.findOptOut === 'true') return;
      t = t.parentElement;
    }
    ev.preventDefault();
    open();
  });

  // Also close on Esc anywhere, but only if the bar is open.
  document.addEventListener('keydown', function (ev) {
    if (ev.key === 'Escape' && bar && !bar.classList.contains('hidden')) {
      // Don't fight other Esc handlers if the input is the focused element
      // (the input's own keydown handler already runs first).
      if (document.activeElement === input) return;
      close();
    }
  });

  // Expose minimal API for callers that want a button.
  window.findInConversation = { open: open, close: close, toggle: toggle };
})();
