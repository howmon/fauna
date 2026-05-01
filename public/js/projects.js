// ── Projects Frontend ─────────────────────────────────────────────────────
// Handles the full Projects UI: switcher pill, hub panel, file tree,
// contexts list, sources management, connectors, and integration with tasks.

// ── Helpers ──────────────────────────────────────────────────────────────

function _projEsc(s) { return String(s || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }

function _activeProject() {
  return state.projects.find(function(p) { return p.id === state.activeProjectId; }) || null;
}

// ── Load / Persist ────────────────────────────────────────────────────────

async function loadProjects() {
  try {
    var r = await fetch('/api/projects');
    if (!r.ok) return;
    state.projects = await r.json();
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

// ── Project Sidebar List ──────────────────────────────────────────────────

function renderProjectSidebarList() {
  var el = document.getElementById('proj-sidebar-list');
  if (!el) return;
  var MAX = 5;
  var projects = (state.projects || []).slice().sort(function(a, b) {
    return (b.lastActiveAt || 0) > (a.lastActiveAt || 0) ? 1 : -1;
  });
  var visible = projects.slice(0, MAX);

  el.innerHTML = visible.map(function(p) {
    var isActive = p.id === state.activeProjectId;
    return '<div class="proj-sidebar-item' + (isActive ? ' active' : '') + '" onclick="setActiveProject(\'' + _projEsc(p.id) + '\')">' +
      '<span class="proj-dot proj-color-' + _projEsc(p.color) + '"></span>' +
      '<span class="proj-sidebar-item-name">' + _projEsc(p.name) + '</span>' +
      '<span class="proj-sidebar-item-actions">' +
        (isActive
          ? '<button class="proj-sidebar-hub-btn" onclick="event.stopPropagation();openProjectHub()" title="Open hub"><i class="ti ti-layout-sidebar-right-expand"></i></button>' +
            '<button class="proj-sidebar-hub-btn" onclick="event.stopPropagation();clearActiveProject()" title="Deactivate"><i class="ti ti-x"></i></button>'
          : '') +
        '<button class="proj-sidebar-del-btn" onclick="event.stopPropagation();_confirmDeleteProjectFromList(\'' + _projEsc(p.id) + '\')" title="Delete project"><i class="ti ti-trash"></i></button>' +
      '</span>' +
    '</div>';
  }).join('') || '<div class="proj-sidebar-empty">No projects yet</div>';

  var showAll = document.getElementById('proj-show-all');
  if (showAll) showAll.style.display = projects.length > MAX ? '' : 'none';
}

// ── All Projects Page ─────────────────────────────────────────────────────

function openAllProjects() {
  var page = document.getElementById('all-projects-page');
  if (!page) return;
  page._filter = '';
  page.style.display = 'flex';
  _renderAllProjectsPage();
}

function closeAllProjects() {
  var page = document.getElementById('all-projects-page');
  if (page) page.style.display = 'none';
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
          '<button class="all-agents-close" onclick="closeAllProjects()"><i class="ti ti-x"></i></button>' +
        '</div>' +
        '<div id="all-projects-list-body" class="all-projects-list"></div>' +
        '<div class="all-agents-footer">' +
          '<button class="proj-action-btn" onclick="openCreateProjectDialog()"><i class="ti ti-plus"></i> New project</button>' +
        '</div>' +
      '</div>';
    listEl = document.getElementById('all-projects-list-body');
  }

  if (!projects.length) {
    listEl.innerHTML = '<div class="proj-hub-empty" style="padding:40px"><i class="ti ti-folders" style="font-size:28px;opacity:.3"></i><div>No projects yet</div></div>';
    return;
  }

  listEl.innerHTML = projects.map(function(p) {
    var convCount = (state.conversations || []).filter(function(c) { return c.projectId === p.id; }).length;
    var taskCount = (p.taskIds || []).length;
    var srcCount  = (p.sources  || []).length;
    var isActive  = p.id === state.activeProjectId;
    return '<div class="all-proj-card' + (isActive ? ' active' : '') + '">' +
      '<div class="all-proj-card-top">' +
        '<span class="proj-dot proj-color-' + _projEsc(p.color) + '" style="width:10px;height:10px;flex-shrink:0"></span>' +
        '<span class="all-proj-card-name">' + _projEsc(p.name) + '</span>' +
        (isActive ? '<span class="all-proj-active-badge">Active</span>' : '') +
      '</div>' +
      (p.description ? '<div class="all-proj-card-desc">' + _projEsc(p.description) + '</div>' : '') +
      '<div class="all-proj-card-meta">' +
        '<span><i class="ti ti-source-code"></i> ' + srcCount + ' source' + (srcCount !== 1 ? 's' : '') + '</span>' +
        '<span><i class="ti ti-messages"></i> ' + convCount + ' conv' + (convCount !== 1 ? 's' : '') + '</span>' +
        '<span><i class="ti ti-checklist"></i> ' + taskCount + ' task' + (taskCount !== 1 ? 's' : '') + '</span>' +
      '</div>' +
      '<div class="all-proj-card-actions">' +
        (isActive
          ? '<button class="proj-action-btn" onclick="openProjectHub();closeAllProjects()"><i class="ti ti-layout-sidebar-right-expand"></i> Open Hub</button>' +
            '<button class="proj-icon-btn" onclick="clearActiveProject();closeAllProjects()" title="Deactivate"><i class="ti ti-x"></i></button>'
          : '<button class="proj-action-btn" onclick="setActiveProject(\'' + _projEsc(p.id) + '\');closeAllProjects()"><i class="ti ti-player-play"></i> Activate</button>') +
        '<button class="proj-icon-btn" style="color:var(--fau-text-muted)" onclick="_confirmDeleteProjectFromList(\'' + _projEsc(p.id) + '\')" title="Delete project"><i class="ti ti-trash"></i></button>' +
      '</div>' +
    '</div>';
  }).join('');
}

async function _confirmDeleteProjectFromList(id) {
  if (!await _projConfirm('Delete this project? This cannot be undone.')) return;
  try {
    await fetch('/api/projects/' + id, { method: 'DELETE' });
    state.projects = state.projects.filter(function(p) { return p.id !== id; });
    _deleteProjectConversations(id);
    if (state.activeProjectId === id) clearActiveProject();
    renderProjectSidebarList();
    _renderAllProjectsPage();
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
  var pill = document.getElementById('topbar-project-pill');
  var nameEl = document.getElementById('topbar-project-name');
  if (!pill || !nameEl) return;
  var proj = _activeProject();
  if (proj) {
    nameEl.textContent = proj.name;
    pill.style.display = '';
  } else {
    pill.style.display = 'none';
    nameEl.textContent = '';
  }
  _updateMoveToProjectBtn();
}

async function setActiveProject(id) {
  state.activeProjectId = id;
  if (id) {
    localStorage.setItem('fauna-active-project', id);
    await _refreshProject(id);
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

  // Navigate to a conversation appropriate for the new project context
  if (id) {
    // Enter project: load most recent project conversation, or start a new one
    var projConvs = state.conversations.filter(function(c) { return c.projectId === id; });
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
  var HUB_MIN = 300, HUB_MAX = 900, HUB_KEY = 'fauna-hub-width';
  var hub = document.getElementById('project-hub');
  var handle = document.getElementById('project-hub-resize-handle');
  if (!hub || !handle) return;
  var saved = parseInt(localStorage.getItem(HUB_KEY), 10);
  if (saved && saved >= HUB_MIN && saved <= HUB_MAX) {
    document.documentElement.style.setProperty('--hub-w', saved + 'px');
  }
  handle.addEventListener('mousedown', function(e) {
    e.preventDefault();
    var startX = e.clientX;
    var startW = hub.getBoundingClientRect().width;
    hub.classList.add('resizing');
    function onMove(e) {
      var w = Math.min(HUB_MAX, Math.max(HUB_MIN, startW - (e.clientX - startX)));
      document.documentElement.style.setProperty('--hub-w', w + 'px');
    }
    function onUp() {
      hub.classList.remove('resizing');
      var finalW = hub.getBoundingClientRect().width;
      localStorage.setItem(HUB_KEY, Math.round(finalW));
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
    }
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
  });
  handle.addEventListener('dblclick', function() {
    document.documentElement.style.setProperty('--hub-w', '460px');
    localStorage.removeItem(HUB_KEY);
  });
}

function openProjectHub(tab) {
  var proj = _activeProject();
  if (!proj) { openProjectPicker(); return; }
  state.projectHubOpen = true;
  state.projectHubTab = tab || state.projectHubTab || 'files';
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

  var TABS = [
    { id: 'files',    icon: 'ti-folder',       label: 'Files' },
    { id: 'contexts', icon: 'ti-file-text',     label: 'Contexts' },
    { id: 'sources',  icon: 'ti-source-code',   label: 'Sources' },
    { id: 'run',      icon: 'ti-player-play',   label: 'Run' },
    { id: 'terminal', icon: 'ti-terminal-2',    label: 'Terminal' },
    { id: 'convs',    icon: 'ti-messages',      label: 'Conversations' },
    { id: 'tasks',    icon: 'ti-checklist',     label: 'Tasks' },
    { id: 'settings', icon: 'ti-settings',      label: 'Settings' },
  ];
  // Add Design tab for design projects
  if (proj.design && proj.design.projectType === 'design') {
    TABS.splice(1, 0, { id: 'design', icon: 'ti-layout-2', label: 'Design' });
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
  else if (tab === 'sources')  body.innerHTML = _renderSourcesTab(proj);
  else if (tab === 'run')      { body.innerHTML = _renderRunTabShell(); _runTabLoad(proj); }
  else if (tab === 'terminal') { body.innerHTML = ''; _renderTerminalTab(proj, body); _termTabLoad(proj); }
  else if (tab === 'convs')    body.innerHTML = _renderConvsTab(proj);
  else if (tab === 'tasks')    body.innerHTML = _renderTasksTab(proj);
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
      '<button class="proj-action-btn" onclick="switchProjectHubTab(\'sources\')"><i class="ti ti-plus"></i> Add a source</button></div>';
  }
  var srcOptions = '';
  if (rootPath && !rootAlreadySrc) {
    var rootBasename = rootPath.split('/').filter(Boolean).pop() || rootPath;
    srcOptions += '<option value="__rootpath__">' + _projEsc(rootBasename) + ' (working folder)</option>';
  }
  srcOptions += (proj.sources || []).map(function(s) {
    return '<option value="' + _projEsc(s.id) + '">' + _projEsc(s.name) + '</option>';
  }).join('');
  return '<div class="proj-files-toolbar">' +
    '<select class="proj-src-select" onchange="loadProjectFileTree(this.value, \'\')">' + srcOptions + '</select>' +
    '<button class="proj-icon-btn" onclick="openProjectFileExplorer()" title="Expand to full screen"><i class="ti ti-arrows-maximize"></i></button>' +
    '<button class="proj-icon-btn" onclick="loadProjectFileTree(document.querySelector(\'.proj-src-select\').value, \'\')" title="Refresh"><i class="ti ti-refresh"></i></button>' +
  '</div>' +
  '<div class="proj-files-layout">' +
    '<div id="proj-file-tree-root" class="proj-file-tree proj-files-tree-col"></div>' +
    '<div id="proj-file-viewer" class="proj-file-viewer proj-files-viewer-col" style="display:none"></div>' +
  '</div>';
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
      return '<div>' +
        '<div class="proj-file-row proj-tree-dir-row" style="padding-left:' + pad + 'px" onclick="_treeToggleDir(\'' + st._id + '\',\'' + _projEsc(f.path) + '\')">' +
          '<i class="ti ' + chevron + ' proj-tree-chevron"></i>' +
          '<i class="ti ' + folderIco + ' proj-file-icon proj-folder-icon"></i>' +
          '<span class="proj-file-name">' + _projEsc(f.name) + '</span>' +
          (hasDot ? '<span class="proj-tree-dot"></span>' : '') +
        '</div>' +
        (open ? '<div>' + children + '</div>' : '') +
      '</div>';
    } else {
      var opened = !!st.openedFiles[f.path];
      var size = f.size ? '<span class="proj-file-size">' + _fmtSize(f.size) + '</span>' : '';
      return '<div class="proj-file-row' + (opened ? ' proj-file-opened' : '') + '" style="padding-left:' + pad + 'px" onclick="_treeOpenFile(\'' + st._id + '\',\'' + _projEsc(f.path) + '\')">' +
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
  } catch(e) { if (el) el.innerHTML = '<div class="proj-hub-error">' + _projEsc(e.message) + '</div>'; }
}

async function loadProjectFileTree(srcId /*, subPath ignored — tree always starts at root */) {
  state._projectFileSrcId = srcId;
  await _treeInit(_hubTreeState, srcId);
}

// ── Monaco file viewer ────────────────────────────────────────────────────

var _projMonacoEditor  = null;
var _projMonacoLoaded  = false;
var _projMonacoSrcId   = null;   // srcId of file currently shown

// Map file extension → Monaco language id
var _MONO_LANG = {
  js:'javascript', mjs:'javascript', cjs:'javascript',
  ts:'typescript', tsx:'typescript', jsx:'javascript',
  json:'json', jsonc:'json',
  html:'html', htm:'html',
  css:'css', scss:'scss', less:'less',
  md:'markdown', markdown:'markdown',
  py:'python', rb:'ruby', php:'php',
  go:'go', rs:'rust', java:'java',
  c:'c', cpp:'cpp', h:'c', hpp:'cpp',
  sh:'shell', bash:'shell', zsh:'shell', fish:'shell',
  sql:'sql', graphql:'graphql',
  yaml:'yaml', yml:'yaml', toml:'ini',
  xml:'xml', svg:'xml',
  swift:'swift', kt:'kotlin', dart:'dart',
  ex:'elixir', exs:'elixir', lua:'lua',
  tf:'hcl', tfvars:'hcl', bicep:'bicep',
  conf:'ini', ini:'ini', cfg:'ini', env:'plaintext',
  txt:'plaintext', log:'plaintext',
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
          (canEdit ? '<button class="proj-icon-btn proj-save-btn" onclick="saveProjectFile()" title="Save file"><i class="ti ti-device-floppy"></i> Save</button>' : '') +
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
  try {
    var r = await fetch('/api/projects/' + state.activeProjectId + '/sources/' + encodeURIComponent(srcId) + '/file?path=' + encodeURIComponent(filePath), {
      method: 'PUT', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content })
    });
    if (!r.ok) throw new Error((await r.json()).error);
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
        '<button class="proj-icon-btn" onclick="explorerLoadTree(document.getElementById(\'proj-exp-src\').value,\'\')" title="Refresh"><i class="ti ti-refresh"></i></button>' +
        '<button class="proj-icon-btn" onclick="closeProjectFileExplorer()" title="Close"><i class="ti ti-x"></i></button>' +
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
      ? (canEdit2 ? '<button class="proj-icon-btn proj-save-btn" onclick="saveProjectFile()" title="Save file"><i class="ti ti-device-floppy"></i> Save</button>' : '') +
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
    _showToast('Saved as project context');
  } catch(e) { _showToast('Error: ' + e.message, true); }
}

// ── Contexts Tab ──────────────────────────────────────────────────────────

function _renderContextsTab(proj) {
  var ctxs = proj.contexts || [];
  var pinned = ctxs.filter(function(c){ return c.pinned; });
  var unpinned = ctxs.filter(function(c){ return !c.pinned; });
  var sorted = pinned.concat(unpinned);

  return '<div class="proj-section-header">' +
    '<span>' + ctxs.length + ' context' + (ctxs.length !== 1 ? 's' : '') + '</span>' +
    '<button class="proj-action-btn" onclick="openAddContextDialog()"><i class="ti ti-plus"></i> Add context</button>' +
  '</div>' +
  (sorted.length ? sorted.map(_renderContextCard).join('') :
    '<div class="proj-hub-empty"><i class="ti ti-files" style="font-size:28px;opacity:.3"></i>' +
    '<div>No contexts yet</div>' +
    '<div style="font-size:11px;color:var(--fau-text-dim)">Save files, URLs, or AI artifacts as named contexts</div></div>');
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
      _showToast('Saved to ' + proj.name);
    } catch(e) { _showToast('Error: ' + e.message, true); }
  } else {
    // Not in a project — show project picker
    _openGenUIProjectPicker(specJson, title);
  }
}

function _openGenUIProjectPicker(specJson, title) {
  var existing = document.getElementById('gui-proj-picker-overlay');
  if (existing) existing.remove();

  var overlay = document.createElement('div');
  overlay.id = 'gui-proj-picker-overlay';
  overlay.className = 'proj-picker-overlay';
  overlay.onclick = function(e) { if (e.target === overlay) overlay.remove(); };

  var projList = (state.projects || []).map(function(p) {
    return '<div class="proj-picker-item" onclick="_saveGenUIToSpecificProject(\'' +
      _projEsc(p.id) + '\',document.getElementById(\'gui-proj-picker-overlay\'))">' +
      '<span class="proj-dot proj-color-' + _projEsc(p.color) + '"></span>' +
      '<span class="proj-picker-name">' + _projEsc(p.name) + '</span>' +
    '</div>';
  }).join('') || '<div style="padding:12px;color:var(--fau-text-dim)">No projects yet</div>';

  overlay.innerHTML =
    '<div class="proj-picker-panel">' +
      '<div class="proj-picker-header">' +
        '<span><i class="ti ti-folder-plus"></i> Add to Project</span>' +
        '<button onclick="document.getElementById(\'gui-proj-picker-overlay\').remove()"><i class="ti ti-x"></i></button>' +
      '</div>' +
      '<div style="padding:8px 12px;font-size:11px;color:var(--fau-text-muted)">Save <strong>' + _projEsc(title || 'UI Component') + '</strong> as a project context</div>' +
      '<div class="proj-picker-list">' + projList + '</div>' +
      '<div class="proj-picker-footer">' +
        '<button class="proj-action-btn" onclick="_createProjectAndSaveGenUI()"><i class="ti ti-plus"></i> New project</button>' +
      '</div>' +
    '</div>';

  // Stash spec on the overlay so sub-functions can reach it
  overlay._guiSpecJson = specJson;
  overlay._guiTitle    = title;
  document.body.appendChild(overlay);
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

function openMoveConversationToProject() {
  var conv = typeof getConv === 'function' && state.currentId ? getConv(state.currentId) : null;
  if (!conv) { _showToast('No active conversation', true); return; }

  var existing = document.getElementById('move-conv-proj-overlay');
  if (existing) existing.remove();

  var overlay = document.createElement('div');
  overlay.id = 'move-conv-proj-overlay';
  overlay.className = 'proj-picker-overlay';
  overlay.onclick = function(e) { if (e.target === overlay) overlay.remove(); };

  var projList = (state.projects || []).map(function(p) {
    var isLinked = conv.projectId === p.id;
    return '<div class="proj-picker-item' + (isLinked ? ' active' : '') + '" onclick="_linkConvToProject(\'' +
      _projEsc(p.id) + '\',document.getElementById(\'move-conv-proj-overlay\'))">' +
      '<span class="proj-dot proj-color-' + _projEsc(p.color) + '"></span>' +
      '<span class="proj-picker-name">' + _projEsc(p.name) + '</span>' +
      (isLinked ? '<span style="margin-left:auto;font-size:10px;color:var(--accent)"><i class="ti ti-check"></i></span>' : '') +
    '</div>';
  }).join('') || '<div style="padding:12px;color:var(--fau-text-dim)">No projects yet</div>';

  var removeRow = conv.projectId
    ? '<div class="proj-picker-item" onclick="_linkConvToProject(null,document.getElementById(\'move-conv-proj-overlay\'))" style="color:var(--fau-text-muted)">' +
        '<i class="ti ti-folder-x" style="font-size:13px"></i> <span>Remove from project</span>' +
      '</div>'
    : '';

  overlay.innerHTML =
    '<div class="proj-picker-panel">' +
      '<div class="proj-picker-header">' +
        '<span><i class="ti ti-folder-symlink"></i> Move to Project</span>' +
        '<button onclick="document.getElementById(\'move-conv-proj-overlay\').remove()"><i class="ti ti-x"></i></button>' +
      '</div>' +
      '<div style="padding:8px 12px;font-size:11px;color:var(--fau-text-muted)">Assign this conversation to a project</div>' +
      '<div class="proj-picker-list">' + projList + removeRow + '</div>' +
      '<div class="proj-picker-footer">' +
        '<button class="proj-action-btn" onclick="_createProjectAndMoveConv()"><i class="ti ti-plus"></i> New project</button>' +
      '</div>' +
    '</div>';

  document.body.appendChild(overlay);
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
  handle.addEventListener('mousedown', function(e) {
    e.preventDefault();
    var startX = e.clientX;
    var startW = sources.getBoundingClientRect().width;
    document.body.classList.add('proj-run-resizing');
    function onMove(e) {
      var w = Math.min(RUN_MAX, Math.max(RUN_MIN, startW + (e.clientX - startX)));
      sources.style.width = w + 'px';
    }
    function onUp() {
      document.body.classList.remove('proj-run-resizing');
      localStorage.setItem(RUN_KEY, Math.round(sources.getBoundingClientRect().width));
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
    }
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
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
  try {
    var r = await fetch('/api/projects/' + pid + '/runs/' + runId, { method: 'DELETE' });
    if (!r.ok) throw new Error((await r.json()).error);
    _showToast('Stopped');
    if (_runOpenLogId === runId) _runLogClose();
    await _runRefresh();
  } catch(e) { _showToast('Stop failed: ' + e.message, true); }
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

// ── Tasks Tab ─────────────────────────────────────────────────────────────

function _renderTasksTab(proj) {
  // Resolve tasks from _tasksCache (defined in tasks.js)
  var tasks = typeof _tasksCache !== 'undefined'
    ? _tasksCache.filter(function(t) { return t.projectId === proj.id; })
    : [];
  if (!tasks.length) {
    return '<div class="proj-hub-empty"><i class="ti ti-checklist" style="font-size:28px;opacity:.3"></i>' +
      '<div>No tasks for this project</div>' +
      '<button class="proj-action-btn" onclick="closeProjectHub();toggleTasksPanel()"><i class="ti ti-plus"></i> Create a task</button></div>';
  }
  return tasks.map(function(t) {
    var icon = { running:'ti-player-play', completed:'ti-check', failed:'ti-x', pending:'ti-clock', scheduled:'ti-calendar', paused:'ti-player-pause' }[t.status] || 'ti-clock';
    return '<div class="proj-task-row">' +
      '<i class="ti ' + icon + ' proj-task-icon task-status-' + t.status + '"></i>' +
      '<span class="proj-task-name">' + _projEsc(t.title) + '</span>' +
      '<span class="proj-task-status">' + t.status + '</span>' +
    '</div>';
  }).join('');
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
        '<input type="checkbox" id="proj-set-allow-edit" class="proj-toggle-input"' + (proj.allowFileEditing ? ' checked' : '') + '>' +
        '<span class="proj-toggle-track"><span class="proj-toggle-thumb"></span></span>' +
        '<span class="proj-toggle-text">Allow editing source files</span>' +
      '</label>' +
      '<div class="proj-settings-hint">When on, you and agents can modify files in this project\'s sources directly from the file viewer.</div>' +
    '</div>' +
    '<div class="proj-settings-actions">' +
      '<button class="proj-action-btn" onclick="saveProjectSettings()"><i class="ti ti-check"></i> Save</button>' +
      '<button class="proj-action-btn proj-danger-btn" onclick="confirmDeleteProject()"><i class="ti ti-trash"></i> Delete project</button>' +
    '</div>' +
  '</div>';
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
    if (data.cancelled || !data.path) return;
    var input = document.getElementById('proj-set-root');
    if (input) {
      input.value = data.path;
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

async function saveProjectSettings() {
  var proj = _activeProject();
  if (!proj) return;
  var name = (document.getElementById('proj-set-name') || {}).value || proj.name;
  var desc = (document.getElementById('proj-set-desc') || {}).value || '';
  var root = (document.getElementById('proj-set-root') || {}).value || null;
  var allowEdit = !!(document.getElementById('proj-set-allow-edit') || {}).checked;
  try {
    var r = await fetch('/api/projects/' + proj.id, {
      method: 'PUT', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, description: desc, rootPath: root || null, color: proj.color, allowFileEditing: allowEdit })
    });
    if (!r.ok) throw new Error((await r.json()).error);
    await _refreshProject(proj.id);
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
    if (data.cancelled || !data.path) return;
    var input = document.getElementById('proj-new-root');
    if (input) input.value = data.path;
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
    if (data.cancelled || !data.path) return;
    var input = document.getElementById('pmf-' + fieldId);
    if (input) input.value = data.path;
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
    await setActiveProject(proj.id);
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
        if (sr.ok) { await _refreshProject(proj.id); renderProjectContextBar(); _showToast('UI saved to ' + proj.name); }
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
    var input;
    if (f.type === 'textarea') {
      input = '<textarea class="proj-input proj-modal-textarea" id="pmf-' + f.id + '" placeholder="' + _projEsc(f.placeholder || '') + '"></textarea>';
    } else if (f.type === 'select') {
      input = '<select class="proj-input" id="pmf-' + f.id + '">' +
        (f.options || []).map(function(o) {
          return '<option value="' + _projEsc(o.value) + '">' + _projEsc(o.label) + '</option>';
        }).join('') +
      '</select>';
    } else if (f.browse) {
      input = '<div style="display:flex;gap:6px;flex:1">' +
        '<input class="proj-input" id="pmf-' + f.id + '" type="text" placeholder="' + _projEsc(f.placeholder || '') + '" autocomplete="off" style="flex:1">' +
        '<button class="proj-action-btn" type="button" onclick="_projModalBrowse(\'' + f.id + '\')" title="Browse"><i class="ti ti-folder-open"></i></button>' +
      '</div>';
    } else {
      input = '<input class="proj-input" id="pmf-' + f.id + '" type="text" placeholder="' + _projEsc(f.placeholder || '') + '" autocomplete="off">';
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

  overlay.querySelector('#_pmclose').onclick  = function() { overlay.remove(); };
  overlay.querySelector('#_pmcancel').onclick = function() { overlay.remove(); };
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
    if (e.key === 'Escape') overlay.remove();
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

// ── Global Ports Dashboard ────────────────────────────────────────────────

var _portsPollingInterval = null;

function _startPortsPolling() {
  if (_portsPollingInterval) return;
  _portsPollingInterval = setInterval(_pollPorts, 5000);
  _pollPorts();
}

async function _pollPorts() {
  try {
    var r = await fetch('/api/runs');
    var runs = await r.json();
    var active = runs.filter(function(r) { return r.status === 'running' || r.status === 'starting'; });
    var btn = document.getElementById('topbar-ports-btn');
    var cnt = document.getElementById('topbar-ports-count');
    if (btn) btn.style.display = active.length ? '' : 'none';
    if (cnt) cnt.textContent = active.length;
  } catch(_) {}
}

function openPortsDashboard() {
  fetch('/api/runs').then(function(r) { return r.json(); }).then(function(runs) {
    var rows = runs.map(function(r) {
      var isActive = r.status === 'running' || r.status === 'starting';
      var portStr = r.port ? ':' + r.port : '(no port)';
      var statusDot = '<span class="proj-run-status-dot proj-run-status-' + r.status + '"></span>';
      var openBtn = r.port && isActive
        ? '<button class="proj-action-btn" style="padding:3px 10px;font-size:11px" onclick="openRunInBrowser(\'http://localhost:' + r.port + '\');document.querySelector(\'.proj-modal-overlay\').remove()">Open</button>'
        : '';
      var stopBtn = isActive
        ? '<button class="proj-action-btn" style="padding:3px 10px;font-size:11px;color:var(--error-light)" onclick="stopProjectRun(\'' + r.runId + '\',\'' + r.projectId + '\').then(function(){openPortsDashboard()});document.querySelector(\'.proj-modal-overlay\').remove()">Stop</button>'
        : '';
      return '<tr class="proj-ports-row">' +
        '<td>' + statusDot + ' ' + _projEsc(r.name) + '</td>' +
        '<td>' + _projEsc(r.srcName) + '</td>' +
        '<td style="font-variant-numeric:tabular-nums">' + portStr + '</td>' +
        '<td><code class="proj-run-cmd-badge">' + _projEsc(r.cmd.length > 40 ? r.cmd.slice(0,40) + '…' : r.cmd) + '</code></td>' +
        '<td style="white-space:nowrap">' + openBtn + ' ' + stopBtn + '</td>' +
      '</tr>';
    }).join('');

    var html = runs.length
      ? '<table class="proj-ports-table"><thead><tr><th>Process</th><th>Source</th><th>Port</th><th>Command</th><th></th></tr></thead><tbody>' + rows + '</tbody></table>'
      : '<div class="proj-hub-empty" style="padding:32px"><i class="ti ti-server" style="font-size:28px;opacity:.3"></i><div>No active processes</div></div>';

    var overlay = document.createElement('div');
    overlay.className = 'proj-modal-overlay';
    overlay.innerHTML =
      '<div class="proj-modal" style="max-width:720px;width:90vw">' +
        '<div class="proj-modal-header">' +
          '<span class="proj-modal-title"><i class="ti ti-server"></i> Active Ports</span>' +
          '<button class="proj-icon-btn" onclick="this.closest(\'.proj-modal-overlay\').remove()"><i class="ti ti-x"></i></button>' +
        '</div>' +
        '<div class="proj-modal-body" style="padding:0;overflow:auto;max-height:60vh">' + html + '</div>' +
      '</div>';
    overlay.addEventListener('click', function(e) { if (e.target === overlay) overlay.remove(); });
    document.body.appendChild(overlay);
  }).catch(function() {});
}
