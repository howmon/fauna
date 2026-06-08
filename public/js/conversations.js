// ── Conversations ─────────────────────────────────────────────────────────

// Bump a conversation to the top of the list (only call when real activity occurs)
function bumpConvToTop(id) {
  var conv = getConv(id);
  if (!conv) return;
  var idx = state.conversations.indexOf(conv);
  if (idx > 0) {
    state.conversations.splice(idx, 1);
    state.conversations.unshift(conv);
  }
}

function _trimStoredText(value, maxLen) {
  if (typeof value !== 'string') return value;
  if (value.length <= maxLen) return value;
  return value.slice(0, maxLen) + '\n…[truncated for local cache]';
}

// Fence-aware trim for message content. Special fenced blocks (gen-ui specs,
// artifacts, etc.) are re-parsed when a conversation is reopened, so cutting
// in the middle of one corrupts it — e.g. a gen-ui JSON spec truncated at the
// raw char limit throws "Expected property name or '}'" on reload. We trim at
// a point that never falls inside a fenced block: if the cut lands inside a
// fence, we extend past its closing delimiter so the block survives whole.
function _trimStoredMessageContent(value, maxLen) {
  if (typeof value !== 'string') return value;
  if (value.length <= maxLen) return value;
  var cut = maxLen;
  var fenceRe = /(^|\n)(```|~~~)[^\n]*\n[\s\S]*?\n\2[ \t]*(?=\n|$)/g;
  var m;
  while ((m = fenceRe.exec(value)) !== null) {
    var start = m.index + (m[1] ? m[1].length : 0);
    var end = m.index + m[0].length;
    if (start >= cut) break;            // fence begins after the cut — safe
    if (end > cut) { cut = end; break; } // cut lands inside fence — keep it whole
  }
  if (cut >= value.length) return value;
  return value.slice(0, cut) + '\n…[truncated for local cache]';
}

function _sanitizeStoredMessage(msg, opts) {
  opts = opts || {};
  var keepAttachments = !!opts.keepAttachments;
  var copy = {};
  Object.keys(msg || {}).forEach(function(k) {
    if (k[0] !== '_') copy[k] = msg[k];
  });

  if (Array.isArray(copy.content)) {
    copy.content = copy.content
      .filter(function(part) { return part && part.type === 'text'; })
      .map(function(part) { return part.text; })
      .join('\n');
  }
  copy.content = _trimStoredMessageContent(typeof copy.content === 'string' ? copy.content : JSON.stringify(copy.content || ''), 12000);

  if (typeof msg._displayText === 'string') {
    copy._displayText = _trimStoredText(msg._displayText, 6000);
  }

  if (Array.isArray(copy.images) && copy.images.length) {
    copy.images = copy.images.map(function(img) {
      return {
        name: img && img.name,
        mime: img && img.mime,
        omitted: true
      };
    });
  }

  if (Array.isArray(copy.attachments) && copy.attachments.length) {
    copy.attachments = copy.attachments.map(function(att) {
      var next = {
        type: att && att.type,
        name: att && att.name,
        sourceUri: att && att.sourceUri,
        extSource: att && att.extSource,
        browser: att && att.browser,
        tabId: att && att.tabId,
        clientId: att && att.clientId,
        size: att && att.size,
        warning: att && att.warning,
        mime: att && att.mime
      };
      if (keepAttachments && att && typeof att.content === 'string') next.content = _trimStoredText(att.content, 4000);
      return next;
    });
  }

  return copy;
}

function _serializeConversationForStorage(conv, opts) {
  opts = opts || {};
  var copy = {};
  Object.keys(conv || {}).forEach(function(k) {
    if (k[0] !== '_') copy[k] = conv[k];
  });

  var recentLimit = opts.recentLimit || 24;
  var archiveLimit = opts.archiveLimit || 40;
  copy.messages = (conv.messages || []).slice(-recentLimit).map(function(msg) {
    return _sanitizeStoredMessage(msg, { keepAttachments: !!opts.keepAttachments });
  });

  if (Array.isArray(conv.archivedMessages) && conv.archivedMessages.length) {
    copy.archivedMessages = conv.archivedMessages.slice(-archiveLimit).map(function(msg) {
      return _sanitizeStoredMessage(msg, { keepAttachments: false });
    });
  }

  if (Array.isArray(conv.artifacts) && conv.artifacts.length) {
    copy.artifacts = conv.artifacts.slice(-10).map(function(artifact) {
      var stored = Object.assign({}, artifact);
      if (stored.base64) delete stored.base64;
      if (typeof stored.content === 'string') stored.content = _trimStoredText(stored.content, 12000);
      return stored;
    });
  }

  if (typeof copy.contextSummary === 'string') copy.contextSummary = _trimStoredText(copy.contextSummary, 12000);
  if (typeof copy.systemPrompt === 'string') copy.systemPrompt = _trimStoredText(copy.systemPrompt, 12000);
  return copy;
}

function _serializeConversationForServer(conv) {
  return _serializeConversationForStorage(conv, {
    recentLimit: 60,
    archiveLimit: 120,
    keepAttachments: true
  });
}

function saveConversations() {
  // IndexedDB mode delegates to the cache module: slim index in localStorage
  // (sync), bodies in IDB (async). Falls through silently in legacy mode.
  if (window.FaunaConvCache && window.FaunaConvCache.getMode() === 'indexeddb') {
    try {
      window.FaunaConvCache.saveAll(state.conversations, _serializeConversationForStorage);
      _syncConvToServer(state.currentId);
      return;
    } catch (_) { /* fall through to legacy path on any failure */ }
  }

  var storageModes = [
    { recentLimit: 24, archiveLimit: 40, keepAttachments: true },
    { recentLimit: 12, archiveLimit: 20, keepAttachments: false },
    { recentLimit: 6, archiveLimit: 0, keepAttachments: false }
  ];
  var saved = false;
  for (var i = 0; i < storageModes.length; i++) {
    try {
      var toSave = state.conversations.map(function(conv) {
        return _serializeConversationForStorage(conv, storageModes[i]);
      });
      localStorage.setItem('fauna-convs', JSON.stringify(toSave));
      saved = true;
      break;
    } catch (err) {
      if (!err || err.name !== 'QuotaExceededError') throw err;
    }
  }
  if (!saved) {
    try {
      var minimal = state.conversations.map(function(conv) {
        return {
          id: conv.id,
          title: conv.title,
          model: conv.model,
          systemPrompt: _trimStoredText(conv.systemPrompt || '', 4000),
          contextSummary: _trimStoredText(conv.contextSummary || '', 4000),
          createdAt: conv.createdAt,
          updatedAt: conv.updatedAt,
          projectId: conv.projectId,
          titleManual: conv.titleManual,
          titleSource: conv.titleSource,
          titleUpdatedAt: conv.titleUpdatedAt,
          messages: (conv.messages || []).slice(-2).map(function(msg) { return _sanitizeStoredMessage(msg, { keepAttachments: false }); })
        };
      });
      localStorage.setItem('fauna-convs', JSON.stringify(minimal));
    } catch (_) {}
  }
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
  var c = _serializeConversationForServer(conv);
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
    var c = _serializeConversationForServer(conv);
    fetch('/api/conversations/' + conv.id, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(c) }).catch(function() {});
  });
}

function getConv(id) {
  return state.conversations.find(c => c.id === id);
}

function normalizeConversationTitle(title) {
  return String(title || '').replace(/\s+/g, ' ').trim().slice(0, 80) || 'Conversation';
}

function setConversationTitle(id, title, opts) {
  opts = opts || {};
  var conv = getConv(id);
  if (!conv) return;
  conv.title = normalizeConversationTitle(title);
  if (opts.manual) {
    conv.titleManual = true;
    conv.titleSource = 'user';
  } else {
    conv.titleSource = 'ai';
    conv.titleUpdatedAt = Date.now();
  }
  if (state.currentId === id) {
    var titleEl = document.getElementById('topbar-title');
    if (titleEl) {
      titleEl.textContent = conv.title;
      titleEl.title = conv.title;
    }
  }
  saveConversations();
  _flushConvToServer(id);
  renderConvList();
  if (document.getElementById('all-convs-page')?.style.display !== 'none') renderAllConvsPage();
}

// Open a conversation in a new app window (multi-window support).
// Falls back gracefully when the preload bridge is unavailable (e.g. when
// the UI is loaded outside of Electron).
function openConvInNewWindow(id, e) {
  if (e) e.stopPropagation();
  if (!id) return;
  if (window.faunaApp && typeof window.faunaApp.openWindow === 'function') {
    window.faunaApp.openWindow({ convId: id, projectId: state.activeProjectId || null });
    return;
  }
  // Browser fallback: open a new tab with the same query params.
  try {
    var params = new URLSearchParams();
    params.set('conv', id);
    if (state.activeProjectId) params.set('project', state.activeProjectId);
    window.open(window.location.pathname + '?' + params.toString(), '_blank');
  } catch (_) {}
}

// Open a fresh app window that will start a new conversation. Mirrors the
// hover affordance on conv rows, but for the "New chat" sidebar button.
// Always opens a non-project-scoped window — use the in-project hover
// affordance on individual conversations to keep the project context.
function newConversationInNewWindow(e) {
  if (e) { e.stopPropagation(); e.preventDefault(); }
  if (window.faunaApp && typeof window.faunaApp.openWindow === 'function') {
    // `blank: true` tells the new window to exit any project context and
    // start with no active conversation, instead of auto-loading the most
    // recent conv (which would re-enter that conv's project).
    window.faunaApp.openWindow({ blank: true });
    return;
  }
  // Browser fallback: open the app root in a new tab with no project param.
  try {
    window.open(window.location.pathname + '?blank=1', '_blank');
  } catch (_) {}
}

async function renameConversation(id, e) {
  if (e) e.stopPropagation();
  var conv = getConv(id || state.currentId);
  if (!conv) return;
  var next = typeof showPrompt === 'function'
    ? await showPrompt('Rename conversation', conv.title || 'Conversation')
    : null;
  if (next === null) return;
  setConversationTitle(conv.id, next, { manual: true });
}

// Toggle the per-conversation autonomous (run-until-done) flag. Writes
// `conv.config.autonomousMode` and lets the existing debounced save flush
// PUT /api/conversations/:id. The chat route reads this on each request and
// scales the agentic loop caps + injects a persistence directive.
function toggleConvAutonomous(id, e) {
  if (e) e.stopPropagation();
  var conv = getConv(id || state.currentId);
  if (!conv) return;
  if (!conv.config || typeof conv.config !== 'object') conv.config = {};
  var next = !conv.config.autonomousMode;
  conv.config.autonomousMode = next;
  if (typeof saveConversations === 'function') saveConversations();
  if (typeof renderConvList === 'function') renderConvList();
  if (typeof showToast === 'function') showToast('Autonomous mode: ' + (next ? 'on' : 'off'));
}

async function maybeUpdateConversationTitle(conv) {
  if (!conv || conv.titleManual || conv._titleUpdating) return;
  if (!conv.messages || conv.messages.length < 2) return;
  var userMessages = conv.messages.filter(function(m) { return m.role === 'user' && !m._isAutoFeed && !m._isBrowserFeed; });
  if (!userMessages.length) return;
  var now = Date.now();
  if (conv.titleUpdatedAt && now - conv.titleUpdatedAt < 45000 && conv.messages.length > 3) return;

  conv._titleUpdating = true;
  try {
    var payloadMessages = conv.messages
      .filter(function(m) { return (m.role === 'user' || m.role === 'assistant') && !m._compositionHandoff; })
      .slice(-8)
      .map(function(m) {
        var content = m._displayText || m.content || '';
        if (typeof content !== 'string') content = JSON.stringify(content || '');
        return { role: m.role, content: content.slice(0, 1200) };
      });
    var r = await fetch('/api/conversation-title', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ messages: payloadMessages, model: conv.model || state.model })
    });
    if (!r.ok) return;
    var data = await r.json();
    var title = normalizeConversationTitle(data.title);
    // Guard against locking in junk. A transient empty model response used to
    // return a bare "New conversation" placeholder; applying it would overwrite
    // a previously-good title AND set titleUpdatedAt, after which the 45s guard
    // blocked all future regeneration — the title stayed wrong forever.
    var isPlaceholder = /^(new conversation|new chat|conversation|untitled)$/i.test(title);
    if (!title || isPlaceholder || conv.titleManual || title === conv.title) return;
    var curIsPlaceholder = /^(new conversation|new chat|conversation|untitled)$/i.test(conv.title || '');
    if (data.source === 'fallback' && !curIsPlaceholder) return; // don't downgrade a real title to a first-message slug
    setConversationTitle(conv.id, title, { manual: false });
  } catch (_) {
  } finally {
    conv._titleUpdating = false;
  }
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
  // Reset the live context-window ring — fresh conv has no usage yet
  if (typeof resetContextMeter === 'function') resetContextMeter();
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

function ensureStreamingPlaceholder(conv) {
  if (!conv || !conv._streaming) return;
  var convInner = getConvInner(conv.id);
  if (!convInner) return;
  // A new assistant turn is starting — strip any stale recommended-actions
  // bar from a previous bubble so it can't sit between two assistant messages.
  Array.from(convInner.querySelectorAll('.suggestion-bar')).forEach(function(old) { old.remove(); });
  var liveMessages = Array.from(convInner.querySelectorAll('.msg.ai[data-streaming-live="1"]'));
  if (liveMessages.length) {
    liveMessages.slice(1).forEach(function(el) { el.remove(); });
    return;
  }
  var hasLiveAssistant = convInner.querySelector('.msg.ai .reasoning-panel, .msg.ai .streaming-status');
  if (hasLiveAssistant) return;
  var msgEl = createMessageEl('ai', null);
  msgEl.dataset.streamingLive = '1';
  var body = msgEl.querySelector('.msg-body');
  if (body) {
    body.innerHTML = '<div class="thinking streaming-status">' +
      '<div class="think-dot"></div><div class="think-dot"></div><div class="think-dot"></div>' +
      '<span class="thinking-label">Fauna is working…</span>' +
    '</div>';
  }
  convInner.appendChild(msgEl);
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

  // Tree model: opening a chat auto-activates the project that owns it (or
  // deactivates any project for a quick chat). No explicit enter/exit step.
  var ownerProj = conv.projectId || null;
  if (ownerProj !== (state.activeProjectId || null) && typeof setActiveProject === 'function') {
    setActiveProject(ownerProj, { navigate: false });
  }

  state.model  = typeof normalizeSupportedModel === 'function'
    ? normalizeSupportedModel(conv.model || state.model, { conv: conv, notify: false })
    : (conv.model || state.model);
  document.getElementById('model-select').value = state.model;
  // Sync toolbar model label
  var _tbLbl = document.getElementById('tb-model-label');
  if (_tbLbl && typeof allModels !== 'undefined') {
    var _m = allModels.find(function(m) { return m.id === state.model; });
    if (_m) _tbLbl.textContent = _m.name;
  }
  document.getElementById('sys-prompt-input').value = conv.systemPrompt || '';
  updateSysScopeHint();
  var topbarTitle = document.getElementById('topbar-title');
  topbarTitle.textContent = conv.title;
  topbarTitle.title = conv.title;
  // Reflect conversation in window title so the tray menu can list it
  try { document.title = conv.title ? ('Fauna — ' + conv.title) : 'Fauna'; } catch (_) {}
  // Tell the main process which conv this window is on (for next-launch restore)
  try {
    if (window.faunaApp && typeof window.faunaApp.reportWindowState === 'function') {
      window.faunaApp.reportWindowState({ convId: id, projectId: state.activeProjectId || null });
    }
  } catch (_) {}

  // Switch browser pane to this conversation's tabs
  _showConvBrowserTabs(id);

  // Sync the ctx-meter ring to this conv's last recorded token_usage (if any).
  // Without this the meter would still show counts from the previous conv.
  try {
    if (conv.tokenUsage && typeof renderTokenUsageBar === 'function') {
      renderTokenUsageBar(conv.tokenUsage);
    } else if (typeof resetContextMeter === 'function') {
      resetContextMeter();
    }
  } catch (_) {}

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
    // Render archived messages first (history preserved from previous compressions)
    if (conv.archivedMessages && conv.archivedMessages.length) {
      conv.archivedMessages.forEach(function(m) {
        if (m._compositionHandoff) return;
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
        appendMessageDOM(m.role, m.content, m.attachments, false, m.agentInfo || null, m._isHTML || false, m.reasoning || null, m.widgets || null, m.plan || null);
      });

      // Divider showing where archive ends and active context begins
      var divider = document.createElement('div');
      divider.className = 'msg system-msg conv-archive-divider';
      divider.innerHTML = typeof renderContextArchiveDivider === 'function'
        ? renderContextArchiveDivider(conv)
        : '<div class="msg-body conv-archive-divider-inner"><span>Older messages archived — full history preserved above, AI context starts here</span></div>';
      convInner.appendChild(divider);
    }

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
      appendMessageDOM(m.role, m.content, m.attachments, false, m.agentInfo || null, m._isHTML || false, m.reasoning || null, m.widgets || null, m.plan || null);
    });
  }

  if (conv.messages.length) showMessages();
  else showEmpty();

  ensureStreamingPlaceholder(conv);
  if (conv._streaming) showMessages();

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

  // Ensure the recommended-actions bar is present for the latest assistant turn.
  // loadConversation only builds the message DOM on FIRST open (guarded by
  // !convInner.hasChildNodes()), and suggestion generation is otherwise only
  // triggered from appendMessageDOM. So switching back to an already-rendered
  // conversation — or one whose suggestions failed to generate the first time —
  // would never (re)trigger generation, leaving the bar permanently missing.
  // Trigger it here when idle and not already shown.
  if (!conv._streaming && typeof _generateContextualSuggestions === 'function') {
    setTimeout(function() {
      if (state.currentId !== id) return;
      var conv2 = getConv(id);
      if (!conv2 || conv2._streaming) return;
      if (typeof _hasActiveConversationWork === 'function' && _hasActiveConversationWork()) return;
      var ci = (typeof getConvInner === 'function') ? getConvInner(id) : null;
      if (!ci || ci.querySelector('.suggestion-bar')) return; // already shown
      var lastEl = ci.querySelector('.msg.assistant:last-of-type')
        || Array.from(ci.querySelectorAll('.msg.assistant')).pop();
      if (lastEl) _generateContextualSuggestions(lastEl);
    }, 150);
  }
}

function clearConversation() {
  var conv = getConv(state.currentId);
  if (!conv) return;
  conv.messages = [];
  conv.title = 'New conversation';
  conv.titleManual = false;
  conv.titleSource = null;
  conv.titleUpdatedAt = null;
  var titleEl = document.getElementById('topbar-title');
  titleEl.textContent = conv.title;
  titleEl.title = conv.title;
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
  if (window.FaunaConvCache) window.FaunaConvCache.removeOne(id);
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

// Shared conversation-row markup, used by both the Quick chats list and the
// per-project folders in the sidebar tree.
function _convRowHtml(conv) {
  return '<div class="conv-item' + (conv.id === state.currentId ? ' active' : '') + '" onclick="loadConversation(\'' + conv.id + '\')">' +
    (conv._streaming ? '<i class="ti ti-loader-2 conv-streaming-icon"></i>' : '') +
    '<span class="conv-label" title="' + escHtml(conv.title) + '">' + escHtml(conv.title) + '</span>' +
    '<span class="conv-actions">' +
      '<button class="conv-rename" onclick="toggleConvAutonomous(\'' + conv.id + '\', event)" title="' + (conv.config && conv.config.autonomousMode ? 'Autonomous mode: on — click to disable' : 'Autonomous mode: off — click to enable') + '"><i class="ti ti-bolt"' + (conv.config && conv.config.autonomousMode ? ' style="color:#ffb800"' : '') + '></i></button>' +
      '<button class="conv-rename" onclick="openConvInNewWindow(\'' + conv.id + '\', event)" title="Open in new window"><i class="ti ti-external-link"></i></button>' +
      '<button class="conv-rename" onclick="renameConversation(\'' + conv.id + '\', event)" title="Rename"><i class="ti ti-pencil"></i></button>' +
      ((typeof state !== 'undefined' && state.enableConvExport)
        ? '<button class="conv-rename" onclick="exportConversation(\'' + conv.id + '\', event)" title="Export transcript (JSON)"><i class="ti ti-download"></i></button>'
        : '') +
      '<button class="conv-del" onclick="deleteConversation(\'' + conv.id + '\', event)"><i class="ti ti-trash"></i></button>' +
    '</span>' +
  '</div>';
}

function renderConvList() {
  var list = document.getElementById('conv-list');
  if (!list) return;
  var MAX_VISIBLE = 6;
  // Quick chats = conversations that do not belong to any project. Project
  // conversations are rendered inside their project folders instead.
  var convs = state.conversations.filter(function(c) { return !c.projectId; });
  var visible = convs.slice(0, MAX_VISIBLE);
  list.innerHTML = visible.map(_convRowHtml).join('');
  var showAll = document.getElementById('conv-show-all');
  if (showAll) showAll.style.display = convs.length > MAX_VISIBLE ? '' : 'none';
  // Keep the project folder tree in sync with the latest conversation data.
  if (typeof renderProjectSidebarList === 'function') renderProjectSidebarList();
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
    convs = convs.filter(function(c) { return String(c.title || 'Conversation').toLowerCase().includes(f); });
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
    var title = c.title || 'Conversation';
    var isActive = c.id === state.currentId;
    items += '<div class="all-convs-item' + (isActive ? ' active' : '') + '" onclick="closeAllConversations();loadConversation(\'' + c.id + '\')">'+
      '<i class="ti ti-message all-convs-icon"></i>' +
      '<span class="all-convs-title" title="' + escHtml(title) + '">' + escHtml(title) + '</span>' +
      '<span class="all-convs-date">' + (c.createdAt ? new Date(c.createdAt).toLocaleDateString() : '') + '</span>' +
      '<button class="all-convs-rename" onclick="event.stopPropagation();openConvInNewWindow(\'' + c.id + '\', event)" title="Open in new window"><i class="ti ti-external-link"></i></button>' +
      '<button class="all-convs-rename" onclick="event.stopPropagation();renameConversation(\'' + c.id + '\', event)" title="Rename"><i class="ti ti-pencil"></i></button>' +
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

// ── Conversation export (HAR-style transcript bundle) ─────────────────────
//
// Produces a single JSON file containing the full conversation transcript,
// tool-call activity blocks (parsed out of assistant message content for easy
// review), per-message metadata (agent, reasoning, widgets, plan), the active
// settings snapshot, and the in-memory client debug log. Mirrors the spirit
// of an HTTP Archive (HAR) file: one self-contained artifact you can hand off
// for offline review of "what happened in this conversation".
//
// Stored conversations don't carry a structured tool_calls field on assistant
// messages — tool activity is emitted into the assistant content as fenced
// blocks (```cot, ```wf, ```shell-exec, ```figma-exec, ```ba ...). We pull
// those fences out into a parallel `tools` array per message so consumers
// don't have to re-parse markdown to see what tools ran.
function _extractToolBlocksFromContent(content) {
  if (!content || typeof content !== 'string') return [];
  var out = [];
  // Match every activity-related fence the chat renderer uses, including the
  // shell command/output pair (bash + shell-output) and the inline tool-call
  // descriptors (cot/wf/ba) and direct-exec fences (shell-exec/figma-exec).
  // Body is captured verbatim so JSON/SQL/shell payloads survive intact.
  var re = /```(cot|wf|shell-exec|figma-exec|ba|bash|sh|zsh|shell-output|tool-output|tool_output)\b([^\n]*)\n([\s\S]*?)```/g;
  var m;
  while ((m = re.exec(content)) !== null) {
    var kind = m[1];
    var header = (m[2] || '').trim();
    var body = m[3] || '';
    var parsed = null;
    // cot/wf/ba blocks are usually JSON payloads; try to parse for convenience.
    if (kind === 'cot' || kind === 'wf' || kind === 'ba') {
      try { parsed = JSON.parse(body); } catch (_) { /* leave raw */ }
    }
    out.push({
      kind: kind,
      // Classify so consumers can filter quickly: 'call' = model invoked something;
      // 'output' = result fed back to the model; 'cmd' = shell command source.
      role: (kind === 'shell-output' || kind === 'tool-output' || kind === 'tool_output') ? 'output'
        : (kind === 'bash' || kind === 'sh' || kind === 'zsh') ? 'cmd'
        : 'call',
      header: header || null,
      body: parsed == null ? body : undefined,
      parsed: parsed || undefined,
      offset: m.index,
    });
  }
  return out;
}

function _buildConversationExport(conv) {
  var messages = Array.isArray(conv.messages) ? conv.messages : [];
  var exported = {
    formatVersion: 1,
    format: 'fauna.transcript.v1',
    exportedAt: new Date().toISOString(),
    app: {
      name: 'Fauna',
      // Pulled from window.FAUNA_BUILD if main.js has injected it; otherwise null.
      version: (typeof window !== 'undefined' && window.FAUNA_BUILD && window.FAUNA_BUILD.version) || null,
      build: (typeof window !== 'undefined' && window.FAUNA_BUILD && window.FAUNA_BUILD.commit) || null,
      userAgent: (typeof navigator !== 'undefined' ? navigator.userAgent : null),
    },
    conversation: {
      id: conv.id,
      title: conv.title || '',
      model: conv.model || null,
      projectId: conv.projectId || null,
      agentName: conv.agentName || (conv._activeAgent && conv._activeAgent.name) || null,
      createdAt: conv.createdAt || null,
      updatedAt: conv.updatedAt || null,
      systemPrompt: conv.systemPrompt || null,
      contextSummary: conv.contextSummary || null,
      config: conv.config || null,
      messageCount: messages.length,
    },
    settings: (typeof state !== 'undefined' && state) ? {
      model: state.model,
      thinkingBudget: state.thinkingBudget,
      maxContextTurns: state.maxContextTurns,
      figmaMCPEnabled: !!state.figmaMCPEnabled,
      playwrightMCPEnabled: !!state.playwrightMCPEnabled,
      enableDynamicWidgets: !!state.enableDynamicWidgets,
      autoCompact: state.autoCompact !== false,
    } : null,
    messages: messages.map(function(m, i) {
      var entry = {
        index: i,
        role: m.role,
        content: m.content == null ? '' : m.content,
      };
      if (m.timestamp) entry.timestamp = m.timestamp;
      if (m.agentInfo) entry.agentInfo = m.agentInfo;
      if (m.reasoning) entry.reasoning = m.reasoning;
      if (m.widgets) entry.widgets = m.widgets;
      if (m.plan) entry.plan = m.plan;
      if (m.attachments) entry.attachments = m.attachments;
      if (m.role === 'assistant') {
        var tools = _extractToolBlocksFromContent(entry.content);
        if (tools.length) entry.tools = tools;
      }
      return entry;
    }),
    clientDebugLog: (typeof _debugLogs !== 'undefined' && Array.isArray(_debugLogs)) ? _debugLogs.slice(-2000) : [],
  };
  return exported;
}

function exportConversation(id, e) {
  if (e) e.stopPropagation();
  // Gated experimental feature — hidden from the UI by default. Refuse if the
  // user hasn't explicitly opted in via Settings → Experimental.
  if (typeof state === 'undefined' || !state.enableConvExport) {
    if (typeof showToast === 'function') showToast('Transcript export is disabled. Enable it under Settings → Experimental.');
    return;
  }
  var conv = null;
  if (id) {
    conv = (state.conversations || []).find(function(c) { return c.id === id; });
  }
  if (!conv) conv = (state.conversations || []).find(function(c) { return c.id === state.currentId; });
  if (!conv) {
    if (typeof showToast === 'function') showToast('No conversation to export');
    return;
  }
  var bundle;
  try {
    bundle = _buildConversationExport(conv);
  } catch (err) {
    if (typeof showToast === 'function') showToast('Export failed: ' + (err && err.message ? err.message : String(err)));
    return;
  }
  var json = JSON.stringify(bundle, null, 2);
  var blob = new Blob([json], { type: 'application/json' });
  var url = URL.createObjectURL(blob);
  var safeTitle = (conv.title || 'conversation').replace(/[^a-zA-Z0-9._-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'conversation';
  var stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  var a = document.createElement('a');
  a.href = url;
  a.download = 'fauna-' + safeTitle + '-' + stamp + '.transcript.json';
  document.body.appendChild(a);
  a.click();
  setTimeout(function() {
    try { document.body.removeChild(a); } catch (_) {}
    URL.revokeObjectURL(url);
  }, 0);
  if (typeof showToast === 'function') showToast('Conversation exported');
}

// Expose on window so inline onclick handlers (and the topbar menu) can call it.
if (typeof window !== 'undefined') {
  window.exportConversation = exportConversation;
}
