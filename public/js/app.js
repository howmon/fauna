// ── Init ──────────────────────────────────────────────────────────────────

// Pre-load rules so getFigmaContext() works when chat starts
loadFigmaRules();

// Pre-load memory groups so getMemoryContext() is ready for the first chat
loadMemoryFromServer();

document.addEventListener('DOMContentLoaded', async () => {
  await loadSysCtx();
  await loadModels();
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
  try {
    var serverRes = await fetch('/api/conversations?full=1');
    if (serverRes.ok) {
      var serverConvs = await serverRes.json();
      if (serverConvs.length) {
        var localIds = new Set(state.conversations.map(function(c) { return c.id; }));
        var merged = false;
        // Add server conversations not already in localStorage
        serverConvs.forEach(function(sc) {
          if (!localIds.has(sc.id)) {
            state.conversations.push(sc);
            merged = true;
          } else {
            // If server version has more messages, prefer it (e.g. CLI extended the conversation)
            var local = state.conversations.find(function(c) { return c.id === sc.id; });
            if (local && (sc.messages || []).length > (local.messages || []).length) {
              Object.assign(local, sc);
              merged = true;
            }
          }
        });
        if (merged) {
          // Sort by createdAt descending
          state.conversations.sort(function(a, b) { return (b.createdAt || 0) - (a.createdAt || 0); });
          saveConversations();
          renderConvList();
        }
      }
    }
  } catch (_) {}

  // Load last conversation or show empty state
  if (state.conversations.length) loadConversation(state.conversations[0].id);
  else showEmpty();

  // One-time migration: sync localStorage conversations to server for CLI/mobile access
  if (!localStorage.getItem('fauna-convs-synced') && state.conversations.length) {
    _syncAllConvsToServer();
    localStorage.setItem('fauna-convs-synced', '1');
  }
});

// ── Help panel ────────────────────────────────────────────────────────────
var helpOpen = false;
function toggleHelp() {
  helpOpen = !helpOpen;
  document.getElementById('help-panel').classList.toggle('open', helpOpen);
}

// ── Keyboard shortcuts ────────────────────────────────────────────────────
document.addEventListener('keydown', function(e) {
  if (e.key === 'Escape' && playbookOpen)     { togglePlaybook(); }
  if (e.key === 'Escape' && agentRulesOpen)  { toggleAgentRules(); }
  if (e.key === 'Escape' && figmaRulesOpen)  { toggleFigmaRules(); }
  if (e.key === 'Escape' && figmaSetupOpen)  { toggleFigmaSetup(); }
  if (e.key === 'Escape' && helpOpen)        { toggleHelp(); }
});
