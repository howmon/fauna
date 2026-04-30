// ── Agent System — Core Runtime ───────────────────────────────────────────
// Manages agent loading, invocation, @mention parsing, autocomplete,
// context handoff, and sandbox enforcement.

var AGENTS_KEY  = 'fauna-installed-agents';
var activeAgent = null;   // { name, manifest, systemPrompt } or null = default mode
var installedAgents = []; // cached list from server
var agentAutocompleteOpen = false;

// ── Built-in agents (moved to store) ─────────────────────────────────────

var BUILTIN_AGENTS = [
  {
    name: 'research',
    displayName: 'Research Agent',
    description: 'Deep web research with citations and source verification',
    icon: 'ti-search',
    category: 'productivity',
    builtin: true,
    permissions: { browser: true, shell: false, fileRead: [], fileWrite: ['~/Research'], network: { allowedDomains: ['*'], blockAll: false }, figma: false },
    systemPrompt: [
      'You are a deep research agent. Your workflow:',
      '1. Break the research question into sub-queries',
      '2. Use the browser to search and extract information from multiple sources',
      '3. Cross-reference facts across sources',
      '4. Synthesise findings into a structured report with citations',
      '5. Flag any conflicting information between sources',
      '',
      'Always cite your sources with URLs. Never fabricate information.',
      'When uncertain, say so explicitly and suggest follow-up queries.',
      'Save final reports to ~/Research/ when the user requests it.'
    ].join('\n')
  },
  {
    name: 'coder',
    displayName: 'Coding Agent',
    description: 'Focused coding assistant with shell and file access',
    icon: 'ti-code',
    category: 'development',
    builtin: true,
    permissions: { browser: false, shell: true, fileRead: ['*'], fileWrite: ['*'], network: { allowedDomains: [], blockAll: true }, figma: false },
    systemPrompt: [
      'You are a focused coding agent. You have full shell and file access.',
      'Your workflow:',
      '1. Understand the coding task',
      '2. Read relevant files to gather context',
      '3. Write or edit code',
      '4. Run tests or linting to verify',
      '5. Iterate until the code is correct',
      '',
      'Write clean, idiomatic code. Prefer small, focused changes.',
      'Always verify your changes compile/run before reporting done.',
      'Explain what you changed and why.'
    ].join('\n')
  },
  {
    name: 'writer',
    displayName: 'Writing Agent',
    description: 'Long-form writing, editing, and document creation',
    icon: 'ti-pencil',
    category: 'productivity',
    builtin: true,
    permissions: { browser: true, shell: false, fileRead: ['~/Documents', '~/Downloads'], fileWrite: ['~/Documents'], network: { allowedDomains: ['*'], blockAll: false }, figma: false },
    systemPrompt: [
      'You are a professional writing agent. You help with:',
      '- Drafting articles, reports, proposals, and documentation',
      '- Editing and improving existing text',
      '- Research to support writing',
      '- Structuring complex documents',
      '',
      'Write clearly and concisely. Match the requested tone and style.',
      'When editing, explain your changes. Offer alternatives when appropriate.',
      'Save documents to ~/Documents/ when requested.'
    ].join('\n')
  },
  {
    name: 'designer',
    displayName: 'Design Agent',
    description: 'Figma design assistant for UI/UX work',
    icon: 'ti-vector-triangle',
    category: 'design',
    builtin: true,
    permissions: { browser: true, shell: false, fileRead: [], fileWrite: [], network: { allowedDomains: ['*'], blockAll: false }, figma: true },
    systemPrompt: [
      'You are a design agent with access to Figma. You help with:',
      '- Creating and modifying Figma designs',
      '- UI/UX reviews and recommendations',
      '- Design system work',
      '- Generating design specs and documentation',
      '',
      'Use the Figma tools available to read and modify designs directly.',
      'Follow design best practices and accessibility guidelines.',
      'When making changes, explain your design decisions.'
    ].join('\n')
  }
];

// ── Agent loading ────────────────────────────────────────────────────────

async function loadInstalledAgents() {
  try {
    var r = await fetch('/api/agents');
    var d = await r.json();
    installedAgents = (d.agents || []).map(function(a) {
      return a;
    });
  } catch (_) {
    installedAgents = [];
  }
}

async function deleteAgent(name) {
  if (!confirm('Delete this agent? This cannot be undone.')) return;
  try {
    var r = await fetch('/api/agents/' + encodeURIComponent(name), { method: 'DELETE' });
    if (!r.ok) { showToast('Failed to delete agent'); return; }
    // Deactivate if active
    if (activeAgent && activeAgent.name === name) {
      var conv = state.currentId ? getConv(state.currentId) : null;
      deactivateAgent(conv);
      updateAgentChipFromState();
    }
    await loadInstalledAgents();
    renderAgentList();
    // Clear any pending update for this agent
    if (typeof pendingUpdates !== 'undefined' && pendingUpdates[name]) {
      delete pendingUpdates[name];
      if (typeof showUpdateBadge === 'function') showUpdateBadge();
    }
    showToast('Agent deleted');
  } catch (_) {
    showToast('Failed to delete agent');
  }
}

function getAllAgents() {
  return installedAgents.slice();
}

function findAgent(name) {
  if (!name) return null;
  var n = name.toLowerCase();
  return getAllAgents().find(function(a) { return a.name.toLowerCase() === n; }) || null;
}

// ── @agent mention parsing ───────────────────────────────────────────────

function parseAgentMention(text) {
  if (!text) return { agent: null, text: text };
  var match = text.match(/^@([\w-]+)\s*/);
  if (!match) {
    // Check for inline @mention (mid-conversation agent switch)
    var inline = text.match(/@([\w-]+)\s*/);
    if (inline) {
      var agent = findAgent(inline[1]);
      if (agent) {
        return { agent: agent.name, text: text.replace(inline[0], '').trim(), inline: true };
      }
    }
    return { agent: null, text: text };
  }
  var agent = findAgent(match[1]);
  if (!agent) return { agent: null, text: text }; // not a known agent, treat as normal text
  return { agent: agent.name, text: text.slice(match[0].length), inline: false };
}

// ── Agent activation ─────────────────────────────────────────────────────

async function activateAgent(agentName, conv, isInline) {
  var agent = findAgent(agentName);
  if (!agent) {
    showToast('Agent "' + agentName + '" not found');
    return false;
  }

  // Skip if this agent is already active (prevents duplicate dividers)
  if (activeAgent && activeAgent.name === agent.name) {
    return true;
  }

  var prevAgent = activeAgent;
  var summary = '';

  // If switching mid-conversation, generate a context summary
  if (isInline && conv && conv.messages.length > 0) {
    summary = await generateConversationSummary(conv);
  }

  activeAgent = {
    name: agent.name,
    displayName: agent.displayName,
    manifest: agent,
    systemPrompt: agent.systemPrompt || '',
    permissions: agent.permissions || {},
    contextSummary: summary
  };

  // Update UI
  updateAgentBadge();

  // Add divider to chat if switching
  if (conv && (isInline || prevAgent)) {
    addAgentDivider(conv.id, agent.displayName, !prevAgent);
  }

  // Auto-enable Figma MCP if agent has figma permission and it's not already on
  if (agent.permissions && agent.permissions.figma && !state.figmaMCPEnabled) {
    if (typeof toggleFigmaMCP === 'function') {
      toggleFigmaMCP();
      dbg('[Agent] Auto-enabled Figma MCP for agent: ' + agent.displayName, 'info');
    }
  }

  dbg('[Agent] Activated: ' + agent.displayName + (summary ? ' (with context summary)' : ''), 'info');
  if (typeof recordAgentInvocation === 'function') recordAgentInvocation(agent.name);
  return true;
}

function deactivateAgent(conv) {
  if (!activeAgent) return;
  var prevName = activeAgent.displayName;
  activeAgent = null;
  updateAgentBadge();
  if (conv) {
    addAgentDivider(conv.id, null, false);
  }
  dbg('[Agent] Deactivated: ' + prevName, 'info');
}

// ── Context summary generation ───────────────────────────────────────────

async function generateConversationSummary(conv) {
  if (!conv || !conv.messages || conv.messages.length === 0) return '';

  // Build a condensed version of the conversation for summarisation
  var msgs = conv.messages.slice(-20).map(function(m) {
    var text = typeof m.content === 'string' ? m.content : (m.content || []).map(function(c) { return c.text || ''; }).join(' ');
    return m.role + ': ' + text.slice(0, 500);
  }).join('\n');

  try {
    var r = await fetch('/api/chat-summary', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ messages: msgs, model: state.model })
    });
    var d = await r.json();
    return d.summary || '';
  } catch (_) {
    // Fallback: just take the last few messages as raw text
    return conv.messages.slice(-5).map(function(m) {
      var text = typeof m.content === 'string' ? m.content : '';
      return m.role + ': ' + text.slice(0, 200);
    }).join('\n');
  }
}

// ── Agent system prompt builder ──────────────────────────────────────────

function getAgentSystemPrompt() {
  if (!activeAgent) return '';

  var parts = [];
  parts.push('## Active Agent: ' + activeAgent.displayName);
  parts.push('');
  parts.push(activeAgent.systemPrompt);

  // Permission summary
  var perms = activeAgent.permissions;
  if (perms) {
    parts.push('');
    parts.push('### Agent Permissions');
    parts.push('- Browser: ' + (perms.browser ? 'yes' : 'no'));
    parts.push('- Shell: ' + (perms.shell ? 'yes' : 'no'));
    if (perms.fileRead && perms.fileRead.length) parts.push('- File read: ' + perms.fileRead.join(', '));
    if (perms.fileWrite && perms.fileWrite.length) parts.push('- File write: ' + perms.fileWrite.join(', '));
    if (perms.figma) parts.push('- Figma: yes');
    if (perms.network && perms.network.allowedDomains && perms.network.allowedDomains.length) {
      parts.push('- Network: ' + (perms.network.allowedDomains[0] === '*' ? 'all domains' : perms.network.allowedDomains.join(', ')));
    }
  }

  // Context summary from prior conversation
  if (activeAgent.contextSummary) {
    parts.push('');
    parts.push('### Prior Conversation Context');
    parts.push(activeAgent.contextSummary);
  }

  // Learnings journal (consolidated patterns from past sessions)
  if (activeAgent.manifest && activeAgent.manifest._learnings) {
    parts.push('');
    parts.push('### Learnings from Past Sessions');
    parts.push(activeAgent.manifest._learnings);
  }

  // Orchestrator mode: inject available agents catalog and delegation protocol
  if (activeAgent.manifest && activeAgent.manifest.orchestrator) {
    parts.push('');
    parts.push('### Orchestrator Mode');
    parts.push('You are an orchestrator agent. You can delegate tasks to other specialized agents and coordinate their work.');
    parts.push('');
    parts.push('#### Available Agents');

    // Use bundled sub-agents if declared, otherwise fall back to all installed agents
    var hasSubAgents = activeAgent.manifest._subAgents && activeAgent.manifest._subAgents.length > 0;
    var delegatableAgents = hasSubAgents ? activeAgent.manifest._subAgents : getAllAgents();
    for (var i = 0; i < delegatableAgents.length; i++) {
      var a = delegatableAgents[i];
      if (a.name === activeAgent.name) continue; // skip self
      parts.push('- **' + a.displayName + '** (`' + a.name + '`): ' + (a.description || 'No description') +
        (a.category ? ' [' + a.category + ']' : ''));
    }
    if (hasSubAgents) {
      parts.push('');
      parts.push('These are your built-in sub-agents. They work as part of your pipeline — delegate to them by name.');
    }
    parts.push('');
    parts.push('#### Delegation Protocol');
    parts.push('To delegate a task to another agent, use this syntax in your response:');
    parts.push('');
    parts.push('```');
    parts.push('[DELEGATE:agent-name]');
    parts.push('Your task instructions for this agent');
    parts.push('[/DELEGATE]');
    parts.push('```');
    parts.push('');
    parts.push('You can include multiple delegation blocks. After all delegations execute, you will receive the results and should synthesize a final answer.');
    parts.push('');
    parts.push('#### Guidelines');
    parts.push('- CRITICAL: When delegating, output ONLY the [DELEGATE:...] blocks — no prose, no partial answers, no explanations before them. The sub-agents will do the work; your job here is only to dispatch.');
    parts.push('- Analyze the user\'s request and break it into clear sub-tasks, one per agent.');
    parts.push('- Provide specific, self-contained instructions in each delegation block so the sub-agent has everything it needs.');
    parts.push('- Keep each delegation small enough to describe in 2-3 sentences. If a task is bigger, split it into multiple delegations.');
    parts.push('- Do NOT perform the sub-agent\'s work yourself. Do NOT write out content that the delegated agent is supposed to produce.');
    parts.push('- Only respond without delegating if the request is genuinely trivial (e.g. a one-sentence factual question).');
    parts.push('- After receiving all delegation results, synthesize and present a unified response to the user.');
    parts.push('');
    parts.push('#### Sub-Agent Completion Signals');
    parts.push('Sub-agents MUST end their response with exactly one of these markers:');
    parts.push('- `[TASK_COMPLETE]` — task finished successfully');
    parts.push('- `[TASK_PARTIAL: <what remains>]` — made progress but could not fully finish');
    parts.push('- `[TASK_BLOCKED: <reason>]` — could not proceed due to a blocker');
    parts.push('- `[TASK_FAILED: <reason>]` — attempted but failed');
    parts.push('When synthesizing results, check these markers to know which tasks succeeded vs need follow-up.');
  }

  return parts.join('\n');
}

// ── UI: Agent badge in topbar ────────────────────────────────────────────

function updateAgentBadge() {
  var badge = document.getElementById('agent-badge');
  if (!badge) return;
  if (activeAgent) {
    var agent = activeAgent.manifest;
    var orchestratorIcon = agent.orchestrator ? ' <i class="ti ti-hierarchy-3" style="font-size:11px;opacity:0.7" title="Orchestrator"></i>' : '';
    badge.innerHTML = agentIconHtml(agent) + ' ' + escHtml(activeAgent.displayName) + orchestratorIcon;
    badge.style.display = 'inline-flex';
    badge.title = 'Active agent: ' + activeAgent.displayName + (agent.orchestrator ? ' (orchestrator)' : '') + ' — click to deactivate';
  } else {
    badge.style.display = 'none';
    badge.innerHTML = '';
  }
}

// ── UI: Agent divider in chat ────────────────────────────────────────────

function addAgentDivider(convId, agentName, isJoining) {
  // Append into the specific conv container so it sits in conversation order
  var container = convId && typeof getConvInner === 'function' ? getConvInner(convId) : document.getElementById('messages-inner');
  if (!container) return;
  var div = document.createElement('div');
  div.className = 'agent-divider';
  if (agentName) {
    div.innerHTML = '<span class="agent-divider-line"></span>' +
      '<span class="agent-divider-label">' + escHtml(agentName) + ' joined</span>' +
      '<span class="agent-divider-line"></span>';
  } else {
    div.innerHTML = '<span class="agent-divider-line"></span>' +
      '<span class="agent-divider-label">Returned to default mode</span>' +
      '<span class="agent-divider-line"></span>';
  }
  container.appendChild(div);
  scrollBottom();
}

// ── UI: @ Autocomplete ──────────────────────────────────────────────────

function showAgentAutocomplete(filter) {
  var dropdown = document.getElementById('agent-autocomplete');
  if (!dropdown) return;

  var agents = getAllAgents();
  if (filter) {
    var f = filter.toLowerCase();
    agents = agents.filter(function(a) {
      return a.name.toLowerCase().includes(f) || a.displayName.toLowerCase().includes(f);
    });
  }

  if (agents.length === 0 && !filter) {
    dropdown.style.display = 'none';
    agentAutocompleteOpen = false;
    return;
  }

  var html = agents.map(function(a) {
    return '<div class="agent-ac-item" data-agent="' + escHtml(a.name) + '" onclick="selectAgentFromAutocomplete(\'' + escHtml(a.name) + '\')">' +
      agentIconHtml(a, 'agent-ac-icon') +
      '<div class="agent-ac-info">' +
        '<span class="agent-ac-name">@' + escHtml(a.displayName || a.name) + '</span>' +
        (a.description ? '<span class="agent-ac-desc">' + escHtml(a.description) + '</span>' : '') +
      '</div>' +
    '</div>';
  }).join('');

  // Add footer actions
  html += '<div class="agent-ac-divider"></div>';
  html += '<div class="agent-ac-item agent-ac-action" onclick="openAgentStore()">' +
    '<i class="ti ti-package agent-ac-icon"></i>' +
    '<div class="agent-ac-info"><span class="agent-ac-name">Browse Agent Store</span></div></div>';
  html += '<div class="agent-ac-item agent-ac-action" onclick="openAgentBuilder()">' +
    '<i class="ti ti-plus agent-ac-icon"></i>' +
    '<div class="agent-ac-info"><span class="agent-ac-name">Create New Agent</span></div></div>';

  dropdown.innerHTML = html;
  dropdown.style.display = 'block';
  agentAutocompleteOpen = true;
}

function hideAgentAutocomplete() {
  var dropdown = document.getElementById('agent-autocomplete');
  if (dropdown) dropdown.style.display = 'none';
  agentAutocompleteOpen = false;
}

function selectAgentFromAutocomplete(name) {
  var input = document.getElementById('msg-input');
  var mention = getAtMentionAtCursor(input);
  if (mention) {
    // Replace the @partial with just a space (agent goes into chip bar)
    var text = input.value;
    input.value = text.substring(0, mention.start) + text.substring(mention.end);
    // Place cursor where the mention was
    var newPos = mention.start;
    input.setSelectionRange(newPos, newPos);
  } else {
    // Fallback: remove leading @mention
    var text = input.value;
    var match = text.match(/^@[\w-]*\s*/);
    if (match) input.value = text.slice(match[0].length);
  }
  // Add the agent as a chip (supports multiple)
  addAgentChip(name);
  input.focus();
  hideAgentAutocomplete();
  resizeTextarea(input);
}

// ── Agent Chip in input ──────────────────────────────────────────────────

// Track agent chips (multiple supported)
var _agentChips = []; // [agentName, ...]

function _saveAgentChipsToConv() {
  var conv = state.currentId ? getConv(state.currentId) : null;
  if (conv) { conv.activeAgentChips = _agentChips.slice(); saveConversations(); }
}

function showAgentChip(name) {
  _agentChips = [name];
  renderAgentChips();
  _saveAgentChipsToConv();
  var conv = state.currentId ? getConv(state.currentId) : null;
  activateAgent(name, conv, false).then(function() { renderAgentList(); });
}

function addAgentChip(name) {
  if (_agentChips.indexOf(name) !== -1) return; // already added
  _agentChips.push(name);
  _loadingAgents[name] = true;
  renderAgentChips();
  _saveAgentChipsToConv();
  // Activate the most recently added agent
  var conv = state.currentId ? getConv(state.currentId) : null;
  activateAgent(name, conv, _agentChips.length > 1).then(function() {
    delete _loadingAgents[name];
    renderAgentChips();
    renderAgentList();
  });
}

function removeAgentChipByName(name) {
  _agentChips = _agentChips.filter(function(n) { return n !== name; });
  renderAgentChips();
  _saveAgentChipsToConv();
  var conv = state.currentId ? getConv(state.currentId) : null;
  if (_agentChips.length > 0) {
    // Activate the remaining (last) agent
    activateAgent(_agentChips[_agentChips.length - 1], conv, true).then(function() { renderAgentList(); });
  } else {
    deactivateAgent(conv);
    renderAgentList();
  }
  document.getElementById('msg-input').focus();
}

function removeAgentChip() {
  _agentChips = [];
  renderAgentChips();
  _saveAgentChipsToConv();
  var conv = state.currentId ? getConv(state.currentId) : null;
  deactivateAgent(conv);
  renderAgentList();
  document.getElementById('msg-input').focus();
}

// Restore a specific set of agent chips (used when switching to an existing conversation)
// Sync _agentChips to match the currently activeAgent (called after @mention activation)
function _syncChipsFromActiveAgent() {
  if (!activeAgent) return;
  if (_agentChips.indexOf(activeAgent.name) === -1) {
    _agentChips = [activeAgent.name];
    renderAgentChips();
    _saveAgentChipsToConv();
  }
}

function _restoreAgentChips(chips, conv) {
  // Keep all chip names — even uninstalled agents show as ghost chips
  _agentChips = chips.slice();
  renderAgentChips();
  // Find the last installed agent to activate
  var installedChips = _agentChips.filter(function(n) { return !!findAgent(n); });
  if (installedChips.length > 0) {
    var last = installedChips[installedChips.length - 1];
    // Restore without generating a context summary (isInline=false, silent=true)
    var agent = findAgent(last);
    if (agent) {
      activeAgent = {
        name: agent.name,
        displayName: agent.displayName,
        manifest: agent,
        systemPrompt: agent.systemPrompt || '',
        permissions: agent.permissions || {},
        contextSummary: ''
      };
      updateAgentBadge();
      if (agent.permissions && agent.permissions.figma && !state.figmaMCPEnabled) {
        if (typeof toggleFigmaMCP === 'function') toggleFigmaMCP();
      }
    }
  } else {
    if (activeAgent) { activeAgent = null; updateAgentBadge(); }
  }
  renderAgentList();
}

// Reset chips to only pinned agents (used on new conversation)
function resetAgentChipsToPinned() {
  _agentChips = [];
  var conv = state.currentId ? getConv(state.currentId) : null;
  deactivateAgent(conv);
  var pinned = getPinnedAgents();
  if (pinned.length) {
    for (var i = 0; i < pinned.length; i++) {
      if (findAgent(pinned[i])) _agentChips.push(pinned[i]);
    }
    if (_agentChips.length) {
      var last = _agentChips[_agentChips.length - 1];
      activateAgent(last, conv, _agentChips.length > 1).then(function() { renderAgentList(); });
    }
  }
  renderAgentChips();
  renderAgentList();
}

function renderAgentChips() {
  var bar = document.getElementById('agent-chip-bar');
  if (!bar) return;
  if (!_agentChips.length) {
    bar.innerHTML = '';
    bar.style.display = 'none';
    bar._agentName = null;
    return;
  }
  var html = '';
  for (var i = 0; i < _agentChips.length; i++) {
    var agent = findAgent(_agentChips[i]);
    if (!agent) {
      // Ghost chip — agent was uninstalled
      html += '<div class="agent-chip agent-chip-ghost" title="Agent uninstalled">' +
        '<i class="ti ti-robot-off" style="font-size:13px;opacity:.5"></i>' +
        '<span class="agent-chip-name" style="text-decoration:line-through;opacity:.5">@' + escHtml(_agentChips[i]) + '</span>' +
        '<button class="agent-chip-remove" onclick="event.stopPropagation();removeAgentChipByName(\'' + escHtml(_agentChips[i]) + '\')" title="Remove"><i class="ti ti-x"></i></button>' +
      '</div>';
      continue;
    }
    var isActive = activeAgent && activeAgent.name === agent.name;
    var isLoading = !!_loadingAgents[agent.name];
    var isPinned = getPinnedAgents().indexOf(agent.name) >= 0;
    var hasSubs = agent._subAgents && agent._subAgents.length > 0;
    html += '<div class="agent-chip' + (isActive ? ' active' : '') + (isLoading ? ' loading' : '') + (hasSubs ? ' has-subs' : '') + '" onclick="switchToAgentChip(\'' + escHtml(agent.name) + '\')">' +
      (isLoading ? '<span class="agent-chip-spinner"></span>' : agentIconHtml(agent)) +
      '<span class="agent-chip-name">@' + escHtml(agent.displayName) + '</span>' +
      (hasSubs ? '<button class="agent-chip-subs-btn" onclick="event.stopPropagation();toggleSubAgentPicker(\'' + escHtml(agent.name) + '\',this)" title="Pick sub-agent"><i class="ti ti-chevron-down" style="font-size:11px"></i></button>' : '') +
      '<button class="agent-chip-pin' + (isPinned ? ' pinned' : '') + '" onclick="event.stopPropagation();togglePinAgent(\'' + escHtml(agent.name) + '\')" title="' + (isPinned ? 'Unpin agent' : 'Pin (auto-add to new chats)') + '"><i class="ti ti-pin' + (isPinned ? '-filled' : '') + '" style="font-size:11px"></i></button>' +
      '<button class="agent-chip-remove" onclick="event.stopPropagation();removeAgentChipByName(\'' + escHtml(agent.name) + '\')" title="Remove agent"><i class="ti ti-x"></i></button>' +
    '</div>';
  }
  bar.innerHTML = html;
  bar.style.display = 'flex';
  bar._agentName = _agentChips[_agentChips.length - 1];
}

function switchToAgentChip(name) {
  // Already the active agent — no-op (avoid duplicate dividers)
  if (activeAgent && activeAgent.name === name) return;
  var conv = state.currentId ? getConv(state.currentId) : null;
  activateAgent(name, conv, true).then(function() {
    renderAgentChips();
    renderAgentList();
  });
}

// ── Sub-agent picker from chip ───────────────────────────────────────────

function toggleSubAgentPicker(parentName, btn) {
  var existing = document.getElementById('sub-agent-picker');
  if (existing) {
    // If already open for this agent, close it
    if (existing.dataset.parent === parentName) { existing.remove(); return; }
    existing.remove();
  }
  var agent = findAgent(parentName);
  if (!agent || !agent._subAgents || !agent._subAgents.length) return;

  var chip = btn.closest('.agent-chip');
  var bar = document.getElementById('agent-chip-bar');
  if (!chip || !bar) return;

  var picker = document.createElement('div');
  picker.id = 'sub-agent-picker';
  picker.className = 'sub-agent-picker';
  picker.dataset.parent = parentName;

  var html = '<div class="sub-agent-picker-header">Sub-agents</div>';
  for (var i = 0; i < agent._subAgents.length; i++) {
    var sub = agent._subAgents[i];
    var alreadyAdded = _agentChips.indexOf(sub.name) !== -1;
    var icon = sub.icon || 'ti-robot';
    var iconHtml = icon.startsWith('custom:')
      ? '<img src="/api/agents/' + encodeURIComponent(sub.name) + '/icon" class="agent-custom-icon" alt="">'
      : '<i class="ti ' + icon + '"></i>';
    html += '<div class="sub-agent-picker-item' + (alreadyAdded ? ' already-added' : '') + '" onclick="selectSubAgentFromChip(\'' + escHtml(sub.name) + '\',\'' + escHtml(parentName) + '\')">' +
      iconHtml +
      '<div class="sub-agent-picker-info">' +
        '<span class="sub-agent-picker-name">' + escHtml(sub.displayName || sub.name) + '</span>' +
        (sub.description ? '<span class="sub-agent-picker-desc">' + escHtml(sub.description) + '</span>' : '') +
      '</div>' +
      (alreadyAdded ? '<i class="ti ti-check" style="font-size:13px;color:var(--accent);margin-left:auto"></i>' : '') +
    '</div>';
  }
  picker.innerHTML = html;

  // Position below the chip
  var chipRect = chip.getBoundingClientRect();
  var barRect = bar.getBoundingClientRect();
  picker.style.position = 'absolute';
  picker.style.left = (chip.offsetLeft) + 'px';
  picker.style.bottom = (bar.offsetHeight + 4) + 'px';

  bar.style.position = 'relative';
  bar.appendChild(picker);

  // Close picker on outside click
  setTimeout(function() {
    function onOutside(e) {
      if (!picker.contains(e.target) && e.target !== btn && !btn.contains(e.target)) {
        picker.remove();
        document.removeEventListener('click', onOutside);
      }
    }
    document.addEventListener('click', onOutside);
  }, 0);
}

function selectSubAgentFromChip(subName, parentName) {
  // Close picker
  var picker = document.getElementById('sub-agent-picker');
  if (picker) picker.remove();

  // Already added — just switch to it
  if (_agentChips.indexOf(subName) !== -1) {
    switchToAgentChip(subName);
    return;
  }

  // Find the sub-agent from the parent
  var parent = findAgent(parentName);
  if (!parent || !parent._subAgents) return;
  var sub = null;
  for (var i = 0; i < parent._subAgents.length; i++) {
    if (parent._subAgents[i].name === subName) { sub = parent._subAgents[i]; break; }
  }
  if (!sub) return;

  // Register as a temporary installed agent if not already present
  if (!findAgent(subName)) {
    var tempAgent = {
      name: sub.name,
      displayName: sub.displayName || sub.name,
      description: sub.description || '',
      icon: sub.icon || 'ti-robot',
      systemPrompt: sub.systemPrompt || '',
      permissions: sub.permissions || (parent.permissions || {}),
      manifest: sub,
      category: 'sub-agent',
      _isSubAgent: true,
      _parentAgent: parentName,
      _subAgents: sub._subAgents || null
    };
    installedAgents.push(tempAgent);
  }

  addAgentChip(subName);
  document.getElementById('msg-input').focus();
}

function updateAgentChipFromState() {
  var bar = document.getElementById('agent-chip-bar');
  if (!bar) return;
  if (activeAgent) {
    if (_agentChips.indexOf(activeAgent.name) === -1) {
      addAgentChip(activeAgent.name);
    } else {
      renderAgentChips();
    }
  } else {
    if (_agentChips.length) {
      _agentChips = [];
      renderAgentChips();
    }
  }
}

// ── Input handler for @ detection ────────────────────────────────────────

// Extract the @mention token at or just before the cursor position
function getAtMentionAtCursor(input) {
  var text = input.value;
  var cursor = input.selectionStart;
  // Walk backwards from cursor to find the '@'
  var start = cursor - 1;
  while (start >= 0 && /[\w-]/.test(text[start])) start--;
  if (start < 0 || text[start] !== '@') return null;
  // '@' must be at position 0 or preceded by whitespace/newline
  if (start > 0 && !/\s/.test(text[start - 1])) return null;
  var partial = text.substring(start + 1, cursor);
  return { start: start, end: cursor, filter: partial };
}

function handleAgentInput(e) {
  var input = e.target;
  var mention = getAtMentionAtCursor(input);

  if (mention) {
    showAgentAutocomplete(mention.filter);
  } else if (agentAutocompleteOpen) {
    hideAgentAutocomplete();
  }
}

// ── Keyboard navigation for autocomplete ─────────────────────────────────

function handleAgentAutocompleteKey(e) {
  if (!agentAutocompleteOpen) return false;
  var dropdown = document.getElementById('agent-autocomplete');
  if (!dropdown) return false;

  var items = dropdown.querySelectorAll('.agent-ac-item:not(.agent-ac-action)');
  var active = dropdown.querySelector('.agent-ac-item.active');
  var idx = -1;
  items.forEach(function(item, i) { if (item === active) idx = i; });

  if (e.key === 'ArrowDown') {
    e.preventDefault();
    if (active) active.classList.remove('active');
    idx = (idx + 1) % items.length;
    items[idx].classList.add('active');
    return true;
  }
  if (e.key === 'ArrowUp') {
    e.preventDefault();
    if (active) active.classList.remove('active');
    idx = idx <= 0 ? items.length - 1 : idx - 1;
    items[idx].classList.add('active');
    return true;
  }
  if (e.key === 'Enter' && active) {
    e.preventDefault();
    var name = active.dataset.agent;
    if (name) selectAgentFromAutocomplete(name);
    return true;
  }
  if (e.key === 'Escape') {
    e.preventDefault();
    hideAgentAutocomplete();
    return true;
  }
  return false;
}

// ── Agent panel in sidebar ───────────────────────────────────────────────

function agentListItemHtml(a) {
  var isActive = activeAgent && activeAgent.name === a.name;
  var pinned = getPinnedAgents();
  var scanBadge = getScanBadgeHtml(a.name);
  var sandboxBadge = isAgentSandboxed(a.name) ? '<span class="agent-sandbox-badge" title="Sandbox mode — restricted permissions"><i class="ti ti-shield-lock"></i></span>' : '';
  var mcpCount = (a.permissions && Array.isArray(a.permissions.mcp)) ? a.permissions.mcp.length : 0;
  var mcpBadge = mcpCount > 0 ? '<span class="agent-mcp-badge" title="Uses ' + mcpCount + ' MCP server' + (mcpCount > 1 ? 's' : '') + '"><i class="ti ti-plug"></i> MCP</span>' : '';
  var pinIndicator = pinned.indexOf(a.name) >= 0 ? '<i class="ti ti-pin-filled agent-pin-indicator" title="Pinned"></i>' : '';
  var isFromStore = a._meta && a._meta.installedFromStore;
  var eName = escHtml(a.name);
  var menuItems = isFromStore ? '' :
    '<button class="agent-menu-item" onclick="event.stopPropagation(); closeAgentMenu(); openAgentBuilder(\'' + eName + '\')">' +
      '<i class="ti ti-edit"></i> Edit</button>' +
    '<button class="agent-menu-item" onclick="event.stopPropagation(); closeAgentMenu(); scanInstalledAgent(\'' + eName + '\').then(showScanReport)">' +
      '<i class="ti ti-shield-check"></i> Security scan</button>' +
    '<button class="agent-menu-item" onclick="event.stopPropagation(); closeAgentMenu(); openTestRunner(\'' + eName + '\')">' +
      '<i class="ti ti-test-pipe"></i> Run tests</button>' +
    '<button class="agent-menu-item" onclick="event.stopPropagation(); closeAgentMenu(); toggleAgentSandboxMode(\'' + eName + '\')">' +
      '<i class="ti ti-shield-lock"></i> Sandbox mode</button>' +
    '<button class="agent-menu-item" onclick="event.stopPropagation(); closeAgentMenu(); showVersionHistory(\'' + eName + '\')">' +
      '<i class="ti ti-git-branch"></i> Version history</button>';
  var deleteLabel = isFromStore ? 'Uninstall' : 'Delete';
  var polishExtras = typeof getPolishExtras === 'function' ? getPolishExtras(a) : '';
  return '<div class="agent-list-item' + (isActive ? ' active' : '') + '" onclick="quickActivateAgent(\'' + eName + '\')">' +
    agentIconHtml(a) +
    pinIndicator +
    '<span class="agent-list-name">' + escHtml(a.displayName) + '</span>' +
    sandboxBadge + mcpBadge + scanBadge + polishExtras +
    '<span class="agent-action-btns">' +
      (menuItems ? '<span class="agent-menu-wrap">' +
        '<button class="agent-action-btn" onclick="event.stopPropagation(); toggleAgentMenu(this)" title="More actions"><i class="ti ti-dots"></i></button>' +
        '<div class="agent-menu-dropdown">' + menuItems + '</div>' +
      '</span>' : '') +
      '<button class="agent-action-btn agent-delete-btn" onclick="event.stopPropagation(); deleteAgent(\'' + eName + '\')" title="' + deleteLabel + '"><i class="ti ti-trash"></i></button>' +
    '</span>' +
    (isActive ? '<span class="agent-list-active-dot"></span>' : '') +
  '</div>';
}

function renderAgentList() {
  var list = document.getElementById('agent-list');
  if (!list) return;

  var agents = getSortedAgents();

  if (!agents.length) {
    list.innerHTML = '<div class="agent-empty">No agents installed</div>';
    var showAll = document.getElementById('agents-show-all');
    if (showAll) showAll.style.display = 'none';
    return;
  }

  var MAX_VISIBLE = 5;
  var visible = agents.slice(0, MAX_VISIBLE);
  list.innerHTML = visible.map(agentListItemHtml).join('');
  var showAll = document.getElementById('agents-show-all');
  if (showAll) showAll.style.display = agents.length > MAX_VISIBLE ? '' : 'none';
}

function openAllAgents() {
  openAllAgentsPage();
}

function toggleAgentMenu(btn) {
  var wrap = btn.closest('.agent-menu-wrap');
  var wasOpen = wrap.classList.contains('open');
  closeAgentMenu();
  if (!wasOpen) wrap.classList.add('open');
}

function closeAgentMenu() {
  document.querySelectorAll('.agent-menu-wrap.open').forEach(function(el) {
    el.classList.remove('open');
  });
}

// Close menu when clicking elsewhere
document.addEventListener('click', function() { closeAgentMenu(); });

var _loadingAgents = {}; // { agentName: true } — agents currently activating

function quickActivateAgent(name) {
  if (activeAgent && activeAgent.name === name) {
    var conv = state.currentId ? getConv(state.currentId) : null;
    deactivateAgent(conv);
    renderAgentList();
    updateAgentChipFromState();
    return;
  }
  // Show chip immediately with loading state
  if (_agentChips.indexOf(name) === -1) {
    _agentChips.push(name);
  }
  _loadingAgents[name] = true;
  renderAgentChips();
  _saveAgentChipsToConv();

  var conv = state.currentId ? getConv(state.currentId) : null;
  var isInline = conv && conv.messages && conv.messages.length > 0;
  activateAgent(name, conv, isInline).then(function() {
    delete _loadingAgents[name];
    renderAgentChips();
    renderAgentList();
  });
}

// openAgentStore() is defined in agent-store.js
// openAgentBuilder() is defined in agent-builder.js

// ── Agent Import (drag & drop + file picker) ─────────────────────────────

var _importInProgress = false;

function openAgentImportPicker() {
  var input = document.getElementById('agent-import-input');
  if (input) input.click();
}

function handleAgentImportFiles(files) {
  if (!files || !files.length) return;
  var file = files[0];
  if (!file.name.endsWith('.zip')) {
    showToast('Only .zip agent packages are supported');
    return;
  }
  importAgentFromFile(file);
}

async function importAgentFromFile(file) {
  if (_importInProgress) { showToast('Import already in progress'); return; }
  _importInProgress = true;
  showImportModal('importing');

  try {
    // Step 1: Read file as ArrayBuffer
    var buf = await file.arrayBuffer();

    // Step 2: Compute SHA-256 checksum
    var hashBuf = await crypto.subtle.digest('SHA-256', buf);
    var hashArr = Array.from(new Uint8Array(hashBuf));
    var checksum = hashArr.map(function(b) { return b.toString(16).padStart(2, '0'); }).join('');

    updateImportStatus('checksum', 'Checksum: ' + checksum.substring(0, 16) + '…');

    // Step 3: Auto-scan before import
    updateImportStatus('scanning', 'Running security scan…');
    var scanRes = await fetch('/api/agents/scan-zip', {
      method: 'POST',
      headers: { 'Content-Type': 'application/zip' },
      body: buf
    });
    var scanReport = await scanRes.json();

    if (scanReport.error) {
      showImportResult('error', 'Scan failed: ' + scanReport.error);
      _importInProgress = false;
      return;
    }

    updateImportStatus('scanned', 'Security score: ' + scanReport.score + '/100');

    // Step 4: Show scan results and ask for confirmation
    showImportScanResult(scanReport, buf, checksum, file.name);
  } catch (e) {
    showImportResult('error', 'Import failed: ' + (e.message || 'Unknown error'));
    _importInProgress = false;
  }
}

function showImportScanResult(scanReport, buf, checksum, fileName) {
  var badge = scanReport.score >= 90 ? '<i class="ti ti-circle-check" style="color:#22c55e"></i>' : scanReport.score >= 80 ? '<i class="ti ti-alert-triangle" style="color:#eab308"></i>' : '<i class="ti ti-circle-x" style="color:#ef4444"></i>';
  var status = scanReport.passed ? 'PASSED' : 'FAILED';

  var findingsHtml = '';
  if (scanReport.findings && scanReport.findings.length) {
    var severityOrder = ['critical', 'high', 'medium', 'low'];
    var icons = { critical: '<i class="ti ti-circle-x" style="color:#ef4444"></i>', high: '<i class="ti ti-alert-circle" style="color:#f97316"></i>', medium: '<i class="ti ti-alert-triangle" style="color:#eab308"></i>', low: '<i class="ti ti-info-circle" style="color:#3b82f6"></i>' };
    for (var s = 0; s < severityOrder.length; s++) {
      var sev = severityOrder[s];
      var items = scanReport.findings.filter(function(f) { return f.severity === sev; });
      if (!items.length) continue;
      findingsHtml += '<div class="scan-severity-group"><div class="scan-severity-title">' + icons[sev] + ' ' + sev.charAt(0).toUpperCase() + sev.slice(1) + ' (' + items.length + ')</div>';
      for (var i = 0; i < items.length; i++) {
        findingsHtml += '<div class="scan-finding"><div class="scan-finding-name">' + escHtml(items[i].checkName) + '</div><div class="scan-finding-desc">' + escHtml(items[i].description) + '</div></div>';
      }
      findingsHtml += '</div>';
    }
  }

  var body = document.getElementById('import-modal-body');
  if (!body) { _importInProgress = false; return; }

  body.innerHTML =
    '<div class="import-scan-result">' +
      '<div class="scan-header">' +
        '<span class="scan-badge-large">' + badge + '</span>' +
        '<span class="scan-score">' + scanReport.score + '/100</span>' +
        '<span class="scan-status ' + (scanReport.passed ? 'pass' : 'fail') + '">' + status + '</span>' +
      '</div>' +
      '<div class="import-meta">' +
        '<div>Agent: <strong>' + escHtml(scanReport.agentName || 'Unknown') + '</strong></div>' +
        '<div>File: ' + escHtml(fileName) + '</div>' +
        '<div>Checksum: <code>' + checksum.substring(0, 16) + '…</code></div>' +
      '</div>' +
      (findingsHtml || '<div class="scan-clean"><i class="ti ti-circle-check" style="color:#22c55e"></i> No security issues found!</div>') +
      '<div class="import-sandbox-toggle">' +
        '<label class="builder-toggle"><input type="checkbox" id="import-sandbox-check" checked><span class="builder-toggle-slider"></span></label>' +
        '<span class="import-sandbox-label"><i class="ti ti-shield-lock"></i> Install in sandbox mode <span class="builder-hint">(restricted until manually trusted)</span></span>' +
      '</div>' +
      '<div class="import-actions">' +
        '<button class="builder-btn secondary" onclick="closeImportModal()">Cancel</button>' +
        '<button class="builder-btn primary" onclick="confirmAgentImport()"><i class="ti ti-download"></i> Install Agent</button>' +
      '</div>' +
    '</div>';

  // Stash data for confirm
  window._pendingImport = { buf: buf, checksum: checksum, scanReport: scanReport };
}

async function confirmAgentImport() {
  var pending = window._pendingImport;
  if (!pending) { _importInProgress = false; return; }

  var sandboxed = document.getElementById('import-sandbox-check');
  var isSandboxed = sandboxed ? sandboxed.checked : true;

  updateImportStatus('installing', 'Installing agent…');

  try {
    var r = await fetch('/api/agents/import', {
      method: 'POST',
      headers: { 'Content-Type': 'application/zip' },
      body: pending.buf
    });
    var result = await r.json();

    if (result.error) {
      // 409: agent with same name already exists — offer to overwrite
      if (r.status === 409 || (result.error && result.error.includes('already exists'))) {
        if (confirm(result.error + '\n\nReinstall and overwrite the existing agent?')) {
          var forceR = await fetch('/api/agents/import?force=1', {
            method: 'POST',
            headers: { 'Content-Type': 'application/zip' },
            body: pending.buf
          });
          var forceResult = await forceR.json();
          if (forceResult.error) {
            showImportResult('error', 'Install failed: ' + forceResult.error);
            _importInProgress = false;
            return;
          }
          result = forceResult;
        } else {
          _importInProgress = false;
          return;
        }
      } else {
        showImportResult('error', 'Install failed: ' + result.error);
        _importInProgress = false;
        return;
      }
    }

    // Save checksum and sandbox state
    await fetch('/api/agents/' + encodeURIComponent(result.name) + '/meta', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        checksum: pending.checksum,
        sandboxMode: isSandboxed,
        scanScore: pending.scanReport.score,
        installedAt: new Date().toISOString()
      })
    });

    // Cache scan report
    _scanCache[result.name] = pending.scanReport;

    // Reload agent list
    await loadInstalledAgents();
    renderAgentList();

    showImportResult('success',
      'Installed "' + escHtml(result.displayName || result.name) + '"' +
      (isSandboxed ? ' in sandbox mode' : '') +
      ' — Security score: ' + pending.scanReport.score + '/100'
    );
  } catch (e) {
    showImportResult('error', 'Install failed: ' + (e.message || 'Unknown error'));
  }

  window._pendingImport = null;
  _importInProgress = false;
}

// ── Import modal UI ──────────────────────────────────────────────────────

function showImportModal(phase) {
  var modal = document.getElementById('import-modal');
  if (!modal) return;
  modal.style.display = 'flex';

  var body = document.getElementById('import-modal-body');
  if (body && phase === 'importing') {
    body.innerHTML =
      '<div class="import-progress">' +
        '<div class="builder-loading"><i class="ti ti-loader"></i> Preparing import…</div>' +
        '<div id="import-status-list" class="import-status-list"></div>' +
      '</div>';
  }
}

function closeImportModal() {
  var modal = document.getElementById('import-modal');
  if (modal) modal.style.display = 'none';
  _importInProgress = false;
  window._pendingImport = null;
}

function updateImportStatus(phase, message) {
  var list = document.getElementById('import-status-list');
  if (!list) return;
  var icon = phase === 'scanning' ? '<i class="ti ti-loader" style="animation:spin 1s linear infinite"></i>' :
             phase === 'installing' ? '<i class="ti ti-loader" style="animation:spin 1s linear infinite"></i>' :
             '<i class="ti ti-check" style="color:#4ade80"></i>';
  list.innerHTML += '<div class="import-status-item">' + icon + ' ' + escHtml(message) + '</div>';
}

function showImportResult(type, message) {
  var body = document.getElementById('import-modal-body');
  if (!body) return;

  var icon = type === 'success' ? '<i class="ti ti-circle-check" style="font-size:36px;color:#4ade80"></i>' :
             '<i class="ti ti-alert-circle" style="font-size:36px;color:#f87171"></i>';

  body.innerHTML =
    '<div class="import-result">' +
      icon +
      '<div class="import-result-msg">' + message + '</div>' +
      '<button class="builder-btn primary" onclick="closeImportModal()">Done</button>' +
    '</div>';
}

// ── Agent Import Drag & Drop (sidebar) ───────────────────────────────────

function initAgentImportDragDrop() {
  var section = document.getElementById('agents-section');
  if (!section) return;

  section.addEventListener('dragenter', function(e) {
    if (!hasZipItem(e.dataTransfer)) return;
    e.preventDefault();
    section.classList.add('agent-drop-active');
  });
  section.addEventListener('dragleave', function(e) {
    if (!section.contains(e.relatedTarget)) {
      section.classList.remove('agent-drop-active');
    }
  });
  section.addEventListener('dragover', function(e) {
    if (!hasZipItem(e.dataTransfer)) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'copy';
  });
  section.addEventListener('drop', function(e) {
    e.preventDefault();
    section.classList.remove('agent-drop-active');
    var files = e.dataTransfer.files;
    for (var i = 0; i < files.length; i++) {
      if (files[i].name.endsWith('.zip')) {
        importAgentFromFile(files[i]);
        return;
      }
    }
    showToast('Drop a .zip agent package to import');
  });
}

function hasZipItem(dt) {
  if (!dt) return false;
  if (dt.types && dt.types.indexOf('Files') !== -1) return true;
  if (dt.items) {
    for (var i = 0; i < dt.items.length; i++) {
      if (dt.items[i].kind === 'file') return true;
    }
  }
  return false;
}

// ── Sandbox Mode ─────────────────────────────────────────────────────────

var _agentMeta = {}; // agentName → { checksum, sandboxMode, scanScore, installedAt }

async function loadAgentMeta(agentName) {
  if (_agentMeta[agentName]) return _agentMeta[agentName];
  try {
    var r = await fetch('/api/agents/' + encodeURIComponent(agentName) + '/meta');
    if (!r.ok) return null;
    var meta = await r.json();
    _agentMeta[agentName] = meta;
    return meta;
  } catch (_) { return null; }
}

async function toggleAgentSandboxMode(agentName) {
  var meta = await loadAgentMeta(agentName);
  var newMode = meta ? !meta.sandboxMode : false;
  try {
    await fetch('/api/agents/' + encodeURIComponent(agentName) + '/meta', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sandboxMode: newMode })
    });
    if (_agentMeta[agentName]) _agentMeta[agentName].sandboxMode = newMode;
    else _agentMeta[agentName] = { sandboxMode: newMode };
    renderAgentList();
    showToast(agentName + ': sandbox mode ' + (newMode ? 'enabled' : 'disabled'));
  } catch (_) {
    showToast('Failed to toggle sandbox mode');
  }
}

function isAgentSandboxed(agentName) {
  var meta = _agentMeta[agentName];
  return meta ? meta.sandboxMode === true : false;
}

// ── Test Suite Runner UI ─────────────────────────────────────────────────

async function openTestRunner(agentName) {
  showTestRunnerModal(agentName);
  await runAgentTests(agentName);
}

function showTestRunnerModal(agentName) {
  var dlg = document.getElementById('dlg-modal');
  var titleEl = document.getElementById('dlg-modal-title');
  var msgEl = document.getElementById('dlg-modal-msg');
  var inputEl = document.getElementById('dlg-modal-input');
  var okBtn = document.getElementById('dlg-modal-ok');

  titleEl.innerHTML = '<i class="ti ti-test-pipe"></i> Test Runner: ' + escHtml(agentName);
  msgEl.style.display = 'block';
  msgEl.innerHTML = '<div class="test-runner"><div class="builder-loading"><i class="ti ti-loader"></i> Loading test cases…</div></div>';
  inputEl.style.display = 'none';
  okBtn.textContent = 'Close';
  dlg.style.display = 'flex';

  window._dlgResolve = function() {
    dlg.style.display = 'none';
    msgEl.innerHTML = '';
    msgEl.style.display = 'none';
    okBtn.textContent = 'OK';
  };
  window._dlgOk = window._dlgResolve;
}

async function runAgentTests(agentName) {
  var msgEl = document.getElementById('dlg-modal-msg');
  if (!msgEl) return;

  try {
    var r = await fetch('/api/agents/' + encodeURIComponent(agentName) + '/tests');
    var data = await r.json();
    var tests = data.testCases || [];

    if (!tests.length) {
      msgEl.innerHTML = '<div class="test-runner"><div class="builder-empty-state"><i class="ti ti-test-pipe"></i><p>No test cases found for this agent.</p></div></div>';
      return;
    }

    // Get agent's system prompt
    var ar = await fetch('/api/agents/' + encodeURIComponent(agentName));
    var agent = await ar.json();
    var systemPrompt = agent.systemPrompt || '';

    // Run each test
    var results = [];
    for (var i = 0; i < tests.length; i++) {
      var tc = tests[i];
      updateTestRunnerUI(msgEl, tests, results, i, 'running');

      try {
        var tr = await fetch('/api/agent-builder/test-prompt', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ systemPrompt: systemPrompt, testMessage: tc.input, model: state.model })
        });
        var td = await tr.json();
        var response = td.response || '';
        var passed = tc.expectedOutput ?
          response.toLowerCase().indexOf(tc.expectedOutput.toLowerCase()) !== -1 :
          response.length > 0;
        results.push({ input: tc.input, expected: tc.expectedOutput, response: response, passed: passed });
      } catch (_) {
        results.push({ input: tc.input, expected: tc.expectedOutput, response: 'Error', passed: false });
      }

      updateTestRunnerUI(msgEl, tests, results, i + 1, i + 1 < tests.length ? 'running' : 'done');
    }
  } catch (e) {
    msgEl.innerHTML = '<div class="test-runner"><div class="builder-test-result error">Failed to load tests: ' + escHtml(e.message) + '</div></div>';
  }
}

function updateTestRunnerUI(container, tests, results, currentIdx, phase) {
  var passCount = results.filter(function(r) { return r.passed; }).length;
  var failCount = results.filter(function(r) { return !r.passed; }).length;
  var total = tests.length;

  var html = '<div class="test-runner">';

  // Progress bar
  var pct = Math.round((results.length / total) * 100);
  html += '<div class="test-progress"><div class="test-progress-bar" style="width:' + pct + '%"></div></div>';

  // Summary
  html += '<div class="builder-test-summary">' +
    '<span class="builder-test-pass">' + passCount + ' passed</span>' +
    '<span class="builder-test-fail">' + failCount + ' failed</span>' +
    '<span class="builder-test-pending">' + (total - results.length) + ' remaining</span>' +
  '</div>';

  // Individual results
  for (var i = 0; i < total; i++) {
    if (i < results.length) {
      var r = results[i];
      var cls = r.passed ? 'pass' : 'fail';
      var icon = r.passed ? '<i class="ti ti-check" style="color:#4ade80"></i>' : '<i class="ti ti-x" style="color:#f87171"></i>';
      html += '<div class="builder-test-card ' + cls + '">' +
        '<div class="builder-test-card-header"><span class="builder-test-status">' + icon + '</span><span class="builder-test-title">Test #' + (i + 1) + '</span></div>' +
        '<div class="builder-test-io">' +
          '<div><strong>Input:</strong> ' + escHtml(r.input.substring(0, 80)) + '</div>' +
          (r.expected ? '<div><strong>Expected:</strong> ' + escHtml(r.expected.substring(0, 80)) + '</div>' : '') +
          '<div><strong>Got:</strong> ' + escHtml(r.response.substring(0, 120)) + '</div>' +
        '</div></div>';
    } else if (i === currentIdx && phase === 'running') {
      html += '<div class="builder-test-card"><div class="builder-test-card-header"><span class="builder-test-status"><i class="ti ti-loader" style="animation:spin 1s linear infinite"></i></span><span class="builder-test-title">Test #' + (i + 1) + ' — running…</span></div></div>';
    } else {
      html += '<div class="builder-test-card"><div class="builder-test-card-header"><span class="builder-test-status"><i class="ti ti-clock" style="color:var(--text-muted)"></i></span><span class="builder-test-title">Test #' + (i + 1) + '</span></div></div>';
    }
  }

  html += '</div>';
  container.innerHTML = html;
}

// ── Vulnerability Scanner UI ─────────────────────────────────────────────

var _scanCache = {}; // agentName → report

async function scanInstalledAgent(agentName) {
  try {
    showToast('Scanning ' + agentName + '…');
    var r = await fetch('/api/agents/' + encodeURIComponent(agentName) + '/scan', { method: 'POST' });
    var report = await r.json();
    if (report.error) { showToast('Scan error: ' + report.error); return null; }
    _scanCache[agentName] = report;
    renderAgentList();
    return report;
  } catch (e) {
    showToast('Scan failed');
    return null;
  }
}

async function getScanReport(agentName) {
  if (_scanCache[agentName]) return _scanCache[agentName];
  try {
    var r = await fetch('/api/agents/' + encodeURIComponent(agentName) + '/scan-report');
    if (!r.ok) return null;
    var report = await r.json();
    _scanCache[agentName] = report;
    return report;
  } catch (_) { return null; }
}

function showScanReport(report) {
  if (!report) { showToast('No scan report available'); return; }

  var badge = report.score >= 90 ? '<i class="ti ti-circle-check" style="color:#22c55e"></i>' : report.score >= 80 ? '<i class="ti ti-alert-triangle" style="color:#eab308"></i>' : '<i class="ti ti-circle-x" style="color:#ef4444"></i>';
  var status = report.passed ? 'PASSED' : 'FAILED';

  var html = '<div class="scan-report">';
  html += '<div class="scan-header">';
  html += '<span class="scan-badge-large">' + badge + '</span>';
  html += '<span class="scan-score">' + report.score + '/100</span>';
  html += '<span class="scan-status ' + (report.passed ? 'pass' : 'fail') + '">' + status + '</span>';
  html += '</div>';
  html += '<div class="scan-meta">' + report.agentName + ' v' + report.agentVersion + ' · ' + report.filesScanned + ' files scanned</div>';

  if (report.findings && report.findings.length) {
    html += '<div class="scan-findings">';
    var severityOrder = ['critical', 'high', 'medium', 'low'];
    var icons = { critical: '<i class="ti ti-circle-x" style="color:#ef4444"></i>', high: '<i class="ti ti-alert-circle" style="color:#f97316"></i>', medium: '<i class="ti ti-alert-triangle" style="color:#eab308"></i>', low: '<i class="ti ti-info-circle" style="color:#3b82f6"></i>' };
    for (var s = 0; s < severityOrder.length; s++) {
      var sev = severityOrder[s];
      var items = report.findings.filter(function(f) { return f.severity === sev; });
      if (!items.length) continue;
      html += '<div class="scan-severity-group">';
      html += '<div class="scan-severity-title">' + icons[sev] + ' ' + sev.charAt(0).toUpperCase() + sev.slice(1) + ' (' + items.length + ')</div>';
      for (var i = 0; i < items.length; i++) {
        var f = items[i];
        var loc = f.line ? f.file + ':' + f.line : f.file;
        html += '<div class="scan-finding">';
        html += '<div class="scan-finding-name">' + escHtml(f.checkName) + ' <span class="scan-finding-loc">' + escHtml(loc) + '</span></div>';
        html += '<div class="scan-finding-desc">' + escHtml(f.description) + '</div>';
        if (f.context) html += '<div class="scan-finding-ctx">' + escHtml(f.context) + '</div>';
        html += '</div>';
      }
      html += '</div>';
    }
    html += '</div>';
  } else {
    html += '<div class="scan-clean"><i class="ti ti-circle-check" style="color:#22c55e"></i> No security issues found!</div>';
  }

  html += '</div>';

  // Show in a toast-style overlay or modal
  showScanModal(report.agentName, html);
}

function showScanModal(title, bodyHtml) {
  // Reuse the dialog modal
  var dlg = document.getElementById('dlg-modal');
  var box = document.getElementById('dlg-modal-box');
  var titleEl = document.getElementById('dlg-modal-title');
  var msgEl = document.getElementById('dlg-modal-msg');
  var inputEl = document.getElementById('dlg-modal-input');
  var okBtn = document.getElementById('dlg-modal-ok');

  titleEl.innerHTML = '<i class="ti ti-shield-check"></i> Security Scan: ' + escHtml(title);
  msgEl.style.display = 'block';
  msgEl.innerHTML = bodyHtml;
  inputEl.style.display = 'none';
  okBtn.textContent = 'Close';
  dlg.style.display = 'flex';

  // Override resolve to just close
  window._dlgResolve = function() {
    dlg.style.display = 'none';
    msgEl.innerHTML = '';
    msgEl.style.display = 'none';
    okBtn.textContent = 'OK';
  };
  window._dlgOk = window._dlgResolve;
}

/**
 * Get a small badge HTML string for an agent's scan status.
 */
function getScanBadgeHtml(agentName) {
  var report = _scanCache[agentName];
  if (!report) return '';
  var ico = report.score >= 90 ? '<i class="ti ti-circle-check" style="color:#22c55e"></i>' : report.score >= 80 ? '<i class="ti ti-alert-triangle" style="color:#eab308"></i>' : '<i class="ti ti-circle-x" style="color:#ef4444"></i>';
  return '<span class="scan-badge" title="Security score: ' + report.score + '/100">' + ico + '</span>';
}

// ── Sandbox routing ──────────────────────────────────────────────────────
// When an agent is active, these helpers route requests through sandboxed
// endpoints that enforce the agent's permissions on the server side.

function isAgentActive() {
  return activeAgent != null;
}

function getActiveAgentName() {
  return activeAgent ? activeAgent.name : null;
}

function getActiveAgentPermissions() {
  return activeAgent ? activeAgent.permissions : null;
}

/**
 * Returns the correct API endpoint for a given operation, depending on
 * whether an agent is active.  Also returns extra body fields to include.
 */
function getSandboxedEndpoint(baseEndpoint) {
  if (!activeAgent) return { url: baseEndpoint, extra: {} };
  return {
    url: '/api/agent' + baseEndpoint.replace('/api', ''),
    extra: { agentName: activeAgent.name, permissions: activeAgent.permissions },
  };
}

/**
 * Check a capability against the active agent's permissions.
 * Returns { allowed: true } or { allowed: false, reason: '...' }
 */
function checkAgentPermission(capability) {
  if (!activeAgent) return { allowed: true };
  var perms = activeAgent.permissions || {};

  switch (capability) {
    case 'shell':
      if (!perms.shell) return { allowed: false, reason: activeAgent.displayName + ' does not have shell permission' };
      return { allowed: true };

    case 'browser':
      if (!perms.browser) return { allowed: false, reason: activeAgent.displayName + ' does not have browser permission' };
      return { allowed: true };

    case 'figma':
      if (!perms.figma) return { allowed: false, reason: activeAgent.displayName + ' does not have Figma permission' };
      return { allowed: true };

    default:
      return { allowed: true };
  }
}

/**
 * Show a sandbox block notification to the user.
 */
function showSandboxBlock(reason) {
  showToast('Blocked: ' + reason);
  dbg('[Sandbox] BLOCKED: ' + reason, 'warn');
  // Feed the block reason to the AI so it can explain it to the user
  if (typeof browserFeedAI === 'function' && state && state.currentId) {
    browserFeedAI('⛔ Action blocked: ' + reason + '.\n\nTell the user this action is not permitted for this agent, and suggest editing the agent in the builder to enable the required permission.', state.currentId).catch(function(){});
  }
}

// ── Audit log viewer ────────────────────────────────────────────────────

async function loadAuditLog(agentName) {
  try {
    var url = '/api/agent/audit-log';
    if (agentName) url += '?agent=' + encodeURIComponent(agentName);
    var r = await fetch(url);
    var d = await r.json();
    return d.log || [];
  } catch (_) {
    return [];
  }
}

// ── Pinned Agents ────────────────────────────────────────────────────────

var PINNED_KEY = 'fauna-pinned-agents';
var ICON_SIZE = 64; // px for custom icon images

// Render an agent icon — either a tabler icon class or a custom image
function agentIconHtml(a, extraClass) {
  var cls = extraClass || '';
  var icon = (a && a.icon) || 'ti-robot';
  if (icon.startsWith('custom:')) {
    return '<img src="/api/agents/' + encodeURIComponent(a.name) + '/icon" class="agent-custom-icon ' + cls + '" alt="icon">';
  }
  return '<i class="ti ' + icon + ' ' + cls + '"></i>';
}

function getPinnedAgents() {
  try { return JSON.parse(localStorage.getItem(PINNED_KEY)) || []; } catch (_) { return []; }
}

function togglePinAgent(name) {
  var pinned = getPinnedAgents();
  var idx = pinned.indexOf(name);
  if (idx >= 0) pinned.splice(idx, 1);
  else pinned.push(name);
  localStorage.setItem(PINNED_KEY, JSON.stringify(pinned));
  renderAgentList();
  var allPage = document.getElementById('all-agents-page');
  if (allPage && allPage.style.display !== 'none') renderAllAgentsPage();
}

function getSortedAgents() {
  var all = getAllAgents();
  var pinned = getPinnedAgents();
  var pinnedList = [];
  var unpinnedList = [];
  for (var i = 0; i < all.length; i++) {
    if (pinned.indexOf(all[i].name) >= 0) pinnedList.push(all[i]);
    else unpinnedList.push(all[i]);
  }
  return pinnedList.concat(unpinnedList);
}

// ── Agents accordion toggle ──────────────────────────────────────────────

function toggleAgentsAccordion() {
  toggleSidebarSection('agents');
}

// ── All Agents Page (full overlay) ───────────────────────────────────────

function openAllAgentsPage() {
  var page = document.getElementById('all-agents-page');
  if (!page) return;
  page.style.display = 'flex';
  renderAllAgentsPage();
}

function closeAllAgentsPage() {
  var page = document.getElementById('all-agents-page');
  if (page) page.style.display = 'none';
}

function renderAllAgentsPage() {
  var page = document.getElementById('all-agents-page');
  if (!page) return;

  var agents = getAllAgents();
  var pinned = getPinnedAgents();
  var filter = page._filter || '';

  if (filter) {
    var f = filter.toLowerCase();
    agents = agents.filter(function(a) {
      return a.name.toLowerCase().includes(f) || a.displayName.toLowerCase().includes(f) || (a.description || '').toLowerCase().includes(f);
    });
  }

  // Separate pinned from unpinned
  var pinnedAgents = [];
  var unpinnedAgents = [];
  for (var i = 0; i < agents.length; i++) {
    if (pinned.indexOf(agents[i].name) >= 0) pinnedAgents.push(agents[i]);
    else unpinnedAgents.push(agents[i]);
  }

  var html = '<div class="all-agents-header">' +
    '<div class="all-agents-title"><i class="ti ti-robot"></i> All Agents</div>' +
    '<div class="all-agents-search-wrap">' +
      '<i class="ti ti-search"></i>' +
      '<input class="all-agents-search" placeholder="Search agents…" value="' + escHtml(filter) + '" oninput="document.getElementById(\'all-agents-page\')._filter=this.value;renderAllAgentsPage()">' +
    '</div>' +
    '<button class="builder-btn primary small" onclick="closeAllAgentsPage();openAgentActionsPage()" title="Create or import an agent"><i class="ti ti-plus"></i> Add Agent</button>' +
    '<button class="builder-btn secondary small" onclick="closeAllAgentsPage();openAgentStore()" title="Browse the agent store"><i class="ti ti-package"></i> Store</button>' +
    '<button class="all-agents-close" onclick="closeAllAgentsPage()"><i class="ti ti-x"></i></button>' +
  '</div>';

  html += '<div class="all-agents-body">';

  if (pinnedAgents.length) {
    html += '<div class="all-agents-section-label"><i class="ti ti-pin-filled"></i> Pinned</div>';
    html += '<div class="all-agents-grid">';
    for (var i = 0; i < pinnedAgents.length; i++) {
      html += renderAgentCard(pinnedAgents[i], true);
    }
    html += '</div>';
  }

  html += '<div class="all-agents-section-label"><i class="ti ti-apps"></i> ' + (pinnedAgents.length ? 'All Others' : 'All Agents') + '</div>';
  if (unpinnedAgents.length) {
    html += '<div class="all-agents-grid">';
    for (var i = 0; i < unpinnedAgents.length; i++) {
      html += renderAgentCard(unpinnedAgents[i], false);
    }
    html += '</div>';
  } else if (!pinnedAgents.length) {
    html += '<div class="store-empty"><i class="ti ti-robot-off"></i><p>No agents found</p></div>';
  }

  html += '</div>';
  page.innerHTML = html;
}

function renderAgentCard(a, isPinned) {
  var isActive = activeAgent && activeAgent.name === a.name;
  var pinIcon = isPinned ? 'ti-pin-filled' : 'ti-pin';
  var pinTitle = isPinned ? 'Unpin agent' : 'Pin to top';

  return '<div class="all-agent-card' + (isActive ? ' active' : '') + '">' +
    '<div class="all-agent-card-top">' +
      agentIconHtml(a, 'all-agent-card-icon') +
      '<button class="all-agent-pin" onclick="event.stopPropagation();togglePinAgent(\'' + escHtml(a.name) + '\')" title="' + pinTitle + '"><i class="ti ' + pinIcon + '"></i></button>' +
    '</div>' +
    '<div class="all-agent-card-name">' + escHtml(a.displayName) + '</div>' +
    '<div class="all-agent-card-desc">' + escHtml((a.description || '').substring(0, 80)) + '</div>' +
    '<div class="all-agent-card-actions">' +
      '<button class="builder-btn primary small" onclick="quickActivateAgent(\'' + escHtml(a.name) + '\');closeAllAgentsPage()">' +
        (isActive ? '<i class="ti ti-circle-check"></i> Active' : '<i class="ti ti-player-play"></i> Use') +
      '</button>' +
      '<button class="builder-btn secondary small" onclick="event.stopPropagation();deleteAgent(\'' + escHtml(a.name) + '\')" title="Delete"><i class="ti ti-trash"></i></button>' +
    '</div>' +
  '</div>';
}

// ── Agent Actions Page (Create / Import) ─────────────────────────────────

function openAgentActionsPage() {
  var page = document.getElementById('agent-actions-page');
  if (!page) return;
  page.style.display = 'flex';
  renderAgentActionsPage();
}

function closeAgentActionsPage() {
  var page = document.getElementById('agent-actions-page');
  if (page) page.style.display = 'none';
}

function renderAgentActionsPage() {
  var page = document.getElementById('agent-actions-page');
  if (!page) return;

  page.innerHTML =
    '<div class="agent-actions-header">' +
      '<div class="all-agents-title"><i class="ti ti-plus"></i> Add Agent</div>' +
      '<button class="all-agents-close" onclick="closeAgentActionsPage()"><i class="ti ti-x"></i></button>' +
    '</div>' +
    '<div class="agent-actions-body">' +
      '<div class="agent-action-card" onclick="closeAgentActionsPage();openAgentBuilder()">' +
        '<div class="agent-action-icon"><i class="ti ti-wand"></i></div>' +
        '<div class="agent-action-info">' +
          '<div class="agent-action-title">Create Agent</div>' +
          '<div class="agent-action-desc">Build a custom agent with the step-by-step wizard. Define its name, role, tools, and permissions.</div>' +
        '</div>' +
        '<i class="ti ti-chevron-right agent-action-arrow"></i>' +
      '</div>' +
      '<div class="agent-action-card" onclick="closeAgentActionsPage();openAgentImportPicker()">' +
        '<div class="agent-action-icon"><i class="ti ti-file-import"></i></div>' +
        '<div class="agent-action-info">' +
          '<div class="agent-action-title">Import Agent</div>' +
          '<div class="agent-action-desc">Import a .zip agent package from your file system. It will be security-scanned before install.</div>' +
        '</div>' +
        '<i class="ti ti-chevron-right agent-action-arrow"></i>' +
      '</div>' +
      '<div class="agent-action-card" onclick="closeAgentActionsPage();openAgentStore()">' +
        '<div class="agent-action-icon"><i class="ti ti-package"></i></div>' +
        '<div class="agent-action-info">' +
          '<div class="agent-action-title">Browse Store</div>' +
          '<div class="agent-action-desc">Discover and install agents from the community store. Reviewed and security-scanned.</div>' +
        '</div>' +
        '<i class="ti ti-chevron-right agent-action-arrow"></i>' +
      '</div>' +
    '</div>';
}

// ── Init ─────────────────────────────────────────────────────────────────

async function initAgentSystem() {
  await loadInstalledAgents();
  // Pre-load meta for installed agents (sandbox state, checksum)
  for (var i = 0; i < installedAgents.length; i++) {
    loadAgentMeta(installedAgents[i].name);
  }
  renderAgentList();
  // Re-render chips now that agents are loaded — resolves ghost-chip false-positives on startup.
  // Also re-activate the last installed chip if nothing is active yet.
  renderAgentChips();
  if (!activeAgent && _agentChips.length > 0) {
    var installedChips = _agentChips.filter(function(n) { return !!findAgent(n); });
    if (installedChips.length > 0) {
      var conv = state.currentId ? getConv(state.currentId) : null;
      activateAgent(installedChips[installedChips.length - 1], conv, false).then(function() { renderAgentList(); });
    }
  }
  initAgentImportDragDrop();
  initAgentStore();
  initAgentPolish();
}
