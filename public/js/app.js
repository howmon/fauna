// ── Init ──────────────────────────────────────────────────────────────────

// Hydrate: merge server-side conversations into localStorage
async function _hydrateServerConvs() {
  try {
    var serverRes = await fetch('/api/conversations?full=1');
    if (!serverRes.ok) return;
    var serverConvs = await serverRes.json();
    if (!serverConvs.length) return;
    var localIds = new Set(state.conversations.map(function(c) { return c.id; }));
    var merged = false;
    serverConvs.forEach(function(sc) {
      if (!localIds.has(sc.id)) {
        state.conversations.push(sc);
        merged = true;
      } else {
        var local = state.conversations.find(function(c) { return c.id === sc.id; });
        var serverNewer = (sc.updatedAt || sc.createdAt || 0) > (local.updatedAt || local.createdAt || 0);
        var serverHasMore = (sc.messages || []).length > (local.messages || []).length;
        if (local && (serverNewer || serverHasMore)) {
          Object.assign(local, sc);
          merged = true;
        }
      }
    });
    if (merged) {
      state.conversations.sort(function(a, b) { return (b.updatedAt || b.createdAt || 0) - (a.updatedAt || a.createdAt || 0); });
      saveConversations();
      renderConvList();
      if (state.currentId && getConv(state.currentId)) {
        purgeConvDom(state.currentId);
        loadConversation(state.currentId);
      }
    }
  } catch (_) {}
}

function _startConversationRealtimeSync() {
  if (!window.EventSource || window._conversationEvents) return;
  try {
    var source = new EventSource('/api/conversations/stream');
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

// Pre-load rules so getFigmaContext() works when chat starts
loadFigmaRules();

// Pre-load memory groups so getMemoryContext() is ready for the first chat
loadMemoryFromServer();

document.addEventListener('DOMContentLoaded', async () => {
  await loadSysCtx();
  await loadModels();
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
  msgInput.addEventListener('input', function(e) { handleAgentInput(e); if (typeof handleSlashInput === 'function') handleSlashInput(e); });
  msgInput.addEventListener('keydown', function(e) {
    if (typeof handleSlashAutocompleteKey === 'function' && handleSlashAutocompleteKey(e)) return;
    handleAgentAutocompleteKey(e);
  });

  // Hydrate conversations: merge server-side conversations with localStorage
  // This ensures conversations from CLI/mobile are visible, and standalone app
  // doesn't lose conversations when Electron's localStorage resets (new build, etc.)
  await _hydrateServerConvs();
  _startConversationRealtimeSync();

  // Re-hydrate when window regains focus (picks up mobile/CLI conversations)
  window.addEventListener('focus', function() { _hydrateServerConvs(); });

  // Load last conversation or show empty state
  if (state.conversations.length) loadConversation(state.conversations[0].id);
  else showEmpty();

  // One-time migration: sync localStorage conversations to server for CLI/mobile access
  if (!localStorage.getItem('fauna-convs-synced') && state.conversations.length) {
    _syncAllConvsToServer();
    localStorage.setItem('fauna-convs-synced', '1');
  }
});

// ── Help panel (redirects to Settings → Help) ─────────────────────────────
function toggleHelp() {
  if (typeof openSettingsPage === 'function') openSettingsPage('help');
}

// ── Keyboard shortcuts ────────────────────────────────────────────────────
document.addEventListener('keydown', function(e) {
  if (e.key === 'Escape' && figmaRulesOpen)  { toggleFigmaRules(); }
  if (e.key === 'Escape' && figmaSetupOpen)  { toggleFigmaSetup(); }
});
