// ── Agent Polish — Update Notifications, Versioning, Multi-Agent,
//    Usage Analytics, Keyboard Shortcuts ──────────────────────────────────

// ═══════════════════════════════════════════════════════════════════════════
// §1  UPDATE NOTIFICATIONS
// ═══════════════════════════════════════════════════════════════════════════

var updateCheckInterval = null;
var pendingUpdates = {}; // agentName → { currentVersion, latestVersion, changelog }

async function checkAgentUpdates() {
  var storeInstalled = installedAgents.filter(function(a) {
    return _agentMeta[a.name] && _agentMeta[a.name].installedFromStore;
  });
  if (!storeInstalled.length) return;

  for (var i = 0; i < storeInstalled.length; i++) {
    var a = storeInstalled[i];
    try {
      var r = await fetch('/api/store/agents/' + encodeURIComponent(a.name));
      if (!r.ok) continue;
      var remote = await r.json();
      var current = a.version || _agentMeta[a.name].storeVersion || '0.0.0';
      if (remote.version && compareVersions(remote.version, current) > 0) {
        pendingUpdates[a.name] = {
          currentVersion: current,
          latestVersion: remote.version,
          changelog: remote.changelog || '',
          displayName: remote.displayName || a.displayName
        };
      }
    } catch (_) { /* store offline — skip */ }
  }

  if (Object.keys(pendingUpdates).length > 0) {
    showUpdateBadge();
    renderAgentList(); // re-render with update indicators
  }
}

function compareVersions(a, b) {
  var pa = a.split('.').map(Number);
  var pb = b.split('.').map(Number);
  for (var i = 0; i < 3; i++) {
    var va = pa[i] || 0;
    var vb = pb[i] || 0;
    if (va > vb) return 1;
    if (va < vb) return -1;
  }
  return 0;
}

function showUpdateBadge() {
  var count = Object.keys(pendingUpdates).length;
  var badge = document.getElementById('agent-update-badge');
  if (badge) {
    if (count > 0) {
      badge.textContent = count;
      badge.style.display = 'inline-flex';
    } else {
      badge.style.display = 'none';
    }
  }
}

function getUpdateInfo(agentName) {
  return pendingUpdates[agentName] || null;
}

async function updateAgent(agentName) {
  var info = pendingUpdates[agentName];
  if (!info) { showToast('No update available'); return; }

  showToast('Updating ' + (info.displayName || agentName) + ' to v' + info.latestVersion + '…');

  try {
    // Use store slug from meta if available, else fall back to agent name
    var meta = _agentMeta[agentName] || {};
    var slug = meta.storeSlug || agentName;

    // Install latest from store (re-downloads and replaces)
    await installStoreAgent(slug);

    // Update meta with new version
    await fetch('/api/agents/' + encodeURIComponent(agentName) + '/meta', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ storeVersion: info.latestVersion })
    });

    delete pendingUpdates[agentName];
    showUpdateBadge();
    renderAgentList();

    // If this agent is currently active, reload it so new prompts use the updated version
    if (activeAgent && activeAgent.name === agentName) {
      var conv = getConv(state.currentId);
      await activateAgent(agentName, conv, false);
    }

    showToast(agentName + ' updated to v' + info.latestVersion);
  } catch (e) {
    showToast('Update failed: ' + e.message);
  }
}

function startUpdateChecker() {
  // Check on startup after a delay, then every 30 minutes
  setTimeout(checkAgentUpdates, 10000);
  updateCheckInterval = setInterval(checkAgentUpdates, 30 * 60 * 1000);
}

function stopUpdateChecker() {
  if (updateCheckInterval) {
    clearInterval(updateCheckInterval);
    updateCheckInterval = null;
  }
}


// ═══════════════════════════════════════════════════════════════════════════
// §2  AGENT VERSIONING & ROLLBACK
// ═══════════════════════════════════════════════════════════════════════════

// Local version history is stored per-agent in meta as `versionHistory`.
// Each entry: { version, timestamp, checksum }

async function getVersionHistory(agentName) {
  var meta = await loadAgentMeta(agentName);
  return (meta && meta.versionHistory) || [];
}

async function recordVersion(agentName, version, checksum) {
  var meta = await loadAgentMeta(agentName);
  if (!meta) meta = {};
  if (!meta.versionHistory) meta.versionHistory = [];

  // Don't duplicate
  var exists = meta.versionHistory.some(function(v) { return v.version === version && v.checksum === checksum; });
  if (exists) return;

  meta.versionHistory.push({
    version: version,
    checksum: checksum,
    timestamp: new Date().toISOString()
  });

  // Keep max 10 versions
  if (meta.versionHistory.length > 10) {
    meta.versionHistory = meta.versionHistory.slice(-10);
  }

  await fetch('/api/agents/' + encodeURIComponent(agentName) + '/meta', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ versionHistory: meta.versionHistory })
  });
}

async function showVersionHistory(agentName) {
  var history = await getVersionHistory(agentName);

  var html = '';
  if (!history.length) {
    html = '<div class="builder-empty-state"><i class="ti ti-git-branch"></i><p>No version history available.</p></div>';
  } else {
    html = '<div class="version-history">';
    for (var i = history.length - 1; i >= 0; i--) {
      var v = history[i];
      var isCurrent = i === history.length - 1;
      html += '<div class="version-item' + (isCurrent ? ' current' : '') + '">' +
        '<div class="version-dot' + (isCurrent ? ' active' : '') + '"></div>' +
        '<div class="version-info">' +
          '<span class="version-label">v' + escHtml(v.version) + (isCurrent ? ' (current)' : '') + '</span>' +
          '<span class="version-date">' + new Date(v.timestamp).toLocaleDateString() + '</span>' +
        '</div>' +
        (!isCurrent ? '<button class="builder-btn secondary small" onclick="rollbackAgent(\'' + escHtml(agentName) + '\',' + i + ')"><i class="ti ti-arrow-back-up"></i> Rollback</button>' : '') +
      '</div>';
    }
    html += '</div>';
  }

  // Show in dialog
  var dlg = document.getElementById('dlg-modal');
  document.getElementById('dlg-modal-title').innerHTML = '<i class="ti ti-git-branch"></i> Version History: ' + escHtml(agentName);
  var msgEl = document.getElementById('dlg-modal-msg');
  msgEl.style.display = 'block';
  msgEl.innerHTML = html;
  document.getElementById('dlg-modal-input').style.display = 'none';
  document.getElementById('dlg-modal-ok').textContent = 'Close';
  dlg.style.display = 'flex';
  window._dlgResolve = function() { dlg.style.display = 'none'; msgEl.innerHTML = ''; msgEl.style.display = 'none'; };
  window._dlgOk = window._dlgResolve;
}

async function rollbackAgent(agentName, historyIdx) {
  var history = await getVersionHistory(agentName);
  if (!history[historyIdx]) { showToast('Version not found'); return; }

  var target = history[historyIdx];
  if (!confirm('Rollback ' + agentName + ' to v' + target.version + '?\nThis will replace the current version.')) return;

  showToast('Rollback not yet wired to zip restore — placeholder for store/backup integration');
}


// ═══════════════════════════════════════════════════════════════════════════
// §3  MULTI-AGENT COMPOSITION
// ═══════════════════════════════════════════════════════════════════════════

// Orchestration modes: sequential | parallel
// Sequential: agents run one after another, each receiving prior output
// Parallel: agents run concurrently, results merged

var _compositionState = {
  active: false,
  mode: 'sequential', // 'sequential' | 'parallel'
  agents: [],         // [{ name, displayName, icon }]
  results: [],        // after execution: [{ agentName, response, duration }]
  currentIdx: 0
};

function startComposition(agentNames, mode) {
  var agents = agentNames.map(function(n) {
    var a = findAgent(n);
    return a ? { name: a.name, displayName: a.displayName, icon: a.icon || 'ti-robot' } : null;
  }).filter(Boolean);

  if (agents.length < 2) {
    showToast('Need at least 2 agents for composition');
    return false;
  }

  _compositionState = {
    active: true,
    mode: mode || 'sequential',
    agents: agents,
    results: [],
    currentIdx: 0,
    convId: state.currentId || null
  };

  addCompositionDivider(agents, mode, state.currentId);
  return true;
}

function addCompositionDivider(agents, mode, convId) {
  var container = convId && typeof getConvInner === 'function' ? getConvInner(convId) : document.getElementById('messages-inner');
  if (!container) return;
  var div = document.createElement('div');
  div.className = 'agent-divider composition-divider';
  var names = agents.map(function(a) { return a.displayName; }).join(' → ');
  div.innerHTML =
    '<span class="agent-divider-line"></span>' +
    '<span class="agent-divider-label"><i class="ti ti-arrows-split-2"></i> ' + mode + ': ' + escHtml(names) + '</span>' +
    '<span class="agent-divider-line"></span>';
  container.appendChild(div);
  scrollBottom();
}

/**
 * Parse composition syntax: @agent1 + @agent2 [parallel] message
 * Returns { agents: [...], mode: 'sequential'|'parallel', text: '...' } or null
 */
function parseCompositionMention(text) {
  if (!text) return null;
  // Match: @agent1 + @agent2 [+ @agent3 ...] [parallel] message
  var m = text.match(/^(@[\w-]+(?:\s*\+\s*@[\w-]+)+)\s*(parallel\s+)?(.*)/i);
  if (!m) return null;

  var agentPart = m[1];
  var isParallel = !!m[2];
  var msg = (m[3] || '').trim();

  var names = agentPart.split(/\s*\+\s*/).map(function(s) { return s.replace('@', ''); });
  // Validate all agents exist
  var allValid = names.every(function(n) { return findAgent(n) !== null; });
  if (!allValid || names.length < 2) return null;

  return { agents: names, mode: isParallel ? 'parallel' : 'sequential', text: msg };
}

async function runComposition(agentNames, mode, userMessage, conv) {
  if (!startComposition(agentNames, mode)) return;

  if (mode === 'parallel') {
    await runParallelComposition(agentNames, userMessage, conv);
  } else {
    await runSequentialComposition(agentNames, userMessage, conv);
  }

  _compositionState.active = false;
}

async function runSequentialComposition(agentNames, userMessage, conv) {
  var input = userMessage;
  for (var i = 0; i < agentNames.length; i++) {
    _compositionState.currentIdx = i;
    var name = agentNames[i];
    var agent = findAgent(name);
    if (!agent) continue;

    // Activate agent
    await activateAgent(name, conv, true);

    var start = Date.now();
    // Send message through the chat pipeline
    try {
      var r = await fetch('/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          messages: [{ role: 'user', content: input }],
          agentName: name,
          agentSystemPrompt: getAgentSystemPrompt(),
          agentPermissions: agent.permissions
        })
      });
      var d = await r.json();
      var response = '';
      if (d.choices && d.choices[0]) {
        response = d.choices[0].message ? d.choices[0].message.content : '';
      }
      _compositionState.results.push({ agentName: name, response: response, duration: Date.now() - start });

      // Next agent gets prior output as input
      input = 'Previous agent (' + agent.displayName + ') produced:\n\n' + response + '\n\nOriginal task: ' + userMessage;
    } catch (e) {
      _compositionState.results.push({ agentName: name, response: 'Error: ' + e.message, duration: Date.now() - start });
    }
  }

  deactivateAgent(conv);
  showCompositionResults();
}

async function runParallelComposition(agentNames, userMessage, conv) {
  var promises = agentNames.map(function(name) {
    var agent = findAgent(name);
    if (!agent) return Promise.resolve({ agentName: name, response: 'Agent not found', duration: 0 });

    var start = Date.now();
    return fetch('/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        messages: [{ role: 'user', content: userMessage }],
        agentName: name,
        agentSystemPrompt: agent.systemPrompt || '',
        agentPermissions: agent.permissions
      })
    }).then(function(r) { return r.json(); }).then(function(d) {
      var response = '';
      if (d.choices && d.choices[0]) response = d.choices[0].message ? d.choices[0].message.content : '';
      return { agentName: name, response: response, duration: Date.now() - start };
    }).catch(function(e) {
      return { agentName: name, response: 'Error: ' + e.message, duration: Date.now() - start };
    });
  });

  _compositionState.results = await Promise.all(promises);
  showCompositionResults();
}

function showCompositionResults() {
  var container = _compositionState.convId && typeof getConvInner === 'function' ? getConvInner(_compositionState.convId) : document.getElementById('messages-inner');
  if (!container) return;

  var div = document.createElement('div');
  div.className = 'composition-results';
  var html = '<div class="composition-header"><i class="ti ti-arrows-split-2"></i> Multi-Agent Results (' + _compositionState.mode + ')</div>';

  for (var i = 0; i < _compositionState.results.length; i++) {
    var r = _compositionState.results[i];
    var agent = findAgent(r.agentName);
    var icon = agent ? agent.icon || 'ti-robot' : 'ti-robot';
    var name = agent ? agent.displayName : r.agentName;
    html += '<div class="composition-result-card">' +
      '<div class="composition-result-header">' +
        '<i class="ti ' + icon + '"></i> ' + escHtml(name) +
        '<span class="composition-duration">' + (r.duration / 1000).toFixed(1) + 's</span>' +
      '</div>' +
      '<div class="composition-result-body">' + escHtml(r.response.substring(0, 500)) + (r.response.length > 500 ? '…' : '') + '</div>' +
    '</div>';
  }

  div.innerHTML = html;
  container.appendChild(div);
  scrollBottom();
}


// ═══════════════════════════════════════════════════════════════════════════
// §3b  ORCHESTRATOR DELEGATION
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Check if current active agent is an orchestrator.
 */
function isOrchestratorActive() {
  return activeAgent && activeAgent.manifest && activeAgent.manifest.orchestrator === true;
}

/**
 * Parse delegation blocks from orchestrator response.
 * Returns array of { agentName, task } or empty array.
 */
function parseDelegations(buffer) {
  if (!buffer) return [];
  var delegations = [];
  var re = /\[DELEGATE:([\w\/-]+)\]\s*([\s\S]*?)\s*\[\/DELEGATE\]/gi;
  var match;
  while ((match = re.exec(buffer)) !== null) {
    var rawName = match[1].trim();
    // Strip agents/ prefix — orchestrators may emit [DELEGATE:agents/name]
    var name = rawName.replace(/^agents\//, '');
    var task = match[2].trim();
    if (name && task && (findAgent(name) || findSubAgent(name))) {
      delegations.push({ agentName: name, task: task });
    }
  }
  return delegations;
}

/**
 * Find a sub-agent from the active orchestrator's bundled _subAgents.
 * Returns the sub-agent manifest or null.
 */
function findSubAgent(name) {
  if (!activeAgent || !activeAgent.manifest || !activeAgent.manifest._subAgents) return null;
  var subs = activeAgent.manifest._subAgents;
  for (var i = 0; i < subs.length; i++) {
    if (subs[i].name === name) return subs[i];
  }
  return null;
}

/**
 * Resolve an agent by name — checks sub-agents first, then global agents.
 */
function resolveAgent(name) {
  return findSubAgent(name) || findAgent(name);
}

/**
 * Strip delegation blocks from the displayed buffer so they don't render as raw text.
 * Replaces each block with a placeholder card reference.
 */
function stripDelegationBlocks(buffer) {
  return buffer.replace(/```?\n?\[DELEGATE:([\w\/-]+)\]\s*[\s\S]*?\[\/DELEGATE\]\n?```?/gi, '')
               .replace(/\[DELEGATE:([\w\/-]+)\]\s*[\s\S]*?\[\/DELEGATE\]/gi, '');
}

/**
 * Parse task completion signal from a sub-agent response.
 * Returns: 'complete', 'partial', 'blocked', 'failed', or 'unknown'.
 */
function _parseTaskStatus(text) {
  if (!text) return 'unknown';
  var last500 = text.slice(-500);
  if (/\[TASK_COMPLETE\]/i.test(last500)) return 'complete';
  if (/\[TASK_PARTIAL:/i.test(last500)) return 'partial';
  if (/\[TASK_BLOCKED:/i.test(last500)) return 'blocked';
  if (/\[TASK_FAILED:/i.test(last500)) return 'failed';
  return 'unknown';
}

/**
 * Execute all delegations in parallel, then synthesize.
 * Returns { results: [...], synthesis: string }
 */
async function executeDelegations(delegations, conv, originalMessage) {
  var results = [];

  // Show delegation progress in UI with per-agent status — anchored to the conversation's DOM
  var inner = typeof getConvInner === 'function' ? getConvInner(conv.id) : document.getElementById('messages-inner');
  var progressEl = document.createElement('div');
  progressEl.className = 'delegation-progress';

  var agentRows = '';
  for (var _d = 0; _d < delegations.length; _d++) {
    var _a = resolveAgent(delegations[_d].agentName);
    var _icon = _a ? (_a.icon || 'ti-robot') : 'ti-robot';
    var _name = _a ? _a.displayName : delegations[_d].agentName;
    var _taskPreview = delegations[_d].task.length > 80 ? delegations[_d].task.substring(0, 80) + '…' : delegations[_d].task;
    agentRows += '<div class="delegation-agent-row" id="deleg-row-' + _d + '">' +
      '<div class="delegation-agent-status"></div>' +
      '<i class="ti ' + escHtml(_icon) + ' delegation-agent-icon"></i>' +
      '<span class="delegation-agent-name">' + escHtml(_name) + '</span>' +
      '<span class="delegation-agent-task">' + escHtml(_taskPreview) + '</span>' +
      '<span class="delegation-agent-time" id="deleg-time-' + _d + '"></span>' +
    '</div>';
  }

  // Mode picker — shown before execution starts, waits for user choice
  var agentOptions = '';
  for (var _o = 0; _o < delegations.length; _o++) {
    var _oa = resolveAgent(delegations[_o].agentName);
    var _oName = _oa ? _oa.displayName : delegations[_o].agentName;
    agentOptions += '<button class="deleg-mode-btn deleg-single-agent-btn" onclick="window._delegPickMode && window._delegPickMode(\'single:' + _o + '\')">' +
      '<i class="ti ' + escHtml(_oa ? (_oa.icon || 'ti-robot') : 'ti-robot') + '"></i> ' + escHtml(_oName) + '</button>';
  }
  var modePickerHtml =
    '<div class="delegation-mode-picker" id="deleg-mode-picker">' +
      '<span class="deleg-mode-label"><i class="ti ti-settings-2"></i> Run mode:</span>' +
      '<button class="deleg-mode-btn" id="deleg-mode-parallel" onclick="window._delegPickMode && window._delegPickMode(\'parallel\')"><i class="ti ti-bolt"></i> Parallel</button>' +
      '<button class="deleg-mode-btn" id="deleg-mode-sequential" onclick="window._delegPickMode && window._delegPickMode(\'sequential\')"><i class="ti ti-arrow-down"></i> Sequential</button>' +
      '<button class="deleg-mode-btn" id="deleg-mode-single-toggle" onclick="var el=document.getElementById(\'deleg-single-picker\');el.style.display=el.style.display===\'none\'?\'\':\'none\'"><i class="ti ti-user"></i> Single</button>' +
    '</div>' +
    '<div class="delegation-single-picker" id="deleg-single-picker" style="display:none">' +
      '<span class="deleg-mode-label">Pick one agent:</span>' +
      agentOptions +
    '</div>';

  progressEl.innerHTML =
    '<div class="delegation-progress-header"><i class="ti ti-hierarchy-3"></i> Orchestrating ' + delegations.length + ' agent(s)…</div>' +
    modePickerHtml +
    '<div class="delegation-agent-list">' + agentRows + '</div>';
  if (inner) { inner.appendChild(progressEl); scrollBottom(); }

  // Wait for user mode choice — no auto-timeout, user must pick
  var chosenMode = await new Promise(function(resolve) {
    window._delegPickMode = function(mode) {
      resolve(mode);
    };
  });
  window._delegPickMode = null;

  // Handle single-agent mode: filter delegations to just the chosen one
  var singleAgentIndex = -1;
  if (chosenMode.startsWith('single:')) {
    singleAgentIndex = parseInt(chosenMode.split(':')[1], 10);
    delegations = [delegations[singleAgentIndex]];
    chosenMode = 'parallel'; // run the single agent directly
  }

  // Abort controller — lets the Stop button cancel all in-flight fetches
  var abortCtrl = new AbortController();
  var cancelled = false;

  // Update picker to show chosen mode + stop button, mark rows as working
  var pickerEl = document.getElementById('deleg-mode-picker');
  if (pickerEl) {
    var stopId = 'deleg-stop-' + Date.now();
    pickerEl.innerHTML =
      '<span class="deleg-mode-chosen"><i class="ti ti-' + (chosenMode === 'sequential' ? 'arrow-down' : 'bolt') + '"></i> ' + (chosenMode === 'sequential' ? 'Sequential' : 'Parallel') + '</span>' +
      '<button class="deleg-stop-btn" id="' + stopId + '" onclick="window._delegStop && window._delegStop()"><i class="ti ti-player-stop-filled"></i> Stop</button>';
  }
  window._delegStop = function() {
    cancelled = true;
    abortCtrl.abort();
    var stopBtn = document.getElementById(stopId);
    if (stopBtn) stopBtn.disabled = true;
    // Mark all still-working rows as cancelled
    for (var _c = 0; _c < delegations.length; _c++) {
      var _row2 = document.getElementById('deleg-row-' + _c);
      if (_row2 && _row2.classList.contains('working')) {
        _row2.classList.remove('working'); _row2.classList.add('cancelled');
        var _st = _row2.querySelector('.delegation-agent-status');
        if (_st) _st.innerHTML = '<i class="ti ti-minus" style="font-size:10px;color:var(--fau-text-muted)"></i>';
      }
      if (_row2 && _row2.classList.contains('pending')) {
        _row2.classList.remove('pending'); _row2.classList.add('cancelled');
      }
    }
    var headerEl2 = progressEl.querySelector('.delegation-progress-header');
    if (headerEl2) { headerEl2.innerHTML = '<i class="ti ti-player-stop-filled"></i> Stopped by user'; headerEl2.classList.add('cancelled'); }
  };

  for (var _r = 0; _r < delegations.length; _r++) {
    var _row = document.getElementById('deleg-row-' + _r);
    if (_row) {
      _row.classList.add(chosenMode === 'sequential' ? 'pending' : 'working');
      if (chosenMode === 'sequential') _row.querySelector('.delegation-agent-status').innerHTML = '<span class="deleg-pending-dot"></span>';
      else _row.querySelector('.delegation-agent-status').innerHTML = '<span class="delegation-spinner"></span>';
    }
  }
  scrollBottom();

  // Helper: run one delegation and update its row
  function runOne(del, idx, priorResultsText) {
    if (cancelled) return Promise.resolve({ agentName: del.agentName, response: 'Cancelled', duration: 0, cancelled: true });
    var agent = resolveAgent(del.agentName);
    if (!agent) return Promise.resolve({ agentName: del.agentName, response: 'Agent not found', duration: 0, error: true });
    var row = document.getElementById('deleg-row-' + idx);
    var timeEl = document.getElementById('deleg-time-' + idx);
    if (row) { row.classList.remove('pending'); row.classList.add('working'); row.querySelector('.delegation-agent-status').innerHTML = '<span class="delegation-spinner"></span>'; }
    var start = Date.now();
    var timerTick = setInterval(function() {
      if (timeEl && row && row.classList.contains('working'))
        timeEl.textContent = ((Date.now() - start) / 1000).toFixed(0) + 's';
    }, 500);
    var userContent = del.task + (priorResultsText ? '\n\n---\nPrevious agent results for context:\n' + priorResultsText : '');
    return fetch('/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      signal: abortCtrl.signal,
      body: JSON.stringify({
        messages: [{ role: 'user', content: userContent }],
        model: state.model,
        agentName: agent.name,
        isDelegation: true,
        agentSystemPrompt: agent.systemPrompt || '',
        agentPermissions: agent.permissions || {},
        useFigmaMCP: !!(agent.permissions && agent.permissions.figma) || !!(activeAgent && activeAgent.permissions && activeAgent.permissions.figma) || state.figmaMCPEnabled || false,
        thinkingBudget: state.thinkingBudget || 'high',
        systemPrompt: '## Active Agent: ' + agent.displayName + '\n\n' + (agent.systemPrompt || '') + '\n\nYou are being delegated a task by an orchestrator agent. Complete the task thoroughly and return your result.\n\n## Verification Before Completion (REQUIRED)\nBefore emitting your completion signal, you MUST verify your work:\n- File edits: read back the changed section to confirm it landed correctly.\n- Shell commands: check exit codes and scan output for errors.\n- Figma: confirm the execution result shows success.\n- If you cannot verify, state what you could NOT confirm.\n- NEVER emit [TASK_COMPLETE] if any step produced errors you did not resolve.\n\n## Completion Signal (REQUIRED)\nYou MUST end your response with a verification summary and exactly one of these markers on its own line:\n- `[TASK_COMPLETE]` — task finished successfully AND verified\n- `[TASK_PARTIAL: <what remains>]` — made progress but could not fully finish\n- `[TASK_BLOCKED: <reason>]` — could not proceed due to a blocker\n- `[TASK_FAILED: <reason>]` — attempted but failed\n\nFormat your ending as:\n### Verification\n- ✓ <what you checked and confirmed>\n- ✗ <what failed or could not be checked> (if any)\n[TASK_COMPLETE]'
      })
    }).then(function(r) { return readDelegationStream(r, abortCtrl.signal); })
    .then(function(text) {
      clearInterval(timerTick);
      var dur = Date.now() - start;
      if (row) { row.classList.remove('working'); row.classList.add('done'); }
      if (timeEl) timeEl.textContent = (dur / 1000).toFixed(1) + 's';
      return { agentName: del.agentName, displayName: agent.displayName, icon: agent.icon || 'ti-robot', task: del.task, response: text, duration: dur, status: _parseTaskStatus(text) };
    }).catch(function(e) {
      clearInterval(timerTick);
      var dur = Date.now() - start;
      var isCancelled = e.name === 'AbortError' || cancelled;
      if (row) { row.classList.remove('working'); row.classList.add(isCancelled ? 'cancelled' : 'error'); }
      if (timeEl) timeEl.textContent = (dur / 1000).toFixed(1) + 's';
      return { agentName: del.agentName, displayName: agent.displayName || del.agentName, icon: 'ti-robot', task: del.task, response: isCancelled ? 'Cancelled' : 'Error: ' + e.message, duration: dur, error: !isCancelled, cancelled: isCancelled, status: isCancelled ? 'cancelled' : 'error' };
    });
  }

  if (chosenMode === 'sequential') {
    // Run one at a time; each agent receives prior agents' results as context
    for (var _s = 0; _s < delegations.length; _s++) {
      if (cancelled) break;
      var priorCtx = results.map(function(r) { return '**' + (r.displayName || r.agentName) + '**: ' + r.response.substring(0, 800); }).join('\n\n');
      var res = await runOne(delegations[_s], _s, priorCtx || null);
      results.push(res);
    }
  } else {
    // Parallel — all at once
    results = await Promise.all(delegations.map(function(del, idx) { return runOne(del, idx, null); }));
  }

  delete window._delegStop;

  // If user stopped, skip synthesis
  if (cancelled) {
    var headerElC = progressEl.querySelector('.delegation-progress-header');
    if (headerElC && !headerElC.classList.contains('cancelled')) {
      headerElC.innerHTML = '<i class="ti ti-player-stop-filled"></i> Stopped by user';
      headerElC.classList.add('cancelled');
    }
    return { results: results, synthesis: null };
  }

  // Update header to synthesis phase
  var headerEl = progressEl.querySelector('.delegation-progress-header');
  if (headerEl) {
    headerEl.innerHTML = '<i class="ti ti-circle-check"></i> All ' + delegations.length + ' delegation(s) complete — synthesizing…';
    headerEl.classList.add('complete');
  }

  // Show delegation result cards
  showDelegationResults(results, inner);

  // Synthesize: send results back to orchestrator for final response
  var synthesis = await synthesizeDelegationResults(results, originalMessage, conv);

  // Final header update
  if (headerEl) {
    headerEl.innerHTML = '<i class="ti ti-circle-check"></i> Orchestration complete';
  }

  return { results: results, synthesis: synthesis };
}

/**
 * Read SSE stream from a delegation fetch response and return the full text.
 */
async function readDelegationStream(response, signal) {
  var reader = response.body.getReader();
  var decoder = new TextDecoder();
  var partial = '';
  var text = '';

  while (true) {
    if (signal && signal.aborted) { reader.cancel(); break; }
    var readResult = await reader.read();
    if (readResult.done) break;
    partial += decoder.decode(readResult.value, { stream: true });
    var lines = partial.split('\n');
    partial = lines.pop();
    for (var i = 0; i < lines.length; i++) {
      var line = lines[i];
      if (!line.startsWith('data: ')) continue;
      var raw = line.slice(6);
      if (raw === '[DONE]') continue;
      try {
        var evt = JSON.parse(raw);
        if (evt.type === 'content') text += evt.content;
      } catch (_) {}
    }
  }
  return text;
}

/**
 * Show delegation result cards in the messages pane.
 */
function showDelegationResults(results, container) {
  if (!container) container = document.getElementById('messages-inner');
  if (!container) return;

  for (var i = 0; i < results.length; i++) {
    try {
    var r = results[i];
    var resp = (r.response || '') + '';
    var card = document.createElement('div');
    var statusLabel = r.status === 'complete' ? '✓' : r.status === 'partial' ? '◐' : r.status === 'blocked' ? '⊘' : r.status === 'failed' ? '✗' : '';
    var statusClass = r.status && r.status !== 'unknown' ? ' status-' + r.status : '';
    card.className = 'delegation-result-card' + (r.error ? ' error' : '') + statusClass;
    var preview = resp.length > 600 ? resp.substring(0, 600) + '…' : resp;
    card.innerHTML =
      '<div class="delegation-result-header">' +
        '<span class="delegation-agent"><i class="ti ' + escHtml(r.icon || 'ti-robot') + '"></i> ' + escHtml(r.displayName || r.agentName) + '</span>' +
        (statusLabel ? '<span class="delegation-status-badge' + statusClass + '">' + statusLabel + ' ' + (r.status || '') + '</span>' : '') +
        '<span class="delegation-duration">' + ((r.duration || 0) / 1000).toFixed(1) + 's</span>' +
      '</div>' +
      '<div class="delegation-task"><i class="ti ti-arrow-right"></i> ' + escHtml((r.task || '').substring(0, 120)) + '</div>' +
      '<div class="delegation-result-body">' + renderMarkdown(preview) + '</div>';

    // Expand/collapse for long responses
    if (resp.length > 600) {
      var toggle = document.createElement('button');
      toggle.className = 'delegation-expand-btn';
      toggle.textContent = 'Show full response';
      toggle.dataset.full = resp;
      toggle.dataset.preview = preview;
      toggle.onclick = function() {
        var body = this.previousElementSibling;
        if (this.dataset.expanded === 'true') {
          body.innerHTML = renderMarkdown(this.dataset.preview);
          this.textContent = 'Show full response';
          this.dataset.expanded = 'false';
        } else {
          body.innerHTML = renderMarkdown(this.dataset.full);
          this.textContent = 'Collapse';
          this.dataset.expanded = 'true';
        }
      };
      card.appendChild(toggle);
    }

    container.appendChild(card);
    } catch (cardErr) {
      console.error('[delegation] Error rendering result card ' + i + ':', cardErr);
      var errCard = document.createElement('div');
      errCard.className = 'delegation-result-card error';
      errCard.innerHTML = '<div class="delegation-result-header"><span class="delegation-agent"><i class="ti ti-alert-triangle"></i> ' + escHtml((results[i] && results[i].displayName) || 'Agent ' + i) + '</span></div>' +
        '<div class="delegation-result-body"><em>Error rendering result</em></div>';
      container.appendChild(errCard);
    }
  }
  scrollBottom();
}

/**
 * Send delegation results back to the orchestrator for synthesis.
 */
async function synthesizeDelegationResults(results, originalMessage, conv) {
  if (!activeAgent) return '';

  // Build a synthesis prompt with all results
  var parts = ['The following agents completed their delegated tasks. Synthesize their results into a unified response for the user.\n'];
  parts.push('**Original user request:** ' + originalMessage + '\n');
  var unverifiedAgents = [];
  for (var i = 0; i < results.length; i++) {
    var r = results[i];
    parts.push('---');
    parts.push('**' + (r.displayName || r.agentName) + '** (task: ' + r.task.substring(0, 200) + ') — status: ' + (r.status || 'unknown') + ':');
    parts.push(r.response);
    parts.push('');
    // Check if agent included a verification section
    if (r.status === 'complete' && !/### Verification/i.test(r.response) && !/✓.*(?:confirmed|verified|checked)/i.test(r.response)) {
      unverifiedAgents.push(r.displayName || r.agentName);
    }
  }
  parts.push('---');
  parts.push('Now synthesize the above results into a clear, unified response. Check each agent\'s status marker:');
  parts.push('- COMPLETE tasks: include their results directly');
  parts.push('- PARTIAL/BLOCKED/FAILED tasks: flag what still needs attention');
  if (unverifiedAgents.length > 0) {
    parts.push('- ⚠️ UNVERIFIED: The following agents claimed COMPLETE but did NOT include a verification section: ' + unverifiedAgents.join(', ') + '. Flag this in your synthesis — their results may need manual verification.');
  }
  parts.push('Highlight key findings and note any conflicts or complementary insights between agents.');

  var synthContent = parts.join('\n');

  try {
    var response = await fetch('/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        messages: [{ role: 'user', content: synthContent }],
        model: state.model,
        useFigmaMCP: state.figmaMCPEnabled || false,
        thinkingBudget: state.thinkingBudget || 'high',
        systemPrompt: '## Active Agent: ' + activeAgent.displayName + ' (Orchestrator — Synthesis Phase)\n\n' + (activeAgent.systemPrompt || '') + '\n\nYou are synthesizing results from delegated agents. Provide a unified, coherent response. Do NOT use [DELEGATE] blocks in this response.'
      })
    });
    return await readDelegationStream(response);
  } catch (e) {
    return 'Synthesis error: ' + e.message;
  }
}


// ═══════════════════════════════════════════════════════════════════════════
// §4  USAGE ANALYTICS (local, opt-in)
// ═══════════════════════════════════════════════════════════════════════════

var ANALYTICS_KEY = 'agent-usage-analytics';
var analyticsEnabled = false;

function getAnalytics() {
  try {
    var d = localStorage.getItem(ANALYTICS_KEY);
    return d ? JSON.parse(d) : { agents: {}, totalInvocations: 0, sessions: [] };
  } catch (_) { return { agents: {}, totalInvocations: 0, sessions: [] }; }
}

function saveAnalytics(data) {
  try { localStorage.setItem(ANALYTICS_KEY, JSON.stringify(data)); } catch (_) {}
}

function recordAgentInvocation(agentName) {
  if (!analyticsEnabled) return;
  var data = getAnalytics();
  data.totalInvocations++;
  if (!data.agents[agentName]) {
    data.agents[agentName] = { invocations: 0, totalDuration: 0, lastUsed: null };
  }
  data.agents[agentName].invocations++;
  data.agents[agentName].lastUsed = new Date().toISOString();
  saveAnalytics(data);
}

function recordAgentDuration(agentName, durationMs) {
  if (!analyticsEnabled) return;
  var data = getAnalytics();
  if (data.agents[agentName]) {
    data.agents[agentName].totalDuration += durationMs;
  }
  saveAnalytics(data);
}

function recordSession(agentName, messageCount) {
  if (!analyticsEnabled) return;
  var data = getAnalytics();
  data.sessions.push({
    agent: agentName,
    messages: messageCount,
    date: new Date().toISOString()
  });
  // Keep last 100 sessions
  if (data.sessions.length > 100) data.sessions = data.sessions.slice(-100);
  saveAnalytics(data);
}

function showAnalyticsDashboard() {
  var data = getAnalytics();
  var agents = data.agents || {};
  var agentNames = Object.keys(agents);

  var html = '<div class="analytics-dashboard">';

  // Toggle
  html += '<div class="analytics-toggle">' +
    '<label class="builder-toggle"><input type="checkbox" id="analytics-enable-toggle"' + (analyticsEnabled ? ' checked' : '') + ' onchange="toggleAnalytics(this.checked)"><span class="builder-toggle-slider"></span></label>' +
    '<span>Enable usage analytics (stored locally only)</span>' +
  '</div>';

  // Summary
  html += '<div class="analytics-summary">' +
    '<div class="analytics-stat"><div class="analytics-stat-value">' + data.totalInvocations + '</div><div class="analytics-stat-label">Total Invocations</div></div>' +
    '<div class="analytics-stat"><div class="analytics-stat-value">' + agentNames.length + '</div><div class="analytics-stat-label">Agents Used</div></div>' +
    '<div class="analytics-stat"><div class="analytics-stat-value">' + (data.sessions || []).length + '</div><div class="analytics-stat-label">Sessions</div></div>' +
  '</div>';

  // Per-agent breakdown
  if (agentNames.length) {
    // Sort by invocations descending
    agentNames.sort(function(a, b) { return agents[b].invocations - agents[a].invocations; });

    html += '<div class="analytics-agents"><h4>Agent Breakdown</h4>';
    var maxInvocations = agents[agentNames[0]].invocations;

    for (var i = 0; i < agentNames.length; i++) {
      var name = agentNames[i];
      var ag = agents[name];
      var agent = findAgent(name);
      var icon = agent ? agent.icon || 'ti-robot' : 'ti-robot';
      var displayName = agent ? agent.displayName : name;
      var barWidth = maxInvocations > 0 ? Math.round((ag.invocations / maxInvocations) * 100) : 0;
      var avgDuration = ag.invocations > 0 ? (ag.totalDuration / ag.invocations / 1000).toFixed(1) : '—';

      html += '<div class="analytics-agent-row">' +
        '<div class="analytics-agent-info">' +
          '<i class="ti ' + icon + '"></i> ' + escHtml(displayName) +
        '</div>' +
        '<div class="analytics-agent-stats">' +
          '<span>' + ag.invocations + ' calls</span>' +
          '<span>avg ' + avgDuration + 's</span>' +
          (ag.lastUsed ? '<span>last: ' + new Date(ag.lastUsed).toLocaleDateString() + '</span>' : '') +
        '</div>' +
        '<div class="analytics-bar-wrap"><div class="analytics-bar" style="width:' + barWidth + '%"></div></div>' +
      '</div>';
    }
    html += '</div>';
  } else {
    html += '<div class="builder-empty-state"><i class="ti ti-chart-bar"></i><p>No usage data yet. Start using agents to see analytics.</p></div>';
  }

  // Clear button
  html += '<div class="analytics-actions">' +
    '<button class="builder-btn secondary" onclick="clearAnalytics()"><i class="ti ti-trash"></i> Clear Data</button>' +
  '</div>';

  html += '</div>';

  // Show in dialog
  var dlg = document.getElementById('dlg-modal');
  document.getElementById('dlg-modal-title').innerHTML = '<i class="ti ti-chart-bar"></i> Agent Usage Analytics';
  var msgEl = document.getElementById('dlg-modal-msg');
  msgEl.style.display = 'block';
  msgEl.innerHTML = html;
  document.getElementById('dlg-modal-input').style.display = 'none';
  document.getElementById('dlg-modal-ok').textContent = 'Close';
  dlg.style.display = 'flex';
  window._dlgResolve = function() { dlg.style.display = 'none'; msgEl.innerHTML = ''; msgEl.style.display = 'none'; };
  window._dlgOk = window._dlgResolve;
}

function toggleAnalytics(enabled) {
  analyticsEnabled = enabled;
  localStorage.setItem('agent-analytics-enabled', enabled ? '1' : '0');
}

function clearAnalytics() {
  if (!confirm('Clear all local analytics data?')) return;
  localStorage.removeItem(ANALYTICS_KEY);
  showAnalyticsDashboard(); // refresh
}


// ═══════════════════════════════════════════════════════════════════════════
// §5  KEYBOARD SHORTCUTS
// ═══════════════════════════════════════════════════════════════════════════

var agentShortcuts = {
  'at':     { key: '@', desc: 'Invoke agent (type @name in input)' },
  'store':  { key: 'Shift+P', desc: 'Open Agent Store', ctrl: true },
  'build':  { key: 'Shift+B', desc: 'Open Agent Builder', ctrl: true },
  'deact':  { key: 'Escape', desc: 'Deactivate current agent (when input empty)', ctrl: false },
  'stats':  { key: 'Shift+A', desc: 'Show Analytics Dashboard', ctrl: true }
};

function handleAgentShortcuts(e) {
  // Ctrl/Cmd+Shift+P → Open Store
  if ((e.ctrlKey || e.metaKey) && e.shiftKey && e.key === 'P') {
    e.preventDefault();
    openAgentStore();
    return true;
  }

  // Ctrl/Cmd+Shift+B → Open Builder
  if ((e.ctrlKey || e.metaKey) && e.shiftKey && e.key === 'B') {
    e.preventDefault();
    openAgentBuilder();
    return true;
  }

  // Ctrl/Cmd+Shift+A → Analytics
  if ((e.ctrlKey || e.metaKey) && e.shiftKey && e.key === 'A') {
    e.preventDefault();
    showAnalyticsDashboard();
    return true;
  }

  // Escape → deactivate agent (only when input is empty)
  if (e.key === 'Escape' && activeAgent) {
    var input = document.getElementById('msg-input');
    if (input && !input.value.trim()) {
      e.preventDefault();
      var conv = state.currentId ? getConv(state.currentId) : null;
      deactivateAgent(conv);
      renderAgentList();
      showToast('Agent deactivated');
      return true;
    }
  }

  return false;
}


// ═══════════════════════════════════════════════════════════════════════════
// §6  ENHANCED AGENT LIST RENDERING (update badges, version history btn)
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Returns extra HTML badges/buttons to append per agent in renderAgentList().
 * Called from agent-system.js renderAgentList if available.
 */
function getPolishExtras(agent) {
  var html = '';
  // Update available badge
  var update = getUpdateInfo(agent.name);
  if (update) {
    html += '<span class="agent-update-badge" title="Update available: v' + escHtml(update.latestVersion) + '" onclick="event.stopPropagation();updateAgent(\'' + escHtml(agent.name) + '\')"><i class="ti ti-cloud-download"></i></span>';
  }
  return html;
}


// ═══════════════════════════════════════════════════════════════════════════
// §7  INIT
// ═══════════════════════════════════════════════════════════════════════════

function initAgentPolish() {
  // Restore analytics preference
  analyticsEnabled = localStorage.getItem('agent-analytics-enabled') === '1';

  // Register keyboard shortcuts
  document.addEventListener('keydown', handleAgentShortcuts);

  // Start update checker
  startUpdateChecker();
}
