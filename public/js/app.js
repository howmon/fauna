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

  // Agent @mention detection on input
  var msgInput = document.getElementById('msg-input');
  msgInput.addEventListener('input', function(e) { handleAgentInput(e); if (typeof handleSlashInput === 'function') handleSlashInput(e); });
  msgInput.addEventListener('keydown', function(e) {
    if (typeof handleSlashAutocompleteKey === 'function' && handleSlashAutocompleteKey(e)) return;
    handleAgentAutocompleteKey(e);
  });

  // Load last conversation or show empty state
  if (state.conversations.length) loadConversation(state.conversations[0].id);
  else showEmpty();
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
