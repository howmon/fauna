// ── Projects Frontend ─────────────────────────────────────────────────────
// Handles the full Projects UI: switcher pill, hub panel, file tree,
// contexts list, sources management, connectors, and integration with tasks.

// ── Helpers ──────────────────────────────────────────────────────────────

function _projEsc(s) { return String(s || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }

function _activeProject() {
  return state.projects.find(function(p) { return p.id === state.activeProjectId; }) || null;
}

var _projectTaskMetricsCache = Object.create(null);
var _projectTaskMetricsInflight = Object.create(null);

function _projectKanbanColumnProgress(column) {
  var map = { backlog: 0, todo: 0, in_progress: 55, review: 85, done: 100, archived: 100 };
  return Object.prototype.hasOwnProperty.call(map, column) ? map[column] : 0;
}

function _computeProjectTaskMetrics(columns) {
  columns = columns || {};
  var counts = {
    backlog: Array.isArray(columns.backlog) ? columns.backlog.length : 0,
    todo: Array.isArray(columns.todo) ? columns.todo.length : 0,
    inProgress: Array.isArray(columns.in_progress) ? columns.in_progress.length : 0,
    review: Array.isArray(columns.review) ? columns.review.length : 0,
    done: Array.isArray(columns.done) ? columns.done.length : 0,
    archived: Array.isArray(columns.archived) ? columns.archived.length : 0,
  };
  var total = counts.backlog + counts.todo + counts.inProgress + counts.review + counts.done;
  var started = counts.inProgress + counts.review + counts.done;
  var progressPoints =
    (counts.backlog * _projectKanbanColumnProgress('backlog')) +
    (counts.todo * _projectKanbanColumnProgress('todo')) +
    (counts.inProgress * _projectKanbanColumnProgress('in_progress')) +
    (counts.review * _projectKanbanColumnProgress('review')) +
    (counts.done * _projectKanbanColumnProgress('done'));
  var completionPct = total ? Math.round(progressPoints / total) : 0;
  return {
    counts: counts,
    total: total,
    done: counts.done,
    started: started,
    completionPct: completionPct,
  };
}

function _projectBoardColumnsFromBacklog(backlog) {
  var columns = {
    backlog: [],
    todo: [],
    in_progress: [],
    review: [],
    done: [],
    archived: [],
  };
  var statusToColumn = {
    'new': 'backlog',
    'groomed': 'todo',
    'in-progress': 'in_progress',
    'done': 'done',
    'dropped': 'archived',
  };
  (backlog || []).forEach(function(it) {
    var col = (it && it.column) || statusToColumn[it && it.status] || 'backlog';
    if (!columns[col]) col = 'backlog';
    columns[col].push(it);
  });
  return columns;
}

function _projectTaskMetricsFromProject(project) {
  if (!project || !Array.isArray(project.backlog)) return null;
  return _computeProjectTaskMetrics(_projectBoardColumnsFromBacklog(project.backlog));
}

function _getProjectTaskMetrics(projectId) {
  if (_projectTaskMetricsCache[projectId]) return _projectTaskMetricsCache[projectId];
  var project = (state.projects || []).find(function(p) { return p.id === projectId; });
  var fromProject = _projectTaskMetricsFromProject(project);
  if (fromProject) {
    _projectTaskMetricsCache[projectId] = fromProject;
    return fromProject;
  }
  return null;
}

function _projectTaskAnalyticsLabel(metrics) {
  if (!metrics) return 'No tasks';
  if (!metrics.total) return 'No tasks';
  var progressed = typeof metrics.started === 'number' ? metrics.started : metrics.done;
  return metrics.completionPct + '% · ' + progressed + '/' + metrics.total;
}

async function refreshProjectTaskMetrics(projectId, opts) {
  opts = opts || {};
  if (!projectId) return null;
  if (_projectTaskMetricsInflight[projectId]) return _projectTaskMetricsInflight[projectId];
  _projectTaskMetricsInflight[projectId] = (async function() {
    try {
      var r = await fetch('/api/projects/' + projectId + '/board');
      if (!r.ok) return _getProjectTaskMetrics(projectId);
      var board = await r.json();
      var metrics = _computeProjectTaskMetrics(board && board.columns);
      _projectTaskMetricsCache[projectId] = metrics;
      if (!opts.silent) {
        renderProjectSidebarList();
        if (typeof renderConvList === 'function') renderConvList();
        var page = document.getElementById('all-projects-page');
        if (page && page.style.display !== 'none') _renderAllProjectsPage();
      }
      return metrics;
    } catch (_) {
      return _getProjectTaskMetrics(projectId);
    } finally {
      delete _projectTaskMetricsInflight[projectId];
    }
  })();
  return _projectTaskMetricsInflight[projectId];
}

function getProjectTaskAnalyticsInlineHtml(projectId, opts) {
  opts = opts || {};
  var metrics = _getProjectTaskMetrics(projectId);
  if (!metrics || !metrics.total) return '';
  var label = _projEsc(_projectTaskAnalyticsLabel(metrics));
  var cls = 'proj-task-analytics-pill' + (opts.compact ? ' compact' : '');
  var attr = opts.clickable === false
    ? ''
    : ' onclick="openProjectTaskboard(\'' + _projEsc(projectId) + '\', event)" title="Open taskboard"';
  return '<button type="button" class="' + cls + '"' + attr + '><i class="ti ti-layout-kanban"></i><span>' + label + '</span></button>';
}

async function openProjectTaskboard(projectId, e) {
  if (e && typeof e.stopPropagation === 'function') e.stopPropagation();
  if (!projectId) return;
  await setActiveProject(projectId, { navigate: false });
  openProjectHub('tasks');
}

window.openProjectTaskboard = openProjectTaskboard;
window.getProjectTaskAnalyticsInlineHtml = getProjectTaskAnalyticsInlineHtml;
window.refreshProjectTaskMetrics = refreshProjectTaskMetrics;

function _startProjectTaskMetricsRealtime() {
  if (!window.EventSource || window._projectTaskMetricsEvents) return;
  try {
    var url = window.faunaStreamUrl ? window.faunaStreamUrl('/api/board/stream') : '/api/board/stream';
    var source = new EventSource(url);
    window._projectTaskMetricsEvents = source;
    source.onmessage = function(ev) {
      try {
        var evt = JSON.parse(ev.data);
        if (!evt || evt.type === 'ping' || evt.type === 'hello' || evt.type === 'idle') return;
        var projectId = evt.projectId || (evt.item && evt.item.projectId) || null;
        if (projectId) refreshProjectTaskMetrics(projectId);
      } catch (_) {}
    };
    source.onerror = function() {
      try { source.close(); } catch (_) {}
      window._projectTaskMetricsEvents = null;
      setTimeout(_startProjectTaskMetricsRealtime, 2500);
    };
  } catch (_) {}
}

// ── Load / Persist ────────────────────────────────────────────────────────

async function loadProjects() {
  try {
    var r = await fetch('/api/projects');
    if (!r.ok) return;
    state.projects = await r.json();
    _projectTaskMetricsCache = Object.create(null);
    // Validate stored active project still exists
    if (state.activeProjectId && !state.projects.find(function(p) { return p.id === state.activeProjectId; })) {
      state.activeProjectId = null;
      localStorage.removeItem('fauna-active-project');
    }
  } catch (e) {
    console.warn('[projects] load failed', e);
  }
  renderProjectSwitcher();
  renderProjectSidebarList();
  renderProjectContextBar();
  updateProjectIndicator();
  (state.projects || []).forEach(function(p) { refreshProjectTaskMetrics(p.id); });
  _startProjectTaskMetricsRealtime();
}

async function _refreshProject(id) {
  try {
    var r = await fetch('/api/projects/' + id);
    if (!r.ok) return;
    var updated = await r.json();
    var idx = state.projects.findIndex(function(p) { return p.id === id; });
    if (idx !== -1) state.projects[idx] = updated;
    else state.projects.push(updated);
  } catch(e) {}
}

// ── Project Sidebar Tree ──────────────────────────────────────────────────
// Each project renders as a collapsible folder containing its conversations.
// Folders are collapsed by default except the active project; the user's manual
// expand/collapse choices are remembered per-project in localStorage.

var _expandedProjects = (function() {
  try { return JSON.parse(localStorage.getItem('fauna-proj-expanded') || '{}') || {}; }
  catch (e) { return {}; }
})();

function _saveExpandedProjects() {
  try { localStorage.setItem('fauna-proj-expanded', JSON.stringify(_expandedProjects)); } catch (e) {}
}

function _isProjectExpanded(id) {
  // Explicit user choice wins; otherwise only the active project is open.
  if (Object.prototype.hasOwnProperty.call(_expandedProjects, id)) return !!_expandedProjects[id];
  return id === state.activeProjectId;
}

function toggleProjectFolder(id, e) {
  if (e) e.stopPropagation();
  _expandedProjects[id] = !_isProjectExpanded(id);
  _saveExpandedProjects();
  renderProjectSidebarList();
}

// Open a new chat inside a project without leaving the current view chrome.
function newConversationInProject(id, e) {
  if (e) e.stopPropagation();
  _expandedProjects[id] = true;
  _saveExpandedProjects();
  if (state.activeProjectId !== id) setActiveProject(id, { navigate: false });
  if (typeof newConversation === 'function') newConversation();
}

// ── Breadcrumb chevron popover ────────────────────────────────────────────
// Click the `>` between the project name and chat title to get a quick menu
// of every conversation in the active project, plus a "New chat" button.
// Replaces the previous behaviour where the chevron was decorative-only.
function _closeBreadcrumbChevronMenu() {
  var existing = document.getElementById('crumb-chev-menu');
  if (existing) existing.remove();
  document.removeEventListener('mousedown', _crumbChevMenuOutside, true);
  document.removeEventListener('keydown', _crumbChevMenuEscape, true);
}
function _crumbChevMenuOutside(e) {
  var menu = document.getElementById('crumb-chev-menu');
  if (!menu) return;
  var sep = document.getElementById('topbar-crumb-sep');
  if (menu.contains(e.target)) return;
  if (sep && sep.contains(e.target)) return;
  _closeBreadcrumbChevronMenu();
}
function _crumbChevMenuEscape(e) {
  if (e.key === 'Escape') _closeBreadcrumbChevronMenu();
}
function toggleBreadcrumbChevronMenu(e) {
  if (e) e.stopPropagation();
  if (document.getElementById('crumb-chev-menu')) { _closeBreadcrumbChevronMenu(); return; }
  var proj = _activeProject();
  if (!proj) return; // chevron only appears when a project is active anyway
  var anchor = document.getElementById('topbar-crumb-sep');
  if (!anchor) return;
  var rect = anchor.getBoundingClientRect();

  var allConvs = (state.conversations || [])
    .filter(function(c) { return c.projectId === proj.id; })
    .sort(function(a, b) {
      return (b.updatedAt || b.createdAt || 0) - (a.updatedAt || a.createdAt || 0);
    });
  var MAX = 12;
  var visible = allConvs.slice(0, MAX);
  var pid = _projEsc(proj.id);

  var rows = visible.map(function(c) {
    var isCurrent = c.id === state.currentId;
    return '<button type="button" class="crumb-chev-conv' + (isCurrent ? ' active' : '') + '" ' +
      'onclick="loadConversation(\'' + c.id + '\');_closeBreadcrumbChevronMenu()">' +
      (c._streaming ? '<i class="ti ti-loader-2 conv-streaming-icon"></i>' : '<i class="ti ti-message"></i>') +
      '<span class="crumb-chev-conv-title">' + escHtml(c.title || 'Untitled') + '</span>' +
    '</button>';
  }).join('') || '<div class="crumb-chev-empty">No chats in this project yet</div>';

  var moreLink = allConvs.length > MAX
    ? '<button type="button" class="crumb-chev-more" onclick="openAllConversations(\'' + pid + '\');_closeBreadcrumbChevronMenu()">' +
        '<i class="ti ti-list"></i><span>All chats (' + allConvs.length + ')</span>' +
      '</button>'
    : '';

  var menu = document.createElement('div');
  menu.id = 'crumb-chev-menu';
  menu.className = 'crumb-chev-menu';
  menu.innerHTML =
    '<div class="crumb-chev-header">' +
      '<span class="proj-dot proj-color-' + _projEsc(proj.color) + '"></span>' +
      '<span class="crumb-chev-proj-name">' + _projEsc(proj.name) + '</span>' +
      '<button type="button" class="crumb-chev-new" onclick="newConversationInProject(\'' + pid + '\', event);_closeBreadcrumbChevronMenu()" title="New chat in project">' +
        '<i class="ti ti-edit"></i><span>New chat</span>' +
      '</button>' +
    '</div>' +
    '<div class="crumb-chev-list">' + rows + '</div>' +
    (moreLink ? '<div class="crumb-chev-footer">' + moreLink + '</div>' : '');
  document.body.appendChild(menu);

  // Position under the chevron, clamped to viewport
  var left = Math.max(8, Math.min(rect.left - 8, window.innerWidth - 320));
  menu.style.left = left + 'px';
  menu.style.top  = (rect.bottom + 6) + 'px';

  // Outside-click + Escape close
  setTimeout(function() {
    document.addEventListener('mousedown', _crumbChevMenuOutside, true);
    document.addEventListener('keydown', _crumbChevMenuEscape, true);
  }, 0);
}

function renderProjectSidebarList() {
  var el = document.getElementById('proj-sidebar-list');
  if (!el) return;
  var MAX = 8;
  var MAX_CONVS = 6;
  // Sort: ACTIVE project always pinned at the top, then everything else by
  // most-recently-active. The active pin makes Activate clicks visually
  // unambiguous — the project jumps to row 0 immediately, irrespective of
  // race conditions between the local lastActiveAt bump and a slower server
  // /touch round-trip.
  var activeId = state.activeProjectId || null;
  var projects = (state.projects || []).slice().sort(function(a, b) {
    if (activeId) {
      if (a.id === activeId) return -1;
      if (b.id === activeId) return 1;
    }
    return (b.lastActiveAt || 0) > (a.lastActiveAt || 0) ? 1 : -1;
  });
  var visible = projects.slice(0, MAX);
  var allConvs = state.conversations || [];

  el.innerHTML = visible.map(function(p) {
    var isActive = p.id === state.activeProjectId;
    var expanded = _isProjectExpanded(p.id);
    var pid = _projEsc(p.id);
    var projConvs = allConvs.filter(function(c) { return c.projectId === p.id; });
    var anyStreaming = projConvs.some(function(c) { return c._streaming; });

    var header = '<div class="proj-folder-header' + (isActive ? ' active' : '') + '" onclick="toggleProjectFolder(\'' + pid + '\', event)">' +
      '<i class="ti ti-chevron-right proj-folder-chevron"></i>' +
      '<span class="proj-dot proj-color-' + _projEsc(p.color) + '"></span>' +
      '<span class="proj-folder-name">' + _projEsc(p.name) + '</span>' +
      (anyStreaming ? '<i class="ti ti-loader-2 conv-streaming-icon proj-folder-streaming" title="A chat in this project is running"></i>' : '') +
      '<span class="proj-folder-trailing">' +
        '<span class="proj-folder-analytics">' + getProjectTaskAnalyticsInlineHtml(p.id, { compact: true }) + '</span>' +
        '<span class="proj-folder-actions">' +
          '<button class="proj-sidebar-hub-btn" onclick="event.stopPropagation();newConversationInProject(\'' + pid + '\', event)" title="New chat in project"><i class="ti ti-edit"></i></button>' +
          '<button class="proj-sidebar-hub-btn" onclick="event.stopPropagation();setActiveProject(\'' + pid + '\', { navigate: false });openProjectHub()" title="Open hub"><i class="ti ti-layout-sidebar-right-expand"></i></button>' +
          '<button class="proj-sidebar-del-btn" onclick="event.stopPropagation();_confirmDeleteProjectFromList(\'' + pid + '\')" title="Delete project"><i class="ti ti-trash"></i></button>' +
        '</span>' +
      '</span>' +
    '</div>';

    var body = '';
    if (expanded) {
      var convs = projConvs;
      var rows = convs.slice(0, MAX_CONVS).map(function(c) {
        return (typeof _convRowHtml === 'function') ? _convRowHtml(c) : '';
      }).join('');
      if (!convs.length) rows = '<div class="proj-folder-empty">No chats yet</div>';
      var more = convs.length > MAX_CONVS
        ? '<div class="proj-folder-showall" onclick="event.stopPropagation();setActiveProject(\'' + pid + '\', { navigate: false });openAllConversations(\'' + pid + '\')">All chats (' + convs.length + ')</div>'
        : '';
      body = '<div class="proj-folder-body">' + rows + more + '</div>';
    }

    return '<div class="proj-folder' + (isActive ? ' active' : '') + (expanded ? ' expanded' : '') + '" data-proj-id="' + pid + '">' + header + body + '</div>';
  }).join('') || '<div class="proj-sidebar-empty">No projects yet</div>';

  var showAll = document.getElementById('proj-show-all');
  if (showAll) showAll.style.display = projects.length > MAX ? '' : 'none';
}

// ── All Projects Page ─────────────────────────────────────────────────────

function openAllProjects() {
  var page = document.getElementById('all-projects-page');
  if (!page) return;
  if (typeof closeAppPage === 'function') closeAppPage();
  if (typeof setAppRailActive === 'function') setAppRailActive('projects');
  page._filter = '';
  page.style.display = 'flex';
  _renderAllProjectsPage();
  if (typeof _openOverlayStrip === 'function') _openOverlayStrip('All Projects');
}

function closeAllProjects() {
  var page = document.getElementById('all-projects-page');
  if (page) page.style.display = 'none';
  if (typeof _closeOverlayStrip === 'function') _closeOverlayStrip();
  if (typeof setAppRailActive === 'function') setAppRailActive('');
}

async function _dedupeAllProjects() {
  if (!await _projConfirm('Remove projects with duplicate names? The oldest of each name is kept; the rest are deleted. This cannot be undone.')) return;
  try {
    var r = await fetch('/api/projects/dedupe', { method: 'POST' });
    if (!r.ok) throw new Error((await r.json().catch(function(){return{};})).error || 'Failed');
    var j = await r.json();
    var deletedIds = (j && j.deleted) || [];
    if (deletedIds.length) {
      // Drop deleted from local state
      state.projects = (state.projects || []).filter(function(p) { return deletedIds.indexOf(p.id) === -1; });
      // If the active project was deleted, clear it
      if (state.activeProjectId && deletedIds.indexOf(state.activeProjectId) !== -1) {
        await setActiveProject(null);
      }
    }
    _renderAllProjectsPage();
    renderProjectSidebarList();
    _showToast('Removed ' + deletedIds.length + ' duplicate project' + (deletedIds.length === 1 ? '' : 's'));
  } catch (e) { _showToast('Error: ' + e.message, true); }
}

function _renderAllProjectsPage() {
  var page = document.getElementById('all-projects-page');
  if (!page) return;
  var filter = (page._filter || '').toLowerCase();
  var projects = (state.projects || []).slice().sort(function(a, b) {
    return (b.lastActiveAt || 0) > (a.lastActiveAt || 0) ? 1 : -1;
  });
  if (filter) projects = projects.filter(function(p) { return p.name.toLowerCase().includes(filter) || (p.description || '').toLowerCase().includes(filter); });

  var listEl = document.getElementById('all-projects-list-body');
  if (!listEl) {
    // First render — build shell
    page.innerHTML =
      '<div class="all-agents-page-inner">' +
        '<div class="all-agents-header">' +
          '<div class="all-agents-title"><i class="ti ti-folders"></i> All Projects</div>' +
          '<div class="all-agents-search-wrap">' +
            '<i class="ti ti-search"></i>' +
            '<input class="all-agents-search" id="all-projects-search" placeholder="Search projects…" oninput="document.getElementById(\'all-projects-page\')._filter=this.value;_renderAllProjectsPage()">' +
          '</div>' +
          '<button class="proj-action-btn" onclick="openCreateProjectDialog()"><i class="ti ti-plus"></i> New project</button>' +
          '<button class="proj-action-btn" onclick="_dedupeAllProjects()" title="Remove projects with duplicate names (keeps the oldest)"><i class="ti ti-broom"></i> Remove duplicates</button>' +
          '<button class="all-agents-close" onclick="closeAllProjects()"><i class="ti ti-x"></i></button>' +
        '</div>' +
        '<div id="all-projects-list-body" class="all-projects-list"></div>' +
      '</div>';
    listEl = document.getElementById('all-projects-list-body');
  }

  if (!projects.length) {
    listEl.innerHTML = '<div class="proj-hub-empty" style="padding:40px"><i class="ti ti-folders" style="font-size:28px;opacity:.3"></i><div>No projects yet</div></div>';
    return;
  }

  var header =
    '<div class="all-proj-row all-proj-row-head">' +
      '<span class="all-proj-col-name">Project</span>' +
      '<span class="all-proj-col-desc">Description</span>' +
      '<span class="all-proj-col-num" title="Sources"><i class="ti ti-source-code"></i></span>' +
      '<span class="all-proj-col-num" title="Conversations"><i class="ti ti-messages"></i></span>' +
      '<span class="all-proj-col-num all-proj-col-analytics" title="Task completion"><i class="ti ti-chart-pie"></i></span>' +
      '<span class="all-proj-col-actions"></span>' +
    '</div>';

  var rows = projects.map(function(p) {
    var convCount = (state.conversations || []).filter(function(c) { return c.projectId === p.id; }).length;
    var srcCount  = (p.sources  || []).length;
    var isActive  = p.id === state.activeProjectId;
    var analyticsHtml = getProjectTaskAnalyticsInlineHtml(p.id, { compact: true });
    return '<div class="all-proj-row' + (isActive ? ' active' : '') + '">' +
      '<span class="all-proj-col-name">' +
        '<span class="proj-dot proj-color-' + _projEsc(p.color) + '" style="width:9px;height:9px;flex-shrink:0"></span>' +
        '<span class="all-proj-name-text">' + _projEsc(p.name) + '</span>' +
        (isActive ? '<span class="all-proj-active-badge">Active</span>' : '') +
      '</span>' +
      '<span class="all-proj-col-desc">' + (p.description ? _projEsc(p.description) : '<span class="all-proj-dim">—</span>') + '</span>' +
      '<span class="all-proj-col-num">' + srcCount + '</span>' +
      '<span class="all-proj-col-num">' + convCount + '</span>' +
      '<span class="all-proj-col-num all-proj-col-analytics">' + analyticsHtml + '</span>' +
      '<span class="all-proj-col-actions">' +
        (isActive
          ? '<button class="proj-action-btn" onclick="openProjectHub();closeAllProjects()"><i class="ti ti-layout-sidebar-right-expand"></i> Open Hub</button>' +
            '<button class="proj-icon-btn" onclick="clearActiveProject();closeAllProjects()" title="Leave project"><i class="ti ti-door-exit"></i></button>'
          : '<button class="proj-action-btn" onclick="setActiveProject(\'' + _projEsc(p.id) + '\');closeAllProjects()"><i class="ti ti-player-play"></i> Activate</button>') +
        '<button class="proj-icon-btn" style="color:var(--fau-text-muted)" onclick="_confirmDeleteProjectFromList(\'' + _projEsc(p.id) + '\')" title="Delete project"><i class="ti ti-trash"></i></button>' +
      '</span>' +
    '</div>';
  }).join('');

  listEl.innerHTML = header + rows;
}

async function _confirmDeleteProjectFromList(id) {
  if (!await _projConfirm('Delete this project? This cannot be undone.')) return;
  try {
    var r = await fetch('/api/projects/' + id, { method: 'DELETE' });
    if (!r.ok && r.status !== 404) {
      var msg = 'HTTP ' + r.status;
      try { var j = await r.json(); if (j && j.error) msg = j.error; } catch(_) {}
      throw new Error(msg);
    }
    // 404 = already gone on the server; either way drop it from local state
    state.projects = state.projects.filter(function(p) { return p.id !== id; });
    _deleteProjectConversations(id);
    if (state.activeProjectId === id) clearActiveProject();
    renderProjectSidebarList();
    _renderAllProjectsPage();
    _showToast(r.status === 404 ? 'Removed stale project' : 'Project deleted');
  } catch(e) { _showToast('Delete failed: ' + e.message, true); }
}

// ── Project Switcher (sidebar pill) — now a no-op, list handles display ──

function renderProjectSwitcher() {
  renderProjectSidebarList();
}

// ── Project Context Bar (above messages, shows active contexts) ───────────

function renderProjectContextBar() {
  var el = document.getElementById('project-context-bar');
  if (!el) return;
  var proj = _activeProject();
  if (!proj || !proj.contexts || !proj.contexts.length) {
    el.style.display = 'none';
    el.innerHTML = '';
    return;
  }
  var pinned = proj.contexts.filter(function(c) { return c.pinned; });
  el.style.display = pinned.length ? '' : 'none';
  if (!pinned.length) { el.innerHTML = ''; return; }
  el.innerHTML =
    '<div class="proj-ctx-bar-inner">' +
      '<span class="proj-ctx-bar-label"><i class="ti ti-pin"></i> ' + _projEsc(proj.name) + '</span>' +
      pinned.map(function(c) {
        var isOn = state.projectContextEnabled[c.id] !== false; // default on
        return '<button class="proj-ctx-chip' + (isOn ? ' active' : '') + '" onclick="toggleProjectContext(\'' + c.id + '\')" title="' + _projEsc(c.name) + '">' +
          '<i class="ti ti-file-text"></i> ' + _projEsc(c.name) +
        '</button>';
      }).join('') +
      '<button class="proj-ctx-bar-hub-btn" onclick="openProjectHub(\'contexts\')" title="Manage contexts"><i class="ti ti-settings"></i></button>' +
    '</div>';
}

function toggleProjectContext(ctxId) {
  var current = state.projectContextEnabled[ctxId];
  state.projectContextEnabled[ctxId] = current === false ? true : false;
  renderProjectContextBar();
}

// ── Set / Clear Active Project ────────────────────────────────────────────

function updateProjectIndicator() {
  // Legacy pill stubs (kept for compat but always hidden)
  var pill = document.getElementById('topbar-project-pill');
  var nameEl = document.getElementById('topbar-project-name');
  var proj = _activeProject();

  // ── Breadcrumb ────────────────────────────────────────────────
  var crumb    = document.getElementById('topbar-project-crumb');
  var crumbSep = document.getElementById('topbar-crumb-sep');
  var settingsBtn = document.getElementById('topbar-project-settings-btn');
  var crumbName = document.getElementById('topbar-project-name'); // shared id

  if (crumb) {
    if (proj) {
      if (crumbName) crumbName.textContent = proj.name;
      crumb.style.display = '';
      if (crumbSep) crumbSep.style.display = '';
      if (settingsBtn) settingsBtn.style.display = '';
    } else {
      crumb.style.display = 'none';
      if (crumbSep) crumbSep.style.display = 'none';
      if (settingsBtn) settingsBtn.style.display = 'none';
    }
  }

  _updateMoveToProjectBtn();

  // Sidebar active project strip
  var strip = document.getElementById('sidebar-active-project');
  var stripName = document.getElementById('sidebar-active-project-name');
  var stripDot = document.getElementById('sidebar-active-project-dot');
  if (!strip) return;
  if (proj) {
    if (stripName) stripName.textContent = proj.name;
    if (stripDot) {
      stripDot.className = 'proj-dot proj-color-' + (proj.color || 'blue');
    }
    strip.style.display = '';
  } else {
    strip.style.display = 'none';
  }
}

async function setActiveProject(id, opts) {
  opts = opts || {};
  var navigate = opts.navigate !== false;
  if (_projFileSearchState.agentRunning && state.activeProjectId !== id) cancelProjectAgentSearch();
  state.activeProjectId = id;
  if (id) {
    localStorage.setItem('fauna-active-project', id);
    await _refreshProject(id);
    // Bump local lastActiveAt so the project immediately re-sorts to the top of
    // the sidebar list (the backend touch below is async and won't be reflected
    // by the refresh above, which already ran).
    var _lp = (state.projects || []).find(function(p) { return p.id === id; });
    if (_lp) _lp.lastActiveAt = Date.now();
    // Reset context enabled state to defaults (all pinned = on, unpinned = off)
    state.projectContextEnabled = {};
    var proj = _activeProject();
    if (proj && proj.contexts) {
      proj.contexts.forEach(function(c) {
        state.projectContextEnabled[c.id] = c.pinned ? true : false;
      });
    }
    // Touch on backend
    fetch('/api/projects/' + id + '/touch', { method: 'POST' }).catch(function(){});
  } else {
    localStorage.removeItem('fauna-active-project');
    state.projectContextEnabled = {};
  }
  renderProjectSwitcher();
  renderProjectSidebarList();
  renderProjectContextBar();
  updateProjectIndicator();
  if (typeof renderConvList === 'function') renderConvList();
  if (typeof renderTasks === 'function') renderTasks();
  // If the project hub is open, re-render it for the newly-active project (or close it if we exited)
  if (state.projectHubOpen) {
    var _hubProj = _activeProject();
    if (_hubProj) {
      _renderProjectHub(_hubProj);
    } else {
      closeProjectHub();
    }
  }
  // Refresh the All Projects page so the Active badge / button states update
  var _allProjPage = document.getElementById('all-projects-page');
  if (_allProjPage && _allProjPage.style.display !== 'none') {
    _renderAllProjectsPage();
  }

  // Navigate to a conversation appropriate for the new project context. Skipped
  // when activation is a side-effect of opening a chat (navigate:false), so we
  // don't recurse or yank the user away from the chat they just clicked.
  if (!navigate) return;
  if (id) {
    // Enter project: load the most recent conversation in the project, or start
    // a new one only if the project has no conversations yet.
    var projConvs = state.conversations.filter(function(c) { return c.projectId === id; })
      .sort(function(a, b) {
        return (b.updatedAt || b.createdAt || 0) - (a.updatedAt || a.createdAt || 0);
      });
    if (projConvs.length) {
      loadConversation(projConvs[0].id);
    } else {
      newConversation();
    }
  } else {
    // Exited project: load most recent non-project conversation if one exists
    var nonProjConv = state.conversations.find(function(c) { return !c.projectId; });
    if (nonProjConv) {
      loadConversation(nonProjConv.id);
    } else {
      newConversation();
    }
  }
}

function clearActiveProject() {
  setActiveProject(null);
  closeProjectHub();
}

// ── Project Hub Panel ─────────────────────────────────────────────────────

var _hubResizeInited = false;
function _initHubResize() {
  if (_hubResizeInited) return;
  _hubResizeInited = true;
  // HUB_MAX is computed from viewport at drag time so the hub can grow up
  // to 90% of the window width on a wide monitor without leaving the user
  // wondering why the handle hit a wall at 900px.
  var HUB_MIN = 300, HUB_KEY = 'fauna-hub-width';
  function hubMax() { return Math.max(HUB_MIN, Math.floor(window.innerWidth * 0.9)); }
  var hub = document.getElementById('project-hub');
  var handle = document.getElementById('project-hub-resize-handle');
  if (!hub || !handle) return;
  var saved = parseInt(localStorage.getItem(HUB_KEY), 10);
  if (saved && saved >= HUB_MIN && saved <= hubMax()) {
    document.documentElement.style.setProperty('--hub-w', saved + 'px');
  }
  window.installPaneResize({
    handle: handle,
    classTarget: hub,
    getStartWidth: function () { return hub.getBoundingClientRect().width; },
    onMove: function (dx, startW) {
      // Hub sits on the right — dragging left widens it.
      var w = Math.min(hubMax(), Math.max(HUB_MIN, startW - dx));
      document.documentElement.style.setProperty('--hub-w', w + 'px');
    },
    onEnd: function () {
      localStorage.setItem(HUB_KEY, Math.round(hub.getBoundingClientRect().width));
    },
  });
  handle.addEventListener('dblclick', function() {
    document.documentElement.style.setProperty('--hub-w', '720px');
    localStorage.removeItem(HUB_KEY);
  });
}

function openProjectHub(tab) {
  var proj = _activeProject();
  if (!proj) { openProjectPicker(); return; }
  state.projectHubOpen = true;
  // Migrate legacy ids: 'sources' merged into 'contexts', 'terminal' into 'run'.
  if (tab === 'sources') tab = 'contexts';
  if (tab === 'terminal') tab = 'run';
  state.projectHubTab = tab || state.projectHubTab || 'tasks';
  if (state.projectHubTab === 'sources') state.projectHubTab = 'contexts';
  if (state.projectHubTab === 'terminal') state.projectHubTab = 'run';
  // Legacy 'files' default \u2014 once-off: if the user had no preference and we
  // landed on 'files' from a stale persisted value, prefer Board.
  if (state.projectHubTab === 'files' && !tab && !localStorage.getItem('fauna-hub-tab-set')) {
    state.projectHubTab = 'tasks';
  }
  // Remember that this user has now made/accepted a tab choice so we don't
  // re-override it again next time they open with no explicit `tab` arg.
  try { localStorage.setItem('fauna-hub-tab-set', '1'); } catch (_) {}
  var hub = document.getElementById('project-hub');
  if (!hub) return;
  hub.style.display = 'flex';
  _initHubResize();
  _renderProjectHub(proj);
}

function closeProjectHub() {
  state.projectHubOpen = false;
  if (_projMonacoEditor) { _projMonacoEditor.dispose(); _projMonacoEditor = null; }
  // Kill all terminal sessions
  _termDestroyAll();
  var hub = document.getElementById('project-hub');
  if (hub) hub.style.display = 'none';
}

function _renderProjectHub(proj) {
  var nameEl = document.getElementById('project-hub-name');
  if (nameEl) nameEl.textContent = proj.name;

  // Migrate any legacy tab id persisted from older builds.
  if (state.projectHubTab === 'sources') state.projectHubTab = 'contexts';
  if (state.projectHubTab === 'terminal') state.projectHubTab = 'run';

  var TABS = [
    { id: 'tasks',    icon: 'ti-layout-kanban',  label: 'Board' },
    { id: 'files',    icon: 'ti-folder',       label: 'Files' },
    // 'contexts' tab now also holds Sources; 'run' tab also holds Terminal.
    { id: 'contexts', icon: 'ti-file-text',     label: 'Contexts' },
    { id: 'run',      icon: 'ti-player-play',   label: 'Run' },
    { id: 'convs',    icon: 'ti-messages',      label: 'Conversations' },
    { id: 'settings', icon: 'ti-settings',      label: 'Settings' },
  ];
  // Add Design tab for design projects
  if (proj.design && proj.design.projectType === 'design') {
    TABS.splice(2, 0, { id: 'design', icon: 'ti-layout-2', label: 'Design' });
  }
  var tabsEl = document.getElementById('project-hub-tabs');
  if (tabsEl) {
    tabsEl.innerHTML = TABS.map(function(t) {
      return '<button class="proj-hub-tab' + (state.projectHubTab === t.id ? ' active' : '') + '" onclick="switchProjectHubTab(\'' + t.id + '\')">' +
        '<i class="ti ' + t.icon + '"></i> ' + t.label +
      '</button>';
    }).join('');
  }

  _renderProjectHubBody(proj);
}

function switchProjectHubTab(tab) {
  // Migrate legacy ids — call sites may still pass 'sources'/'terminal'.
  if (tab === 'sources') tab = 'contexts';
  if (tab === 'terminal') tab = 'run';
  // Dispose Monaco if leaving the files tab
  if (state.projectHubTab === 'files' && tab !== 'files') {
    if (_projMonacoEditor) { _projMonacoEditor.dispose(); _projMonacoEditor = null; }
  }
  // Disconnect run log SSE if leaving run tab (keep terminal alive)
  if (state.projectHubTab === 'run' && tab !== 'run') {
    if (_runLogESrc) { try { _runLogESrc.close(); } catch(_) {} _runLogESrc = null; }
    // Disconnect terminal SSE but keep shell alive
    _termDisconnectSSE();
  }
  // Reconnect terminal SSE when entering terminal or run tab
  if ((tab === 'run' || tab === 'terminal') && state.projectHubTab !== tab) {
    // Will reconnect after render
  }
  // Kill standalone terminal tab shell if leaving (it shares the session pool)
  if (state.projectHubTab === 'terminal' && tab !== 'terminal') {
    _termDisconnectSSE();
  }
  // Disconnect Kanban board SSE if leaving the board tab. The board
  // module owns its own EventSource on window._kbState.sse.
  if (state.projectHubTab === 'tasks' && tab !== 'tasks') {
    try {
      if (window._kbState && window._kbState.sse) {
        window._kbState.sse.close();
        window._kbState.sse = null;
      }
    } catch (_) { /* ignore */ }
  }
  state.projectHubTab = tab;
  var proj = _activeProject();
  if (!proj) return;
  // Re-render tabs
  var tabsEl = document.getElementById('project-hub-tabs');
  if (tabsEl) {
    tabsEl.querySelectorAll('.proj-hub-tab').forEach(function(btn) {
      btn.classList.toggle('active', btn.textContent.trim().toLowerCase().startsWith(tab));
    });
  }
  _renderProjectHubBody(proj);
}

function _escHtml(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function _renderBacklogListHtml(items) {
  if (!Array.isArray(items) || !items.length) return '<div class="proj-backlog-empty">No backlog items yet.</div>';
  var rows = items.slice(0, 10).map(function(it) {
    var score = (it.score == null) ? '—' : it.score;
    var status = it.status || 'new';
    return '<div class="proj-backlog-item">' +
      '<div class="proj-backlog-item-head">' +
        '<span class="proj-backlog-score" title="score">' + _escHtml(score) + '</span>' +
        '<span class="proj-backlog-title">' + _escHtml(it.title || 'Untitled') + '</span>' +
        '<span class="proj-backlog-status proj-backlog-status-' + _escHtml(status) + '">' + _escHtml(status) + '</span>' +
      '</div>' +
      (it.body ? '<div class="proj-backlog-body">' + _escHtml(String(it.body).slice(0, 200)) + '</div>' : '') +
    '</div>';
  }).join('');
  return rows;
}

function _renderProjectHubBody(proj) {
  var body = document.getElementById('project-hub-body');
  if (!body) return;
  var tab = state.projectHubTab;
  if (tab === 'design') {
    // Design settings panel
    var d = proj.design || {};
    body.innerHTML =
      '<div class="proj-design-ready">' +
        '<div class="proj-design-ready-icon"><i class="ti ti-sparkles"></i></div>' +
        '<div class="proj-design-ready-title">Your design project is ready</div>' +
        '<div class="proj-design-ready-desc">Close this panel and start chatting — describe what you want to build and the AI will generate it. The settings below are optional and can be changed any time.</div>' +
        '<button class="proj-design-start-btn" onclick="closeProjectHub()"><i class="ti ti-arrow-right"></i> Start designing</button>' +
      '</div>' +
      '<details class="proj-design-settings-details">' +
        '<summary class="proj-design-settings-summary"><i class="ti ti-adjustments-horizontal"></i> Settings (optional)</summary>' +
        '<div class="proj-section proj-design-settings-body">' +
          '<div class="proj-settings-row"><label>Skills<span class="proj-settings-hint">Choose what kinds of design output to focus on</span></label>' +
            '<div class="proj-skill-checks" id="proj-hub-skill-checks">Loading…</div>' +
          '</div>' +
          '<div class="proj-settings-row"><label>Design System<span class="proj-settings-hint">Visual style foundation</span></label>' +
            '<select class="proj-input" data-field="systemId" onchange="_saveDesignField(\'' + proj.id + '\', this)"></select>' +
          '</div>' +
          '<div class="proj-settings-row"><label>Platform<span class="proj-settings-hint">Target viewport</span></label>' +
            '<select class="proj-input" data-field="platform" onchange="_saveDesignField(\'' + proj.id + '\', this)">' +
              '<option value="desktop"' + (d.platform !== 'mobile' ? ' selected' : '') + '>Desktop</option>' +
              '<option value="mobile"'  + (d.platform === 'mobile'  ? ' selected' : '') + '>Mobile</option>' +
            '</select>' +
          '</div>' +
          '<div class="proj-settings-row"><label>Fidelity<span class="proj-settings-hint">How polished the output should be</span></label>' +
            '<select class="proj-input" data-field="fidelity" onchange="_saveDesignField(\'' + proj.id + '\', this)">' +
              '<option value="hi"' + (d.fidelity !== 'lo' ? ' selected' : '') + '>High (pixel-ready HTML/CSS)</option>' +
              '<option value="lo"' + (d.fidelity === 'lo'  ? ' selected' : '') + '>Low (wireframe sketch)</option>' +
            '</select>' +
          '</div>' +
        '</div>' +
      '</details>';
    // Populate skill checkboxes and system select via API
    if (typeof loadDesignCatalog === 'function') {
      loadDesignCatalog(function(catalog) {
        var skillChecks = body.querySelector('#proj-hub-skill-checks');
        var selSys      = body.querySelector('[data-field="systemId"]');
        var activeIds   = d.skillIds || (d.skillId ? [d.skillId] : []);
        if (skillChecks) {
          skillChecks.innerHTML = (catalog.skills || []).map(function(s) {
            var checked = activeIds.indexOf(s.id) !== -1 ? ' checked' : '';
            return '<label class="proj-skill-check">' +
              '<input type="checkbox" value="' + _projEsc(s.id) + '"' + checked +
                ' onchange="_saveDesignSkills(\'' + proj.id + '\', this.closest(\'.proj-skill-checks\'))">' +
              ' ' + _projEsc(s.name) +
            '</label>';
          }).join('');
          if (!(catalog.skills || []).length) skillChecks.textContent = 'No skills installed';
        }
        if (selSys) {
          selSys.innerHTML = '<option value="default">Default (neutral)</option>' +
            (catalog.systems || []).filter(function(s){ return s.id !== 'default'; }).map(function(s) {
              return '<option value="' + _projEsc(s.id) + '"' + (s.id === d.systemId ? ' selected' : '') + '>' + _projEsc(s.name) + '</option>';
            }).join('');
          if (!d.systemId) selSys.value = 'default';
        }
      });
    }
    return;
  }
  if (tab === 'files') {
    var proj2 = proj;
    body.innerHTML = _renderFilesTab(proj2);
    var rootPath2 = proj2.rootPath && proj2.rootPath.trim();
    var rootAlreadySrc2 = rootPath2 && (proj2.sources || []).some(function(s) { return s.type === 'local' && s.path === rootPath2; });
    var defaultSrcId = state._projectFileSrcId ||
      (rootPath2 && !rootAlreadySrc2 ? '__rootpath__' : null) ||
      (proj2.sources && proj2.sources[0] && proj2.sources[0].id);
    if (defaultSrcId) loadProjectFileTree(defaultSrcId, '');
  }
  else if (tab === 'contexts') body.innerHTML = _renderContextsTab(proj);
  else if (tab === 'sources')  body.innerHTML = _renderContextsTab(proj); // legacy alias
  else if (tab === 'run')      { body.innerHTML = _renderRunTabShell(); _runTabLoad(proj); }
  else if (tab === 'terminal') { body.innerHTML = _renderRunTabShell(); _runTabLoad(proj); } // legacy alias
  else if (tab === 'convs')    body.innerHTML = _renderConvsTab(proj);
  else if (tab === 'tasks')    {
    // Kanban board (P2). The board renderer mounts into the body element
    // itself and manages all subsequent DOM updates + SSE subscription.
    body.innerHTML = '';
    if (typeof window.renderKanbanBoard === 'function') {
      window.renderKanbanBoard({ projectId: proj.id, scope: 'project' }, body);
    } else {
      body.innerHTML = '<div class="proj-hub-empty"><i class="ti ti-alert-circle" style="font-size:24px;opacity:.3"></i>' +
        '<div>Board module failed to load.</div></div>';
    }
  }
  else if (tab === 'settings') body.innerHTML = _renderSettingsTab(proj);
}

// ── Files Tab ─────────────────────────────────────────────────────────────

function _renderFilesTab(proj) {
  var rootPath = proj.rootPath && proj.rootPath.trim();
  var rootAlreadySrc = rootPath && (proj.sources || []).some(function(s) {
    return s.type === 'local' && s.path === rootPath;
  });
  var hasAnySrc = (proj.sources && proj.sources.length) || (rootPath && !rootAlreadySrc);
  if (!hasAnySrc) {
    return '<div class="proj-hub-empty"><i class="ti ti-folder-open" style="font-size:28px;opacity:.3"></i><div>No sources yet</div>' +
      '<button class="proj-action-btn" onclick="switchProjectHubTab(\'contexts\')"><i class="ti ti-plus"></i> Add a source</button></div>';
  }
  var srcOptions = '';
  if (rootPath && !rootAlreadySrc) {
    var rootBasename = rootPath.split('/').filter(Boolean).pop() || rootPath;
    srcOptions += '<option value="__rootpath__"' + (state._projectFileSrcId === '__rootpath__' ? ' selected' : '') + '>' + _projEsc(rootBasename) + ' (working folder)</option>';
  }
  srcOptions += (proj.sources || []).map(function(s) {
    return '<option value="' + _projEsc(s.id) + '"' + (state._projectFileSrcId === s.id ? ' selected' : '') + '>' + _projEsc(s.name) + '</option>';
  }).join('');
  return '<div class="proj-files-toolbar">' +
    '<select class="proj-src-select" onchange="loadProjectFileTree(this.value, \'\')">' + srcOptions + '</select>' +
    '<button class="proj-icon-btn' + (_projFileSearchState.visible ? ' active' : '') + '" onclick="toggleProjectFileSearch()" title="Find in files (Cmd/Ctrl+Shift+F)"><i class="ti ti-search"></i></button>' +
    '<button class="proj-icon-btn" onclick="newProjectEntry(\'hub\', \'\', \'file\')" title="New file"><i class="ti ti-file-plus"></i></button>' +
    '<button class="proj-icon-btn" onclick="newProjectEntry(\'hub\', \'\', \'dir\')" title="New folder"><i class="ti ti-folder-plus"></i></button>' +
    '<button class="proj-icon-btn" onclick="_triggerProjectUpload(\'hub\', \'\')" title="Upload files"><i class="ti ti-upload"></i></button>' +
    '<button class="proj-icon-btn" onclick="openProjectFileExplorer()" title="Expand to full screen"><i class="ti ti-arrows-maximize"></i></button>' +
    '<button class="proj-icon-btn" onclick="loadProjectFileTree(document.querySelector(\'.proj-src-select\').value, \'\')" title="Refresh"><i class="ti ti-refresh"></i></button>' +
    '<input id="proj-hub-upload-input" type="file" multiple style="display:none" onchange="_handleProjectUploadPick(\'hub\', this)"/>' +
  '</div>' +
  _renderProjectFileSearch(proj) +
  '<div class="proj-files-layout">' +
    '<div id="proj-file-tree-root" class="proj-file-tree proj-files-tree-col"></div>' +
    '<div id="proj-file-viewer" class="proj-file-viewer proj-files-viewer-col" style="display:none"></div>' +
  '</div>';
}

var _projFileSearchState = {
  visible: false,
  mode: 'text',
  replaceVisible: false,
  query: '',
  replacement: '',
  caseSensitive: false,
  wholeWord: false,
  regex: false,
  include: '',
  exclude: '',
  result: null,
  loading: false,
  error: '',
  timer: null,
  requestSeq: 0,
  agentName: '',
  agentTask: '',
  agentApply: false,
  agentRunning: false,
  agentOutput: '',
  agentError: '',
  agentAbortController: null,
};

function _renderProjectFileSearch(proj) {
  var s = _projFileSearchState;
  var canEdit = !!(proj && proj.allowFileEditing);
  var modeBar = '<div class="proj-search-modebar" role="tablist" aria-label="Search mode">' +
    '<button class="proj-search-mode' + (s.mode === 'text' ? ' active' : '') + '" role="tab" aria-selected="' + (s.mode === 'text') + '" onclick="setProjectSearchMode(\'text\')"><i class="ti ti-search"></i> Find</button>' +
    '<button class="proj-search-mode' + (s.mode === 'agent' ? ' active' : '') + '" role="tab" aria-selected="' + (s.mode === 'agent') + '" onclick="setProjectSearchMode(\'agent\')"><i class="ti ti-sparkles"></i> Agent</button>' +
  '</div>';
  if (s.mode === 'agent') {
    return '<section id="proj-file-search" class="proj-file-search' + (s.visible ? '' : ' hidden') + '" aria-label="Agent search">' +
      modeBar + _renderProjectAgentSearch(proj, canEdit) + '</section>';
  }
  return '<section id="proj-file-search" class="proj-file-search' + (s.visible ? '' : ' hidden') + '" aria-label="Find in files">' +
    modeBar +
    '<div class="proj-search-row">' +
      '<button class="proj-search-disclosure" onclick="toggleProjectReplace()" title="Toggle Replace"><i class="ti ' + (s.replaceVisible ? 'ti-chevron-down' : 'ti-chevron-right') + '"></i></button>' +
      '<div class="proj-search-input-wrap"><i class="ti ti-search"></i>' +
        '<input id="proj-search-query" class="proj-search-input" value="' + _projEsc(s.query) + '" placeholder="Search" autocomplete="off" oninput="queueProjectFileSearch()" onkeydown="if(event.key===\'Enter\'){event.preventDefault();runProjectFileSearch()}">' +
        '<button class="proj-search-option' + (s.caseSensitive ? ' active' : '') + '" onclick="toggleProjectSearchOption(\'caseSensitive\')" title="Match Case">Aa</button>' +
        '<button class="proj-search-option' + (s.wholeWord ? ' active' : '') + '" onclick="toggleProjectSearchOption(\'wholeWord\')" title="Match Whole Word">ab</button>' +
        '<button class="proj-search-option' + (s.regex ? ' active' : '') + '" onclick="toggleProjectSearchOption(\'regex\')" title="Use Regular Expression">.*</button>' +
      '</div>' +
      '<button class="proj-icon-btn" onclick="runProjectFileSearch()" title="Refresh search"><i class="ti ti-refresh"></i></button>' +
      '<button class="proj-icon-btn" onclick="toggleProjectFileSearch(false)" title="Close search"><i class="ti ti-x"></i></button>' +
    '</div>' +
    '<div class="proj-search-row proj-replace-row' + (s.replaceVisible ? '' : ' hidden') + '">' +
      '<span class="proj-search-indent"></span>' +
      '<div class="proj-search-input-wrap"><i class="ti ti-replace"></i>' +
        '<input id="proj-search-replacement" class="proj-search-input" value="' + _projEsc(s.replacement) + '" placeholder="Replace" autocomplete="off"' + (canEdit ? '' : ' disabled') + ' oninput="_projFileSearchState.replacement=this.value" onkeydown="if(event.key===\'Enter\'&&event.metaKey){event.preventDefault();replaceAllProjectMatches()}">' +
      '</div>' +
      '<button class="proj-icon-btn" onclick="replaceAllProjectMatches()" title="Replace All"' + (canEdit ? '' : ' disabled') + '><i class="ti ti-replace"></i></button>' +
    '</div>' +
    '<div class="proj-search-filters">' +
      '<label>files to include <input id="proj-search-include" value="' + _projEsc(s.include) + '" placeholder="e.g. src/**/*.js" oninput="queueProjectFileSearch()"></label>' +
      '<label>files to exclude <input id="proj-search-exclude" value="' + _projEsc(s.exclude) + '" placeholder="e.g. **/*.test.js" oninput="queueProjectFileSearch()"></label>' +
    '</div>' +
    (!canEdit && s.replaceVisible ? '<div class="proj-search-readonly"><i class="ti ti-lock"></i> Enable source file editing in Project Settings to replace matches.</div>' : '') +
    '<div id="proj-search-results" class="proj-search-results">' + _renderProjectSearchResults() + '</div>' +
  '</section>';
}

function _projectSearchAgents() {
  return typeof getAllAgents === 'function' ? getAllAgents().filter(function(agent) {
    return agent && agent.name && !agent.orchestrator;
  }) : [];
}

function _renderProjectAgentSearch(proj, canEdit) {
  var s = _projFileSearchState;
  var agents = _projectSearchAgents();
  var activeName = typeof getActiveAgentName === 'function' ? getActiveAgentName() : '';
  if (!s.agentName || !agents.some(function(agent) { return agent.name === s.agentName; })) {
    s.agentName = activeName && agents.some(function(agent) { return agent.name === activeName; }) ? activeName : (agents[0] && agents[0].name) || '';
  }
  var options = agents.map(function(agent) {
    return '<option value="' + _projEsc(agent.name) + '"' + (agent.name === s.agentName ? ' selected' : '') + '>' + _projEsc(agent.displayName || agent.name) + '</option>';
  }).join('');
  var output = s.agentError
    ? '<div class="proj-agent-search-status error"><i class="ti ti-alert-circle"></i>' + _projEsc(s.agentError) + '</div>'
    : s.agentOutput
      ? '<pre class="proj-agent-search-output">' + _projEsc(s.agentOutput) + '</pre>'
      : '<div class="proj-agent-search-status"><i class="ti ti-sparkles"></i>Ask an agent to trace behavior, find patterns, or refactor this source.</div>';
  return '<div class="proj-agent-search-toolbar">' +
      '<select id="proj-agent-search-agent" class="proj-agent-search-select" onchange="_projFileSearchState.agentName=this.value" aria-label="Search agent"' + (s.agentRunning ? ' disabled' : '') + '>' + (options || '<option value="">No agents installed</option>') + '</select>' +
      '<button class="proj-agent-apply-toggle' + (s.agentApply ? ' active' : '') + '" onclick="toggleProjectAgentApply()" title="Allow the selected agent to edit files"' + (!canEdit || s.agentRunning ? ' disabled' : '') + '><i class="ti ti-wand"></i> Apply changes</button>' +
      '<button class="proj-icon-btn proj-agent-search-run" onclick="' + (s.agentRunning ? 'cancelProjectAgentSearch()' : 'runProjectAgentSearch()') + '" title="' + (s.agentRunning ? 'Stop agent' : 'Run agent (Cmd/Ctrl+Enter)') + '"' + (!agents.length ? ' disabled' : '') + '><i class="ti ' + (s.agentRunning ? 'ti-square' : 'ti-player-play') + '"></i></button>' +
      '<button class="proj-icon-btn" onclick="toggleProjectFileSearch(false)" title="Close search"><i class="ti ti-x"></i></button>' +
    '</div>' +
    '<textarea id="proj-agent-search-task" class="proj-agent-search-task" rows="3" placeholder="Find the authentication flow and refactor duplicated token validation…" oninput="_projFileSearchState.agentTask=this.value" onkeydown="if((event.metaKey||event.ctrlKey)&&event.key===\'Enter\'){event.preventDefault();runProjectAgentSearch()}"' + (s.agentRunning ? ' disabled' : '') + '>' + _projEsc(s.agentTask) + '</textarea>' +
    (!canEdit ? '<div class="proj-search-readonly"><i class="ti ti-lock"></i>Analysis is read-only. Enable source file editing in Project Settings to apply refactors.</div>' :
      (!s.agentApply ? '<div class="proj-agent-search-safety"><i class="ti ti-shield-check"></i>Analysis mode cannot run shell commands or modify files.</div>' : '')) +
    '<div id="proj-agent-search-results" class="proj-agent-search-results">' + (s.agentRunning && !s.agentOutput ? '<div class="proj-agent-search-status"><i class="ti ti-loader-2 spin"></i>Agent is searching…</div>' : output) + '</div>';
}

function setProjectSearchMode(mode) {
  if (mode !== 'text' && mode !== 'agent') return;
  if (_projFileSearchState.agentRunning) return;
  _captureProjectSearchInputs();
  _projFileSearchState.mode = mode;
  var proj = _activeProject();
  if (proj) _renderProjectHubBody(proj);
  setTimeout(function() {
    var input = document.getElementById(mode === 'agent' ? 'proj-agent-search-task' : 'proj-search-query');
    if (input) input.focus();
  }, 0);
}

function toggleProjectAgentApply() {
  if (_projFileSearchState.agentRunning) return;
  var proj = _activeProject();
  if (!proj || !proj.allowFileEditing) return;
  _projFileSearchState.agentApply = !_projFileSearchState.agentApply;
  _renderProjectHubBody(proj);
}

function _projectAgentSourcePath(proj) {
  if (!proj) return '';
  if (_hubTreeState.srcId === '__rootpath__') return proj.rootPath || '';
  var source = (proj.sources || []).find(function(item) { return item.id === _hubTreeState.srcId; });
  return source && source.type === 'local' ? source.path || '' : '';
}

function _updateProjectAgentSearchResults() {
  var el = document.getElementById('proj-agent-search-results');
  if (!el) return;
  var s = _projFileSearchState;
  if (s.agentError) el.innerHTML = '<div class="proj-agent-search-status error"><i class="ti ti-alert-circle"></i>' + _projEsc(s.agentError) + '</div>';
  else if (s.agentOutput) el.innerHTML = '<pre class="proj-agent-search-output">' + _projEsc(s.agentOutput) + '</pre>';
  else if (s.agentRunning) el.innerHTML = '<div class="proj-agent-search-status"><i class="ti ti-loader-2 spin"></i>Agent is searching…</div>';
}

function cancelProjectAgentSearch() {
  var s = _projFileSearchState;
  if (s.agentAbortController) s.agentAbortController.abort();
}

async function _readProjectAgentSearchStream(response, signal, onContent) {
  var reader = response.body.getReader();
  var decoder = new TextDecoder();
  var partial = '';
  var text = '';
  while (true) {
    if (signal && signal.aborted) {
      try { await reader.cancel(); } catch (_) {}
      throw new DOMException('Agent run stopped', 'AbortError');
    }
    var chunk = await reader.read();
    if (chunk.done) break;
    partial += decoder.decode(chunk.value, { stream: true });
    var lines = partial.split('\n');
    partial = lines.pop();
    for (var lineIndex = 0; lineIndex < lines.length; lineIndex++) {
      var line = lines[lineIndex];
      if (line.indexOf('data: ') !== 0) continue;
      var event;
      try {
        event = JSON.parse(line.slice(6));
      } catch (_) { continue; }
      if (event.type === 'error') throw new Error(event.error || 'Agent search failed');
      if (event.type === 'content' && typeof event.content === 'string') {
        text += event.content;
        onContent(event.content);
      }
    }
  }
  return text;
}

async function runProjectAgentSearch() {
  var s = _projFileSearchState;
  if (s.agentRunning) return;
  var taskInput = document.getElementById('proj-agent-search-task');
  if (taskInput) s.agentTask = taskInput.value;
  var task = (s.agentTask || '').trim();
  var proj = _activeProject();
  var agent = typeof findAgent === 'function' ? findAgent(s.agentName) : null;
  if (!task || !proj || !agent || !_hubTreeState.srcId) return;
  if (s.agentApply) {
    if (!proj.allowFileEditing) { s.agentApply = false; _renderProjectHubBody(proj); return; }
    if (!await _projConfirm('Allow ' + (agent.displayName || agent.name) + ' to search and modify files in this project source?')) return;
  }
  var sourcePath = _projectAgentSourcePath(proj);
  if (!sourcePath) {
    s.agentError = 'Agent search requires a local project source.';
    _updateProjectAgentSearchResults();
    return;
  }
  var permissions = {
    fileRead: [sourcePath],
    fileWrite: s.agentApply ? [sourcePath] : [],
    shell: false,
    browser: false,
    figma: false,
    network: { blockAll: true },
  };
  var modeInstruction = s.agentApply
    ? 'Inspect the repository, make only the requested changes, re-read changed files to verify them, and summarize changed files. Shell access is unavailable.'
    : 'This is read-only analysis. Use agent_search_files and agent_read_file. Do not modify files and do not claim changes were made.';
  var systemPrompt = '## Project Hub Agent Search\n\n' + (agent.systemPrompt || '') + '\n\n' + modeInstruction +
    '\nActive project: ' + (proj.name || proj.id) + '\nActive source path: ' + sourcePath;
  s.agentRunning = true;
  s.agentOutput = '';
  s.agentError = '';
  s.agentAbortController = new AbortController();
  var runProjectId = state.activeProjectId;
  var runSourceId = _hubTreeState.srcId;
  var applyRequested = !!s.agentApply;
  _renderProjectHubBody(proj);
  try {
    var response = await fetch('/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      signal: s.agentAbortController.signal,
      body: JSON.stringify({
        messages: [{ role: 'user', content: task }],
        model: (Array.isArray(agent.model) ? agent.model[0] : agent.model) || state.model,
        projectId: runProjectId,
        clientContext: 'project-search',
        sourceId: runSourceId,
        projectSearchApply: applyRequested,
        agentName: agent.name,
        agentPermissions: permissions,
        isolatedContext: true,
        thinkingBudget: state.thinkingBudget || 'high',
        systemPrompt: systemPrompt,
      }),
    });
    if (!response.ok || !response.body) throw new Error('Agent request failed (HTTP ' + response.status + ')');
    await _readProjectAgentSearchStream(response, s.agentAbortController.signal, function(delta) {
      s.agentOutput += delta;
      _updateProjectAgentSearchResults();
    });
    if (!s.agentOutput) s.agentOutput = 'Agent completed without a written summary.';
    if (applyRequested && state.activeProjectId === runProjectId && _hubTreeState.srcId === runSourceId) {
      await loadProjectFileTree(runSourceId, '');
    }
  } catch (error) {
    if (error && error.name === 'AbortError') s.agentOutput = s.agentOutput || 'Agent run stopped.';
    else s.agentError = (error && error.message) || String(error);
  } finally {
    s.agentRunning = false;
    s.agentAbortController = null;
    if (state.activeProjectId === runProjectId) _renderProjectHubBody(_activeProject() || proj);
  }
}

function _captureProjectSearchInputs() {
  var query = document.getElementById('proj-search-query');
  var replacement = document.getElementById('proj-search-replacement');
  var include = document.getElementById('proj-search-include');
  var exclude = document.getElementById('proj-search-exclude');
  if (query) _projFileSearchState.query = query.value;
  if (replacement) _projFileSearchState.replacement = replacement.value;
  if (include) _projFileSearchState.include = include.value;
  if (exclude) _projFileSearchState.exclude = exclude.value;
}

function toggleProjectFileSearch(force) {
  var next = typeof force === 'boolean' ? force : !_projFileSearchState.visible;
  _projFileSearchState.visible = next;
  var proj = _activeProject();
  if (proj && state.projectHubOpen && state.projectHubTab === 'files') _renderProjectHubBody(proj);
  if (next) {
    setTimeout(function() {
      var input = document.getElementById('proj-search-query');
      if (input) { input.focus(); input.select(); }
    }, 0);
  }
}

function toggleProjectReplace() {
  _captureProjectSearchInputs();
  _projFileSearchState.replaceVisible = !_projFileSearchState.replaceVisible;
  var proj = _activeProject();
  if (proj) _renderProjectHubBody(proj);
}

function toggleProjectSearchOption(key) {
  _captureProjectSearchInputs();
  _projFileSearchState[key] = !_projFileSearchState[key];
  var proj = _activeProject();
  if (proj) _renderProjectHubBody(proj);
  if (_projFileSearchState.query) runProjectFileSearch();
}

function queueProjectFileSearch() {
  _captureProjectSearchInputs();
  clearTimeout(_projFileSearchState.timer);
  _projFileSearchState.timer = setTimeout(runProjectFileSearch, 250);
}

function _projectSearchPayload(extra) {
  _captureProjectSearchInputs();
  var s = _projFileSearchState;
  return Object.assign({
    query: s.query,
    replacement: s.replacement,
    caseSensitive: s.caseSensitive,
    wholeWord: s.wholeWord,
    regex: s.regex,
    include: s.include,
    exclude: s.exclude,
  }, extra || {});
}

async function runProjectFileSearch() {
  var s = _projFileSearchState;
  var payload = _projectSearchPayload();
  if (!payload.query || !state.activeProjectId || !_hubTreeState.srcId) {
    s.requestSeq++;
    s.result = null; s.error = ''; s.loading = false; _updateProjectSearchResults(); return;
  }
  var requestId = ++s.requestSeq;
  s.loading = true; s.error = ''; _updateProjectSearchResults();
  try {
    var r = await fetch('/api/projects/' + encodeURIComponent(state.activeProjectId) +
      '/sources/' + encodeURIComponent(_hubTreeState.srcId) + '/search', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload),
      });
    var data = await r.json();
    if (!r.ok) throw new Error(data.error || ('HTTP ' + r.status));
    if (requestId !== s.requestSeq) return;
    s.result = data;
  } catch (e) {
    if (requestId !== s.requestSeq) return;
    s.result = null; s.error = e.message;
  } finally {
    if (requestId === s.requestSeq) { s.loading = false; _updateProjectSearchResults(); }
  }
}

function _renderProjectSearchResults() {
  var s = _projFileSearchState;
  if (s.loading) return '<div class="proj-search-status"><i class="ti ti-loader-2 spin"></i> Searching…</div>';
  if (s.error) return '<div class="proj-search-status error"><i class="ti ti-alert-circle"></i> ' + _projEsc(s.error) + '</div>';
  if (!s.query) return '<div class="proj-search-status">Search across the selected source.</div>';
  if (!s.result) return '';
  if (!s.result.matchCount) return '<div class="proj-search-status">No results found.</div>';
  var canEdit = !!(_activeProject() && _activeProject().allowFileEditing);
  var summary = '<div class="proj-search-summary"><strong>' + s.result.matchCount + '</strong> result' + (s.result.matchCount === 1 ? '' : 's') +
    ' in <strong>' + s.result.fileCount + '</strong> file' + (s.result.fileCount === 1 ? '' : 's') +
    (s.result.truncated ? '<span class="proj-search-truncated">Results limited</span>' : '') + '</div>';
  var groups = (s.result.files || []).map(function(file) {
    var rows = (file.matches || []).map(function(match) {
      return '<button class="proj-search-match" data-path="' + _projEsc(file.path) + '" data-line="' + match.line + '" data-column="' + match.column + '" onclick="openProjectSearchMatch(this)">' +
        '<span class="proj-search-location">' + match.line + ':' + match.column + '</span>' +
        '<span class="proj-search-preview">' + _projEsc(match.preview) + '</span>' +
      '</button>';
    }).join('');
    return '<div class="proj-search-file">' +
      '<div class="proj-search-file-head"><i class="ti ' + _fileIcon((file.path.split('.').pop() || '').toLowerCase()) + '"></i>' +
        '<span title="' + _projEsc(file.path) + '">' + _projEsc(file.path) + '</span>' +
        '<span class="proj-search-file-count">' + file.matches.length + '</span>' +
        (canEdit && s.replaceVisible ? '<button class="proj-search-file-replace" data-path="' + _projEsc(file.path) + '" onclick="event.stopPropagation();replaceProjectSearchFile(this)" title="Replace all in this file"><i class="ti ti-replace"></i></button>' : '') +
      '</div>' + rows +
    '</div>';
  }).join('');
  return summary + groups;
}

function _updateProjectSearchResults() {
  var el = document.getElementById('proj-search-results');
  if (el) el.innerHTML = _renderProjectSearchResults();
}

async function openProjectSearchMatch(button) {
  var filePath = button && button.dataset.path;
  if (!filePath || !_hubTreeState.srcId) return;
  var line = Number(button.dataset.line || 1);
  var column = Number(button.dataset.column || 1);
  await openProjectFile(_hubTreeState.srcId, filePath);
  var attempts = 0;
  (function reveal() {
    if (_projMonacoEditor) {
      _projMonacoEditor.setPosition({ lineNumber: line, column: column });
      _projMonacoEditor.revealLineInCenter(line);
      _projMonacoEditor.focus();
      return;
    }
    if (attempts++ < 20) setTimeout(reveal, 50);
  })();
}

async function _replaceProjectMatches(paths) {
  var payload = _projectSearchPayload(paths ? { paths: paths } : {});
  if (!payload.query || !state.activeProjectId || !_hubTreeState.srcId) return;
  try {
    var r = await fetch('/api/projects/' + encodeURIComponent(state.activeProjectId) +
      '/sources/' + encodeURIComponent(_hubTreeState.srcId) + '/replace', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload),
      });
    var data = await r.json();
    if (!r.ok) throw new Error(data.error || ('HTTP ' + r.status));
    _showToast('Replaced ' + data.replacementCount + ' match' + (data.replacementCount === 1 ? '' : 'es') + ' in ' + data.fileCount + ' file' + (data.fileCount === 1 ? '' : 's'));
    await runProjectFileSearch();
    if (window._lastProjectFilePath && data.files && data.files.some(function(f) { return f.path === window._lastProjectFilePath; })) {
      await openProjectFile(_hubTreeState.srcId, window._lastProjectFilePath);
    }
  } catch (e) { _showToast('Replace failed: ' + e.message, true); }
}

async function replaceProjectSearchFile(button) {
  var filePath = button && button.dataset.path;
  if (filePath) await _replaceProjectMatches([filePath]);
}

async function replaceAllProjectMatches() {
  _captureProjectSearchInputs();
  var result = _projFileSearchState.result;
  if (!result || !result.matchCount) return;
  if (!await _projConfirm('Replace ' + result.matchCount + ' match' + (result.matchCount === 1 ? '' : 'es') + ' across ' + result.fileCount + ' file' + (result.fileCount === 1 ? '' : 's') + '?')) return;
  await _replaceProjectMatches(null);
}

if (typeof document !== 'undefined') {
  document.addEventListener('keydown', function(event) {
    if (!(event.metaKey || event.ctrlKey) || !event.shiftKey || event.key.toLowerCase() !== 'f') return;
    if (!state.projectHubOpen || state.projectHubTab !== 'files') return;
    event.preventDefault();
    toggleProjectFileSearch(true);
  });
}

// ── Unified expand-in-place tree ─────────────────────────────────────────
var _hubTreeState = { _id:'hub', srcId:null, dirCache:{}, expanded:{}, openedFiles:{}, dirHasOpened:{} };
var _explorerTreeState = { _id:'explorer', srcId:null, dirCache:{}, expanded:{}, openedFiles:{}, dirHasOpened:{} };

function _treeMarkOpened(st, filePath) {
  st.openedFiles[filePath] = true;
  var parts = filePath.split('/');
  for (var i = 1; i < parts.length; i++) {
    st.dirHasOpened[parts.slice(0, i).join('/')] = true;
  }
}

function _treeRender(st) {
  var elId = st._id === 'hub' ? 'proj-file-tree-root' : 'proj-exp-tree';
  var el = document.getElementById(elId);
  if (!el) return;
  var html = _treeRenderLevel(st, '', 0);
  el.innerHTML = html || '<div class="proj-hub-empty">Empty directory</div>';
}

function _treeRenderLevel(st, path, depth) {
  var entries = st.dirCache[path];
  if (!entries || !entries.length) return '';
  return entries.map(function(f) {
    var pad = 8 + depth * 16;
    if (f.type === 'dir') {
      var open = !!st.expanded[f.path];
      var hasDot = !!st.dirHasOpened[f.path];
      var chevron = open ? 'ti-chevron-down' : 'ti-chevron-right';
      var folderIco = open ? 'ti-folder-open' : 'ti-folder';
      var children = open ? _treeRenderLevel(st, f.path, depth + 1) : '';
      var dirPathEsc = _projEsc(f.path);
      return '<div>' +
        '<div class="proj-file-row proj-tree-dir-row" data-dir-path="' + dirPathEsc + '" style="padding-left:' + pad + 'px" onclick="_treeToggleDir(\'' + st._id + '\',\'' + dirPathEsc + '\')">' +
          '<i class="ti ' + chevron + ' proj-tree-chevron"></i>' +
          '<i class="ti ' + folderIco + ' proj-file-icon proj-folder-icon"></i>' +
          '<span class="proj-file-name">' + _projEsc(f.name) + '</span>' +
          (hasDot ? '<span class="proj-tree-dot"></span>' : '') +
          '<span class="proj-tree-actions">' +
            '<i class="ti ti-file-plus proj-tree-act" title="New file here" onclick="event.stopPropagation();newProjectEntry(\'' + st._id + '\',\'' + dirPathEsc + '\',\'file\')"></i>' +
            '<i class="ti ti-folder-plus proj-tree-act" title="New folder here" onclick="event.stopPropagation();newProjectEntry(\'' + st._id + '\',\'' + dirPathEsc + '\',\'dir\')"></i>' +
          '</span>' +
        '</div>' +
        (open ? '<div>' + children + '</div>' : '') +
      '</div>';
    } else {
      var opened = !!st.openedFiles[f.path];
      var size = f.size ? '<span class="proj-file-size">' + _fmtSize(f.size) + '</span>' : '';
      return '<div class="proj-file-row' + (opened ? ' proj-file-opened' : '') + '" data-file-path="' + _projEsc(f.path) + '" style="padding-left:' + pad + 'px" onclick="_treeOpenFile(\'' + st._id + '\',\'' + _projEsc(f.path) + '\')">' +
        '<i class="ti ' + _fileIcon(f.ext) + ' proj-file-icon"></i>' +
        '<span class="proj-file-name">' + _projEsc(f.name) + '</span>' +
        size +
      '</div>';
    }
  }).join('');
}

async function _treeToggleDir(stId, path) {
  var st = stId === 'hub' ? _hubTreeState : _explorerTreeState;
  if (st.expanded[path]) {
    delete st.expanded[path];
    _treeRender(st);
    return;
  }
  st.expanded[path] = true;
  if (!st.dirCache[path]) {
    try {
      var r = await fetch('/api/projects/' + state.activeProjectId + '/sources/' + st.srcId + '/files?path=' + encodeURIComponent(path));
      var files = await r.json();
      st.dirCache[path] = r.ok ? files : [];
    } catch(e) { st.dirCache[path] = []; }
  }
  _treeRender(st);
}

function _treeOpenFile(stId, filePath) {
  var st = stId === 'hub' ? _hubTreeState : _explorerTreeState;
  _treeMarkOpened(st, filePath);
  _treeRender(st);
  if (stId === 'hub') openProjectFile(st.srcId, filePath);
  else explorerOpenFile(st.srcId, filePath);
}

// ── Drag-and-drop upload ─────────────────────────────────────────────────
// Wire dragover/drop on the tree container. Identifying the target dir:
//   - drop over a directory row → that directory
//   - drop over a file row → its parent directory
//   - drop on empty space → source root
// Files post one-by-one to /upload as application/octet-stream. Holding
// Option (Alt) during drop triggers overwrite=1 — without it, collisions
// surface as "skipped". `webkitGetAsEntry` is preferred so dropped folders
// recurse; we fall back to `event.dataTransfer.files` (flat) otherwise.
function _treeBindDnd(st) {
  var rootId = st._id === 'hub' ? 'proj-file-tree-root' : 'proj-exp-tree';
  var el = document.getElementById(rootId);
  if (!el) return;
  if (el.dataset.dndBound === '1') return;
  el.dataset.dndBound = '1';

  var hoveredRow = null;
  function clearHover() {
    if (hoveredRow) { hoveredRow.classList.remove('proj-tree-drop-row'); hoveredRow = null; }
  }
  function setHover(row) {
    if (row === hoveredRow) return;
    clearHover();
    if (row) { row.classList.add('proj-tree-drop-row'); hoveredRow = row; }
  }
  function targetDirFor(evt) {
    var row = evt.target && evt.target.closest && evt.target.closest('.proj-file-row');
    if (!row) return { dir: '', row: null };
    var isDir = row.classList.contains('proj-tree-dir-row');
    if (isDir) {
      var dirPath = row.getAttribute('data-dir-path');
      return { dir: dirPath || '', row: row };
    }
    var filePath = row.getAttribute('data-file-path') || '';
    var slash = filePath.lastIndexOf('/');
    return { dir: slash >= 0 ? filePath.slice(0, slash) : '', row: row };
  }

  el.addEventListener('dragenter', function(evt) {
    if (!evt.dataTransfer || !Array.from(evt.dataTransfer.types || []).includes('Files')) return;
    evt.preventDefault();
    el.classList.add('proj-tree-drop-active');
  });
  el.addEventListener('dragover', function(evt) {
    if (!evt.dataTransfer || !Array.from(evt.dataTransfer.types || []).includes('Files')) return;
    evt.preventDefault();
    evt.dataTransfer.dropEffect = 'copy';
    el.classList.add('proj-tree-drop-active');
    var t = targetDirFor(evt);
    setHover(t.row);
  });
  el.addEventListener('dragleave', function(evt) {
    if (evt.target === el || !el.contains(evt.relatedTarget)) {
      el.classList.remove('proj-tree-drop-active');
      clearHover();
    }
  });
  el.addEventListener('drop', async function(evt) {
    if (!evt.dataTransfer || !Array.from(evt.dataTransfer.types || []).includes('Files')) return;
    evt.preventDefault();
    el.classList.remove('proj-tree-drop-active');
    clearHover();
    if (!st.srcId) { _showToast('Open a source first', true); return; }
    var t = targetDirFor(evt);
    var overwrite = !!evt.altKey;
    var entries = _treeReadDataTransferEntries(evt.dataTransfer);
    if (entries.length) {
      await _treeUploadEntries(st, t.dir, entries, overwrite);
    } else {
      var files = Array.from(evt.dataTransfer.files || []);
      if (!files.length) return;
      await _treeUploadFlatFiles(st, t.dir, files, overwrite);
    }
  });
}

// ----- Manual upload via the toolbar Upload button --------------------------
// _triggerProjectUpload opens the hidden file picker; _handleProjectUploadPick
// reads the selected files and routes them through _treeUploadFlatFiles so
// the same upload pipeline (toast summary, refresh, overwrite handling) is
// used for both DnD and manual uploads. `_pendingUploadDir` lets a folder
// row's context-menu "Upload Files Here…" target a sub-directory.

var _pendingUploadDir = { hub: '', explorer: '' };

function _triggerProjectUpload(stId, dirPath) {
  var st = stId === 'hub' ? _hubTreeState : _explorerTreeState;
  if (!st.srcId) { _showToast('Open a source first', true); return; }
  _pendingUploadDir[stId] = dirPath || '';
  var inputId = stId === 'hub' ? 'proj-hub-upload-input' : 'proj-explorer-upload-input';
  var input = document.getElementById(inputId);
  if (!input) { _showToast('Upload control missing', true); return; }
  // Reset value so picking the same file twice still fires `change`.
  input.value = '';
  input.click();
}

async function _handleProjectUploadPick(stId, inputEl) {
  var st = stId === 'hub' ? _hubTreeState : _explorerTreeState;
  var files = Array.from((inputEl && inputEl.files) || []);
  var baseDir = _pendingUploadDir[stId] || '';
  if (!files.length) return;
  await _treeUploadFlatFiles(st, baseDir, files, false);
  if (inputEl) inputEl.value = '';
}

// ----- Right-click context menu ---------------------------------------------
// VS Code-style popover with file/folder actions. Bound once per tree
// container (guarded via `data-ctxBound`). Rows expose `data-file-path`
// (files) or `data-dir-path` (directories); we route through the same
// helpers regardless of whether the tree is in the hub or the explorer.

var _activeProjCtxMenu = null;

function _treeBindContextMenu(st) {
  var rootId = st._id === 'hub' ? 'proj-file-tree-root' : 'proj-exp-tree';
  var el = document.getElementById(rootId);
  if (!el) return;
  if (el.dataset.ctxBound === '1') return;
  el.dataset.ctxBound = '1';
  el.addEventListener('contextmenu', function(evt) {
    var row = evt.target && evt.target.closest && evt.target.closest('.proj-file-row');
    var isDir, targetPath;
    if (!row) {
      // Empty-space right-click → root menu (Upload / New file / New folder).
      isDir = true; targetPath = '';
    } else {
      isDir = row.classList.contains('proj-tree-dir-row');
      targetPath = isDir
        ? (row.getAttribute('data-dir-path') || '')
        : (row.getAttribute('data-file-path') || '');
    }
    evt.preventDefault();
    _showProjCtxMenu(st, evt.clientX, evt.clientY, isDir, targetPath);
  });
}

function _showProjCtxMenu(st, x, y, isDir, targetPath) {
  _dismissProjCtxMenu();
  var items = [];
  if (isDir) {
    items.push({ label: 'New File…',          icon: 'ti-file-plus',   handler: function() { newProjectEntry(st._id, targetPath, 'file'); } });
    items.push({ label: 'New Folder…',        icon: 'ti-folder-plus', handler: function() { newProjectEntry(st._id, targetPath, 'dir');  } });
    items.push({ label: 'Upload Files Here…', icon: 'ti-upload',      handler: function() { _triggerProjectUpload(st._id, targetPath); } });
    if (targetPath) {
      items.push({ sep: true });
      items.push({ label: 'Reveal in Finder',    icon: 'ti-folder-open',  handler: function() { _treeRevealInFinder(st, targetPath); } });
      items.push({ label: 'Copy Path',           icon: 'ti-clipboard',     handler: function() { _treeCopyAbsPath(st, targetPath); } });
      items.push({ label: 'Copy Relative Path',  icon: 'ti-clipboard-text', handler: function() { _treeCopyRelPath(targetPath); } });
      items.push({ sep: true });
      items.push({ label: 'Rename…',             icon: 'ti-edit',          handler: function() { _treeRenameEntry(st, targetPath, true); } });
      items.push({ label: 'Delete',              icon: 'ti-trash', danger: true, handler: function() { _treeDeleteEntry(st, targetPath, true); } });
    }
  } else {
    items.push({ label: 'Open',                  icon: 'ti-file',         handler: function() { _treeOpenFile(st._id, targetPath); } });
    items.push({ sep: true });
    items.push({ label: 'Reveal in Finder',      icon: 'ti-folder-open',  handler: function() { _treeRevealInFinder(st, targetPath); } });
    items.push({ label: 'Copy Path',             icon: 'ti-clipboard',     handler: function() { _treeCopyAbsPath(st, targetPath); } });
    items.push({ label: 'Copy Relative Path',    icon: 'ti-clipboard-text', handler: function() { _treeCopyRelPath(targetPath); } });
    items.push({ sep: true });
    items.push({ label: 'Rename…',               icon: 'ti-edit',          handler: function() { _treeRenameEntry(st, targetPath, false); } });
    items.push({ label: 'Delete',                icon: 'ti-trash', danger: true, handler: function() { _treeDeleteEntry(st, targetPath, false); } });
  }

  var menu = document.createElement('div');
  menu.className = 'proj-ctx-menu';
  menu.setAttribute('role', 'menu');
  var html = '';
  for (var i = 0; i < items.length; i++) {
    var it = items[i];
    if (it.sep) { html += '<div class="proj-ctx-sep"></div>'; continue; }
    html += '<div class="proj-ctx-item' + (it.danger ? ' proj-ctx-item-danger' : '') + '" data-idx="' + i + '">' +
      '<i class="ti ' + (it.icon || 'ti-point') + '"></i>' +
      '<span>' + _projEsc(it.label) + '</span>' +
      '</div>';
  }
  menu.innerHTML = html;
  document.body.appendChild(menu);
  // Position with viewport clamping.
  var vw = window.innerWidth, vh = window.innerHeight;
  menu.style.visibility = 'hidden';
  menu.style.left = '0px'; menu.style.top = '0px';
  var r = menu.getBoundingClientRect();
  var px = x, py = y;
  if (px + r.width  > vw - 4) px = Math.max(4, vw - r.width  - 4);
  if (py + r.height > vh - 4) py = Math.max(4, vh - r.height - 4);
  menu.style.left = px + 'px';
  menu.style.top  = py + 'px';
  menu.style.visibility = '';

  menu.addEventListener('click', function(e) {
    var row = e.target.closest && e.target.closest('.proj-ctx-item');
    if (!row) return;
    var idx = parseInt(row.getAttribute('data-idx'), 10);
    var it = items[idx];
    _dismissProjCtxMenu();
    if (it && typeof it.handler === 'function') {
      try { it.handler(); } catch (err) { _showToast(err.message, true); }
    }
  });
  _activeProjCtxMenu = menu;
  // Defer the global listeners so the same click that opened the menu
  // doesn't immediately close it.
  setTimeout(function() {
    document.addEventListener('mousedown', _projCtxOutsideHandler, true);
    document.addEventListener('keydown',   _projCtxKeyHandler, true);
    window.addEventListener('blur',        _dismissProjCtxMenu);
    window.addEventListener('resize',      _dismissProjCtxMenu);
    window.addEventListener('scroll',      _dismissProjCtxMenu, true);
  }, 0);
}

function _projCtxOutsideHandler(e) {
  if (!_activeProjCtxMenu) return;
  if (_activeProjCtxMenu.contains(e.target)) return;
  _dismissProjCtxMenu();
}
function _projCtxKeyHandler(e) {
  if (e.key === 'Escape') _dismissProjCtxMenu();
}
function _dismissProjCtxMenu() {
  if (!_activeProjCtxMenu) return;
  _activeProjCtxMenu.remove();
  _activeProjCtxMenu = null;
  document.removeEventListener('mousedown', _projCtxOutsideHandler, true);
  document.removeEventListener('keydown',   _projCtxKeyHandler, true);
  window.removeEventListener('blur',        _dismissProjCtxMenu);
  window.removeEventListener('resize',      _dismissProjCtxMenu);
  window.removeEventListener('scroll',      _dismissProjCtxMenu, true);
}

async function _treeRevealInFinder(st, relPath) {
  if (!st.srcId) return;
  try {
    var url = '/api/projects/' + encodeURIComponent(state.activeProjectId) +
      '/sources/' + encodeURIComponent(st.srcId) +
      '/reveal?path=' + encodeURIComponent(relPath);
    var r = await fetch(url, { method: 'POST' });
    var j = await r.json().catch(function() { return {}; });
    if (!r.ok) { _showToast('Reveal failed: ' + (j.error || ('HTTP ' + r.status)), true); return; }
    if (j.ok === false) _showToast(j.error || 'Reveal unavailable in this context', true);
  } catch (e) { _showToast('Reveal failed: ' + e.message, true); }
}

async function _treeCopyAbsPath(st, relPath) {
  if (!st.srcId) return;
  try {
    var url = '/api/projects/' + encodeURIComponent(state.activeProjectId) +
      '/sources/' + encodeURIComponent(st.srcId) +
      '/abspath?path=' + encodeURIComponent(relPath);
    var r = await fetch(url);
    var j = await r.json().catch(function() { return {}; });
    if (!r.ok || !j.fullPath) { _showToast('Copy path failed: ' + (j.error || ('HTTP ' + r.status)), true); return; }
    await _projCopyToClipboard(j.fullPath);
    _showToast('Path copied');
  } catch (e) { _showToast('Copy path failed: ' + e.message, true); }
}

async function _treeCopyRelPath(relPath) {
  try {
    await _projCopyToClipboard(relPath);
    _showToast('Relative path copied');
  } catch (e) { _showToast('Copy failed: ' + e.message, true); }
}

function _projCopyToClipboard(text) {
  if (navigator.clipboard && navigator.clipboard.writeText) {
    return navigator.clipboard.writeText(text);
  }
  // Fallback: hidden textarea + execCommand.
  return new Promise(function(resolve, reject) {
    try {
      var ta = document.createElement('textarea');
      ta.value = text; ta.style.position = 'fixed'; ta.style.opacity = '0';
      document.body.appendChild(ta); ta.select();
      var ok = document.execCommand('copy');
      ta.remove();
      ok ? resolve() : reject(new Error('execCommand copy failed'));
    } catch (e) { reject(e); }
  });
}

async function _treeRenameEntry(st, relPath, isDir) {
  if (!st.srcId) return;
  var oldName = relPath.split('/').pop();
  var parent = relPath.split('/').slice(0, -1).join('/');
  var newName = await _projPrompt({
    title: isDir ? 'Rename folder' : 'Rename file',
    label: 'New name',
    placeholder: oldName,
    defaultValue: oldName,
    submit: 'Rename',
    validate: function(v) {
      v = (v || '').trim();
      if (!v) return 'Name is required.';
      if (v === oldName) return 'Name unchanged.';
      if (v.indexOf('\\') !== -1) return 'Use forward slashes for paths.';
      var segs = v.split('/').filter(Boolean);
      for (var i = 0; i < segs.length; i++) {
        if (segs[i] === '.' || segs[i] === '..') return 'Path traversal not allowed.';
      }
      return null;
    },
  });
  if (!newName) return;
  newName = newName.trim();
  var newRel = parent ? (parent + '/' + newName) : newName;
  try {
    var url = '/api/projects/' + encodeURIComponent(state.activeProjectId) +
      '/sources/' + encodeURIComponent(st.srcId) + '/entry';
    var r = await fetch(url, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ oldPath: relPath, newPath: newRel }),
    });
    var j = await r.json().catch(function() { return {}; });
    if (!r.ok) { _showToast('Rename failed: ' + (j.error || ('HTTP ' + r.status)), true); return; }
    if (!isDir && st.openedFiles && st.openedFiles[relPath]) {
      st.openedFiles[newRel] = st.openedFiles[relPath];
      delete st.openedFiles[relPath];
    }
    // Drop cache keys under the old prefix so the refresh picks up the new layout.
    var keys = Object.keys(st.dirCache);
    for (var i = 0; i < keys.length; i++) {
      var k = keys[i];
      if (k === relPath || k.indexOf(relPath + '/') === 0) delete st.dirCache[k];
    }
    await _treeRefreshDirs(st, [parent]);
    _showToast('Renamed');
  } catch (e) { _showToast('Rename failed: ' + e.message, true); }
}

async function _treeDeleteEntry(st, relPath, isDir) {
  if (!st.srcId) return;
  var label = isDir ? ('folder "' + relPath + '" and all its contents') : ('file "' + relPath + '"');
  var ok = await _projConfirm('Permanently delete ' + label + '? This cannot be undone.');
  if (!ok) return;
  try {
    var url = '/api/projects/' + encodeURIComponent(state.activeProjectId) +
      '/sources/' + encodeURIComponent(st.srcId) +
      '/entry?path=' + encodeURIComponent(relPath);
    var r = await fetch(url, { method: 'DELETE' });
    var j = await r.json().catch(function() { return {}; });
    if (!r.ok) { _showToast('Delete failed: ' + (j.error || ('HTTP ' + r.status)), true); return; }
    if (st.openedFiles) {
      Object.keys(st.openedFiles).forEach(function(k) {
        if (k === relPath || (isDir && k.indexOf(relPath + '/') === 0)) {
          delete st.openedFiles[k];
        }
      });
    }
    var parent = relPath.split('/').slice(0, -1).join('/');
    var keys = Object.keys(st.dirCache);
    for (var i = 0; i < keys.length; i++) {
      var k = keys[i];
      if (k === relPath || k.indexOf(relPath + '/') === 0) delete st.dirCache[k];
    }
    await _treeRefreshDirs(st, [parent]);
    _showToast('Deleted');
  } catch (e) { _showToast('Delete failed: ' + e.message, true); }
}

function _treeReadDataTransferEntries(dt) {
  var out = [];
  if (!dt || !dt.items) return out;
  for (var i = 0; i < dt.items.length; i++) {
    var it = dt.items[i];
    if (it.kind !== 'file') continue;
    var entry = typeof it.webkitGetAsEntry === 'function' ? it.webkitGetAsEntry() : null;
    if (entry) out.push(entry);
  }
  return out;
}

// Recursively walk a FileSystemEntry and POST every File found. Returns
// counts so we can summarise in a single toast at the end.
async function _treeUploadEntries(st, baseDir, entries, overwrite) {
  var stats = { uploaded: 0, skipped: 0, failed: 0, dirs: new Set([baseDir]) };
  for (var i = 0; i < entries.length; i++) {
    await _treeWalkEntry(st, baseDir, entries[i], overwrite, stats);
  }
  await _treeRefreshDirs(st, Array.from(stats.dirs));
  _treeSummariseUpload(stats);
}

async function _treeWalkEntry(st, baseDir, entry, overwrite, stats) {
  if (!entry) return;
  if (entry.isFile) {
    var file = await new Promise(function(resolve) { entry.file(resolve, function() { resolve(null); }); });
    if (!file) { stats.failed++; return; }
    // entry.fullPath starts with '/' and reflects the dropped folder layout.
    var relInner = entry.fullPath ? entry.fullPath.replace(/^\//, '') : entry.name;
    var rel = _joinPath(baseDir, relInner);
    var parent = rel.split('/').slice(0, -1).join('/');
    stats.dirs.add(parent);
    var ok = await _treeUploadOne(st, rel, file, overwrite);
    if (ok === 'uploaded') stats.uploaded++;
    else if (ok === 'skipped') stats.skipped++;
    else stats.failed++;
  } else if (entry.isDirectory) {
    var reader = entry.createReader();
    var children = await _readAllDirEntries(reader);
    for (var i = 0; i < children.length; i++) {
      await _treeWalkEntry(st, baseDir, children[i], overwrite, stats);
    }
  }
}

function _readAllDirEntries(reader) {
  return new Promise(function(resolve) {
    var all = [];
    function pump() {
      reader.readEntries(function(batch) {
        if (!batch.length) { resolve(all); return; }
        all = all.concat(Array.from(batch));
        pump();
      }, function() { resolve(all); });
    }
    pump();
  });
}

async function _treeUploadFlatFiles(st, baseDir, files, overwrite) {
  var stats = { uploaded: 0, skipped: 0, failed: 0, dirs: new Set([baseDir]) };
  for (var i = 0; i < files.length; i++) {
    var f = files[i];
    var rel = _joinPath(baseDir, f.name);
    var ok = await _treeUploadOne(st, rel, f, overwrite);
    if (ok === 'uploaded') stats.uploaded++;
    else if (ok === 'skipped') stats.skipped++;
    else stats.failed++;
  }
  await _treeRefreshDirs(st, Array.from(stats.dirs));
  _treeSummariseUpload(stats);
}

async function _treeUploadOne(st, relPath, file, overwrite) {
  try {
    var buf = await file.arrayBuffer();
    var url = '/api/projects/' + encodeURIComponent(state.activeProjectId) +
      '/sources/' + encodeURIComponent(st.srcId) +
      '/upload?path=' + encodeURIComponent(relPath) +
      (overwrite ? '&overwrite=1' : '');
    var r = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/octet-stream' },
      body: buf,
    });
    if (r.ok) return 'uploaded';
    if (r.status === 409) return 'skipped';
    var msg = '';
    try { var j = await r.json(); msg = j && j.error; } catch (_) {}
    _showToast('Upload failed: ' + relPath + ' — ' + (msg || ('HTTP ' + r.status)), true);
    return 'failed';
  } catch (e) {
    _showToast('Upload failed: ' + relPath + ' — ' + e.message, true);
    return 'failed';
  }
}

async function _treeRefreshDirs(st, dirs) {
  var unique = Array.from(new Set(dirs));
  // Shallowest first so a parent's cache is loaded before its newly-added subdirs.
  unique.sort(function(a, b) { return a.split('/').length - b.split('/').length; });
  for (var i = 0; i < unique.length; i++) {
    var dir = unique[i];
    try {
      var r = await fetch('/api/projects/' + encodeURIComponent(state.activeProjectId) +
        '/sources/' + encodeURIComponent(st.srcId) +
        '/files?path=' + encodeURIComponent(dir));
      var files = await r.json();
      st.dirCache[dir] = r.ok ? files : [];
      if (dir) st.expanded[dir] = true;
    } catch (_) {}
  }
  _treeRender(st);
}

function _treeSummariseUpload(stats) {
  var parts = [];
  if (stats.uploaded) parts.push(stats.uploaded + ' uploaded');
  if (stats.skipped)  parts.push(stats.skipped + ' skipped (exists — hold Option to overwrite)');
  if (stats.failed)   parts.push(stats.failed + ' failed');
  if (!parts.length) return;
  _showToast(parts.join(' · '), stats.failed > 0 && stats.uploaded === 0);
}

function _joinPath(dir, name) {
  var clean = String(name || '').replace(/\\/g, '/').replace(/^\/+/, '');
  if (!dir) return clean;
  return dir.replace(/\/+$/, '') + '/' + clean;
}

async function _treeInit(st, srcId) {
  if (!state.activeProjectId) return;
  st.srcId = srcId;
  st.dirCache = {};
  st.expanded = {};
  var el = document.getElementById(st._id === 'hub' ? 'proj-file-tree-root' : 'proj-exp-tree');
  if (el) el.innerHTML = '<div class="proj-loading"><i class="ti ti-loader-2 spin"></i> Loading…</div>';
  try {
    var r = await fetch('/api/projects/' + state.activeProjectId + '/sources/' + srcId + '/files?path=');
    var files = await r.json();
    if (!r.ok) { if (el) el.innerHTML = '<div class="proj-hub-error">' + _projEsc(files.error) + '</div>'; return; }
    st.dirCache[''] = files;
    _treeRender(st);
    _treeBindDnd(st);
    _treeBindContextMenu(st);
  } catch(e) { if (el) el.innerHTML = '<div class="proj-hub-error">' + _projEsc(e.message) + '</div>'; }
}

async function loadProjectFileTree(srcId /*, subPath ignored — tree always starts at root */) {
  if (_projFileSearchState.agentRunning && _hubTreeState.srcId && _hubTreeState.srcId !== srcId) {
    cancelProjectAgentSearch();
  }
  _projFileSearchState.requestSeq++;
  state._projectFileSrcId = srcId;
  await _treeInit(_hubTreeState, srcId);
  if (_projFileSearchState.visible && _projFileSearchState.query) runProjectFileSearch();
}

// Prompt the user for a name then create a new file or directory inside
// the source rooted under `parentPath` (empty string = source root). On
// success the parent dir's cache is invalidated, the parent is expanded,
// the tree is re-rendered, and (for files) the new file is opened.
async function newProjectEntry(stId, parentPath, type) {
  var st = stId === 'hub' ? _hubTreeState : _explorerTreeState;
  if (!st.srcId) { _showToast('Open a source first', true); return; }
  if (!state.activeProjectId) return;
  var label = type === 'dir' ? 'New folder name' : 'New file name';
  var placeholder = type === 'dir' ? 'utils' : 'notes.md';
  var name = await _projPrompt({
    title: type === 'dir' ? 'Create folder' : 'Create file',
    label: label + (parentPath ? ' (in ' + parentPath + ')' : ''),
    placeholder: placeholder,
    submit: 'Create',
    validate: function(v) {
      v = (v || '').trim();
      if (!v) return 'Name is required.';
      if (v.indexOf('\\') !== -1) return 'Use forward slashes for paths.';
      var segs = v.split('/').filter(Boolean);
      if (!segs.length) return 'Name is required.';
      for (var i = 0; i < segs.length; i++) {
        if (segs[i] === '.' || segs[i] === '..') return 'Path traversal not allowed.';
      }
      return null;
    },
  });
  if (name === null) return;
  name = name.trim();
  if (!name) return;
  var relPath = parentPath ? (parentPath.replace(/\/+$/, '') + '/' + name) : name;
  try {
    var r = await fetch('/api/projects/' + encodeURIComponent(state.activeProjectId) +
      '/sources/' + encodeURIComponent(st.srcId) + '/entry', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: relPath, type: type }),
    });
    var data = null; try { data = await r.json(); } catch (_) {}
    if (!r.ok) throw new Error((data && data.error) || ('HTTP ' + r.status));
    // Refresh the parent dir's cache so the new entry shows up.
    var parentKey = parentPath || '';
    try {
      var rl = await fetch('/api/projects/' + encodeURIComponent(state.activeProjectId) +
        '/sources/' + encodeURIComponent(st.srcId) + '/files?path=' + encodeURIComponent(parentKey));
      var files = await rl.json();
      st.dirCache[parentKey] = rl.ok ? files : [];
    } catch (_) {}
    // Make sure the parent is expanded so the new row is visible.
    if (parentKey) st.expanded[parentKey] = true;
    _treeRender(st);
    _showToast((type === 'dir' ? 'Created folder ' : 'Created file ') + relPath);
    // Auto-open new files for editing.
    if (type === 'file') {
      _treeMarkOpened(st, relPath);
      _treeRender(st);
      if (stId === 'hub') openProjectFile(st.srcId, relPath);
      else explorerOpenFile(st.srcId, relPath);
    }
  } catch (e) {
    _showToast('Create failed: ' + e.message, true);
  }
}

// ── Monaco file viewer ────────────────────────────────────────────────────

var _projMonacoEditor  = null;
var _projMonacoLoaded  = false;
var _projMonacoSrcId   = null;   // srcId of file currently shown
var _projMonacoBaseline = '';
var _explorerMonacoBaseline = '';

function _setProjectSaveDirty(scope, dirty) {
  var selector = scope === 'explorer'
    ? '#proj-exp-viewer .proj-save-btn'
    : '#proj-file-viewer-header .proj-save-btn';
  var button = document.querySelector(selector);
  if (!button) return;
  button.disabled = !dirty;
  button.classList.toggle('dirty', !!dirty);
}

// Map file extension → Monaco language id
var _MONO_LANG = {
  js:'javascript', mjs:'javascript', cjs:'javascript',
  ts:'typescript', tsx:'typescript', jsx:'javascript',
  json:'json', jsonc:'json',
  html:'html', htm:'html',
  css:'css', scss:'scss', sass:'scss', less:'less',
  md:'markdown', markdown:'markdown', mdx:'markdown',
  py:'python', rb:'ruby', php:'php',
  go:'go', rs:'rust', java:'java',
  c:'c', cpp:'cpp', h:'c', hpp:'cpp', hh:'cpp', cc:'cpp',
  cs:'csharp', vb:'vb',
  sh:'shell', bash:'shell', zsh:'shell', fish:'shell',
  bat:'bat', cmd:'bat', ps1:'powershell', psm1:'powershell',
  sql:'sql', graphql:'graphql', gql:'graphql', graphqls:'graphql',
  yaml:'yaml', yml:'yaml', toml:'ini',
  xml:'xml', svg:'xml', plist:'xml',
  swift:'swift', kt:'kotlin', kts:'kotlin', dart:'dart',
  ex:'elixir', exs:'elixir', lua:'lua',
  tf:'hcl', tfvars:'hcl', bicep:'bicep',
  conf:'ini', ini:'ini', cfg:'ini', env:'plaintext', properties:'ini',
  txt:'plaintext', log:'plaintext', csv:'plaintext',
  r:'r', m:'objective-c', mm:'objective-c',
  pl:'perl', hs:'haskell', ml:'fsharp',
  scala:'scala', groovy:'groovy', clj:'clojure', cljs:'clojure',
  dockerfile:'dockerfile', makefile:'plaintext',
  svelte:'html', vue:'html', astro:'html',
  prisma:'graphql', proto:'protobuf',
  diff:'plaintext', patch:'plaintext',
  // Extensionless basenames (sent as ext from server fallback)
  license:'plaintext', licence:'plaintext', readme:'markdown',
  changelog:'markdown', authors:'plaintext', codeowners:'plaintext',
  gemfile:'ruby', rakefile:'ruby', vagrantfile:'ruby',
  procfile:'yaml', brewfile:'ruby',
};

async function openProjectFile(srcId, filePath) {
  if (!state.activeProjectId) return;
  var viewerEl = document.getElementById('proj-file-viewer');
  if (!viewerEl) return;
  viewerEl.style.display = '';

  // Initialize structure if not already present
  if (!document.getElementById('proj-file-viewer-body')) {
    viewerEl.innerHTML =
      '<div class="proj-file-viewer-header" id="proj-file-viewer-header"></div>' +
      '<div id="proj-file-viewer-body" class="proj-file-viewer-body"></div>';
  }

  var headerEl = document.getElementById('proj-file-viewer-header');
  if (headerEl) headerEl.innerHTML = '<span class="proj-loading"><i class="ti ti-loader-2 spin"></i> Loading…</span>';

  try {
    var r = await fetch('/api/projects/' + state.activeProjectId + '/sources/' + srcId + '/file?path=' + encodeURIComponent(filePath));
    var data = await r.json();
    if (!r.ok) {
      viewerEl.innerHTML = '<div class="proj-hub-error">' + _projEsc(data.error) + '</div>';
      _projMonacoEditor = null;
      return;
    }
    window._lastProjectFileContent = data.type === 'text' ? data.content : null;
    window._lastProjectFileSrcId   = srcId;
    window._lastProjectFilePath    = filePath;

    var rawUrl = '/api/projects/' + state.activeProjectId + '/sources/' + encodeURIComponent(srcId) + '/raw?path=' + encodeURIComponent(filePath);
    var fname  = filePath.split('/').pop();

    // Render header with type-appropriate buttons
    if (headerEl) {
      var headerBtns = '';
      if (data.type === 'text') {
        var canEdit = _activeProject() && _activeProject().allowFileEditing;
        headerBtns =
          (canEdit ? '<button class="proj-icon-btn proj-save-btn" onclick="saveProjectFile()" title="Save file" disabled><i class="ti ti-device-floppy"></i> Save</button>' : '') +
          (canEdit ? '<button class="proj-icon-btn" onclick="projUndoFile()" title="Undo"><i class="ti ti-arrow-back-up"></i></button>' : '') +
          (canEdit ? '<button class="proj-icon-btn" onclick="projRedoFile()" title="Redo"><i class="ti ti-arrow-forward-up"></i></button>' : '') +
          '<button class="proj-icon-btn" onclick="saveFileAsContext(\'' + _projEsc(srcId) + '\',\'' + _projEsc(filePath) + '\')" title="Save as context"><i class="ti ti-folder-plus"></i> Save to Project</button>' +
          '<button class="proj-icon-btn" onclick="copyFileContent()" title="Copy"><i class="ti ti-copy"></i></button>';
      } else {
        headerBtns = '<a class="proj-icon-btn" href="' + rawUrl + '" download="' + _projEsc(fname) + '" title="Download"><i class="ti ti-download"></i></a>';
      }
      headerEl.innerHTML =
        '<span class="proj-file-viewer-path">' + _projEsc(filePath) + '</span>' +
        '<span class="proj-file-viewer-size">' + _fmtSize(data.size) + '</span>' +
        headerBtns +
        '<button class="proj-icon-btn" onclick="closeProjectFileViewer()" title="Close"><i class="ti ti-x"></i></button>';
    }

    var bodyEl = document.getElementById('proj-file-viewer-body');
    if (!bodyEl) return;

    if (data.type === 'text') {
      var ext  = (data.ext || '').toLowerCase();
      var lang = _MONO_LANG[ext] || 'plaintext';
      // Create Monaco container if not present (first open, or switching from binary)
      if (!document.getElementById('proj-monaco-container')) {
        if (_projMonacoEditor) { _projMonacoEditor.dispose(); _projMonacoEditor = null; }
        bodyEl.innerHTML = '<div id="proj-monaco-container" class="proj-monaco-container"></div>';
      }
      _mountProjectMonaco(data.content, lang);
    } else {
      // Dispose Monaco if active, then render appropriate view
      if (_projMonacoEditor) { _projMonacoEditor.dispose(); _projMonacoEditor = null; }
      switch (data.type) {
        case 'image':
          bodyEl.innerHTML =
            '<div class="proj-file-media-wrap">' +
              '<img class="proj-file-img" src="' + rawUrl + '" alt="' + _projEsc(fname) + '">' +
            '</div>';
          break;
        case 'video':
          bodyEl.innerHTML =
            '<div class="proj-file-media-wrap">' +
              '<video class="proj-file-video" controls>' +
                '<source src="' + rawUrl + '" type="' + _projEsc(data.mime) + '">' +
                'Your browser cannot play this video.' +
              '</video>' +
            '</div>';
          break;
        case 'audio':
          bodyEl.innerHTML =
            '<div class="proj-file-audio-wrap">' +
              '<i class="ti ti-music proj-file-audio-icon"></i>' +
              '<div class="proj-file-audio-name">' + _projEsc(fname) + '</div>' +
              '<audio class="proj-file-audio" controls>' +
                '<source src="' + rawUrl + '" type="' + _projEsc(data.mime) + '">' +
                'Your browser cannot play this audio.' +
              '</audio>' +
            '</div>';
          break;
        case 'pdf':
          bodyEl.innerHTML =
            '<iframe class="proj-file-pdf" src="' + rawUrl + '" title="' + _projEsc(fname) + '"></iframe>';
          break;
        case 'office': {
          var officeIconMap = {
            doc:'ti-file-word', docx:'ti-file-word',
            xls:'ti-file-spreadsheet', xlsx:'ti-file-spreadsheet',
            ppt:'ti-presentation', pptx:'ti-presentation',
            odt:'ti-file-text', ods:'ti-file-text', odp:'ti-presentation',
          };
          var officeIco = officeIconMap[data.ext] || 'ti-file-description';
          bodyEl.innerHTML =
            '<div class="proj-file-binary-wrap">' +
              '<i class="ti ' + officeIco + ' proj-file-binary-icon"></i>' +
              '<div class="proj-file-binary-name">' + _projEsc(fname) + '</div>' +
              '<div class="proj-file-binary-size">' + _fmtSize(data.size) + '</div>' +
              '<div class="proj-file-binary-note">Office documents cannot be previewed in-browser</div>' +
              '<a class="proj-action-btn" href="' + rawUrl + '" download="' + _projEsc(fname) + '"><i class="ti ti-download"></i> Download</a>' +
            '</div>';
          break;
        }
        default:
          bodyEl.innerHTML =
            '<div class="proj-file-binary-wrap">' +
              '<i class="ti ti-file-unknown proj-file-binary-icon"></i>' +
              '<div class="proj-file-binary-name">' + _projEsc(fname) + '</div>' +
              '<div class="proj-file-binary-size">' + _fmtSize(data.size) + '</div>' +
              '<a class="proj-action-btn" href="' + rawUrl + '" download="' + _projEsc(fname) + '"><i class="ti ti-download"></i> Download</a>' +
            '</div>';
      }
    }
  } catch(e) {
    viewerEl.innerHTML = '<div class="proj-hub-error">' + _projEsc(e.message) + '</div>';
    _projMonacoEditor = null;
  }
}

function _mountProjectMonaco(content, lang) {
  var container = document.getElementById('proj-monaco-container');
  if (!container) return;
  _projMonacoBaseline = content;
  _setProjectSaveDirty('hub', false);

  // If editor already exists, just swap content and language
  if (_projMonacoEditor) {
    var model = _projMonacoEditor.getModel();
    if (model) {
      monaco.editor.setModelLanguage(model, lang);
      _projMonacoEditor.setValue(content);
    }
    return;
  }

  // Monaco not loaded yet — try to load it
  if (typeof require === 'undefined') {
    _projMonacoFallback(container, content);
    return;
  }

  require.config({ paths: { vs: 'https://cdn.jsdelivr.net/npm/monaco-editor@0.44.0/min/vs' } });
  require(['vs/editor/editor.main'], function() {
    _projMonacoLoaded = true;
    // Clear any fallback content
    container.innerHTML = '';
    _projMonacoEditor = monaco.editor.create(container, {
      value: content,
      language: lang,
      theme: 'vs-dark',
      readOnly: !(_activeProject() && _activeProject().allowFileEditing),
      fontSize: 12,
      fontFamily: "'Cascadia Code','JetBrains Mono','Fira Code',Menlo,Consolas,monospace",
      lineNumbers: 'on',
      minimap: { enabled: false },
      scrollBeyondLastLine: false,
      automaticLayout: true,
      wordWrap: 'off',
      renderLineHighlight: 'line',
      folding: true,
      scrollbar: { verticalScrollbarSize: 6, horizontalScrollbarSize: 6 },
      padding: { top: 8, bottom: 8 },
    });
    // Cmd+S (macOS) / Ctrl+S (Windows/Linux) saves the file from inside Monaco.
    _projMonacoEditor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, function() {
      if (typeof saveProjectFile === 'function') saveProjectFile();
    });
    _projMonacoEditor.onDidChangeModelContent(function() {
      _setProjectSaveDirty('hub', _projMonacoEditor.getValue() !== _projMonacoBaseline);
    });
  });
}

function _projMonacoFallback(container, content) {
  // Plain pre/code fallback when Monaco loader isn't available
  container.innerHTML = '<pre class="proj-file-code"><code>' + _projEsc(content) + '</code></pre>';
}

function closeProjectFileViewer() {
  var viewerEl = document.getElementById('proj-file-viewer');
  if (viewerEl) viewerEl.style.display = 'none';
  // Dispose editor so it doesn't hold memory when switching tabs
  if (_projMonacoEditor) {
    _projMonacoEditor.dispose();
    _projMonacoEditor = null;
  }
}

function copyFileContent() {
  if (window._lastProjectFileContent) navigator.clipboard.writeText(window._lastProjectFileContent).catch(function(){});
}

function projUndoFile() {
  var ed = _explorerMonaco || _projMonacoEditor;
  if (ed) ed.trigger('keyboard', 'undo', null);
}

function projRedoFile() {
  var ed = _explorerMonaco || _projMonacoEditor;
  if (ed) ed.trigger('keyboard', 'redo', null);
}

async function saveProjectFile() {
  var srcId    = window._lastProjectFileSrcId;
  var filePath = window._lastProjectFilePath;
  if (!srcId || !filePath || !state.activeProjectId) return;
  // Get content from whichever Monaco is active
  var content = _explorerMonaco ? _explorerMonaco.getValue()
              : _projMonacoEditor ? _projMonacoEditor.getValue()
              : null;
  if (content === null) { _showToast('Nothing to save', true); return; }
  var scope = _explorerMonaco ? 'explorer' : 'hub';
  var baseline = scope === 'explorer' ? _explorerMonacoBaseline : _projMonacoBaseline;
  if (content === baseline) { _setProjectSaveDirty(scope, false); return; }
  try {
    var r = await fetch('/api/projects/' + state.activeProjectId + '/sources/' + encodeURIComponent(srcId) + '/file?path=' + encodeURIComponent(filePath), {
      method: 'PUT', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content })
    });
    if (!r.ok) throw new Error((await r.json()).error);
    if (scope === 'explorer') _explorerMonacoBaseline = content;
    else _projMonacoBaseline = content;
    window._lastProjectFileContent = content;
    _setProjectSaveDirty(scope, false);
    _showToast('Saved \u2713 ' + filePath.split('/').pop());
  } catch(e) { _showToast('Save failed: ' + e.message, true); }
}

// ── Full-screen File Explorer ─────────────────────────────────────────────

var _explorerMonaco = null;

function openProjectFileExplorer() {
  var proj = _activeProject();
  if (!proj || !proj.sources || !proj.sources.length) return;

  var existing = document.getElementById('proj-explorer-overlay');
  if (existing) { existing.remove(); _explorerMonacoDispose(); return; }

  var srcOptions = proj.sources.map(function(s) {
    return '<option value="' + _projEsc(s.id) + '">' + _projEsc(s.name) + '</option>';
  }).join('');
  var activeSrcId = state._projectFileSrcId || proj.sources[0].id;

  var overlay = document.createElement('div');
  overlay.id = 'proj-explorer-overlay';
  overlay.className = 'proj-explorer-overlay';
  overlay.innerHTML =
    '<div class="proj-explorer-panel">' +
      '<div class="proj-explorer-header">' +
        '<i class="ti ti-folder-open" style="color:var(--accent)"></i>' +
        '<span class="proj-explorer-title">' + _projEsc(proj.name) + ' — Files</span>' +
        '<select class="proj-src-select proj-explorer-src-select" id="proj-exp-src" onchange="explorerLoadTree(this.value,\'\')">' + srcOptions + '</select>' +
        '<button class="proj-icon-btn" onclick="newProjectEntry(\'explorer\', \'\', \'file\')" title="New file"><i class="ti ti-file-plus"></i></button>' +
        '<button class="proj-icon-btn" onclick="newProjectEntry(\'explorer\', \'\', \'dir\')" title="New folder"><i class="ti ti-folder-plus"></i></button>' +
        '<button class="proj-icon-btn" onclick="_triggerProjectUpload(\'explorer\', \'\')" title="Upload files"><i class="ti ti-upload"></i></button>' +
        '<button class="proj-icon-btn" onclick="explorerLoadTree(document.getElementById(\'proj-exp-src\').value,\'\')" title="Refresh"><i class="ti ti-refresh"></i></button>' +
        '<button class="proj-icon-btn" onclick="closeProjectFileExplorer()" title="Close"><i class="ti ti-x"></i></button>' +
        '<input id="proj-explorer-upload-input" type="file" multiple style="display:none" onchange="_handleProjectUploadPick(\'explorer\', this)"/>' +
      '</div>' +
      '<div class="proj-explorer-body">' +
        '<div class="proj-explorer-tree" id="proj-exp-tree"></div>' +
        '<div class="proj-explorer-viewer" id="proj-exp-viewer">' +
          '<div class="proj-explorer-viewer-empty"><i class="ti ti-file-code" style="font-size:40px;opacity:.2"></i><div>Select a file to view</div></div>' +
        '</div>' +
      '</div>' +
    '</div>';
  document.body.appendChild(overlay);
  explorerLoadTree(activeSrcId, '');
}

function closeProjectFileExplorer() {
  _explorerMonacoDispose();
  var el = document.getElementById('proj-explorer-overlay');
  if (el) el.remove();
}

function _explorerMonacoDispose() {
  if (_explorerMonaco) { _explorerMonaco.dispose(); _explorerMonaco = null; }
}

async function explorerLoadTree(srcId /*, subPath ignored — tree always starts at root */) {
  state._projectFileSrcId = srcId;
  // Preserve expanded/opened state when the same source is already loaded
  if (_explorerTreeState.srcId === srcId && _explorerTreeState.dirCache['']) {
    _treeRender(_explorerTreeState);
    return;
  }
  await _treeInit(_explorerTreeState, srcId);
}

async function explorerOpenFile(srcId, filePath) {
  if (!state.activeProjectId) return;
  var viewerEl = document.getElementById('proj-exp-viewer');
  if (!viewerEl) return;
  viewerEl.innerHTML = '<div class="proj-loading"><i class="ti ti-loader-2 spin"></i> Loading…</div>';
  _explorerMonacoDispose();
  try {
    var r = await fetch('/api/projects/' + state.activeProjectId + '/sources/' + srcId + '/file?path=' + encodeURIComponent(filePath));
    var data = await r.json();
    if (!r.ok) { viewerEl.innerHTML = '<div class="proj-hub-error">' + _projEsc(data.error) + '</div>'; return; }
    window._lastProjectFileContent = data.type === 'text' ? data.content : null;
    window._lastProjectFileSrcId = srcId;
    window._lastProjectFilePath  = filePath;
    var fname  = filePath.split('/').pop();
    var rawUrl = '/api/projects/' + state.activeProjectId + '/sources/' + encodeURIComponent(srcId) + '/raw?path=' + encodeURIComponent(filePath);
    var canEdit2 = _activeProject() && _activeProject().allowFileEditing;
    var headerBtns = data.type === 'text'
      ? (canEdit2 ? '<button class="proj-icon-btn proj-save-btn" onclick="saveProjectFile()" title="Save file" disabled><i class="ti ti-device-floppy"></i> Save</button>' : '') +
        (canEdit2 ? '<button class="proj-icon-btn" onclick="projUndoFile()" title="Undo"><i class="ti ti-arrow-back-up"></i></button>' : '') +
        (canEdit2 ? '<button class="proj-icon-btn" onclick="projRedoFile()" title="Redo"><i class="ti ti-arrow-forward-up"></i></button>' : '') +
        '<button class="proj-icon-btn" onclick="saveFileAsContext(\'' + _projEsc(srcId) + '\',\'' + _projEsc(filePath) + '\')" title="Save as context"><i class="ti ti-folder-plus"></i> Save to Project</button>' +
        '<button class="proj-icon-btn" onclick="copyFileContent()" title="Copy"><i class="ti ti-copy"></i></button>'
      : '<button class="proj-icon-btn" onclick="saveFileAsContext(\'' + _projEsc(srcId) + '\',\'' + _projEsc(filePath) + '\')" title="Save as context"><i class="ti ti-folder-plus"></i> Save to Project</button>' +
        '<a class="proj-icon-btn" href="' + rawUrl + '" download="' + _projEsc(fname) + '" title="Download"><i class="ti ti-download"></i></a>';
    viewerEl.innerHTML =
      '<div class="proj-file-viewer-header">' +
        '<span class="proj-file-viewer-path">' + _projEsc(filePath) + '</span>' +
        '<span class="proj-file-viewer-size">' + _fmtSize(data.size) + '</span>' +
        headerBtns +
      '</div>' +
      '<div id="proj-exp-monaco" class="proj-explorer-monaco"></div>';
    var bodyEl2 = document.getElementById('proj-exp-monaco');
    if (data.type === 'text') {
      var ext = (data.ext || '').toLowerCase();
      var lang = _MONO_LANG[ext] || 'plaintext';
      _mountExplorerMonaco(data.content, lang);
    } else if (data.type === 'image') {
      if (bodyEl2) bodyEl2.innerHTML =
        '<div class="proj-file-media-wrap">' +
          '<img class="proj-file-img" src="' + rawUrl + '" alt="' + _projEsc(fname) + '">' +
        '</div>';
    } else if (data.type === 'video') {
      if (bodyEl2) bodyEl2.innerHTML =
        '<div class="proj-file-media-wrap">' +
          '<video class="proj-file-video" controls>' +
            '<source src="' + rawUrl + '" type="' + _projEsc(data.mime) + '">' +
            'Your browser cannot play this video.' +
          '</video>' +
        '</div>';
    } else if (data.type === 'audio') {
      if (bodyEl2) bodyEl2.innerHTML =
        '<div class="proj-file-audio-wrap">' +
          '<i class="ti ti-music proj-file-audio-icon"></i>' +
          '<div class="proj-file-audio-name">' + _projEsc(fname) + '</div>' +
          '<audio class="proj-file-audio" controls>' +
            '<source src="' + rawUrl + '" type="' + _projEsc(data.mime) + '">' +
            'Your browser cannot play this audio.' +
          '</audio>' +
        '</div>';
    } else if (data.type === 'pdf') {
      if (bodyEl2) bodyEl2.innerHTML =
        '<iframe class="proj-file-pdf" src="' + rawUrl + '" title="' + _projEsc(fname) + '"></iframe>';
    } else if (data.type === 'office') {
      var officeIconMap2 = {
        doc:'ti-file-word', docx:'ti-file-word',
        xls:'ti-file-spreadsheet', xlsx:'ti-file-spreadsheet',
        ppt:'ti-presentation', pptx:'ti-presentation',
        odt:'ti-file-text', ods:'ti-file-text', odp:'ti-presentation',
      };
      var officeIco2 = officeIconMap2[data.ext] || 'ti-file-description';
      if (bodyEl2) bodyEl2.innerHTML =
        '<div class="proj-file-binary-wrap">' +
          '<i class="ti ' + officeIco2 + ' proj-file-binary-icon"></i>' +
          '<div class="proj-file-binary-name">' + _projEsc(fname) + '</div>' +
          '<div class="proj-file-binary-size">' + _fmtSize(data.size) + '</div>' +
          '<div class="proj-file-binary-note">Office documents cannot be previewed in-browser</div>' +
          '<a class="proj-action-btn" href="' + rawUrl + '" download="' + _projEsc(fname) + '"><i class="ti ti-download"></i> Download</a>' +
        '</div>';
    } else {
      if (bodyEl2) bodyEl2.innerHTML =
        '<div class="proj-file-binary-wrap">' +
          '<i class="ti ti-file-unknown proj-file-binary-icon"></i>' +
          '<div class="proj-file-binary-name">' + _projEsc(fname) + '</div>' +
          '<div class="proj-file-binary-size">' + _fmtSize(data.size) + '</div>' +
          '<a class="proj-action-btn" href="' + rawUrl + '" download="' + _projEsc(fname) + '"><i class="ti ti-download"></i> Download</a>' +
        '</div>';
    }
  } catch(e) { viewerEl.innerHTML = '<div class="proj-hub-error">' + _projEsc(e.message) + '</div>'; }
}

function _mountExplorerMonaco(content, lang) {
  var container = document.getElementById('proj-exp-monaco');
  if (!container) return;
  _explorerMonacoBaseline = content;
  _setProjectSaveDirty('explorer', false);
  if (typeof require === 'undefined') {
    container.innerHTML = '<pre class="proj-file-code"><code>' + _projEsc(content) + '</code></pre>';
    return;
  }
  require.config({ paths: { vs: 'https://cdn.jsdelivr.net/npm/monaco-editor@0.44.0/min/vs' } });
  require(['vs/editor/editor.main'], function() {
    container.innerHTML = '';
    _explorerMonaco = monaco.editor.create(container, {
      value: content, language: lang,
      theme: 'vs-dark', readOnly: !(_activeProject() && _activeProject().allowFileEditing),
      fontSize: 13,
      fontFamily: "'Cascadia Code','JetBrains Mono','Fira Code',Menlo,Consolas,monospace",
      lineNumbers: 'on', minimap: { enabled: true },
      scrollBeyondLastLine: false, automaticLayout: true,
      wordWrap: 'off', folding: true,
      scrollbar: { verticalScrollbarSize: 6, horizontalScrollbarSize: 6 },
      padding: { top: 8, bottom: 8 },
    });
    // Cmd+S (macOS) / Ctrl+S (Windows/Linux) saves the file from inside Monaco.
    _explorerMonaco.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, function() {
      if (typeof saveProjectFile === 'function') saveProjectFile();
    });
    _explorerMonaco.onDidChangeModelContent(function() {
      _setProjectSaveDirty('explorer', _explorerMonaco.getValue() !== _explorerMonacoBaseline);
    });
  });
}

async function saveFileAsContext(srcId, filePath) {
  if (!state.activeProjectId) return;
  try {
    var r = await fetch('/api/projects/' + state.activeProjectId + '/sources/' + srcId + '/file?path=' + encodeURIComponent(filePath));
    var data = await r.json();
    if (!r.ok) throw new Error(data.error);
    var r2 = await fetch('/api/projects/' + state.activeProjectId + '/contexts', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ type: 'file', name: filePath.split('/').pop(), content: data.content, srcId: srcId, path: filePath })
    });
    if (!r2.ok) throw new Error('Failed to save context');
    await _refreshProject(state.activeProjectId);
    renderProjectContextBar();
    if (state.projectHubOpen) _renderProjectHubBody(_activeProject());
    _showToast('Saved as project context');
  } catch(e) { _showToast('Error: ' + e.message, true); }
}

// ── Contexts Tab ──────────────────────────────────────────────────────────

function _renderContextsTab(proj) {
  // Merged "Contexts" tab now also shows project Sources (folders + repos).
  // Sources block comes first because they're the data inputs; contexts are
  // the curated/derived snippets that get pinned into chat.
  var srcs = proj.sources || [];
  var srcBlock = '<div class="proj-section-header">' +
      '<span>' + srcs.length + ' source' + (srcs.length !== 1 ? 's' : '') + '</span>' +
      '<button class="proj-action-btn" onclick="openAddSourceDialog()"><i class="ti ti-plus"></i> Add source</button>' +
    '</div>' +
    (srcs.length ? srcs.map(function(s) { return _renderSourceCard(proj, s); }).join('') :
      '<div class="proj-hub-empty"><i class="ti ti-folder" style="font-size:28px;opacity:.3"></i>' +
      '<div>No sources yet</div>' +
      '<div style="font-size:11px;color:var(--fau-text-dim)">Add a local folder or connect a GitHub/GitLab repo</div></div>');

  var ctxs = proj.contexts || [];
  var pinned = ctxs.filter(function(c){ return c.pinned; });
  var unpinned = ctxs.filter(function(c){ return !c.pinned; });
  var sorted = pinned.concat(unpinned);
  var ctxBlock = '<div class="proj-section-header" style="margin-top:18px">' +
      '<span>' + ctxs.length + ' context' + (ctxs.length !== 1 ? 's' : '') + '</span>' +
      '<button class="proj-action-btn" onclick="openAddContextDialog()"><i class="ti ti-plus"></i> Add context</button>' +
    '</div>' +
    (sorted.length ? sorted.map(_renderContextCard).join('') :
      '<div class="proj-hub-empty"><i class="ti ti-files" style="font-size:28px;opacity:.3"></i>' +
      '<div>No contexts yet</div>' +
      '<div style="font-size:11px;color:var(--fau-text-dim)">Save files, URLs, or AI artifacts as named contexts</div></div>');

  return srcBlock + ctxBlock;
}

function _renderContextCard(c) {
  var typeIcon = { file: 'ti-file-text', url: 'ti-link', artifact: 'ti-sparkles', snippet: 'ti-code', note: 'ti-notes' }[c.type] || 'ti-file';
  var isOn = (window.state && state.projectContextEnabled) ? state.projectContextEnabled[c.id] !== false : c.pinned;
  return '<div class="proj-ctx-card' + (c.pinned ? ' pinned' : '') + '" id="ctx-card-' + c.id + '">' +
    '<div class="proj-ctx-card-header">' +
      '<i class="ti ' + typeIcon + ' proj-ctx-icon"></i>' +
      '<span class="proj-ctx-name">' + _projEsc(c.name) + '</span>' +
      '<span class="proj-ctx-size">' + _fmtSize(c.size || 0) + '</span>' +
      '<button class="proj-ctx-pin-btn' + (c.pinned ? ' active' : '') + '" onclick="toggleContextPin(\'' + c.id + '\')" title="' + (c.pinned ? 'Unpin' : 'Pin to chat') + '"><i class="ti ti-pin' + (c.pinned ? '' : '-off') + '"></i></button>' +
      '<button class="proj-ctx-del-btn" onclick="deleteProjectContext(\'' + c.id + '\')" title="Delete"><i class="ti ti-trash"></i></button>' +
    '</div>' +
    (c.content ? '<pre class="proj-ctx-preview">' + _projEsc(c.content.slice(0, 200)) + (c.content.length > 200 ? '…' : '') + '</pre>' : '') +
  '</div>';
}

async function toggleContextPin(ctxId) {
  var proj = _activeProject();
  if (!proj) return;
  var ctx = (proj.contexts || []).find(function(c){ return c.id === ctxId; });
  if (!ctx) return;
  try {
    await fetch('/api/projects/' + proj.id + '/contexts/' + ctxId, {
      method: 'PUT', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ pinned: !ctx.pinned })
    });
    await _refreshProject(proj.id);
    renderProjectContextBar();
    _renderProjectHubBody(_activeProject());
  } catch(e) {}
}

async function deleteProjectContext(ctxId) {
  var proj = _activeProject();
  if (!proj) return;
  try {
    await fetch('/api/projects/' + proj.id + '/contexts/' + ctxId, { method: 'DELETE' });
    await _refreshProject(proj.id);
    renderProjectContextBar();
    _renderProjectHubBody(_activeProject());
  } catch(e) {}
}

function openAddContextDialog() {
  var overlay = document.createElement('div');
  overlay.className = 'proj-picker-overlay';
  overlay.innerHTML =
    '<div class="proj-picker-panel">' +
      '<div class="proj-picker-header">' +
        '<span>Add Context</span>' +
        '<button id="_acclose"><i class="ti ti-x"></i></button>' +
      '</div>' +
      '<div class="proj-ctx-add-tabs">' +
        '<button class="proj-ctx-add-tab active" id="_actab-paste" onclick="_acSwitchTab(\'paste\')"><i class="ti ti-clipboard-text"></i> Paste text</button>' +
        '<button class="proj-ctx-add-tab" id="_actab-file" onclick="_acSwitchTab(\'file\')"><i class="ti ti-paperclip"></i> Attach file</button>' +
      '</div>' +
      '<div class="proj-form" id="_ac-pane-paste">' +
        '<div class="proj-settings-row"><label>Name</label><input class="proj-input" id="_ac-name" placeholder="e.g. API spec" autocomplete="off"></div>' +
        '<div class="proj-settings-row"><label>Content</label><textarea class="proj-input proj-modal-textarea" id="_ac-content" placeholder="Paste text here…"></textarea></div>' +
      '</div>' +
      '<div class="proj-form" id="_ac-pane-file" style="display:none">' +
        '<div class="proj-settings-row"><label>Name</label><input class="proj-input" id="_ac-fname" placeholder="Auto-filled from filename" autocomplete="off"></div>' +
        '<div class="proj-ctx-file-drop" id="_ac-drop">' +
          '<i class="ti ti-upload" style="font-size:28px;opacity:.4"></i>' +
          '<span>Drop a file here, or</span>' +
          '<button class="proj-action-btn" type="button" onclick="document.getElementById(\'_ac-fileinput\').click()">Browse…</button>' +
          '<input type="file" id="_ac-fileinput" style="display:none" accept=".txt,.md,.js,.ts,.jsx,.tsx,.py,.json,.yaml,.yml,.html,.css,.csv,.xml,.sh,.env,.toml,.ini,.rs,.go,.rb,.java,.c,.cpp,.h,.swift,.kt">' +
          '<span id="_ac-filename" style="font-size:11px;color:var(--accent);display:none"></span>' +
        '</div>' +
      '</div>' +
      '<div id="_ac-err" class="proj-modal-err" style="display:none"></div>' +
      '<div class="proj-picker-footer">' +
        '<button class="proj-action-btn" id="_acsubmit">Add</button>' +
        '<button class="proj-action-btn" id="_accancel">Cancel</button>' +
      '</div>' +
    '</div>';

  document.body.appendChild(overlay);

  var _acMode = 'paste';
  var _acFileData = null; // { name, content }

  window._acSwitchTab = function(tab) {
    _acMode = tab;
    overlay.querySelector('#_actab-paste').classList.toggle('active', tab === 'paste');
    overlay.querySelector('#_actab-file').classList.toggle('active', tab === 'file');
    overlay.querySelector('#_ac-pane-paste').style.display = tab === 'paste' ? '' : 'none';
    overlay.querySelector('#_ac-pane-file').style.display  = tab === 'file'  ? '' : 'none';
  };

  // File input change
  var fileInput = overlay.querySelector('#_ac-fileinput');
  fileInput.onchange = function() {
    var f = fileInput.files[0];
    if (!f) return;
    var reader = new FileReader();
    reader.onload = function(e) {
      _acFileData = { name: f.name, content: e.target.result };
      overlay.querySelector('#_ac-filename').textContent = f.name;
      overlay.querySelector('#_ac-filename').style.display = '';
      if (!overlay.querySelector('#_ac-fname').value) {
        overlay.querySelector('#_ac-fname').value = f.name.replace(/\.[^.]+$/, '');
      }
    };
    reader.readAsText(f);
  };

  // Drag & drop
  var drop = overlay.querySelector('#_ac-drop');
  drop.addEventListener('dragover', function(e) { e.preventDefault(); drop.classList.add('dragover'); });
  drop.addEventListener('dragleave', function() { drop.classList.remove('dragover'); });
  drop.addEventListener('drop', function(e) {
    e.preventDefault(); drop.classList.remove('dragover');
    var f = e.dataTransfer.files[0];
    if (!f) return;
    fileInput.files = e.dataTransfer.files;
    fileInput.onchange();
  });

  overlay.querySelector('#_acclose').onclick  = function() { overlay.remove(); };
  overlay.querySelector('#_accancel').onclick = function() { overlay.remove(); };
  setTimeout(function() { overlay.querySelector('#_ac-name').focus(); }, 50);

  overlay.querySelector('#_acsubmit').onclick = async function() {
    var errEl = overlay.querySelector('#_ac-err');
    errEl.style.display = 'none';
    var proj = _activeProject();
    if (!proj) return;

    if (_acMode === 'paste') {
      var name = overlay.querySelector('#_ac-name').value.trim();
      var content = overlay.querySelector('#_ac-content').value;
      if (!name) { errEl.textContent = 'Name is required'; errEl.style.display = ''; return; }
      overlay.remove();
      await _addProjectContext({ type: 'snippet', name, content });

    } else {
      if (!_acFileData) { errEl.textContent = 'Please select a file'; errEl.style.display = ''; return; }
      var customName = overlay.querySelector('#_ac-fname').value.trim() || _acFileData.name;
      overlay.remove();
      try {
        var form = new FormData();
        form.append('name', customName);
        var blob = new Blob([_acFileData.content], { type: 'text/plain' });
        form.append('file', blob, _acFileData.name);
        var r = await fetch('/api/projects/' + proj.id + '/contexts/from-file', { method: 'POST', body: form });
        if (!r.ok) throw new Error((await r.json()).error);
        await _refreshProject(proj.id);
        renderProjectContextBar();
        _renderProjectHubBody(_activeProject());
      } catch(e) { _showToast('Error: ' + e.message, true); }
    }
  };

  overlay.addEventListener('keydown', function(e) {
    if (e.key === 'Escape') overlay.remove();
  });
}

async function _addProjectContext(opts) {
  var proj = _activeProject();
  if (!proj) return;
  try {
    var r = await fetch('/api/projects/' + proj.id + '/contexts', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(opts)
    });
    if (!r.ok) throw new Error((await r.json()).error);
    await _refreshProject(proj.id);
    renderProjectContextBar();
    _renderProjectHubBody(_activeProject());
  } catch(e) { _showToast('Error: ' + e.message, true); }
}

// Save an artifact to the active project (called from artifacts.js toolbar)
async function saveArtifactToProject(artifactId) {
  var proj = _activeProject();
  if (!proj) { _showToast('No active project', true); return; }
  var a = (state.artifacts || []).find(function(x) { return x.id === artifactId; });
  if (!a) { _showToast('Artifact not found', true); return; }
  try {
    var r = await fetch('/api/projects/' + proj.id + '/contexts/from-artifact', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: a.id, title: a.title, content: a.content, type: a.type })
    });
    if (!r.ok) throw new Error((await r.json()).error);
    await _refreshProject(proj.id);
    renderProjectContextBar();
    if (state.projectHubOpen) _renderProjectHubBody(_activeProject());
    _showToast('Saved to ' + proj.name);
  } catch(e) { _showToast('Error: ' + e.message, true); }
}

// ── Save a gen-ui spec to a project as a JSON context ────────────────────

async function saveGenUIToProject(specJson, title) {
  if (state.activeProjectId) {
    // Already in a project — save directly
    var proj = _activeProject();
    try {
      var r = await fetch('/api/projects/' + proj.id + '/contexts/from-artifact', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title: title || 'UI Component', content: specJson, type: 'json' })
      });
      if (!r.ok) throw new Error((await r.json()).error);
      await _refreshProject(proj.id);
      renderProjectContextBar();
      if (state.projectHubOpen) _renderProjectHubBody(_activeProject());
      _showToast('Saved to ' + proj.name);
    } catch(e) { _showToast('Error: ' + e.message, true); }
  } else {
    // Not in a project — show project picker
    _openGenUIProjectPicker(specJson, title);
  }
}

function _buildGenUIProjList(filter) {
  var q = (filter || '').toLowerCase();
  var projs = (state.projects || []).filter(function(p) {
    return !q || p.name.toLowerCase().indexOf(q) !== -1;
  });
  var rows = projs.map(function(p) {
    return '<div class="proj-picker-item" onclick="_saveGenUIToSpecificProject(\'' +
      _projEsc(p.id) + '\',document.getElementById(\'gui-proj-picker-overlay\'))">' +
      '<span class="proj-dot proj-color-' + _projEsc(p.color) + '"></span>' +
      '<span class="proj-picker-name">' + _projEsc(p.name) + '</span>' +
    '</div>';
  }).join('');
  if (!rows) rows = '<div style="padding:10px 12px;font-size:12px;color:var(--fau-text-dim)">' + (q ? 'No matches' : 'No projects yet') + '</div>';
  return rows;
}

function _openGenUIProjectPicker(specJson, title) {
  var existing = document.getElementById('gui-proj-picker-overlay');
  if (existing) existing.remove();

  var overlay = document.createElement('div');
  overlay.id = 'gui-proj-picker-overlay';
  overlay.className = 'proj-picker-overlay';
  overlay.onclick = function(e) { if (e.target === overlay) overlay.remove(); };

  overlay.innerHTML =
    '<div class="proj-picker-panel">' +
      '<div class="proj-picker-header">' +
        '<span><i class="ti ti-folder-plus"></i> Add to Project</span>' +
        '<button onclick="document.getElementById(\'gui-proj-picker-overlay\').remove()"><i class="ti ti-x"></i></button>' +
      '</div>' +
      '<div class="proj-picker-search-wrap">' +
        '<i class="ti ti-search proj-picker-search-icon"></i>' +
        '<input id="gui-proj-search" class="proj-picker-search" placeholder="Filter projects…" autocomplete="off"' +
          ' oninput="document.getElementById(\'gui-proj-list\').innerHTML=_buildGenUIProjList(this.value)">' +
      '</div>' +
      '<div class="proj-picker-list" id="gui-proj-list" style="max-height:260px">' +
        _buildGenUIProjList('') +
      '</div>' +
      '<div class="proj-picker-footer">' +
        '<div style="font-size:11px;color:var(--fau-text-muted);flex:1">Save <strong>' + _projEsc(title || 'UI Component') + '</strong> as a context</div>' +
        '<button class="proj-action-btn" onclick="_createProjectAndSaveGenUI()"><i class="ti ti-plus"></i> New project</button>' +
      '</div>' +
    '</div>';

  // Stash spec on the overlay so sub-functions can reach it
  overlay._guiSpecJson = specJson;
  overlay._guiTitle    = title;
  document.body.appendChild(overlay);
  // Auto-focus search
  setTimeout(function() {
    var inp = document.getElementById('gui-proj-search');
    if (inp) inp.focus();
  }, 50);
}

async function _saveGenUIToSpecificProject(projectId, overlay) {
  var specJson = overlay && overlay._guiSpecJson;
  var title    = overlay && overlay._guiTitle;
  if (overlay) overlay.remove();
  try {
    var r = await fetch('/api/projects/' + projectId + '/contexts/from-artifact', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: title || 'UI Component', content: specJson, type: 'json' })
    });
    if (!r.ok) throw new Error((await r.json()).error);
    var proj = state.projects.find(function(p) { return p.id === projectId; });
    await _refreshProject(projectId);
    renderProjectContextBar();
    if (state.projectHubOpen) _renderProjectHubBody(_activeProject());
    _showToast('Saved to ' + (proj ? proj.name : 'project'));
  } catch(e) { _showToast('Error: ' + e.message, true); }
}

async function _createProjectAndSaveGenUI() {
  var overlay = document.getElementById('gui-proj-picker-overlay');
  var specJson = overlay && overlay._guiSpecJson;
  var title    = overlay && overlay._guiTitle;
  if (overlay) overlay.remove();

  // Reuse the create-project dialog, then hook into submit
  openCreateProjectDialog();
  // After project creation the spec will need to be saved manually —
  // store pending data on window so submitCreateProject can pick it up
  window._pendingGenUISpec = { specJson: specJson, title: title };
}

// ── Move current conversation into a project ─────────────────────────────

function _buildMoveConvProjList(filter, convProjectId) {
  var q = (filter || '').toLowerCase();
  var projs = (state.projects || []).filter(function(p) {
    return !q || p.name.toLowerCase().indexOf(q) !== -1;
  });
  var rows = projs.map(function(p) {
    var isLinked = convProjectId === p.id;
    return '<div class="proj-picker-item' + (isLinked ? ' active' : '') + '" onclick="_linkConvToProject(\'' +
      _projEsc(p.id) + '\',document.getElementById(\'move-conv-proj-overlay\'))">' +
      '<span class="proj-dot proj-color-' + _projEsc(p.color) + '"></span>' +
      '<span class="proj-picker-name">' + _projEsc(p.name) + '</span>' +
      (isLinked ? '<span style="margin-left:auto;font-size:10px;color:var(--accent)"><i class="ti ti-check"></i></span>' : '') +
    '</div>';
  }).join('');
  if (!rows) rows = '<div style="padding:10px 12px;font-size:12px;color:var(--fau-text-dim)">' + (q ? 'No matches' : 'No projects yet') + '</div>';
  return rows;
}

function openMoveConversationToProject() {
  var conv = typeof getConv === 'function' && state.currentId ? getConv(state.currentId) : null;
  if (!conv) { _showToast('No active conversation', true); return; }

  var existing = document.getElementById('move-conv-proj-overlay');
  if (existing) existing.remove();

  var overlay = document.createElement('div');
  overlay.id = 'move-conv-proj-overlay';
  overlay.className = 'proj-picker-overlay';
  overlay.onclick = function(e) { if (e.target === overlay) overlay.remove(); };

  var removeRow = conv.projectId
    ? '<div class="proj-picker-item proj-picker-remove" onclick="_linkConvToProject(null,document.getElementById(\'move-conv-proj-overlay\'))" style="color:var(--fau-text-muted)">' +
        '<i class="ti ti-folder-x" style="font-size:13px"></i> <span>Remove from project</span>' +
      '</div>'
    : '';

  overlay.innerHTML =
    '<div class="proj-picker-panel">' +
      '<div class="proj-picker-header">' +
        '<span><i class="ti ti-folder-symlink"></i> Move to Project</span>' +
        '<button onclick="document.getElementById(\'move-conv-proj-overlay\').remove()"><i class="ti ti-x"></i></button>' +
      '</div>' +
      '<div class="proj-picker-search-wrap">' +
        '<i class="ti ti-search proj-picker-search-icon"></i>' +
        '<input id="move-conv-proj-search" class="proj-picker-search" placeholder="Filter projects…" autocomplete="off"' +
          ' oninput="document.getElementById(\'move-conv-proj-list\').innerHTML=_buildMoveConvProjList(this.value,\'' + _projEsc(conv.projectId || '') + '\')+document.getElementById(\'move-conv-proj-remove\').innerHTML">' +
      '</div>' +
      '<div class="proj-picker-list" id="move-conv-proj-list" style="max-height:260px">' +
        _buildMoveConvProjList('', conv.projectId) +
      '</div>' +
      '<div id="move-conv-proj-remove" style="display:none">' + removeRow + '</div>' +
      '<div class="proj-picker-footer">' +
        (removeRow ? '<div class="proj-picker-remove-wrap">' + removeRow + '</div>' : '') +
        '<button class="proj-action-btn" onclick="_createProjectAndMoveConv()"><i class="ti ti-plus"></i> New project</button>' +
      '</div>' +
    '</div>';

  document.body.appendChild(overlay);
  // Auto-focus search
  setTimeout(function() {
    var inp = document.getElementById('move-conv-proj-search');
    if (inp) inp.focus();
  }, 50);
}

async function _linkConvToProject(projectId, overlay) {
  if (overlay) overlay.remove();
  var conv = typeof getConv === 'function' && state.currentId ? getConv(state.currentId) : null;
  if (!conv) return;

  var oldProjectId = conv.projectId;
  conv.projectId = projectId || undefined;
  if (!projectId) delete conv.projectId;

  if (typeof saveConversations === 'function') saveConversations();
  if (typeof renderConvList === 'function') renderConvList();

  // Notify backend
  if (projectId) {
    fetch('/api/projects/' + projectId + '/conversations', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ convId: conv.id })
    }).catch(function(){});
  }

  var proj = projectId && state.projects.find(function(p) { return p.id === projectId; });
  _showToast(proj ? 'Moved to ' + proj.name : 'Removed from project');

  // Refresh topbar button state
  _updateMoveToProjectBtn();
}

async function _createProjectAndMoveConv() {
  var overlay = document.getElementById('move-conv-proj-overlay');
  if (overlay) overlay.remove();
  window._pendingMoveConvId = state.currentId;
  openCreateProjectDialog();
}

// Update the topbar "Move to Project" button visibility
function _updateMoveToProjectBtn() {
  var btn = document.getElementById('topbar-move-to-project-btn');
  if (!btn) return;
  // Show when there is no active project OR when the current conv is not in the active project
  var conv = typeof getConv === 'function' && state.currentId ? getConv(state.currentId) : null;
  var inProject = conv && conv.projectId && conv.projectId === state.activeProjectId;
  btn.style.display = inProject ? 'none' : '';
}

// ── Sources Tab ───────────────────────────────────────────────────────────

function _renderSourcesTab(proj) {
  var srcs = proj.sources || [];
  return '<div class="proj-section-header">' +
    '<span>' + srcs.length + ' source' + (srcs.length !== 1 ? 's' : '') + '</span>' +
    '<button class="proj-action-btn" onclick="openAddSourceDialog()"><i class="ti ti-plus"></i> Add source</button>' +
  '</div>' +
  (srcs.length ? srcs.map(function(s) { return _renderSourceCard(proj, s); }).join('') :
    '<div class="proj-hub-empty"><i class="ti ti-folder" style="font-size:28px;opacity:.3"></i>' +
    '<div>No sources yet</div>' +
    '<div style="font-size:11px;color:var(--fau-text-dim)">Add a local folder or connect a GitHub/GitLab repo</div></div>');
}

function _renderSourceCard(proj, s) {
  var typeIcon = { local: 'ti-folder', github: 'ti-brand-github', gitlab: 'ti-brand-gitlab', bitbucket: 'ti-brand-bitbucket' }[s.type] || 'ti-source-code';
  var statusCls = { active: 'proj-src-ok', syncing: 'proj-src-syncing', error: 'proj-src-error' }[s.status] || '';
  return '<div class="proj-src-card">' +
    '<div class="proj-src-card-header">' +
      '<i class="ti ' + typeIcon + '"></i>' +
      '<span class="proj-src-name">' + _projEsc(s.name) + '</span>' +
      '<span class="proj-src-status ' + statusCls + '">' + _projEsc(s.status) + '</span>' +
      '<button class="proj-icon-btn" onclick="syncProjectSource(\'' + s.id + '\')" title="Sync"><i class="ti ti-refresh"></i></button>' +
      '<button class="proj-icon-btn" style="color:var(--fau-text-muted)" onclick="deleteProjectSource(\'' + s.id + '\')" title="Remove"><i class="ti ti-trash"></i></button>' +
    '</div>' +
    (s.path ? '<div class="proj-src-path">' + _projEsc(s.path) + '</div>' : '') +
    (s.url && !s.path ? '<div class="proj-src-path">' + _projEsc(s.url) + '</div>' : '') +
    (s.syncedAt ? '<div class="proj-src-synced">Synced ' + _relTime(s.syncedAt) + '</div>' : '') +
    (s.error ? '<div class="proj-src-error-msg">' + _projEsc(s.error) + '</div>' : '') +
  '</div>';
}

async function syncProjectSource(srcId) {
  var proj = _activeProject();
  if (!proj) return;
  try {
    var r = await fetch('/api/projects/' + proj.id + '/sources/' + srcId + '/sync', { method: 'POST' });
    var data = await r.json();
    if (!r.ok) throw new Error(data.error);
    await _refreshProject(proj.id);
    _renderProjectHubBody(_activeProject());
    _showToast('Source synced');
  } catch(e) { _showToast('Sync failed: ' + e.message, true); }
}

async function deleteProjectSource(srcId) {
  if (!await _projConfirm('Remove this source?')) return;
  var proj = _activeProject();
  if (!proj) return;
  try {
    await fetch('/api/projects/' + proj.id + '/sources/' + srcId, { method: 'DELETE' });
    await _refreshProject(proj.id);
    _renderProjectHubBody(_activeProject());
  } catch(e) {}
}

function openAddSourceDialog() {
  // Step 1: pick type
  _projModal({
    title: 'Add Source — Step 1',
    fields: [
      { id: 'src-type', label: 'Type', type: 'select', options: [
        { value: 'local',  label: 'Local folder' },
        { value: 'github', label: 'GitHub repository' },
        { value: 'gitlab', label: 'GitLab repository' },
      ]},
    ],
    submit: 'Next',
    onSubmit: function(vals) {
      var type = vals['src-type'];
      if (type === 'local') {
        _projModal({
          title: 'Add Local Source',
          fields: [
            { id: 'src-path', label: 'Folder path', placeholder: '/Users/me/myproject', type: 'text', browse: true },
          ],
          submit: 'Add',
          onSubmit: function(v2) {
            if (!v2['src-path']) return 'Path is required';
            _addProjectSource({ type: 'local', path: v2['src-path'] });
          },
        });
      } else {
        _projModal({
          title: 'Add ' + type.charAt(0).toUpperCase() + type.slice(1) + ' Source',
          fields: [
            { id: 'src-owner',  label: 'Owner / org',   placeholder: 'octocat',  type: 'text' },
            { id: 'src-repo',   label: 'Repository',    placeholder: 'my-repo',  type: 'text' },
            { id: 'src-branch', label: 'Branch',        placeholder: 'main',     type: 'text' },
          ],
          submit: 'Add',
          onSubmit: function(v2) {
            if (!v2['src-owner'] || !v2['src-repo']) return 'Owner and repository are required';
            var branch = v2['src-branch'] || 'main';
            _addProjectSource({ type: type, owner: v2['src-owner'], repo: v2['src-repo'],
              branch: branch, name: v2['src-owner'] + '/' + v2['src-repo'] });
          },
        });
      }
    },
  });
}

async function _addProjectSource(opts) {
  var proj = _activeProject();
  if (!proj) return;
  try {
    var r = await fetch('/api/projects/' + proj.id + '/sources', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(opts)
    });
    if (!r.ok) throw new Error((await r.json()).error);
    await _refreshProject(proj.id);
    _renderProjectHubBody(_activeProject());
  } catch(e) { _showToast('Error: ' + e.message, true); }
}

// ── Run Tab ───────────────────────────────────────────────────────────────
// State: detected commands per srcId, active runs, open log SSE

var _runDetected   = {};   // srcId → [{ label, cmd, detected }]
var _runStack      = {};   // srcId → string[]
var _runActiveList = [];   // list from /api/projects/:id/runs
var _runLogESrc    = null; // EventSource for log pane
var _runOpenLogId  = null; // which runId is showing logs

// Terminal state
var _termSessions  = [];  // [{ id, name, termId, projectId, ess }]
var _termActiveId  = null; // id of active session
var _termHistory   = [];
var _termHistIdx   = -1;
var _runBottomMode = 'terminal'; // 'terminal' | 'logs'

function _termUidLocal() { return 'ts-' + Date.now() + '-' + Math.random().toString(36).slice(2,6); }

// Reconnect all dropped SSEs when the page becomes visible again or network comes back
// (handles macOS sleep/wake and ERR_NETWORK_IO_SUSPENDED)
function _sseReconnectAll() {
  _termSessions.forEach(function(sess) {
    if (!sess.termId) return;
    if (!sess.ess || sess.ess.readyState === EventSource.CLOSED) {
      _termConnectSSE(sess);
    }
  });
}
document.addEventListener('visibilitychange', function() {
  if (document.visibilityState === 'visible') _sseReconnectAll();
});
window.addEventListener('online', _sseReconnectAll);

function _renderRunTabShell() {
  return '<div id="proj-run-root" class="proj-run-root">' +
    '<div class="proj-hub-empty"><i class="ti ti-loader-2 ti-spin" style="font-size:22px;opacity:.5"></i><div>Loading…</div></div>' +
  '</div>';
}

async function _runTabLoad(proj) {
  _runDetected = {};
  _runStack = {};
  _runActiveList = [];
  _runOpenLogId = null;
  _runBottomMode = 'terminal';
  if (_runLogESrc) { try { _runLogESrc.close(); } catch(_) {} _runLogESrc = null; }
  // Keep sessions alive — just filter to this project's sessions
  _termSessions = _termSessions.filter(function(s) { return s.projectId === proj.id; });
  if (!_termActiveId || !_termSessions.find(function(s) { return s.id === _termActiveId; })) {
    _termActiveId = _termSessions.length ? _termSessions[0].id : null;
  }

  // Fetch active runs
  try {
    var r = await fetch('/api/projects/' + proj.id + '/runs');
    _runActiveList = await r.json();
  } catch(_) {}

  // Detect commands for each source in parallel
  if (proj.sources && proj.sources.length) {
    await Promise.all(proj.sources.map(async function(s) {
      try {
        var r = await fetch('/api/projects/' + proj.id + '/sources/' + s.id + '/run-commands');
        var data = await r.json();
        _runDetected[s.id] = Array.isArray(data) ? data : (data.commands || []);
        _runStack[s.id] = Array.isArray(data) ? [] : (data.stack || []);
      } catch(_) { _runDetected[s.id] = []; _runStack[s.id] = []; }
    }));
  }

  _runRender(proj);
  // Start embedded terminal shell
  _runStartTerminal(proj);
}

function _initRunResize() {
  var handle = document.getElementById('proj-run-resize-handle');
  var sources = document.querySelector('.proj-run-sources');
  if (!handle || !sources) return;
  var RUN_MIN = 180, RUN_MAX = 700, RUN_KEY = 'fauna-run-sources-width';
  var saved = parseInt(localStorage.getItem(RUN_KEY), 10);
  if (saved && saved >= RUN_MIN && saved <= RUN_MAX) sources.style.width = saved + 'px';
  window.installPaneResize({
    handle: handle,
    getStartWidth: function () { return sources.getBoundingClientRect().width; },
    onMove: function (dx, startW) {
      var w = Math.min(RUN_MAX, Math.max(RUN_MIN, startW + dx));
      sources.style.width = w + 'px';
    },
    onEnd: function () {
      localStorage.setItem(RUN_KEY, Math.round(sources.getBoundingClientRect().width));
    },
  });
  handle.addEventListener('dblclick', function() {
    sources.style.width = '340px';
    localStorage.removeItem(RUN_KEY);
  });
}

function _runRenderBottom(proj) {
  var root = document.getElementById('proj-run-root');
  if (!root) return;
  var isLogs = _runBottomMode === 'logs';
  var logRun = isLogs ? _runActiveList.find(function(r) { return r.runId === _runOpenLogId; }) : null;
  var logIsActive = logRun && (logRun.status === 'running' || logRun.status === 'starting');
  var pane = document.createElement('div');
  pane.className = 'proj-run-bottom-pane';
  pane.id = 'proj-run-bottom-pane';

  var tabsHtml = _termSessionTabsHtml(isLogs, logRun, logIsActive, proj);
  var bodyHtml = isLogs
    ? '<pre id="proj-run-log-body" class="proj-run-log-body"></pre>'
    : _termSessionBodyHtml();

  pane.innerHTML = tabsHtml + bodyHtml;
  var old = document.getElementById('proj-run-bottom-pane');
  if (old) old.replaceWith(pane);
  else root.appendChild(pane);
  if (!isLogs) {
    var inp = pane.querySelector('#proj-terminal-input');
    if (inp) inp.addEventListener('keydown', _termKeydown);
  }
}

function _termSessionTabsHtml(isLogs, logRun, logIsActive, proj) {
  var projId = proj ? proj.id : '';
  var html = '<div class="proj-run-bottom-tabs">';
  // Terminal session tabs
  _termSessions.filter(function(s) { return s.projectId === projId; }).forEach(function(s) {
    var isActive = !isLogs && s.id === _termActiveId;
    html += '<button class="proj-run-bottom-tab' + (isActive ? ' active' : '') + '" onclick="_termSwitchSession(\'' + _projEsc(s.id) + '\')" title="' + _projEsc(s.name) + '">' +
      '<i class="ti ti-terminal-2"></i> ' + _projEsc(s.name) +
      '<span class="proj-term-tab-close" onclick="event.stopPropagation();_termCloseSession(\'' + _projEsc(s.id) + '\')">×</span>' +
    '</button>';
  });
  // New terminal button
  html += '<button class="proj-run-bottom-tab proj-term-new-btn" onclick="_termNewSession()" title="New terminal"><i class="ti ti-plus"></i></button>';
  // Logs tab (when in logs mode)
  if (isLogs) {
    html += '<button class="proj-run-bottom-tab active">' +
      '<i class="ti ti-file-text"></i> ' + _projEsc((logRun ? logRun.name : '') + ' logs') + '</button>' +
      '<button class="proj-icon-btn" style="margin-left:auto" onclick="_runSwitchBottomMode(\'terminal\')"><i class="ti ti-x"></i></button>' +
      (logIsActive
        ? '<button class="proj-icon-btn proj-run-log-stop-btn" style="color:#f87171" onclick="stopProjectRun(\'' + _projEsc(_runOpenLogId) + '\',\'' + _projEsc(proj ? proj.id : '') + '\')"><i class="ti ti-player-stop-filled"></i> Stop</button>'
        : '');
  }
  html += '</div>';
  return html;
}

function _termSessionBodyHtml() {
  return '<div id="proj-terminal-output" class="proj-terminal-output proj-run-terminal-output"></div>' +
    '<div class="proj-terminal-input-row">' +
      '<span class="proj-terminal-prompt">$</span>' +
      '<input id="proj-terminal-input" class="proj-terminal-input" placeholder="Type a command…" autocomplete="off" autocorrect="off" spellcheck="false">' +
    '</div>';
}

async function _runStartTerminal(proj) {
  // If we already have a session for this project, just reconnect SSE
  var existing = _termSessions.filter(function(s) { return s.projectId === proj.id; });
  if (existing.length) {
    _termActiveId = existing[0].id;
    var sess = existing[0];
    if (!sess.ess) _termConnectSSE(sess);
    _runRenderBottom(proj);
    var inp = document.getElementById('proj-terminal-input');
    if (inp) { inp.addEventListener('keydown', _termKeydown); inp.focus(); }
    _termRepaintOutput(sess);
    return;
  }
  // No session yet — create one
  await _termNewSession(proj, null, null);
}

// Create a new terminal session. name=null → auto, initCmd=null → none
async function _termNewSession(proj, name, initCmd) {
  proj = proj || _activeProject();
  if (!proj) return;
  var label = name || ('Terminal ' + (_termSessions.filter(function(s){ return s.projectId === proj.id; }).length + 1));
  var sess = { id: _termUidLocal(), name: label, termId: null, projectId: proj.id, ess: null, localBuf: '' };
  _termSessions.push(sess);
  _termActiveId = sess.id;
  // Render pane so the output div exists before we write to it
  _runRenderBottom(proj);
  var inp = document.getElementById('proj-terminal-input');
  if (inp) inp.addEventListener('keydown', _termKeydown);
  _termWriteToSession(sess, '<span style="color:#6b7280">Starting shell\u2026</span>\n');
  try {
    var r = await fetch('/api/projects/' + proj.id + '/terminal', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
    var d = await r.json();
    sess.termId = d.termId;
  } catch(e) {
    _termWriteToSession(sess, '<span style="color:#f87171">[Failed: ' + e.message + ']</span>\n');
    return;
  }
  sess.localBuf = '';
  _termWriteToSession(sess, '<span style="color:#6b7280">Ready \u2014 ' + _projEsc(proj.rootPath || '~') + '</span>\n');
  _termConnectSSE(sess);
  if (initCmd) {
    _termWriteToSession(sess, '<span class="proj-terminal-echo">$ ' + _projEsc(initCmd) + '</span>\n');
    await _termSendToSession(sess, proj.id, initCmd + '\n');
  }
  if (_termActiveId === sess.id) {
    var inp2 = document.getElementById('proj-terminal-input');
    if (inp2) inp2.focus();
  }
}

function _termSwitchSession(id) {
  var prev = _termSessions.find(function(s) { return s.id === _termActiveId; });
  if (prev && prev.ess) { try { prev.ess.close(); } catch(_) {} prev.ess = null; }
  _termActiveId = id;
  _runBottomMode = 'terminal';
  var proj = _activeProject();
  if (proj) _runRenderBottom(proj);
  var sess = _termSessions.find(function(s) { return s.id === id; });
  if (sess) {
    _termRepaintOutput(sess);
    if (sess.termId) _termConnectSSE(sess);
  }
  var inp = document.getElementById('proj-terminal-input');
  if (inp) { inp.addEventListener('keydown', _termKeydown); inp.focus(); }
}

function _termRepaintOutput(sess) {
  var out = document.getElementById('proj-terminal-output');
  if (!out || !sess) return;
  out.innerHTML = '';
  if (sess.localBuf) {
    var span = document.createElement('span');
    span.textContent = sess.localBuf;
    out.appendChild(span);
    out.scrollTop = out.scrollHeight;
  }
}

async function _termCloseSession(id) {
  var sess = _termSessions.find(function(s) { return s.id === id; });
  if (!sess) return;
  if (sess.ess) { try { sess.ess.close(); } catch(_) {} }
  var proj = _activeProject();
  if (proj && sess.termId) {
    try { await fetch('/api/projects/' + proj.id + '/terminal/' + sess.termId, { method: 'DELETE' }); } catch(_) {}
  }
  _termSessions = _termSessions.filter(function(s) { return s.id !== id; });
  if (_termActiveId === id) {
    _termActiveId = _termSessions.length ? _termSessions[_termSessions.length-1].id : null;
  }
  if (proj) {
    _runRenderBottom(proj);
    if (_termActiveId) {
      var next = _termSessions.find(function(s) { return s.id === _termActiveId; });
      if (next) { _termRepaintOutput(next); if (next.termId) _termConnectSSE(next); }
    }
  }
}

function _termDestroyAll() {
  _termSessions.forEach(function(sess) {
    if (sess.ess) { try { sess.ess.close(); } catch(_) {} }
    var proj = _activeProject();
    if (proj && sess.termId) {
      fetch('/api/projects/' + proj.id + '/terminal/' + sess.termId, { method: 'DELETE' }).catch(function(){});
    }
  });
  _termSessions = [];
  _termActiveId = null;
}

function _termDisconnectSSE() {
  _termSessions.forEach(function(sess) {
    if (sess.ess) { try { sess.ess.close(); } catch(_) {} sess.ess = null; }
  });
}

function _termConnectSSE(sess) {
  if (!sess || !sess.termId) return;
  var projectId = sess.projectId;
  if (sess.ess) { try { sess.ess.close(); } catch(_) {} sess.ess = null; }
  sess._essRetry = 0;
  (function connect() {
    if (!sess.termId) return; // session was closed
    var es = new EventSource('/api/projects/' + projectId + '/terminal/' + sess.termId + '/output');
    sess.ess = es;
    es.onmessage = function(e) {
      sess._essRetry = 0;
      var d = JSON.parse(e.data);
      if (d.out !== undefined) {
        var text = d.out.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '')
                        .replace(/\x1b\][^\x07\x1b]*(\x07|\x1b\\)/g, '')
                        .replace(/\x1b[()][0-9A-Za-z]/g, '')
                        .replace(/\r\n/g, '\n').replace(/\r/g, '\n');
        text = text.replace(/^Last login:.*\n?/m, '');
        sess.localBuf += text;
        if (sess.localBuf.length > 200000) sess.localBuf = sess.localBuf.slice(-150000);
        if (sess.id === _termActiveId) {
          var out = document.getElementById('proj-terminal-output');
          if (out) {
            var span = document.createElement('span');
            span.textContent = text;
            out.appendChild(span);
            out.scrollTop = out.scrollHeight;
          }
        }
      }
    };
    es.onerror = function() {
      try { es.close(); } catch(_) {}
      sess.ess = null;
      if (!sess.termId) return;
      var delay = Math.min(1000 * Math.pow(2, sess._essRetry || 0), 15000);
      sess._essRetry = (sess._essRetry || 0) + 1;
      setTimeout(connect, delay);
    };
  }());
}

function _runSwitchBottomMode(mode) {
  _runBottomMode = mode;
  if (mode === 'terminal') {
    if (_runLogESrc) { try { _runLogESrc.close(); } catch(_) {} _runLogESrc = null; }
    _runOpenLogId = null;
  }
  var proj = _activeProject();
  if (proj) _runRenderBottom(proj);
  if (mode === 'terminal') {
    var sess = _termSessions.find(function(s) { return s.id === _termActiveId; });
    if (sess) { _termRepaintOutput(sess); if (sess.termId && !sess.ess) _termConnectSSE(sess); }
    var inp = document.getElementById('proj-terminal-input');
    if (inp) inp.focus();
  }
}

function _runRender(proj) {
  var root = document.getElementById('proj-run-root');
  if (!root) return;
  var srcs = (proj && proj.sources) ? proj.sources : [];

  // Active runs section
  var activeHtml = '';
  var activeRuns = _runActiveList.filter(function(r) { return r.status === 'running' || r.status === 'starting'; });
  var stoppedRuns = _runActiveList.filter(function(r) { return r.status !== 'running' && r.status !== 'starting'; });
  var allRunsHtml = [...activeRuns, ...stoppedRuns].map(function(r) { return _runRecordCard(r, proj.id); }).join('');

  var html = '<div class="proj-run-layout">';

  // Left: sources to start
  html += '<div class="proj-run-sources">';
  html += '<div class="proj-section-header"><span>Launch</span></div>';
  if (!srcs.length) {
    html += '<div class="proj-hub-empty" style="padding:24px"><div>No sources — add one in the Sources tab</div></div>';
  } else {
    html += srcs.map(function(s) {
      var cmds = _runDetected[s.id] || [];
      var topCmd = cmds.length ? cmds[0].cmd : '';
      var stackBadges = (_runStack[s.id] || []).map(function(t) {
        return '<span class="proj-stack-badge">' + _projEsc(t) + '</span>';
      }).join('');
      return '<div class="proj-run-src-card" id="proj-run-src-' + _projEsc(s.id) + '">' +
        '<div class="proj-run-src-header">' +
          '<i class="ti ti-folder proj-folder-icon"></i>' +
          '<span class="proj-run-src-name">' + _projEsc(s.name) + '</span>' +
          (stackBadges ? '<span class="proj-stack-badges">' + stackBadges + '</span>' : '') +
          '<button class="proj-icon-btn proj-run-src-term-btn" title="Open terminal here" onclick="_termOpenForSource(\'' + _projEsc(proj.id) + '\',\'' + _projEsc(s.id) + '\',\'' + _projEsc(s.name) + '\',\'' + _projEsc(s.rootPath || s.path || '') + '\')">' +
            '<i class="ti ti-terminal-2"></i></button>' +
        '</div>' +
        '<div class="proj-run-src-body">' +
          '<div class="proj-run-field-row">' +
            '<label class="proj-run-label">Command</label>' +
            (cmds.length
              ? '<div class="proj-run-detected-pills">' + cmds.slice(0, 4).map(function(c, i) {
                  return '<button class="proj-run-pill' + (i === 0 ? ' active' : '') + '" onclick="_runSetCmd(\'' + _projEsc(s.id) + '\',this,\'' + _projEsc(c.cmd) + '\')">' + _projEsc(c.label) + '</button>';
                }).join('') + '</div>'
              : '') +
            '<input id="proj-run-cmd-' + _projEsc(s.id) + '" class="proj-run-input" placeholder="e.g. npm run dev" value="' + _projEsc(topCmd) + '">' +
          '</div>' +
          '<div class="proj-run-field-row proj-run-port-row">' +
            '<label class="proj-run-label">Port</label>' +
            '<input id="proj-run-port-' + _projEsc(s.id) + '" class="proj-run-input proj-run-port-input" type="number" placeholder="auto" min="1" max="65535">' +
            '<button class="proj-run-start-btn" onclick="startProjectRun(\'' + _projEsc(s.id) + '\')">' +
              '<i class="ti ti-player-play-filled"></i> Run' +
            '</button>' +
          '</div>' +
        '</div>' +
      '</div>';
    }).join('');
  }
  html += '</div>'; // close proj-run-sources

  html += '<div class="proj-run-resize-handle" id="proj-run-resize-handle"></div>';

  // Right: active runs
  html += '<div class="proj-run-active">';
  html += '<div class="proj-section-header"><span>Active runs</span>' +
    '<button class="proj-icon-btn" title="Refresh" onclick="_runRefresh()"><i class="ti ti-refresh"></i></button>' +
  '</div>';
  html += allRunsHtml || '<div class="proj-hub-empty" style="padding:24px"><div>No runs yet</div></div>';
  html += '</div>';

  html += '</div>';

  root.innerHTML = html;

  // Wire up split resize
  _initRunResize();

  // Render bottom pane
  _runRenderBottom(proj);
}

function _runRecordCard(r, projectId) {
  var statusCls = { running: 'proj-run-status-running', starting: 'proj-run-status-starting',
    stopped: 'proj-run-status-stopped', exited: 'proj-run-status-exited', error: 'proj-run-status-error' }[r.status] || '';
  var portBtn = r.port
    ? '<button class="proj-icon-btn" title="Open in browser" onclick="openRunInBrowser(\'http://localhost:' + r.port + '\')">' +
        '<i class="ti ti-world"></i> :' + r.port + '</button>'
    : '';
  var isActive = r.status === 'running' || r.status === 'starting';
  var actionBtn = isActive
    ? '<button class="proj-run-stop-btn" title="Stop" onclick="stopProjectRun(\'' + _projEsc(r.runId) + '\',\'' + _projEsc(projectId) + '\')">' +
        '<i class="ti ti-player-stop-filled"></i> Stop</button>'
    : '<button class="proj-icon-btn proj-run-dismiss-btn" title="Dismiss" onclick="dismissProjectRun(\'' + _projEsc(r.runId) + '\',\'' + _projEsc(projectId) + '\')">' +
        '<i class="ti ti-x"></i></button>';
  return '<div class="proj-run-card" id="proj-run-card-' + _projEsc(r.runId) + '">' +
    '<div class="proj-run-card-header">' +
      '<span class="proj-run-status-dot ' + statusCls + '"></span>' +
      '<span class="proj-run-card-name">' + _projEsc(r.name) + '</span>' +
      '<span class="proj-run-card-src">' + _projEsc(r.srcName) + '</span>' +
      portBtn +
      '<button class="proj-icon-btn" title="View logs" onclick="_runLogOpen(\'' + _projEsc(r.runId) + '\',\'' + _projEsc(projectId) + '\',true)">' +
        '<i class="ti ti-terminal-2"></i></button>' +
      actionBtn +
    '</div>' +
    '<div class="proj-run-card-cmd">' + _projEsc(r.cmd) + '</div>' +
  '</div>';
}

function _runSetCmd(srcId, btn, cmd) {
  // Highlight the chosen pill
  var card = document.getElementById('proj-run-src-' + srcId);
  if (card) {
    card.querySelectorAll('.proj-run-pill').forEach(function(b) { b.classList.remove('active'); });
    btn.classList.add('active');
  }
  var inp = document.getElementById('proj-run-cmd-' + srcId);
  if (inp) inp.value = cmd;
}

async function startProjectRun(srcId) {
  var proj = _activeProject();
  if (!proj) return;
  var cmdEl  = document.getElementById('proj-run-cmd-' + srcId);
  var portEl = document.getElementById('proj-run-port-' + srcId);
  var cmd  = cmdEl ? cmdEl.value.trim() : '';
  var port = portEl && portEl.value.trim() ? Number(portEl.value.trim()) : null;
  if (!cmd) { _showToast('Enter a command first', true); return; }

  try {
    var body = { cmd, name: cmd.split(' ')[0] };
    if (port) body.port = port;
    var r = await fetch('/api/projects/' + proj.id + '/sources/' + srcId + '/run', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });
    var data = await r.json();
    if (!r.ok) throw new Error(data.error);
    _showToast('Started: ' + cmd.split(' ')[0]);
    // Refresh run list
    await _runRefresh();
    // Auto-open logs for the new run
    _runLogOpen(data.runId, proj.id, true);
  } catch(e) { _showToast('Failed: ' + e.message, true); }
}

async function stopProjectRun(runId, projectId) {
  var pid = projectId || (state.activeProjectId);
  // Dev-server registry entries (no project) live at /api/runs/:id (DELETE).
  if (!pid) return stopDevServerRun(runId);
  try {
    var r = await fetch('/api/projects/' + pid + '/runs/' + runId, { method: 'DELETE' });
    if (!r.ok) throw new Error((await r.json()).error);
    _showToast('Stopped');
    if (_runOpenLogId === runId) _runLogClose();
    await _runRefresh();
  } catch(e) { _showToast('Stop failed: ' + e.message, true); }
}

async function stopDevServerRun(runId) {
  try {
    var r = await fetch('/api/runs/' + encodeURIComponent(runId), { method: 'DELETE' });
    var j = await r.json();
    if (!j.ok) throw new Error(j.error || 'stop failed');
    _showToast('Stopped');
  } catch(e) { _showToast('Stop failed: ' + e.message, true); }
}

async function restartDevServerRun(runId) {
  try {
    var r = await fetch('/api/runs/' + encodeURIComponent(runId) + '/restart', { method: 'POST' });
    var j = await r.json();
    if (!j.ok) throw new Error(j.error || 'restart failed');
    _showToast('Restarting…');
  } catch(e) { _showToast('Restart failed: ' + e.message, true); }
}

async function dismissProjectRun(runId, projectId) {
  var pid = projectId || (state.activeProjectId);
  try {
    await fetch('/api/projects/' + pid + '/runs/' + runId, { method: 'DELETE' });
    if (_runOpenLogId === runId) _runLogClose();
    _runActiveList = _runActiveList.filter(function(r) { return r.runId !== runId; });
    var proj = _activeProject();
    if (proj) _runRender(proj);
  } catch(_) {}
}

async function _runRefresh() {
  var proj = _activeProject();
  if (!proj || state.projectHubTab !== 'run') return;
  try {
    var r = await fetch('/api/projects/' + proj.id + '/runs');
    _runActiveList = await r.json();
  } catch(_) {}
  _runRender(proj);
}

function _runLogOpen(runId, projectId, scroll) {
  _runOpenLogId = runId;
  _runBottomMode = 'logs';
  if (_runLogESrc) { try { _runLogESrc.close(); } catch(_) {} _runLogESrc = null; }
  _termDisconnectSSE();

  // Render bottom pane in logs mode
  var proj = _activeProject();
  if (proj) _runRenderBottom(proj);

  var body = document.getElementById('proj-run-log-body');
  if (!body) return;
  body.textContent = '';

  var _logRetry = 0;
  (function connectLog() {
    var es = new EventSource('/api/projects/' + projectId + '/runs/' + runId + '/logs');
    _runLogESrc = es;
    es.onmessage = function(e) {
      _logRetry = 0;
      var d = JSON.parse(e.data);
      if (d.line !== undefined) {
        body.textContent += d.line + '\n';
        if (scroll !== false) body.scrollTop = body.scrollHeight;
      }
      if (d.status) {
        var rec = _runActiveList.find(function(r) { return r.runId === runId; });
        if (rec) {
          rec.status = d.status;
          if (d.port) rec.port = d.port;
          _runPatchCard(rec, runId);
          _runPatchLogHeader(rec);
        } else {
          _runRefresh();
        }
      }
    };
    es.onerror = function() {
      try { es.close(); } catch(_) {}
      _runLogESrc = null;
      // Only reconnect if we're still showing this log and the body element still exists
      if (_runOpenLogId !== runId || !document.getElementById('proj-run-log-body')) return;
      var delay = Math.min(1000 * Math.pow(2, _logRetry), 15000);
      _logRetry++;
      setTimeout(connectLog, delay);
    };
  }());
}

function _runPatchCard(rec, runId) {
  var card = document.getElementById('proj-run-card-' + runId);
  if (!card) return;
  var isActive = rec.status === 'running' || rec.status === 'starting';
  var statusCls = { running: 'proj-run-status-running', starting: 'proj-run-status-starting',
    stopped: 'proj-run-status-stopped', exited: 'proj-run-status-exited', error: 'proj-run-status-error' }[rec.status] || '';
  var dot = card.querySelector('.proj-run-status-dot');
  if (dot) { dot.className = 'proj-run-status-dot ' + statusCls; }
  // Replace action button
  var proj = _activeProject();
  var pid = proj ? proj.id : '';
  var oldBtn = card.querySelector('.proj-run-stop-btn, .proj-run-dismiss-btn');
  var newBtn = document.createElement('button');
  if (isActive) {
    newBtn.className = 'proj-run-stop-btn';
    newBtn.title = 'Stop';
    newBtn.innerHTML = '<i class="ti ti-player-stop-filled"></i> Stop';
    newBtn.onclick = function() { stopProjectRun(runId, pid); };
  } else {
    newBtn.className = 'proj-icon-btn proj-run-dismiss-btn';
    newBtn.title = 'Dismiss';
    newBtn.innerHTML = '<i class="ti ti-x"></i>';
    newBtn.onclick = function() { dismissProjectRun(runId, pid); };
  }
  if (oldBtn) oldBtn.replaceWith(newBtn);
}

function _runPatchLogHeader(rec) {
  var stopBtn = document.querySelector('.proj-run-bottom-tabs .proj-run-log-stop-btn');
  var isActive = rec && (rec.status === 'running' || rec.status === 'starting');
  if (!isActive && stopBtn) stopBtn.remove();
  if (isActive && !stopBtn) {
    var tabs = document.querySelector('.proj-run-bottom-tabs');
    var proj = _activeProject();
    if (tabs && proj) {
      var btn = document.createElement('button');
      btn.className = 'proj-icon-btn proj-run-log-stop-btn';
      btn.style.color = '#f87171';
      btn.title = 'Stop process';
      btn.innerHTML = '<i class="ti ti-player-stop-filled"></i> Stop';
      btn.onclick = function() { stopProjectRun(rec.runId, proj.id); };
      tabs.appendChild(btn);
    }
  }
}

function _runLogClose() {
  _runSwitchBottomMode('terminal');
}

function openRunInBrowser(url) {
  // Switch to chat view so the browser pane is visible, then open
  if (typeof switchToChat === 'function') switchToChat();
  if (typeof openBrowserPane === 'function') {
    // Bypass the agent permission check for localhost/project runs
    var pane = document.getElementById('browser-pane');
    if (pane) pane.classList.add('open');
    if (typeof _restoreBrowserPaneWidth === 'function') _restoreBrowserPaneWidth();
    if (typeof browserNavigateTo === 'function') browserNavigateTo(url);
  } else {
    window.open(url, '_blank');
  }
}

// ── Terminal Tab ─────────────────────────────────────────────────────────

function _renderTerminalTab(proj, container) {
  var sessions = _termSessions.filter(function(s) { return s.projectId === proj.id; });
  var sessionTabsHtml = '<div class="proj-term-session-tabs">';
  sessions.forEach(function(s) {
    var isActive = s.id === _termActiveId;
    sessionTabsHtml +=
      '<button class="proj-term-session-tab' + (isActive ? ' active' : '') + '" onclick="_termSwitchSession(\'' + _projEsc(s.id) + '\')" title="' + _projEsc(s.name) + '">' +
        '<i class="ti ti-terminal-2"></i> ' + _projEsc(s.name) +
        '<span class="proj-term-tab-close" onclick="event.stopPropagation();_termCloseSession(\'' + _projEsc(s.id) + '\')">×</span>' +
      '</button>';
  });
  sessionTabsHtml +=
    '<button class="proj-term-session-tab proj-term-new-btn" onclick="_termNewSession()" title="New terminal"><i class="ti ti-plus"></i></button>' +
    '<button class="proj-icon-btn" style="margin-left:auto" title="Clear output" onclick="_termClear()"><i class="ti ti-eraser"></i></button>' +
  '</div>';
  var root = container || document.getElementById('project-hub-body');
  if (root) {
    root.innerHTML = '<div class="proj-terminal" id="proj-terminal">' +
      sessionTabsHtml +
      '<div id="proj-terminal-output" class="proj-terminal-output"></div>' +
      '<div class="proj-terminal-input-row">' +
        '<span class="proj-terminal-prompt">$</span>' +
        '<input id="proj-terminal-input" class="proj-terminal-input" placeholder="Type a command and press Enter…" autocomplete="off" autocorrect="off" spellcheck="false">' +
      '</div>' +
    '</div>';
  }
}

async function _termTabLoad(proj) {
  // Reuse existing sessions for this project
  var existing = _termSessions.filter(function(s) { return s.projectId === proj.id; });
  if (existing.length) {
    _termActiveId = existing[0].id;
    _renderTerminalTab(proj);
    var sess = existing[0];
    _termRepaintOutput(sess);
    if (!sess.ess && sess.termId) _termConnectSSE(sess);
    var inp = document.getElementById('proj-terminal-input');
    if (inp) { inp.addEventListener('keydown', _termKeydown); inp.focus(); }
    return;
  }
  // No sessions yet — create one
  _renderTerminalTab(proj);
  await _termNewSession(proj, null, null);
}

function _termAppend(raw) {
  var sess = _termSessions.find(function(s) { return s.id === _termActiveId; });
  if (!sess) return;
  var text = raw.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '')
                .replace(/\x1b\][^\x07\x1b]*(\x07|\x1b\\)/g, '')
                .replace(/\x1b[()][0-9A-Za-z]/g, '')
                .replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  _termWriteToSession(sess, text);
}


function _termKeydown(e) {
  var sess = _termSessions.find(function(s) { return s.id === _termActiveId; });
  if (!sess) return;
  if (e.key === 'Enter') {
    var inp = e.target;
    var cmd = inp.value;
    inp.value = '';
    _termHistIdx = -1;
    if (cmd.trim()) { _termHistory.unshift(cmd); if (_termHistory.length > 200) _termHistory.pop(); }
    _termWriteToSession(sess, '<span class="proj-terminal-echo">$ ' + _projEsc(cmd) + '</span>\n');
    if (cmd.trim() === 'clear' || cmd.trim() === 'cls') { _termClearSession(sess); return; }
    _termSendToSession(sess, sess.projectId, cmd + '\n');
  } else if (e.key === 'ArrowUp') {
    e.preventDefault();
    if (_termHistory.length) {
      _termHistIdx = Math.min(_termHistIdx + 1, _termHistory.length - 1);
      e.target.value = _termHistory[_termHistIdx];
    }
  } else if (e.key === 'ArrowDown') {
    e.preventDefault();
    if (_termHistIdx > 0) { _termHistIdx--; e.target.value = _termHistory[_termHistIdx]; }
    else { _termHistIdx = -1; e.target.value = ''; }
  } else if (e.key === 'c' && e.ctrlKey) {
    e.preventDefault();
    _termSendToSession(sess, sess.projectId, '\x03');
    _termWriteToSession(sess, '^C\n');
  } else if (e.key === 'l' && e.ctrlKey) {
    e.preventDefault();
    _termClearSession(sess);
  }
}

async function _termSendToSession(sess, projectId, data) {
  if (!sess || !sess.termId) return;
  try {
    await fetch('/api/projects/' + projectId + '/terminal/' + sess.termId + '/input', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ data }),
    });
  } catch(_) {}
}

function _termWriteToSession(sess, html) {
  if (!sess) return;
  // Append to local buffer (plain text)
  var tmp = document.createElement('div');
  tmp.innerHTML = html;
  sess.localBuf += tmp.textContent;
  if (sess.localBuf.length > 200000) sess.localBuf = sess.localBuf.slice(-150000);
  // Only paint to DOM if visible
  if (sess.id === _termActiveId) {
    var out = document.getElementById('proj-terminal-output');
    if (out) {
      var span = document.createElement('span');
      span.innerHTML = html;
      out.appendChild(span);
      out.scrollTop = out.scrollHeight;
    }
  }
}

function _termClearSession(sess) {
  if (!sess) return;
  sess.localBuf = '';
  var out = document.getElementById('proj-terminal-output');
  if (out) out.innerHTML = '';
}

// Open a new terminal tab and cd into the given source root
async function _termOpenForSource(projId, srcId, srcName, srcPath) {
  var proj = _activeProject();
  if (!proj || proj.id !== projId) return;
  // Switch run bottom pane to terminal mode
  _runBottomMode = 'terminal';
  // Create a session named after the source, cd into its root
  await _termNewSession(proj, srcName, srcPath ? ('cd ' + JSON.stringify(srcPath)) : null);
}

async function _termSend(data) {
  var sess = _termSessions.find(function(s) { return s.id === _termActiveId; });
  var proj = _activeProject();
  if (!sess || !proj) return;
  await _termSendToSession(sess, proj.id, data);
}

function _termWrite(html) {
  var sess = _termSessions.find(function(s) { return s.id === _termActiveId; });
  if (sess) _termWriteToSession(sess, html);
}

function _termClear() {
  var sess = _termSessions.find(function(s) { return s.id === _termActiveId; });
  if (sess) _termClearSession(sess);
}

async function _termNew() {
  var proj = _activeProject();
  if (!proj) return;
  await _termNewSession(proj, null, null);
}

// Legacy compat — no-op (we no longer destroy on tab switch)
async function _termDestroy(proj) {}


// ── Conversations Tab ────────────────────────────────────────────────────

function _renderConvsTab(proj) {
  var convs = (typeof state !== 'undefined' ? state.conversations || [] : [])
    .filter(function(c) { return c.projectId === proj.id; });
  var header = '<div class="proj-section-header">' +
    '<span>' + convs.length + ' conversation' + (convs.length !== 1 ? 's' : '') + '</span>' +
    '<button class="proj-action-btn" onclick="closeProjectHub();newConversation()"><i class="ti ti-plus"></i> New conversation</button>' +
  '</div>';
  if (!convs.length) {
    return header +
      '<div class="proj-hub-empty"><i class="ti ti-messages" style="font-size:28px;opacity:.3"></i>' +
      '<div>No conversations yet</div>' +
      '<div style="font-size:11px;color:var(--fau-text-dim)">New conversations while this project is active will appear here with all project context included</div></div>';
  }
  return header + convs.map(function(c) {
    var isActive = c.id === state.currentId;
    var date = c.createdAt ? new Date(c.createdAt).toLocaleDateString(undefined, { month: 'short', day: 'numeric' }) : '';
    var msgCount = (c.messages || []).filter(function(m){ return m.role === 'user'; }).length;
    return '<div class="proj-conv-row' + (isActive ? ' active' : '') + '" onclick="closeProjectHub();loadConversation(\'' + c.id + '\')">' +
      '<i class="ti ti-message proj-conv-icon"></i>' +
      '<div class="proj-conv-info">' +
        '<span class="proj-conv-title">' + _projEsc(c.title) + '</span>' +
        '<span class="proj-conv-meta">' + (msgCount ? msgCount + ' message' + (msgCount !== 1 ? 's' : '') + ' · ' : '') + date + '</span>' +
      '</div>' +
      '<button class="proj-icon-btn" onclick="event.stopPropagation();deleteConversation(\'' + c.id + '\',event)" title="Delete"><i class="ti ti-trash"></i></button>' +
    '</div>';
  }).join('');
}

// ── Tasks / Board Tab ────────────────────────────────────────────────────
// The Kanban board is rendered by public/js/board.js (window.renderKanbanBoard).
// This helper remains for any legacy call sites that expected a string return;
// it just shows a hint pointing at the live board.
function _renderTasksTab(proj) {
  return '<div class="proj-hub-empty"><i class="ti ti-layout-kanban" style="font-size:28px;opacity:.3"></i>' +
    '<div>Loading board…</div></div>';
}

// ── Settings Tab ──────────────────────────────────────────────────────────

function _renderSettingsTab(proj) {
  var rootSet = proj.rootPath && proj.rootPath.trim();
  // Check if rootPath is already added as a local source
  var rootAlreadySource = rootSet && (proj.sources || []).some(function(s) {
    return s.type === 'local' && s.path === proj.rootPath.trim();
  });

  var folderSection =
    '<div class="proj-settings-folder">' +
      '<div class="proj-settings-folder-header">' +
        '<span class="proj-settings-folder-label"><i class="ti ti-folder"></i> Project folder</span>' +
        '<button class="proj-icon-btn" onclick="browseProjectFolder()" title="Browse"><i class="ti ti-dots"></i></button>' +
      '</div>' +
      (rootSet
        ? '<div class="proj-settings-folder-path">' + _projEsc(proj.rootPath) + '</div>' +
          '<div class="proj-settings-folder-actions">' +
            '<button class="proj-icon-btn proj-folder-clear-btn" onclick="clearProjectFolder()" title="Clear folder"><i class="ti ti-x"></i> Clear</button>' +
            (!rootAlreadySource
              ? '<button class="proj-action-btn proj-folder-src-btn" onclick="addRootAsSource()" title="Add to sources"><i class="ti ti-plug"></i> Add as source</button>'
              : '<span class="proj-folder-src-note"><i class="ti ti-check"></i> Added as source</span>') +
          '</div>'
        : '<div class="proj-settings-folder-empty">No folder set &mdash; type a path or click <i class="ti ti-dots"></i></div>') +
      '<input class="proj-input proj-settings-folder-input" id="proj-set-root" value="' + _projEsc(proj.rootPath || '') + '" placeholder="/path/to/project" oninput="this.dataset.dirty=1">' +
    '</div>';

  return '<div class="proj-settings">' +
    '<div class="proj-settings-row">' +
      '<label>Name</label>' +
      '<input class="proj-input" id="proj-set-name" value="' + _projEsc(proj.name) + '">' +
    '</div>' +
    '<div class="proj-settings-row">' +
      '<label>Description</label>' +
      '<input class="proj-input" id="proj-set-desc" value="' + _projEsc(proj.description || '') + '">' +
    '</div>' +
    folderSection +
    '<div class="proj-settings-row">' +
      '<label>Color</label>' +
      '<div class="proj-color-picker">' +
        ['teal','teal2','purple','green','orange','red','violet','pink'].map(function(c) {
          return '<button class="proj-color-dot proj-color-' + c + (proj.color === c ? ' active' : '') + '" onclick="pickProjColor(\'' + c + '\')" title="' + c + '"></button>';
        }).join('') +
      '</div>' +
    '</div>' +
    '<div class="proj-settings-row">' +
      '<label>File editing</label>' +
      '<label class="proj-toggle-label">' +
        '<input type="checkbox" id="proj-set-allow-edit" class="proj-toggle-input"' + (proj.allowFileEditing ? ' checked' : '') + ' onchange="_toggleProjSetting(\'allowFileEditing\', this)">' +
        '<span class="proj-toggle-track"><span class="proj-toggle-thumb"></span></span>' +
        '<span class="proj-toggle-text">Allow editing attached source files</span>' +
      '</label>' +
      '<div class="proj-settings-hint">Controls attached sources and agent edits. You can always manage files in the project\'s working folder from Project Hub.</div>' +
    '</div>' +
    '<div class="proj-settings-row" id="proj-set-github-row">' +
      '<label>GitHub</label>' +
      _renderGitHubSection(proj) +
    '</div>' +
    '<div class="proj-settings-row">' +
      '<label>Autonomous mode</label>' +
      '<label class="proj-toggle-label">' +
        '<input type="checkbox" id="proj-set-autonomous" class="proj-toggle-input"' + (proj.autonomousMode ? ' checked' : '') + ' onchange="_toggleProjSetting(\'autonomousMode\', this)">' +
        '<span class="proj-toggle-track"><span class="proj-toggle-thumb"></span></span>' +
        '<span class="proj-toggle-text">Run until done</span>' +
      '</label>' +
      '<div class="proj-settings-hint">When on, the agent loops with higher tool-call and continuation caps and is instructed not to half-stop. Per-conversation setting overrides this.</div>' +
    '</div>' +
    '<div class="proj-settings-row">' +
      '<label>Acceptance criteria</label>' +
      '<textarea id="proj-set-acceptance" class="proj-input proj-settings-textarea" rows="4" placeholder="One bullet per criterion. e.g.&#10;- All tests pass&#10;- /api/health returns 200&#10;- README updated">' + _escHtml(proj.acceptanceCriteria || '') + '</textarea>' +
      '<div class="proj-settings-hint">Injected into the system prompt for autonomous runs. The agent must verify each item before emitting DONE:.</div>' +
    '</div>' +
    '<div class="proj-settings-row">' +
      '<label>QA gate command</label>' +
      '<input type="text" id="proj-set-qa-cmd" class="proj-input proj-mono-input" placeholder="npm test" value="' + _escHtml((proj.qa && proj.qa.command) || '') + '">' +
      '<div class="proj-settings-hint">Runs automatically before the autonomous agent can emit DONE:. A non-zero exit blocks completion and feeds output back to the model.</div>' +
    '</div>' +
    '<div class="proj-settings-row">' +
      '<label>Backlog</label>' +
      '<div id="proj-set-backlog" class="proj-backlog-list">' + _renderBacklogListHtml(proj.backlog || []) + '</div>' +
      '<div class="proj-settings-hint">Top items by score. Use <code>fauna_feature_request_create</code> and <code>fauna_backlog_prioritize</code> tools to manage from chat.</div>' +
    '</div>' +
    _renderCheckpointsSection(proj) +
    '<div class="proj-settings-actions">' +
      '<button class="proj-action-btn" onclick="saveProjectSettings()"><i class="ti ti-check"></i> Save</button>' +
      '<button class="proj-action-btn proj-danger-btn" onclick="confirmDeleteProject()"><i class="ti ti-trash"></i> Delete project</button>' +
    '</div>' +
  '</div>';
}

// ── Project Checkpoints (Settings tab) ───────────────────────────────────
// Sidecar undo/restore — see server/lib/project-checkpoints.js. Renders the
// list async after the section mounts so opening Settings stays fast.
function _renderCheckpointsSection(proj) {
  var cp = proj.checkpoints || {};
  var maxCount = Number.isFinite(cp.maxCount) && cp.maxCount > 0 ? cp.maxCount : 50;
  var maxMB = Number.isFinite(cp.maxBytes) && cp.maxBytes > 0
    ? Math.round(cp.maxBytes / (1024 * 1024))
    : 100;
  var on = function(v) { return v !== false; }; // default true for the toggles
  var rootSet = !!(proj.rootPath && proj.rootPath.trim());
  setTimeout(function() { _loadProjCheckpoints(proj.id); }, 0);
  return (
    '<div class="proj-settings-row">' +
      '<label>Checkpoints</label>' +
      (rootSet
        ? '<div class="proj-cp-controls">' +
            '<button class="proj-action-btn" onclick="createProjectCheckpoint()"><i class="ti ti-camera"></i> Snapshot now</button>' +
            '<input class="proj-input proj-cp-title" id="proj-cp-title" placeholder="(optional label)">' +
          '</div>' +
          '<div id="proj-cp-list" class="proj-cp-list"><div class="proj-cp-empty">Loading…</div></div>' +
          '<div class="proj-cp-settings">' +
            '<label class="proj-toggle-label">' +
              '<input type="checkbox" id="proj-cp-auto-destr" class="proj-toggle-input"' + (on(cp.autoSnapshotOnDestructive) ? ' checked' : '') + '>' +
              '<span class="proj-toggle-track"><span class="proj-toggle-thumb"></span></span>' +
              '<span class="proj-toggle-text">Auto-snapshot before agent patches</span>' +
            '</label>' +
            '<label class="proj-toggle-label">' +
              '<input type="checkbox" id="proj-cp-include-untracked" class="proj-toggle-input"' + (on(cp.includeUntracked) ? ' checked' : '') + '>' +
              '<span class="proj-toggle-track"><span class="proj-toggle-thumb"></span></span>' +
              '<span class="proj-toggle-text">Include untracked files (respects .gitignore)</span>' +
            '</label>' +
            '<div class="proj-cp-retention">' +
              '<label>Keep last <input type="number" min="1" max="500" id="proj-cp-max-count" value="' + maxCount + '" class="proj-input proj-cp-num"></label>' +
              '<label>Cap <input type="number" min="1" max="10240" id="proj-cp-max-mb" value="' + maxMB + '" class="proj-input proj-cp-num"> MB</label>' +
              '<button class="proj-action-btn proj-cp-save-btn" onclick="saveCheckpointSettings()"><i class="ti ti-device-floppy"></i> Save settings</button>' +
            '</div>' +
          '</div>' +
          '<div class="proj-settings-hint">Sidecar history of working-tree changes (uses <code>git ls-files</code> when available so <code>node_modules</code> and other ignored paths are skipped). Restore can preview, 3-way merge, or undo.</div>'
        : '<div class="proj-cp-empty">Set a project folder above to enable checkpoints.</div>') +
    '</div>'
  );
}

async function _loadProjCheckpoints(projectId) {
  var listEl = document.getElementById('proj-cp-list');
  if (!listEl) return;
  try {
    var r = await fetch('/api/projects/' + encodeURIComponent(projectId) + '/checkpoints');
    var data = await r.json();
    if (!data || !data.ok) { listEl.innerHTML = '<div class="proj-cp-empty">Could not load: ' + _escHtml(String((data && data.error) || 'error')) + '</div>'; return; }
    var items = data.checkpoints || [];
    if (!items.length) { listEl.innerHTML = '<div class="proj-cp-empty">No checkpoints yet — click <b>Snapshot now</b> above.</div>'; return; }
    listEl.innerHTML = items.map(function(cp) {
      var when = _projCpFormatTime(cp.createdAt);
      var sizeKB = Math.max(1, Math.round((cp.totalBytes || 0) / 1024));
      var trigger = cp.trigger || 'manual';
      return (
        '<div class="proj-cp-item" data-num="' + cp.number + '">' +
          '<div class="proj-cp-head">' +
            '<span class="proj-cp-number">#' + cp.number + '</span>' +
            '<span class="proj-cp-title">' + _escHtml(cp.title || 'Untitled') + '</span>' +
            '<span class="proj-cp-trigger proj-cp-trigger-' + _escHtml(trigger) + '">' + _escHtml(trigger) + '</span>' +
          '</div>' +
          '<div class="proj-cp-meta">' +
            '<span><i class="ti ti-clock"></i> ' + _escHtml(when) + '</span>' +
            '<span><i class="ti ti-files"></i> ' + (cp.fileCount || 0) + ' file' + (cp.fileCount === 1 ? '' : 's') + '</span>' +
            '<span><i class="ti ti-database"></i> ' + sizeKB + ' KB</span>' +
          '</div>' +
          '<div class="proj-cp-actions">' +
            '<button class="proj-cp-btn" onclick="previewProjectCheckpoint(\'' + projectId + '\',' + cp.number + ')"><i class="ti ti-eye"></i> Preview</button>' +
            '<button class="proj-cp-btn" onclick="restoreProjectCheckpoint(\'' + projectId + '\',' + cp.number + ',\'3way\')"><i class="ti ti-git-merge"></i> Restore (3-way)</button>' +
            '<button class="proj-cp-btn proj-cp-btn-danger" onclick="restoreProjectCheckpoint(\'' + projectId + '\',' + cp.number + ',\'reverse\')" title="Undo this checkpoint\u2019s changes"><i class="ti ti-arrow-back-up"></i> Undo</button>' +
            '<button class="proj-cp-btn proj-cp-btn-danger" onclick="deleteProjectCheckpoint(\'' + projectId + '\',' + cp.number + ')"><i class="ti ti-trash"></i></button>' +
          '</div>' +
        '</div>'
      );
    }).join('');
  } catch (e) {
    listEl.innerHTML = '<div class="proj-cp-empty">Error: ' + _escHtml(e.message || String(e)) + '</div>';
  }
}

function _projCpFormatTime(iso) {
  if (!iso) return '';
  try {
    var d = new Date(iso);
    var now = new Date();
    var sameDay = d.toDateString() === now.toDateString();
    if (sameDay) return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    return d.toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
  } catch (_) { return iso; }
}

async function createProjectCheckpoint() {
  var proj = _activeProject();
  if (!proj) return;
  var titleEl = document.getElementById('proj-cp-title');
  var title = titleEl ? titleEl.value.trim() : '';
  try {
    var r = await fetch('/api/projects/' + encodeURIComponent(proj.id) + '/checkpoints', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: title || undefined, trigger: 'manual' }),
    });
    var data = await r.json();
    if (!data || !data.ok) throw new Error((data && data.error) || 'snapshot failed');
    if (titleEl) titleEl.value = '';
    _showToast('Checkpoint #' + data.checkpoint.number + ' saved (' + data.checkpoint.fileCount + ' files)');
    _loadProjCheckpoints(proj.id);
  } catch (e) { _showToast('Snapshot failed: ' + e.message, true); }
}

async function previewProjectCheckpoint(projectId, number) {
  try {
    var r = await fetch('/api/projects/' + encodeURIComponent(projectId) + '/checkpoints/' + number + '/restore', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ mode: 'preview' }),
    });
    var data = await r.json();
    if (!data || !data.ok) throw new Error((data && data.error) || 'preview failed');
    _showCheckpointPreview(data);
  } catch (e) { _showToast('Preview failed: ' + e.message, true); }
}

function _showCheckpointPreview(data) {
  var existing = document.getElementById('proj-cp-preview');
  if (existing) existing.remove();
  var overlay = document.createElement('div');
  overlay.id = 'proj-cp-preview';
  overlay.className = 'proj-cp-preview-overlay';
  var fileLines = (data.files || []).map(function(f) {
    var icon = f.changeType === 'added' ? 'ti-plus' :
               f.changeType === 'deleted' ? 'ti-minus' :
               f.changeType === 'renamed' ? 'ti-arrow-right' :
               f.changeType === 'untracked' ? 'ti-circle-plus' : 'ti-edit';
    var size = f.size ? ' · ' + Math.max(1, Math.round((f.size || 0) / 1024)) + ' KB' : '';
    var note = f.isTruncated ? ' <span class="proj-cp-trunc">(truncated)</span>' : '';
    return '<div class="proj-cp-file proj-cp-file-' + _escHtml(f.changeType) + '">' +
      '<i class="ti ' + icon + '"></i> ' + _escHtml(f.path) +
      '<span class="proj-cp-file-meta">' + _escHtml(f.changeType) + size + '</span>' +
      note +
    '</div>';
  }).join('');
  var diff = data.patch || '';
  overlay.innerHTML =
    '<div class="proj-cp-preview-card">' +
      '<div class="proj-cp-preview-head">' +
        '<span class="proj-cp-preview-title"><i class="ti ti-eye"></i> ' + _escHtml(data.title || 'Checkpoint') + '</span>' +
        '<button class="proj-icon-btn" onclick="document.getElementById(\'proj-cp-preview\').remove()"><i class="ti ti-x"></i></button>' +
      '</div>' +
      '<div class="proj-cp-preview-files">' + (fileLines || '<div class="proj-cp-empty">No files in checkpoint.</div>') + '</div>' +
      (diff ? '<pre class="proj-cp-preview-diff">' + _escHtml(diff) + '</pre>' : '') +
    '</div>';
  document.body.appendChild(overlay);
  overlay.addEventListener('click', function(e) {
    if (e.target === overlay) overlay.remove();
  });
}

async function restoreProjectCheckpoint(projectId, number, mode) {
  var verb = mode === 'reverse' ? 'undo' : (mode === '3way' ? '3-way merge' : (mode === 'forward' ? 'force-restore' : 'restore'));
  if (!await _projConfirm('Apply ' + verb + ' for checkpoint #' + number + '?\nA "before-restore" snapshot will be created automatically.')) return;
  try {
    var r = await fetch('/api/projects/' + encodeURIComponent(projectId) + '/checkpoints/' + number + '/restore', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ mode: mode || '3way' }),
    });
    var data = await r.json();
    if (!data || !data.ok) {
      var msg = (data && data.error) || 'restore failed';
      if (data && (data.warnings || []).length) msg += '\n' + data.warnings.join('\n');
      throw new Error(msg);
    }
    var applied = (data.applied || []).length;
    var conflicts = (data.conflicts || []).length;
    var warns = (data.warnings || []).length;
    _showToast('Restored: ' + applied + ' applied' +
      (conflicts ? ', ' + conflicts + ' conflict' + (conflicts === 1 ? '' : 's') : '') +
      (warns ? ' (' + warns + ' warning' + (warns === 1 ? '' : 's') + ')' : ''));
    _loadProjCheckpoints(projectId);
  } catch (e) { _showToast('Restore failed: ' + e.message, true); }
}

async function deleteProjectCheckpoint(projectId, number) {
  if (!await _projConfirm('Delete checkpoint #' + number + '? This cannot be undone.')) return;
  try {
    var r = await fetch('/api/projects/' + encodeURIComponent(projectId) + '/checkpoints/' + number, { method: 'DELETE' });
    var data = await r.json();
    if (!data || !data.ok) throw new Error((data && data.error) || 'delete failed');
    _loadProjCheckpoints(projectId);
  } catch (e) { _showToast('Delete failed: ' + e.message, true); }
}

async function saveCheckpointSettings() {
  var proj = _activeProject();
  if (!proj) return;
  var auto = !!(document.getElementById('proj-cp-auto-destr') || {}).checked;
  var inclU = !!(document.getElementById('proj-cp-include-untracked') || {}).checked;
  var maxCount = Math.max(1, Math.min(500, parseInt((document.getElementById('proj-cp-max-count') || {}).value, 10) || 50));
  var maxMB    = Math.max(1, Math.min(10240, parseInt((document.getElementById('proj-cp-max-mb') || {}).value, 10) || 100));
  try {
    var r = await fetch('/api/projects/' + encodeURIComponent(proj.id) + '/checkpoints/settings', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        autoSnapshotOnDestructive: auto,
        includeUntracked: inclU,
        maxCount,
        maxBytes: maxMB * 1024 * 1024,
      }),
    });
    var data = await r.json();
    if (!data || !data.ok) throw new Error((data && data.error) || 'save failed');
    if (data.settings) proj.checkpoints = data.settings;
    _showToast('Checkpoint settings saved');
  } catch (e) { _showToast('Save failed: ' + e.message, true); }
}

function pickProjColor(color) {
  var proj = _activeProject();
  if (!proj) return;
  // Optimistic update in memory
  proj.color = color;
  _renderProjectHubBody(proj);
}

async function browseProjectFolder() {
  try {
    var r = await fetch('/api/pick-folder', { method: 'POST' });
    var data = await r.json();
    if (data.cancelled || !data.folderPath) return;
    var input = document.getElementById('proj-set-root');
    if (input) {
      input.value = data.folderPath;
      input.dataset.dirty = '1';
    }
    // Auto-save immediately so the folder card re-renders
    await saveProjectSettings();
  } catch(e) { _showToast('Could not open folder picker', true); }
}

async function clearProjectFolder() {
  var input = document.getElementById('proj-set-root');
  if (input) input.value = '';
  await saveProjectSettings();
}

async function addRootAsSource() {
  var proj = _activeProject();
  if (!proj || !proj.rootPath) return;
  await _addProjectSource({ type: 'local', path: proj.rootPath });
}

// ── GitHub integration (Settings tab) ─────────────────────────────────────
//
// A project can have multiple git-capable targets (the project's rootPath, and
// any local source whose path is itself a git repo). Each target gets its own
// link to a GitHub account + repo + branch, so repos from different owners
// can be committed with different accounts. The backend enumerates targets
// and returns them in /api/projects/:id/github; we render one card per target.

var _ghTargetsCache = {}; // projId → { targets:[…], orphans:[…] }

function _renderGitHubSection(proj) {
  var host = '<div class="gh-section" id="gh-section-' + _projEsc(proj.id) + '">' +
    '<div class="gh-section-header">' +
      '<span class="gh-section-title"><i class="ti ti-brand-github"></i> GitHub</span>' +
      '<button class="proj-icon-btn" onclick="window.ghAccounts && window.ghAccounts.open()" title="Manage accounts"><i class="ti ti-users"></i> Manage accounts</button>' +
    '</div>' +
    _renderGitTargetsBody(proj.id) +
  '</div>';
  // Kick off the async fetch after this HTML is inserted.
  setTimeout(function() { _refreshGitHubSection(proj.id); }, 0);
  return host;
}
function _renderGitTargetsBody(projId) {
  var cached = _ghTargetsCache[projId];
  if (!cached) {
    return '<div class="gh-targets-loading"><i class="ti ti-loader-2"></i> Scanning git repositories…</div>';
  }
  var targets = cached.targets || [];
  if (!targets.length) {
    return '<div class="gh-unlinked-text gh-empty-targets">' +
      '<i class="ti ti-info-circle"></i> No git repositories found. Set a project folder or add a local source that is a git repo to enable GitHub operations.' +
    '</div>';
  }
  var rows = targets.map(_renderGitTargetRow).join('');
  var orphanCount = (cached.orphans || []).length;
  var orphanNote = orphanCount
    ? '<div class="gh-orphan-note"><i class="ti ti-alert-triangle"></i> ' + orphanCount +
      ' link' + (orphanCount === 1 ? '' : 's') + ' point to sources that no longer exist.</div>'
    : '';
  return rows + orphanNote;
}

function _renderGitTargetRow(t) {
  var pid = _projEsc(t._projId || '');
  var sid = _projEsc(t.sourceId);
  var label = '<div class="gh-target-label">' +
    '<i class="ti ' + (t.kind === 'root' ? 'ti-folder' : 'ti-folder-symlink') + '"></i> ' +
    _projEsc(t.label) +
    ' <span class="gh-target-path" title="' + _projEsc(t.cwd) + '">' + _projEsc(_collapseHome(t.cwd)) + '</span>' +
  '</div>';
  // Folder isn't a git repo yet — show an Initialize action instead of the
  // full link/ops UI. The user can git init right from here.
  if (t.isGitRepo === false) {
    return '<div class="gh-target gh-target-unlinked gh-target-noinit">' +
      label +
      '<div class="gh-target-meta">' +
        '<span class="gh-account-chip gh-account-chip-missing"><i class="ti ti-info-circle"></i> Not a git repository</span>' +
      '</div>' +
      '<div class="gh-target-actions">' +
        '<button class="proj-action-btn" onclick="initGitRepo(\'' + pid + '\', \'' + sid + '\')"><i class="ti ti-git-branch"></i> Initialize git</button>' +
      '</div>' +
    '</div>';
  }
  if (!t.link || !t.link.accountId) {
    return '<div class="gh-target gh-target-unlinked">' +
      label +
      '<div class="gh-target-actions">' +
        '<button class="proj-action-btn" onclick="linkGitHubAccountFlow(\'' + sid + '\')"><i class="ti ti-plug"></i> Link account</button>' +
      '</div>' +
    '</div>';
  }
  var account = t.account
    ? _renderGitAccountChip(t.account)
    : '<span class="gh-account-chip gh-account-chip-missing"><i class="ti ti-alert-triangle"></i> Account removed</span>';
  var repo = '<span class="gh-linked-repo"><i class="ti ti-git-branch"></i> ' + _projEsc(t.link.repo) +
    (t.link.defaultBranch ? '<span class="gh-linked-branch"> &middot; ' + _projEsc(t.link.defaultBranch) + '</span>' : '') +
  '</span>';
  var statusPill = _renderGitStatusPill(t.status);
  var rebaseBanner = (t.status && t.status.rebasing)
    ? '<div class="gh-rebase-banner"><i class="ti ti-alert-circle"></i> Rebase in progress.' +
      ' <button class="gh-mini-btn" onclick="gitOp(\'' + pid + '\', \'' + sid + '\', \'rebase/continue\')">Continue</button>' +
      ' <button class="gh-mini-btn gh-mini-btn-danger" onclick="gitOp(\'' + pid + '\', \'' + sid + '\', \'rebase/abort\')">Abort</button>' +
    '</div>'
    : '';
  var branchPicker = '<div class="gh-branch-picker">' +
    '<button class="gh-branch-btn" onclick="openBranchPicker(\'' + pid + '\', \'' + sid + '\', this)" title="Branches">' +
      '<i class="ti ti-git-branch"></i> ' + _projEsc((t.status && t.status.branch) || '(no branch)') +
      ' <i class="ti ti-chevron-down"></i>' +
    '</button>' +
  '</div>';
  var fileList = _renderGitFileList(t, pid, sid);
  return '<div class="gh-target gh-target-linked">' +
    label +
    '<div class="gh-target-meta">' + account + repo + statusPill + '</div>' +
    rebaseBanner +
    '<div class="gh-target-toolbar">' +
      branchPicker +
      '<span class="gh-ops-spacer"></span>' +
      '<button class="gh-op-btn gh-op-btn-ghost" onclick="linkGitHubAccountFlow(\'' + sid + '\')" title="Change account or repo"><i class="ti ti-switch"></i></button>' +
      '<button class="gh-op-btn gh-op-btn-ghost" onclick="unlinkGitHubAccount(\'' + pid + '\', \'' + sid + '\')" title="Unlink"><i class="ti ti-unlink"></i></button>' +
    '</div>' +
    fileList +
    '<div class="gh-ops-row">' +
      '<button class="gh-op-btn gh-op-btn-primary" onclick="openCommitDialog(\'' + pid + '\', \'' + sid + '\')"><i class="ti ti-git-commit"></i> Commit</button>' +
      '<button class="gh-op-btn" onclick="gitOp(\'' + pid + '\', \'' + sid + '\', \'fetch\')"><i class="ti ti-cloud-download"></i> Fetch</button>' +
      '<button class="gh-op-btn" onclick="gitOp(\'' + pid + '\', \'' + sid + '\', \'pull\')"><i class="ti ti-arrow-down"></i> Pull</button>' +
      '<button class="gh-op-btn" onclick="gitOp(\'' + pid + '\', \'' + sid + '\', \'push\')"><i class="ti ti-arrow-up"></i> Push</button>' +
      '<button class="gh-op-btn" onclick="gitOp(\'' + pid + '\', \'' + sid + '\', \'sync\')"><i class="ti ti-refresh"></i> Sync</button>' +
      '<button class="gh-op-btn gh-op-btn-ghost" onclick="openRebaseDialog(\'' + pid + '\', \'' + sid + '\')" title="Rebase onto a ref"><i class="ti ti-git-merge"></i> Rebase</button>' +
      '<button class="gh-op-btn gh-op-btn-ghost" onclick="openStashMenu(\'' + pid + '\', \'' + sid + '\')" title="Stash"><i class="ti ti-archive"></i></button>' +
    '</div>' +
  '</div>';
}

// Render the changed-files section: a list of porcelain entries with
// per-file checkboxes (preserved across re-renders via _ghFileSelections),
// plus quick Stage all / Unstage all / Discard buttons. Hidden when the repo
// is clean.
var _ghFileSelections = {}; // (projId+sid) → Set of path strings

function _ghSelKey(projId, sid) { return projId + '|' + sid; }
function _getGhSel(projId, sid) {
  var k = _ghSelKey(projId, sid);
  if (!_ghFileSelections[k]) _ghFileSelections[k] = new Set();
  return _ghFileSelections[k];
}

function _renderGitFileList(t, pid, sid) {
  var files = (t.status && t.status.files) || [];
  if (!files.length) {
    return '<div class="gh-files gh-files-empty"><i class="ti ti-check"></i> Working tree clean</div>';
  }
  var sel = _getGhSel(pid, sid);
  // Drop selections for files that no longer exist (handled the commit etc.).
  var live = new Set(files.map(function(f) { return f.path; }));
  Array.from(sel).forEach(function(p) { if (!live.has(p)) sel.delete(p); });

  var rows = files.map(function(f) {
    var status = _gitFileStatusLabel(f);
    var checked = sel.has(f.path) ? ' checked' : '';
    var stageBtn = f.staged
      ? '<button class="gh-mini-btn" title="Unstage" onclick="gitFileOp(\'' + pid + '\', \'' + sid + '\', \'unstage\', \'' + _projEsc(f.path) + '\')"><i class="ti ti-minus"></i></button>'
      : '<button class="gh-mini-btn" title="Stage"   onclick="gitFileOp(\'' + pid + '\', \'' + sid + '\', \'stage\',   \'' + _projEsc(f.path) + '\')"><i class="ti ti-plus"></i></button>';
    var discardBtn = '<button class="gh-mini-btn gh-mini-btn-danger" title="Discard changes" onclick="gitFileOp(\'' + pid + '\', \'' + sid + '\', \'discard\', \'' + _projEsc(f.path) + '\')"><i class="ti ti-trash"></i></button>';
    return '<label class="gh-file-row gh-file-' + status.cls + '">' +
      '<input type="checkbox" class="gh-file-check" data-path="' + _projEsc(f.path) + '"' + checked +
        ' onchange="_onGhFileToggle(\'' + pid + '\', \'' + sid + '\', this)">' +
      '<span class="gh-file-status" title="' + _projEsc(status.title) + '">' + status.short + '</span>' +
      '<span class="gh-file-path" title="' + _projEsc(f.path) + '">' + _projEsc(f.path) + '</span>' +
      '<span class="gh-file-actions">' + stageBtn + discardBtn + '</span>' +
    '</label>';
  }).join('');

  var hdr = '<div class="gh-files-header">' +
    '<span class="gh-files-count">' + files.length + ' changed</span>' +
    '<span class="gh-ops-spacer"></span>' +
    '<button class="gh-mini-btn" onclick="_ghSelectAll(\'' + pid + '\', \'' + sid + '\', true)">All</button>' +
    '<button class="gh-mini-btn" onclick="_ghSelectAll(\'' + pid + '\', \'' + sid + '\', false)">None</button>' +
    '<button class="gh-mini-btn" onclick="gitBulkOp(\'' + pid + '\', \'' + sid + '\', \'stage\')"><i class="ti ti-plus"></i> Stage selected</button>' +
    '<button class="gh-mini-btn gh-mini-btn-danger" onclick="gitBulkOp(\'' + pid + '\', \'' + sid + '\', \'discard\')"><i class="ti ti-trash"></i> Discard selected</button>' +
  '</div>';
  return '<div class="gh-files">' + hdr + '<div class="gh-files-list">' + rows + '</div></div>';
}

function _gitFileStatusLabel(f) {
  if (f.conflicted) return { short: '!!', cls: 'conflict', title: 'Conflicted' };
  if (f.untracked)  return { short: '??', cls: 'untracked', title: 'Untracked' };
  // index/worktree single-letter convention from `git status --porcelain`
  var x = f.indexStatus.trim();
  var y = f.workStatus.trim();
  var titles = { M: 'Modified', A: 'Added', D: 'Deleted', R: 'Renamed', C: 'Copied', T: 'Type changed' };
  var primary = x || y;
  var cls = ({ M: 'modified', A: 'added', D: 'deleted', R: 'renamed', C: 'copied', T: 'modified' })[primary] || 'modified';
  return { short: (x || '·') + (y || '·'), cls: cls, title: (titles[primary] || 'Changed') + (f.staged ? ' (staged)' : '') };
}

function _onGhFileToggle(projId, sid, el) {
  var sel = _getGhSel(projId, sid);
  var p = el.getAttribute('data-path');
  if (el.checked) sel.add(p); else sel.delete(p);
}

function _ghSelectAll(projId, sid, on) {
  var sel = _getGhSel(projId, sid);
  var nodes = document.querySelectorAll('#gh-section-' + projId + ' .gh-file-check');
  nodes.forEach(function(n) {
    n.checked = !!on;
    var p = n.getAttribute('data-path');
    if (on) sel.add(p); else sel.delete(p);
  });
}

/** Single-file op convenience wrapper. */
async function gitFileOp(projId, sid, op, path) {
  if (op === 'discard' && !confirm('Discard local changes to "' + path + '"? This cannot be undone.')) return;
  await gitBulkOp(projId, sid, op, [path]);
}

async function gitBulkOp(projId, sourceId, op, explicitFiles) {
  var files = explicitFiles || Array.from(_getGhSel(projId, sourceId));
  if (!files.length) { _showToast('Select at least one file first', true); return; }
  if (op === 'discard' && !explicitFiles && !confirm('Discard local changes in ' + files.length + ' file(s)? This cannot be undone.')) return;
  // Use `sid` consistently to mirror the parameter name in the URL builder
  // below and avoid shadowing surprises.
  var sid = sourceId;
  try {
    var r = await fetch('/api/projects/' + encodeURIComponent(projId) + '/github/' + encodeURIComponent(sid) + '/' + op, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ files: files }),
    });
    var data = null; try { data = await r.json(); } catch (_) {}
    if (!r.ok) {
      if (data && Array.isArray(data.ignoredPaths) && data.ignoredPaths.length) {
        var sel = _getGhSel(projId, sid);
        data.ignoredPaths.forEach(function(p) { sel.delete(p); });
      }
      throw new Error((data && data.error) || ('HTTP ' + r.status));
    }
    if (op === 'discard' || op === 'stage' || op === 'unstage') {
      _getGhSel(projId, sid).clear();
    }
    _showToast(op + ' ok');
  } catch (e) {
    _showToast(op + ' failed: ' + e.message, true);
  } finally {
    // Always refresh — even on failure the working tree state may have
    // partially changed and the UI must reflect reality.
    delete _ghTargetsCache[projId];
    _refreshGitHubSection(projId);
  }
}

// ── Branch picker popover ───────────────────────────────────────────────

var _ghBranchPopover = null;

async function openBranchPicker(projId, sid, anchorBtn) {
  closeBranchPicker();
  var pop = document.createElement('div');
  pop.className = 'gh-branch-popover';
  pop.innerHTML = '<div class="gh-popover-loading"><i class="ti ti-loader-2"></i> Loading branches…</div>';
  document.body.appendChild(pop);
  _ghBranchPopover = pop;
  var rect = anchorBtn.getBoundingClientRect();
  pop.style.top  = (rect.bottom + 4) + 'px';
  pop.style.left = rect.left + 'px';
  // One-shot dismiss when clicking outside.
  setTimeout(function() {
    document.addEventListener('mousedown', _onBranchDocDown, true);
  }, 0);
  try {
    var r = await fetch('/api/projects/' + encodeURIComponent(projId) + '/github/' + encodeURIComponent(sid) + '/branches');
    var data = await r.json();
    if (!r.ok) throw new Error(data.error || ('HTTP ' + r.status));
    pop.innerHTML = _renderBranchPopover(projId, sid, data);
  } catch (e) {
    pop.innerHTML = '<div class="gh-popover-err">' + _projEsc(e.message) + '</div>';
  }
}

function closeBranchPicker() {
  if (_ghBranchPopover) {
    try { _ghBranchPopover.remove(); } catch (_) {}
    _ghBranchPopover = null;
  }
  document.removeEventListener('mousedown', _onBranchDocDown, true);
}

function _onBranchDocDown(e) {
  if (!_ghBranchPopover) return;
  if (e.target.closest('.gh-branch-popover')) return;
  closeBranchPicker();
}

function _renderBranchPopover(projId, sid, data) {
  var local = (data.local || []).map(function(b) {
    var cls = b.current ? 'gh-branch-row gh-branch-current' : 'gh-branch-row';
    var actions = b.current ? '<span class="gh-branch-flag">current</span>' :
      '<button class="gh-mini-btn" title="Delete branch" onclick="event.stopPropagation();deleteBranch(\'' + projId + '\',\'' + sid + '\',\'' + _projEsc(b.name) + '\')"><i class="ti ti-trash"></i></button>';
    var click = b.current ? '' : ' onclick="checkoutBranch(\'' + projId + '\',\'' + sid + '\',\'' + _projEsc(b.name) + '\')"';
    return '<div class="' + cls + '"' + click + '><i class="ti ti-git-branch"></i> ' + _projEsc(b.name) +
      (b.upstream ? ' <span class="gh-branch-upstream">→ ' + _projEsc(b.upstream) + '</span>' : '') +
      '<span class="gh-ops-spacer"></span>' + actions + '</div>';
  }).join('') || '<div class="gh-empty-sub">No local branches.</div>';
  var remote = (data.remote || []).map(function(b) {
    return '<div class="gh-branch-row gh-branch-remote" onclick="createBranchFromRemote(\'' + projId + '\',\'' + sid + '\',\'' + _projEsc(b.name) + '\')">' +
      '<i class="ti ti-cloud"></i> ' + _projEsc(b.name) +
      '<span class="gh-ops-spacer"></span>' +
      '<span class="gh-branch-flag">checkout</span>' +
    '</div>';
  }).join('') || '';
  return '<div class="gh-branch-section">' +
      '<div class="gh-branch-section-title">Local</div>' + local +
    '</div>' +
    (remote ? '<div class="gh-branch-section"><div class="gh-branch-section-title">Remote</div>' + remote + '</div>' : '') +
    '<div class="gh-branch-actions">' +
      '<button class="gh-op-btn gh-op-btn-primary" onclick="createBranchFlow(\'' + projId + '\',\'' + sid + '\')"><i class="ti ti-plus"></i> New branch from HEAD</button>' +
    '</div>';
}

async function checkoutBranch(projId, sid, name) {
  closeBranchPicker();
  try {
    var r = await fetch('/api/projects/' + encodeURIComponent(projId) + '/github/' + encodeURIComponent(sid) + '/checkout', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: name }),
    });
    var data = null; try { data = await r.json(); } catch (_) {}
    if (!r.ok) throw new Error((data && data.error) || ('HTTP ' + r.status));
    _showToast('Switched to ' + name);
    delete _ghTargetsCache[projId];
    _refreshGitHubSection(projId);
  } catch (e) { _showToast('Checkout failed: ' + e.message, true); }
}

async function createBranchFlow(projId, sid) {
  closeBranchPicker();
  var name = await _projPrompt({
    title: 'Create branch',
    label: 'New branch name',
    placeholder: 'feature/my-change',
    submit: 'Create',
    validate: function(v) { return (v || '').trim() ? null : 'Branch name is required.'; },
  });
  if (name === null) return;
  name = name.trim();
  if (!name) return;
  try {
    var r = await fetch('/api/projects/' + encodeURIComponent(projId) + '/github/' + encodeURIComponent(sid) + '/branches', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: name.trim(), checkout: true }),
    });
    var data = null; try { data = await r.json(); } catch (_) {}
    if (!r.ok) throw new Error((data && data.error) || ('HTTP ' + r.status));
    _showToast('Created and checked out ' + name);
    delete _ghTargetsCache[projId];
    _refreshGitHubSection(projId);
  } catch (e) { _showToast('Create branch failed: ' + e.message, true); }
}

async function createBranchFromRemote(projId, sid, remoteName) {
  closeBranchPicker();
  // remoteName is like "origin/feature-x" — propose stripping the remote.
  var suggested = remoteName.replace(/^[^\/]+\//, '');
  var local = await _projPrompt({
    title: 'Checkout remote branch',
    label: 'Local branch name for ' + remoteName,
    defaultValue: suggested,
    submit: 'Checkout',
    validate: function(v) { return (v || '').trim() ? null : 'Branch name is required.'; },
  });
  if (local === null) return;
  local = local.trim();
  if (!local) return;
  try {
    var r = await fetch('/api/projects/' + encodeURIComponent(projId) + '/github/' + encodeURIComponent(sid) + '/branches', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: local.trim(), from: remoteName, checkout: true }),
    });
    var data = null; try { data = await r.json(); } catch (_) {}
    if (!r.ok) throw new Error((data && data.error) || ('HTTP ' + r.status));
    _showToast('Checked out ' + local);
    delete _ghTargetsCache[projId];
    _refreshGitHubSection(projId);
  } catch (e) { _showToast('Checkout failed: ' + e.message, true); }
}

async function deleteBranch(projId, sid, name) {
  if (!confirm('Delete local branch "' + name + '"?')) return;
  try {
    var r = await fetch('/api/projects/' + encodeURIComponent(projId) + '/github/' + encodeURIComponent(sid) + '/branches/delete', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: name }),
    });
    var data = null; try { data = await r.json(); } catch (_) {}
    if (!r.ok) {
      // Offer force-delete on the typical "not fully merged" failure.
      if (/not fully merged|merged/i.test((data && (data.error + ' ' + (data.stderr || ''))) || '')) {
        if (!confirm('Branch is not fully merged. Force delete?')) return;
        var f = await fetch('/api/projects/' + encodeURIComponent(projId) + '/github/' + encodeURIComponent(sid) + '/branches/delete', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name: name, force: true }),
        });
        var d2 = null; try { d2 = await f.json(); } catch (_) {}
        if (!f.ok) throw new Error((d2 && d2.error) || 'force-delete failed');
      } else {
        throw new Error((data && data.error) || ('HTTP ' + r.status));
      }
    }
    _showToast('Deleted ' + name);
    delete _ghTargetsCache[projId];
    _refreshGitHubSection(projId);
    openBranchPicker(projId, sid, document.querySelector('#gh-section-' + projId + ' .gh-branch-btn'));
  } catch (e) { _showToast('Delete failed: ' + e.message, true); }
}

async function openRebaseDialog(projId, sid) {
  var t = _ghTargetsCache[projId] && (_ghTargetsCache[projId].targets || []).find(function(x) { return x.sourceId === sid; });
  var defaultOnto = (t && t.link && t.link.defaultBranch) ? ('origin/' + t.link.defaultBranch) : 'origin/main';
  var onto = await _projPrompt({
    title: 'Rebase',
    label: 'Rebase current branch onto which ref?',
    defaultValue: defaultOnto,
    submit: 'Rebase',
    validate: function(v) { return (v || '').trim() ? null : 'Target ref is required.'; },
  });
  if (onto === null) return;
  onto = onto.trim();
  if (!onto) return;
  try {
    var r = await fetch('/api/projects/' + encodeURIComponent(projId) + '/github/' + encodeURIComponent(sid) + '/rebase', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ onto: onto.trim() }),
    });
    var data = null; try { data = await r.json(); } catch (_) {}
    if (!r.ok) throw new Error((data && data.error) || ('HTTP ' + r.status));
    _showToast('Rebased onto ' + onto);
    delete _ghTargetsCache[projId];
    _refreshGitHubSection(projId);
  } catch (e) { _showToast('Rebase failed: ' + e.message, true); }
}

async function openStashMenu(projId, sid) {
  var action = await _projPrompt({
    title: 'Stash',
    label: 'Action — type "push", "pop", or "list"',
    defaultValue: 'push',
    submit: 'Continue',
  });
  if (action === null) return;
  action = (action || '').trim().toLowerCase();
  if (!action) return;
  if (action === 'push') {
    var msg = await _projPrompt({
      title: 'Stash changes',
      label: 'Stash message (optional)',
      defaultValue: '',
      submit: 'Stash',
    });
    if (msg === null) return;
    await fetch('/api/projects/' + encodeURIComponent(projId) + '/github/' + encodeURIComponent(sid) + '/stash', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: msg || '' }),
    }).then(async function(r) {
      var d = await r.json(); if (!r.ok) throw new Error(d.error);
      _showToast('Stashed'); delete _ghTargetsCache[projId]; _refreshGitHubSection(projId);
    }).catch(function(e) { _showToast('Stash failed: ' + e.message, true); });
  } else if (action === 'pop') {
    await fetch('/api/projects/' + encodeURIComponent(projId) + '/github/' + encodeURIComponent(sid) + '/stash/pop', { method: 'POST' })
      .then(async function(r) {
        var d = await r.json(); if (!r.ok) throw new Error(d.error);
        _showToast('Stash popped'); delete _ghTargetsCache[projId]; _refreshGitHubSection(projId);
      }).catch(function(e) { _showToast('Pop failed: ' + e.message, true); });
  } else if (action === 'list') {
    var r = await fetch('/api/projects/' + encodeURIComponent(projId) + '/github/' + encodeURIComponent(sid) + '/stash');
    var d = await r.json();
    if (!r.ok) { _showToast(d.error, true); return; }
    if (!d.entries.length) { _showToast('No stashes'); return; }
    alert(d.entries.map(function(s) { return s.ref + '  ' + s.subject; }).join('\n'));
  }
}

function _collapseHome(p) {
  if (!p) return '';
  // Heuristic: collapse leading /Users/<x>/ or /home/<x>/ to ~/ for compactness.
  return String(p).replace(/^\/Users\/[^/]+\//, '~/').replace(/^\/home\/[^/]+\//, '~/');
}

function _renderGitAccountChip(account) {
  if (!account) return '<span class="gh-account-chip gh-account-chip-missing"><i class="ti ti-alert-triangle"></i> Account removed</span>';
  var avatar = account.avatarUrl
    ? '<img class="gh-account-chip-avatar" src="' + _projEsc(account.avatarUrl) + '" alt="">'
    : '<i class="ti ti-user"></i>';
  return '<span class="gh-account-chip">' + avatar +
    '<span class="gh-account-chip-login">' + _projEsc(account.login) + '</span>' +
  '</span>';
}

function _renderGitStatusPill(status) {
  if (!status) return '';
  if (!status.isRepo) {
    return '<span class="gh-status-pill gh-status-warn" title="Not a git repository"><i class="ti ti-alert-triangle"></i> Not a git repo</span>';
  }
  var parts = [];
  if (status.dirty)  parts.push('<span class="gh-status-pill gh-status-dirty"><i class="ti ti-pencil"></i> ' + status.dirty + ' changed</span>');
  if (status.ahead)  parts.push('<span class="gh-status-pill gh-status-ahead"><i class="ti ti-arrow-up"></i> ' + status.ahead + ' ahead</span>');
  if (status.behind) parts.push('<span class="gh-status-pill gh-status-behind"><i class="ti ti-arrow-down"></i> ' + status.behind + ' behind</span>');
  if (!parts.length) parts.push('<span class="gh-status-pill gh-status-clean"><i class="ti ti-check"></i> Clean</span>');
  if (status.branch) parts.unshift('<span class="gh-status-pill gh-status-branch"><i class="ti ti-git-branch"></i> ' + _projEsc(status.branch) + '</span>');
  return parts.join('');
}

async function _refreshGitHubSection(projId) {
  try {
    var r = await fetch('/api/projects/' + encodeURIComponent(projId) + '/github');
    if (!r.ok) return;
    var data = await r.json();
    // Stamp each target with the parent projId so row markup can reference it.
    (data.targets || []).forEach(function(t) { t._projId = projId; });
    _ghTargetsCache[projId] = data;
    var host = document.getElementById('gh-section-' + projId);
    if (!host) return;
    var proj = _activeProject();
    if (!proj || proj.id !== projId) return;
    // Replace only the body to avoid wiping the section header. If the
    // header isn't there for some reason (DOM mutated by another renderer),
    // fall back to re-rendering the whole section so we never end up in a
    // state where the cache is fresh but the DOM still shows old data.
    var headerEl = host.querySelector('.gh-section-header');
    if (headerEl) {
      host.innerHTML = headerEl.outerHTML + _renderGitTargetsBody(projId);
    } else {
      host.outerHTML = _renderGitHubSection(proj);
    }
    _ensureGitHubSectionPolling(projId);
  } catch (e) {
    // Don't swallow silently — at least log so the devtools console has a
    // trail when refresh fails mid-op.
    console.warn('[projects] gh refresh failed:', e && e.message);
  }
}

// Lightweight polling: while the GitHub section is mounted in the DOM,
// re-fetch status every few seconds so external changes (terminal commits,
// IDE saves, dev-server file rewrites, another window's git ops) catch up
// without the user having to leave settings and come back.
var _ghPollTimers = {};
function _ensureGitHubSectionPolling(projId) {
  if (_ghPollTimers[projId]) return;
  _ghPollTimers[projId] = setInterval(function() {
    var host = document.getElementById('gh-section-' + projId);
    if (!host) {
      clearInterval(_ghPollTimers[projId]);
      delete _ghPollTimers[projId];
      return;
    }
    // Only refresh when the section is actually visible — avoids hammering
    // git when the user has scrolled away or collapsed settings.
    var rect = host.getBoundingClientRect();
    var visible = rect.bottom > 0 && rect.top < (window.innerHeight || document.documentElement.clientHeight);
    if (!visible) return;
    _refreshGitHubSection(projId);
  }, 4000);
}

/**
 * Two-step link flow scoped to a specific source: pick an account from the
 * manager, then prompt for the owner/repo string for that target.
 */
async function linkGitHubAccountFlow(sourceId) {
  var proj = _activeProject();
  if (!proj || !sourceId) return;
  if (!window.ghAccounts) { _showToast('GitHub manager not loaded', true); return; }
  try {
    var account = await window.ghAccounts.pickAccount();
    if (!account) return; // user dismissed
    var cached = _ghTargetsCache[proj.id];
    var target = cached && (cached.targets || []).find(function(t) { return t.sourceId === sourceId; });
    var existing = (target && target.link) || {};
    var defaultName = (target && target.label ? target.label : (proj.name || 'repo'))
      .toLowerCase().replace(/[^a-z0-9._-]+/g, '-');
    // Mode selection: link to an existing repo, or create a brand new one on
    // GitHub under this account (user or one of its orgs). The Esc / cancel
    // path returns null and we just bail.
    var choice = await _projPrompt({
      title: 'Link "' + (target ? target.label : sourceId) + '" to GitHub',
      label: 'Enter an existing repo as "owner/name", or type "new" to create one.',
      defaultValue: existing.repo || (account.login + '/' + defaultName),
      submit: 'Continue',
    });
    if (choice === null) return;
    choice = choice.trim();
    if (!choice) return;
    var repo, defaultBranch = existing.defaultBranch || null;
    if (choice.toLowerCase() === 'new' || choice.toLowerCase() === 'create') {
      var created = await _createGitHubRepoFlow(account, defaultName);
      if (!created) return;
      repo = created.repo;
      defaultBranch = created.defaultBranch || defaultBranch;
    } else {
      repo = choice.replace(/^https?:\/\/github\.com\//i, '').replace(/\.git$/i, '');
      if (!/^[^\/\s]+\/[^\/\s]+$/.test(repo)) { _showToast('Repo must be in the form "owner/name"', true); return; }
      var branch = await _projPrompt({
        title: 'Default branch',
        label: 'Default branch (leave blank for current)',
        defaultValue: defaultBranch || '',
        submit: 'Save',
      });
      if (branch === null) return;
      defaultBranch = branch.trim() || defaultBranch;
    }
    var body = { accountId: account.id, repo: repo, defaultBranch: defaultBranch };
    var r = await fetch('/api/projects/' + encodeURIComponent(proj.id) + '/github/' + encodeURIComponent(sourceId), {
      method: 'PUT', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    var data = null; try { data = await r.json(); } catch (_) {}
    if (!r.ok) throw new Error((data && data.error) || ('HTTP ' + r.status));
    _showToast('Linked ' + (target ? target.label : sourceId) + ' to ' + repo);
    delete _ghTargetsCache[proj.id];
    await _refreshProject(proj.id);
  } catch (e) { _showToast('Link failed: ' + e.message, true); }
}

/**
 * Walk the user through creating a new repo on GitHub. Loads the owners list
 * for the account (user + any orgs), then collects name / visibility /
 * description in a single modal. Returns { repo:'owner/name', defaultBranch,
 * htmlUrl } or null if the user cancelled.
 */
async function _createGitHubRepoFlow(account, suggestedName) {
  // 1. Discover the owners we can publish under.
  var ownersResp = await fetch('/api/github/accounts/' + encodeURIComponent(account.id) + '/owners');
  if (!ownersResp.ok) {
    _showToast('Could not load owners for @' + account.login, true);
    return null;
  }
  var owners = (await ownersResp.json()).owners || [];
  if (!owners.length) owners = [{ login: account.login, type: 'User' }];

  // 2. Combined modal: owner + name + visibility + description.
  var ownerOptions = owners.map(function(o) {
    return { value: o.login, label: o.login + (o.type === 'Organization' ? '  (org)' : '  (you)') };
  });
  var values = await new Promise(function(resolve) {
    _projModal({
      title: 'Create new GitHub repo',
      submit: 'Create',
      fields: [
        { id: 'owner',       label: 'Owner',                 type: 'select', options: ownerOptions, value: account.login },
        { id: 'name',        label: 'Repo name',             placeholder: suggestedName, value: suggestedName },
        { id: 'visibility',  label: 'Visibility',            type: 'select', options: [
          { value: 'private', label: 'Private' },
          { value: 'public',  label: 'Public'  },
        ], value: 'private' },
        { id: 'description', label: 'Description (optional)' },
      ],
      onSubmit: function(v) {
        var name = (v.name || suggestedName || '').trim();
        if (!name) return 'Repo name is required.';
        if (!/^[A-Za-z0-9._-]+$/.test(name)) return 'Use letters, digits, dot, dash, underscore.';
        resolve({ owner: v.owner, name: name, visibility: v.visibility, description: (v.description || '').trim() });
        return null;
      },
      onCancel: function() { resolve(null); },
    });
  });
  if (!values) return null;

  // 3. Create.
  var r = await fetch('/api/github/accounts/' + encodeURIComponent(account.id) + '/repos', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      owner: values.owner,
      name: values.name,
      description: values.description,
      private: values.visibility !== 'public',
      autoInit: false,    // never auto-init — the local repo will be pushed up
    }),
  });
  var data = null; try { data = await r.json(); } catch (_) {}
  if (!r.ok) {
    _showToast('Create failed: ' + ((data && data.error) || ('HTTP ' + r.status)), true);
    return null;
  }
  _showToast('Created ' + data.repo + ' (' + (data.private ? 'private' : 'public') + ')');
  return data;
}

async function unlinkGitHubAccount(projId, sourceId) {
  if (!confirm('Unlink this source from GitHub? The stored account itself is not deleted.')) return;
  try {
    var r = await fetch('/api/projects/' + encodeURIComponent(projId) + '/github/' + encodeURIComponent(sourceId), { method: 'DELETE' });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    delete _ghTargetsCache[projId];
    _showToast('Unlinked');
    await _refreshProject(projId);
  } catch (e) { _showToast('Unlink failed: ' + e.message, true); }
}

// Initialize a plain folder as a git repo (runs `git init -b <branch>`).
// After it succeeds the section is re-fetched and the row will switch to
// the normal "Link account" state.
async function initGitRepo(projId, sourceId) {
  var branch = await _projPrompt({
    title: 'Initialize git repository',
    label: 'Initial branch name',
    defaultValue: 'main',
    submit: 'Initialize',
    validate: function(v) {
      v = (v || '').trim();
      if (!v) return 'Branch name is required.';
      if (!/^[A-Za-z0-9._\/-]+$/.test(v)) return 'Use letters, digits, dot, dash, underscore, or slash.';
      return null;
    },
  });
  if (branch === null) return;
  branch = branch.trim();
  try {
    var r = await fetch('/api/projects/' + encodeURIComponent(projId) + '/github/' + encodeURIComponent(sourceId) + '/init', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ initialBranch: branch }),
    });
    var data = null; try { data = await r.json(); } catch (_) {}
    if (!r.ok) throw new Error((data && data.error) || ('HTTP ' + r.status));
    _showToast(data && data.alreadyInitialized ? 'Already a git repo' : ('Initialized on branch ' + (data.branch || branch)));
    delete _ghTargetsCache[projId];
    await _refreshProject(projId);
  } catch (e) { _showToast('Init failed: ' + e.message, true); }
}

async function gitOp(projId, sourceId, op, opts) {
  opts = opts || {};
  var section = document.getElementById('gh-section-' + projId);
  var btnHosts = section ? section.querySelectorAll('.gh-op-btn') : [];
  for (var i = 0; i < btnHosts.length; i++) btnHosts[i].disabled = true;
  try {
    var r = await fetch('/api/projects/' + encodeURIComponent(projId) + '/github/' + encodeURIComponent(sourceId) + '/' + op, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(opts.body || {}),
    });
    var data = null; try { data = await r.json(); } catch (_) {}
    if (!r.ok) {
      // Ignored-paths errors are user-fixable: drop them from the selection
      // so the next click works without the user having to hunt them down.
      if (data && Array.isArray(data.ignoredPaths) && data.ignoredPaths.length) {
        var sel = _getGhSel(projId, sourceId);
        data.ignoredPaths.forEach(function(p) { sel.delete(p); });
      }
      throw new Error((data && data.error) || ('HTTP ' + r.status));
    }
    var msg = op[0].toUpperCase() + op.slice(1) + ' ok';
    if (data && data.status) {
      var s = data.status;
      var bits = [];
      if (s.dirty)  bits.push(s.dirty + ' changed');
      if (s.ahead)  bits.push(s.ahead + ' ahead');
      if (s.behind) bits.push(s.behind + ' behind');
      if (!bits.length && s.isRepo) bits.push('clean');
      if (bits.length) msg += ' — ' + bits.join(', ');
    }
    _showToast(msg);
    if (op === 'commit') _getGhSel(projId, sourceId).clear();
  } catch (e) {
    // Surface as much of the real error as we can — the server already
    // includes the git stderr in `data.error` for commit/push failures.
    _showToast(op + ' failed: ' + e.message, true);
  } finally {
    // Always re-enable buttons AND refresh the section, even on failure.
    // Otherwise a 500 leaves the UI showing stale "Commit (N selected)" with
    // disabled buttons and the user has to leave settings and come back to
    // see the real state.
    for (var j = 0; j < btnHosts.length; j++) btnHosts[j].disabled = false;
    delete _ghTargetsCache[projId];
    var proj = _activeProject();
    if (proj && proj.id === projId) _refreshGitHubSection(projId);
  }
}

async function openCommitDialog(projId, sourceId) {
  // If the user has explicitly checked some files, commit only those;
  // otherwise fall back to the legacy "stage everything" behaviour. This
  // matches VS Code's "Commit (selected)" vs "Commit all" model.
  var sel = Array.from(_getGhSel(projId, sourceId));
  var hint = sel.length ? ' (' + sel.length + ' selected)' : ' (all changes)';
  var msg = await _projPrompt({
    title: 'Commit' + hint,
    label: 'Commit message',
    defaultValue: 'Update from Fauna',
    submit: 'Commit',
    multiline: true,
    validate: function(v) { return (v || '').trim() ? null : 'Commit message is required.'; },
  });
  if (msg === null) return;
  msg = msg.trim();
  if (!msg) return;
  var body = { message: msg };
  if (sel.length) body.files = sel;
  gitOp(projId, sourceId, 'commit', { body: body });
}

// Persist a single boolean project setting immediately (no full-form Save
// needed). Used by the File-editing and Autonomous-mode toggles so they behave
// like real switches and never silently revert.
async function _toggleProjSetting(field, el) {
  var proj = _activeProject();
  if (!proj || !el) return;
  var val = !!el.checked;
  proj[field] = val; // optimistic
  try {
    var patch = {};
    patch[field] = val;
    var r = await fetch('/api/projects/' + proj.id, {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(patch)
    });
    if (!r.ok) throw new Error((await r.json()).error);
    await _refreshProject(proj.id);
    if (field === 'allowFileEditing') {
      // Reflect the new permission in any open file viewer and force the file
      // tree to reload (cached entries were fetched under the old permission).
      _hubTreeState.dirCache = {};
      if (_projMonacoEditor) {
        try { _projMonacoEditor.updateOptions({ readOnly: !val }); } catch(_) {}
      }
    }
    _showToast(val ? 'Enabled' : 'Disabled');
  } catch(e) {
    el.checked = !val;
    proj[field] = !val;
    _showToast('Error: ' + e.message, true);
  }
}

async function saveProjectSettings() {
  var proj = _activeProject();
  if (!proj) return;
  var prevRoot = (proj.rootPath || '').trim();
  var name = (document.getElementById('proj-set-name') || {}).value || proj.name;
  var desc = (document.getElementById('proj-set-desc') || {}).value || '';
  var root = (document.getElementById('proj-set-root') || {}).value || null;
  var allowEdit = !!(document.getElementById('proj-set-allow-edit') || {}).checked;
  var autonomous = !!(document.getElementById('proj-set-autonomous') || {}).checked;
  var acceptance = (document.getElementById('proj-set-acceptance') || {}).value || '';
  var qaCmd = (document.getElementById('proj-set-qa-cmd') || {}).value || '';
  var existingQa = (proj.qa && typeof proj.qa === 'object') ? proj.qa : {};
  var qa = { command: qaCmd, browserSmoke: existingQa.browserSmoke || '', requireScreenshot: !!existingQa.requireScreenshot };
  try {
    var r = await fetch('/api/projects/' + proj.id, {
      method: 'PUT', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, description: desc, rootPath: root || null, color: proj.color, allowFileEditing: allowEdit, autonomousMode: autonomous, acceptanceCriteria: acceptance, qa: qa })
    });
    if (!r.ok) throw new Error((await r.json()).error);
    await _refreshProject(proj.id);
    // The project folder and/or file-editing permission may have changed —
    // invalidate the cached file tree (and reset the selected source when the
    // working folder moved) so the Files tab reloads fresh next time it opens.
    var newRoot = ((root || '')).trim();
    if (newRoot !== prevRoot) state._projectFileSrcId = null;
    _hubTreeState.dirCache = {};
    _hubTreeState.expanded = {};
    if (_projMonacoEditor) {
      try { _projMonacoEditor.updateOptions({ readOnly: !allowEdit }); } catch(_) {}
    }
    renderProjectSwitcher();
    _renderProjectHub(_activeProject());
    _showToast('Project saved');
  } catch(e) { _showToast('Error: ' + e.message, true); }
}

function _deleteProjectConversations(projectId) {
  var ids = state.conversations
    .filter(function(c) { return c.projectId === projectId; })
    .map(function(c) { return c.id; });
  if (!ids.length) return;
  ids.forEach(function(id) {
    if (typeof _destroyConvBrowserTabs === 'function') _destroyConvBrowserTabs(id);
    if (typeof purgeConvDom === 'function') purgeConvDom(id);
    fetch('/api/conversations/' + id, { method: 'DELETE' }).catch(function() {});
  });
  state.conversations = state.conversations.filter(function(c) { return c.projectId !== projectId; });
  if (typeof saveConversations === 'function') saveConversations();
  if (ids.includes(state.currentId)) {
    state.currentId = null;
    if (state.conversations.length && typeof loadConversation === 'function') loadConversation(state.conversations[0].id);
    else if (typeof showEmpty === 'function') showEmpty();
  }
  if (typeof renderConvList === 'function') renderConvList();
}

async function confirmDeleteProject() {
  var proj = _activeProject();
  if (!proj) return;
  if (!await _projConfirm('Delete project \u201c' + proj.name + '\u201d? This cannot be undone.')) return;
  try {
    var id = proj.id;
    await fetch('/api/projects/' + id, { method: 'DELETE' });
    var idx = state.projects.findIndex(function(p) { return p.id === id; });
    if (idx !== -1) state.projects.splice(idx, 1);
    _deleteProjectConversations(id);
    clearActiveProject();
  } catch(e) { _showToast('Error: ' + e.message, true); }
}

// ── Project Picker ────────────────────────────────────────────────────────

function openProjectPicker() {
  var existing = document.getElementById('proj-picker-overlay');
  if (existing) { existing.remove(); return; }
  var overlay = document.createElement('div');
  overlay.id = 'proj-picker-overlay';
  overlay.className = 'proj-picker-overlay';
  overlay.onclick = function(e) { if (e.target === overlay) overlay.remove(); };
  var html = '<div class="proj-picker-panel">' +
    '<div class="proj-picker-header"><span>Switch Project</span><button onclick="document.getElementById(\'proj-picker-overlay\').remove()"><i class="ti ti-x"></i></button></div>' +
    '<div class="proj-picker-list">' +
    (state.projects.length ? state.projects.map(function(p) {
      return '<div class="proj-picker-item' + (p.id === state.activeProjectId ? ' active' : '') + '" onclick="setActiveProject(\'' + p.id + '\');document.getElementById(\'proj-picker-overlay\').remove()">' +
        '<span class="proj-dot proj-color-' + _projEsc(p.color) + '"></span>' +
        '<span class="proj-picker-name">' + _projEsc(p.name) + '</span>' +
        (p.design && p.design.projectType === 'design' ? '<span class="proj-design-badge"><i class="ti ti-layout-2"></i> Design</span>' : '') +
      '</div>';
    }).join('') : '<div style="padding:12px;color:var(--fau-text-dim)">No projects yet</div>') +
    '</div>' +
    '<div class="proj-picker-footer">' +
      '<button class="proj-action-btn" onclick="openCreateProjectDialog();document.getElementById(\'proj-picker-overlay\').remove()"><i class="ti ti-plus"></i> New project</button>' +
    '</div>' +
  '</div>';
  overlay.innerHTML = html;
  document.body.appendChild(overlay);
}

// ── Create Project Dialog ─────────────────────────────────────────────────

function openCreateProjectDialog() {
  var existing = document.getElementById('proj-create-overlay');
  if (existing) { existing.remove(); return; }
  var overlay = document.createElement('div');
  overlay.id = 'proj-create-overlay';
  overlay.className = 'proj-picker-overlay';
  overlay.onclick = function(e) { if (e.target === overlay) overlay.remove(); };
  overlay.innerHTML =
    '<div class="proj-picker-panel">' +
      '<div class="proj-picker-header"><span>New Project</span><button onclick="document.getElementById(\'proj-create-overlay\').remove()"><i class="ti ti-x"></i></button></div>' +
      '<div class="proj-form">' +
        '<div class="proj-settings-row"><label>Name</label><input class="proj-input" id="proj-new-name" placeholder="My project"></div>' +
        '<div class="proj-settings-row"><label>Description</label><input class="proj-input" id="proj-new-desc" placeholder="Optional description"></div>' +
        '<div class="proj-settings-row"><label>Type</label>' +
          '<div class="proj-type-toggle" id="proj-new-type">' +
            '<button class="proj-type-btn active" data-type="" onclick="_pickProjType(this)"><i class="ti ti-code"></i> Code / General</button>' +
            '<button class="proj-type-btn" data-type="design" onclick="_pickProjType(this)"><i class="ti ti-layout-2"></i> Design</button>' +
          '</div>' +
        '</div>' +
        '<div class="proj-settings-row" id="proj-new-design-row" style="display:none"><label>Skills</label>' +
          '<div class="proj-skill-checks" id="proj-new-skill-checks">Loading…</div>' +
        '</div>' +
        '<div class="proj-settings-row"><label>Root path</label><div style="display:flex;gap:6px;flex:1"><input class="proj-input" id="proj-new-root" placeholder="~/code/myproject (optional)" style="flex:1"><button class="proj-action-btn" type="button" onclick="browseNewProjectFolder()" title="Browse"><i class="ti ti-folder-open"></i></button></div></div>' +
        '<div class="proj-settings-row"><label>Color</label>' +
          '<div class="proj-color-picker" id="proj-new-color-picker">' +
            ['teal','teal2','purple','green','orange','red','violet','pink'].map(function(c,i) {
              return '<button class="proj-color-dot proj-color-' + c + (i===0?' active':'') + '" onclick="pickNewProjColor(\'' + c + '\')" title="' + c + '"></button>';
            }).join('') +
          '</div>' +
        '</div>' +
      '</div>' +
      '<div class="proj-picker-footer">' +
        '<button class="proj-action-btn" onclick="submitCreateProject()"><i class="ti ti-check"></i> Create</button>' +
      '</div>' +
    '</div>';
  document.body.appendChild(overlay);
  setTimeout(function(){ var n = document.getElementById('proj-new-name'); if(n) n.focus(); }, 50);
  window._newProjColor = 'teal';
  window._newProjType  = '';
  // Pre-populate skill list
  if (typeof loadDesignCatalog === 'function') {
    loadDesignCatalog(function(catalog) {
      var checks = document.getElementById('proj-new-skill-checks');
      if (checks) {
        checks.innerHTML = (catalog.skills || []).map(function(s) {
          return '<label class="proj-skill-check">' +
            '<input type="checkbox" value="' + _projEsc(s.id) + '"> ' + _projEsc(s.name) +
          '</label>';
        }).join('');
        if (!(catalog.skills || []).length) checks.textContent = 'No skills available';
      }
    });
  }
}

async function browseNewProjectFolder() {
  try {
    var r = await fetch('/api/pick-folder', { method: 'POST' });
    var data = await r.json();
    if (data.cancelled || !data.folderPath) return;
    var input = document.getElementById('proj-new-root');
    if (input) input.value = data.folderPath;
  } catch(e) { _showToast('Could not open folder picker', true); }
}

function _pickProjType(btn) {
  window._newProjType = btn.dataset.type || '';
  var row = document.getElementById('proj-new-design-row');
  if (row) row.style.display = window._newProjType === 'design' ? '' : 'none';
  var btns = document.querySelectorAll('#proj-new-type .proj-type-btn');
  btns.forEach(function(b) { b.classList.toggle('active', b === btn); });
}

async function _saveDesignSkills(projectId, checksContainer) {
  var skillIds = [];
  if (checksContainer) {
    checksContainer.querySelectorAll('input[type="checkbox"]:checked').forEach(function(cb) {
      if (cb.value) skillIds.push(cb.value);
    });
  }
  try {
    await fetch('/api/projects/' + projectId + '/design', {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ skillIds: skillIds })
    });
    var proj = (state.projects || []).find(function(p){ return p.id === projectId; });
    if (proj) { if (!proj.design) proj.design = {}; proj.design.skillIds = skillIds; }
    _showToast('Saved');
  } catch(e) {
    _showToast('Save failed: ' + e.message, true);
  }
}

async function _saveDesignField(projectId, selectEl) {
  var field = selectEl.dataset.field;
  var value = selectEl.value;
  if (!field) return;
  var patch = {};
  patch[field] = value;
  try {
    await fetch('/api/projects/' + projectId + '/design', {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(patch)
    });
    // Update cached state
    var proj = (state.projects || []).find(function(p){ return p.id === projectId; });
    if (proj) { if (!proj.design) proj.design = {}; proj.design[field] = value; }
    _showToast('Saved');
  } catch(e) {
    _showToast('Save failed: ' + e.message, true);
  }
}

async function _projModalBrowse(fieldId) {
  try {
    var r = await fetch('/api/pick-folder', { method: 'POST' });
    var data = await r.json();
    // The server returns the chosen directory as `folderPath`.
    var picked = data.folderPath || data.path;
    if (data.cancelled || !picked) return;
    var input = document.getElementById('pmf-' + fieldId);
    if (input) input.value = picked;
  } catch(e) { _showToast('Could not open folder picker', true); }
}

function pickNewProjColor(color) {
  window._newProjColor = color;
  var picker = document.getElementById('proj-new-color-picker');
  if (picker) picker.querySelectorAll('.proj-color-dot').forEach(function(b) {
    b.classList.toggle('active', b.title === color);
  });
}

async function submitCreateProject() {
  var name = (document.getElementById('proj-new-name') || {}).value;
  if (!name || !name.trim()) { _showToast('Name is required', true); return; }
  var desc    = (document.getElementById('proj-new-desc') || {}).value || '';
  var root    = (document.getElementById('proj-new-root') || {}).value || null;
  var color   = window._newProjColor || 'teal';
  var type    = window._newProjType  || '';
  var skillIds = [];
  var newChecks = document.getElementById('proj-new-skill-checks');
  if (newChecks) {
    newChecks.querySelectorAll('input[type="checkbox"]:checked').forEach(function(cb) {
      if (cb.value) skillIds.push(cb.value);
    });
  }
  try {
    var r = await fetch('/api/projects', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: name.trim(), description: desc, rootPath: root || null, color })
    });
    if (!r.ok) throw new Error((await r.json()).error);
    var proj = await r.json();
    // Save design metadata if this is a design project
    if (type === 'design') {
      try {
        await fetch('/api/projects/' + proj.id + '/design', {
          method: 'PATCH', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ projectType: 'design', skillIds: skillIds, systemId: 'default', fidelity: 'hi', platform: 'desktop' })
        });
        proj.design = { projectType: 'design', skillIds: skillIds, systemId: 'default', fidelity: 'hi', platform: 'desktop' };
      } catch(_) {}
    }
    state.projects.push(proj);
    var overlay = document.getElementById('proj-create-overlay');
    if (overlay) overlay.remove();
    await setActiveProject(proj.id, { navigate: false });
    renderProjectSidebarList();
    _renderAllProjectsPage();
    openProjectHub(type === 'design' ? 'design' : 'files');
    _showToast('Project created');

    // Handle pending gen-ui spec save (from _createProjectAndSaveGenUI)
    if (window._pendingGenUISpec) {
      var pending = window._pendingGenUISpec;
      window._pendingGenUISpec = null;
      try {
        var sr = await fetch('/api/projects/' + proj.id + '/contexts/from-artifact', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ title: pending.title || 'UI Component', content: pending.specJson, type: 'json' })
        });
        if (sr.ok) { await _refreshProject(proj.id); renderProjectContextBar(); if (state.projectHubOpen) _renderProjectHubBody(_activeProject()); _showToast('UI saved to ' + proj.name); }
      } catch(_) {}
    }

    // Handle pending conversation move (from _createProjectAndMoveConv)
    if (window._pendingMoveConvId) {
      var convId = window._pendingMoveConvId;
      window._pendingMoveConvId = null;
      var conv = typeof getConv === 'function' ? getConv(convId) : null;
      if (conv) {
        conv.projectId = proj.id;
        if (typeof saveConversations === 'function') saveConversations();
        if (typeof renderConvList === 'function') renderConvList();
        fetch('/api/projects/' + proj.id + '/conversations', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ convId: convId })
        }).catch(function(){});
        _showToast('Conversation moved to ' + proj.name);
        _updateMoveToProjectBtn();
      }
    }
  } catch(e) { _showToast('Error: ' + e.message, true); }
}

// ── Toast helper ─────────────────────────────────────────────────────────

function _showToast(msg, isError) {
  var el = document.createElement('div');
  el.className = 'proj-toast' + (isError ? ' proj-toast-error' : '');
  el.textContent = msg;
  document.body.appendChild(el);
  setTimeout(function(){ el.classList.add('visible'); }, 10);
  setTimeout(function(){ el.classList.remove('visible'); setTimeout(function(){ el.remove(); }, 300); }, 3000);
}

// ── Modal helpers (replaces browser prompt/confirm — not supported in Electron) ──

// Electron's renderer process silently returns null from window.prompt()
// without ever showing UI, so every flow that relied on `var x =
// window.prompt(…); if (!x) return;` exited as a no-op (e.g. the
// "Initialize git" button did nothing). _projPrompt() shows a real modal
// and returns Promise<string|null>. window.confirm() does work in Electron
// (it shows a native dialog) so it's left alone.
//
//   opts = {
//     title, label, placeholder?, defaultValue?, submit?='OK',
//     multiline?:false, validate?(value)→errorString|null
//   }
function _projPrompt(opts) {
  opts = opts || {};
  return new Promise(function(resolve) {
    var overlay = document.createElement('div');
    overlay.className = 'proj-picker-overlay';
    var inputHtml = opts.multiline
      ? '<textarea class="proj-input proj-modal-textarea" id="_pp-input" placeholder="' + _projEsc(opts.placeholder || '') + '">' + _projEsc(opts.defaultValue || '') + '</textarea>'
      : '<input class="proj-input" id="_pp-input" type="text" placeholder="' + _projEsc(opts.placeholder || '') + '" autocomplete="off" value="' + _projEsc(opts.defaultValue || '') + '">';
    overlay.innerHTML =
      '<div class="proj-picker-panel">' +
        '<div class="proj-picker-header">' +
          '<span>' + _projEsc(opts.title || '') + '</span>' +
          '<button id="_pp-close"><i class="ti ti-x"></i></button>' +
        '</div>' +
        '<div class="proj-form">' +
          '<div class="proj-settings-row">' +
            (opts.label ? '<label>' + _projEsc(opts.label) + '</label>' : '') +
            inputHtml +
          '</div>' +
        '</div>' +
        '<div id="_pp-err" class="proj-modal-err" style="display:none"></div>' +
        '<div class="proj-picker-footer">' +
          '<button class="proj-action-btn" id="_pp-ok">' + _projEsc(opts.submit || 'OK') + '</button>' +
          '<button class="proj-action-btn" id="_pp-cancel">Cancel</button>' +
        '</div>' +
      '</div>';
    document.body.appendChild(overlay);
    var done = false;
    function close(value) { if (done) return; done = true; overlay.remove(); resolve(value); }
    var input = overlay.querySelector('#_pp-input');
    setTimeout(function() {
      try { input.focus(); if (!opts.multiline) input.select(); } catch (_) {}
    }, 50);
    overlay.querySelector('#_pp-close').onclick  = function() { close(null); };
    overlay.querySelector('#_pp-cancel').onclick = function() { close(null); };
    overlay.querySelector('#_pp-ok').onclick = function() {
      var val = input.value;
      if (typeof opts.validate === 'function') {
        var err = opts.validate(val);
        if (err) {
          var errEl = overlay.querySelector('#_pp-err');
          errEl.textContent = err; errEl.style.display = '';
          return;
        }
      }
      close(val);
    };
    overlay.addEventListener('keydown', function(e) {
      if (e.key === 'Escape') { e.preventDefault(); close(null); }
      if (e.key === 'Enter' && !opts.multiline && e.target.tagName !== 'BUTTON') {
        e.preventDefault();
        overlay.querySelector('#_pp-ok').click();
      }
    });
  });
}

// _projConfirm(message) → Promise<boolean>
function _projConfirm(message) {
  return new Promise(function(resolve) {
    var overlay = document.createElement('div');
    overlay.className = 'proj-picker-overlay';
    overlay.innerHTML =
      '<div class="proj-picker-panel proj-modal-sm">' +
        '<div class="proj-picker-header"><span>Confirm</span></div>' +
        '<div class="proj-modal-body"><p>' + _projEsc(message) + '</p></div>' +
        '<div class="proj-picker-footer">' +
          '<button class="proj-action-btn proj-danger-btn" id="_pmc-ok">Delete</button>' +
          '<button class="proj-action-btn" id="_pmc-cancel">Cancel</button>' +
        '</div>' +
      '</div>';
    document.body.appendChild(overlay);
    overlay.querySelector('#_pmc-ok').onclick    = function() { overlay.remove(); resolve(true);  };
    overlay.querySelector('#_pmc-cancel').onclick = function() { overlay.remove(); resolve(false); };
  });
}

// _projModal({ title, fields, submit, onSubmit }) — fields: [{id, label, type, placeholder, options}]
// onSubmit(values) may return an error string, or void/falsy on success.
function _projModal(opts) {
  var overlay = document.createElement('div');
  overlay.className = 'proj-picker-overlay';

  var fieldsHtml = (opts.fields || []).map(function(f) {
    var defaultVal = (f.value != null) ? String(f.value) : '';
    var input;
    if (f.type === 'textarea') {
      input = '<textarea class="proj-input proj-modal-textarea" id="pmf-' + f.id + '" placeholder="' + _projEsc(f.placeholder || '') + '">' + _projEsc(defaultVal) + '</textarea>';
    } else if (f.type === 'select') {
      input = '<select class="proj-input" id="pmf-' + f.id + '">' +
        (f.options || []).map(function(o) {
          var sel = (defaultVal && String(o.value) === defaultVal) ? ' selected' : '';
          return '<option value="' + _projEsc(o.value) + '"' + sel + '>' + _projEsc(o.label) + '</option>';
        }).join('') +
      '</select>';
    } else if (f.browse) {
      input = '<div style="display:flex;gap:6px;flex:1">' +
        '<input class="proj-input" id="pmf-' + f.id + '" type="text" placeholder="' + _projEsc(f.placeholder || '') + '" autocomplete="off" value="' + _projEsc(defaultVal) + '" style="flex:1">' +
        '<button class="proj-action-btn" type="button" onclick="_projModalBrowse(\'' + f.id + '\')" title="Browse"><i class="ti ti-folder-open"></i></button>' +
      '</div>';
    } else {
      input = '<input class="proj-input" id="pmf-' + f.id + '" type="text" placeholder="' + _projEsc(f.placeholder || '') + '" autocomplete="off" value="' + _projEsc(defaultVal) + '">';
    }
    return '<div class="proj-settings-row"><label>' + _projEsc(f.label) + '</label>' + input + '</div>';
  }).join('');

  overlay.innerHTML =
    '<div class="proj-picker-panel">' +
      '<div class="proj-picker-header">' +
        '<span>' + _projEsc(opts.title || '') + '</span>' +
        '<button id="_pmclose"><i class="ti ti-x"></i></button>' +
      '</div>' +
      '<div class="proj-form">' + fieldsHtml + '</div>' +
      '<div id="_pm-err" class="proj-modal-err" style="display:none"></div>' +
      '<div class="proj-picker-footer">' +
        '<button class="proj-action-btn" id="_pmsubmit">' + _projEsc(opts.submit || 'Submit') + '</button>' +
        '<button class="proj-action-btn" id="_pmcancel">Cancel</button>' +
      '</div>' +
    '</div>';

  document.body.appendChild(overlay);

  function cancel() {
    overlay.remove();
    if (typeof opts.onCancel === 'function') opts.onCancel();
  }
  overlay.querySelector('#_pmclose').onclick  = cancel;
  overlay.querySelector('#_pmcancel').onclick = cancel;
  // Focus first text/textarea input
  var first = overlay.querySelector('input, textarea');
  if (first) setTimeout(function() { first.focus(); }, 50);

  overlay.querySelector('#_pmsubmit').onclick = function() {
    var vals = {};
    (opts.fields || []).forEach(function(f) {
      var el = overlay.querySelector('#pmf-' + f.id);
      vals[f.id] = el ? el.value : '';
    });
    var err = opts.onSubmit && opts.onSubmit(vals);
    if (err) {
      var errEl = overlay.querySelector('#_pm-err');
      errEl.textContent = err;
      errEl.style.display = '';
    } else {
      overlay.remove();
    }
  };

  // Submit on Enter (but not in textarea)
  overlay.addEventListener('keydown', function(e) {
    if (e.key === 'Enter' && e.target.tagName !== 'TEXTAREA' && e.target.tagName !== 'BUTTON') {
      overlay.querySelector('#_pmsubmit').click();
    }
    if (e.key === 'Escape') cancel();
  });
}

// ── Utility helpers ───────────────────────────────────────────────────────

function _fmtSize(bytes) {
  if (!bytes) return '0 B';
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1048576) return (bytes / 1024).toFixed(1) + ' KB';
  return (bytes / 1048576).toFixed(1) + ' MB';
}

function _relTime(iso) {
  try {
    var diff = Date.now() - new Date(iso).getTime();
    var s = Math.floor(diff / 1000);
    if (s < 60) return 'just now';
    if (s < 3600) return Math.floor(s/60) + 'm ago';
    if (s < 86400) return Math.floor(s/3600) + 'h ago';
    return Math.floor(s/86400) + 'd ago';
  } catch(_) { return ''; }
}

function _fileIcon(ext) {
  var map = {
    js:'ti-brand-javascript', ts:'ti-brand-typescript', jsx:'ti-brand-react', tsx:'ti-brand-react',
    json:'ti-braces', md:'ti-markdown', html:'ti-brand-html5', css:'ti-brand-css3', scss:'ti-brand-css3',
    py:'ti-brand-python', go:'ti-brand-golang', rs:'ti-brand-rust', java:'ti-coffee',
    sql:'ti-database', sh:'ti-terminal', bash:'ti-terminal',
    // Images
    png:'ti-photo', jpg:'ti-photo', jpeg:'ti-photo', gif:'ti-photo', webp:'ti-photo',
    svg:'ti-vector', ico:'ti-photo', avif:'ti-photo', bmp:'ti-photo', tiff:'ti-photo', tif:'ti-photo',
    // Video
    mp4:'ti-video', webm:'ti-video', mov:'ti-video', avi:'ti-video', mkv:'ti-video',
    // Audio
    mp3:'ti-music', wav:'ti-music', flac:'ti-music', m4a:'ti-music', aac:'ti-music', ogg:'ti-music',
    // Documents
    pdf:'ti-file-type-pdf',
    doc:'ti-file-word', docx:'ti-file-word',
    xls:'ti-file-spreadsheet', xlsx:'ti-file-spreadsheet',
    ppt:'ti-presentation', pptx:'ti-presentation',
    // Archives / other
    zip:'ti-file-zip', gz:'ti-file-zip', tar:'ti-file-zip',
    txt:'ti-file-text',
  };
  return (ext && map[ext]) || 'ti-file';
}

// ── Global Dev-Server Dashboard ───────────────────────────────────────────
// Lives inside Settings → Dev Servers. The poll keeps the nav-item count
// badge in sync; renderDevServersPage() repaints the table when the page
// is open. Topbar overflow no longer hosts this UI.

var _portsPollingInterval = null;
// Tracks server ids that have already triggered a "ready" notification so we
// don't re-notify on every snapshot after a server is first seen as running.
var _notifiedServerIds = new Set();
var _devServerSSE = null;

function _startPortsPolling() {
  if (_portsPollingInterval) return;
  _portsPollingInterval = setInterval(_pollPorts, 5000);
  _pollPorts();
  _connectDevServerSSE();
}

// Connect to the server-push SSE stream for instant “Port ready” notifications.
// Mirrors VS Code’s Ports panel balloon: fires the moment stdout shows a
// listening port, not on the next 5-second poll tick.
function _connectDevServerSSE() {
  if (_devServerSSE) return;
  try {
    var es = new EventSource('/api/dev-servers/events');
    _devServerSSE = es;

    es.addEventListener('snapshot', function(e) {
      try {
        var d = JSON.parse(e.data);
        _applyDevServerSnapshot(d.servers || []);
      } catch(_) {}
    });

    es.addEventListener('server-ready', function(e) {
      try {
        var d = JSON.parse(e.data);
        if (!_notifiedServerIds.has(d.id)) {
          _notifiedServerIds.add(d.id);
          _showServerReadyNotification(d);
        }
      } catch(_) {}
    });

    es.addEventListener('server-exited', function(e) {
      try {
        var d = JSON.parse(e.data);
        _notifiedServerIds.delete(d.id);
        _dismissServerNotification(d.id);
      } catch(_) {}
    });

    es.onerror = function() {
      try { es.close(); } catch(_) {}
      _devServerSSE = null;
      // Reconnect after backoff
      setTimeout(_connectDevServerSSE, 8000);
    };
  } catch(_) {}
}

function _applyDevServerSnapshot(servers) {
  var active = servers.filter(function(s) { return s.status === 'running' || s.status === 'starting'; });
  if (typeof reconcileDevServerPills === 'function') reconcileDevServerPills(servers);
  var btn   = document.getElementById('topbar-servers-btn');
  var count = document.getElementById('topbar-servers-count');
  if (btn)   btn.style.display   = active.length ? '' : 'none';
  if (count) count.textContent   = active.length || '';
  // Update settings badge
  var settingsCnt = document.getElementById('settings-dev-servers-count');
  if (settingsCnt) {
    settingsCnt.textContent = active.length;
    settingsCnt.style.display = active.length ? '' : 'none';
  }
  // Re-render dev-servers page if open
  var pageEl = document.querySelector('#settings-panel .settings-page[data-page="dev-servers"]');
  if (pageEl && pageEl.classList.contains('active')) _renderDevServersList(servers);
}

// “Port 3000 — Open in Browser” balloon — VS Code’s Ports panel equivalent.
// Stacks vertically so multiple servers can each show a notification.
function _showServerReadyNotification(server) {
  var container = document.getElementById('dev-server-notif-container');
  if (!container) {
    container = document.createElement('div');
    container.id = 'dev-server-notif-container';
    Object.assign(container.style, {
      position: 'fixed', bottom: '16px', right: '16px',
      display: 'flex', flexDirection: 'column', gap: '8px',
      zIndex: '9999', pointerEvents: 'none',
    });
    document.body.appendChild(container);
  }
  var name  = server.name || server.cmd || 'Dev server';
  var port  = server.port;
  var url   = port ? 'http://localhost:' + port : null;
  var notif = document.createElement('div');
  notif.className = 'dev-server-notif';
  notif.dataset.serverId = server.id;
  Object.assign(notif.style, { pointerEvents: 'auto' });
  notif.innerHTML =
    '<div class="dsn-icon"><i class="ti ti-server"></i></div>' +
    '<div class="dsn-body">' +
      '<div class="dsn-title">' + (port ? 'Port ' + port + ' — ' : '') + escHtml(name) + '</div>' +
      '<div class="dsn-cmd">' + escHtml((server.cmd || '').slice(0, 60)) + '</div>' +
    '</div>' +
    (url ? '<button class="dsn-open" onclick="openRunInBrowser(\'' + url + '\')">' +
      '<i class="ti ti-external-link"></i> Open' +
    '</button>' : '') +
    '<button class="dsn-close" onclick="_dismissServerNotification(\'' + server.id + '\')">' +
      '<i class="ti ti-x"></i>' +
    '</button>';
  container.appendChild(notif);
  // Auto-dismiss after 12s
  notif._timeout = setTimeout(function() { _dismissServerNotification(server.id); }, 12000);
  // Animate in
  requestAnimationFrame(function() { notif.classList.add('dsn-visible'); });
}

function _dismissServerNotification(serverId) {
  var notif = document.querySelector('.dev-server-notif[data-server-id="' + serverId + '"]');
  if (!notif) return;
  clearTimeout(notif._timeout);
  notif.classList.remove('dsn-visible');
  setTimeout(function() { notif.remove(); }, 250);
}

function _openDevServersQuick() {
  var btn = document.querySelector('#settings-panel .settings-nav-item[data-page="dev-servers"]');
  switchSettingsPage('dev-servers', btn);
  if (typeof toggleSettings === 'function') {
    var panel = document.getElementById('settings-panel');
    if (panel && panel.style.display === 'none') toggleSettings();
  }
}

async function _pollPorts() {
  try {
    var r = await fetch('/api/runs');
    var runs = await r.json();
    _applyDevServerSnapshot(runs);
  } catch(_) {}
}

function renderDevServersPage() {
  fetch('/api/runs')
    .then(function(r) { return r.json(); })
    .then(_renderDevServersList)
    .catch(function() {});
}

function _renderDevServersList(runs) {
  var host = document.getElementById('dev-servers-list');
  if (!host) return;
  if (!runs.length) {
    host.innerHTML =
      '<div style="padding:40px;text-align:center;color:var(--fau-text-muted)">' +
        '<i class="ti ti-server" style="font-size:32px;opacity:.35;display:block;margin-bottom:8px"></i>' +
        '<div style="font-size:13px">No dev servers running</div>' +
        '<div style="font-size:11.5px;opacity:.7;margin-top:4px">Servers Fauna spawns (npm run dev, vite, next dev, …) will appear here.</div>' +
      '</div>';
    return;
  }
  var rows = runs.map(function(r) {
    var isActive = r.status === 'running' || r.status === 'starting';
    var portStr = r.port ? ':' + r.port : '<span style="opacity:.5">—</span>';
    var statusDot = '<span class="proj-run-status-dot proj-run-status-' + r.status + '"></span>';
    var pidArg = r.projectId ? ("'" + r.projectId + "'") : 'null';
    var openBtn = r.port && isActive
      ? '<button class="proj-action-btn" style="padding:3px 10px;font-size:11px" onclick="openRunInBrowser(\'http://localhost:' + r.port + '\')">Open</button>'
      : '';
    var restartBtn = isActive && !r.projectId
      ? '<button class="proj-action-btn" style="padding:3px 10px;font-size:11px" onclick="restartDevServerRun(\'' + r.runId + '\').then(function(){setTimeout(renderDevServersPage,400)})">Restart</button>'
      : '';
    var stopBtn = isActive
      ? '<button class="proj-action-btn" style="padding:3px 10px;font-size:11px;color:var(--error-light)" onclick="stopProjectRun(\'' + r.runId + '\',' + pidArg + ').then(function(){setTimeout(renderDevServersPage,400)})">Stop</button>'
      : '';
    // The Process column shows the short label (e.g. "npm run dev"); hover
    // the row to see the full cwd / command tooltip.
    var procLabel = _projEsc(r.name);
    var folderLabel = _projEsc(r.srcName || '~');
    var fullCmd = _projEsc(r.cmd || '');
    return '<tr class="proj-ports-row" title="' + fullCmd + '">' +
      '<td>' + statusDot + ' <span style="vertical-align:middle">' + procLabel + '</span></td>' +
      '<td style="font-size:11.5px;color:var(--fau-text-muted)" title="' + folderLabel + '">' + folderLabel + '</td>' +
      '<td style="font-variant-numeric:tabular-nums">' + portStr + '</td>' +
      '<td><code class="proj-run-cmd-badge" title="' + fullCmd + '">' + fullCmd + '</code></td>' +
      '<td style="white-space:nowrap;text-align:right">' +
        [openBtn, restartBtn, stopBtn].filter(Boolean).join(' ') +
      '</td>' +
    '</tr>';
  }).join('');
  host.innerHTML =
    '<table class="proj-ports-table"><colgroup>' +
      '<col class="proj-ports-col-process">' +
      '<col class="proj-ports-col-folder">' +
      '<col class="proj-ports-col-port">' +
      '<col class="proj-ports-col-command">' +
      '<col class="proj-ports-col-actions">' +
    '</colgroup><thead>' +
      '<tr><th>Process</th><th>Folder</th><th>Port</th><th>Command</th><th></th></tr>' +
    '</thead><tbody>' + rows + '</tbody></table>';
}

// Backwards-compat alias — anything still calling openPortsDashboard() now
// routes the user into Settings → Dev Servers.
function openPortsDashboard() {
  if (typeof toggleSettings === 'function') {
    var panel = document.getElementById('settings-panel');
    if (panel && !panel.classList.contains('open')) toggleSettings();
  }
  if (typeof switchSettingsPage === 'function') {
    var btn = document.querySelector('#settings-panel .settings-nav-item[data-page="dev-servers"]');
    switchSettingsPage('dev-servers', btn);
  }
  renderDevServersPage();
}

