// ── Conversations ─────────────────────────────────────────────────────────

function saveConversations() {
  // Strip transient runtime fields before persisting
  var toSave = state.conversations.map(function(conv) {
    var c = {};
    Object.keys(conv).forEach(function(k) { if (k[0] !== '_') c[k] = conv[k]; });
    return c;
  });
  localStorage.setItem('fauna-convs', JSON.stringify(toSave));
}

function getConv(id) {
  return state.conversations.find(c => c.id === id);
}

function newConversation() {
  var id = 'c' + Date.now();
  var conv = { id, title: 'New conversation', messages: [], model: state.model, systemPrompt: state.systemPrompt, createdAt: Date.now() };
  state.conversations.unshift(conv);
  saveConversations();
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

  // Restore artifacts BEFORE rendering messages so history load can inject cards
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
  state.conversations = state.conversations.filter(c => c.id !== id);
  saveConversations();
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
  var visible = convs.slice(0, MAX_VISIBLE);
  visible.forEach(conv => {
    var d = document.createElement('div');
    d.className = 'conv-item' + (conv.id === state.currentId ? ' active' : '');
    d.onclick = () => loadConversation(conv.id);
    d.innerHTML = (conv._streaming ? '<i class="ti ti-loader-2 conv-streaming-icon"></i>' : '') +
      '<span class="conv-label">' + escHtml(conv.title) + '</span>' +
      '<button class="conv-del" onclick="deleteConversation(\'' + conv.id + '\', event)"><i class="ti ti-x"></i></button>';
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
  var bodyId = section === 'conv' ? 'conv-section-body' : 'agents-section-body';
  var body = document.getElementById(bodyId);
  if (!body) return;
  var isHidden = body.style.display === 'none';
  body.style.display = isHidden ? '' : 'none';
  // Toggle chevron on the clicked icon
  var headerId = section === 'conv' ? 'conv-section-header' : 'agents-section-header';
  var header = document.getElementById(headerId);
  if (header) {
    var chevron = header.querySelector('.section-chevron');
    if (chevron) {
      chevron.classList.toggle('ti-chevron-down', isHidden);
      chevron.classList.toggle('ti-chevron-right', !isHidden);
    }
  }
}
