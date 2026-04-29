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
  renderProjectContextBar();
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

// ── Project Switcher (sidebar pill) ──────────────────────────────────────

function renderProjectSwitcher() {
  var el = document.getElementById('project-switcher');
  if (!el) return;
  var proj = _activeProject();
  if (!proj) {
    el.innerHTML =
      '<div class="proj-switcher-row">' +
        '<button class="proj-switcher-btn proj-switcher-none" onclick="openProjectPicker()" title="Switch project">' +
          '<i class="ti ti-folder-open"></i> No project' +
        '</button>' +
        '<button class="proj-new-btn" onclick="openCreateProjectDialog()" title="New project"><i class="ti ti-plus"></i></button>' +
      '</div>';
    return;
  }
  el.innerHTML =
    '<div class="proj-switcher-row">' +
      '<button class="proj-switcher-btn proj-switcher-active" onclick="openProjectHub()" title="Open project hub" data-proj-color="' + _projEsc(proj.color) + '">' +
        '<span class="proj-dot proj-color-' + _projEsc(proj.color) + '"></span>' +
        '<span class="proj-switcher-label">' + _projEsc(proj.name) + '</span>' +
        '<i class="ti ti-layout-sidebar-right-expand" style="margin-left:4px;font-size:11px;opacity:.6"></i>' +
      '</button>' +
      '<button class="proj-switcher-close-btn" onclick="clearActiveProject()" title="Deactivate project"><i class="ti ti-x"></i></button>' +
    '</div>';
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
  renderProjectContextBar();
  if (typeof renderConvList === 'function') renderConvList();
  if (typeof renderTasks === 'function') renderTasks();
}

function clearActiveProject() {
  setActiveProject(null);
  closeProjectHub();
}

// ── Project Hub Panel ─────────────────────────────────────────────────────

function openProjectHub(tab) {
  var proj = _activeProject();
  if (!proj) { openProjectPicker(); return; }
  state.projectHubOpen = true;
  state.projectHubTab = tab || state.projectHubTab || 'files';
  var hub = document.getElementById('project-hub');
  if (!hub) return;
  hub.style.display = 'flex';
  _renderProjectHub(proj);
}

function closeProjectHub() {
  state.projectHubOpen = false;
  if (_projMonacoEditor) { _projMonacoEditor.dispose(); _projMonacoEditor = null; }
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
    { id: 'convs',    icon: 'ti-messages',      label: 'Conversations' },
    { id: 'tasks',    icon: 'ti-checklist',     label: 'Tasks' },
    { id: 'settings', icon: 'ti-settings',      label: 'Settings' },
  ];
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
  if (tab === 'files')         body.innerHTML = _renderFilesTab(proj);
  else if (tab === 'contexts') body.innerHTML = _renderContextsTab(proj);
  else if (tab === 'sources')  body.innerHTML = _renderSourcesTab(proj);
  else if (tab === 'convs')    body.innerHTML = _renderConvsTab(proj);
  else if (tab === 'tasks')    body.innerHTML = _renderTasksTab(proj);
  else if (tab === 'settings') body.innerHTML = _renderSettingsTab(proj);
}

// ── Files Tab ─────────────────────────────────────────────────────────────

function _renderFilesTab(proj) {
  if (!proj.sources || !proj.sources.length) {
    return '<div class="proj-hub-empty"><i class="ti ti-folder-open" style="font-size:28px;opacity:.3"></i><div>No sources yet</div>' +
      '<button class="proj-action-btn" onclick="switchProjectHubTab(\'sources\')"><i class="ti ti-plus"></i> Add a source</button></div>';
  }
  var srcOptions = proj.sources.map(function(s) {
    return '<option value="' + _projEsc(s.id) + '">' + _projEsc(s.name) + '</option>';
  }).join('');
  var activeSrcId = state._projectFileSrcId || proj.sources[0].id;
  return '<div class="proj-files-toolbar">' +
    '<select class="proj-src-select" onchange="loadProjectFileTree(this.value, \'\')">' + srcOptions + '</select>' +
    '<button class="proj-icon-btn" onclick="loadProjectFileTree(document.querySelector(\'.proj-src-select\').value, \'\')" title="Refresh"><i class="ti ti-refresh"></i></button>' +
  '</div>' +
  '<div id="proj-file-tree-root" class="proj-file-tree"></div>' +
  '<div id="proj-file-viewer" class="proj-file-viewer" style="display:none"></div>' +
  '<script>loadProjectFileTree("' + _projEsc(activeSrcId) + '", "");<\/script>';
}

async function loadProjectFileTree(srcId, subPath) {
  if (!state.activeProjectId) return;
  state._projectFileSrcId = srcId;
  state._projectFilePath  = subPath;
  var treeEl = document.getElementById('proj-file-tree-root');
  if (!treeEl) return;
  treeEl.innerHTML = '<div class="proj-loading"><i class="ti ti-loader-2 spin"></i> Loading…</div>';
  try {
    var r = await fetch('/api/projects/' + state.activeProjectId + '/sources/' + srcId + '/files?path=' + encodeURIComponent(subPath));
    var files = await r.json();
    if (!r.ok) { treeEl.innerHTML = '<div class="proj-hub-error">' + _projEsc(files.error) + '</div>'; return; }
    treeEl.innerHTML = _renderFileList(files, srcId, subPath);
    if (subPath) {
      var backHtml = '<div class="proj-file-back" onclick="loadProjectFileTree(\'' + _projEsc(srcId) + '\', \'' + _projEsc(subPath.split('/').slice(0,-1).join('/')) + '\')">' +
        '<i class="ti ti-arrow-left"></i> Back' +
      '</div>';
      treeEl.innerHTML = backHtml + treeEl.innerHTML;
    }
  } catch(e) { treeEl.innerHTML = '<div class="proj-hub-error">' + _projEsc(e.message) + '</div>'; }
}

function _renderFileList(files, srcId, subPath) {
  if (!files.length) return '<div class="proj-hub-empty">Empty directory</div>';
  return files.map(function(f) {
    var icon = f.type === 'dir' ? 'ti-folder' : _fileIcon(f.ext);
    var clickFn = f.type === 'dir'
      ? 'loadProjectFileTree(\'' + _projEsc(srcId) + '\',\'' + _projEsc(f.path) + '\')'
      : 'openProjectFile(\'' + _projEsc(srcId) + '\',\'' + _projEsc(f.path) + '\')';
    var sizeLabel = f.type === 'file' && f.size ? ' <span class="proj-file-size">' + _fmtSize(f.size) + '</span>' : '';
    return '<div class="proj-file-row" onclick="' + clickFn + '">' +
      '<i class="ti ' + icon + ' proj-file-icon"></i>' +
      '<span class="proj-file-name">' + _projEsc(f.name) + '</span>' +
      sizeLabel +
    '</div>';
  }).join('');
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
        headerBtns =
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
      readOnly: true,
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

async function saveFileAsContext(srcId, filePath) {
  if (!state.activeProjectId) return;
  try {
    var r = await fetch('/api/projects/' + state.activeProjectId + '/sources/' + srcId + '/file?path=' + encodeURIComponent(filePath));
    var data = await r.json();
    if (!r.ok) throw new Error(data.error);
    var r2 = await fetch('/api/projects/' + state.activeProjectId + '/contexts', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'file', name: filePath.split('/').pop(), content: data.content, path: filePath })
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
    '<div style="font-size:11px;color:var(--text-dim)">Save files, URLs, or AI artifacts as named contexts</div></div>');
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
  _projModal({
    title: 'Add Context',
    fields: [
      { id: 'ctx-name',    label: 'Name',    placeholder: 'e.g. API spec', type: 'text' },
      { id: 'ctx-content', label: 'Content', placeholder: 'Paste text here…', type: 'textarea' },
    ],
    submit: 'Add',
    onSubmit: function(vals) {
      if (!vals['ctx-name']) return 'Name is required';
      _addProjectContext({ type: 'snippet', name: vals['ctx-name'], content: vals['ctx-content'] || '' });
    },
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
async function saveArtifactToProject(artifactData) {
  var proj = _activeProject();
  if (!proj) { _showToast('No active project', true); return; }
  try {
    var r = await fetch('/api/projects/' + proj.id + '/contexts/from-artifact', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(artifactData)
    });
    if (!r.ok) throw new Error((await r.json()).error);
    await _refreshProject(proj.id);
    renderProjectContextBar();
    _showToast('Saved to ' + proj.name);
  } catch(e) { _showToast('Error: ' + e.message, true); }
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
    '<div style="font-size:11px;color:var(--text-dim)">Add a local folder or connect a GitHub/GitLab repo</div></div>');
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
      '<button class="proj-icon-btn" style="color:var(--text-muted)" onclick="deleteProjectSource(\'' + s.id + '\')" title="Remove"><i class="ti ti-trash"></i></button>' +
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
      '<div style="font-size:11px;color:var(--text-dim)">New conversations while this project is active will appear here with all project context included</div></div>';
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
  try {
    var r = await fetch('/api/projects/' + proj.id, {
      method: 'PUT', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, description: desc, rootPath: root || null, color: proj.color })
    });
    if (!r.ok) throw new Error((await r.json()).error);
    await _refreshProject(proj.id);
    renderProjectSwitcher();
    _renderProjectHub(_activeProject());
    _showToast('Project saved');
  } catch(e) { _showToast('Error: ' + e.message, true); }
}

async function confirmDeleteProject() {
  var proj = _activeProject();
  if (!proj) return;
  if (!await _projConfirm('Delete project \u201c' + proj.name + '\u201d? This cannot be undone.')) return;
  try {
    await fetch('/api/projects/' + proj.id, { method: 'DELETE' });
    var idx = state.projects.findIndex(function(p) { return p.id === proj.id; });
    if (idx !== -1) state.projects.splice(idx, 1);
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
      '</div>';
    }).join('') : '<div style="padding:12px;color:var(--text-dim)">No projects yet</div>') +
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
        '<div class="proj-settings-row"><label>Name</label><input class="proj-input" id="proj-new-name" placeholder="My project" autofocus></div>' +
        '<div class="proj-settings-row"><label>Description</label><input class="proj-input" id="proj-new-desc" placeholder="Optional description"></div>' +
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
  var desc = (document.getElementById('proj-new-desc') || {}).value || '';
  var root = (document.getElementById('proj-new-root') || {}).value || null;
  var color = window._newProjColor || 'teal';
  try {
    var r = await fetch('/api/projects', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: name.trim(), description: desc, rootPath: root || null, color })
    });
    if (!r.ok) throw new Error((await r.json()).error);
    var proj = await r.json();
    state.projects.push(proj);
    var overlay = document.getElementById('proj-create-overlay');
    if (overlay) overlay.remove();
    await setActiveProject(proj.id);
    openProjectHub('files');
    _showToast('Project created');
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
