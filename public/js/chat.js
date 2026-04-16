// ── Sending messages ──────────────────────────────────────────────────────

// Keywords that suggest the user wants system/file actions performed
var SYSTEM_TASK_PATTERNS = [
  /\bdesktop\b/i, /\barrange\s+(my\s+)?files/i, /clean\s*up\s+(my\s+)?(desktop|files|folder)/i,
  /organis[ez]\s+(my\s+)?(desktop|files|folder|downloads)/i,
  /files?\s+on\s+(my\s+)?desktop/i, /my\s+(desktop\s+)?files/i, /move\s+file/i,
  /list\s+(file|app|process|program)/i, /show\s+(me\s+)?(what|the)/i,
  /open\s+app/i, /running\s+app/i, /installed\s+app/i,
  /take\s+screenshot/i, /screenshot/i,
  /disk\s+space/i, /storage/i, /find\s+file/i
];

// Patterns that specifically indicate a desktop file organization task (for organizer card)
var DESKTOP_ORG_PATTERNS = [
  /\b(organis|organiz)[ez]?\s+(my\s+)?(desktop|files|folder|downloads)/i,
  /\b(clean|tidy)\s*(up)?\s+(my\s+)?(desktop|files|downloads)/i,
  /\barrange\s+(my\s+)?(desktop|files)/i,
  /sort\s+(my\s+)?(desktop|files|downloads)/i
];

// Short confirmations — user is approving a plan the AI just described
var CONFIRM_PATTERNS = /^(yes|proceed|do it|go ahead|execute|run it|ok|okay|sure|do this|confirm|apply|start|make it so|go|yep|yup|do that|please do|please proceed|sounds good|let'?s? do it)[\.\!\?]?$/i;

async function gatherSystemContext(text) {
  var ctx = [];
  var home    = sysCtx.home    || '~';
  var desktop = sysCtx.desktop || (home + '/Desktop');
  var conv    = state.currentId ? getConv(state.currentId) : null;

  // If user is confirming a plan, inject a command-forcing instruction
  if (CONFIRM_PATTERNS.test(text.trim())) {
    var lastAI = conv && conv.messages.slice().reverse().find(function(m) { return m.role === 'assistant'; });
    if (lastAI) {
      if (DESKTOP_ORG_PATTERNS.some(function(p) { return p.test(lastAI.content || ''); })) state._lastMsgWasDesktopTask = true;
      return '\n\n[The user has confirmed the plan. Now output the COMPLETE shell commands to execute it — ' +
        'write every command inside code blocks with real content. ' +
        'Do not leave any code block empty. Do not just describe — write the actual commands.\n' +
        'Example format:\n' +
        'mkdir -p ~/Desktop/Screenshots\n' +
        'mv ~/Desktop/Screenshot*.png ~/Desktop/Screenshots/\n' +
        'Each command on its own line, all inside one code block.]';
    }
  }

  var matched = SYSTEM_TASK_PATTERNS.some(function(p) { return p.test(text); });
  if (!matched) return '';

  // Gather Desktop contents
  if (/desktop|arrange|clean|organis|organiz/i.test(text)) {
    state._lastMsgWasDesktopTask = DESKTOP_ORG_PATTERNS.some(function(p) { return p.test(text); });
    try {
      var r = await fetch('/api/shell-exec', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ command: 'ls -1A "' + desktop + '" 2>/dev/null | head -80' })
      });
      var d = await r.json();
      if (d.stdout && d.stdout.trim()) {
        ctx.push('Current Desktop contents (`ls ~/Desktop`):\n```\n' + d.stdout.trim() + '\n```');
      } else {
        ctx.push('Desktop is empty (no files found at ' + desktop + ').');
      }
    } catch (_) {}
  }

  // Gather disk space if relevant
  if (/disk|storage|space/i.test(text)) {
    try {
      var r2 = await fetch('/api/shell-exec', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ command: 'df -h ~' })
      });
      var d2 = await r2.json();
      if (d2.stdout) ctx.push('Disk usage:\n```\n' + d2.stdout.trim() + '\n```');
    } catch (_) {}
  }

  return ctx.length ? '\n\n[System context gathered automatically]\n' + ctx.join('\n') : '';
}

// Send a message directly into the conversation (supports vision/array content).
// Used by auto-feed when a screenshot was taken.
async function sendDirectMessage(content, opts) {
  opts = opts || {};
  var targetId = opts.targetConvId || state.currentId;
  if (!targetId) { newConversation(); targetId = state.currentId; }
  var conv = getConv(targetId);
  if (!conv) return;
  if (conv._streaming) return;
  if (!opts.fromAutoFeed && !opts.isBrowserFeed) conv._autoFeedDepth = 0;
  var isCurrentConv = (targetId === state.currentId);

  var displayText = typeof content === 'string' ? content
    : (content.find(function(c){ return c.type === 'text'; }) || {}).text || '';

  var userMsg = { role: 'user', content: content };
  conv.messages.push(userMsg);

  if (isCurrentConv) {
    if (opts.isAutoFeed || opts.isBrowserFeed) {
      var feedIcon  = opts.isBrowserFeed ? 'ti-world-www' : opts.isWriteFileFeed ? 'ti-file-alert' : 'ti-terminal-2';
      var feedLabel = opts.isBrowserFeed ? 'Browser page fed to AI' : opts.isWriteFileFeed ? 'File error fed to AI' : 'Shell output fed to AI';
      var statusEl = document.createElement('div');
      statusEl.className = 'msg system-msg';
      statusEl.innerHTML = '<div class="msg-body" style="display:flex;align-items:center;gap:5px;font-size:11px">' +
        '<i class="ti ' + feedIcon + '" style="font-size:12px;opacity:.5"></i>' +
        '<span>' + feedLabel + '</span>' +
      '</div>';
      getConvInner(targetId).appendChild(statusEl);
      showMessages();
    } else if (displayText) {
      appendMessageDOM('user', displayText, [], true);
      showMessages();
    }
    scrollBottom();
  } else if (opts.isAutoFeed || opts.isBrowserFeed) {
    var feedIcon2  = opts.isBrowserFeed ? 'ti-world-www' : opts.isWriteFileFeed ? 'ti-file-alert' : 'ti-terminal-2';
    var feedLabel2 = opts.isBrowserFeed ? 'Browser page fed to AI' : opts.isWriteFileFeed ? 'File error fed to AI' : 'Shell output fed to AI';
    var bgStatusEl = document.createElement('div');
    bgStatusEl.className = 'msg system-msg';
    bgStatusEl.innerHTML = '<div class="msg-body" style="display:flex;align-items:center;gap:5px;font-size:11px">' +
      '<i class="ti ' + feedIcon2 + '" style="font-size:12px;opacity:.5"></i>' +
      '<span>' + feedLabel2 + '</span>' +
    '</div>';
    getConvInner(targetId).appendChild(bgStatusEl);
  }
  saveConversations();
  await streamResponse(conv);
}

async function sendMessage(opts) {
  opts = opts || {};
  if (!state.currentId) newConversation();
  var conv = getConv(state.currentId);
  if (!conv) return;
  if (!opts.fromAutoFeed) conv._autoFeedDepth = 0; // user-initiated → reset chain
  if (conv._streaming) {
    // Safety: if streaming flag is stale (>90s), force reset
    if (Date.now() - (conv._streamingStart || 0) > 90000) {
      dbg('⚠ streaming flag stale — force reset', 'warn');
      conv._streaming = false;
      conv._autoFeedDepth = 0;
      setBusy(false);
    } else {
      dbg('⛔ sendMessage blocked — already streaming', 'warn');
      return;
    }
  }
  var input = document.getElementById('msg-input');
  var text  = input.value.trim();
  if (!text && !state.pendingAttachments.length) { dbg('sendMessage: empty input', 'warn'); return; }
  dbg('sendMessage: ' + text.slice(0,80), 'info');

  // Handle multi-agent composition: @agent1 + @agent2 [parallel] message
  var compParsed = typeof parseCompositionMention === 'function' ? parseCompositionMention(text) : null;
  if (compParsed) {
    input.value = '';
    resizeTextarea(input);
    hideAgentAutocomplete();
    // Record analytics for each agent
    if (typeof recordAgentInvocation === 'function') {
      compParsed.agents.forEach(function(n) { recordAgentInvocation(n); });
    }
    await runComposition(compParsed.agents, compParsed.mode, compParsed.text, conv);
    return;
  }

  // Multi-chip sequential composition: when 2+ agent chips are active, run them sequentially
  if (typeof _agentChips !== 'undefined' && _agentChips.length > 1 && text) {
    input.value = '';
    resizeTextarea(input);
    hideAgentAutocomplete();
    await runMultiChipComposition(_agentChips.slice(), text, conv, state.pendingAttachments.slice());
    return;
  }

  // Handle @agent mentions
  var agentParsed = parseAgentMention(text);
  if (agentParsed.agent) {
    if (agentParsed.agent === 'default') {
      deactivateAgent(conv);
      text = agentParsed.text;
    } else {
      await activateAgent(agentParsed.agent, conv, agentParsed.inline);
      // Sync agent chips so state is saved to conversation
      if (typeof _syncChipsFromActiveAgent === 'function') _syncChipsFromActiveAgent();
      text = agentParsed.text;
    }
    if (!text && !state.pendingAttachments.length) {
      // Only agent switch, no message content
      input.value = '';
      resizeTextarea(input);
      hideAgentAutocomplete();
      return;
    }
  }
  hideAgentAutocomplete();

  // ── Slash command interception (smart features) ─────────────────────────
  if (typeof handleSlashCommand === 'function' && handleSlashCommand(text)) {
    input.value = '';
    resizeTextarea(input);
    return;
  }

  // Build user message content (text + file/url attachments + auto-gathered system context)
  var content = text;
  var pendingImages = [];
  if (state.pendingAttachments.length) {
    state.pendingAttachments.forEach(att => {
      if (att.type === 'image') {
        pendingImages.push({ base64: att.base64, mime: att.mime, name: att.name });
      } else {
        var label = att.type === 'url' ? `URL: ${att.name}` : `File: ${att.name}`;
        content += '\n\n' + '```\n// ' + label + '\n' + att.content + '\n```';
      }
    });
  }

  // Inject live system context when the message is about system tasks
  var sysContext = await gatherSystemContext(text);
  var apiContent = sysContext ? content + sysContext : content;

  var userMsg = { role: 'user', content: apiContent, images: pendingImages.length ? pendingImages : undefined, attachments: state.pendingAttachments.map(a => ({ type: a.type, name: a.name, base64: a.type === 'image' ? a.base64 : undefined, mime: a.type === 'image' ? a.mime : undefined })) };
  conv.messages.push(userMsg);

  // Auto-title from first message
  if (conv.messages.length === 1) {
    conv.title = text.slice(0, 45) || 'Conversation';
    document.getElementById('topbar-title').textContent = conv.title;
    renderConvList();
  }

  saveConversations();
  appendMessageDOM('user', content, userMsg.attachments, true);
  showMessages();
  clearAttachments();

  input.value = '';
  resizeTextarea(input);
  scrollBottom();

  await streamResponse(conv);
}

// ── Multi-chip composition ────────────────────────────────────────────────
// When 2+ agent chips are active: show mode picker (parallel/sequential),
// run all agents via /api/chat (like sub-agent delegation), show result cards.

async function runMultiChipComposition(agentNames, userMessage, conv, attachments) {
  if (!conv) return;
  attachments = attachments || [];

  // Build content with any file/url attachments appended (same as sendMessage)
  var content = userMessage;
  var pendingImages = [];
  attachments.forEach(function(att) {
    if (att.type === 'image') {
      pendingImages.push({ base64: att.base64, mime: att.mime, name: att.name });
    } else {
      var label = att.type === 'url' ? 'URL: ' + att.name : 'File: ' + att.name;
      content += '\n\n```\n// ' + label + '\n' + att.content + '\n```';
    }
  });

  // Show the user message in chat
  var userMsg = { role: 'user', content: content, images: pendingImages.length ? pendingImages : undefined };
  conv.messages.push(userMsg);

  if (conv.messages.length === 1) {
    conv.title = userMessage.slice(0, 45) || 'Conversation';
    document.getElementById('topbar-title').textContent = conv.title;
    renderConvList();
  }
  saveConversations();
  appendMessageDOM('user', content, null, true);
  showMessages();
  clearAttachments();
  scrollBottom();

  // Use per-conv DOM container so switching away doesn't hide/destroy the progress UI
  var inner = getConvInner(conv.id);

  // Mark conv as streaming so sidebar shows spinner + other convo sends are not blocked
  conv._streaming = true;
  conv._streamingStart = Date.now();
  if (state.currentId === conv.id) setBusy(true);

  // ── Build progress UI with mode picker ───────────────────────────────────
  var mcId = 'mc-' + Date.now();
  var agentRows = agentNames.map(function(n, i) {
    var a = findAgent(n);
    var icon = a ? (a.icon || 'ti-robot') : 'ti-robot';
    var name = a ? a.displayName : n;
    return '<div class="delegation-agent-row" id="mc-row-' + i + '-' + mcId + '">' +
      '<div class="delegation-agent-status"></div>' +
      '<i class="ti ' + escHtml(icon) + ' delegation-agent-icon"></i>' +
      '<span class="delegation-agent-name">' + escHtml(name) + '</span>' +
      '<span class="delegation-agent-task" id="mc-task-' + i + '-' + mcId + '">' + escHtml(userMessage.length > 70 ? userMessage.substring(0, 70) + '…' : userMessage) + '</span>' +
      '<span class="delegation-agent-time" id="mc-time-' + i + '-' + mcId + '"></span>' +
    '</div>';
  }).join('');

  var agentOptionsHtml = agentNames.map(function(n, i) {
    var a = findAgent(n);
    var icon = a ? (a.icon || 'ti-robot') : 'ti-robot';
    var name = a ? a.displayName : n;
    return '<button class="deleg-mode-btn deleg-single-agent-btn" onclick="window[\'_mcPickMode_' + mcId + '\'] && window[\'_mcPickMode_' + mcId + '\'](\'single:' + i + '\')">' +
      '<i class="ti ' + escHtml(icon) + '"></i> ' + escHtml(name) + '</button>';
  }).join('');

  var modePickerHtml =
    '<div class="delegation-mode-picker" id="mc-mode-picker-' + mcId + '">' +
      '<span class="deleg-mode-label"><i class="ti ti-settings-2"></i> Run mode:</span>' +
      '<button class="deleg-mode-btn" id="mc-mode-parallel-' + mcId + '" onclick="window[\'_mcPickMode_' + mcId + '\'] && window[\'_mcPickMode_' + mcId + '\'](\'parallel\')"><i class="ti ti-bolt"></i> Parallel</button>' +
      '<button class="deleg-mode-btn" id="mc-mode-sequential-' + mcId + '" onclick="window[\'_mcPickMode_' + mcId + '\'] && window[\'_mcPickMode_' + mcId + '\'](\'sequential\')"><i class="ti ti-arrow-down"></i> Sequential</button>' +
      '<button class="deleg-mode-btn" onclick="var el=document.getElementById(\'mc-single-picker-' + mcId + '\');el.style.display=el.style.display===\'none\'?\'\':\'none\'"><i class="ti ti-user"></i> Single</button>' +
    '</div>' +
    '<div class="delegation-single-picker" id="mc-single-picker-' + mcId + '" style="display:none">' +
      '<span class="deleg-mode-label">Pick one agent:</span>' +
      agentOptionsHtml +
    '</div>';

  var progressEl = document.createElement('div');
  progressEl.className = 'delegation-progress';
  progressEl.innerHTML =
    '<div class="delegation-progress-header" id="mc-header-' + mcId + '"><i class="ti ti-hierarchy-3"></i> Running ' + agentNames.length + ' agents…</div>' +
    modePickerHtml +
    '<div class="delegation-agent-list">' + agentRows + '</div>';
  if (inner) { inner.appendChild(progressEl); scrollBottom(); }

  // ── Wait for user mode choice — no auto-timeout ──────────────────────────
  var chosenMode = await new Promise(function(resolve) {
    window['_mcPickMode_' + mcId] = function(mode) {
      resolve(mode);
    };
  });
  window['_mcPickMode_' + mcId] = null;

  // Handle single-agent mode
  if (chosenMode.startsWith('single:')) {
    var singleIdx = parseInt(chosenMode.split(':')[1], 10);
    agentNames = [agentNames[singleIdx]];
    chosenMode = 'parallel';
  }

  // ── Setup abort + show stop button ───────────────────────────────────────
  var abortCtrl = new AbortController();
  var cancelled = false;
  var stopId = 'mc-stop-' + mcId;
  var headerEl = document.getElementById('mc-header-' + mcId);

  var pickerEl = document.getElementById('mc-mode-picker-' + mcId);
  if (pickerEl) {
    pickerEl.innerHTML =
      '<span class="deleg-mode-chosen"><i class="ti ti-' + (chosenMode === 'sequential' ? 'arrow-down' : 'bolt') + '"></i> ' + (chosenMode === 'sequential' ? 'Sequential' : 'Parallel') + '</span>' +
      '<button class="deleg-stop-btn" id="' + stopId + '" onclick="window._mcStop_' + mcId + ' && window._mcStop_' + mcId + '()"><i class="ti ti-player-stop-filled"></i> Stop all</button>';
  }

  window['_mcStop_' + mcId] = function() {
    cancelled = true;
    abortCtrl.abort();
    var btn = document.getElementById(stopId);
    if (btn) btn.disabled = true;
    agentNames.forEach(function(_, _i) {
      var _r = document.getElementById('mc-row-' + _i + '-' + mcId);
      if (_r && (_r.classList.contains('working') || _r.classList.contains('pending'))) {
        _r.classList.remove('working', 'pending');
        _r.classList.add('cancelled');
        var _st = _r.querySelector('.delegation-agent-status');
        if (_st) _st.innerHTML = '<i class="ti ti-minus" style="font-size:10px;color:var(--text-muted)"></i>';
      }
    });
    if (headerEl) { headerEl.innerHTML = '<i class="ti ti-player-stop-filled"></i> Stopped by user'; headerEl.classList.add('cancelled'); }
    conv._streaming = false;
    conv._abortController = null;
    if (state.currentId === conv.id) setBusy(false);
    renderConvList();
  };

  // ── Mark rows as pending (sequential) or working (parallel) ──────────────
  agentNames.forEach(function(_, i) {
    var _r = document.getElementById('mc-row-' + i + '-' + mcId);
    if (!_r) return;
    if (chosenMode === 'sequential') {
      _r.classList.add('pending');
      _r.querySelector('.delegation-agent-status').innerHTML = '<span class="deleg-pending-dot"></span>';
    } else {
      _r.classList.add('working');
      _r.querySelector('.delegation-agent-status').innerHTML = '<span class="delegation-spinner"></span>';
    }
  });
  scrollBottom();

  // ── runOne: call /api/chat for a single agent ─────────────────────────────
  function runOne(agent, idx, task, priorResultsText) {
    if (cancelled) return Promise.resolve({ agentName: agent.name, displayName: agent.displayName, icon: agent.icon || 'ti-robot', task: task, response: 'Cancelled', duration: 0, cancelled: true });
    var row = document.getElementById('mc-row-' + idx + '-' + mcId);
    var timeEl = document.getElementById('mc-time-' + idx + '-' + mcId);
    if (row) { row.classList.remove('pending'); row.classList.add('working'); row.querySelector('.delegation-agent-status').innerHTML = '<span class="delegation-spinner"></span>'; }
    var start = Date.now();
    var timerTick = setInterval(function() {
      if (timeEl && row && row.classList.contains('working'))
        timeEl.textContent = ((Date.now() - start) / 1000).toFixed(0) + 's';
    }, 500);
    var userContent = task + (priorResultsText ? '\n\n---\nPrevious agent results for context:\n' + priorResultsText : '');
    return fetch('/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      signal: abortCtrl.signal,
      body: JSON.stringify({
        messages: [{ role: 'user', content: userContent }],
        model: state.model,
        agentName: agent.name,
        agentSystemPrompt: agent.systemPrompt || '',
        agentPermissions: agent.permissions || {},
        useFigmaMCP: state.figmaMCPEnabled || false,
        thinkingBudget: state.thinkingBudget || 'high',
        systemPrompt: '## Active Agent: ' + agent.displayName + '\n\n' + (agent.systemPrompt || '') + '\n\nYou are running as one of several agents in a multi-agent session. Complete your assigned task thoroughly.'
      })
    }).then(function(r) {
      return typeof readDelegationStream === 'function' ? readDelegationStream(r, abortCtrl.signal) : r.text();
    }).then(function(text) {
      clearInterval(timerTick);
      var dur = Date.now() - start;
      if (row) { row.classList.remove('working'); row.classList.add('done'); }
      if (timeEl) timeEl.textContent = (dur / 1000).toFixed(1) + 's';
      return { agentName: agent.name, displayName: agent.displayName, icon: agent.icon || 'ti-robot', task: task, response: text, duration: dur };
    }).catch(function(e) {
      clearInterval(timerTick);
      var dur = Date.now() - start;
      var isCancelled = e.name === 'AbortError' || cancelled;
      if (row) { row.classList.remove('working'); row.classList.add(isCancelled ? 'cancelled' : 'error'); }
      if (timeEl) timeEl.textContent = (dur / 1000).toFixed(1) + 's';
      return { agentName: agent.name, displayName: agent.displayName || agent.name, icon: 'ti-robot', task: task, response: isCancelled ? 'Cancelled' : ('Error: ' + e.message), duration: dur, error: !isCancelled, cancelled: isCancelled };
    });
  }

  // ── Execute ───────────────────────────────────────────────────────────────
  var results = [];
  if (chosenMode === 'sequential') {
    for (var _si = 0; _si < agentNames.length; _si++) {
      if (cancelled) break;
      var _agent = findAgent(agentNames[_si]);
      if (!_agent) continue;
      var priorCtx = results.length ? results.map(function(r) { return '**' + (r.displayName || r.agentName) + '**: ' + r.response.substring(0, 800); }).join('\n\n') : null;
      var res = await runOne(_agent, _si, userMessage, priorCtx);
      results.push(res);
    }
  } else {
    // Parallel — all at once
    results = await Promise.all(agentNames.map(function(n, i) {
      var _a = findAgent(n);
      if (!_a) return Promise.resolve({ agentName: n, displayName: n, icon: 'ti-robot', task: userMessage, response: 'Agent not found', duration: 0, error: true });
      return runOne(_a, i, userMessage, null);
    }));
  }

  delete window['_mcStop_' + mcId];

  // Clear streaming state
  conv._streaming = false;
  conv._abortController = null;
  if (state.currentId === conv.id) setBusy(false);
  renderConvList();

  // ── Finalize ──────────────────────────────────────────────────────────────
  if (cancelled) {
    // headerEl already updated by _mcStop handler
    return;
  }

  if (headerEl) {
    headerEl.innerHTML = '<i class="ti ti-circle-check"></i> All ' + agentNames.length + ' agents complete';
    headerEl.classList.add('complete');
  }

  // Show per-agent result cards (reuse delegation renderer)
  if (typeof showDelegationResults === 'function') {
    showDelegationResults(results, inner);
  }

  // Persist results summary to conversation
  var summary = results.map(function(r) {
    return '**' + escHtml(r.displayName || r.agentName) + '**\n' + (r.response || '');
  }).join('\n\n---\n\n');
  var aiSummaryMsg = { role: 'assistant', content: summary };
  conv.messages.push(aiSummaryMsg);
  saveConversations();

  scrollBottom();
  if (typeof renderAgentChips === 'function') renderAgentChips();
}

async function streamResponse(conv) {
  var convId = conv.id;
  function isActive() { return state.currentId === convId; }

  conv._streaming = true;
  conv._streamingStart = Date.now();
  conv._abortController = new AbortController();
  if (isActive()) setBusy(true);
  renderConvList(); // show streaming spinner in sidebar

  // Create AI message placeholder — append to this conv's own DOM container (works in background too)
  var _currentAgentInfo = null;
  if (typeof isAgentActive === 'function' && isAgentActive()) {
    _currentAgentInfo = { name: activeAgent.name, displayName: activeAgent.displayName, icon: activeAgent.manifest.icon || 'ti-robot' };
  }
  var msgEl  = createMessageEl('ai', _currentAgentInfo);
  var bodyEl = msgEl.querySelector('.msg-body');
  bodyEl.innerHTML = '<div class="thinking"><div class="think-dot"></div><div class="think-dot"></div><div class="think-dot"></div></div>';
  getConvInner(convId).appendChild(msgEl);
  if (isActive()) { showMessages(); scrollBottom(); }

  var buffer       = '';
  var renderTimer  = null;
  var lastScrolled = 0;
  var tokenCount   = 0;

  function scheduleRender() {
    if (!isActive() || !bodyEl) return;
    if (renderTimer) return;
    renderTimer = setTimeout(() => {
      renderTimer = null;
      if (buffer) {
        bodyEl.classList.add('streaming-cursor');
        bodyEl.innerHTML = renderStreamingCOT(buffer);
        var now = Date.now();
        if (now - lastScrolled > 200) { scrollBottom(); lastScrolled = now; }
      }
    }, 60);
  }

  try {
    var messages = conv.messages.slice(0, -1).concat([conv.messages[conv.messages.length - 1]])
      .map(m => {
        if (m.images && m.images.length) {
          var parts = [];
          if (m.content) parts.push({ type: 'text', text: m.content });
          m.images.forEach(img => parts.push({
            type: 'image_url',
            image_url: { url: 'data:' + img.mime + ';base64,' + img.base64, detail: 'high' }
          }));
          return { role: m.role, content: parts };
        }
        return { role: m.role, content: m.content };
      });

    var userSysPrompt  = document.getElementById('sys-prompt-input').value;
    // Only inject Figma context when user has explicitly enabled Figma MCP
    var figmaCtx       = state.figmaMCPEnabled ? getFigmaContext() : '';
    var capsCtx        = getCapabilitiesContext();
    var agentCtx       = getAgentRulesContext();
    var agentSysCtx    = getAgentSystemPrompt();
    var playbookCtx    = getPlaybookContext();
    // Extract user text from last user message for keyword-gated memory injection
    var lastUserMsg = conv.messages.slice().reverse().find(function(m) { return m.role === 'user'; });
    var userText = lastUserMsg ? (typeof lastUserMsg.content === 'string' ? lastUserMsg.content : (lastUserMsg.content.find(function(c){ return c.type === 'text'; }) || {}).text || '') : '';
    var memoryCtx      = getMemoryContext(userText);
    var workspaceCtx   = typeof getWorkspaceContextPrompt === 'function' ? getWorkspaceContextPrompt() : '';

    // Concise chat directive: terse in conversation, verbose only when writing output
    var conciseDirective = '## Communication Style\n' +
      'Be concise in conversation. Drop filler, hedging, pleasantries. Short answers for simple questions.\n' +
      'Write FULL verbose content only when producing: code blocks, file content, specs, documents, artifacts, commit messages.\n' +
      'Security warnings and irreversible actions: always be explicit and clear.\n' +
      'Pattern: [thing] [action] [reason]. Not: "Sure! I\'d be happy to help you with that. The issue is likely..."';

    var systemPrompt   = [agentSysCtx ? agentSysCtx + '\n\n' + getAgentMetaContext() : (capsCtx + agentCtx), playbookCtx, memoryCtx, workspaceCtx, figmaCtx, conciseDirective, userSysPrompt].filter(Boolean).join('\n\n');

    dbg('► fetch /api/chat model=' + state.model + ' msgs=' + messages.length + ' sysPrompt=' + systemPrompt.length + 'ch', 'cmd');

    // Track context sizes for the meter
    var _ctxSysChars = systemPrompt.length;
    var _ctxMsgChars = JSON.stringify(messages).length;
    var _ctxUsage = null;

    // Build chat request body — include agent info when active
    var chatBody = { messages, model: state.model, systemPrompt, useFigmaMCP: state.figmaMCPEnabled, contextSummary: conv.contextSummary || '', thinkingBudget: state.thinkingBudget, maxContextTurns: state.maxContextTurns };
    if (typeof isAgentActive === 'function' && isAgentActive()) {
      chatBody.agentName = getActiveAgentName();
      chatBody.agentPermissions = getActiveAgentPermissions();
    }

    var response = await fetch('/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(chatBody),
      signal: conv._abortController.signal
    });

    dbg('◀ fetch status=' + response.status, response.ok ? 'ok' : 'err');

    var reader  = response.body.getReader();
    var decoder = new TextDecoder();
    var partial = '';

    while (true) {
      var done_val;
      var value_val;
      var readResult = await reader.read();
      done_val = readResult.done; value_val = readResult.value;
      if (done_val) break;

      partial += decoder.decode(value_val, { stream: true });
      var lines = partial.split('\n');
      partial   = lines.pop();

      for (var i = 0; i < lines.length; i++) {
        var line = lines[i];
        if (!line.startsWith('data: ')) continue;
        var raw = line.slice(6);
        if (raw === '[DONE]') continue;
        try {
          var evt = JSON.parse(raw);
          if (evt.type === 'content')   { buffer += evt.content; tokenCount++; if (tokenCount === 1) dbg('first token received', 'ok'); scheduleRender(); }
          if (evt.type === 'error')     { dbg('SSE error: ' + evt.error, 'err'); buffer += '\n\nError: ' + evt.error; scheduleRender(); }
          if (evt.type === 'tool_call') {
            dbg('tool_call: ' + evt.name, 'cmd');
            // Pick a readable label based on the tool name
            var toolLabel = evt.name || 'tool';
            var isFigma = /figma/i.test(toolLabel);
            var toolPrefix = isFigma ? 'Calling Figma tool' : 'Calling tool';
            buffer += '\n\n*' + toolPrefix + ': `' + toolLabel + '`…*\n\n';
            scheduleRender();
          }
          if (evt.type === 'done') {
            dbg('done: finish_reason=' + evt.finish_reason + ' usage=' + JSON.stringify(evt.usage), evt.finish_reason ? 'ok' : 'warn');
            if (evt.usage) _ctxUsage = evt.usage;
          }
        } catch (e) {}
      }
    }
  } catch (err) {
    dbg('stream error: ' + err.message, 'err');
    if (err.name !== 'AbortError') buffer += (buffer ? '\n\n' : '') + err.message;
  } finally {
    if (renderTimer) { clearTimeout(renderTimer); renderTimer = null; }
    dbg('■ stream done — buffer=' + buffer.length + 'ch tokens=' + tokenCount, buffer.length ? 'ok' : 'warn');
    dbg('  raw: ' + JSON.stringify(buffer), 'info');

    // Update context meter (granular breakdown)
    var _meterFn = typeof updateContextMeterGranular === 'function' ? updateContextMeterGranular : updateContextMeter;
    _meterFn({ sysChars: _ctxSysChars, msgChars: _ctxMsgChars, usage: _ctxUsage, outputTokens: tokenCount, model: state.model });

    // Always save the AI message regardless of which conv is active
    var aiMsg = { role: 'assistant', content: buffer };
    if (_currentAgentInfo) aiMsg.agentInfo = _currentAgentInfo;
    conv.messages.push(aiMsg);
    conv._streaming = false;
    conv._abortController = null;
    conv._autoFeedDepth = 0; // reset chain depth after each AI turn
    saveConversations();
    renderConvList(); // remove streaming spinner from sidebar

    // Background summarization — trigger when conversation is getting long
    // so older messages can be dropped without losing task context
    maybeCompressConversation(conv);

    if (isActive()) {
      bodyEl.classList.remove('streaming-cursor');
      // Sanitize write-file blocks BEFORE rendering — extracts file content into
      // _wfContentStore so the markdown renderer never sees large file bytes.
      var renderBuffer = sanitizeWriteFileBlocks(buffer);

      // Orchestrator delegation — check for [DELEGATE:...] blocks
      var delegations = typeof parseDelegations === 'function' ? parseDelegations(buffer) : [];
      if (delegations.length > 0 && typeof isOrchestratorActive === 'function' && isOrchestratorActive()) {
        // Strip delegation blocks from displayed content
        var cleanBuffer = stripDelegationBlocks(renderBuffer || buffer);
        bodyEl.innerHTML = cleanBuffer.trim() ? renderMarkdown(cleanBuffer) : '<span style="color:var(--text-muted)">Delegating tasks…</span>';
        scrollBottom();

        // Extract last user message text for synthesis context
        var lastUserText = '';
        for (var _u = conv.messages.length - 1; _u >= 0; _u--) {
          if (conv.messages[_u].role === 'user') {
            lastUserText = typeof conv.messages[_u].content === 'string' ? conv.messages[_u].content : '';
            break;
          }
        }

        // Execute delegations and synthesize
        try {
          var delResult = await executeDelegations(delegations, conv, lastUserText);
          if (delResult.synthesis) {
            // Add synthesis as a new AI message
            var synthMsg = { role: 'assistant', content: delResult.synthesis };
            if (_currentAgentInfo) synthMsg.agentInfo = _currentAgentInfo;
            synthMsg.isDelegationSynthesis = true;
            conv.messages.push(synthMsg);
            saveConversations();

            var synthEl = createMessageEl('ai', _currentAgentInfo);
            var synthBody = synthEl.querySelector('.msg-body');
            synthBody.innerHTML = renderMarkdown(delResult.synthesis);
            synthEl.classList.add('synthesis-message');
            getConvInner(convId).appendChild(synthEl);
            scrollBottom();
          }
        } catch (delErr) {
          dbg('Delegation error: ' + delErr.message, 'err');
        }
        setBusy(false);
      } else {
        bodyEl.innerHTML = renderBuffer ? renderMarkdown(renderBuffer) : '<span style="color:var(--text-muted)">No response.</span>';

        var shellBlocks = (msgEl.querySelectorAll('code.language-shell-exec')||[]).length;
        dbg('  code blocks found: shell-exec=' + shellBlocks, 'info');

        extractAndRenderFigmaExec(buffer, msgEl);
        extractAndRenderShellExec(buffer, msgEl, false, convId);
        extractAndRenderBrowserActions(buffer, msgEl, false, convId);
        extractAndRenderWriteFile(msgEl, false, convId);
        extractAndRenderSaveInstruction(buffer, msgEl, false);
        extractArtifactsFromBuffer(buffer, msgEl);
        if (typeof extractAndRenderCreateAgent === 'function') extractAndRenderCreateAgent(buffer, msgEl);
        if (typeof extractAndRenderPatchAgent === 'function') extractAndRenderPatchAgent(buffer, msgEl);
        if (typeof extractAndRenderUninstallAgent === 'function') extractAndRenderUninstallAgent(buffer, msgEl);
        wrapInChainOfThought(msgEl);
        if (state._lastMsgWasDesktopTask) {
          injectOrganizerCard(msgEl, buffer);
          state._lastMsgWasDesktopTask = false;
        }
        scrollBottom();
        setBusy(false);
      }
    } else {
      // Background conversation — render into its (hidden) DOM and auto-run shell commands
      dbg('■ background stream done for conv ' + convId, 'info');
      bodyEl.classList.remove('streaming-cursor');
      var renderBuffer = sanitizeWriteFileBlocks(buffer);
      bodyEl.innerHTML = renderBuffer ? renderMarkdown(renderBuffer) : '';
      extractAndRenderFigmaExec(buffer, msgEl);
      extractAndRenderShellExec(buffer, msgEl, false, convId);  // auto-run continues in background
      extractAndRenderBrowserActions(buffer, msgEl, false, convId);
      extractAndRenderWriteFile(msgEl, false, convId);
      extractAndRenderSaveInstruction(buffer, msgEl, false);
      extractArtifactsFromBuffer(buffer, msgEl, true);
      if (typeof extractAndRenderCreateAgent === 'function') extractAndRenderCreateAgent(buffer, msgEl);
      if (typeof extractAndRenderPatchAgent === 'function') extractAndRenderPatchAgent(buffer, msgEl);
      if (typeof extractAndRenderUninstallAgent === 'function') extractAndRenderUninstallAgent(buffer, msgEl);
      wrapInChainOfThought(msgEl);
    }
  }
}

// ── Context summarization ─────────────────────────────────────────────────

// How many chars of history to keep without compressing
var SUMMARIZE_THRESHOLD = 30000;  // trigger when raw history exceeds this
var SUMMARIZE_KEEP_RECENT = 6;    // always keep the last N messages verbatim after summary

async function maybeCompressConversation(conv) {
  if (conv._summarizing) return;  // already in progress

  // Calculate total raw size of conversation
  var totalChars = conv.messages.reduce(function(sum, m) {
    return sum + (typeof m.content === 'string' ? m.content.length : 500);
  }, 0);

  // Only summarize if we're over threshold and have enough messages to make it worthwhile
  if (totalChars < SUMMARIZE_THRESHOLD || conv.messages.length < 8) return;

  // Messages to summarize: everything except the last N (keep recent verbatim)
  var toSummarize = conv.messages.slice(0, -SUMMARIZE_KEEP_RECENT);
  if (toSummarize.length < 4) return;

  dbg('↻ summarizing ' + toSummarize.length + ' old messages (~' + totalChars + ' chars)…', 'info');
  conv._summarizing = true;

  try {
    var r = await fetch('/api/summarize', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ messages: toSummarize, model: state.model })
    });
    if (!r.ok) throw new Error('summarize failed: ' + r.status);
    var data = await r.json();
    if (!data.summary) return;

    // Store summary and drop the summarized messages from history
    conv.contextSummary = data.summary;
    conv.messages = conv.messages.slice(-SUMMARIZE_KEEP_RECENT);
    saveConversations();
    dbg('context compressed — summary: ' + data.summary.length + ' chars, kept last ' + SUMMARIZE_KEEP_RECENT + ' messages', 'ok');

    // Show an indicator in the active conversation
    if (state.currentId === conv.id) {
      var indicator = document.createElement('div');
      indicator.className = 'msg system-msg';
      indicator.innerHTML = '<div class="msg-body" style="display:flex;align-items:center;gap:6px;font-size:11px;color:var(--text-muted)">' +
        '<i class="ti ti-compress" style="font-size:13px"></i>' +
        '<span>Older messages summarized to save context — task state preserved</span>' +
        '<button onclick="showContextSummary(\'' + conv.id + '\')" style="margin-left:auto;font-size:10px;opacity:.7;background:none;border:1px solid var(--border);border-radius:3px;padding:1px 6px;cursor:pointer;color:inherit">View</button>' +
      '</div>';
      getConvInner(conv.id).appendChild(indicator);
    }
  } catch (e) {
    dbg('summarize error: ' + e.message, 'warn');
  } finally {
    conv._summarizing = false;
  }
}

function showContextSummary(convId) {
  var conv = getConv(convId);
  if (!conv || !conv.contextSummary) return;
  // Show as an artifact
  var id = addArtifact({ type: 'markdown', title: 'Task Context Summary', content: conv.contextSummary });
  openArtifact(id);
}

function stopGeneration() {
  var conv = getConv(state.currentId);
  if (conv && conv._abortController) conv._abortController.abort();
  showToast('Generation stopped');
}
