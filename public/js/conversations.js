// ── Conversations ─────────────────────────────────────────────────────────

function saveConversations() {
  // Strip transient runtime fields before persisting
  var toSave = state.conversations.map(function(conv) {
    var c = {};
    Object.keys(conv).forEach(function(k) { if (k[0] !== '_') c[k] = conv[k]; });
    return c;
  });
  localStorage.setItem('fauna-convs', JSON.stringify(toSave));
  // Sync current conversation to server (fire-and-forget)
  _syncConvToServer(state.currentId);
}

// Debounced per-conversation server sync
var _syncTimers = {};
function _syncConvToServer(id) {
  if (!id) return;
  clearTimeout(_syncTimers[id]);
  _syncTimers[id] = setTimeout(function() {
    _flushConvToServer(id);
  }, 500);
}

function _flushConvToServer(id) {
  var conv = getConv(id);
  if (!conv) return;
  var c = {};
  Object.keys(conv).forEach(function(k) { if (k[0] !== '_') c[k] = conv[k]; });
  fetch('/api/conversations/' + id, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(c) }).catch(function() {});
}

// Flush pending syncs immediately (called on beforeunload)
function _flushAllPendingSyncs() {
  Object.keys(_syncTimers).forEach(function(id) {
    clearTimeout(_syncTimers[id]);
    delete _syncTimers[id];
    _flushConvToServer(id);
  });
  // Also sync current conversation directly
  if (state.currentId) _flushConvToServer(state.currentId);
}
window.addEventListener('beforeunload', _flushAllPendingSyncs);

// Sync ALL conversations to server (used on init/migration)
function _syncAllConvsToServer() {
  state.conversations.forEach(function(conv) {
    var c = {};
    Object.keys(conv).forEach(function(k) { if (k[0] !== '_') c[k] = conv[k]; });
    fetch('/api/conversations/' + conv.id, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(c) }).catch(function() {});
  });
}

function getConv(id) {
  return state.conversations.find(c => c.id === id);
}

function newConversation() {
  var id = 'c' + Date.now();
  var conv = { id, title: 'New conversation', messages: [], model: state.model, systemPrompt: state.systemPrompt, createdAt: Date.now() };
  if (state.activeProjectId) conv.projectId = state.activeProjectId;
  state.conversations.unshift(conv);
  saveConversations();
  // Notify backend about the link
  if (state.activeProjectId) {
    fetch('/api/projects/' + state.activeProjectId + '/conversations', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ convId: id }) }).catch(function(){});
  }
  loadConversation(id);
  // Clear agents — only pinned agents auto-populate in new chats
  if (typeof resetAgentChipsToPinned === 'function') resetAgentChipsToPinned();
  renderConvList();
  document.getElementById('msg-input').focus();
}

// Map of convId → <div> holding that conversation's message elements (kept alive for background execution)
var _convDomCache = {};

function getConvInner(id) {
  var inner = document.getElementById('messages-inner');
  if (!_convDomCache[id] || !inner.contains(_convDomCache[id])) {
    var div = document.createElement('div');
    div.dataset.convMessages = id;
    div.style.display = 'none';
    inner.appendChild(div);
    _convDomCache[id] = div;
  }
  return _convDomCache[id];
}

function showConvDom(id) {
  // Hide all conv containers, show the target one
  var inner = document.getElementById('messages-inner');
  Array.from(inner.children).forEach(function(c) { c.style.display = 'none'; });
  var target = getConvInner(id);
  target.style.display = 'contents';
  return target;
}

function purgeConvDom(id) {
  if (_convDomCache[id]) {
    _convDomCache[id].remove();
    delete _convDomCache[id];
  }
}

function loadConversation(id) {
  // Save outgoing conversation's agent state before switching
  if (state.currentId && state.currentId !== id) {
    var outgoing = getConv(state.currentId);
    if (outgoing && typeof _agentChips !== 'undefined') {
      outgoing.activeAgentChips = _agentChips.slice();
    }
  }

  state.currentId = id;
  _promptHistIdx = -1;
  _promptHistDraft = '';
  var conv = getConv(id);
  if (!conv) return;

  // Move to top of list so it appears as the most recent
  var idx = state.conversations.indexOf(conv);
  if (idx > 0) {
    state.conversations.splice(idx, 1);
    state.conversations.unshift(conv);
    saveConversations();
  }

  state.model  = conv.model || state.model;
  document.getElementById('model-select').value = state.model;
  document.getElementById('sys-prompt-input').value = conv.systemPrompt || '';
  updateSysScopeHint();
  document.getElementById('topbar-title').textContent = conv.title;

  // Switch browser pane to this conversation's tabs
  _showConvBrowserTabs(id);

  // Show this conv's DOM (keeping all others alive in background)
  var convInner = showConvDom(id);
  if (typeof syncShellRunningPills === 'function') syncShellRunningPills();

  // Restore artifacts BEFORE rendering messages so history load can inject cards
  if (typeof pruneStaleArtifacts === 'function') pruneStaleArtifacts(conv);
  state.artifacts = (conv.artifacts || []).map(function(a) { return Object.assign({}, a); });
  state.activeArtifact = null;
  state.artifacts.forEach(function(a) {
    if (a.type === 'image' && a.path && !a.base64) fetchArtifactImage(a.id, a.path);
  });
  renderArtifactTabs();

  // Only populate DOM if it's empty (first load); don't re-render if already built
  if (!convInner.hasChildNodes()) {
    conv.messages.forEach(m => {
      if (m._compositionHandoff) return; // skip internal handoff messages
      if (m._isBrowserFeed) {
        var feedNote = document.createElement('div');
        feedNote.className = 'msg system-msg';
        feedNote.innerHTML = '<div class="msg-body" style="display:flex;align-items:center;gap:5px;font-size:11px">' +
          '<i class="ti ti-world-www" style="font-size:12px;opacity:.5"></i>' +
          '<span>Browser page fed to AI</span>' +
        '</div>';
        convInner.appendChild(feedNote);
        return;
      }
      if (m._isAutoFeed) {
        var autoNote = document.createElement('div');
        autoNote.className = 'msg system-msg';
        autoNote.innerHTML = '<div class="msg-body" style="display:flex;align-items:center;gap:5px;font-size:11px">' +
          '<i class="ti ti-terminal-2" style="font-size:12px;opacity:.5"></i>' +
          '<span>Shell output fed to AI</span>' +
        '</div>';
        convInner.appendChild(autoNote);
        return;
      }
      appendMessageDOM(m.role, m.content, m.attachments, false, m.agentInfo || null, m._isHTML || false);
    });
  }

  if (conv.messages.length) showMessages();
  else showEmpty();

  // Reflect this conversation's streaming state in UI
  setBusy(!!conv._streaming);

  // Restore agent chips for this conversation (or fall back to pinned)
  if (typeof resetAgentChipsToPinned === 'function') {
    if (conv.activeAgentChips && conv.activeAgentChips.length > 0) {
      // Restore exactly the chips that were active when the user last used this conversation
      if (typeof _restoreAgentChips === 'function') _restoreAgentChips(conv.activeAgentChips, conv);
      else resetAgentChipsToPinned();
    } else if (conv.activeAgentChips && conv.activeAgentChips.length === 0) {
      // Explicitly cleared — no agent
      if (typeof _restoreAgentChips === 'function') _restoreAgentChips([], conv);
      else resetAgentChipsToPinned();
    } else {
      // Never had chips saved — treat as pinned default (new/old conv)
      resetAgentChipsToPinned();
    }
  }

  renderConvList();
  scrollBottom();
  if (typeof _updateMoveToProjectBtn === 'function') _updateMoveToProjectBtn();
}

function clearConversation() {
  var conv = getConv(state.currentId);
  if (!conv) return;
  conv.messages = [];
  conv.title = 'New conversation';
  document.getElementById('topbar-title').textContent = conv.title;
  purgeConvDom(state.currentId);
  showConvDom(state.currentId);
  saveConversations();
  showEmpty();
}

function deleteConversation(id, e) {
  e.stopPropagation();
  _destroyConvBrowserTabs(id);
  if (typeof clearShellRunningPillsForConversation === 'function') clearShellRunningPillsForConversation(id);
  state.conversations = state.conversations.filter(c => c.id !== id);
  saveConversations();
  fetch('/api/conversations/' + id, { method: 'DELETE' }).catch(function() {});
  if (state.currentId === id) {
    purgeConvDom(id);
    if (state.conversations.length) loadConversation(state.conversations[0].id);
    else { state.currentId = null; showEmpty(); document.getElementById('messages-inner').innerHTML = ''; closeBrowserPane(); }
  } else {
    purgeConvDom(id);
  }
  renderConvList();
}

function renderConvList() {
  var list = document.getElementById('conv-list');
  list.innerHTML = '';
  var MAX_VISIBLE = 5;
  var convs = state.conversations;
  if (state.activeProjectId) {
    // Project active: show only that project's conversations
    convs = convs.filter(function(c) { return c.projectId === state.activeProjectId; });
  } else {
    // No project active: hide all project-linked conversations — they live in the project
    convs = convs.filter(function(c) { return !c.projectId; });
  }
  var visible = convs.slice(0, MAX_VISIBLE);
  visible.forEach(conv => {
    var d = document.createElement('div');
    d.className = 'conv-item' + (conv.id === state.currentId ? ' active' : '');
    d.onclick = () => loadConversation(conv.id);
    d.innerHTML = (conv._streaming ? '<i class="ti ti-loader-2 conv-streaming-icon"></i>' : '') +
      '<span class="conv-label">' + escHtml(conv.title) + '</span>' +
      '<button class="conv-del" onclick="deleteConversation(\'' + conv.id + '\', event)"><i class="ti ti-trash"></i></button>';
    list.appendChild(d);
  });
  var showAll = document.getElementById('conv-show-all');
  if (showAll) showAll.style.display = convs.length > MAX_VISIBLE ? '' : 'none';
}

function openAllConversations() {
  var page = document.getElementById('all-convs-page');
  if (!page) return;
  page._filter = '';
  page.innerHTML = '';
  page.style.display = 'flex';
  renderAllConvsPage();
}

function closeAllConversations() {
  var page = document.getElementById('all-convs-page');
  if (page) page.style.display = 'none';
}

function renderAllConvsPage() {
  var page = document.getElementById('all-convs-page');
  if (!page) return;
  var filter = page._filter || '';
  var convs = state.conversations;
  if (filter) {
    var f = filter.toLowerCase();
    convs = convs.filter(function(c) { return c.title.toLowerCase().includes(f); });
  }

  // If the page is already built, only update the list body
  var listEl = document.getElementById('all-convs-list-body');
  if (!listEl) {
    // First render — build full structure
    var html = '<div class="all-agents-header">' +
      '<div class="all-agents-title"><i class="ti ti-messages"></i> All Conversations</div>' +
      '<div class="all-agents-search-wrap">' +
        '<i class="ti ti-search"></i>' +
        '<input class="all-agents-search" id="all-convs-search" placeholder="Search conversations\u2026" value="' + escHtml(filter) + '" oninput="document.getElementById(\'all-convs-page\')._filter=this.value;renderAllConvsPage()">' +
      '</div>' +
      '<button class="builder-btn primary small" onclick="closeAllConversations();newConversation()"><i class="ti ti-plus"></i> New</button>' +
      '<button class="all-agents-close" onclick="closeAllConversations()"><i class="ti ti-x"></i></button>' +
    '</div>';
    html += '<div class="all-agents-body"><div id="all-convs-list-body" class="all-convs-list"></div></div>';
    page.innerHTML = html;
    listEl = document.getElementById('all-convs-list-body');
  }

  // Render just the list items
  var items = '';
  for (var i = 0; i < convs.length; i++) {
    var c = convs[i];
    var isActive = c.id === state.currentId;
    items += '<div class="all-convs-item' + (isActive ? ' active' : '') + '" onclick="closeAllConversations();loadConversation(\'' + c.id + '\')">'+
      '<i class="ti ti-message"></i>' +
      '<span class="all-convs-title">' + escHtml(c.title) + '</span>' +
      '<span class="all-convs-date">' + (c.createdAt ? new Date(c.createdAt).toLocaleDateString() : '') + '</span>' +
      '<button class="all-convs-del" onclick="event.stopPropagation();deleteConversation(\'' + c.id + '\', event);renderAllConvsPage()"><i class="ti ti-trash"></i></button>' +
    '</div>';
  }
  if (!convs.length) {
    items = '<div class="store-empty"><i class="ti ti-messages-off"></i><p>No conversations found</p></div>';
  }
  listEl.innerHTML = items;
}

function toggleSidebarSection(section) {
  var bodyMap = { conv: 'conv-section-body', agents: 'agents-section-body', projects: 'projects-section-body' };
  var headerMap = { conv: 'conv-section-header', agents: 'agents-section-header', projects: 'projects-section-header' };
  var body = document.getElementById(bodyMap[section]);
  if (!body) return;
  var isHidden = body.style.display === 'none';
  body.style.display = isHidden ? '' : 'none';
  var header = document.getElementById(headerMap[section]);
  if (header) {
    var chevron = header.querySelector('.section-chevron');
    if (chevron) {
      chevron.classList.toggle('ti-chevron-down', isHidden);
      chevron.classList.toggle('ti-chevron-right', !isHidden);
    }
  }
}
