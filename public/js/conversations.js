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
  // Limits are now caller-controlled so the server-bound payload can keep
  // full message bodies while the localStorage / IDB cache stays small.
  // Fall back to the historic 12 000 / 6 000 / 4 000 caps for callers that
  // don't pass an override (local cache writes).
  var contentLimit = (typeof opts.contentLimit === 'number') ? opts.contentLimit : 12000;
  var displayLimit = (typeof opts.displayLimit === 'number') ? opts.displayLimit : 6000;
  var attachLimit  = (typeof opts.attachLimit  === 'number') ? opts.attachLimit  : 4000;
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
  copy.content = _trimStoredMessageContent(typeof copy.content === 'string' ? copy.content : JSON.stringify(copy.content || ''), contentLimit);

  if (typeof msg._displayText === 'string') {
    copy._displayText = _trimStoredText(msg._displayText, displayLimit);
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
      if (keepAttachments && att && typeof att.content === 'string') next.content = _trimStoredText(att.content, attachLimit);
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

  var recentLimit  = opts.recentLimit  || 24;
  var archiveLimit = opts.archiveLimit || 40;
  var msgOpts = {
    keepAttachments: !!opts.keepAttachments,
    contentLimit:    opts.contentLimit,
    displayLimit:    opts.displayLimit,
    attachLimit:     opts.attachLimit,
  };
  copy.messages = (conv.messages || []).slice(-recentLimit).map(function(msg) {
    return _sanitizeStoredMessage(msg, msgOpts);
  });

  if (Array.isArray(conv.archivedMessages) && conv.archivedMessages.length) {
    var archMsgOpts = Object.assign({}, msgOpts, { keepAttachments: false });
    copy.archivedMessages = conv.archivedMessages.slice(-archiveLimit).map(function(msg) {
      return _sanitizeStoredMessage(msg, archMsgOpts);
    });
  }

  // Artifact and prompt limits also default to 12 000 (local cache) but the
  // server-bound serializer can pass a much larger cap so users see the full
  // artifact / system prompt when a conversation is reopened.
  var artifactLimit       = (typeof opts.artifactContentLimit === 'number') ? opts.artifactContentLimit : 12000;
  var artifactSliceLimit  = (typeof opts.artifactSliceLimit   === 'number') ? opts.artifactSliceLimit   : 10;
  var contextSummaryLimit = (typeof opts.contextSummaryLimit  === 'number') ? opts.contextSummaryLimit  : 12000;
  var systemPromptLimit   = (typeof opts.systemPromptLimit    === 'number') ? opts.systemPromptLimit    : 12000;

  if (Array.isArray(conv.artifacts) && conv.artifacts.length) {
    copy.artifacts = conv.artifacts.slice(-artifactSliceLimit).map(function(artifact) {
      var stored = Object.assign({}, artifact);
      if (stored.base64) delete stored.base64;
      if (typeof stored.content === 'string') stored.content = _trimStoredText(stored.content, artifactLimit);
      return stored;
    });
  }

  if (typeof copy.contextSummary === 'string') copy.contextSummary = _trimStoredText(copy.contextSummary, contextSummaryLimit);
  if (typeof copy.systemPrompt   === 'string') copy.systemPrompt   = _trimStoredText(copy.systemPrompt,   systemPromptLimit);
  return copy;
}

// Server-side cap on a single message body (mirror of MAX_MESSAGE_BYTES in
// server/lib/conversation-store.js). Stay a hair below so an over-budget
// content gets trimmed locally with a clean marker instead of bouncing the
// whole PUT with a 413 that silently drops the update.
var SERVER_MESSAGE_LIMIT = 4 * 1024 * 1024;

function _serializeConversationForServer(conv) {
  return _serializeConversationForStorage(conv, {
    recentLimit:  60,
    archiveLimit: 120,
    keepAttachments: true,
    // Send full content to the server. The local cache trim is purely a
    // localStorage / IDB quota workaround — the server is the source of
    // truth and is sized to hold real messages.
    contentLimit:         SERVER_MESSAGE_LIMIT,
    displayLimit:         SERVER_MESSAGE_LIMIT,
    attachLimit:          SERVER_MESSAGE_LIMIT,
    artifactContentLimit: SERVER_MESSAGE_LIMIT,
    artifactSliceLimit:   100,
    contextSummaryLimit:  SERVER_MESSAGE_LIMIT,
    systemPromptLimit:    SERVER_MESSAGE_LIMIT,
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
// Last-flushed payload hash per conv id. Used to suppress redundant PUTs
// when saveConversations() is called repeatedly with identical conv state
// (UI re-renders, hydrate-merge with no real diff, focus events, etc.) —
// otherwise the network log fills up with /api/conversations/:id traffic
// and each PUT bounces back as an SSE upsert that re-triggers hydrate.
var _lastSyncHash = {};

// FNV-1a 32-bit — fast, no allocations, good enough to spot identical bodies.
function _hashString(s) {
  var h = 0x811c9dc5;
  for (var i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0;
  }
  return h.toString(16);
}

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
  var body = JSON.stringify(c);
  var hash = _hashString(body);
  if (_lastSyncHash[id] === hash) return; // identical to the last successful PUT — skip
  _lastSyncHash[id] = hash;
  fetch('/api/conversations/' + id, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: body })
    .catch(function() {
      // Network error — forget the hash so the next save retries instead of
      // silently swallowing a real update.
      delete _lastSyncHash[id];
    });
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
    var body = JSON.stringify(c);
    var hash = _hashString(body);
    if (_lastSyncHash[conv.id] === hash) return;
    _lastSyncHash[conv.id] = hash;
    fetch('/api/conversations/' + conv.id, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: body })
      .catch(function() { delete _lastSyncHash[conv.id]; });
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

function newConversation(opts) {
  opts = opts || {};
  // `quick` forces a project-less conversation even when a project is active,
  // so the Quick chats "New chat" button never files into the current project.
  var projectId = opts.quick ? null : (state.activeProjectId || null);
  var id = 'c' + Date.now();
  var conv = { id, title: 'New conversation', messages: [], model: state.model, systemPrompt: state.systemPrompt, createdAt: Date.now() };
  if (projectId) conv.projectId = projectId;
  state.conversations.unshift(conv);
  saveConversations();
  // Notify backend about the link
  if (projectId) {
    fetch('/api/projects/' + projectId + '/conversations', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ convId: id }) }).catch(function(){});
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

  // Keep the sidebar tidy: show the section the open chat lives in, collapse
  // the other. Quick chat → collapse Projects; project chat → collapse Quick chats.
  if (typeof focusSidebarSectionForConv === 'function') {
    focusSidebarSectionForConv(!!ownerProj);
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
  // Use forceScrollBottom() — not scrollBottom() — because the shared
  // `_userScrolledUp` latch carries over from whatever the previous conv
  // looked like, and `display:none → display:contents` swap inside
  // #messages-inner can briefly leave #messages scrolled to the top of the
  // new conv. Defer one frame so the new conv's height has settled before
  // we set scrollTop = scrollHeight.
  forceScrollBottom();
  requestAnimationFrame(function() {
    if (state.currentId === id) forceScrollBottom();
  });
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
  var dateStr = _convRelativeDate(conv);
  var projMetrics = '';
  if (conv.projectId && typeof getProjectTaskAnalyticsInlineHtml === 'function') {
    projMetrics = getProjectTaskAnalyticsInlineHtml(conv.projectId, { compact: true });
  }
  return '<div class="conv-item' + (conv.id === state.currentId ? ' active' : '') + '" onclick="loadConversation(\'' + conv.id + '\')">' +
    (conv._streaming ? '<i class="ti ti-loader-2 conv-streaming-icon"></i>' : '') +
    '<span class="conv-label" title="' + escHtml(conv.title) + (dateStr ? ' \u2014 ' + escHtml(dateStr) : '') + '">' + escHtml(conv.title) + '</span>' +
    projMetrics +
    (dateStr ? '<span class="conv-date" title="' + escHtml(dateStr) + '">' + escHtml(dateStr) + '</span>' : '') +
    '<span class="conv-actions">' +
      '<button class="conv-rename" onclick="toggleConvAutonomous(\'' + conv.id + '\', event)" title="' + (conv.config && conv.config.autonomousMode ? 'Autonomous mode: on \u2014 click to disable' : 'Autonomous mode: off \u2014 click to enable') + '"><i class="ti ti-bolt"' + (conv.config && conv.config.autonomousMode ? ' style="color:#ffb800"' : '') + '></i></button>' +
      '<button class="conv-rename" onclick="openConvInNewWindow(\'' + conv.id + '\', event)" title="Open in new window"><i class="ti ti-external-link"></i></button>' +
      '<button class="conv-rename" onclick="renameConversation(\'' + conv.id + '\', event)" title="Rename"><i class="ti ti-pencil"></i></button>' +
      ((typeof state !== 'undefined' && state.enableConvExport)
        ? '<button class="conv-rename" onclick="exportConversation(\'' + conv.id + '\', event)" title="Export transcript (JSON)"><i class="ti ti-download"></i></button>'
        : '') +
      '<button class="conv-del" onclick="deleteConversation(\'' + conv.id + '\', event)"><i class="ti ti-trash"></i></button>' +
    '</span>' +
  '</div>';
}

// Pick the best timestamp we can find for a conversation. Legacy records
// may be missing updatedAt/createdAt entirely, so fall back to the most
// recent message's timestamp before giving up.
function _convBestTs(conv) {
  if (!conv) return 0;
  if (conv.updatedAt) return conv.updatedAt;
  if (conv.createdAt) return conv.createdAt;
  var msgs = conv.messages || [];
  for (var i = msgs.length - 1; i >= 0; i--) {
    if (msgs[i] && msgs[i].timestamp) return msgs[i].timestamp;
  }
  return 0;
}

// Friendly "Today / Yesterday / Mon / Jun 3 / Jun 3, 2024" formatter for
// the sidebar + All Conversations list. Older items always get a full
// date (with year for anything not in the current year) so the user can
// tell really-old chats apart at a glance \u2014 fixing the "older
// conversations don't have dates" complaint.
function _convRelativeDate(conv) {
  var ts = _convBestTs(conv);
  if (!ts) return '';
  var d = new Date(ts);
  if (isNaN(d.getTime())) return '';
  var now = new Date();
  var startOfDay = function(x) { return new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime(); };
  var dayMs = 86400000;
  var dayDiff = Math.round((startOfDay(now) - startOfDay(d)) / dayMs);
  if (dayDiff === 0) {
    return d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  }
  if (dayDiff === 1) return 'Yesterday';
  if (dayDiff > 1 && dayDiff < 7) {
    return d.toLocaleDateString([], { weekday: 'short' });
  }
  if (d.getFullYear() === now.getFullYear()) {
    return d.toLocaleDateString([], { month: 'short', day: 'numeric' });
  }
  return d.toLocaleDateString([], { month: 'short', day: 'numeric', year: 'numeric' });
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
  _updateSectionStreamingIndicators();
}

// Section headers show a spinner when their section is COLLAPSED but holds a
// running conversation, so ongoing work stays visible even when the inner
// rows (which carry their own spinners) are hidden.
function _updateSectionStreamingIndicators() {
  var convs = state.conversations || [];
  var quickRunning = convs.some(function(c) { return !c.projectId && c._streaming; });
  var projRunning = convs.some(function(c) { return c.projectId && c._streaming; });
  var pairs = [
    ['conv-section-body', 'conv-section-streaming', quickRunning],
    ['projects-section-body', 'projects-section-streaming', projRunning]
  ];
  pairs.forEach(function(p) {
    var icon = document.getElementById(p[1]);
    if (!icon) return;
    var body = document.getElementById(p[0]);
    var collapsed = body && body.style.display === 'none';
    icon.style.display = (p[2] && collapsed) ? '' : 'none';
  });
}

function openAllConversations(projectId) {
  var page = document.getElementById('all-convs-page');
  if (!page) return;
  page._filter = '';
  // Optional pre-filter by project — used when the user clicks "All chats"
  // under a project folder so the table only shows that project's chats.
  // Pass null/undefined / '' to show everything.
  page._projFilter = projectId || '';
  page.innerHTML = '';
  page.style.display = 'flex';
  renderAllConvsPage();
}

// Clear the active project filter on the All Conversations page (exposed for
// the in-header "× clear" chip).
function clearAllConvsProjectFilter() {
  var page = document.getElementById('all-convs-page');
  if (!page) return;
  page._projFilter = '';
  page.innerHTML = ''; // force header rebuild so the chip disappears
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
  var projFilter = page._projFilter || '';
  var convs = (state.conversations || []).slice().sort(function(a, b) {
    return (b.updatedAt || b.createdAt || 0) > (a.updatedAt || a.createdAt || 0) ? 1 : -1;
  });
  if (projFilter) {
    convs = convs.filter(function(c) { return c.projectId === projFilter; });
  }
  if (filter) {
    var f = filter.toLowerCase();
    convs = convs.filter(function(c) { return String(c.title || 'Conversation').toLowerCase().includes(f); });
  }

  // Resolve the active project filter to a {name,color} object (or null) so
  // we can render the filter chip in the header and re-render it whenever the
  // filter changes.
  var activeProj = projFilter
    ? (state.projects || []).find(function(p) { return p.id === projFilter; })
    : null;

  // If the page is already built, only update the list body
  var listEl = document.getElementById('all-convs-list-body');
  if (!listEl) {
    // First render — build full structure (mirrors the All Projects datagrid)
    var titleHtml = activeProj
      ? '<div class="all-agents-title"><i class="ti ti-messages"></i> All Conversations' +
          '<span class="all-conv-filter-chip" title="Showing only chats in this project">' +
            '<span class="proj-dot proj-color-' + escHtml(activeProj.color || 'blue') + '" style="width:8px;height:8px;flex-shrink:0"></span>' +
            escHtml(activeProj.name) +
            '<button type="button" class="all-conv-filter-chip-clear" onclick="clearAllConvsProjectFilter()" title="Clear project filter"><i class="ti ti-x"></i></button>' +
          '</span>' +
        '</div>'
      : '<div class="all-agents-title"><i class="ti ti-messages"></i> All Conversations</div>';
    page.innerHTML =
      '<div class="all-agents-page-inner">' +
        '<div class="all-agents-header">' +
          titleHtml +
          '<div class="all-agents-search-wrap">' +
            '<i class="ti ti-search"></i>' +
            '<input class="all-agents-search" id="all-convs-search" placeholder="Search conversations\u2026" value="' + escHtml(filter) + '" oninput="document.getElementById(\'all-convs-page\')._filter=this.value;renderAllConvsPage()">' +
          '</div>' +
          '<button class="proj-action-btn" onclick="closeAllConversations();newConversation()"><i class="ti ti-plus"></i> New chat</button>' +
          '<button class="all-agents-close" onclick="closeAllConversations()"><i class="ti ti-x"></i></button>' +
        '</div>' +
        '<div id="all-convs-list-body" class="all-convs-list"></div>' +
      '</div>';
    listEl = document.getElementById('all-convs-list-body');
  }

  if (!convs.length) {
    var emptyMsg = projFilter
      ? 'No conversations in this project'
      : 'No conversations found';
    listEl.innerHTML = '<div class="proj-hub-empty" style="padding:40px"><i class="ti ti-messages-off" style="font-size:28px;opacity:.3"></i><div>' + escHtml(emptyMsg) + '</div></div>';
    return;
  }

  var projName = function(id) {
    if (!id) return null;
    var p = (state.projects || []).find(function(x) { return x.id === id; });
    return p || null;
  };

  var header =
    '<div class="all-conv-row all-conv-row-head">' +
      '<span class="all-conv-col-name">Conversation</span>' +
      '<span class="all-conv-col-proj">Project</span>' +
      '<span class="all-conv-col-num" title="Messages"><i class="ti ti-message-2"></i></span>' +
      '<span class="all-conv-col-date">Updated</span>' +
      '<span class="all-conv-col-actions"></span>' +
    '</div>';

  var rows = convs.map(function(c) {
    var title = c.title || 'Conversation';
    var isActive = c.id === state.currentId;
    var msgCount = (c.messages || []).length;
    // Use the shared best-timestamp helper so legacy conversations with no
    // explicit updatedAt/createdAt still show a date (falling back to the
    // last message's timestamp).
    var dateStr = _convRelativeDate(c);
    var proj = projName(c.projectId);
    var projAnalytics = '';
    if (proj && typeof getProjectTaskAnalyticsInlineHtml === 'function') {
      projAnalytics = getProjectTaskAnalyticsInlineHtml(proj.id, { compact: true });
    }
    var cid = escHtml(c.id);
    return '<div class="all-conv-row' + (isActive ? ' active' : '') + '" onclick="closeAllConversations();loadConversation(\'' + cid + '\')">' +
      '<span class="all-conv-col-name">' +
        (c._streaming
          ? '<i class="ti ti-loader-2 conv-streaming-icon"></i>'
          : '<i class="ti ti-message all-conv-icon"></i>') +
        '<span class="all-conv-name-text" title="' + escHtml(title) + '">' + escHtml(title) + '</span>' +
        (isActive ? '<span class="all-proj-active-badge">Active</span>' : '') +
      '</span>' +
      '<span class="all-conv-col-proj">' +
        (proj
          ? '<span class="all-conv-proj-badge"><span class="proj-dot proj-color-' + escHtml(proj.color || 'blue') + '" style="width:8px;height:8px;flex-shrink:0"></span>' + escHtml(proj.name) + '</span>' + projAnalytics
          : '<span class="all-proj-dim">—</span>') +
      '</span>' +
      '<span class="all-conv-col-num">' + msgCount + '</span>' +
      '<span class="all-conv-col-date">' + (dateStr ? escHtml(dateStr) : '<span class="all-proj-dim">\u2014</span>') + '</span>' +
      '<span class="all-conv-col-actions">' +
        '<button class="proj-icon-btn" onclick="event.stopPropagation();openConvInNewWindow(\'' + cid + '\', event)" title="Open in new window"><i class="ti ti-external-link"></i></button>' +
        '<button class="proj-icon-btn" onclick="event.stopPropagation();renameConversation(\'' + cid + '\', event)" title="Rename"><i class="ti ti-pencil"></i></button>' +
        '<button class="proj-icon-btn" style="color:var(--fau-text-muted)" onclick="event.stopPropagation();deleteConversation(\'' + cid + '\', event);renderAllConvsPage()" title="Delete"><i class="ti ti-trash"></i></button>' +
      '</span>' +
    '</div>';
  }).join('');

  listEl.innerHTML = header + rows;
}

function toggleSidebarSection(section) {
  var bodyMap = { conv: 'conv-section-body', agents: 'agents-section-body', projects: 'projects-section-body' };
  var body = document.getElementById(bodyMap[section]);
  if (!body) return;
  setSidebarSection(section, body.style.display !== 'none');
}

// Collapse (collapsed=true) or expand a sidebar section, syncing its chevron.
function setSidebarSection(section, collapsed) {
  var bodyMap = { conv: 'conv-section-body', agents: 'agents-section-body', projects: 'projects-section-body' };
  var headerMap = { conv: 'conv-section-header', agents: 'agents-section-header', projects: 'projects-section-header' };
  var body = document.getElementById(bodyMap[section]);
  if (!body) return;
  var alreadyCollapsed = body.style.display === 'none';
  if (alreadyCollapsed === collapsed) return;
  body.style.display = collapsed ? 'none' : '';
  var header = document.getElementById(headerMap[section]);
  if (header) {
    var chevron = header.querySelector('.section-chevron');
    if (chevron) {
      chevron.classList.toggle('ti-chevron-down', !collapsed);
      chevron.classList.toggle('ti-chevron-right', collapsed);
    }
  }
  _updateSectionStreamingIndicators();
}

// When a chat opens, keep the sidebar tidy by showing only the relevant
// section: a quick chat collapses Projects; a project chat collapses Quick chats.
function focusSidebarSectionForConv(isProjectChat) {
  if (isProjectChat) {
    setSidebarSection('projects', false);
    setSidebarSection('conv', true);
  } else {
    setSidebarSection('conv', false);
    setSidebarSection('projects', true);
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
    messages: messages.reduce(function(acc, m, i) {
      // Drop auto-injected system control nudges that get persisted with
      // role:'user'. These are never the user's words — they're things
      // like "[System: the plan is not yet complete. Next step: …]" or
      // continuation pokes from the runtime. They make exports look like
      // the user said weird system-y things they never said.
      if (m.role === 'user' && _isSystemControlMessage(m.content)) return acc;
      var rawContent = m.content == null ? '' : m.content;
      var entry = {
        index: i,
        role: m.role,
        content: _sanitizeExportContent(m.role, rawContent),
      };
      if (m.timestamp) entry.timestamp = m.timestamp;
      if (m.agentInfo) entry.agentInfo = m.agentInfo;
      if (m.reasoning) entry.reasoning = m.reasoning;
      if (m.widgets) entry.widgets = m.widgets;
      if (m.plan) entry.plan = m.plan;
      if (m.attachments) entry.attachments = m.attachments;
      if (m.role === 'assistant') {
        // Extract from RAW content — sanitize strips shell-output / tool-output
        // fences out of `content` (they're huge dumps that bury the prose), and
        // we want them captured here in structured form.
        var tools = _extractToolBlocksFromContent(rawContent);
        if (tools.length) entry.tools = tools;
      }
      acc.push(entry);
      return acc;
    }, []),
    clientDebugLog: (typeof _debugLogs !== 'undefined' && Array.isArray(_debugLogs)) ? _debugLogs.slice(-2000) : [],
  };
  return exported;
}

// True when a user-role message is purely a runtime control nudge (no real
// user text). We match common prefixes used by the planner / continuation
// loop. Anything that's just a `[System: …]` bracket with no preceding
// user prose is treated as control noise.
function _isSystemControlMessage(content) {
  if (typeof content !== 'string') return false;
  var t = content.trim();
  if (!t) return false;
  if (/^\[System:\s/i.test(t) && t.endsWith(']')) return true;
  if (/^\[Browser extension snapshot\]/i.test(t)) return true;
  return false;
}

// Strip every runtime-injected preamble/postscript out of a user-role message
// so the bubble shows ONLY what the user actually typed. Used by both the
// display renderer (ui.js) and the export path (_sanitizeExportContent).
//
// We inject context into user messages from a half-dozen places:
//   - Live browser tab dumps (//  Browser page: / // Live browser tab context)
//   - The planner's "[The user has confirmed the plan…]" coercion prose
//   - System-task context fences (Desktop contents, etc.)
//   - The trailing "[Current date and time: …]" stamp
// All of that needs to reach the model — none of it should be visible to the
// user. They typed "proceed", so the bubble should show "proceed".
function sanitizeUserDisplayContent(content) {
  if (typeof content !== 'string') return content;
  var s = content;
  // Leading "// Browser page:" attachment fence.
  s = s.replace(/^```[\s\S]*?\/\/ Browser page:[\s\S]*?```\s*/m, '');
  // "[Resolved live browser tab context — …]" note.
  s = s.replace(/\[Resolved live browser tab context[\s\S]*?\]\s*/m, '');
  // "// Live browser tab context" trailing dump.
  s = s.replace(/```[\s\S]*?\/\/ Live browser tab context[\s\S]*?```\s*/g, '');
  // Planner's "[The user has confirmed the plan. Now output…]" coercion.
  s = s.replace(/\n*\[The user has confirmed the plan\.[\s\S]*?\]\s*/g, '');
  // gatherSystemContext "Current Desktop contents" prose + any other prose
  // it appends as a `Current ... :\n```...```\n` sandwich. Drop the leading
  // labelled-fence block when it appears just above/below user text.
  s = s.replace(/Current Desktop contents \(`ls ~\/Desktop`\):\s*```[\s\S]*?```\s*/g, '');
  // Trailing "[Current date and time: …]" stamp.
  s = s.replace(/\n*\[Current date and time:[^\]]*\]\s*$/m, '');
  // Collapse runs of blank lines we may have created.
  s = s.replace(/\n{3,}/g, '\n\n');
  return s.trim();
}
// Expose globally so ui.js / chat.js can reuse without an import.
if (typeof window !== 'undefined') window.sanitizeUserDisplayContent = sanitizeUserDisplayContent;

// Strip runtime-injected preamble & postscript noise from message content so
// the exported transcript shows what was actually said. For user messages we
// strip the planner's injected browser/date noise. For assistant messages we
// strip ```shell-output / ```tool-output / ```tool_output fences — those are
// raw tool dumps that the streaming buffer inlines for rendering, but are
// already captured in the separate per-message `tools[]` array. Leaving them
// in `content` produces 40KB+ assistant messages whose actual prose is buried
// at the bottom and gets truncated to invisibility by viewers.
function _sanitizeExportContent(role, content) {
  if (typeof content !== 'string') return content;
  if (role === 'assistant') {
    var s = content;
    // Pull every tool-output fence out of the prose. Keep one blank line in
    // its place so paragraph spacing around the (now extracted) block looks
    // sane in the export.
    s = s.replace(/```(?:shell-output|tool-output|tool_output)\b[^\n]*\n[\s\S]*?```\s*/g, '\n');
    // Collapse runs of blank lines we may have created.
    s = s.replace(/\n{3,}/g, '\n\n');
    return s.trim();
  }
  if (role !== 'user') return content;
  // User-role export reuses the display sanitizer: same noise, same fix.
  return sanitizeUserDisplayContent(content);
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

// ── Open Markdown file (file association) ──────────────────────────────────
// When the user opens a .md file with Fauna (double-click, dock drop, command
// line), the main process delivers `{ path, name, content }` here. We offer to
// start a new conversation or attach the document to an existing one.
var _mdFileQueue = [];
var _mdFilePending = null;

function handleIncomingMdFile(payload) {
  if (!payload || typeof payload.content !== 'string') return;
  _mdFileQueue.push(payload);
  // Only surface the modal when one isn't already being decided.
  if (!_mdFilePending) _showNextMdFile();
}

function _showNextMdFile() {
  _mdFilePending = _mdFileQueue.shift() || null;
  if (!_mdFilePending) { closeMdFileModal(); return; }

  var modal = document.getElementById('mdfile-modal');
  if (!modal) {
    // No modal (non-Electron host) — just attach to the current conversation.
    _attachMdFile(_mdFilePending);
    _mdFilePending = null;
    return;
  }

  var nameEl = document.getElementById('mdfile-modal-name');
  if (nameEl) {
    nameEl.innerHTML = '<i class="ti ti-file-text"></i> ' +
      (typeof escHtml === 'function' ? escHtml(_mdFilePending.name) : _mdFilePending.name);
  }

  // Action cards use the native :disabled attribute (styles in CSS) — no
  // inline opacity/pointer-events fiddling needed.
  var curBtn = document.getElementById('mdfile-current-btn');
  if (curBtn) {
    var hasCurrent = !!(state.currentId && getConv(state.currentId));
    curBtn.disabled = !hasCurrent;
  }
  // 'Add to project' is only useful when a project exists AND the file lives
  // on disk (project sources are paths, not in-memory blobs).
  var projBtn = document.getElementById('mdfile-project-btn');
  if (projBtn) {
    var hasProjects = !!(state.projects && state.projects.length);
    var hasPath = !!(_mdFilePending && _mdFilePending.path);
    projBtn.disabled = !hasProjects || !hasPath;
    projBtn.title = !hasPath
      ? 'Project sources need a file on disk (this one was pasted/dropped without a path).'
      : (!hasProjects ? 'Create a project first.' : 'Add to a project so every chat can see it.');
  }

  // Always start on the primary action grid, not the project sub-view.
  _mdFileShowActions();
  _renderMdFileRecent();
  modal.classList.add('show');
}

// Toggle the two sub-views inside the modal: primary actions, or project picker.
function _mdFileShowActions() {
  var actions = document.getElementById('mdfile-modal-actions');
  var projects = document.getElementById('mdfile-modal-projects');
  var recentLbl = document.getElementById('mdfile-modal-recent-label');
  var recent = document.getElementById('mdfile-modal-recent');
  if (actions)  actions.style.display = '';
  if (projects) projects.style.display = 'none';
  if (recentLbl) recentLbl.style.display = '';
  if (recent) recent.style.display = '';
}

function _mdFileShowProjects() {
  var actions = document.getElementById('mdfile-modal-actions');
  var projects = document.getElementById('mdfile-modal-projects');
  var recentLbl = document.getElementById('mdfile-modal-recent-label');
  var recent = document.getElementById('mdfile-modal-recent');
  if (actions)  actions.style.display = 'none';
  if (recentLbl) recentLbl.style.display = 'none';
  if (recent) recent.style.display = 'none';
  if (projects) projects.style.display = '';
  _renderMdFileProjects();
}

function mdFileBackToActions() { _mdFileShowActions(); }

function _renderMdFileProjects() {
  var list = document.getElementById('mdfile-modal-projects-list');
  if (!list) return;
  var projs = (state.projects || []).slice().sort(function(a, b) {
    var au = a.updatedAt || a.createdAt || 0;
    var bu = b.updatedAt || b.createdAt || 0;
    return bu - au;
  });
  if (!projs.length) {
    list.innerHTML = '<div style="font-size:12px;color:var(--fau-text-dim);padding:8px 4px">No projects yet. Create one from the sidebar first.</div>';
    return;
  }
  list.innerHTML = projs.map(function(p) {
    var name = typeof escHtml === 'function' ? escHtml(p.name || 'Untitled project') : (p.name || 'Untitled project');
    var srcCount = (p.sources || []).length;
    var sub = srcCount + ' ' + (srcCount === 1 ? 'source' : 'sources');
    return '<button class="mdfile-project-item" onclick="mdFileChoose(\'project-pick\',\'' +
      p.id + '\')">' +
      '<i class="ti ti-folder"></i>' +
      '<span class="mdfile-project-name">' + name + '</span>' +
      '<span class="mdfile-project-sub">' + sub + '</span>' +
    '</button>';
  }).join('');
}

function _renderMdFileRecent() {
  var wrap = document.getElementById('mdfile-modal-recent');
  var label = document.getElementById('mdfile-modal-recent-label');
  if (!wrap) return;
  var recent = (state.conversations || [])
    .filter(function(c) { return c && c.id !== state.currentId; })
    .slice(0, 6);
  if (!recent.length) {
    wrap.innerHTML = '';
    if (label) label.style.display = 'none';
    return;
  }
  if (label) label.style.display = '';
  wrap.innerHTML = recent.map(function(c) {
    var title = c.title || 'Untitled conversation';
    var safeTitle = typeof escHtml === 'function' ? escHtml(title) : title;
    return '<button class="mdfile-recent-item" onclick="mdFileChoose(\'conv\', \'' +
      c.id + '\')"><i class="ti ti-message"></i>' +
      '<span class="mdfile-recent-title">' + safeTitle + '</span></button>';
  }).join('');
}

function closeMdFileModal() {
  var modal = document.getElementById('mdfile-modal');
  if (modal) modal.classList.remove('show');
}

function mdFileChoose(target, convId) {
  var payload = _mdFilePending;
  if (!payload) { closeMdFileModal(); return; }

  // 'project' is the entry point — flip the modal to the project picker
  // sub-view without consuming the pending file. The actual add happens
  // on 'project-pick'.
  if (target === 'project') { _mdFileShowProjects(); return; }

  _mdFilePending = null;

  if (target === 'preview') {
    // Open the document in the artifact panel without attaching to a chat.
    // Ensure there's a conversation to host the artifact (artifacts persist
    // to the active conversation).
    if (!(state.currentId && getConv(state.currentId)) && typeof newConversation === 'function') {
      newConversation();
    }
    _previewMdFile(payload);
  } else if (target === 'project-pick') {
    // convId carries the projectId in this branch.
    _addMdFileToProject(payload, convId);
  } else {
    if (target === 'new') {
      if (typeof newConversation === 'function') newConversation();
    } else if (target === 'conv' && convId) {
      if (typeof loadConversation === 'function') loadConversation(convId);
    } else { // 'current'
      if (!(state.currentId && getConv(state.currentId)) && typeof newConversation === 'function') {
        newConversation();
      }
    }
    _attachMdFile(payload);
  }

  // Continue with any further queued files, else close.
  if (_mdFileQueue.length) {
    _showNextMdFile();
  } else {
    closeMdFileModal();
  }
}

// Add the dropped/opened markdown file to a project as a local source.
// Project sources are paths on disk — if the file was pasted into Fauna
// without ever touching disk (no payload.path), there's nothing to point at,
// so the button is disabled in _showNextMdFile().
async function _addMdFileToProject(payload, projectId) {
  if (!payload || !projectId) return;
  if (!payload.path) {
    if (typeof showToast === 'function') showToast('Cannot add — no file path available', true);
    return;
  }
  try {
    var r = await fetch('/api/projects/' + encodeURIComponent(projectId) + '/sources', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'local', path: payload.path, name: payload.name || undefined }),
    });
    if (!r.ok) {
      var err = await r.json().catch(function() { return {}; });
      throw new Error(err.error || ('HTTP ' + r.status));
    }
    var proj = (state.projects || []).find(function(p) { return p.id === projectId; });
    var projName = proj && proj.name ? proj.name : 'project';
    if (typeof showToast === 'function') showToast('Added ' + (payload.name || 'file') + ' to ' + projName);
    // Refresh project state so the new source shows up in settings.
    if (typeof loadProjects === 'function') { try { await loadProjects(); } catch (_) {} }
  } catch (e) {
    if (typeof showToast === 'function') showToast('Add to project failed: ' + (e && e.message), true);
  }
}

function _previewMdFile(payload) {
  if (!payload) return;
  var absPath = payload.path || '';
  if (typeof addArtifact !== 'function') {
    // No artifact subsystem available — fall back to attaching.
    _attachMdFile(payload);
    return;
  }
  var id = addArtifact({
    type: 'markdown',
    title: payload.name || 'document.md',
    content: payload.content || '',
    path: absPath || undefined,
    sourceUri: absPath ? ('file://' + absPath) : undefined,
  });
  if (typeof openArtifact === 'function') openArtifact(id);
  else if (typeof openArtifactPane === 'function') openArtifactPane();
  if (typeof showToast === 'function') {
    showToast('Previewing ' + (payload.name || 'document'));
  }
}

function _attachMdFile(payload) {
  if (!payload) return;
  var absPath = payload.path || '';
  var att = {
    type: 'file',
    name: payload.name || 'document.md',
    content: (payload.content || '').slice(0, 200000),
    size: (payload.content || '').length,
    mime: 'text/markdown',
    sourceUri: absPath ? ('file://' + absPath) : ('attachment://' + encodeURIComponent(payload.name || 'document.md')),
  };
  if (absPath) att.path = absPath;
  if (typeof addAttachment === 'function') addAttachment(att);
  if (typeof showToast === 'function') {
    showToast('Attached ' + att.name + ' — type a message to send it');
  }
  try { document.getElementById('msg-input')?.focus(); } catch (_) {}
}

if (typeof window !== 'undefined') {
  window.handleIncomingMdFile = handleIncomingMdFile;
  window.closeMdFileModal = closeMdFileModal;
  window.mdFileChoose = mdFileChoose;
  window.mdFileBackToActions = mdFileBackToActions;
}
