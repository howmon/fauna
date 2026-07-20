// ── Init ──────────────────────────────────────────────────────────────────

// Parse per-window launch parameters (?conv=...&project=...) used by the
// multi-window feature. These override the persisted active conversation /
// project for THIS window only; we never write them back to localStorage so
// closing a secondary window does not change the default the primary window
// boots into.
function _faunaLaunchParams() {
  try {
    var p = new URLSearchParams(window.location.search || '');
    return {
      convId:    p.get('conv')    || null,
      projectId: p.get('project') || null,
      blank:     p.get('blank')   === '1',
      restored:  p.get('restored') === '1',
    };
  } catch (_) {
    return { convId: null, projectId: null, blank: false, restored: false };
  }
}

// Cheap signature of a conversation's rendered transcript. Changes only when
// the visible message list changes (a message added/removed, or the last
// message's content grows/shrinks — e.g. a truncated local copy being
// backfilled). Metadata-only bumps (title, updatedAt, usage, background
// summary) leave it unchanged, so we can skip a costly DOM rebuild.
function _convTranscriptSig(conv) {
  var m = (conv && conv.messages) || [];
  var last = m[m.length - 1];
  var lastLen = 0;
  if (last) {
    if (typeof last.content === 'string') lastLen = last.content.length;
    else if (Array.isArray(last.content)) lastLen = last.content.length;
  }
  return m.length + '|' + lastLen + '|' + ((last && last.role) || '');
}

// Hydrate: merge server-side conversations into localStorage
async function _hydrateServerConvs() {
  try {
    var serverRes = await fetch('/api/conversations?full=1');
    if (!serverRes.ok) return;
    var serverConvs = await serverRes.json();
    if (!serverConvs.length) return;
    var localIds = new Set(state.conversations.map(function(c) { return c.id; }));
    var merged = false;
    // Snapshot the active conversation's transcript signature BEFORE merging so
    // we can tell whether the incoming sync actually changed what's on screen.
    var activeId = state.currentId;
    var activeSigBefore = _convTranscriptSig(getConv(activeId));
    var activeTruncated = false;
    // True when the local copy contains content that was trimmed for the
    // local quota cache — that text needs to be re-pulled from the server.
    function _isLocallyTruncated(conv) {
      var msgs = (conv && conv.messages) || [];
      for (var i = 0; i < msgs.length; i++) {
        var m = msgs[i];
        if (m && typeof m.content === 'string' && m.content.indexOf('[truncated for local cache]') !== -1) return true;
      }
      if (typeof conv.contextSummary === 'string' && conv.contextSummary.indexOf('[truncated for local cache]') !== -1) return true;
      if (typeof conv.systemPrompt   === 'string' && conv.systemPrompt.indexOf('[truncated for local cache]')   !== -1) return true;
      return false;
    }
    serverConvs.forEach(function(sc) {
      if (!localIds.has(sc.id)) {
        state.conversations.push(sc);
        merged = true;
      } else {
        var local = state.conversations.find(function(c) { return c.id === sc.id; });
        var serverNewer    = (sc.updatedAt || sc.createdAt || 0) > (local.updatedAt || local.createdAt || 0);
        var serverHasMore  = (sc.messages || []).length > (local.messages || []).length;
        // If the local cache is truncated, the server copy (which now holds
        // full message bodies) is preferred even when the counts/timestamps
        // tie. Without this, reopening a long conversation after a restart
        // keeps showing the "…[truncated for local cache]" placeholder.
        var localTruncated = _isLocallyTruncated(local);
        if (local && (serverNewer || serverHasMore || localTruncated)) {
          if (sc.id === activeId && localTruncated) activeTruncated = true;
          Object.assign(local, sc);
          merged = true;
        }
      }
    });
    if (merged) {
      state.conversations.sort(function(a, b) { return (b.updatedAt || b.createdAt || 0) - (a.updatedAt || a.createdAt || 0); });
      saveConversations();
      renderConvList();
      if (activeId && getConv(activeId)) {
        var activeConv = getConv(activeId);
        if (activeConv && activeConv._streaming) {
          if (typeof showMessages === 'function') showMessages({ preserveAppPage: true });
          if (typeof setBusy === 'function') setBusy(true);
        } else if (activeTruncated || _convTranscriptSig(activeConv) !== activeSigBefore) {
          // The visible transcript genuinely changed (new messages from another
          // device, or a truncated copy backfilled) — rebuild the rendered DOM.
          purgeConvDom(activeId);
          loadConversation(activeId, { preserveAppPage: true });
        } else {
          // Metadata-only bump (title / updatedAt / usage / background summary).
          // Leave the rendered transcript — and its recommended-actions bar —
          // untouched so it doesn't flicker; just refresh the topbar title.
          var _tt = document.getElementById('topbar-title');
          if (_tt && activeConv.title) { _tt.textContent = activeConv.title; _tt.title = activeConv.title; }
        }
      }
    }
  } catch (_) {}
}

function _startConversationRealtimeSync() {
  if (!window.EventSource || window._conversationEvents) return;
  try {
    var _convStreamUrl = (window.faunaStreamUrl ? window.faunaStreamUrl('/api/conversations/stream') : '/api/conversations/stream');
    var source = new EventSource(_convStreamUrl);
    window._conversationEvents = source;
    var timer = null;
    source.onmessage = function(evt) {
      try {
        var msg = JSON.parse(evt.data || '{}');
        if (msg.type === 'ready') return;
        if (timer) clearTimeout(timer);
        timer = setTimeout(function() { _hydrateServerConvs(); }, 120);
      } catch (_) {}
    };
    source.onerror = function() {
      source.close();
      window._conversationEvents = null;
      setTimeout(_startConversationRealtimeSync, 2500);
    };
  } catch (_) {}
}

// When the OS suspends network I/O (sleep, App Nap, long backgrounding) the
// SSE socket dies with ERR_NETWORK_IO_SUSPENDED. Reconnect immediately on
// wake / network-online instead of waiting for the back-off retry.
(function () {
  function _wakeReconnectConvStream() {
    var src = window._conversationEvents;
    if (src) {
      try { src.close(); } catch (_) {}
      window._conversationEvents = null;
    }
    if (typeof _startConversationRealtimeSync === 'function') _startConversationRealtimeSync();
  }
  document.addEventListener('visibilitychange', function () {
    if (document.visibilityState === 'visible') _wakeReconnectConvStream();
  });
  window.addEventListener('online', _wakeReconnectConvStream);
}());

// ── Sync engine event stream ──────────────────────────────────────────────
// Open a long-lived EventSource against /api/sync/events so the renderer
// re-paints automatically when a remote pull lands. Without this, projects
// or conversations synced in from another device stay invisible until the
// user re-opens an overlay or restarts the app.
//
// We debounce per-namespace because a single pull cycle can apply hundreds
// of records and we'd otherwise spam loadProjects() / _hydrateServerConvs().
function _startSyncEventStream() {
  if (!window.EventSource || window._syncEvents) return;
  try {
    var url = (window.faunaStreamUrl ? window.faunaStreamUrl('/api/sync/events') : '/api/sync/events');
    var source = new EventSource(url);
    window._syncEvents = source;
    var projTimer = null;
    var convTimer = null;
    function _refreshProjects() {
      if (typeof loadProjects !== 'function') return;
      loadProjects().then(function () {
        // If the All Projects overlay is open, re-paint it too.
        var page = document.getElementById('all-projects-page');
        if (page && page.style.display !== 'none' && typeof _renderAllProjectsPage === 'function') {
          _renderAllProjectsPage();
        }
        // If the Cloud Sync settings panel is open, refresh its project list.
        if (typeof window.renderCloudSyncPage === 'function') {
          var cs = document.getElementById('cs-projects');
          if (cs) window.renderCloudSyncPage();
        }
      }).catch(function () {});
    }
    function _refreshConvs() {
      if (typeof _hydrateServerConvs === 'function') _hydrateServerConvs();
    }
    source.onmessage = function (evt) {
      try {
        var msg = JSON.parse(evt.data || '{}');
        if (msg.type === 'ready') return;
        // 'apply' fires once per applied remote change; 'pull:end' fires
        // once per pull cycle and includes a per-ns count. Either signals
        // that local state may be stale.
        var nsTouched = {};
        if (msg.type === 'apply' && msg.ns) {
          nsTouched[msg.ns] = true;
        } else if (msg.type === 'pull:end' && msg.applied) {
          for (var k in msg.applied) {
            if (msg.applied[k] > 0) nsTouched[k] = true;
          }
        } else if (msg.type === 'bootstrap' && msg.ns) {
          // Our own bootstrap pushed local data; nothing to refresh, but
          // the cloud-sync panel might want to redraw if open.
          if (typeof window.renderCloudSyncPage === 'function') {
            var panel = document.getElementById('cs-projects');
            if (panel) window.renderCloudSyncPage();
          }
          return;
        } else if (msg.type === 'push:end') {
          // Push drained → keep the cloud-sync panel in sync if open.
          if (typeof window.renderCloudSyncPage === 'function') {
            var p2 = document.getElementById('cs-projects');
            if (p2) window.renderCloudSyncPage();
          }
          return;
        } else if (msg.type === 'locked' || msg.type === 'unlocked') {
          // E2E lock state changed — flip the cloud-sync panel between
          // dashboard and password-prompt views.
          if (typeof window.renderCloudSyncPage === 'function') {
            var visible = document.querySelector('.settings-page[data-page="cloud-sync"]');
            if (visible && visible.classList.contains('active')) {
              window.renderCloudSyncPage();
            }
          }
          return;
        }
        if (nsTouched.project) {
          if (projTimer) clearTimeout(projTimer);
          projTimer = setTimeout(_refreshProjects, 200);
        }
        if (nsTouched.conversation) {
          if (convTimer) clearTimeout(convTimer);
          convTimer = setTimeout(_refreshConvs, 200);
        }
      } catch (_) {}
    };
    source.onerror = function () {
      try { source.close(); } catch (_) {}
      window._syncEvents = null;
      // Same back-off as the conversation stream.
      setTimeout(_startSyncEventStream, 2500);
    };
  } catch (_) {}
}
(function () {
  function _wakeReconnectSyncStream() {
    var src = window._syncEvents;
    if (src) {
      try { src.close(); } catch (_) {}
      window._syncEvents = null;
    }
    _startSyncEventStream();
  }
  document.addEventListener('visibilitychange', function () {
    if (document.visibilityState === 'visible') _wakeReconnectSyncStream();
  });
  window.addEventListener('online', _wakeReconnectSyncStream);
}());

// Pre-load rules so getFigmaContext() works when chat starts
loadFigmaRules();

// Pre-load memory groups so getMemoryContext() is ready for the first chat
loadMemoryFromServer();

document.addEventListener('DOMContentLoaded', async () => {
  var launch = _faunaLaunchParams();
  // Apply ?project= BEFORE loadProjects() so its validation honors the override
  // without persisting it (in-memory only for this window).
  if (launch.projectId) state.activeProjectId = launch.projectId;
  // Blank new-window: also exit any active project (in-memory only; do not
  // touch localStorage so other windows keep their selection).
  else if (launch.blank) state.activeProjectId = null;
  // Restored window with no persisted project: this window was explicitly not
  // in a project last session, so honor that instead of falling back to the
  // global last-active-project default (otherwise non-project conversations
  // wrongly reopen inside the project with the project menu showing).
  else if (launch.restored) state.activeProjectId = null;

  await loadSysCtx();
  await loadModels();
  // Apply the diagnostic transcript-export visibility (hidden by default).
  if (typeof _applyConvExportVisibility === 'function') _applyConvExportVisibility();
  // Load projects and render the switcher
  if (typeof loadProjects === 'function') await loadProjects();
  if (typeof renderProjectSwitcher === 'function') renderProjectSwitcher();
  if (typeof renderProjectSidebarList === 'function') renderProjectSidebarList();
  // Start global port polling (shows active processes count in topbar)
  if (typeof _startPortsPolling === 'function') _startPortsPolling();
  checkAuth();
  renderConvList();
  document.getElementById('sys-prompt-input').value = state.systemPrompt;
  updateSysScopeHint();

  // Initialize agent system
  initAgentSystem();

  // Initialize voice control
  initVoice();

  // Agent @mention detection on input
  var msgInput = document.getElementById('msg-input');
  msgInput.addEventListener('input', function(e) { handleAgentInput(e); if (typeof handleSlashInput === 'function') handleSlashInput(e); if (typeof aiAutocompleteOnInput === 'function') aiAutocompleteOnInput(e); });
  msgInput.addEventListener('keydown', function(e) {
    if (typeof handleSlashAutocompleteKey === 'function' && handleSlashAutocompleteKey(e)) return;
    if (typeof aiAutocompleteOnKeydown === 'function' && aiAutocompleteOnKeydown(e)) return;
    handleAgentAutocompleteKey(e);
  });

  // Open an explicit conversation deep link; otherwise land on Home by default.
  // Done BEFORE hydration so the page is never blank while the 24 MB server
  // sync is in flight. _hydrateServerConvs() re-renders the conversation list
  // and home page itself once the merge is complete.
  if (launch.convId && getConv(launch.convId)) {
    loadConversation(launch.convId);
  } else if (typeof openHomePage === 'function') {
    openHomePage();
  } else {
    showEmpty();
  }

  // Hydrate conversations: merge server-side conversations with localStorage
  // This ensures conversations from CLI/mobile are visible, and standalone app
  // doesn't lose conversations when Electron's localStorage resets (new build, etc.)
  // First, if the client cache is in IndexedDB mode, fill in message bodies
  // from IDB before we ask the server for missing convs.
  if (window.FaunaConvCache && window.FaunaConvCache.getMode() === 'indexeddb') {
    try { await window.FaunaConvCache.hydrateBodies(state.conversations); } catch (_) {}
  }
  await _hydrateServerConvs();
  _startConversationRealtimeSync();
  _startSyncEventStream();

  // Re-hydrate when window regains focus (picks up mobile/CLI conversations)
  window.addEventListener('focus', function() { _hydrateServerConvs(); });

  // One-time migration: sync localStorage conversations to server for CLI/mobile access
  if (!localStorage.getItem('fauna-convs-synced') && state.conversations.length) {
    _syncAllConvsToServer();
    localStorage.setItem('fauna-convs-synced', '1');
  }

  // Markdown files opened via a file association (double-click, dock drop,
  // command line) are delivered by the main process — prompt the user to start
  // a new conversation or attach the document to an existing one.
  try {
    if (window.faunaApp && typeof window.faunaApp.onOpenFile === 'function') {
      window.faunaApp.onOpenFile(function(payload) {
        if (typeof handleIncomingMdFile === 'function') handleIncomingMdFile(payload);
      });
    }
    if (window.faunaApp && typeof window.faunaApp.onOpenFileError === 'function') {
      window.faunaApp.onOpenFileError(function(payload) {
        if (typeof showToast === 'function') {
          showToast('Could not open ' + ((payload && payload.name) || 'file') +
            ((payload && payload.error) ? ': ' + payload.error : ''));
        }
      });
    }
  } catch (_) {}
});

// ── Help panel (redirects to Settings → Help) ─────────────────────────────
function toggleHelp() {
  if (typeof openSettingsPage === 'function') openSettingsPage('help');
}

// ── Keyboard shortcuts ────────────────────────────────────────────────────
document.addEventListener('keydown', function(e) {
  if (e.key === 'Escape' && figmaRulesOpen)  { toggleFigmaRules(); }
  if (e.key === 'Escape' && figmaSetupOpen)  { toggleFigmaSetup(); }

  // Cmd+S (macOS) / Ctrl+S (Windows/Linux) — save the open project file when a
  // file viewer/editor is active. Falls through to the browser default
  // otherwise so we never hijack Save in unrelated contexts.
  if ((e.metaKey || e.ctrlKey) && !e.altKey && (e.key === 's' || e.key === 'S')) {
    var hasOpenFile = window._lastProjectFileSrcId && window._lastProjectFilePath;
    var hasEditor = (typeof _projMonacoEditor !== 'undefined' && _projMonacoEditor) ||
                    (typeof _explorerMonaco !== 'undefined' && _explorerMonaco);
    if (hasOpenFile && hasEditor && typeof saveProjectFile === 'function') {
      e.preventDefault();
      saveProjectFile();
    }
  }
});

