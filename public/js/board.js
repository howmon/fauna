// ── Kanban Board — per-project + global ────────────────────────────────────
// Renders work items grouped by column. Drag-and-drop between columns.
// Subscribes to /api/board/stream for live updates from the worker (P4)
// and other clients.
//
// Public API (attached to window for inline-onclick handlers):
//   renderKanbanBoard(opts, mountEl)
//     opts.projectId       — per-project board. Omit for global view.
//     opts.scope='global'  — render aggregated cards from every project.
//   refreshKanbanBoard()   — re-fetch + re-render the current board.
//   openWorkItemModal(projectId, itemId)
//   openNewWorkItemModal(projectId)
//
// State lives on window._kbState; only one board is ever mounted at a time.

(function() {
  'use strict';

  var COLUMNS = [
    { id: 'backlog',     label: 'Backlog',     icon: 'ti-inbox' },
    { id: 'todo',        label: 'To do',       icon: 'ti-list' },
    { id: 'in_progress', label: 'In progress', icon: 'ti-player-play' },
    { id: 'review',      label: 'Review',      icon: 'ti-eye' },
    { id: 'done',        label: 'Done',        icon: 'ti-check' },
    { id: 'archived',    label: 'Archived',    icon: 'ti-archive' },
  ];

  var PRIORITY_LABELS = { p0: 'P0', p1: 'P1', p2: 'P2', p3: 'P3' };

  window._kbState = window._kbState || {
    projectId: null,           // null = global view
    scope: 'project',          // 'project' | 'global'
    items: [],
    projectsById: {},          // for global view, project metadata lookup
    mountEl: null,
    sse: null,
    dragId: null,
    dragFromCol: null,
    filterAssignee: 'all',     // 'all' | 'ai' | 'human'
    showArchived: false,
    kanban: {},                // current project's kanban config (autopilot etc)
  };

  function _esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function _toast(msg, isErr) {
    if (typeof showToast === 'function') showToast(msg, isErr);
    else console[isErr ? 'error' : 'log']('[board]', msg);
  }

  // ── Fetchers ───────────────────────────────────────────────────────────
  function _fetchProjectBoard(projectId) {
    return fetch('/api/projects/' + encodeURIComponent(projectId) + '/board')
      .then(function(r) { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); });
  }
  function _fetchGlobal() {
    var qs = window._kbState.showArchived ? '' : '';
    return fetch('/api/board' + qs)
      .then(function(r) { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); });
  }

  // ── Render ─────────────────────────────────────────────────────────────
  function renderKanbanBoard(opts, mountEl) {
    opts = opts || {};
    var s = window._kbState;
    s.scope = opts.scope === 'global' ? 'global' : 'project';
    s.projectId = opts.projectId || null;
    s.mountEl = mountEl;
    if (!mountEl) return;

    mountEl.innerHTML =
      '<div class="kb-toolbar">' +
        '<div class="kb-toolbar-left">' +
          '<button class="kb-btn primary" onclick="openNewWorkItemModal(' +
            (s.scope === 'project' ? "'" + _esc(s.projectId) + "'" : 'null') +
          ')"><i class="ti ti-plus"></i> New work item</button>' +
          (s.scope === 'project'
            ? '<button class="kb-btn" onclick="kbPrioritize()" title="Score with RICE and promote new cards into Todo"><i class="ti ti-sort-descending"></i> Prioritise</button>'
            : '') +
          (s.scope === 'project'
            ? '<button class="kb-btn danger" onclick="kbEmptyArchive(\'' + _esc(s.projectId) + '\')" title="Permanently delete all archived cards"><i class="ti ti-trash"></i> Empty archive</button>'
            : '') +
          (s.scope === 'project'
            ? '<label class="kb-toggle-wrap kb-autopilot-toggle" title="When on, the AI will claim Todo cards assigned to it and run them automatically.">' +
                '<input type="checkbox" id="kb-autopilot-cb" onchange="kbToggleAutopilot(this.checked)"> ' +
                '<span><i class="ti ti-robot"></i> Autopilot</span>' +
              '</label>' +
              '<label class="kb-toggle-wrap kb-concurrency-wrap" title="Max in-flight AI cards per project. Higher = more cards run in parallel.">' +
                '<span style="font-size:11px;color:var(--fau-text-dim)">Parallel</span>' +
                '<input type="number" id="kb-concurrency" min="1" max="10" step="1" ' +
                  'onchange="kbSetConcurrency(this.value)" ' +
                  'style="width:48px;background:var(--fau-surface2);border:1px solid var(--fau-border);border-radius:6px;padding:3px 6px;color:var(--fau-text);font-size:12px;">' +
              '</label>' +
              '<div id="kb-idle-banner" class="kb-idle-banner" style="display:none"></div>'
            : '') +
        '</div>' +
        '<div class="kb-toolbar-right">' +
          '<div class="kb-filter-group" role="group">' +
            '<button class="kb-chip ' + (s.filterAssignee === 'all'   ? 'active' : '') + '" onclick="kbSetFilter(\'all\')">All</button>' +
            '<button class="kb-chip ' + (s.filterAssignee === 'human' ? 'active' : '') + '" onclick="kbSetFilter(\'human\')"><i class="ti ti-user"></i> Mine</button>' +
            '<button class="kb-chip ' + (s.filterAssignee === 'ai'    ? 'active' : '') + '" onclick="kbSetFilter(\'ai\')"><i class="ti ti-robot"></i> AI</button>' +
          '</div>' +
          '<label class="kb-toggle-wrap" title="Show archived cards">' +
            '<input type="checkbox" ' + (s.showArchived ? 'checked' : '') + ' onchange="kbToggleArchived(this.checked)"> ' +
            '<span>Archived</span>' +
          '</label>' +
          '<button class="kb-btn" onclick="refreshKanbanBoard()" title="Refresh"><i class="ti ti-refresh"></i></button>' +
        '</div>' +
      '</div>' +
      '<div class="kb-board" id="kb-board-grid"></div>';

    refreshKanbanBoard();
    _subscribeSse();
  }

  function refreshKanbanBoard() {
    var s = window._kbState;
    if (!s.mountEl) return;
    var loader = s.scope === 'global' ? _fetchGlobal() : _fetchProjectBoard(s.projectId);
    loader.then(function(data) {
      if (s.scope === 'global') {
        s.items = data.items || [];
        // Build a project lookup from cards (each has projectId/Name/Color)
        s.projectsById = {};
        s.items.forEach(function(it) {
          if (it.projectId && !s.projectsById[it.projectId]) {
            s.projectsById[it.projectId] = { id: it.projectId, name: it.projectName, color: it.projectColor };
          }
        });
      } else {
        // Per-project: flatten board.columns into items[]
        s.items = [];
        var cols = (data && data.columns) || {};
        Object.keys(cols).forEach(function(col) {
          (cols[col] || []).forEach(function(it) {
            it.column = it.column || col;
            s.items.push(it);
          });
        });
        // Capture project kanban config so the toolbar can render the
        // autopilot toggle in sync with the server.
        s.kanban = (data && data.kanban) || {};
        // Capture the autopilot idle-reason snapshot (server-attached).
        s.idle = (data && data.idle) || null;
        _updateAutopilotToggle();
        _updateIdleBanner();
      }
      _renderGrid();
    }).catch(function(e) {
      _toast('Board load failed: ' + e.message, true);
    });
  }

  function _renderGrid() {
    var s = window._kbState;
    var grid = document.getElementById('kb-board-grid');
    if (!grid) return;
    var filtered = s.items.filter(function(it) {
      if (s.filterAssignee !== 'all' && it.assignee !== s.filterAssignee) return false;
      return true;
    });
    var cols = COLUMNS.filter(function(c) { return s.showArchived || c.id !== 'archived'; });
    grid.innerHTML = cols.map(function(col) {
      var items = filtered.filter(function(it) { return it.column === col.id; });
      return '<div class="kb-column" data-col="' + col.id + '" ' +
        'ondragover="kbDragOver(event)" ondragleave="kbDragLeave(event)" ondrop="kbDrop(event,\'' + col.id + '\')">' +
        '<div class="kb-col-header">' +
          '<span class="kb-col-title"><i class="ti ' + col.icon + '"></i> ' + col.label + '</span>' +
          '<span class="kb-col-count">' + items.length + '</span>' +
        '</div>' +
        '<div class="kb-col-list">' +
          (items.length ? items.map(_renderCard).join('') : '<div class="kb-col-empty">Drop here</div>') +
        '</div>' +
      '</div>';
    }).join('');
  }

  function _renderCard(it) {
    var s = window._kbState;
    var assigneeChip = '';
    if (it.assignee === 'ai')    assigneeChip = '<span class="kb-chip-mini kb-chip-ai" title="Assigned to AI"><i class="ti ti-robot"></i></span>';
    else if (it.assignee === 'human') assigneeChip = '<span class="kb-chip-mini kb-chip-human" title="Assigned to a human"><i class="ti ti-user"></i></span>';

    var lockChip = it.lockedByUser
      ? '<span class="kb-chip-mini kb-chip-lock" title="Locked — AI cannot move or archive"><i class="ti ti-lock"></i></span>'
      : '';

    var priorityCls = 'kb-pri-' + (it.priority || 'p2');
    var priorityChip = '<span class="kb-chip-mini ' + priorityCls + '" title="Priority ' + _esc(it.priority || 'p2') + '">' +
      _esc(PRIORITY_LABELS[it.priority] || 'P2') + '</span>';

    var commentsBadge = (it.comments && it.comments.length)
      ? '<span class="kb-card-meta-item" title="' + it.comments.length + ' comment(s)"><i class="ti ti-message"></i> ' + it.comments.length + '</span>'
      : '';
    var runsBadge = (it.runs && it.runs.length)
      ? '<span class="kb-card-meta-item" title="' + it.runs.length + ' run(s)"><i class="ti ti-rocket"></i> ' + it.runs.length + '</span>'
      : '';
    var scoreBadge = (typeof it.score === 'number' && it.score > 0)
      ? '<span class="kb-card-meta-item" title="RICE score"><i class="ti ti-target-arrow"></i> ' + it.score + '</span>'
      : '';

    // Global view: small project chip in top corner
    var projectChip = '';
    if (s.scope === 'global' && it.projectName) {
      projectChip = '<span class="kb-chip-mini kb-chip-proj proj-color-' + _esc(it.projectColor || 'teal') + '" ' +
        'onclick="event.stopPropagation();setActiveProject(\'' + _esc(it.projectId) + '\')" ' +
        'title="Open project ' + _esc(it.projectName) + '">' + _esc(it.projectName) + '</span>';
    }

    var sourceMark = '';
    if (it.source === 'reflection') sourceMark = '<i class="ti ti-bulb kb-card-src" title="Proposed by project audit"></i>';
    else if (it.source === 'agent') sourceMark = '<i class="ti ti-robot kb-card-src" title="Created by AI"></i>';

    var pidArg = s.scope === 'global'
      ? "'" + _esc(it.projectId) + "'"
      : "'" + _esc(s.projectId) + "'";

    // Live-run pill — visible on AI-claimed in_progress cards. Clicking it
    // opens the live task viewer panel (model + chain-of-reasoning + steps).
    // runs[] may end with a `finishedAt`-only entry from a prior failed run,
    // so we walk backwards to find the most recent entry that actually has a
    // taskId (the live one). Without this the badge silently disappears after
    // any recovery / retry until a brand-new run completes.
    var liveBadge = '';
    var isLive = false;
    if (it.column === 'in_progress' && it.claimedBy && it.claimedBy.indexOf('ai:') === 0) {
      var liveTaskId = null;
      var runs = Array.isArray(it.runs) ? it.runs : [];
      for (var ri = runs.length - 1; ri >= 0; ri--) {
        if (runs[ri] && runs[ri].taskId) { liveTaskId = runs[ri].taskId; break; }
      }
      if (liveTaskId) {
        isLive = true;
        liveBadge = '<button class="kb-live-pill" ' +
          'onclick="event.stopPropagation();openLiveTaskPanel(\'' +
            _esc(liveTaskId) + '\',\'' + _esc(it.id) + '\')" ' +
          'title="See what the model is thinking">' +
          '<span class="kb-live-dot"></span><i class="ti ti-activity"></i> Live</button>';
      }
    }

    return '<div class="kb-card' + (isLive ? ' kb-card-live' : '') + '" draggable="true" ' +
        'data-item="' + _esc(it.id) + '" data-col="' + _esc(it.column) + '" data-project="' + _esc(it.projectId || s.projectId) + '" ' +
        'ondragstart="kbDragStart(event)" ondragend="kbDragEnd(event)" ' +
        'onclick="openWorkItemModal(' + pidArg + ',\'' + _esc(it.id) + '\')">' +
      '<div class="kb-card-top">' +
        '<div class="kb-card-chips">' + priorityChip + assigneeChip + lockChip + liveBadge + '</div>' +
        '<div class="kb-card-chips-right">' + projectChip + '</div>' +
      '</div>' +
      '<div class="kb-card-title">' + sourceMark + ' ' + _esc(it.title) + '</div>' +
      (it.body ? '<div class="kb-card-body">' + _esc(it.body).slice(0, 140) + '</div>' : '') +
      '<div class="kb-card-meta">' + scoreBadge + commentsBadge + runsBadge + '</div>' +
    '</div>';
  }

  // ── Drag and Drop ──────────────────────────────────────────────────────
  window.kbDragStart = function(e) {
    var card = e.currentTarget;
    window._kbState.dragId = card.dataset.item;
    window._kbState.dragFromCol = card.dataset.col;
    window._kbState.dragProjectId = card.dataset.project;
    card.classList.add('kb-card-dragging');
    try { e.dataTransfer.setData('text/plain', card.dataset.item); e.dataTransfer.effectAllowed = 'move'; } catch (_) {}
  };
  window.kbDragEnd = function(e) {
    var card = e.currentTarget;
    card.classList.remove('kb-card-dragging');
    document.querySelectorAll('.kb-column.kb-col-over').forEach(function(el) { el.classList.remove('kb-col-over'); });
  };
  window.kbDragOver = function(e) {
    e.preventDefault();
    try { e.dataTransfer.dropEffect = 'move'; } catch (_) {}
    e.currentTarget.classList.add('kb-col-over');
  };
  window.kbDragLeave = function(e) {
    e.currentTarget.classList.remove('kb-col-over');
  };
  window.kbDrop = function(e, targetCol) {
    e.preventDefault();
    e.currentTarget.classList.remove('kb-col-over');
    var s = window._kbState;
    var id = s.dragId;
    var from = s.dragFromCol;
    var projectId = s.dragProjectId || s.projectId;
    s.dragId = null; s.dragFromCol = null;
    if (!id || !projectId || from === targetCol) return;
    // Optimistic update
    var local = s.items.find(function(x) { return x.id === id; });
    if (local) local.column = targetCol;
    _renderGrid();
    fetch('/api/projects/' + encodeURIComponent(projectId) + '/workitems/' +
      encodeURIComponent(id) + '/move', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-fauna-actor': 'human' },
        body: JSON.stringify({ column: targetCol }),
      })
      .then(function(r) { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); })
      .then(function(item) {
        if (local) Object.assign(local, item);
        _renderGrid();
      })
      .catch(function(e) {
        _toast('Move failed: ' + e.message, true);
        refreshKanbanBoard(); // re-sync from server
      });
  };

  // ── Toolbar handlers ───────────────────────────────────────────────────
  window.kbSetFilter = function(v) {
    window._kbState.filterAssignee = v;
    // Toggle the active class on the toolbar chips in place — avoids
    // re-rendering the toolbar which would re-bind the SSE.
    var bar = document.querySelector('.kb-toolbar .kb-filter-group');
    if (bar) {
      bar.querySelectorAll('.kb-chip').forEach(function(c) { c.classList.remove('active'); });
      var label = (v === 'all' ? 'All' : v === 'human' ? 'Mine' : 'AI');
      bar.querySelectorAll('.kb-chip').forEach(function(c) {
        if (c.textContent.trim() === label) c.classList.add('active');
      });
    }
    _renderGrid();
  };
  window.kbToggleArchived = function(v) {
    window._kbState.showArchived = !!v;
    _renderGrid();
  };
  window.kbPrioritize = function() {
    var s = window._kbState;
    if (!s.projectId) return;
    fetch('/api/projects/' + encodeURIComponent(s.projectId) + '/prioritize', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ method: 'rice' }),
    }).then(function(r) { return r.ok ? r.json() : Promise.reject(new Error('HTTP ' + r.status)); })
      .then(function() { _toast('Prioritised'); refreshKanbanBoard(); })
      .catch(function(e) { _toast('Prioritise failed: ' + e.message, true); });
  };

  // Sync the autopilot checkbox to whatever the server says. Called after every
  // board fetch so external toggles (other tabs / API calls) stay reflected.
  function _updateAutopilotToggle() {
    var s = window._kbState;
    var cb = document.getElementById('kb-autopilot-cb');
    if (cb) cb.checked = !!(s.kanban && s.kanban.autopilot);
    var conc = document.getElementById('kb-concurrency');
    if (conc) conc.value = (s.kanban && Number(s.kanban.concurrency)) || 3;
  }

  // Render the autopilot idle-reason banner inline with the toolbar. The
  // server attaches a `board.idle = { reasons:[{kind,label,...}], candidates,
  // actionable }` snapshot whenever the picker returned null with AI
  // candidates waiting. The kanban-worker also pushes 'idle' over SSE
  // every tick. We only render when `actionable` — concurrency cap alone
  // means autopilot is running at full capacity (happy path), not stuck.
  function _updateIdleBanner() {
    var s = window._kbState;
    var el = document.getElementById('kb-idle-banner');
    if (!el) return;
    var info = s.idle;
    if (!info || !info.reasons || !info.reasons.length || !info.actionable || !(s.kanban && s.kanban.autopilot)) {
      el.style.display = 'none';
      el.innerHTML = '';
      return;
    }
    var parts = info.reasons.map(function(r) {
      if (r.kind === 'concurrency') return 'parallel cap ' + r.current + '/' + r.limit;
      if (r.kind === 'quota')       return 'daily AI quota ' + r.current + '/' + r.limit;
      if (typeof r.count === 'number') return r.count + ' ' + r.label;
      return r.label;
    });
    var summary = parts.join(' · ');
    var waiting = info.candidates + ' waiting';
    el.style.display = '';
    el.title = 'Autopilot idle — ' + summary + ' (' + info.candidates + ' AI card' + (info.candidates === 1 ? '' : 's') + ' waiting)';
    el.innerHTML =
      '<i class="ti ti-alert-triangle" aria-hidden="true"></i>' +
      '<span class="kb-idle-banner-text">' +
        '<strong>Idle:</strong> ' + _esc(summary) +
        ' <span class="kb-idle-banner-cand">· ' + _esc(waiting) + '</span>' +
      '</span>';
  }

  window.kbSetConcurrency = function(value) {
    var s = window._kbState;
    if (!s.projectId) return;
    var n = Math.max(1, Math.min(10, parseInt(value, 10) || 1));
    var nextKanban = Object.assign({}, s.kanban || {}, { concurrency: n });
    fetch('/api/projects/' + encodeURIComponent(s.projectId), {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ kanban: nextKanban }),
    }).then(function(r) { return r.ok ? r.json() : Promise.reject(new Error('HTTP ' + r.status)); })
      .then(function(proj) {
        s.kanban = (proj && proj.kanban) || nextKanban;
        _updateAutopilotToggle();
        _toast('Parallel runs set to ' + n);
      })
      .catch(function(e) { _toast('Update failed: ' + e.message, true); _updateAutopilotToggle(); });
  };

  window.kbToggleAutopilot = function(checked) {
    var s = window._kbState;
    if (!s.projectId) return;
    var nextKanban = Object.assign({}, s.kanban || {}, { autopilot: !!checked });
    fetch('/api/projects/' + encodeURIComponent(s.projectId), {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ kanban: nextKanban }),
    }).then(function(r) { return r.ok ? r.json() : Promise.reject(new Error('HTTP ' + r.status)); })
      .then(function(proj) {
        s.kanban = (proj && proj.kanban) || nextKanban;
        _updateAutopilotToggle();
        _toast(checked ? 'Autopilot ON — AI will claim Todo cards' : 'Autopilot OFF');
      })
      .catch(function(e) {
        _toast('Autopilot toggle failed: ' + e.message, true);
        _updateAutopilotToggle(); // revert UI
      });
  };

  // ── Modals (create / edit) ─────────────────────────────────────────────
  function _ensureModalHost() {
    var host = document.getElementById('kb-modal-host');
    if (host) return host;
    host = document.createElement('div');
    host.id = 'kb-modal-host';
    document.body.appendChild(host);
    return host;
  }

  function _closeModal() {
    var host = document.getElementById('kb-modal-host');
    if (host) host.innerHTML = '';
  }

  window.openNewWorkItemModal = function(projectId) {
    var s = window._kbState;
    var pid = projectId || s.projectId;
    if (!pid && s.scope === 'global') {
      // Global view with no project: pick the first known project, or warn.
      var keys = Object.keys(s.projectsById);
      pid = keys[0] || null;
    }
    if (!pid) { _toast('No project selected for new card', true); return; }
    var host = _ensureModalHost();
    host.innerHTML = _renderModal({
      mode: 'new', projectId: pid, item: {
        title: '', body: '', column: 'backlog', assignee: null,
        priority: 'p2', acceptance: '', tags: [], model: _currentTaskModelFallback(),
      },
    });
    _populateModelSelect();
  };

  window.openWorkItemModal = function(projectId, itemId) {
    var s = window._kbState;
    var item = s.items.find(function(x) { return x.id === itemId; });
    if (!item) return;
    var host = _ensureModalHost();
    host.innerHTML = _renderModal({ mode: 'edit', projectId: projectId, item: item });
    _populateModelSelect();
  };

  // Populate the model dropdown in the open work-item modal from /api/models.
  // We add the options lazily so the initial render isn't blocked on a fetch,
  // and we preserve the currently-selected value (set as data-current on render).
  function _currentTaskModelFallback() {
    try {
      if (typeof state !== 'undefined' && state && state.model) return state.model;
    } catch (_) {}
    return 'claude-sonnet-4.6';
  }

  function _populateModelSelect() {
    var sel = document.getElementById('kb-m-model');
    if (!sel) return;
    var current = sel.getAttribute('data-current') || _currentTaskModelFallback();
    fetch('/api/models').then(function(r) { return r.json(); }).then(function(d) {
      var models = (d && d.models) || [];
      if (!models.length) return;
      var html = '<option value="">Default — ' + _esc(current) + '</option>';
      var foundCurrent = false;
      models.forEach(function(mod) {
        var id = mod.id || mod.name;
        var label = mod.name || mod.id;
        if (!id) return;
        if (current === id) foundCurrent = true;
        html += '<option value="' + _esc(id) + '"' +
          (current === id ? ' selected' : '') + '>' + _esc(label) + '</option>';
      });
      if (current && !foundCurrent) {
        html += '<option value="' + _esc(current) + '" selected>' + _esc(current) + '</option>';
      }
      sel.innerHTML = html;
    }).catch(function() { /* leave the default-only dropdown in place */ });
  }

  function _renderModal(opts) {
    var m = opts.item;
    var isEdit = opts.mode === 'edit';
    var lockIcon = m.lockedByUser ? 'ti-lock' : 'ti-lock-open';
    var lockLabel = m.lockedByUser ? 'Locked' : 'Unlocked';
    var claimedLine = m.claimedBy
      ? '<div class="kb-modal-meta-row"><i class="ti ti-hand-stop"></i> Claimed by <code>' + _esc(m.claimedBy) + '</code></div>'
      : '';
    var commentsHtml = (m.comments || []).map(function(c) {
      var who = c.author === 'ai' ? '<i class="ti ti-robot"></i> AI' : '<i class="ti ti-user"></i> You';
      return '<div class="kb-comment kb-comment-' + _esc(c.author) + '">' +
        '<div class="kb-comment-head">' + who + ' · ' + new Date(c.ts).toLocaleString() + '</div>' +
        '<div class="kb-comment-body">' + _esc(c.body) + '</div>' +
      '</div>';
    }).join('');

    return '<div class="kb-modal-backdrop" onclick="if(event.target===this)closeWorkItemModal()">' +
      '<div class="kb-modal">' +
        '<div class="kb-modal-head">' +
          '<input class="kb-modal-title" id="kb-m-title" placeholder="Title…" value="' + _esc(m.title) + '">' +
          '<button class="kb-icon-btn" onclick="closeWorkItemModal()" title="Close"><i class="ti ti-x"></i></button>' +
        '</div>' +
        '<div class="kb-modal-body">' +
          '<div class="kb-modal-grid">' +
            '<label>Column' +
              '<select id="kb-m-column">' + COLUMNS.map(function(c) {
                return '<option value="' + c.id + '"' + (m.column === c.id ? ' selected' : '') + '>' + c.label + '</option>';
              }).join('') + '</select>' +
            '</label>' +
            '<label>Assignee' +
              '<select id="kb-m-assignee">' +
                '<option value=""' + (!m.assignee ? ' selected' : '') + '>— Unassigned —</option>' +
                '<option value="ai"' + (m.assignee === 'ai' ? ' selected' : '') + '>AI</option>' +
                '<option value="human"' + (m.assignee === 'human' ? ' selected' : '') + '>Human</option>' +
              '</select>' +
            '</label>' +
            '<label>Priority' +
              '<select id="kb-m-priority">' +
                ['p0','p1','p2','p3'].map(function(p) {
                  return '<option value="' + p + '"' + (m.priority === p ? ' selected' : '') + '>' + PRIORITY_LABELS[p] + '</option>';
                }).join('') +
              '</select>' +
            '</label>' +
            (isEdit ? '<label>Lock' +
              '<button type="button" class="kb-btn" onclick="kbToggleLock(\'' + _esc(opts.projectId) + '\',\'' + _esc(m.id) + '\',' + (!m.lockedByUser) + ')">' +
                '<i class="ti ' + lockIcon + '"></i> ' + lockLabel +
              '</button>' +
            '</label>' : '') +
            '<label>Model' +
              '<select id="kb-m-model" data-current="' + _esc(m.model || _currentTaskModelFallback()) + '">' +
                '<option value="' + _esc(m.model || _currentTaskModelFallback()) + '" selected>' + _esc(m.model || _currentTaskModelFallback()) + '</option>' +
              '</select>' +
            '</label>' +
          '</div>' +
          '<label class="kb-modal-full">Description' +
            '<textarea id="kb-m-body" rows="5" placeholder="What needs to happen?">' + _esc(m.body) + '</textarea>' +
          '</label>' +
          '<label class="kb-modal-full">Acceptance criteria' +
            '<textarea id="kb-m-acceptance" rows="3" placeholder="One bullet per criterion the AI must satisfy before marking Done">' + _esc(m.acceptance || '') + '</textarea>' +
          '</label>' +
          claimedLine +
          (isEdit && commentsHtml ? '<div class="kb-modal-section-label">Comments</div><div class="kb-comments">' + commentsHtml + '</div>' : '') +
          (isEdit ? '<div class="kb-modal-section-label">Add comment</div>' +
            '<div class="kb-comment-row">' +
              '<textarea id="kb-m-newcomment" rows="2" placeholder="Comment as you…"></textarea>' +
              '<button class="kb-btn" onclick="kbAddComment(\'' + _esc(opts.projectId) + '\',\'' + _esc(m.id) + '\')"><i class="ti ti-send"></i></button>' +
            '</div>' : '') +
        '</div>' +
        '<div class="kb-modal-foot">' +
          (isEdit
            ? '<div class="kb-modal-foot-left">' +
                '<button class="kb-btn danger" onclick="kbArchive(\'' + _esc(opts.projectId) + '\',\'' + _esc(m.id) + '\')"><i class="ti ti-archive"></i> Archive</button>' +
                '<button class="kb-btn danger" onclick="kbDelete(\'' + _esc(opts.projectId) + '\',\'' + _esc(m.id) + '\')"><i class="ti ti-trash"></i> Delete</button>' +
              '</div>'
            : '<span></span>') +
          '<div>' +
            '<button class="kb-btn" onclick="closeWorkItemModal()">Cancel</button>' +
            '<button class="kb-btn primary" onclick="kbSave(\'' + _esc(opts.projectId) + '\',' + (isEdit ? "'" + _esc(m.id) + "'" : 'null') + ')">' +
              '<i class="ti ti-check"></i> ' + (isEdit ? 'Save' : 'Create') +
            '</button>' +
          '</div>' +
        '</div>' +
      '</div>' +
    '</div>';
  }

  window.closeWorkItemModal = _closeModal;

  window.kbSave = function(projectId, itemId) {
    var body = {
      title: (document.getElementById('kb-m-title') || {}).value || '',
      body:  (document.getElementById('kb-m-body')  || {}).value || '',
      column: (document.getElementById('kb-m-column') || {}).value || 'backlog',
      assignee: (document.getElementById('kb-m-assignee') || {}).value || null,
      priority: (document.getElementById('kb-m-priority') || {}).value || 'p2',
      acceptance: (document.getElementById('kb-m-acceptance') || {}).value || '',
      model: (document.getElementById('kb-m-model') || {}).value || null,
    };
    try {
      var activeConv = (typeof getConv === 'function' && state.currentId) ? getConv(state.currentId) : null;
      if (!itemId && activeConv && activeConv.projectId === projectId) body.originConvId = activeConv.id;
    } catch (_) {}
    if (!body.title.trim()) { _toast('Title required', true); return; }
    var url = itemId
      ? '/api/projects/' + encodeURIComponent(projectId) + '/workitems/' + encodeURIComponent(itemId)
      : '/api/projects/' + encodeURIComponent(projectId) + '/workitems';
    fetch(url, {
      method: itemId ? 'PATCH' : 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }).then(function(r) { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); })
      .then(function() { _closeModal(); refreshKanbanBoard(); })
      .catch(function(e) { _toast('Save failed: ' + e.message, true); });
  };

  window.kbAddComment = function(projectId, itemId) {
    var el = document.getElementById('kb-m-newcomment');
    var body = (el && el.value || '').trim();
    if (!body) return;
    fetch('/api/projects/' + encodeURIComponent(projectId) + '/workitems/' +
      encodeURIComponent(itemId) + '/comments', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ author: 'human', body: body }),
      })
      .then(function(r) { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); })
      .then(function() { el.value = ''; refreshKanbanBoard(); _toast('Comment added'); })
      .catch(function(e) { _toast('Comment failed: ' + e.message, true); });
  };

  window.kbToggleLock = function(projectId, itemId, locked) {
    fetch('/api/projects/' + encodeURIComponent(projectId) + '/workitems/' +
      encodeURIComponent(itemId) + '/lock', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ locked: !!locked }),
      })
      .then(function(r) { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); })
      .then(function(item) {
        // Refresh modal & board with new lock state
        _closeModal();
        var local = window._kbState.items.find(function(x) { return x.id === itemId; });
        if (local) Object.assign(local, item);
        refreshKanbanBoard();
        openWorkItemModal(projectId, itemId);
      })
      .catch(function(e) { _toast('Lock failed: ' + e.message, true); });
  };

  window.kbArchive = function(projectId, itemId) {
    if (!confirm('Archive this work item?')) return;
    fetch('/api/projects/' + encodeURIComponent(projectId) + '/workitems/' +
      encodeURIComponent(itemId), { method: 'DELETE' })
      .then(function(r) { if (!r.ok) throw new Error('HTTP ' + r.status); })
      .then(function() { _closeModal(); refreshKanbanBoard(); })
      .catch(function(e) { _toast('Archive failed: ' + e.message, true); });
  };

  window.kbDelete = function(projectId, itemId) {
    if (!confirm('Permanently delete this work item? This cannot be undone.')) return;
    fetch('/api/projects/' + encodeURIComponent(projectId) + '/workitems/' +
      encodeURIComponent(itemId) + '?hard=1', { method: 'DELETE' })
      .then(function(r) { if (!r.ok) throw new Error('HTTP ' + r.status); })
      .then(function() { _closeModal(); refreshKanbanBoard(); _toast('Work item deleted'); })
      .catch(function(e) { _toast('Delete failed: ' + e.message, true); });
  };

  window.kbEmptyArchive = function(projectId) {
    if (!projectId) return;
    if (!confirm('Permanently delete all archived work items? This cannot be undone.')) return;
    fetch('/api/projects/' + encodeURIComponent(projectId) + '/workitems/archived', { method: 'DELETE' })
      .then(function(r) { return r.ok ? r.json() : Promise.reject(new Error('HTTP ' + r.status)); })
      .then(function(out) {
        refreshKanbanBoard();
        _toast((out && out.removedCount ? out.removedCount : 0) + ' archived item(s) deleted');
      })
      .catch(function(e) { _toast('Empty archive failed: ' + e.message, true); });
  };

  // ── SSE subscription ───────────────────────────────────────────────────
  function _subscribeSse() {
    var s = window._kbState;
    if (s.sse) { try { s.sse.close(); } catch (_) {} s.sse = null; }
    try {
      var url = window.faunaStreamUrl ? window.faunaStreamUrl('/api/board/stream') : '/api/board/stream';
      s.sse = new EventSource(url);
      s.sse.onmessage = function(ev) {
        try {
          var evt = JSON.parse(ev.data);
          if (evt.type === 'ping' || evt.type === 'hello') return;
          // For per-project view, ignore events from other projects.
          if (s.scope === 'project' && evt.projectId && evt.projectId !== s.projectId) return;
          // 'idle' is a lightweight diagnostic — update the banner inline
          // without re-fetching the whole board.
          if (evt.type === 'idle') {
            if (s.scope === 'project') {
              s.idle = {
                reasons: evt.reasons || [],
                candidates: evt.candidates || 0,
                actionable: !!evt.actionable,
              };
              _updateIdleBanner();
            }
            return;
          }
          var originConvId = evt.originConvId || (evt.item && evt.item.originConvId) || null;
          if (evt.type === 'comment' && originConvId && typeof window.receiveKanbanFeedbackFromKanban === 'function') {
            evt.originConvId = originConvId;
            window.receiveKanbanFeedbackFromKanban(evt);
          }
          if (typeof window.refreshConversationKanbanWidget === 'function') {
            window.refreshConversationKanbanWidget(originConvId || null);
          }
          // Any structural change (move/claim/comment/etc.) implicitly
          // clears the idle banner — the upcoming fetch will overwrite it.
          refreshKanbanBoard();
        } catch (_) {}
      };
      s.sse.onerror = function() { /* browser auto-reconnects */ };
    } catch (_) { /* no SSE — board still works without live updates */ }
  }

  // ── Live task viewer ───────────────────────────────────────────────────
  // Lightweight panel that streams what an autopilot-spawned task is
  // currently doing: model, elapsed time, step counter, and the per-step
  // chain-of-reasoning (intent → actions → outcome).
  var _liveState = { taskId: null, cardId: null, sse: null, host: null, lastStepIds: new Set() };

  function _liveEnsureHost() {
    if (_liveState.host && document.body.contains(_liveState.host)) return _liveState.host;
    var h = document.createElement('div');
    h.id = 'kb-live-host';
    h.innerHTML =
      '<div class="kb-live-backdrop" onclick="closeLiveTaskPanel()"></div>' +
      '<aside class="kb-live-panel" role="dialog" aria-label="Live task viewer">' +
        '<div class="kb-live-resize" role="separator" aria-orientation="vertical" aria-label="Resize panel" title="Drag to resize"></div>' +
        '<header class="kb-live-head">' +
          '<div class="kb-live-head-main">' +
            '<div class="kb-live-title"><span class="kb-live-dot"></span> <span id="kb-live-title-text">Live task</span></div>' +
            '<div class="kb-live-sub" id="kb-live-sub">Connecting…</div>' +
          '</div>' +
          '<button class="kb-icon-btn" onclick="closeLiveTaskPanel()" title="Close"><i class="ti ti-x"></i></button>' +
        '</header>' +
        '<div class="kb-live-meta" id="kb-live-meta"></div>' +
        '<div class="kb-live-stream" id="kb-live-stream"><div class="kb-live-empty">Waiting for the first step…</div></div>' +
        '<footer class="kb-live-foot">' +
          '<button class="kb-btn danger" onclick="kbLiveStop()" title="Tell the task-runner to stop this task"><i class="ti ti-player-stop"></i> Stop run</button>' +
          '<button class="kb-btn" onclick="kbLiveSteer()" title="Inject a steering message — the next iteration will see it"><i class="ti ti-message-2-share"></i> Steer</button>' +
        '</footer>' +
      '</aside>';
    document.body.appendChild(h);
    _liveState.host = h;
    _liveAttachResize(h);
    return h;
  }

  // Click-drag the left edge of the drawer to resize. Persists the width
  // to localStorage so the user's preference survives across opens.
  var KB_LIVE_WIDTH_KEY = 'fauna.kbLivePanelWidth';
  function _liveClampWidth(px) {
    var vw = window.innerWidth || 1024;
    var min = 320;
    var max = Math.max(min + 80, Math.floor(vw * 0.95));
    if (px < min) return min;
    if (px > max) return max;
    return px;
  }
  function _liveApplyWidth(px) {
    var panel = _liveState.host && _liveState.host.querySelector('.kb-live-panel');
    if (!panel) return;
    panel.style.setProperty('--kb-live-width', px + 'px');
  }
  function _liveAttachResize(host) {
    // Restore persisted width before the first paint so the panel slides
    // in at the user's chosen size rather than the default.
    try {
      var saved = parseInt(localStorage.getItem(KB_LIVE_WIDTH_KEY) || '', 10);
      if (saved > 0) _liveApplyWidth(_liveClampWidth(saved));
    } catch (_) {}
    var handle = host.querySelector('.kb-live-resize');
    if (!handle) return;
    var dragging = false;
    function onDown(e) {
      dragging = true;
      host.classList.add('kb-live-resizing');
      // Disable text selection while dragging.
      document.body.style.userSelect = 'none';
      e.preventDefault();
    }
    function onMove(e) {
      if (!dragging) return;
      // Panel is anchored to the right edge of the viewport, so width is
      // distance from cursor X to the right edge.
      var x = e.clientX != null ? e.clientX
            : (e.touches && e.touches[0] ? e.touches[0].clientX : null);
      if (x == null) return;
      var vw = window.innerWidth || 1024;
      var width = _liveClampWidth(vw - x);
      _liveApplyWidth(width);
    }
    function onUp() {
      if (!dragging) return;
      dragging = false;
      host.classList.remove('kb-live-resizing');
      document.body.style.userSelect = '';
      // Persist current width.
      try {
        var panel = host.querySelector('.kb-live-panel');
        if (panel) {
          var w = parseInt(panel.style.getPropertyValue('--kb-live-width'), 10);
          if (w > 0) localStorage.setItem(KB_LIVE_WIDTH_KEY, String(w));
        }
      } catch (_) {}
    }
    handle.addEventListener('mousedown', onDown);
    handle.addEventListener('touchstart', onDown, { passive: false });
    window.addEventListener('mousemove', onMove);
    window.addEventListener('touchmove', onMove, { passive: false });
    window.addEventListener('mouseup', onUp);
    window.addEventListener('touchend', onUp);
    window.addEventListener('touchcancel', onUp);
  }

  function _liveFmtElapsed(ms) {
    if (!ms || ms < 0) return '0s';
    var s = Math.floor(ms / 1000);
    if (s < 60) return s + 's';
    var m = Math.floor(s / 60); s = s % 60;
    if (m < 60) return m + 'm ' + s + 's';
    var h = Math.floor(m / 60); m = m % 60;
    return h + 'h ' + m + 'm';
  }

  function _liveRenderHead(snap) {
    var titleEl = document.getElementById('kb-live-title-text');
    var subEl   = document.getElementById('kb-live-sub');
    var metaEl  = document.getElementById('kb-live-meta');
    if (!titleEl || !subEl || !metaEl) return;
    titleEl.textContent = snap.title || 'Task';
    var status = snap.running ? 'Running' : (snap.status || 'finished');
    var statusCls = snap.running ? 'kb-live-status-running'
                   : (snap.status === 'failed' ? 'kb-live-status-failed' : 'kb-live-status-done');
    subEl.innerHTML =
      '<span class="kb-live-status ' + statusCls + '">' + _esc(status) + '</span>' +
      ' &middot; step <strong>' + (snap.step || 0) + '</strong>' +
      ' &middot; ' + _liveFmtElapsed(snap.elapsedMs || 0);
    var stats = snap.stats || {};
    metaEl.innerHTML =
      '<div class="kb-live-meta-row"><i class="ti ti-cpu"></i> <span>Model</span><code>' + _esc(snap.model || 'default') + '</code></div>' +
      (snap.agents && snap.agents.length
        ? '<div class="kb-live-meta-row"><i class="ti ti-robot"></i> <span>Agent</span><code>' + _esc(snap.agents.join(', ')) + '</code></div>'
        : '') +
      '<div class="kb-live-meta-row"><i class="ti ti-bolt"></i> <span>Actions</span>' +
        '<span class="kb-live-stat-num">' + (stats.actionsTotal || 0) + '</span>' +
        ' <span class="kb-live-stat-ok">' + (stats.actionsOk || 0) + ' ok</span>' +
        ' <span class="kb-live-stat-fail">' + (stats.actionsFailed || 0) + ' fail</span>' +
      '</div>';
  }

  function _liveAppendEntry(entry) {
    var stream = document.getElementById('kb-live-stream');
    if (!stream || !entry) return;
    var key = 'step-' + entry.step;
    if (_liveState.lastStepIds.has(key)) {
      // Update existing node in case actions/outcome came in later.
      var existing = stream.querySelector('[data-step="' + entry.step + '"]');
      if (existing) existing.outerHTML = _liveStepHtml(entry);
      return;
    }
    var empty = stream.querySelector('.kb-live-empty');
    if (empty) empty.remove();
    _liveState.lastStepIds.add(key);
    stream.insertAdjacentHTML('beforeend', _liveStepHtml(entry));
    stream.scrollTop = stream.scrollHeight;
  }

  function _liveStepHtml(entry) {
    var actions = (entry.actions || []).map(function(a) {
      var ico = a.ok === false ? 'ti-x' : 'ti-check';
      var cls = a.ok === false ? 'kb-live-action-fail' : 'kb-live-action-ok';
      return '<li class="' + cls + '"><i class="ti ' + ico + '"></i> ' +
        '<span class="kb-live-action-type">' + _esc(a.type || 'action') + '</span> ' +
        '<span class="kb-live-action-detail">' + _esc((a.action || '').slice(0, 200)) + '</span></li>';
    }).join('');
    return '<div class="kb-live-step" data-step="' + entry.step + '">' +
      '<div class="kb-live-step-head">' +
        '<span class="kb-live-step-no">Step ' + entry.step + '</span>' +
        (entry.outcome ? '<span class="kb-live-step-outcome">' + _esc(entry.outcome) + '</span>' : '') +
      '</div>' +
      (entry.intent
        ? '<div class="kb-live-step-intent">' + _esc(String(entry.intent).slice(0, 600)) + '</div>'
        : '') +
      (actions ? '<ul class="kb-live-step-actions">' + actions + '</ul>' : '') +
    '</div>';
  }

  // Render the model's in-progress output as a soft, scrolling preview at
  // the top of the stream. Replaced/updated on every partial event; cleared
  // once the step finishes (reasoning entry arrives) or a new step starts.
  function _liveRenderPartial(step, content, length) {
    var stream = document.getElementById('kb-live-stream');
    if (!stream) return;
    // Drop the empty-state placeholder once we have anything to show.
    var empty = stream.querySelector('.kb-live-empty');
    if (empty) empty.remove();
    var el = document.getElementById('kb-live-partial');
    if (!el) {
      el = document.createElement('div');
      el.id = 'kb-live-partial';
      el.className = 'kb-live-step kb-live-step-partial';
      stream.insertBefore(el, stream.firstChild);
    }
    var lenLabel = (typeof length === 'number' && length > content.length)
      ? ' · ' + length + ' chars so far'
      : '';
    el.innerHTML =
      '<div class="kb-live-step-head">' +
        '<span class="kb-live-step-num">STEP ' + (step || '?') + '</span>' +
        '<span class="kb-live-step-outcome kb-live-step-streaming">' +
          '<span class="kb-live-dot"></span> streaming' + lenLabel +
        '</span>' +
      '</div>' +
      '<pre class="kb-live-partial-body">' + _esc(String(content || '')) + '</pre>';
  }

  function _liveClearPartial() {
    var el = document.getElementById('kb-live-partial');
    if (el) el.remove();
  }

  function _liveSubscribe(taskId) {
    if (_liveState.sse) { try { _liveState.sse.close(); } catch (_) {} }
    try {
      var es = new EventSource('/api/tasks/stream');
      es.onmessage = function(ev) {
        try {
          var msg = JSON.parse(ev.data);
          // Server publishes flat events shaped { taskId, event, ...payload }.
          if (!msg || msg.taskId !== taskId) return;
          if (msg.event === 'reasoning' && msg.entry) {
            // A step finished — clear any in-progress partial preview
            // since the entry now reflects the completed step.
            _liveClearPartial();
            _liveAppendEntry(msg.entry);
          } else if (msg.event === 'partial' && msg.content) {
            // Streaming token deltas from the model's current chat call.
            // Render in-place so the panel never sits idle while the
            // model is producing output.
            _liveRenderPartial(msg.step, msg.content, msg.length);
          } else if (msg.event === 'step') {
            // New step starting — reset partial preview.
            _liveClearPartial();
            _liveRefreshSnapshot(taskId);
          } else if (msg.event === 'completed' || msg.event === 'failed') {
            _liveClearPartial();
            _liveRefreshSnapshot(taskId);
          }
        } catch (_) {}
      };
      es.onerror = function() { /* browser auto-reconnects */ };
      _liveState.sse = es;
    } catch (_) {}
  }

  function _liveRefreshSnapshot(taskId) {
    fetch('/api/tasks/' + encodeURIComponent(taskId) + '/live')
      .then(function(r) { return r.ok ? r.json() : Promise.reject(new Error('HTTP ' + r.status)); })
      .then(function(snap) {
        if (!snap || snap.taskId !== _liveState.taskId) return; // user closed/switched
        _liveRenderHead(snap);
        // Replay any entries we missed (e.g. opened after task already ran).
        (snap.reasoning || []).forEach(_liveAppendEntry);
        // If we got the snapshot back but the reasoning array is empty,
        // the placeholder needs to say something useful — not "Loading…"
        // which makes the user think the network is stuck. The model is
        // probably mid-thinking on step 1 (chat call can take 30-90 s).
        _liveSetEmptyMessage(snap);
      })
      .catch(function(e) {
        var sub = document.getElementById('kb-live-sub');
        if (sub) sub.textContent = 'Lost connection: ' + e.message;
        var stream = document.getElementById('kb-live-stream');
        var empty = stream && stream.querySelector('.kb-live-empty');
        if (empty) empty.textContent = 'Failed to load: ' + e.message;
      });
  }

  // Update the empty-state placeholder based on what the snapshot tells us.
  // Most common case: task is running, step ≥ 1, but the model hasn't
  // produced its first response yet so reasoning is still empty. We make
  // that explicit instead of saying "Loading…".
  function _liveSetEmptyMessage(snap) {
    var stream = document.getElementById('kb-live-stream');
    if (!stream) return;
    var empty = stream.querySelector('.kb-live-empty');
    if (!empty) return; // first real entry already replaced it
    if (snap.running) {
      empty.innerHTML =
        '<div style="font-weight:600;margin-bottom:4px;">Model is thinking…</div>' +
        '<div style="opacity:.75;font-size:11px;">' +
          'No reasoning step has finished yet. First responses can take 30–90s ' +
          'depending on the model. This panel updates live the moment the ' +
          'first step completes.' +
        '</div>';
    } else if (snap.interrupted) {
      empty.innerHTML =
        '<div style="font-weight:600;margin-bottom:4px;">Run was interrupted</div>' +
        '<div style="opacity:.75;font-size:11px;">' +
          'The task died before producing any reasoning steps ' +
          '(likely killed during the first chat call). The card has been ' +
          'returned to Todo for a fresh attempt.' +
        '</div>';
    } else {
      empty.textContent = 'No reasoning recorded for this run.';
    }
  }

  window.openLiveTaskPanel = function(taskId, cardId) {
    if (!taskId) return;
    var host = _liveEnsureHost();
    host.classList.add('open');
    _liveState.taskId = taskId;
    _liveState.cardId = cardId || null;
    _liveState.lastStepIds = new Set();
    var stream = document.getElementById('kb-live-stream');
    if (stream) stream.innerHTML = '<div class="kb-live-empty">Connecting…</div>';
    _liveRefreshSnapshot(taskId);
    _liveSubscribe(taskId);
  };

  window.closeLiveTaskPanel = function() {
    if (_liveState.sse) { try { _liveState.sse.close(); } catch (_) {} _liveState.sse = null; }
    if (_liveState.host) _liveState.host.classList.remove('open');
    _liveState.taskId = null;
    _liveState.cardId = null;
  };

  window.kbLiveStop = function() {
    if (!_liveState.taskId) return;
    if (!confirm('Stop this task? The card will bounce back to Todo.')) return;
    fetch('/api/tasks/' + encodeURIComponent(_liveState.taskId) + '/stop', { method: 'POST' })
      .then(function(r) { return r.ok ? r.json() : Promise.reject(new Error('HTTP ' + r.status)); })
      .then(function() { _toast('Stop signal sent'); })
      .catch(function(e) { _toast('Stop failed: ' + e.message, true); });
  };

  window.kbLiveSteer = function() {
    if (!_liveState.taskId) return;
    var taskId = _liveState.taskId;
    // window.prompt() throws in Electron — use the existing _projPrompt
    // modal helper from projects.js (script-global) instead. Falls back to
    // window.prompt only if the helper isn't loaded (e.g. board opened
    // outside the main app shell).
    var ask = (typeof _projPrompt === 'function')
      ? _projPrompt({
          title: 'Steer the model',
          label: 'What should the model do next? The next iteration will see this message.',
          placeholder: 'e.g. "Skip the verification step and move straight to PR"',
          submit: 'Send',
          multiline: true,
        })
      : Promise.resolve(window.prompt('Steering message:'));

    Promise.resolve(ask).then(function(msg) {
      if (!msg || !String(msg).trim()) return;
      return fetch('/api/tasks/' + encodeURIComponent(taskId) + '/steer', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: String(msg).slice(0, 2000) }),
      }).then(function(r) { return r.ok ? r.json() : Promise.reject(new Error('HTTP ' + r.status)); })
        .then(function() { _toast('Steering message queued'); });
    }).catch(function(e) { _toast('Steer failed: ' + e.message, true); });
  };

  // ── Exports ────────────────────────────────────────────────────────────
  window.renderKanbanBoard = renderKanbanBoard;
  window.refreshKanbanBoard = refreshKanbanBoard;

  // ── Global Board panel toggle (sidebar entry) ─────────────────────────
  // Lives here so board.js owns its panel lifecycle. The panel element is
  // defined in index.html as #board-panel. We tear down the SSE + DOM on
  // close so the next open starts clean.
  var _boardPanelOpen = false;
  function toggleBoardPanel() {
    var panel = document.getElementById('board-panel');
    var body  = document.getElementById('board-panel-body');
    if (!panel || !body) return;
    if (_boardPanelOpen) {
      closeBoardPanelPage();
      if (typeof closeAppPage === 'function') closeAppPage();
    } else {
      // Close the automations panel if it was also open so we don't stack.
      if (typeof closeTasksPanelPage === 'function') closeTasksPanelPage();
      _boardPanelOpen = true;
      var pageBody = typeof _openAppPage === 'function' ? _openAppPage('board', 'Board') : null;
      if (pageBody) {
        pageBody.innerHTML = '';
        pageBody.appendChild(panel);
      }
      panel.classList.add('open');
      try { renderKanbanBoard({ scope: 'global' }, body); }
      catch (e) {
        body.innerHTML = '<div style="padding:20px;color:var(--fau-text-dim)">Board failed to load: ' +
          (e && e.message ? e.message : 'unknown error') + '</div>';
      }
    }
  }
  function closeBoardPanelPage() {
    if (!_boardPanelOpen) return;
    _boardPanelOpen = false;
    var panel = document.getElementById('board-panel');
    var body  = document.getElementById('board-panel-body');
    if (panel) panel.classList.remove('open');
    var s = window._kbState;
    if (s && s.sse) { try { s.sse.close(); } catch (_) {} s.sse = null; }
    if (body) body.innerHTML = '';
  }
  window.toggleBoardPanel = toggleBoardPanel;
  window.closeBoardPanelPage = closeBoardPanelPage;
})();
