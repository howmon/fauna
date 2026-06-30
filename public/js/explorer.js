// public/js/explorer.js
//
// Explore page — a GenUI-first "front door". The user starts with a short
// conversational prompt; Fauna turns it into an interactive gen-ui view. Every
// view can expose drill-down Buttons (action: "explore_into") that push a new
// node onto a journey stack. A breadcrumb shows the path so the user can branch
// off in a new direction or step back to any earlier view (cached → instant).
// While a view's JSON is loading, a skeleton placeholder keeps the page from
// feeling laggy. A floating chat control is always available as the escape
// hatch when the on-screen call-to-action doesn't meet the user's need.

(function () {
  // Journey state. journey = [{ title, prompt, spec }], idx = current node.
  var EX = { journey: [], idx: -1, reqId: 0 };
  window._faunaExplorer = EX;

  // ── Page open / close ────────────────────────────────────────────────────

  function openExplorerPage() {
    var body = (typeof _openAppPage === 'function') ? _openAppPage('explorer', 'Explore') : null;
    if (!body) return;
    renderExplorerShell(body);
    if (EX.journey.length && EX.idx >= 0) loadNode(EX.idx);
    else renderFrontDoor();
  }
  window.openExplorerPage = openExplorerPage;

  function closeExplorerPage() {
    if (typeof closeAppPage === 'function') closeAppPage();
  }
  window.closeExplorerPage = closeExplorerPage;

  // ── Shell ──────────────────────────────────────────────────────────────

  function renderExplorerShell(body) {
    body.innerHTML =
      '<div class="explorer-shell">' +
        '<div class="explorer-topbar">' +
          '<div id="explorer-breadcrumb" class="explorer-breadcrumb"></div>' +
        '</div>' +
        '<div id="explorer-content" class="explorer-content"></div>' +
      '</div>' +
      '<button class="explorer-fab" onclick="toggleExplorerChat()" title="Ask in chat" aria-label="Ask in chat"><i class="ti ti-message-2"></i></button>' +
      '<div class="explorer-chat-panel" id="explorer-chat-panel" hidden>' +
        '<div class="explorer-chat-head"><i class="ti ti-message-2"></i><span>Ask in chat</span>' +
          '<button class="explorer-chat-x" onclick="toggleExplorerChat(false)" aria-label="Close"><i class="ti ti-x"></i></button>' +
        '</div>' +
        '<p class="explorer-chat-hint">CTA not cutting it? Describe what you actually need and Fauna will pick it up in the full chat.</p>' +
        '<textarea id="explorer-chat-input" class="explorer-chat-input" rows="3" placeholder="What do you need to do?"></textarea>' +
        '<button class="explorer-chat-send" onclick="explorerChatSend()">Send to chat <i class="ti ti-arrow-right"></i></button>' +
      '</div>';
  }

  // ── Front door (conversational start) ────────────────────────────────────

  var SUGGESTIONS = [
    'Compare the top 5 electric SUVs',
    'Break down how a transformer model works',
    'Plan a 3-day trip to Lisbon',
    'Show the state of my project at a glance',
  ];

  function renderFrontDoor() {
    EX.idx = -1;
    renderBreadcrumb();
    var content = document.getElementById('explorer-content');
    if (!content) return;
    var chips = SUGGESTIONS.map(function (s) {
      return '<button class="explorer-chip" onclick="_explorerChip(this)" data-prompt="' + escHtml(s) + '">' + escHtml(s) + '</button>';
    }).join('');
    content.innerHTML =
      '<div class="explorer-hero">' +
        '<div class="explorer-hero-badge"><i class="ti ti-compass"></i> Explore</div>' +
        '<h1 class="explorer-hero-title">What do you want to explore?</h1>' +
        '<p class="explorer-hero-sub">Start a conversation. Fauna turns it into an interactive view you can keep clicking deeper — your path shows up as a breadcrumb so you can branch off or step back anytime.</p>' +
        '<div class="explorer-hero-input-row">' +
          '<textarea id="explorer-prompt" class="explorer-hero-input" rows="1" placeholder="e.g. Compare the top 5 electric SUVs"></textarea>' +
          '<button class="explorer-hero-go" onclick="_explorerSubmitFrontDoor()" aria-label="Explore"><i class="ti ti-arrow-right"></i></button>' +
        '</div>' +
        '<div class="explorer-chips">' + chips + '</div>' +
        tieHtml() +
      '</div>';
    var ta = document.getElementById('explorer-prompt');
    if (ta) {
      var autosize = function () { ta.style.height = 'auto'; ta.style.height = Math.min(ta.scrollHeight, 200) + 'px'; };
      ta.addEventListener('input', autosize);
      ta.addEventListener('keydown', function (e) {
        if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); _explorerSubmitFrontDoor(); }
      });
      setTimeout(function () { try { ta.focus(); } catch (_) {} }, 0);
    }
  }

  window._explorerSubmitFrontDoor = function () {
    var ta = document.getElementById('explorer-prompt');
    var text = ta ? ta.value.trim() : '';
    if (!text) return;
    explorerStart(text);
  };
  window._explorerChip = function (btn) {
    var p = btn && btn.dataset ? btn.dataset.prompt : '';
    if (p) explorerStart(p);
  };

  // ── Journey navigation ───────────────────────────────────────────────────

  function explorerStart(prompt, title) {
    EX.journey = [{ title: title || shortLabel(prompt), prompt: prompt }];
    EX.idx = 0;
    loadNode(0);
  }

  // Called from gen-ui Buttons via action "explore_into".
  window.faunaExploreInto = function (params) {
    params = params || {};
    var prompt = typeof params.prompt === 'string' ? params.prompt : '';
    if (!prompt) return;
    // Branching: drop any forward history past the current node.
    EX.journey = EX.journey.slice(0, EX.idx + 1);
    EX.journey.push({ title: params.title || shortLabel(prompt), prompt: prompt });
    EX.idx = EX.journey.length - 1;
    loadNode(EX.idx);
  };

  window._explorerGoTo = function (i) {
    if (i < 0 || i >= EX.journey.length) return;
    loadNode(i);
  };
  window._explorerHome = function () { renderFrontDoor(); };
  window._explorerRetry = function () {
    var n = EX.journey[EX.idx];
    if (n) { n.spec = null; loadNode(EX.idx); }
    else renderFrontDoor();
  };

  function loadNode(i) {
    EX.idx = i;
    var node = EX.journey[i];
    if (!node) return renderFrontDoor();
    renderBreadcrumb();
    var content = document.getElementById('explorer-content');
    if (!content) return;
    // Cached spec → instant render (back/forward navigation).
    if (node.spec) { renderSpecInto(content, node.spec); return; }
    content.innerHTML = skeletonHtml();
    var myReq = ++EX.reqId;
    var path = EX.journey.slice(0, i).map(function (n) { return n.title; });
    fetch('/api/genui-explore', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        prompt: node.prompt,
        path: path,
        context: tieContext(),
        model: (typeof state !== 'undefined' && state.model) ? state.model : undefined,
      }),
    })
      .then(function (r) { return r.json(); })
      .then(function (d) {
        if (myReq !== EX.reqId) return; // superseded by a newer navigation
        if (!d || !d.ok || !d.spec) { renderError(content, (d && d.error) || 'Could not generate this view.'); return; }
        node.spec = d.spec;
        if (d.title) node.title = d.title;
        renderBreadcrumb();
        renderSpecInto(content, d.spec);
      })
      .catch(function (e) {
        if (myReq !== EX.reqId) return;
        renderError(content, (e && e.message) || 'Network error');
      });
  }

  function renderSpecInto(container, spec) {
    container.innerHTML = '';
    var wrap = document.createElement('div');
    wrap.className = 'gui-root explorer-gui';
    try {
      if (typeof renderGenUI === 'function') renderGenUI(spec, wrap);
      else { renderError(container, 'GenUI renderer unavailable'); return; }
    } catch (e) {
      renderError(container, (e && e.message) || 'Render error');
      return;
    }
    container.appendChild(wrap);
    container.scrollTop = 0;
  }

  // ── Breadcrumb ───────────────────────────────────────────────────────────

  function renderBreadcrumb() {
    var bc = document.getElementById('explorer-breadcrumb');
    if (!bc) return;
    var homeActive = EX.idx < 0;
    var html = '<button class="explorer-crumb explorer-crumb-home' + (homeActive ? ' active' : '') +
      '" onclick="_explorerHome()"><i class="ti ti-compass"></i> Explore</button>';
    EX.journey.forEach(function (n, idx) {
      html += '<i class="ti ti-chevron-right explorer-crumb-sep"></i>';
      var active = idx === EX.idx;
      html += '<button class="explorer-crumb' + (active ? ' active' : '') +
        '" onclick="_explorerGoTo(' + idx + ')">' + escHtml(n.title || ('Step ' + (idx + 1))) + '</button>';
    });
    bc.innerHTML = html;
  }

  // ── Floating chat (escape hatch) ─────────────────────────────────────────

  window.toggleExplorerChat = function (force) {
    var panel = document.getElementById('explorer-chat-panel');
    if (!panel) return;
    var open = (force !== undefined) ? !!force : panel.hasAttribute('hidden');
    if (open) {
      panel.removeAttribute('hidden');
      var ta = document.getElementById('explorer-chat-input');
      if (ta) setTimeout(function () { try { ta.focus(); } catch (_) {} }, 0);
    } else {
      panel.setAttribute('hidden', '');
    }
  };

  window.explorerChatSend = function () {
    var ta = document.getElementById('explorer-chat-input');
    if (!ta) return;
    var text = ta.value.trim();
    if (!text) return;
    ta.value = '';
    window.toggleExplorerChat(false);
    closeExplorerPage();
    var input = document.getElementById('msg-input');
    if (input) {
      input.value = text;
      try { input.dispatchEvent(new Event('input', { bubbles: true })); } catch (_) {}
    }
    if (typeof sendMessage === 'function') {
      setTimeout(function () { try { sendMessage(); } catch (_) {} }, 0);
    }
  };

  // ── Conversation / project tie-in ────────────────────────────────────────

  function activeProject() {
    if (typeof state === 'undefined' || !Array.isArray(state.projects)) return null;
    var conv = (state.currentId && typeof getConv === 'function') ? getConv(state.currentId) : null;
    var pid = (conv && conv.projectId) || state.activeProjectId;
    if (!pid) return null;
    return state.projects.find(function (p) { return p.id === pid; }) || null;
  }

  function tieContext() {
    var bits = [];
    var conv = (typeof state !== 'undefined' && state.currentId && typeof getConv === 'function') ? getConv(state.currentId) : null;
    if (conv && conv.title) bits.push('Current conversation: ' + conv.title);
    var proj = activeProject();
    if (proj && proj.name) bits.push('Active project: ' + proj.name);
    return bits.join('\n');
  }

  function tieHtml() {
    var conv = (typeof state !== 'undefined' && state.currentId && typeof getConv === 'function') ? getConv(state.currentId) : null;
    var proj = activeProject();
    var label = '';
    if (proj && proj.name) label = 'Tied to project · ' + escHtml(proj.name);
    else if (conv && conv.title) label = 'Tied to · ' + escHtml(conv.title);
    else label = 'Standalone session';
    return '<div class="explorer-tie"><i class="ti ti-link"></i> ' + label + '</div>';
  }

  // ── Skeleton + error ─────────────────────────────────────────────────────

  function skeletonHtml() {
    return '' +
      '<div class="explorer-skeleton" aria-busy="true">' +
        '<div class="explorer-skel-line explorer-skel-title"></div>' +
        '<div class="explorer-skel-line explorer-skel-sub"></div>' +
        '<div class="explorer-skel-grid">' +
          '<div class="explorer-skel-card"></div>' +
          '<div class="explorer-skel-card"></div>' +
          '<div class="explorer-skel-card"></div>' +
        '</div>' +
        '<div class="explorer-skel-line"></div>' +
        '<div class="explorer-skel-line explorer-skel-short"></div>' +
        '<div class="explorer-skel-chips">' +
          '<div class="explorer-skel-pill"></div>' +
          '<div class="explorer-skel-pill"></div>' +
          '<div class="explorer-skel-pill"></div>' +
        '</div>' +
      '</div>';
  }

  function renderError(container, message) {
    container.innerHTML =
      '<div class="explorer-error">' +
        '<i class="ti ti-alert-triangle"></i>' +
        '<strong>Couldn\'t build that view</strong>' +
        '<span>' + escHtml(message || '') + '</span>' +
        '<div class="explorer-error-actions">' +
          '<button class="explorer-hero-go explorer-error-retry" onclick="_explorerRetry()"><i class="ti ti-refresh"></i> Retry</button>' +
          '<button class="explorer-chip" onclick="toggleExplorerChat(true)">Ask in chat instead</button>' +
        '</div>' +
      '</div>';
  }

  // ── Utils ────────────────────────────────────────────────────────────────

  function shortLabel(text) {
    var t = String(text || '').replace(/\s+/g, ' ').trim();
    if (t.length <= 28) return t;
    return t.slice(0, 26).trim() + '…';
  }
})();
