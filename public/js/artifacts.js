// ── Artifact Pane ─────────────────────────────────────────────────────────

var _codePreviewRegistry = {}; // id → rawText for Preview buttons on code blocks

var ARTIFACT_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

// Prune artifacts older than 30 days from a conversation's persisted list
function pruneStaleArtifacts(conv) {
  if (!conv || !conv.artifacts) return;
  var cutoff = Date.now() - ARTIFACT_TTL_MS;
  conv.artifacts = conv.artifacts.filter(function(a) {
    return !a.createdAt || a.createdAt > cutoff;
  });
}

function addArtifact(spec) {
  var id = 'art-' + Date.now() + '-' + Math.random().toString(36).slice(2, 6);
  var artifact = Object.assign({ id: id, createdAt: Date.now() }, spec);
  state.artifacts.push(artifact);
  if (state.artifacts.length > 20) state.artifacts.shift();
  renderArtifactTabs();
  if (document.getElementById('all-artifacts-page')?.style.display !== 'none' && typeof renderAllArtifactsPage === 'function') renderAllArtifactsPage();
  if (document.getElementById('home-page')?.style.display !== 'none' && typeof renderHomePage === 'function') renderHomePage();
  // If the pane is already open with nothing selected, auto-show this artifact so
  // it doesn't appear empty when a fresh artifact streams in.
  var pane = document.getElementById('artifact-pane');
  if (pane && pane.classList.contains('open') && !state.activeArtifact) {
    state.activeArtifact = id;
    if (typeof renderArtifactContent === 'function') renderArtifactContent();
    renderArtifactTabs();
  }
  // Lazy-load image data if only a path was provided
  if (artifact.type === 'image' && artifact.path && !artifact.base64) {
    fetchArtifactImage(id, artifact.path);
  }
  // Persist to current conversation (strip large payloads so localStorage stays small)
  var conv = getConv(state.currentId);
  if (conv) {
    if (!conv.artifacts) conv.artifacts = [];
    var stored = Object.assign({}, artifact);
    if (stored.base64 && stored.base64.length > 20000) delete stored.base64;
    // For file-backed text artifacts we can reload the full content from disk,
    // so don't bloat localStorage with large inline copies — it re-hydrates on view.
    if (stored.path && _artifactShouldHydrateFromDisk(stored) &&
        typeof stored.content === 'string' && stored.content.length > 20000) {
      delete stored.content;
    }
    conv.artifacts.push(stored);
    if (conv.artifacts.length > 20) conv.artifacts.shift();
    saveConversations();
  }
  return id;
}

// Open the pane and show a specific artifact (called from cards/buttons)
function openArtifact(id) {
  switchArtifactTab(id);
  openArtifactPane();
}

// Inject a compact inline card that lets the user open the artifact on demand
function injectArtifactCard(id, containerEl) {
  if (!containerEl) return;
  var a = state.artifacts.find(function(x) { return x.id === id; });
  if (!a) return;
  var icons = { html:'ti-brand-html5', image:'ti-photo', markdown:'ti-markdown', json:'ti-braces',
                csv:'ti-table', text:'ti-file-text', files:'ti-folder-open', web:'ti-world', pdf:'ti-file-type-pdf', docx:'ti-file-word',
                code:'ti-code', svg:'ti-vector', summary:'ti-align-left' };
  var labels = { html:'HTML', image:'Image', markdown:'Markdown', json:'JSON',
                 csv:'CSV', text:'Text', files:'Files', web:'Web', pdf:'PDF', docx:'DOCX', code:'Code',
                 svg:'SVG', summary:'Summary' };
  var icon  = icons[a.type]  || 'ti-file';
  var label = labels[a.type] || a.type;
  var card  = document.createElement('div');
  card.className = 'artifact-card';
  card.innerHTML =
    '<div class="artifact-card-icon"><i class="ti ' + icon + '"></i></div>' +
    '<div class="artifact-card-info">' +
      '<div class="artifact-card-title">' + escHtml(a.title || 'Artifact') + '</div>' +
      '<span class="artifact-card-type">' + escHtml(label) + '</span>' +
    '</div>' +
    '<button class="artifact-card-open" onclick="openArtifact(\'' + id + '\')">' +
      '<i class="ti ti-arrow-right"></i> Open' +
    '</button>';
  containerEl.appendChild(card);
}

function removeArtifact(id) {
  var idx = state.artifacts.findIndex(function(a) { return a.id === id; });
  if (idx === -1) return;
  state.artifacts.splice(idx, 1);
  // Also remove from the persisted conversation list, otherwise the artifact
  // reappears whenever state.artifacts is rebuilt from conv.artifacts (e.g. on
  // conversation reload or when the next artifact streams in).
  var conv = getConv(state.currentId);
  if (conv && Array.isArray(conv.artifacts)) {
    var cidx = conv.artifacts.findIndex(function(a) { return a.id === id; });
    if (cidx !== -1) {
      conv.artifacts.splice(cidx, 1);
      saveConversations();
    }
  }
  if (state.activeArtifact === id) {
    state.activeArtifact = state.artifacts.length ? state.artifacts[state.artifacts.length - 1].id : null;
  }
  renderArtifactTabs();
  if (!state.artifacts.length) closeArtifactPane();
  else renderArtifactContent();
}

function openArtifactPane() {
  document.getElementById('artifact-pane').classList.add('open');
}

function closeArtifactPane() {
  document.getElementById('artifact-pane').classList.remove('open');
}

// ── Artifact pane resize ──────────────────────────────────────────────────
(function () {
  var STORAGE_KEY = 'fauna-artifact-width';
  var MIN = 280, MAX = 900;

  // Restore saved width
  var saved = parseInt(localStorage.getItem(STORAGE_KEY), 10);
  if (saved && saved >= MIN && saved <= MAX) {
    var style = document.createElement('style');
    style.id = 'artifact-width-override';
    style.textContent = '#artifact-pane.open { width: ' + saved + 'px !important; }';
    document.head.appendChild(style);
  }

  function setWidth(w) {
    w = Math.max(MIN, Math.min(MAX, w));
    var el = document.getElementById('artifact-width-override');
    if (!el) {
      el = document.createElement('style');
      el.id = 'artifact-width-override';
      document.head.appendChild(el);
    }
    el.textContent = '#artifact-pane.open { width: ' + w + 'px !important; }';
    localStorage.setItem(STORAGE_KEY, w);
  }

  document.addEventListener('DOMContentLoaded', function () {
    var handle = document.getElementById('artifact-resize-handle');
    if (!handle) return;
    var pane = document.getElementById('artifact-pane');

    window.installPaneResize({
      handle: handle,
      classTarget: pane,
      getStartWidth: function () { return pane.getBoundingClientRect().width; },
      onMove: function (dx, startW) {
        // Handle is on the left edge — dragging left widens the pane.
        setWidth(startW - dx);
      },
    });

    // Double-click handle → reset to default width
    handle.addEventListener('dblclick', function () {
      localStorage.removeItem(STORAGE_KEY);
      var el = document.getElementById('artifact-width-override');
      if (el) el.textContent = '#artifact-pane.open { width: 440px !important; }';
    });
  });
}());


function appendAINotice(markdown, convId) {
  var inner = getConvInner(convId || state.currentId);
  if (!inner) return;
  var el = document.createElement('div');
  el.className = 'msg ai';
  el.innerHTML = '<div class="msg-body"><div class="prose">' + renderMarkdown(markdown) + '</div></div>';
  inner.appendChild(el);
  scrollBottom();
}

function switchArtifactTab(id) {
  state.activeArtifact = id;
  state.artifactCodeView = false; // reset to visual when switching tabs
  renderArtifactTabs();
  renderArtifactContent();
}

function _artifactShouldHydrateFromDisk(a) {
  return !!(a && a.path && ['markdown','summary','web','text','code','json','csv','html','svg','design'].includes(a.type));
}

function _hydrateArtifactFromDisk(a) {
  if (!_artifactShouldHydrateFromDisk(a) || a._hydratingFromDisk) return;
  a._hydratingFromDisk = true;
  fetch('/api/read-file', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ path: a.path })
  }).then(function(r) { return r.json(); }).then(function(d) {
    a._hydratingFromDisk = false;
    if (!d.ok) throw new Error(d.error || 'read failed');
    var diskContent = d.content || '';
    if (diskContent && diskContent !== a.content) {
      a.content = diskContent;
      a.bytes = d.bytes;
      a._hydratedFromDisk = true;
      dbg('artifact hydrate: loaded full file path=' + d.path + ' bytes=' + d.bytes + ' chars=' + diskContent.length, 'ok');
      if (state.activeArtifact === a.id) renderArtifactContent();
      var conv = getConv(state.currentId);
      if (conv && conv.artifacts) {
        var stored = conv.artifacts.find(function(x) { return x.id === a.id; });
        if (stored) {
          stored.content = diskContent;
          stored.bytes = d.bytes;
          stored._hydratedFromDisk = true;
          saveConversations();
        }
      }
    }
  }).catch(function(e) {
    a._hydratingFromDisk = false;
    dbg('artifact hydrate failed: ' + (a.path || a.title || a.id) + ' — ' + e.message, 'warn');
  });
}

function renderArtifactTabs() {
  var tabs = document.getElementById('artifact-tabs');
  if (!tabs) return;
  tabs.innerHTML = state.artifacts.map(function(a) {
    var icon = artifactTypeIcon(a.type);
    var active = a.id === state.activeArtifact ? ' active' : '';
    return '<div class="artifact-tab' + active + '" onclick="switchArtifactTab(\'' + a.id + '\')" title="' + escHtml(a.title || '') + '">' +
      '<i class="ti ' + icon + '" style="font-size:11px;flex-shrink:0"></i>' +
      '<span class="artifact-tab-text">' + escHtml(a.title || 'Artifact') + '</span>' +
      '<button class="artifact-tab-close" onclick="event.stopPropagation();removeArtifact(\'' + a.id + '\')" title="Close">×</button>' +
    '</div>';
  }).join('');
}

function artifactTypeIcon(type) {
  var m = { html:'ti-brand-html5', image:'ti-photo', markdown:'ti-markdown', json:'ti-braces',
            csv:'ti-table', text:'ti-file-text', files:'ti-folder-open', web:'ti-world', pdf:'ti-file-type-pdf', docx:'ti-file-word',
            code:'ti-code', svg:'ti-vector', summary:'ti-align-left', design:'ti-layout-2' };
  return m[type] || 'ti-file';
}

function _artifactTypeLabel(type) {
  var m = { html:'HTML', image:'Image', markdown:'Markdown', json:'JSON', csv:'CSV', text:'Text', files:'Files', web:'Web', pdf:'PDF', docx:'DOCX', code:'Code', svg:'SVG', summary:'Summary', design:'Design' };
  return m[type] || (type || 'Artifact');
}

function _artifactRelativeTime(ts) {
  if (!ts) return 'Unknown';
  var diff = Date.now() - ts;
  var mins = Math.max(1, Math.floor(diff / 60000));
  if (mins < 60) return mins + 'm ago';
  var hours = Math.floor(mins / 60);
  if (hours < 24) return hours + 'h ago';
  var days = Math.floor(hours / 24);
  if (days < 30) return days + 'd ago';
  var months = Math.floor(days / 30);
  return months + 'mo ago';
}

function _projectForConversation(conv) {
  if (!conv || !conv.projectId) return null;
  return (state.projects || []).find(function(p) { return p.id === conv.projectId; }) || null;
}

function _getCachedStoreAccount() {
  if (typeof storeState !== 'undefined' && storeState.account) return storeState.account;
  try {
    var cached = localStorage.getItem('store-account');
    return cached ? JSON.parse(cached) : null;
  } catch (_) { return null; }
}

function _firstNameFromText(text) {
  text = String(text || '').trim();
  if (!text) return '';
  if (text.indexOf('@') !== -1) text = text.split('@')[0].replace(/[._-]+/g, ' ');
  return text.split(/\s+/).filter(Boolean)[0] || '';
}

function getFaunaHomeUserName() {
  var saved = localStorage.getItem('fauna-user-display-name') || '';
  var account = _getCachedStoreAccount();
  var accountName = account && (account.name || account.displayName || account.email);
  return _firstNameFromText(accountName) || _firstNameFromText(saved);
}

function saveFaunaHomeUserName() {
  var input = document.getElementById('home-name-input');
  if (!input) return;
  var value = input.value.trim();
  if (!value) return;
  localStorage.setItem('fauna-user-display-name', value);
  renderHomePage();
}

function renderHomeNamePrompt() {
  return '<div class="home-name-prompt">' +
    '<label for="home-name-input">What should Fauna call you?</label>' +
    '<div><input id="home-name-input" type="text" placeholder="First name" onkeydown="if(event.key===\'Enter\')saveFaunaHomeUserName()"><button class="proj-action-btn" onclick="saveFaunaHomeUserName()"><i class="ti ti-check"></i> Save</button></div>' +
  '</div>';
}

function getAllSavedArtifacts() {
  var items = [];
  var seen = Object.create(null);
  (state.conversations || []).forEach(function(conv) {
    if (!conv || !Array.isArray(conv.artifacts)) return;
    var project = _projectForConversation(conv);
    conv.artifacts.forEach(function(artifact) {
      if (!artifact || !artifact.id) return;
      var key = conv.id + ':' + artifact.id;
      if (seen[key]) return;
      seen[key] = true;
      items.push(Object.assign({}, artifact, {
        convId: conv.id,
        conversationTitle: conv.title || 'Conversation',
        projectId: conv.projectId || null,
        projectName: project ? project.name : '',
        projectColor: project ? project.color : '',
      }));
    });
  });
  return items.sort(function(a, b) { return (b.createdAt || 0) - (a.createdAt || 0); });
}

function _closeGlobalPages(exceptId) {
  ['home-page', 'all-artifacts-page', 'all-convs-page', 'all-projects-page', 'all-agents-page', 'agent-actions-page'].forEach(function(id) {
    if (id === exceptId) return;
    var el = document.getElementById(id);
    if (el) el.style.display = 'none';
  });
}

function _openAppPage(pageId, title) {
  _closeReusableAppPages(pageId);
  _parkReusableAppPanels();
  _closeGlobalPages('');
  setAppRailActive(pageId);
  if (typeof setConversationRailVisible === 'function') setConversationRailVisible(false);
  var page = document.getElementById('app-page');
  var body = document.getElementById('app-page-body');
  if (!page || !body) return null;
  document.body.classList.add('app-page-open');
  page.dataset.page = pageId;
  page.style.display = 'block';
  ['empty-state', 'messages', 'input-area', 'project-context-bar'].forEach(function(id) {
    var el = document.getElementById(id);
    if (el) el.style.display = 'none';
  });
  var titleEl = document.getElementById('topbar-title');
  if (titleEl && title) {
    titleEl.textContent = title;
    titleEl.title = title;
  }
  var projectCrumb = document.getElementById('topbar-project-crumb');
  var crumbSep = document.getElementById('topbar-crumb-sep');
  if (projectCrumb) projectCrumb.style.display = 'none';
  if (crumbSep) crumbSep.style.display = 'none';
  return body;
}

function _closeReusableAppPages(nextPageId) {
  if (nextPageId !== 'automations' && typeof closeTasksPanelPage === 'function') closeTasksPanelPage();
  if (nextPageId !== 'board' && typeof closeBoardPanelPage === 'function') closeBoardPanelPage();
  if (nextPageId !== 'settings' && typeof closeSettingsPanelPage === 'function') closeSettingsPanelPage();
  if (nextPageId !== 'mcp' && window._mcpBuiltinInterval) { clearInterval(window._mcpBuiltinInterval); window._mcpBuiltinInterval = null; }
}

function _parkReusableAppPanels() {
  ['tasks-panel', 'board-panel', 'settings-panel'].forEach(function(id) {
    var el = document.getElementById(id);
    if (el && el.parentElement && el.parentElement.id === 'app-page-body') {
      document.body.appendChild(el);
    }
  });
  if (typeof _parkMcpServersPage === 'function') _parkMcpServersPage();
  if (typeof _parkPluginsPage === 'function') _parkPluginsPage();
}

function closeAppPage(opts) {
  opts = opts || {};
  var page = document.getElementById('app-page');
  if (!opts.force && page && (page.dataset.page === 'settings' || page.dataset.page === 'plugins')) {
    var holdUntil = Number(window.__faunaSettingsInteractionUntil || 0);
    if (holdUntil && Date.now() < holdUntil) return;
  }
  _closeReusableAppPages('');
  setAppRailActive('conversations');
  if (typeof setConversationRailVisible === 'function') setConversationRailVisible(true);
  var body = document.getElementById('app-page-body');
  _parkReusableAppPanels();
  if (page) {
    page.style.display = 'none';
    page.dataset.page = '';
  }
  document.body.classList.remove('app-page-open');
  if (body) body.innerHTML = '';
  var input = document.getElementById('input-area');
  if (input) input.style.display = '';
  if (typeof renderProjectContextBar === 'function') renderProjectContextBar();
}

function openPluginsPage() {
  var body = typeof _openAppPage === 'function' ? _openAppPage('plugins', 'Plugins') : null;
  var panel = document.getElementById('agent-store-panel');
  if (!body || !panel) return null;
  if (!panel._pluginsHome) panel._pluginsHome = { parent: panel.parentNode, next: panel.nextSibling };
  body.innerHTML =
    '<div class="plugins-page-shell">' +
      '<div class="plugins-page-header">' +
        '<div>' +
          '<div class="home-kicker"><span></span>Extensions</div>' +
          '<h1>Plugins</h1>' +
          '<p>Browse, install, publish, and manage Fauna agents and plugin integrations.</p>' +
        '</div>' +
      '</div>' +
      '<div id="plugins-page-mount"></div>' +
    '</div>';
  var mount = document.getElementById('plugins-page-mount');
  if (mount) mount.appendChild(panel);
  panel.style.display = 'flex';
  panel.classList.add('open', 'plugins-app-panel');
  if (typeof setAppRailActive === 'function') setAppRailActive('plugins');
  return panel;
}

function openConversationsRail() {
  closeAppPage();
  if (typeof setConversationRailVisible === 'function') setConversationRailVisible(true);
  setAppRailActive('conversations');
  var conv = state.currentId && typeof getConv === 'function' ? getConv(state.currentId) : null;
  if (conv && typeof loadConversation === 'function') loadConversation(state.currentId);
  else if (typeof showEmpty === 'function') showEmpty();
}

function setAppRailActive(pageId) {
  document.querySelectorAll('#app-rail [data-rail-page]').forEach(function(btn) {
    btn.classList.toggle('active', !!pageId && btn.dataset.railPage === pageId);
  });
}

function _getAppPageBody(pageId) {
  var page = document.getElementById('app-page');
  if (page && page.style.display !== 'none' && (!pageId || page.dataset.page === pageId)) {
    return document.getElementById('app-page-body');
  }
  return null;
}

function openHomePage() {
  if (!_openAppPage('home', 'Home')) return;
  renderHomePage();
}

function closeHomePage() {
  closeAppPage();
}

function renderHomePage() {
  var page = _getAppPageBody('home') || document.getElementById('home-page');
  if (!page) return;
  var projects = (state.projects || []).slice().sort(function(a, b) { return (b.lastActiveAt || b.updatedAt || 0) - (a.lastActiveAt || a.updatedAt || 0); });
  var convs = (state.conversations || []).slice().sort(function(a, b) { return (b.updatedAt || b.createdAt || 0) - (a.updatedAt || a.createdAt || 0); });
  var artifacts = getAllSavedArtifacts();
  var running = convs.filter(function(c) { return c._streaming; });
  var firstName = getFaunaHomeUserName();
  var greeting = firstName ? ('Hi ' + firstName + ',') : 'Welcome,';
  var namePrompt = firstName ? '' : renderHomeNamePrompt();
  var projectCards = projects.slice(0, 5).map(function(p) {
    var convCount = convs.filter(function(c) { return c.projectId === p.id; }).length;
    var artifactCount = artifacts.filter(function(a) { return a.projectId === p.id; }).length;
    var analytics = typeof getProjectTaskAnalyticsInlineHtml === 'function' ? getProjectTaskAnalyticsInlineHtml(p.id, { compact: true }) : '';
    return '<button class="home-project-row" onclick="setActiveProject(\'' + escHtml(p.id) + '\');closeHomePage()">' +
      '<span class="proj-dot proj-color-' + escHtml(p.color || 'blue') + '"></span>' +
      '<span class="home-project-main"><span>' + escHtml(p.name || 'Untitled project') + '</span><small>' + convCount + ' chats · ' + artifactCount + ' artifacts</small></span>' +
      '<span class="home-project-analytics">' + analytics + '</span>' +
    '</button>';
  }).join('') || '<div class="home-empty-row">No projects yet</div>';
  var artifactRows = artifacts.slice(0, 4).map(function(a) {
    return '<button class="home-artifact-row" onclick="viewArtifactFromLibrary(\'' + escHtml(a.convId) + '\',\'' + escHtml(a.id) + '\')">' +
      '<i class="ti ' + artifactTypeIcon(a.type) + '"></i>' +
      '<span><strong>' + escHtml(a.title || 'Artifact') + '</strong><small>' + escHtml(_artifactTypeLabel(a.type)) + ' · ' + escHtml(a.conversationTitle) + '</small></span>' +
    '</button>';
  }).join('') || '<div class="home-empty-row">No saved artifacts yet</div>';
  var recentRows = convs.slice(0, 5).map(function(c) {
    var p = _projectForConversation(c);
    return '<button class="home-conv-row" onclick="closeHomePage();loadConversation(\'' + escHtml(c.id) + '\')">' +
      (c._streaming ? '<i class="ti ti-loader-2 conv-streaming-icon"></i>' : '<i class="ti ti-message"></i>') +
      '<span><strong>' + escHtml(c.title || 'Conversation') + '</strong><small>' + (p ? escHtml(p.name) + ' · ' : '') + escHtml(_artifactRelativeTime(c.updatedAt || c.createdAt)) + '</small></span>' +
    '</button>';
  }).join('') || '<div class="home-empty-row">No conversations yet</div>';
  page.innerHTML =
    '<div class="home-shell">' +
      '<main class="home-main">' +
        '<div class="home-header"><div><div class="home-kicker"><span></span>Updated ' + escHtml(_artifactRelativeTime(Date.now())) + '</div><h1>' + escHtml(greeting) + '</h1><p>You have ' + convs.length + ' conversations, ' + projects.length + ' projects, and ' + artifacts.length + ' saved artifacts across Fauna.</p>' + namePrompt + '</div><button class="proj-action-btn" onclick="closeHomePage();newConversation()"><i class="ti ti-plus"></i> New task</button></div>' +
        '<section class="home-panel home-highlights"><div class="home-section-title"><i class="ti ti-info-circle"></i> Important highlights</div>' +
          '<button onclick="closeHomePage();openAllArtifactsPage()"><i class="ti ti-layout-grid"></i><span><strong>' + artifacts.length + ' saved artifacts</strong><small>Browse previews across every project and chat</small></span><i class="ti ti-chevron-right"></i></button>' +
          '<button onclick="closeHomePage();openAllConversations()"><i class="ti ti-messages"></i><span><strong>' + running.length + ' active conversations</strong><small>' + (running.length ? 'Agents are still working' : 'No agents are currently running') + '</small></span><i class="ti ti-chevron-right"></i></button>' +
        '</section>' +
        '<div class="home-grid">' +
          '<section class="home-panel"><div class="home-section-title"><i class="ti ti-star"></i> Projects</div>' + projectCards + '</section>' +
          '<section class="home-panel"><div class="home-section-title"><i class="ti ti-sparkles"></i> Artifacts</div>' + artifactRows + '<button class="home-link-row" onclick="closeHomePage();openAllArtifactsPage()">View artifact library <i class="ti ti-arrow-right"></i></button></section>' +
          '<section class="home-panel home-wide"><div class="home-section-title"><i class="ti ti-clock"></i> Recent conversations</div>' + recentRows + '</section>' +
        '</div>' +
      '</main>' +
    '</div>';
}

function openAllArtifactsPage() {
  var page = _openAppPage('artifacts', 'Artifacts');
  if (!page) return;
  page._filter = page._filter || '';
  page._view = page._view || localStorage.getItem('fauna-artifact-library-view') || 'grid';
  renderAllArtifactsPage();
}

function closeAllArtifactsPage() {
  closeAppPage();
}

function setArtifactLibraryView(view) {
  var page = _getAppPageBody('artifacts') || document.getElementById('all-artifacts-page');
  if (!page) return;
  page._view = view === 'list' ? 'list' : 'grid';
  localStorage.setItem('fauna-artifact-library-view', page._view);
  renderAllArtifactsPage();
}

function _findLibraryArtifact(convId, artifactId) {
  var conv = getConv(convId);
  if (!conv || !Array.isArray(conv.artifacts)) return null;
  var artifact = conv.artifacts.find(function(a) { return a.id === artifactId; });
  if (!artifact) return null;
  var project = _projectForConversation(conv);
  return Object.assign({}, artifact, {
    convId: conv.id,
    conversationTitle: conv.title || 'Conversation',
    projectId: conv.projectId || null,
    projectName: project ? project.name : '',
    projectColor: project ? project.color : '',
    _libraryPreview: true,
  });
}

function viewArtifactFromLibrary(convId, artifactId) {
  var artifact = _findLibraryArtifact(convId, artifactId);
  if (!artifact) return;
  var existing = state.artifacts.find(function(a) { return a.id === artifact.id; });
  if (!existing) {
    state.artifacts.push(artifact);
    if (artifact.type === 'image' && artifact.path && !artifact.base64) fetchArtifactImage(artifact.id, artifact.path);
  }
  openArtifact(artifact.id);
}

function goToArtifactConversation(convId) {
  closeAllArtifactsPage();
  if (typeof loadConversation === 'function') loadConversation(convId);
}

function updateArtifactLibraryFilter(value) {
  var page = _getAppPageBody('artifacts') || document.getElementById('all-artifacts-page');
  if (!page) return;
  page._filter = value || '';
  renderAllArtifactsPage();
}

function updateArtifactLibraryProject(value) {
  var page = _getAppPageBody('artifacts') || document.getElementById('all-artifacts-page');
  if (!page) return;
  page._projectFilter = value || '';
  page._conversationFilter = '';
  renderAllArtifactsPage();
}

function updateArtifactLibraryConversation(value) {
  var page = _getAppPageBody('artifacts') || document.getElementById('all-artifacts-page');
  if (!page) return;
  page._conversationFilter = value || '';
  renderAllArtifactsPage();
}

function renderAllArtifactsPage() {
  var page = _getAppPageBody('artifacts') || document.getElementById('all-artifacts-page');
  if (!page) return;
  var filter = (page._filter || '').toLowerCase();
  var projectFilter = page._projectFilter || '';
  var conversationFilter = page._conversationFilter || '';
  var view = page._view || 'grid';
  var allArtifacts = getAllSavedArtifacts();
  var artifacts = allArtifacts;
  if (projectFilter) {
    artifacts = artifacts.filter(function(a) {
      return projectFilter === '__quick' ? !a.projectId : (a.projectId || '') === projectFilter;
    });
  }
  if (conversationFilter) artifacts = artifacts.filter(function(a) { return a.convId === conversationFilter; });
  if (filter) {
    artifacts = artifacts.filter(function(a) {
      return String(a.title || '').toLowerCase().includes(filter) ||
        String(a.type || '').toLowerCase().includes(filter) ||
        String(a.conversationTitle || '').toLowerCase().includes(filter) ||
        String(a.projectName || '').toLowerCase().includes(filter);
    });
  }
  var projectOptions = _artifactProjectFilterOptions(allArtifacts, projectFilter);
  var conversationOptions = _artifactConversationFilterOptions(allArtifacts, projectFilter, conversationFilter);
  page.innerHTML =
    '<div class="all-agents-page-inner">' +
      '<div class="all-agents-header">' +
        '<div class="all-agents-title"><i class="ti ti-layout-grid"></i> Artifacts</div>' +
        '<div class="all-agents-search-wrap"><i class="ti ti-search"></i><input class="all-agents-search" id="all-artifacts-search" placeholder="Search artifacts…" value="' + escHtml(page._filter || '') + '" oninput="updateArtifactLibraryFilter(this.value)"></div>' +
        '<div class="artifact-view-toggle"><button class="' + (view === 'grid' ? 'active' : '') + '" onclick="setArtifactLibraryView(\'grid\')" title="Grid view"><i class="ti ti-layout-grid"></i></button><button class="' + (view === 'list' ? 'active' : '') + '" onclick="setArtifactLibraryView(\'list\')" title="List view"><i class="ti ti-list"></i></button></div>' +
      '</div>' +
      '<div class="artifact-library-filters">' +
        '<label><span>Project</span><select onchange="updateArtifactLibraryProject(this.value)">' + projectOptions + '</select></label>' +
        '<label><span>Conversation</span><select onchange="updateArtifactLibraryConversation(this.value)">' + conversationOptions + '</select></label>' +
        ((projectFilter || conversationFilter || filter) ? '<button class="proj-action-btn" onclick="updateArtifactLibraryFilter(\'\');updateArtifactLibraryProject(\'\')"><i class="ti ti-x"></i> Clear</button>' : '') +
      '</div>' +
      '<div class="artifact-library ' + (view === 'list' ? 'list' : 'grid') + '">' + _renderArtifactLibraryItems(artifacts, view) + '</div>' +
    '</div>';
}

function _artifactProjectFilterOptions(artifacts, selected) {
  var counts = Object.create(null);
  artifacts.forEach(function(a) { counts[a.projectId || ''] = (counts[a.projectId || ''] || 0) + 1; });
  var projects = (state.projects || []).filter(function(p) { return counts[p.id]; }).sort(function(a, b) { return String(a.name || '').localeCompare(String(b.name || '')); });
  var html = '<option value="">All projects (' + artifacts.length + ')</option>';
  if (counts['']) html += '<option value="__quick"' + (selected === '__quick' ? ' selected' : '') + '>Quick chats (' + counts[''] + ')</option>';
  html += projects.map(function(p) {
    return '<option value="' + escHtml(p.id) + '"' + (selected === p.id ? ' selected' : '') + '>' + escHtml(p.name || 'Untitled project') + ' (' + counts[p.id] + ')</option>';
  }).join('');
  return html;
}

function _artifactConversationFilterOptions(artifacts, projectId, selected) {
  var relevant = projectId ? artifacts.filter(function(a) { return projectId === '__quick' ? !a.projectId : (a.projectId || '') === projectId; }) : artifacts;
  var byConv = Object.create(null);
  relevant.forEach(function(a) {
    if (!byConv[a.convId]) byConv[a.convId] = { id: a.convId, title: a.conversationTitle || 'Conversation', count: 0 };
    byConv[a.convId].count += 1;
  });
  var convs = Object.keys(byConv).map(function(id) { return byConv[id]; }).sort(function(a, b) { return a.title.localeCompare(b.title); });
  return '<option value="">All conversations (' + relevant.length + ')</option>' + convs.map(function(c) {
    return '<option value="' + escHtml(c.id) + '"' + (selected === c.id ? ' selected' : '') + '>' + escHtml(c.title) + ' (' + c.count + ')</option>';
  }).join('');
}

function _renderArtifactLibraryItems(artifacts, view) {
  if (!artifacts.length) return '<div class="proj-hub-empty" style="padding:40px"><i class="ti ti-layout-grid" style="font-size:28px;opacity:.3"></i><div>No artifacts found</div></div>';
  if (view === 'list') {
    var header = '<div class="artifact-library-row artifact-library-head"><span>Artifact</span><span>Project</span><span>Conversation</span><span>Updated</span><span></span></div>';
    return header + artifacts.map(function(a) {
      return '<div class="artifact-library-row">' +
        '<span class="artifact-library-name"><i class="ti ' + artifactTypeIcon(a.type) + '"></i><span><strong>' + escHtml(a.title || 'Artifact') + '</strong><small>' + escHtml(_artifactTypeLabel(a.type)) + '</small></span></span>' +
        '<span>' + (a.projectName ? '<span class="proj-dot proj-color-' + escHtml(a.projectColor || 'blue') + '"></span>' + escHtml(a.projectName) : '<span class="all-proj-dim">—</span>') + '</span>' +
        '<span class="artifact-library-muted">' + escHtml(a.conversationTitle || 'Conversation') + '</span>' +
        '<span class="artifact-library-muted">' + escHtml(_artifactRelativeTime(a.createdAt)) + '</span>' +
        '<span class="artifact-library-actions"><button class="proj-action-btn" onclick="viewArtifactFromLibrary(\'' + escHtml(a.convId) + '\',\'' + escHtml(a.id) + '\')"><i class="ti ti-eye"></i> View only</button><button class="proj-icon-btn" onclick="goToArtifactConversation(\'' + escHtml(a.convId) + '\')" title="Open conversation"><i class="ti ti-message-forward"></i></button></span>' +
      '</div>';
    }).join('');
  }
  return artifacts.map(function(a) {
    return '<article class="artifact-library-card">' +
      '<div class="artifact-library-card-top"><i class="ti ' + artifactTypeIcon(a.type) + '"></i><span>' + escHtml(_artifactTypeLabel(a.type)) + '</span></div>' +
      '<h3 title="' + escHtml(a.title || 'Artifact') + '">' + escHtml(a.title || 'Artifact') + '</h3>' +
      '<p>' + (a.projectName ? escHtml(a.projectName) + ' · ' : '') + escHtml(a.conversationTitle || 'Conversation') + '</p>' +
      '<div class="artifact-library-card-meta"><span>' + escHtml(_artifactRelativeTime(a.createdAt)) + '</span></div>' +
      '<div class="artifact-library-card-actions"><button class="proj-action-btn" onclick="viewArtifactFromLibrary(\'' + escHtml(a.convId) + '\',\'' + escHtml(a.id) + '\')"><i class="ti ti-eye"></i> View only</button><button class="proj-action-btn" onclick="goToArtifactConversation(\'' + escHtml(a.convId) + '\')"><i class="ti ti-message-forward"></i> Conversation</button></div>' +
    '</article>';
  }).join('');
}

// Per-artifact frame setting: null = no frame, 'browser-chrome' | 'iphone-15-pro' | 'android-pixel' | 'macbook'
var _artifactFrames = {};

function renderArtifactContent() {
  var body = document.getElementById('artifact-body');
  if (!body) return;
  var a = state.artifacts.find(function(x) { return x.id === state.activeArtifact; });
  if (!a) {
    body.innerHTML = '<div class="artifact-empty"><i class="ti ti-layers-intersect"></i><span>Nothing to preview</span></div>';
    return;
  }
  if (_artifactShouldHydrateFromDisk(a) && !a._hydratedFromDisk) _hydrateArtifactFromDisk(a);

  var toolbar = makeArtifactToolbar(a);
  var content = '';
  var showCode = !!state.artifactCodeView;

  if ((a.type === 'html' || a.type === 'svg' || a.type === 'design') && !showCode) {
    var doc = a.type === 'svg'
      ? '<!DOCTYPE html><html><body style="margin:0;background:#fff;display:flex;align-items:center;justify-content:center;min-height:100vh">' + a.content + '</body></html>'
      : a.content;
    var activeFrame = _artifactFrames[a.id] || null;
    if (activeFrame && a.type === 'design') {
      // Render inside device frame — load frame HTML, communicate content via postMessage
      content = '<div class="artifact-scroll artifact-frame-wrap" style="height:calc(100% - 35px);background:#1a1a1a;overflow:auto">' +
        '<iframe id="frame-host-' + a.id + '" src="/api/design/frames/' + encodeURIComponent(activeFrame) + '" style="border:none;width:100%;height:100%;min-height:600px" ' +
          'sandbox="allow-scripts allow-same-origin" ' +
          'onload="(function(el){var f=el.contentWindow;var d=' + JSON.stringify(JSON.stringify({type:'setContent',html:doc})) + ';f.postMessage(JSON.parse(d),\'*\')})(this)">' +
        '</iframe>' +
      '</div>';
    } else {
      var srcdoc = doc.replace(/&/g,'&amp;').replace(/"/g,'&quot;').replace(/'/g,'&#39;').replace(/`/g,'&#96;').replace(/\n/g,'&#10;');
      content = '<div class="artifact-scroll" style="height:calc(100% - 35px)">' +
        '<iframe srcdoc="' + srcdoc + '" sandbox="allow-scripts allow-modals allow-popups allow-forms" title="' + escHtml(a.title) + '"></iframe>' +
      '</div>';
    }

  } else if ((a.type === 'html' || a.type === 'svg' || a.type === 'design' || showCode) && a.content != null) {
    content = '<div class="artifact-scroll" style="height:calc(100% - 35px)">' +
      '<pre class="artifact-mono">' + escHtml(a.content || '') + '</pre>' +
    '</div>';

  } else if (a.type === 'image') {
    var src = a.base64 ? 'data:' + (a.mime || 'image/png') + ';base64,' + a.base64 : '';
    content = '<div class="artifact-scroll" style="height:calc(100% - 35px)">' +
      '<div class="artifact-image-wrap">' +
        (src ? '<img src="' + src + '" alt="' + escHtml(a.title) + '" id="artimg-' + a.id + '">'
             : '<div id="artimg-' + a.id + '" style="color:var(--fau-text-muted);font-size:12px">Loading…</div>') +
      '</div>' +
    '</div>';

  } else if (a.type === 'pdf' && a.path) {
    var pdfUrl = '/api/preview-file?path=' + encodeURIComponent(a.path);
    content = '<div class="artifact-scroll" style="height:calc(100% - 35px);background:#2a2a2a">' +
      '<iframe src="' + pdfUrl + '" title="' + escHtml(a.title || 'PDF') + '" style="width:100%;height:100%;border:none;background:#fff"></iframe>' +
    '</div>';

  } else if (a.type === 'docx') {
    var readOnly = a.editable === false;
    content = '<div class="artifact-scroll" style="height:calc(100% - 35px)">' +
      '<div style="padding:12px;display:flex;flex-direction:column;gap:10px;height:100%;box-sizing:border-box">' +
        '<div style="font-size:12px;color:var(--fau-text-muted)">' +
          (readOnly ? 'Previewing extracted document text. Editing is not supported for this document format in this build.' : 'Previewing extracted document text. Edit below and save back to the source document.') +
        '</div>' +
        '<textarea id="artifact-docx-editor-' + a.id + '" spellcheck="true" style="flex:1;min-height:280px;resize:none;background:var(--fau-surface2);color:var(--fau-text);border:1px solid var(--fau-border);border-radius:8px;padding:12px;font:13px/1.5 var(--mono);outline:none">' + escHtml(a.content || '') + '</textarea>' +
      '</div>' +
    '</div>';

  } else if (a.type === 'markdown' || a.type === 'summary' || a.type === 'web') {
    content = '<div class="artifact-scroll" style="height:calc(100% - 35px)">' +
      '<div class="artifact-prose msg-body" id="artifact-md-' + a.id + '">' + renderMarkdown(a.content || '') + '</div>' +
    '</div>';

  } else if (a.type === 'json') {
    var pretty = a.content;
    try { pretty = JSON.stringify(JSON.parse(a.content), null, 2); } catch (_) {}
    content = '<div class="artifact-scroll" style="height:calc(100% - 35px)">' +
      '<pre class="artifact-mono">' + escHtml(pretty) + '</pre>' +
    '</div>';

  } else if (a.type === 'csv') {
    content = '<div class="artifact-scroll" style="height:calc(100% - 35px)">' +
      '<div class="artifact-prose">' + csvToHtmlTable(a.content || '') + '</div>' +
    '</div>';

  } else if (a.type === 'files') {
    content = '<div class="artifact-scroll" style="height:calc(100% - 35px)">' +
      '<div class="artifact-files">' + renderFileList(a.content || '') + '</div>' +
    '</div>';

  } else {
    // text / code / fallback
    content = '<div class="artifact-scroll" style="height:calc(100% - 35px)">' +
      '<pre class="artifact-mono">' + escHtml(a.content || '') + '</pre>' +
    '</div>';
  }

  body.innerHTML = toolbar + content;
  
  // Initialize mermaid diagrams if this is a markdown artifact
  if ((a.type === 'markdown' || a.type === 'summary' || a.type === 'web') && typeof initMermaidInContainer === 'function') {
    var mdContainer = document.getElementById('artifact-md-' + a.id);
    if (mdContainer) {
      setTimeout(function() { initMermaidInContainer(mdContainer); }, 100);
    }
  }
}

function makeArtifactToolbar(a) {
  var btns = '';
  var showCode = !!state.artifactCodeView;

  // Visual / Code toggle for HTML, SVG, and design artifacts
  if (a.type === 'html' || a.type === 'svg' || a.type === 'design') {
    btns += '<button class="artifact-tbtn artifact-tbtn-view' + (!showCode ? ' active' : '') + '" onclick="setArtifactView(false)" title="Rendered preview"><i class="ti ti-eye"></i> Visual</button>';
    btns += '<button class="artifact-tbtn artifact-tbtn-view' + (showCode ? ' active' : '') + '" onclick="setArtifactView(true)" title="View source"><i class="ti ti-code"></i> Code</button>';
  }

  // Device frame picker for design artifacts
  if (a.type === 'design') {
    var curFrame = _artifactFrames[a.id] || '';
    var frames = [
      { id: '',               icon: 'ti-layout',          label: 'No frame' },
      { id: 'browser-chrome', icon: 'ti-browser',         label: 'Browser' },
      { id: 'macbook',        icon: 'ti-device-laptop',   label: 'MacBook' },
      { id: 'iphone-15-pro',  icon: 'ti-device-mobile',   label: 'iPhone' },
      { id: 'android-pixel',  icon: 'ti-brand-android',   label: 'Android' }
    ];
    frames.forEach(function(f) {
      btns += '<button class="artifact-tbtn' + (curFrame === f.id ? ' active' : '') + '" ' +
        'onclick="setArtifactFrame(\'' + a.id + '\',\'' + f.id + '\')" title="' + f.label + '">' +
        '<i class="ti ' + f.icon + '"></i>' +
      '</button>';
    });
    // PDF print button
    btns += '<button class="artifact-tbtn" onclick="printDesignArtifact(\'' + a.id + '\')" title="Print / Save as PDF"><i class="ti ti-printer"></i><span class="artifact-tbtn-label"> PDF</span></button>';
  }

  // Copy source code
  if (a.content != null) {
    btns += '<button class="artifact-tbtn" onclick="copyArtifact(\'' + a.id + '\')" title="Copy source code"><i class="ti ti-copy"></i><span class="artifact-tbtn-label"> Copy Code</span></button>';
  }
  // Download
  if (a.content != null) {
    var ext = (a.type === 'design') ? '.html' : a.type === 'html' ? '.html' : a.type === 'svg' ? '.svg' : a.type === 'json' ? '.json' : a.type === 'csv' ? '.csv' : a.type === 'markdown' ? '.md' : '.txt';
    var filename = (a.title || 'artifact').replace(/[^a-zA-Z0-9._-]/g, '_') + ext;
    btns += '<button class="artifact-tbtn" onclick="downloadArtifact(\'' + a.id + '\',\'' + escHtml(filename) + '\')" title="Download file"><i class="ti ti-download"></i><span class="artifact-tbtn-label"> Download</span></button>';
  }
  // Open externally in default browser
  if (a.type === 'html' || a.type === 'svg' || a.type === 'design') {
    btns += '<button class="artifact-tbtn" onclick="openArtifactExternal(\'' + a.id + '\')" title="Open in browser"><i class="ti ti-external-link"></i><span class="artifact-tbtn-label"> Open</span></button>';
  }
  if ((a.type === 'image') && a.path) {
    btns += '<button class="artifact-tbtn" onclick="openFileInFinder(\'' + a.path + '\')" title="Reveal in Finder"><i class="ti ti-folder"></i><span class="artifact-tbtn-label"> Reveal</span></button>';
  }
  if (a.type === 'pdf' && a.path) {
    btns += '<button class="artifact-tbtn" onclick="openFilePath(\'' + a.path + '\')" title="Open file"><i class="ti ti-external-link"></i><span class="artifact-tbtn-label"> Open</span></button>';
    btns += '<button class="artifact-tbtn" onclick="openFileInFinder(\'' + a.path + '\')" title="Reveal in Finder"><i class="ti ti-folder"></i><span class="artifact-tbtn-label"> Reveal</span></button>';
  }
  if (a.type === 'docx' && a.path) {
    if (a.editable !== false) {
      btns += '<button class="artifact-tbtn" onclick="saveDocxArtifact(\'' + a.id + '\')" title="Save changes back to document"><i class="ti ti-device-floppy"></i><span class="artifact-tbtn-label"> Save</span></button>';
    }
    btns += '<button class="artifact-tbtn" onclick="openFilePath(\'' + a.path + '\')" title="Open file"><i class="ti ti-external-link"></i><span class="artifact-tbtn-label"> Open</span></button>';
    btns += '<button class="artifact-tbtn" onclick="openFileInFinder(\'' + a.path + '\')" title="Reveal in Finder"><i class="ti ti-folder"></i><span class="artifact-tbtn-label"> Reveal</span></button>';
  }
  if (a.url && /^https?:\/\//i.test(a.url)) {
    btns += '<button class="artifact-tbtn" onclick="window.open(\'' + escHtml(a.url) + '\',\'_blank\')" title="Open URL"><i class="ti ti-external-link"></i><span class="artifact-tbtn-label"> Open</span></button>';
  }
  // Save to active project
  if (state.activeProjectId && a.content != null) {
    btns += '<button class="artifact-tbtn proj-save-btn" onclick="saveArtifactToProject(\'' + escHtml(a.id) + '\')" title="Save to project"><i class="ti ti-folder-plus"></i><span class="artifact-tbtn-label"> Save to Project</span></button>';
  }
  return '<div class="artifact-toolbar">' +
    '<span class="artifact-toolbar-label">' + escHtml(a.title || 'Artifact') + '</span>' +
    btns +
  '</div>';
}

function setArtifactFrame(id, frameId) {
  _artifactFrames[id] = frameId;
  if (state.activeArtifact === id) renderArtifactContent();
}

function printDesignArtifact(id) {
  var a = state.artifacts.find(function(x) { return x.id === id; });
  if (!a || !a.content) return;
  var win = window.open('', '_blank');
  if (!win) return;
  win.document.write(a.content);
  win.document.close();
  win.focus();
  setTimeout(function() { win.print(); }, 500);
}

function setArtifactView(codeMode) {
  state.artifactCodeView = codeMode;
  renderArtifactContent();
}

function copyArtifact(id) {
  var a = state.artifacts.find(function(x) { return x.id === id; });
  if (a && a.content != null) navigator.clipboard.writeText(a.content).catch(function() {});
}

function downloadArtifact(id, filename) {
  var a = state.artifacts.find(function(x) { return x.id === id; });
  if (!a || a.content == null) return;
  var blob = new Blob([a.content], { type: 'text/plain' });
  var url  = URL.createObjectURL(blob);
  var link = document.createElement('a');
  link.href = url; link.download = filename;
  document.body.appendChild(link); link.click();
  document.body.removeChild(link); URL.revokeObjectURL(url);
}

function openArtifactExternal(id) {
  var a = state.artifacts.find(function(x) { return x.id === id; });
  if (!a) return;
  if (a.type === 'html' || a.type === 'svg') {
    // Write to a temp file via the API, then open with the OS default browser.
    // Using Blob + window.open doesn't work in Electron (blob: URLs are blocked by shell.openExternal).
    var isWin = navigator.userAgent.includes('Windows');
    var ext = a.type === 'svg' ? '.svg' : '.html';
    var tmpPath = isWin
      ? 'C:\\Users\\Public\\fauna-artifact-' + a.id + ext
      : '/tmp/fauna-artifact-' + a.id + ext;
    var openCmd = isWin ? 'start "" "' + tmpPath + '"' : 'open ' + JSON.stringify(tmpPath);
    fetch('/api/write-file', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: tmpPath, content: a.content })
    }).then(function() {
      fetch('/api/shell-exec', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ command: openCmd })
      });
    }).catch(function(e) { console.error('openArtifactExternal:', e); });
  }
}

function openFileInFinder(path) {
  fetch('/api/shell-exec', { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ command: 'open -R ' + JSON.stringify(path) }) }).catch(function(){});
}

function openFilePath(path) {
  fetch('/api/shell-exec', { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ command: 'open ' + JSON.stringify(path) }) }).catch(function(){});
}

async function saveDocxArtifact(id) {
  var a = state.artifacts.find(function(x) { return x.id === id; });
  if (!a || !a.path) return;
  var editor = document.getElementById('artifact-docx-editor-' + id);
  if (!editor) return;
  var nextContent = editor.value;
  try {
    var r = await fetch('/api/write-document-text', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: a.path, content: nextContent })
    });
    var d = await r.json();
    if (!r.ok || !d.ok) throw new Error((d && d.error) || 'Failed to save document');
    a.content = nextContent;
    saveConversations();
    showToast('Document saved');
  } catch (e) {
    showToast('Save failed: ' + e.message);
  }
}

async function fetchArtifactImage(id, path) {
  try {
    var r = await fetch('/api/read-image?path=' + encodeURIComponent(path));
    if (!r.ok) return;
    var d = await r.json();
    var a = state.artifacts.find(function(x) { return x.id === id; });
    if (a) { a.base64 = d.base64; a.mime = d.mime; }
    // Update DOM if currently displayed
    var el = document.getElementById('artimg-' + id);
    if (el) {
      var img = document.createElement('img');
      img.src = 'data:' + d.mime + ';base64,' + d.base64;
      img.alt = path;
      img.style.cssText = 'max-width:100%;max-height:65vh;object-fit:contain;border-radius:6px;box-shadow:0 4px 20px rgba(0,0,0,.4)';
      el.parentNode.replaceChild(img, el);
    }
  } catch (_) {}
}

function csvToHtmlTable(csv) {
  var lines = csv.trim().split('\n');
  if (!lines.length) return '';
  var headers = lines[0].split(',').map(function(h) { return '<th>' + escHtml(h.trim()) + '</th>'; }).join('');
  var rows = lines.slice(1).map(function(row) {
    return '<tr>' + row.split(',').map(function(c) { return '<td>' + escHtml(c.trim()) + '</td>'; }).join('') + '</tr>';
  }).join('');
  return '<table><thead><tr>' + headers + '</tr></thead><tbody>' + rows + '</tbody></table>';
}

function renderFileList(text) {
  return text.trim().split('\n').filter(Boolean).map(function(line) {
    line = line.trim();
    var isDir = line.endsWith('/');
    var name  = line.split('/').pop() || line;
    var icon  = isDir ? 'ti-folder' : fileIcon(name);
    var canPreview = isLikelyArtifactPath(line);
    return '<div class="artifact-file-row' + (canPreview ? '' : ' artifact-file-row-disabled') + '"' +
      (canPreview ? ' onclick="previewFilePath(' + JSON.stringify(line) + ')"' : '') +
      ' title="' + escHtml(canPreview ? line : 'Not a previewable file path: ' + line) + '">' +
      '<i class="ti ' + icon + '"></i>' +
      '<span class="artifact-file-path">' + escHtml(line) + '</span>' +
    '</div>';
  }).join('');
}

function isLikelyArtifactPath(line) {
  var value = String(line || '').trim();
  if (!value) return false;
  if (/^[0-9]+:?$/.test(value)) return false;
  if (/^[0-9]+:\s*$/.test(value)) return false;
  if (/^[A-Za-z]+:$/.test(value)) return false;
  if (/^[A-Za-z][A-Za-z\s-]{1,40}:$/.test(value)) return false;
  if (/^(developer|assistant|user|system)$/i.test(value)) return false;
  if (/^[*-]\s+/.test(value)) value = value.replace(/^[*-]\s+/, '');
  if (/^\d+[.)]\s+/.test(value)) value = value.replace(/^\d+[.)]\s+/, '');
  if (/^(https?:|data:|blob:)/i.test(value)) return false;
  if (/^[~./]/.test(value)) return true;
  if (/^[A-Za-z]:[\\/]/.test(value)) return true;
  if (/[\\/]/.test(value)) return true;
  if (/\.[A-Za-z0-9]{1,8}$/.test(value)) return true;
  return false;
}

function fileIcon(name) {
  var ext = (name.split('.').pop() || '').toLowerCase();
  var m = { js:'ti-brand-javascript', ts:'ti-brand-typescript', jsx:'ti-brand-react', tsx:'ti-brand-react',
            py:'ti-brand-python', html:'ti-brand-html5', css:'ti-palette', json:'ti-braces',
            md:'ti-markdown', txt:'ti-file-text', png:'ti-photo', jpg:'ti-photo',
            jpeg:'ti-photo', gif:'ti-photo', svg:'ti-vector', pdf:'ti-file-type-pdf',
            sh:'ti-terminal', csv:'ti-table', xml:'ti-code', yaml:'ti-file', yml:'ti-file' };
  return m[ext] || 'ti-file';
}

async function previewFilePath(filePath) {
  if (!isLikelyArtifactPath(filePath)) return;
  var ext = (filePath.split('.').pop() || '').toLowerCase();
  if (['png','jpg','jpeg','gif','webp'].includes(ext)) {
    openArtifact(addArtifact({ type: 'image', title: filePath.split('/').pop(), path: filePath }));
    return;
  }
  if (ext === 'pdf') {
    openArtifact(addArtifact({ type: 'pdf', title: filePath.split('/').pop(), path: filePath }));
    return;
  }
  if (['doc','docx','rtf','odt','pages'].includes(ext)) {
    try {
      var docRes = await fetch('/api/extract-document', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path: filePath })
      });
      var docData = await docRes.json();
      if (!docRes.ok || !docData.ok) throw new Error((docData && docData.error) || 'Failed to preview document');
      openArtifact(addArtifact({ type: 'docx', title: filePath.split('/').pop(), path: docData.path || filePath, content: docData.content || '', editable: docData.editable !== false }));
    } catch (_) {}
    return;
  }
  try {
    var r = await fetch('/api/shell-exec', { method:'POST', headers:{'Content-Type':'application/json'},
      body: JSON.stringify({ command: 'cat ' + JSON.stringify(filePath) + ' 2>/dev/null | head -500' }) });
    var d = await r.json();
    if (d.stdout) {
      var type = ['md','markdown'].includes(ext) ? 'markdown'
               : ext === 'json' ? 'json'
               : ext === 'csv'  ? 'csv'
               : ['html','htm'].includes(ext) ? 'html'
               : 'text';
      openArtifact(addArtifact({ type: type, title: filePath.split('/').pop(), path: filePath, content: d.stdout }));
    }
  } catch (_) {}
}

// Called from code-block Preview buttons
function previewCodeBlock(codeId, lang) {
  var raw = _codePreviewRegistry[codeId];
  if (raw == null) return;
  var typeMap = { html:'html', svg:'svg', markdown:'markdown', md:'markdown',
                  json:'json', csv:'csv', javascript:'code', python:'code' };
  var type  = typeMap[lang] || 'text';
  var title = lang.toUpperCase() + ' Preview';
  var id = addArtifact({ type: type, title: title, content: raw });
  openArtifact(id); // explicit user click → open immediately
}

// Extract ```artifact:TYPE blocks that AI can emit directly
// injectCards=false when called from appendMessageDOM (history load — cards injected from restored state.artifacts)
//
// Parsing strategy: line-based scanner that balances inner code fences.
// If the outer artifact fence is exactly 3 backticks and the artifact
// contains a ```mermaid / ```code block inside, naïve regex would close
// at the inner fence. We track inner-fence open/close state when the outer
// fence is 3, and require >= fenceLen backticks for closing when 4+.
function _scanArtifactBlocks(buffer) {
  var lines = buffer.split('\n');
  var out = [];
  var i = 0;
  while (i < lines.length) {
    var openMatch = lines[i].match(/^(`{3,})artifact:(.+?)\s*$/);
    if (!openMatch) { i++; continue; }
    var fenceLen = openMatch[1].length;
    var spec = openMatch[2].trim();
    var content = [];
    var innerOpen = false;
    var closed = false;
    var j = i + 1;
    for (; j < lines.length; j++) {
      var l = lines[j];
      var fence = l.match(/^(`{3,})(\S*)\s*$/);
      if (!fence) { content.push(l); continue; }
      var thisLen = fence[1].length;
      var hasLang = !!fence[2];
      if (fenceLen >= 4) {
        if (thisLen >= fenceLen && !hasLang) { closed = true; break; }
        content.push(l);
      } else {
        if (innerOpen) {
          if (!hasLang && thisLen === 3) { innerOpen = false; content.push(l); continue; }
          content.push(l);
        } else {
          if (hasLang) { innerOpen = true; content.push(l); }
          else if (thisLen === 3) { closed = true; break; }
          else { content.push(l); }
        }
      }
    }
    out.push({ spec: spec, content: content.join('\n'), unterminated: !closed });
    i = closed ? j + 1 : lines.length;
  }
  return out;
}

function extractArtifactsFromBuffer(buffer, msgEl, injectCards) {
  if (injectCards === undefined) injectCards = true;
  var container = msgEl ? (msgEl.querySelector('.msg-body') || msgEl) : null;
  var blocks = _scanArtifactBlocks(buffer);
  for (var b = 0; b < blocks.length; b++) {
    var spec    = blocks[b].spec;
    var content = blocks[b].content;
    var parts   = spec.split(':');
    var type    = parts[0];
    var title   = parts.slice(1).join(':') || type;
    var id;

    if (injectCards) {
      // Live stream end — create artifact and inject card
      if (type === 'image') {
        id = addArtifact({ type: 'image', title: title, path: title });
      } else if (type === 'html') {
        id = addArtifact({ type: 'html', title: title || 'HTML Preview', content: content });
      } else if (type === 'markdown' || type === 'md') {
        id = addArtifact({ type: 'markdown', title: title || 'Document', content: content });
      } else if (type === 'json') {
        id = addArtifact({ type: 'json', title: title || 'JSON', content: content });
      } else if (type === 'csv') {
        id = addArtifact({ type: 'csv', title: title || 'Data', content: content });
      } else if (type === 'files') {
        id = addArtifact({ type: 'files', title: title || 'Files', content: content });
      } else if (type === 'summary') {
        id = addArtifact({ type: 'summary', title: title || 'Summary', content: content });
      } else {
        id = addArtifact({ type: 'text', title: title || 'Output', content: content });
      }
      if (id && container) injectArtifactCard(id, container);
    } else {
      // History load — artifacts already restored into state.artifacts; just inject the card
      var existing = state.artifacts.find(function(a) {
        return a.type === type && (a.title === title || a.title === (title || type));
      });
      if (existing && container) injectArtifactCard(existing.id, container);
    }
  }
}

// Auto-detect artifacts from shell stdout (file listings, JSON output, etc.)
function detectShellArtifacts(command, stdout, containerEl) {
  if (!stdout || stdout.trim().length < 100) return;
  var cmd = command.trim();

  // Only explicit file-listing commands with meaningful output
  if (/^find\s+\S+.*-(?:type\s+f|name\b)/i.test(cmd) || /^ls\s+-[la]{2,}/i.test(cmd)) {
    var lines = stdout.trim().split('\n').filter(Boolean);
    if (lines.length >= 6) {
      var id = addArtifact({ type: 'files', title: 'Files', content: stdout.trim() });
      if (id && containerEl) injectArtifactCard(id, containerEl);
    }
    return;
  }

  // JSON: only rich nested objects
  var trimmed = stdout.trim();
  if (trimmed.length > 300 && (trimmed.startsWith('{') || trimmed.startsWith('['))) {
    try {
      var parsed = JSON.parse(trimmed);
      var depth = JSON.stringify(parsed).split('{').length - 1 + JSON.stringify(parsed).split('[').length - 1;
      if (depth >= 4) {
        var id = addArtifact({ type: 'json', title: 'JSON Output', content: trimmed });
        if (id && containerEl) injectArtifactCard(id, containerEl);
      }
    } catch (_) {}
  }
}

