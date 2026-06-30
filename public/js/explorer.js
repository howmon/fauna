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
  // Tree state. nodes = [{ id, parentId, title, prompt, spec }], currentId =
  // the node currently shown (null = front door). Branching is preserved:
  // exploring from a node adds a child without dropping its siblings.
  var EX = { nodes: [], currentId: null, reqId: 0, web: false, model: '', agentName: '', sessionId: '', convId: '', open: false };
  window._faunaExplorer = EX;

  var EX_SESSIONS_KEY = 'fauna-explore-sessions';

  // ── Tree helpers ─────────────────────────────────────────────────────────
  function exNewId() { return 'n-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 6); }
  function exNode(id) { for (var i = 0; i < EX.nodes.length; i++) { if (EX.nodes[i].id === id) return EX.nodes[i]; } return null; }
  function exChildren(id) { return EX.nodes.filter(function (n) { return n.parentId === id; }); }
  function exSiblings(node) { return node ? exChildren(node.parentId) : []; }
  function exPathTo(id) {
    var path = [], guard = 0, n = exNode(id);
    while (n && guard++ < 200) { path.unshift(n); n = n.parentId ? exNode(n.parentId) : null; }
    return path;
  }

  // ── Page open / close ────────────────────────────────────────────────────

  function openExplorerPage() {
    var body = (typeof _openAppPage === 'function') ? _openAppPage('explorer', 'Explore') : null;
    if (!body) return;
    EX.open = true;
    renderExplorerShell(body);
    if (EX.nodes.length && EX.currentId) loadNode(EX.currentId);
    else renderFrontDoor();
  }
  window.openExplorerPage = openExplorerPage;

  function closeExplorerPage() {
    EX.open = false;
    if (typeof closeAppPage === 'function') closeAppPage();
  }
  window.closeExplorerPage = closeExplorerPage;

  // ── Shell ──────────────────────────────────────────────────────────────

  // ── Front door (conversational start) ────────────────────────────────────

  var SUGGESTIONS = [
    'Compare the top 5 electric SUVs',
    'Break down how a transformer model works',
    'Plan a 3-day trip to Lisbon',
    'Show the state of my project at a glance',
  ];

  function renderFrontDoor() {
    EX.currentId = null;
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
    EX.sessionId = '';
    var id = exNewId();
    EX.nodes = [{ id: id, parentId: null, title: title || shortLabel(prompt), prompt: prompt }];
    EX.currentId = id;
    loadNode(id);
  }

  // Called from gen-ui Buttons via action "explore_into". Adds a CHILD of the
  // current node, preserving any existing branches (siblings).
  window.faunaExploreInto = function (params) {
    params = params || {};
    var prompt = typeof params.prompt === 'string' ? params.prompt : '';
    if (!prompt) return;
    if (!EX.currentId || !EX.nodes.length) { explorerStart(prompt, params.title); return; }
    var id = exNewId();
    EX.nodes.push({ id: id, parentId: EX.currentId, title: params.title || shortLabel(prompt), prompt: prompt });
    EX.currentId = id;
    loadNode(id);
  };

  window._explorerGoTo = function (id) {
    if (!exNode(id)) return;
    loadNode(id);
  };
  window._explorerHome = function () { renderFrontDoor(); };
  window._explorerRetry = function () {
    var n = exNode(EX.currentId);
    if (n) { n.spec = null; loadNode(n.id); }
    else renderFrontDoor();
  };

  function loadNode(id) {
    EX.currentId = id;
    var node = exNode(id);
    if (!node) return renderFrontDoor();
    renderBreadcrumb();
    var content = document.getElementById('explorer-content');
    if (!content) return;
    // Cached spec → instant render (back/forward navigation).
    if (node.spec) { renderSpecInto(content, node.spec); return; }
    content.innerHTML = skeletonHtml();
    var myReq = ++EX.reqId;
    var path = exPathTo(id).slice(0, -1).map(function (n) { return n.title; });
    var agent = EX.agentName ? findExploreAgent(EX.agentName) : null;
    fetch('/api/genui-explore', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        prompt: node.prompt,
        path: path,
        context: tieContext(),
        model: currentModelId() || undefined,
        web: !!EX.web,
        agentName: agent ? agent.name : undefined,
        agentPrompt: agent ? agent.systemPrompt : undefined,
      }),
    })
      .then(function (r) { return r.json(); })
      .then(function (d) {
        if (myReq !== EX.reqId) return; // superseded by a newer navigation
        if (!d || !d.ok || !d.spec) {
          var msg = (d && d.error) || 'Could not generate this view.';
          if (d && d.detail) msg += ' (' + String(d.detail).slice(0, 160) + ')';
          renderError(content, msg);
          return;
        }
        node.spec = d.spec;
        if (d.title) node.title = d.title;
        renderBreadcrumb();
        renderSpecInto(content, d.spec);
        exPersistCurrent();
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
    var homeActive = !EX.currentId;
    var crumbHtml = function (node, active) {
      var sibs = exSiblings(node);
      var fork = (sibs.length > 1) ? '<i class="ti ti-git-branch explorer-crumb-fork" title="' + sibs.length + ' branches"></i>' : '';
      return '<button class="explorer-crumb' + (active ? ' active' : '') + '" title="' + escHtml(node.title || '') +
        '" onclick="_explorerGoTo(\'' + node.id + '\')">' + fork + '<span class="explorer-crumb-label">' +
        escHtml(node.title || 'Step') + '</span></button>';
    };
    var sep = '<i class="ti ti-chevron-right explorer-crumb-sep"></i>';

    var html = '<button class="explorer-crumb explorer-crumb-home' + (homeActive ? ' active' : '') +
      '" onclick="_explorerHome()"><i class="ti ti-compass"></i><span class="explorer-crumb-label">Explore</span></button>';

    var path = EX.currentId ? exPathTo(EX.currentId) : [];
    // Collapse the middle when the path is long: home › first › … › last two.
    if (path.length > 4) {
      html += sep + crumbHtml(path[0], false);
      html += sep + '<button class="explorer-crumb explorer-crumb-ellipsis" title="Show full path / branch map" onclick="toggleExplorerMap(true)">…</button>';
      var tail = path.slice(-2);
      tail.forEach(function (n) { html += sep + crumbHtml(n, n.id === EX.currentId); });
    } else {
      path.forEach(function (n) { html += sep + crumbHtml(n, n.id === EX.currentId); });
    }
    bc.innerHTML = html;

    // Show the branch-map button whenever there is more than one node or any
    // branching has occurred.
    var mapBtn = document.getElementById('explorer-map-btn');
    if (mapBtn) {
      var branched = EX.nodes.length > 1;
      mapBtn.hidden = !branched;
      var forks = EX.nodes.filter(function (n) { return exChildren(n.parentId).length > 1; }).length;
      mapBtn.querySelector('.explorer-map-count').textContent = EX.nodes.length;
      mapBtn.classList.toggle('has-branches', forks > 0);
    }
  }

  // ── Branch map (full exploration tree) ───────────────────────────────────

  window.toggleExplorerMap = function (force) {
    var panel = document.getElementById('explorer-map-panel');
    var back = document.getElementById('explorer-map-backdrop');
    if (!panel) return;
    var open = (force !== undefined) ? !!force : panel.hasAttribute('hidden');
    if (open) {
      renderMapTree();
      panel.removeAttribute('hidden');
      if (back) back.removeAttribute('hidden');
    } else {
      panel.setAttribute('hidden', '');
      if (back) back.setAttribute('hidden', '');
    }
  };

  function renderMapTree() {
    var host = document.getElementById('explorer-map-tree');
    if (!host) return;
    var roots = EX.nodes.filter(function (n) { return !n.parentId; });
    if (!roots.length) {
      host.innerHTML = '<div class="explorer-sessions-empty">Nothing explored yet.</div>';
      return;
    }
    var out = [];
    var walk = function (node, depth) {
      var kids = exChildren(node.id);
      var active = node.id === EX.currentId ? ' active' : '';
      out.push('<div class="explorer-map-node' + active + '" style="padding-left:' + (depth * 18 + 8) + 'px" ' +
        'onclick="_explorerMapGo(\'' + node.id + '\')">' +
        (depth ? '<i class="ti ti-corner-down-right explorer-map-twig"></i>' : '<i class="ti ti-point explorer-map-twig"></i>') +
        '<span class="explorer-map-label">' + escHtml(node.title || 'Step') + '</span>' +
        (kids.length > 1 ? '<span class="explorer-map-badge">' + kids.length + '</span>' : '') +
        '</div>');
      kids.forEach(function (k) { walk(k, depth + 1); });
    };
    roots.forEach(function (r) { walk(r, 0); });
    host.innerHTML = out.join('');
  }

  window._explorerMapGo = function (id) {
    if (!exNode(id)) return;
    window.toggleExplorerMap(false);
    loadNode(id);
  };

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
    // Act WITHIN Explore: generate the next view instead of handing off to the
    // main chat. From the front door (no current node) start a new journey;
    // otherwise branch a new node off the current one.
    if (!EX.currentId || !EX.nodes.length) explorerStart(text);
    else window.faunaExploreInto({ prompt: text });
  };

  // Explicit escape hatch — hand the message to the full chat assistant, but
  // inside Explore's OWN conversation (created on demand, outside any project).
  window.explorerChatToChat = function () {
    var ta = document.getElementById('explorer-chat-input');
    if (!ta) return;
    var text = ta.value.trim();
    if (!text) return;
    ta.value = '';
    window._explorerHandoff(text, { send: true });
  };

  // Ensure Explore has its own conversation (project-less) tied to this session,
  // reusing it across hand-offs. Returns the conversation id (or null).
  function exEnsureConversation() {
    if (EX.convId && typeof getConv === 'function' && getConv(EX.convId)) {
      if (typeof loadConversation === 'function') loadConversation(EX.convId);
      return EX.convId;
    }
    if (typeof newConversation !== 'function') return null;
    newConversation({ quick: true }); // quick:true → never filed under a project
    var id = (typeof state !== 'undefined') ? state.currentId : null;
    EX.convId = id;
    var conv = (typeof getConv === 'function') ? getConv(id) : null;
    if (conv) {
      var root = EX.nodes.find(function (n) { return !n.parentId; });
      conv.title = 'Explore · ' + ((root && root.title) || 'session');
      conv._exploreSession = EX.sessionId || '';
      if (typeof saveConversations === 'function') saveConversations();
      if (typeof renderConvList === 'function') renderConvList();
    }
    exPersistCurrent();
    return id;
  }

  // Close Explore, ensure its conversation, drop the text in and (optionally) send.
  window._explorerHandoff = function (text, opts) {
    opts = opts || {};
    if (!text) return;
    window.toggleExplorerChat(false);
    closeExplorerPage();
    exEnsureConversation();
    var input = document.getElementById('msg-input');
    if (input) {
      input.value = text;
      try { input.dispatchEvent(new Event('input', { bubbles: true })); } catch (_) {}
      try { input.focus(); } catch (_) {}
    }
    if (opts.send && typeof sendMessage === 'function') {
      setTimeout(function () { try { sendMessage(); } catch (_) {} }, 0);
    }
  };

  // ── Explore sessions (own store, behind the hamburger) ───────────────────

  function exLoadSessions() {
    try {
      var raw = localStorage.getItem(EX_SESSIONS_KEY);
      var arr = raw ? JSON.parse(raw) : [];
      return Array.isArray(arr) ? arr : [];
    } catch (_) { return []; }
  }
  function exSaveSessions(list) {
    try { localStorage.setItem(EX_SESSIONS_KEY, JSON.stringify(list)); } catch (_) {}
  }

  // Upsert the current exploration tree into the session store.
  function exPersistCurrent() {
    if (!EX.nodes.length) return;
    if (!EX.sessionId) EX.sessionId = 'ex-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 6);
    var list = exLoadSessions();
    var root = EX.nodes.find(function (n) { return !n.parentId; });
    var title = (root && root.title) || 'Exploration';
    var rec = {
      id: EX.sessionId,
      title: title,
      nodes: EX.nodes,
      currentId: EX.currentId,
      web: EX.web,
      model: EX.model,
      agentName: EX.agentName,
      convId: EX.convId,
      updatedAt: Date.now(),
    };
    var found = false;
    for (var i = 0; i < list.length; i++) {
      if (list[i].id === EX.sessionId) { rec.createdAt = list[i].createdAt || Date.now(); list[i] = rec; found = true; break; }
    }
    if (!found) { rec.createdAt = Date.now(); list.unshift(rec); }
    // Keep newest first, cap to 40 sessions.
    list.sort(function (a, b) { return (b.updatedAt || 0) - (a.updatedAt || 0); });
    if (list.length > 40) list = list.slice(0, 40);
    exSaveSessions(list);
    renderSessionsList();
  }

  function renderSessionsList() {
    var host = document.getElementById('explorer-sessions-list');
    if (!host) return;
    var list = exLoadSessions();
    if (!list.length) {
      host.innerHTML = '<div class="explorer-sessions-empty">No saved explorations yet. Your journeys are saved here automatically.</div>';
      return;
    }
    host.innerHTML = list.map(function (s) {
      var active = (s.id === EX.sessionId) ? ' active' : '';
      var nodes = Array.isArray(s.nodes) ? s.nodes : (Array.isArray(s.journey) ? s.journey : []);
      var steps = nodes.length;
      var forks = nodes.filter(function (n) {
        return nodes.filter(function (m) { return m.parentId === n.parentId; }).length > 1 && n.parentId;
      }).length;
      var branchTag = forks > 0 ? ' · <i class="ti ti-git-branch"></i> branched' : '';
      return '<div class="explorer-session' + active + '" onclick="_exOpenSession(\'' + s.id + '\')">' +
          '<div class="explorer-session-main">' +
            '<div class="explorer-session-title">' + escHtml(s.title || 'Exploration') + '</div>' +
            '<div class="explorer-session-meta">' + steps + ' step' + (steps === 1 ? '' : 's') + branchTag + ' · ' + exTimeAgo(s.updatedAt) + '</div>' +
          '</div>' +
          '<button class="explorer-session-del" onclick="event.stopPropagation();_exDeleteSession(\'' + s.id + '\')" title="Delete" aria-label="Delete"><i class="ti ti-trash"></i></button>' +
        '</div>';
    }).join('');
  }

  function exTimeAgo(ts) {
    if (!ts) return '';
    var s = Math.floor((Date.now() - ts) / 1000);
    if (s < 60) return 'just now';
    var m = Math.floor(s / 60); if (m < 60) return m + 'm ago';
    var h = Math.floor(m / 60); if (h < 24) return h + 'h ago';
    var d = Math.floor(h / 24); if (d < 7) return d + 'd ago';
    try { return new Date(ts).toLocaleDateString(); } catch (_) { return ''; }
  }

  window.toggleExplorerSessions = function (force) {
    var panel = document.getElementById('explorer-sessions-panel');
    var back = document.getElementById('explorer-sessions-backdrop');
    if (!panel) return;
    var open = (force !== undefined) ? !!force : panel.hasAttribute('hidden');
    if (open) {
      renderSessionsList();
      panel.removeAttribute('hidden');
      if (back) back.removeAttribute('hidden');
    } else {
      panel.setAttribute('hidden', '');
      if (back) back.setAttribute('hidden', '');
    }
  };

  window._exNewSession = function () {
    EX.sessionId = '';
    EX.nodes = [];
    EX.currentId = null;
    EX.convId = '';
    window.toggleExplorerSessions(false);
    renderFrontDoor();
  };

  // Convert an old linear { journey, idx } session into the tree model.
  function exMigrateSession(s) {
    var journey = Array.isArray(s.journey) ? s.journey : [];
    var nodes = [];
    var prevId = null;
    journey.forEach(function (j, i) {
      var id = 'n-mig-' + i + '-' + Math.random().toString(36).slice(2, 6);
      nodes.push({ id: id, parentId: prevId, title: j.title, prompt: j.prompt, spec: j.spec });
      prevId = id;
    });
    var idx = (typeof s.idx === 'number') ? s.idx : (nodes.length - 1);
    var currentId = (nodes[idx] && nodes[idx].id) || (nodes.length ? nodes[nodes.length - 1].id : null);
    return { nodes: nodes, currentId: currentId };
  }

  window._exOpenSession = function (id) {
    var list = exLoadSessions();
    var s = null;
    for (var i = 0; i < list.length; i++) { if (list[i].id === id) { s = list[i]; break; } }
    if (!s) return;
    EX.sessionId = s.id;
    if (Array.isArray(s.nodes)) {
      EX.nodes = s.nodes;
      EX.currentId = s.currentId || (s.nodes.length ? s.nodes[s.nodes.length - 1].id : null);
    } else {
      var mig = exMigrateSession(s);
      EX.nodes = mig.nodes;
      EX.currentId = mig.currentId;
    }
    if (typeof s.web === 'boolean') EX.web = s.web;
    if (typeof s.model === 'string') EX.model = s.model;
    if (typeof s.agentName === 'string') EX.agentName = s.agentName;
    EX.convId = (typeof s.convId === 'string') ? s.convId : '';
    window.toggleExplorerSessions(false);
    renderExplorerControls();
    if (EX.nodes.length && EX.currentId) loadNode(EX.currentId);
    else renderFrontDoor();
  };

  window._exDeleteSession = function (id) {
    var list = exLoadSessions().filter(function (s) { return s.id !== id; });
    exSaveSessions(list);
    if (EX.sessionId === id) { EX.sessionId = ''; }
    renderSessionsList();
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

  function renderExplorerShell(body) {
    body.innerHTML =
      '<div class="explorer-shell">' +
        '<div class="explorer-topbar">' +
          '<button class="explorer-menu-btn" onclick="toggleExplorerSessions()" title="Sessions" aria-label="Sessions"><i class="ti ti-menu-2"></i></button>' +
          '<div id="explorer-breadcrumb" class="explorer-breadcrumb"></div>' +
          '<button class="explorer-map-btn" id="explorer-map-btn" hidden onclick="toggleExplorerMap()" title="Branch map">' +
            '<i class="ti ti-sitemap"></i><span class="explorer-map-count">0</span>' +
          '</button>' +
          '<div id="explorer-controls" class="explorer-controls"></div>' +
        '</div>' +
        '<div id="explorer-content" class="explorer-content"></div>' +
      '</div>' +
      '<div class="explorer-sessions-backdrop" id="explorer-sessions-backdrop" hidden onclick="toggleExplorerSessions(false)"></div>' +
      '<aside class="explorer-sessions" id="explorer-sessions-panel" hidden>' +
        '<div class="explorer-sessions-head">' +
          '<span><i class="ti ti-compass"></i> Explore sessions</span>' +
          '<button class="explorer-chat-x" onclick="toggleExplorerSessions(false)" aria-label="Close"><i class="ti ti-x"></i></button>' +
        '</div>' +
        '<button class="explorer-sessions-new" onclick="_exNewSession()"><i class="ti ti-plus"></i> New exploration</button>' +
        '<div class="explorer-sessions-list" id="explorer-sessions-list"></div>' +
      '</aside>' +
      '<div class="explorer-sessions-backdrop" id="explorer-map-backdrop" hidden onclick="toggleExplorerMap(false)"></div>' +
      '<aside class="explorer-map-panel" id="explorer-map-panel" hidden>' +
        '<div class="explorer-sessions-head">' +
          '<span><i class="ti ti-sitemap"></i> Branch map</span>' +
          '<button class="explorer-chat-x" onclick="toggleExplorerMap(false)" aria-label="Close"><i class="ti ti-x"></i></button>' +
        '</div>' +
        '<p class="explorer-map-hint">Every view you opened. Click any node to jump back to it — branches are kept.</p>' +
        '<div class="explorer-map-tree" id="explorer-map-tree"></div>' +
      '</aside>' +
      '<button class="explorer-fab" onclick="toggleExplorerChat()" title="Continue exploring" aria-label="Continue exploring"><i class="ti ti-message-2"></i></button>' +
      '<div class="explorer-chat-panel" id="explorer-chat-panel" hidden>' +
        '<div class="explorer-chat-head"><i class="ti ti-message-2"></i><span>Continue exploring</span>' +
          '<button class="explorer-chat-x" onclick="toggleExplorerChat(false)" aria-label="Close"><i class="ti ti-x"></i></button>' +
        '</div>' +
        '<p class="explorer-chat-hint" id="explorer-chat-hint">Ask anything to generate the next view right here. Use “Open in chat” only when you need the full assistant.</p>' +
        '<textarea id="explorer-chat-input" class="explorer-chat-input" rows="3" placeholder="What do you want to see next?"></textarea>' +
        '<div class="explorer-chat-actions">' +
          '<button class="explorer-chat-send" onclick="explorerChatSend()">Explore <i class="ti ti-arrow-right"></i></button>' +
          '<button class="explorer-chat-tochat" onclick="explorerChatToChat()" title="Hand off to the full chat assistant">Open in chat</button>' +
        '</div>' +
      '</div>';
    renderExplorerControls();
    renderSessionsList();
  }

  // ── Controls: agent picker + live-web toggle ─────────────────────────────

  function renderExplorerControls() {
    var host = document.getElementById('explorer-controls');
    if (!host) return;
    var agents = (typeof getAllAgents === 'function') ? getAllAgents() : [];
    // Explore keeps its OWN agent selection (EX.agentName), independent of the
    // global chat agent. Default is no agent.
    var activeName = EX.agentName || '';
    var opts = '<option value="">No agent</option>' + agents.map(function (a) {
      var sel = (a.name === activeName) ? ' selected' : '';
      return '<option value="' + escHtml(a.name) + '"' + sel + '>' + escHtml(a.displayName || a.name) + '</option>';
    }).join('');
    var modelId = currentModelId();
    var modelOpts = buildModelOptions(modelId);
    host.innerHTML =
      '<label class="explorer-web-toggle' + (EX.web ? ' on' : '') + '" title="Ground views in live web search (Playwright)">' +
        '<input type="checkbox" ' + (EX.web ? 'checked' : '') + ' onchange="_explorerToggleWeb(this.checked)">' +
        '<i class="ti ti-world-search"></i><span>Live web</span>' +
      '</label>' +
      '<div class="explorer-agent-pick" title="Preferred AI model">' +
        '<i class="ti ti-cpu"></i>' +
        '<select class="explorer-agent-select" onchange="_explorerSetModel(this.value)">' + modelOpts + '</select>' +
      '</div>' +
      '<div class="explorer-agent-pick">' +
        '<i class="ti ti-robot"></i>' +
        '<select class="explorer-agent-select" onchange="_explorerSetAgent(this.value)">' + opts + '</select>' +
      '</div>';
    // Lazy-load the agent list the first time if it's empty.
    if (!agents.length && typeof loadInstalledAgents === 'function' && !EX._agentsRequested) {
      EX._agentsRequested = true;
      Promise.resolve(loadInstalledAgents()).then(function () { renderExplorerControls(); }).catch(function () {});
    }
    var hint = document.getElementById('explorer-chat-hint');
    if (hint) {
      var picked = EX.agentName ? findExploreAgent(EX.agentName) : null;
      hint.textContent = picked
        ? 'Sends to the full chat using the ' + (picked.displayName || picked.name) + ' agent.'
        : 'CTA not cutting it? Describe what you actually need and Fauna will pick it up in the full chat.';
    }
  }

  function findExploreAgent(name) {
    var agents = (typeof getAllAgents === 'function') ? getAllAgents() : [];
    for (var i = 0; i < agents.length; i++) { if (agents[i].name === name) return agents[i]; }
    return null;
  }

  // Resolve the model the Explore page should use (its own override or the
  // global chat model).
  function currentModelId() {
    if (EX.model) return EX.model;
    return (typeof state !== 'undefined' && state.model) ? state.model : '';
  }

  // Build <optgroup>-grouped <option>s from the global allModels list.
  function buildModelOptions(selectedId) {
    var models = (typeof allModels !== 'undefined' && Array.isArray(allModels)) ? allModels : [];
    if (!models.length) {
      return '<option value="' + escHtml(selectedId || '') + '" selected>' + escHtml(selectedId || 'Default model') + '</option>';
    }
    var order = ['Anthropic', 'OpenAI', 'Google', 'xAI', 'Minimax', 'Custom'];
    var byVendor = {};
    models.forEach(function (m) {
      var v = m.vendor || 'Other';
      (byVendor[v] = byVendor[v] || []).push(m);
    });
    var vendors = Object.keys(byVendor).sort(function (a, b) {
      var ai = order.indexOf(a), bi = order.indexOf(b);
      if (ai === -1 && bi === -1) return a.localeCompare(b);
      if (ai === -1) return 1;
      if (bi === -1) return -1;
      return ai - bi;
    });
    return vendors.map(function (v) {
      var inner = byVendor[v].map(function (m) {
        var sel = (m.id === selectedId) ? ' selected' : '';
        return '<option value="' + escHtml(m.id) + '"' + sel + '>' + escHtml(m.name) + '</option>';
      }).join('');
      return '<optgroup label="' + escHtml(v) + '">' + inner + '</optgroup>';
    }).join('');
  }

  window._explorerSetModel = function (id) {
    EX.model = id || '';
    renderExplorerControls();
  };

  window._explorerToggleWeb = function (on) {
    EX.web = !!on;
    renderExplorerControls();
  };

  window._explorerSetAgent = function (name) {
    EX.agentName = name || '';
    renderExplorerControls();
  };

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
