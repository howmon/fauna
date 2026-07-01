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
  var EX = { nodes: [], currentId: null, reqId: 0, web: true, model: '', agentName: '', sessionId: '', convId: '', open: false };
  window._faunaExplorer = EX;

  var EX_SESSIONS_KEY = 'fauna-explore-sessions';

  // Collapsed branch-map nodes (ephemeral, keyed by node id).
  var exMapCollapsed = {};

  // ── Tree helpers ─────────────────────────────────────────────────────────
  function exNewId() { return 'n-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 6); }
  function exNode(id) { for (var i = 0; i < EX.nodes.length; i++) { if (EX.nodes[i].id === id) return EX.nodes[i]; } return null; }
  function exChildren(id) { return EX.nodes.filter(function (n) { return n.parentId === id; }); }
  function exDescendantCount(id) { var c = 0; exChildren(id).forEach(function (k) { c += 1 + exDescendantCount(k.id); }); return c; }
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
    'Take me on a tour of the solar system',
    'Explore how to make the perfect ramen',
    "Explain today's top news stories",
    'Build a skill tree for learning jazz piano',
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
          '<textarea id="explorer-prompt" class="explorer-hero-input" rows="1" placeholder="e.g. Take me on a tour of the solar system"></textarea>' +
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

  // ── Partial-spec parsing (streaming) ───────────────────────────────────
  // While the gen-ui JSON streams in token-by-token, we repeatedly try to
  // parse the incomplete text into a renderable spec so the view can grow
  // progressively instead of blocking on the full completion. The tail is
  // usually a truncated string / object; we close open structures and trim
  // the last few chars until it parses.

  function _exIsRenderableSpec(spec) {
    return !!(spec && spec.root && spec.elements && spec.elements[spec.root]);
  }

  function _exCloseOpenStructures(s) {
    var stack = [];
    var inStr = false, esc = false;
    for (var i = 0; i < s.length; i++) {
      var ch = s.charAt(i);
      if (inStr) {
        if (esc) { esc = false; }
        else if (ch === '\\') { esc = true; }
        else if (ch === '"') { inStr = false; }
        continue;
      }
      if (ch === '"') { inStr = true; }
      else if (ch === '{' || ch === '[') { stack.push(ch); }
      else if (ch === '}' || ch === ']') { stack.pop(); }
    }
    var out = s;
    if (inStr) out += '"';
    out = out.replace(/[\s,]+$/, '');
    if (/:$/.test(out)) out += 'null';
    for (var j = stack.length - 1; j >= 0; j--) {
      out += (stack[j] === '{') ? '}' : ']';
    }
    return out;
  }

  function _exCompleteTruncatedJson(body) {
    var MAX_TRIM = 40;
    for (var trim = 0; trim <= MAX_TRIM && trim < body.length; trim++) {
      var candidate = trim ? body.slice(0, body.length - trim) : body;
      try { return JSON.parse(_exCloseOpenStructures(candidate)); } catch (e) {}
    }
    return null;
  }

  function _exBestPartialSpec(raw) {
    if (!raw) return null;
    var start = raw.indexOf('{');
    if (start < 0) return null;
    var body = raw.slice(start);
    // Common case: the tail is only a little truncated.
    var obj = _exCompleteTruncatedJson(body);
    if (_exIsRenderableSpec(obj)) return obj;
    // Otherwise step back through the tail to the last renderable prefix.
    var WINDOW = 6000, STEP = 24;
    var floor = Math.max(0, body.length - WINDOW);
    for (var end = body.length - STEP; end > floor; end -= STEP) {
      try {
        var o = JSON.parse(_exCloseOpenStructures(body.slice(0, end)));
        if (_exIsRenderableSpec(o)) return o;
      } catch (e) {}
    }
    return null;
  }

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

    var acc = '';           // accumulated raw model text
    var lastRenderAt = 0;   // throttle progressive repaints
    var painted = false;    // have we drawn at least one partial/final spec?
    var RENDER_MS = 140;

    var paintPartial = function (force) {
      if (myReq !== EX.reqId) return;
      var now = Date.now();
      if (!force && (now - lastRenderAt) < RENDER_MS) return;
      var partial = _exBestPartialSpec(acc);
      if (partial) {
        lastRenderAt = now;
        renderSpecInto(content, partial);
        painted = true;
      }
    };

    var applyFinal = function (spec, title) {
      if (myReq !== EX.reqId) return;
      node.spec = spec;
      if (title) node.title = title;
      renderBreadcrumb();
      renderSpecInto(content, spec);
      painted = true;
      exPersistCurrent();
    };

    var fail = function (msg) {
      if (myReq !== EX.reqId) return;
      if (!painted) renderError(content, msg || 'Could not generate this view.');
    };

    fetch('/api/genui-explore', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        prompt: node.prompt,
        path: path,
        context: tieContext(),
        projects: exProjectsForGrounding(),
        model: currentModelId() || undefined,
        web: !!EX.web,
        agentName: agent ? agent.name : undefined,
        agentPrompt: agent ? agent.systemPrompt : undefined,
        stream: true,
      }),
    })
      .then(function (resp) {
        // Fallback to plain JSON if streaming isn't available.
        if (!resp.ok || !resp.body || typeof resp.body.getReader !== 'function') {
          return resp.json().then(function (d) {
            if (myReq !== EX.reqId) return;
            if (!d || !d.ok || !d.spec) {
              var msg = (d && d.error) || 'Could not generate this view.';
              if (d && d.detail) msg += ' (' + String(d.detail).slice(0, 160) + ')';
              fail(msg);
              return;
            }
            applyFinal(d.spec, d.title);
          });
        }

        var reader = resp.body.getReader();
        var decoder = new TextDecoder();
        var sseBuf = '';
        var doneApplied = false;

        var handleEvent = function (obj) {
          if (!obj || !obj.type) return;
          if (obj.type === 'delta') {
            acc += (obj.text || '');
            paintPartial(false);
          } else if (obj.type === 'done') {
            doneApplied = true;
            if (obj.spec) applyFinal(obj.spec, obj.title);
            else fail('Could not generate this view.');
          } else if (obj.type === 'error') {
            fail(obj.error || 'Could not generate this view.');
          }
        };

        var pump = function () {
          return reader.read().then(function (res) {
            if (myReq !== EX.reqId) { try { reader.cancel(); } catch (_) {} return; }
            if (res.done) {
              if (!doneApplied) { paintPartial(true); if (!painted) fail('Stream ended unexpectedly.'); }
              return;
            }
            sseBuf += decoder.decode(res.value, { stream: true });
            var idx;
            while ((idx = sseBuf.indexOf('\n\n')) >= 0) {
              var frame = sseBuf.slice(0, idx);
              sseBuf = sseBuf.slice(idx + 2);
              var line = frame.replace(/^data:\s?/, '').trim();
              if (!line) continue;
              var evt = null;
              try { evt = JSON.parse(line); } catch (_) {}
              if (evt) handleEvent(evt);
            }
            return pump();
          });
        };
        return pump();
      })
      .catch(function (e) {
        if (myReq !== EX.reqId) return;
        if (!painted) renderError(content, (e && e.message) || 'Network error');
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
    var homeBtn = '<button class="explorer-crumb explorer-crumb-home' + (homeActive ? ' active' : '') +
      '" onclick="_explorerHome()"><i class="ti ti-compass"></i><span class="explorer-crumb-label">Explore</span></button>';
    var ellipsisBtn = '<button class="explorer-crumb explorer-crumb-ellipsis" title="Show full trail" ' +
      'onclick="_explorerToggleTrail(event)"><i class="ti ti-dots"></i></button>';

    var path = EX.currentId ? exPathTo(EX.currentId) : [];

    // Build the full breadcrumb, then collapse the middle progressively until it
    // fits the available width (long single labels overflow even at depth 2).
    var buildFull = function () {
      return homeBtn + path.map(function (n) { return sep + crumbHtml(n, n.id === EX.currentId); }).join('');
    };
    // keepTail = how many trailing crumbs to show beside the ellipsis.
    var buildCollapsed = function (keepTail) {
      var tail = path.slice(-keepTail);
      var lead = homeBtn;
      // Keep the first crumb if it isn't part of the tail, so origin stays visible.
      if (path.length - keepTail >= 1) lead += sep + crumbHtml(path[0], false);
      lead += sep + ellipsisBtn;
      tail.forEach(function (n) { lead += sep + crumbHtml(n, n.id === EX.currentId); });
      return lead;
    };

    bc.innerHTML = buildFull();
    var overflowing = function () { return bc.scrollWidth > bc.clientWidth + 2; };
    if (path.length > 1 && overflowing()) {
      // Try keeping the last 2, then just the current, collapsing the rest.
      bc.innerHTML = buildCollapsed(2);
      if (overflowing()) bc.innerHTML = buildCollapsed(1);
    }

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

  // ── Inline trail popover (the ellipsis dropdown) ─────────────────────────
  // A compact tree showing the full path from Explore → current, plus any
  // branch siblings along the way, so you can jump anywhere without leaving.
  window._explorerToggleTrail = function (arg) {
    var pop = document.getElementById('explorer-trail-pop');
    var back = document.getElementById('explorer-trail-backdrop');
    if (!pop) return;
    var force = (typeof arg === 'boolean') ? arg : undefined;
    var open = (force !== undefined) ? force : pop.hasAttribute('hidden');
    if (open) {
      renderTrailList();
      pop.removeAttribute('hidden');
      if (back) back.removeAttribute('hidden');
      // Anchor under the ellipsis button (fall back to breadcrumb start).
      var anchor = document.querySelector('.explorer-crumb-ellipsis') ||
        document.getElementById('explorer-breadcrumb');
      if (anchor && arg && arg.stopPropagation) arg.stopPropagation();
      if (anchor) {
        var r = anchor.getBoundingClientRect();
        pop.style.top = (r.bottom + 6) + 'px';
        pop.style.left = Math.max(8, r.left) + 'px';
      }
    } else {
      pop.setAttribute('hidden', '');
      if (back) back.setAttribute('hidden', '');
    }
  };

  function renderTrailList() {
    var host = document.getElementById('explorer-trail-list');
    if (!host) return;
    var path = EX.currentId ? exPathTo(EX.currentId) : [];
    var out = [];
    out.push('<button class="explorer-trail-row' + (!EX.currentId ? ' active' : '') + '" ' +
      'style="padding-left:8px" onclick="_explorerTrailGo(\'\')">' +
      '<i class="ti ti-compass explorer-trail-ico"></i>' +
      '<span class="explorer-trail-label">Explore</span></button>');
    path.forEach(function (n, i) {
      var active = n.id === EX.currentId ? ' active' : '';
      out.push('<button class="explorer-trail-row' + active + '" style="padding-left:' + (i * 16 + 8) + 'px" ' +
        'onclick="_explorerTrailGo(\'' + n.id + '\')">' +
        '<i class="ti ' + (i ? 'ti-corner-down-right' : 'ti-point') + ' explorer-trail-ico"></i>' +
        '<span class="explorer-trail-label">' + escHtml(n.title || 'Step') + '</span></button>');
      // Branch siblings: alternate paths that diverge at this node.
      var sibs = exSiblings(n).filter(function (s) { return s.id !== n.id; });
      sibs.forEach(function (s) {
        out.push('<button class="explorer-trail-row explorer-trail-branch" style="padding-left:' + (i * 16 + 24) + 'px" ' +
          'onclick="_explorerTrailGo(\'' + s.id + '\')">' +
          '<i class="ti ti-git-branch explorer-trail-ico"></i>' +
          '<span class="explorer-trail-label">' + escHtml(s.title || 'Branch') + '</span></button>');
      });
    });
    host.innerHTML = out.join('');
  }

  window._explorerTrailGo = function (id) {
    window._explorerToggleTrail(false);
    if (!id) { _explorerHome(); return; }
    if (exNode(id)) loadNode(id);
  };

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
      var hasKids = kids.length > 0;
      var collapsed = !!exMapCollapsed[node.id];
      var active = node.id === EX.currentId ? ' active' : '';
      var caret = hasKids
        ? '<button class="explorer-map-caret" title="' + (collapsed ? 'Expand' : 'Collapse') + '" ' +
            'onclick="event.stopPropagation();_explorerMapToggle(\'' + node.id + '\',event)">' +
            '<i class="ti ti-chevron-' + (collapsed ? 'right' : 'down') + '"></i></button>'
        : '<span class="explorer-map-caret is-leaf"></span>';
      var showBadge = hasKids && (collapsed || kids.length > 1);
      var badgeNum = collapsed ? exDescendantCount(node.id) : kids.length;
      out.push('<div class="explorer-map-node' + active + '" style="padding-left:' + (depth * 18 + 6) + 'px" ' +
        'onclick="_explorerMapGo(\'' + node.id + '\')">' +
        caret +
        (depth ? '<i class="ti ti-corner-down-right explorer-map-twig"></i>' : '<i class="ti ti-point explorer-map-twig"></i>') +
        '<span class="explorer-map-label">' + escHtml(node.title || 'Step') + '</span>' +
        (showBadge ? '<span class="explorer-map-badge">' + badgeNum + '</span>' : '') +
        '<button class="explorer-map-rename" title="Rename" aria-label="Rename" ' +
          'onclick="event.stopPropagation();_explorerMapRename(\'' + node.id + '\',event)"><i class="ti ti-pencil"></i></button>' +
        '<button class="explorer-map-del" title="Delete this branch" aria-label="Delete branch" ' +
          'onclick="event.stopPropagation();_explorerMapDelete(\'' + node.id + '\',event)"><i class="ti ti-trash"></i></button>' +
        '</div>');
      if (!collapsed) kids.forEach(function (k) { walk(k, depth + 1); });
    };
    roots.forEach(function (r) { walk(r, 0); });
    host.innerHTML = out.join('');
  }

  // Collapse / expand a branch-map node (ephemeral).
  window._explorerMapToggle = function (id, ev) {
    if (ev && ev.stopPropagation) ev.stopPropagation();
    exMapCollapsed[id] = !exMapCollapsed[id];
    renderMapTree();
  };

  window._explorerMapGo = function (id) {
    if (!exNode(id)) return;
    window.toggleExplorerMap(false);
    loadNode(id);
  };

  // Delete a node and all of its descendants from the exploration tree.
  window._explorerMapDelete = function (id, ev) {
    if (ev && ev.stopPropagation) ev.stopPropagation();
    var target = exNode(id);
    if (!target) return;
    // Gather the node + every descendant.
    var doomed = {};
    (function collect(nid) {
      doomed[nid] = true;
      exChildren(nid).forEach(function (k) { collect(k.id); });
    })(id);
    var count = Object.keys(doomed).length;
    var label = target.title || 'this step';
    var msg = count > 1
      ? 'Delete "' + label + '" and its ' + (count - 1) + ' sub-branch' + (count - 1 === 1 ? '' : 'es') + '?'
      : 'Delete "' + label + '"?';
    if (typeof window.confirm === 'function' && !window.confirm(msg)) return;

    var parentId = target.parentId;
    EX.nodes = EX.nodes.filter(function (n) { return !doomed[n.id]; });

    // If the node we were viewing got removed, fall back to its parent,
    // then any remaining root, then the front door.
    if (doomed[EX.currentId]) {
      if (parentId && exNode(parentId)) EX.currentId = parentId;
      else { var firstRoot = EX.nodes.find(function (n) { return !n.parentId; }); EX.currentId = firstRoot ? firstRoot.id : null; }
    }

    if (!EX.nodes.length) {
      // Whole exploration emptied — drop the saved session and reset.
      exDeleteSessionRecord(EX.sessionId);
      EX.currentId = null;
      EX.sessionId = '';
      EX.convId = '';
      window.toggleExplorerMap(false);
      renderFrontDoor();
      return;
    }

    exPersistCurrent();
    renderMapTree();
    if (EX.currentId && exNode(EX.currentId)) loadNode(EX.currentId);
    else { window.toggleExplorerMap(false); renderFrontDoor(); }
  };

  // Rename a node's title (also reflected in breadcrumb + exports).
  window._explorerMapRename = function (id, ev) {
    if (ev && ev.stopPropagation) ev.stopPropagation();
    var node = exNode(id);
    if (!node) return;
    var next = (typeof window.prompt === 'function')
      ? window.prompt('Rename this step', node.title || '')
      : null;
    if (next === null) return; // cancelled
    next = String(next).trim();
    if (!next || next === node.title) return;
    node.title = next.slice(0, 120);
    exPersistCurrent();
    renderMapTree();
    if (id === EX.currentId) renderBreadcrumb();
  };

  // ── Export the whole session map as a self-contained interactive file ────

  // Remove the "go deeper" journey section (explore_into buttons + the
  // heading/container that introduces them) from a spec, returning a clone.
  function exStripGoDeeper(spec) {
    if (!spec || !spec.elements) return spec;
    var clone;
    try { clone = JSON.parse(JSON.stringify(spec)); } catch (_) { return spec; }
    var els = clone.elements || {};
    var remove = {};
    // 1) explore_into buttons. The journey action may live on the element
    //    top level (e.action) or inside props (e.props.action) depending on
    //    how the spec was authored, so check both.
    Object.keys(els).forEach(function (k) {
      var e = els[k];
      if (!e) return;
      var act = (e.props && e.props.action) || e.action;
      if (act === 'explore_into') remove[k] = true;
    });
    // 2) headings that introduce the journey ("go deeper", "continue exploring"…).
    var headRe = /(go deeper|dig deeper|continue exploring|explore (more|further|next)|where to (next|go)|keep exploring|branch (out|from here)|next steps?)/i;
    Object.keys(els).forEach(function (k) {
      var e = els[k];
      if (!e) return;
      if ((e.type === 'Heading' || e.type === 'Text') && e.props) {
        var t = e.props.text || e.props.title || '';
        if (t && headRe.test(String(t))) remove[k] = true;
      }
    });
    // Detach removed ids from every children array.
    Object.keys(els).forEach(function (k) {
      var e = els[k];
      if (e && Array.isArray(e.children)) {
        e.children = e.children.filter(function (c) { return !remove[c]; });
      }
    });
    // Prune containers that became empty (no children, no own content props).
    var changed = true, guard = 0;
    var contentProps = ['text', 'title', 'src', 'label', 'value', 'items', 'data', 'rows', 'options', 'tabs', 'series'];
    function hasContent(e) {
      if (!e || !e.props) return false;
      return contentProps.some(function (p) {
        var v = e.props[p];
        return v != null && v !== '' && !(Array.isArray(v) && v.length === 0);
      });
    }
    var containerTypes = { Card: 1, Stack: 1, Grid: 1, Section: 1, Tabs: 1, Carousel: 1, Accordion: 1 };
    while (changed && guard++ < 20) {
      changed = false;
      Object.keys(els).forEach(function (k) {
        if (remove[k] || k === clone.root) return;
        var e = els[k];
        if (!e) return;
        if (containerTypes[e.type] && (!e.children || !e.children.length) && !hasContent(e)) {
          remove[k] = true;
          changed = true;
          Object.keys(els).forEach(function (pk) {
            var pe = els[pk];
            if (pe && Array.isArray(pe.children)) pe.children = pe.children.filter(function (c) { return c !== k; });
          });
        }
      });
    }
    Object.keys(remove).forEach(function (k) { delete els[k]; });
    return clone;
  }

  // Render a spec to a static HTML string (icons stripped to avoid missing
  // webfont glyphs in the exported file).
  function exSpecToHtml(spec) {
    if (!spec || typeof renderGenUI !== 'function') return '<p class="ex-empty">No content captured for this step.</p>';
    var holder = document.createElement('div');
    holder.className = 'gui-root explorer-gui';
    holder.style.position = 'absolute';
    holder.style.left = '-99999px';
    holder.style.width = '820px';
    document.body.appendChild(holder);
    var html = '';
    try {
      renderGenUI(spec, holder);
      holder.querySelectorAll('i.ti, .ti').forEach(function (n) {
        if (n.tagName === 'I') n.remove();
      });
      // Un-proxy image URLs: the live renderer routes http(s) images through the
      // app's local /api/fetch-image proxy, which doesn't exist in a standalone
      // exported file. Restore the original absolute URL so images load anywhere.
      holder.querySelectorAll('img').forEach(function (img) {
        var s = img.getAttribute('src') || '';
        var m = s.match(/[?&]url=([^&]+)/);
        if (/^\/api\/fetch-image/.test(s) && m) {
          try { img.setAttribute('src', decodeURIComponent(m[1])); } catch (_) {}
        }
        img.removeAttribute('data-gui-broken');
        if (img.style && img.style.display === 'none') img.style.display = '';
        img.setAttribute('loading', 'lazy');
        img.setAttribute('referrerpolicy', 'no-referrer');
      });
      html = holder.innerHTML;
    } catch (e) {
      html = '<p class="ex-empty">Could not render this step.</p>';
    } finally {
      holder.remove();
    }
    return html;
  }

  // Pull the gui-* component CSS + the theme variables actually in use so the
  // export looks right without shipping the entire app stylesheet.
  function exCollectGuiCss() {
    var out = [];
    for (var s = 0; s < document.styleSheets.length; s++) {
      var rules;
      try { rules = document.styleSheets[s].cssRules; } catch (_) { continue; }
      if (!rules) continue;
      for (var i = 0; i < rules.length; i++) {
        var r = rules[i];
        var sel = r.selectorText || '';
        if (!sel) continue;
        if (/\.gui[-\w]*/.test(sel) || /\.explorer-gui/.test(sel)) out.push(r.cssText);
      }
    }
    return out.join('\n');
  }

  function exThemeVarBlock() {
    var names = ['--fau-bg', '--fau-surface', '--fau-surface1', '--fau-surface2', '--fau-surface3',
      '--fau-border', '--fau-text', '--fau-text-dim', '--fau-text-muted',
      '--accent', '--accent2', '--accent-dim', '--accent-glow', '--accent-contrast', '--gui-accent',
      '--success', '--error', '--warn', '--color-warning',
      '--radius', '--radius-sm', '--shadow-4', '--font'];
    var cs = getComputedStyle(document.documentElement);
    var lines = names.map(function (n) {
      var v = cs.getPropertyValue(n);
      return v && v.trim() ? '  ' + n + ': ' + v.trim() + ';' : '';
    }).filter(Boolean);
    return ':root {\n' + lines.join('\n') + '\n}';
  }

  function exExportShellCss() {
    return [
      '*{box-sizing:border-box}',
      'html,body{margin:0;height:100%}',
      'body{background:var(--fau-bg,#0e0f13);color:var(--fau-text,#e8e8ea);font-family:var(--font,system-ui,-apple-system,Segoe UI,Roboto,sans-serif);font-size:14px}',
      '.ex-export{display:grid;grid-template-columns:300px minmax(0,1fr);height:100vh}',
      '.ex-tree{border-right:1px solid var(--fau-border,#262830);overflow-y:auto;padding:14px;background:var(--fau-surface,#15171c)}',
      '.ex-tree-head{display:flex;align-items:center;justify-content:space-between;gap:8px;margin-bottom:10px}',
      '.ex-tree-title{font-size:13px;font-weight:700;color:var(--fau-text,#eee);display:flex;align-items:center;gap:7px}',
      '.ex-print-btn{border:1px solid var(--fau-border,#333);background:var(--fau-surface2,#1d2027);color:var(--fau-text-dim,#bbb);border-radius:8px;padding:6px 10px;font:inherit;font-size:12px;cursor:pointer}',
      '.ex-print-btn:hover{color:var(--fau-text,#fff);border-color:var(--accent,#5b8cff)}',
      '.ex-node{display:flex;align-items:center;gap:6px;border-radius:8px;border:1px solid transparent;padding:7px 8px;cursor:pointer;color:var(--fau-text-dim,#bbb);font-size:13px}',
      '.ex-node:hover{background:var(--fau-surface2,#1d2027);color:var(--fau-text,#fff)}',
      '.ex-node.active{background:var(--accent-dim,rgba(91,140,255,.16));color:var(--accent2,#9db8ff);border-color:var(--accent,#5b8cff)}',
      '.ex-node-label{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
      '.ex-node-rename{opacity:0;border:none;background:transparent;color:inherit;cursor:pointer;font-size:13px;padding:2px}',
      '.ex-node:hover .ex-node-rename{opacity:.8}',
      '.ex-node-rename:hover{opacity:1}',
      '.ex-main{overflow-y:auto;padding:22px clamp(18px,4vw,48px) 60px}',
      '.ex-breadcrumb{display:flex;flex-wrap:wrap;align-items:center;gap:6px;font-size:13px;color:var(--fau-text-muted,#888);margin-bottom:18px}',
      '.ex-breadcrumb button{border:none;background:none;color:var(--fau-text-dim,#bbb);cursor:pointer;font:inherit;padding:2px 4px;border-radius:6px}',
      '.ex-breadcrumb button:hover{color:var(--accent2,#9db8ff)}',
      '.ex-breadcrumb .ex-crumb-cur{color:var(--fau-text,#fff);font-weight:600}',
      '.ex-breadcrumb .ex-crumb-sep{opacity:.5}',
      '.ex-content{max-width:920px}',
      '.ex-empty{color:var(--fau-text-muted,#888);font-style:italic}',
      '.ex-print-only{display:none}',
      '@media print{',
      '  .ex-tree,.ex-breadcrumb,.ex-print-btn{display:none!important}',
      '  .ex-export{display:block;height:auto}',
      '  .ex-main{display:none}',
      '  .ex-print-only{display:block;padding:0 12px}',
      '  .ex-print-node{break-inside:avoid;page-break-inside:avoid;margin:0 0 26px}',
      '  .ex-print-path{font-size:12px;color:#666;margin-bottom:4px}',
      '  .ex-print-title{font-size:18px;font-weight:700;margin:0 0 10px}',
      '}',
    ].join('\n');
  }

  // Build the full self-contained HTML document for the current session.
  function exBuildExportHtml() {
    var nodes = EX.nodes.map(function (n) {
      return {
        id: n.id,
        parentId: n.parentId || null,
        title: n.title || 'Step',
        html: n.spec ? exSpecToHtml(exStripGoDeeper(n.spec)) : '',
      };
    });
    var root = EX.nodes.find(function (n) { return !n.parentId; });
    var sessionTitle = (root && root.title) || 'Exploration';
    var css = exThemeVarBlock() + '\n' + exExportShellCss() + '\n' + exCollectGuiCss();
    var data = JSON.stringify({ title: sessionTitle, nodes: nodes, rootId: root ? root.id : (nodes[0] && nodes[0].id) });

    var script = [
      '(function(){',
      'var D=window.__EX_DATA__;var CUR=D.rootId;',
      'var byId={};D.nodes.forEach(function(n){byId[n.id]=n});',
      'function kids(id){return D.nodes.filter(function(n){return n.parentId===id})}',
      'function pathTo(id){var p=[],n=byId[id],g=0;while(n&&g++<200){p.unshift(n);n=n.parentId?byId[n.parentId]:null}return p}',
      'function esc(s){return String(s==null?"":s).replace(/[&<>"]/g,function(c){return{"&":"&amp;","<":"&lt;",">":"&gt;","\\"":"&quot;"}[c]})}',
      'function renderTree(){var roots=D.nodes.filter(function(n){return !n.parentId});var out=[];' +
        'function walk(n,d){out.push(' +
        '\'<div class="ex-node\'+(n.id===CUR?" active":"")+\'" style="padding-left:\'+(d*16+8)+\'px" onclick="EXGO(\\\'\'+n.id+\'\\\')">\'+' +
        '\'<span class="ex-node-label">\'+esc(n.title)+\'</span>\'+' +
        '\'<button class="ex-node-rename" title="Rename" onclick="event.stopPropagation();EXREN(\\\'\'+n.id+\'\\\')">\\u270e</button>\'+' +
        '\'</div>\');kids(n.id).forEach(function(k){walk(k,d+1)})}' +
        'roots.forEach(function(r){walk(r,0)});document.getElementById("ex-tree-list").innerHTML=out.join("")}',
      'function renderCrumb(){var p=pathTo(CUR),h=[];p.forEach(function(n,i){var last=i===p.length-1;' +
        'if(i)h.push(\'<span class="ex-crumb-sep">/</span>\');' +
        'h.push(last?\'<span class="ex-crumb-cur">\'+esc(n.title)+\'</span>\':\'<button onclick="EXGO(\\\'\'+n.id+\'\\\')">\'+esc(n.title)+\'</button>\')});' +
        'document.getElementById("ex-breadcrumb").innerHTML=h.join("")}',
      'function renderContent(){var n=byId[CUR];document.getElementById("ex-content").innerHTML=n&&n.html?n.html:\'<p class="ex-empty">No content captured for this step.</p>\'}',
      'function renderPrint(){var out=[];D.nodes.forEach(function(n){var p=pathTo(n.id).map(function(x){return x.title});' +
        'out.push(\'<section class="ex-print-node"><div class="ex-print-path">\'+esc(p.join(" / "))+\'</div><h2 class="ex-print-title">\'+esc(n.title)+\'</h2><div class="gui-root explorer-gui">\'+(n.html||"")+\'</div></section>\')});' +
        'document.getElementById("ex-print").innerHTML=out.join("")}',
      'window.EXGO=function(id){CUR=id;renderTree();renderCrumb();renderContent();var m=document.querySelector(".ex-main");if(m)m.scrollTop=0};',
      'window.EXREN=function(id){var n=byId[id];if(!n)return;var v=prompt("Rename this step",n.title||"");if(v===null)return;v=String(v).trim();if(!v)return;n.title=v.slice(0,120);renderTree();renderCrumb();renderPrint()};',
      'window.EXPRINT=function(){window.print()};',
      'renderTree();renderCrumb();renderContent();renderPrint();',
      '})();',
    ].join('\n');

    var html = '<!doctype html>\n<html lang="en">\n<head>\n<meta charset="utf-8">\n' +
      '<meta name="viewport" content="width=device-width, initial-scale=1">\n' +
      '<title>' + escHtml(sessionTitle) + ' — Explore map</title>\n' +
      '<style>\n' + css + '\n</style>\n</head>\n<body>\n' +
      '<div class="ex-export">\n' +
        '<aside class="ex-tree">\n' +
          '<div class="ex-tree-head"><div class="ex-tree-title">\u2318 ' + escHtml(sessionTitle) + '</div>' +
            '<button class="ex-print-btn" onclick="EXPRINT()">Save as PDF</button></div>\n' +
          '<div id="ex-tree-list"></div>\n' +
        '</aside>\n' +
        '<main class="ex-main">\n' +
          '<div class="ex-breadcrumb" id="ex-breadcrumb"></div>\n' +
          '<div class="ex-content gui-root explorer-gui" id="ex-content"></div>\n' +
        '</main>\n' +
        '<div class="ex-print-only" id="ex-print"></div>\n' +
      '</div>\n' +
      '<script>window.__EX_DATA__=' + data.replace(/<\//g, '<\\/') + ';<\/script>\n' +
      '<script>\n' + script + '\n<\/script>\n' +
      '</body>\n</html>';
    return { html: html, title: sessionTitle };
  }

  window._explorerExportMap = function () {
    if (!EX.nodes || !EX.nodes.length) {
      if (typeof showToast === 'function') showToast('Nothing to export yet');
      return;
    }
    var built;
    try { built = exBuildExportHtml(); }
    catch (e) {
      if (typeof showToast === 'function') showToast('Export failed: ' + (e && e.message || 'error'));
      return;
    }
    var slug = (built.title || 'exploration').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'exploration';
    var blob = new Blob([built.html], { type: 'text/html' });
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url;
    a.download = 'explore-' + slug + '.html';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(function () { URL.revokeObjectURL(url); }, 4000);
    if (typeof showToast === 'function') showToast('Exported map · open the file, then “Save as PDF” to print');
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
      var title = s.title || 'Exploration';
      var meta = steps + ' step' + (steps === 1 ? '' : 's') + (forks > 0 ? ' · branched' : '') + ' · ' + exTimeAgo(s.updatedAt);
      return '<div class="explorer-session' + active + '" onclick="_exOpenSession(\'' + s.id + '\')" title="' + escHtml(title) + ' \u2014 ' + escHtml(meta) + '">' +
          '<span class="explorer-session-label">' + escHtml(title) + '</span>' +
          '<span class="explorer-session-date">' + escHtml(exTimeAgo(s.updatedAt)) + '</span>' +
          '<span class="explorer-session-actions">' +
            '<button class="explorer-session-act" onclick="event.stopPropagation();_exRenameSession(\'' + s.id + '\',event)" title="Rename"><i class="ti ti-pencil"></i></button>' +
            '<button class="explorer-session-act explorer-session-act-del" onclick="event.stopPropagation();_exDeleteSession(\'' + s.id + '\')" title="Delete"><i class="ti ti-trash"></i></button>' +
          '</span>' +
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
    if (!panel) return;
    var open = (force !== undefined) ? !!force : panel.hasAttribute('hidden');
    if (open) {
      renderSessionsList();
      panel.removeAttribute('hidden');
    } else {
      panel.setAttribute('hidden', '');
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
    // Live web grounding is always on now — ignore any stored web flag.
    EX.web = true;
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

  window._exRenameSession = function (id, ev) {
    if (ev && ev.stopPropagation) ev.stopPropagation();
    var list = exLoadSessions();
    var s = null;
    for (var i = 0; i < list.length; i++) { if (list[i].id === id) { s = list[i]; break; } }
    if (!s) return;
    var name = window.prompt('Rename exploration', s.title || 'Exploration');
    if (name == null) return;
    name = String(name).trim().slice(0, 120);
    if (!name) return;
    s.title = name;
    exSaveSessions(list);
    // Keep the live session's root node + breadcrumb in sync.
    if (EX.sessionId === id) {
      var root = EX.nodes.find(function (n) { return !n.parentId; });
      if (root) root.title = name;
      if (typeof renderBreadcrumb === 'function') renderBreadcrumb();
    }
    renderSessionsList();
  };

  // Remove a saved session record without touching the live EX state/UI.
  function exDeleteSessionRecord(id) {
    if (!id) return;
    var list = exLoadSessions().filter(function (s) { return s.id !== id; });
    exSaveSessions(list);
    renderSessionsList();
  }

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

  // A compact list of the user's real projects, sent to the Explore route so
  // status/data prompts ground on a chosen project instead of hallucinating a
  // dashboard from invented numbers.
  function exProjectsForGrounding() {
    try {
      if (typeof state === 'undefined' || !Array.isArray(state.projects)) return [];
      return state.projects.slice(0, 30).map(function (p) {
        var desc = p && (p.description || p.goal || p.summary || p.brief) ? String(p.description || p.goal || p.summary || p.brief) : '';
        return {
          name: p && p.name ? String(p.name).slice(0, 120) : '',
          description: desc.slice(0, 200),
        };
      }).filter(function (p) { return p.name; });
    } catch (_) { return []; }
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
      '<div class="explorer-page-flex">' +
        '<aside class="explorer-sessions" id="explorer-sessions-panel">' +
          '<div class="explorer-sessions-top">' +
            '<span class="explorer-sessions-brand"><i class="ti ti-compass"></i> Explore</span>' +
            '<button class="explorer-chat-x" onclick="toggleExplorerSessions(false)" aria-label="Close"><i class="ti ti-x"></i></button>' +
          '</div>' +
          '<div class="explorer-sessions-actions">' +
            '<button class="explorer-sessions-act" onclick="_exNewSession()"><i class="ti ti-edit"></i> New exploration</button>' +
          '</div>' +
          '<div class="explorer-sessions-secthead"><i class="ti ti-chevron-down"></i><span>Recent explorations</span></div>' +
          '<div class="explorer-sessions-list" id="explorer-sessions-list"></div>' +
        '</aside>' +
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
      '</div>' +
      '<div class="explorer-trail-backdrop" id="explorer-trail-backdrop" hidden onclick="_explorerToggleTrail(false)"></div>' +
      '<div class="explorer-trail-pop" id="explorer-trail-pop" hidden>' +
        '<div class="explorer-trail-head"><i class="ti ti-route"></i><span>Your trail</span></div>' +
        '<div class="explorer-trail-list" id="explorer-trail-list"></div>' +
      '</div>' +
      '<div class="explorer-sessions-backdrop" id="explorer-map-backdrop" hidden onclick="toggleExplorerMap(false)"></div>' +
      '<aside class="explorer-map-panel" id="explorer-map-panel" hidden>' +
        '<div class="explorer-sessions-head">' +
          '<span><i class="ti ti-sitemap"></i> Branch map</span>' +
          '<div class="explorer-map-head-actions">' +
            '<button class="explorer-map-export" onclick="_explorerExportMap()" title="Export this map as an interactive HTML / PDF"><i class="ti ti-download"></i> Export</button>' +
            '<button class="explorer-chat-x" onclick="toggleExplorerMap(false)" aria-label="Close"><i class="ti ti-x"></i></button>' +
          '</div>' +
        '</div>' +
        '<p class="explorer-map-hint">Every view you opened. Click any node to jump back to it, the pencil to rename, or the trash to remove a branch.</p>' +
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
    var pref = exPreferredModel();
    if (pref) return pref;
    return (typeof state !== 'undefined' && state.model) ? state.model : '';
  }

  // Explore prefers a recent GPT (5.5, then 5.4) when one is available, since it
  // does the best with the gen-ui JSON contract. Falls back to the chat default.
  function exPreferredModel() {
    var models = (typeof allModels !== 'undefined' && Array.isArray(allModels)) ? allModels : [];
    if (!models.length) return '';
    var prefer = ['gpt-5.5', 'gpt-5.4'];
    for (var i = 0; i < prefer.length; i++) {
      var want = prefer[i];
      // Prefer an exact id match, else the closest variant (e.g. gpt-5.5, gpt-5.5-mini).
      var exact = models.find(function (m) { return m.id === want; });
      if (exact) return exact.id;
      var loose = models.find(function (m) { return typeof m.id === 'string' && m.id.indexOf(want) === 0; });
      if (loose) return loose.id;
    }
    return '';
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
    // Retained for backward-compat; live web grounding is always on.
    EX.web = true;
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
