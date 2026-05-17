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

// ── Suggested next steps ──────────────────────────────────────────────────
// Parse ```suggestions blocks and render clickable CTA buttons after the message.
function _fallbackSuggestionsFromMessage(buffer) {
  var text = String(buffer || '');
  if (!text.trim()) return [];
  if (/validation failed|truncated|incomplete|failed|error|not found|exception/i.test(text)) {
    return ['Fix the issue', 'Show the relevant logs', 'Try a safer approach'];
  }
  if (/test|vitest|npm test|playwright|coverage/i.test(text)) {
    return ['Run the tests', 'Fix failing tests', 'Summarize test coverage'];
  }
  if (/(wrote|written|created|generated|saved).*(file|document|guide|markdown|project)|IMPLEMENTATION_GUIDE|README|runbook|spec/i.test(text)) {
    return ['Verify generated files', 'Open the generated document', 'Continue implementation'];
  }
  if (/build|npm run build|electron-builder|compiled|packag/i.test(text)) {
    return ['Run the app', 'Review build warnings', 'Package a release'];
  }
  if (/code|patch|changed|updated|implemented|fixed/i.test(text)) {
    return ['Review the changes', 'Run verification', 'Continue refining'];
  }
  return ['Continue', 'Verify the result', 'Summarize what changed'];
}

function extractAndRenderSuggestions(buffer, msgEl, allowFallback) {
  var match = buffer.match(/```suggestions\n([\s\S]*?)```/);
  var items;
  if (match) {
    try { items = JSON.parse(match[1].trim()); } catch (_) { return; }
  } else if (allowFallback !== false) {
    items = _fallbackSuggestionsFromMessage(buffer);
  } else {
    return;
  }
  if (!Array.isArray(items) || !items.length) return;
  if (msgEl.classList && msgEl.classList.contains('chain-msg')) return;

  // Suggestions are conversation-level CTAs: keep only the latest bar visible.
  var scope = msgEl.closest('.conv-inner') || msgEl.parentElement || document;
  Array.from(scope.querySelectorAll('.suggestion-bar')).forEach(function(old) { old.remove(); });

  var bar = document.createElement('div');
  bar.className = 'suggestion-bar' + (match ? '' : ' suggestion-bar-fallback');
  bar.setAttribute('aria-label', 'Recommended actions');

  items.slice(0, 4).forEach(function(label) {
    var btn = document.createElement('button');
    btn.className = 'suggestion-btn';
    btn.textContent = label;
    btn.onclick = function() {
      bar.remove();
      var input = document.getElementById('msg-input');
      input.value = label;
      sendMessage();
    };
    bar.appendChild(btn);
  });

  // "Other…" button — focuses input so user can type
  var otherBtn = document.createElement('button');
  otherBtn.className = 'suggestion-btn suggestion-btn-other';
  otherBtn.innerHTML = '<i class="ti ti-dots"></i> Other…';
  otherBtn.onclick = function() {
    bar.remove();
    var input = document.getElementById('msg-input');
    input.focus();
  };
  bar.appendChild(otherBtn);

  msgEl.appendChild(bar);
}

// Send a message directly into the conversation (supports vision/array content).
// Used by auto-feed when a screenshot was taken.
async function sendDirectMessage(content, opts) {
  opts = opts || {};
  var targetId = opts.targetConvId || state.currentId;
  if (!targetId) { newConversation(); targetId = state.currentId; }
  var conv = getConv(targetId);
  if (!conv) return;
  if (conv._cancelled) return;
  if (conv._streaming) return;
  if (!opts.fromAutoFeed && !opts.isBrowserFeed) conv._autoFeedDepth = 0;
  if (!opts.fromAutoFeed && !opts.isBrowserFeed) conv._depthLimitNotified = false;

  var isCurrentConv = (targetId === state.currentId);
  var isChainFeed = !!(opts.isAutoFeed || opts.isBrowserFeed);

  var displayText = typeof content === 'string' ? content
    : (content.find(function(c){ return c.type === 'text'; }) || {}).text || '';

  var userMsg = { role: 'user', content: content };
  if (opts.isBrowserFeed) userMsg._isBrowserFeed = true;
  if (opts.isAutoFeed || opts.fromAutoFeed) userMsg._isAutoFeed = true;
  if (opts.isWriteFileFeed) userMsg._isWriteFileFeed = true;
  // Attach inline image if provided (e.g. browser extension snapshot)
  if (opts.image) {
    var imgDataUrl = opts.image;
    var imgMime = 'image/png';
    var imgBase64 = imgDataUrl;
    if (imgDataUrl.startsWith('data:')) {
      var parts = imgDataUrl.match(/^data:([^;]+);base64,(.+)$/);
      if (parts) { imgMime = parts[1]; imgBase64 = parts[2]; }
    }
    userMsg.images = [{ base64: imgBase64, mime: imgMime, name: 'snapshot' }];
  }
  conv.messages.push(userMsg);

  // Mark chain mode so streamResponse can merge the next AI bubble
  if (isChainFeed) conv._chainMode = true;
  if (opts.suppressShellAutoRun) conv._suppressShellAutoRunOnce = true;

  if (isCurrentConv) {
    if (isChainFeed) {
      // Silent — no "Browser page fed to AI" / "Shell output fed to AI" system messages
      dbg('chain feed: ' + (opts.isBrowserFeed ? 'browser' : opts.isWriteFileFeed ? 'write-file' : 'shell/auto'), 'info');
    } else if (displayText) {
      appendMessageDOM('user', displayText, [], true);
      showMessages();
    }
    forceScrollBottom();
  }
  bumpConvToTop(conv.id);
  saveConversations();
  await streamResponse(conv);
}

async function sendMessage(opts) {
  opts = opts || {};
  if (!state.currentId) newConversation();
  var conv = getConv(state.currentId);
  if (!conv) return;
  if (!opts.fromAutoFeed) conv._autoFeedDepth = 0; // user-initiated → reset chain
  if (!opts.fromAutoFeed) conv._depthLimitNotified = false;
  if (!opts.fromAutoFeed) conv._chainMode = false; // user msg → not a chain continuation
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
        var label = att.extSource === 'page'      ? 'Browser page: '      + att.name
                  : att.extSource === 'selection' ? 'Browser selection from ' + (att.sourceUri || att.name)
                  : att.type === 'url'            ? 'URL: ' + att.name
                  : 'File: ' + att.name;
        var ref = att.sourceUri || ('attachment://' + encodeURIComponent(att.name || 'file'));
        var meta = [];
        if (att.mime) meta.push('mime=' + att.mime);
        if (att.size) meta.push('bytes=' + att.size);
        if (att.warning) meta.push('warning=' + att.warning);
        if (att.browser) meta.push('browser=' + att.browser);
        if (att.tabId) meta.push('tabId=' + att.tabId);
        if (att.clientId) meta.push('clientId=' + att.clientId);
        var header = '// ' + label + '\n// Ref: ' + ref + (meta.length ? '\n// Meta: ' + meta.join(', ') : '');
        content += '\n\n```\n' + header + '\n' + (att.content || '') + '\n```';
      }
    });
  }

  // Inject live system context when the message is about system tasks
  var sysContext = await gatherSystemContext(text);
  var apiContent = sysContext ? content + sysContext : content;

  // Inject current date/time — gives the AI authoritative "today" context on every turn
  apiContent += '\n\n[Current date and time: ' + new Intl.DateTimeFormat('en', { dateStyle: 'full', timeStyle: 'short', hour12: false }).format(new Date()) + ']';

  var userMsg = {
    role: 'user',
    content: apiContent,
    _displayText: text,
    images: pendingImages.length ? pendingImages : undefined,
    attachments: state.pendingAttachments.map(function(a) {
      return {
        type: a.type,
        name: a.name,
        content: a.type === 'image' ? undefined : a.content,
        sourceUri: a.sourceUri,
        extSource: a.extSource,
        browser: a.browser,
        tabId: a.tabId,
        clientId: a.clientId,
        size: a.size,
        warning: a.warning,
        base64: a.type === 'image' ? a.base64 : undefined,
        mime: a.mime
      };
    })
  };
  conv.messages.push(userMsg);

  bumpConvToTop(conv.id);
  saveConversations();
  appendMessageDOM('user', content, userMsg.attachments, true);
  showMessages();
  clearAttachments();

  input.value = '';
  resizeTextarea(input);
  forceScrollBottom();

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
      var ref = att.sourceUri || ('attachment://' + encodeURIComponent(att.name || 'file'));
      var meta = [];
      if (att.mime) meta.push('mime=' + att.mime);
      if (att.size) meta.push('bytes=' + att.size);
      if (att.warning) meta.push('warning=' + att.warning);
      var header = '// ' + label + '\n// Ref: ' + ref + (meta.length ? '\n// Meta: ' + meta.join(', ') : '');
      content += '\n\n```\n' + header + '\n' + (att.content || '') + '\n```';
    }
  });

  // Show the user message in chat
  var userMsg = { role: 'user', content: content, images: pendingImages.length ? pendingImages : undefined };
  conv.messages.push(userMsg);

  saveConversations();
  appendMessageDOM('user', content, null, true);
  showMessages();
  clearAttachments();
  forceScrollBottom();

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

  // ── Setup abort ───────────────────────────────────────────────────────────
  var abortCtrl = new AbortController();
  var cancelled = false;
  var headerEl = document.getElementById('mc-header-' + mcId);

  var pickerEl = document.getElementById('mc-mode-picker-' + mcId);
  if (pickerEl) {
    pickerEl.innerHTML =
      '<span class="deleg-mode-chosen"><i class="ti ti-' + (chosenMode === 'sequential' ? 'arrow-down' : 'bolt') + '"></i> ' + (chosenMode === 'sequential' ? 'Sequential' : 'Parallel') + '</span>';
  }

  window['_mcStop_' + mcId] = function() {
    cancelled = true;
    abortCtrl.abort();
    agentNames.forEach(function(_, _i) {
      var _r = document.getElementById('mc-row-' + _i + '-' + mcId);
      if (_r && (_r.classList.contains('working') || _r.classList.contains('pending'))) {
        _r.classList.remove('working', 'pending');
        _r.classList.add('cancelled');
        var _st = _r.querySelector('.delegation-agent-status');
        if (_st) _st.innerHTML = '<i class="ti ti-minus" style="font-size:10px;color:var(--fau-text-muted)"></i>';
      }
    });
    if (headerEl) { headerEl.innerHTML = '<i class="ti ti-player-stop-filled"></i> Stopped by user'; headerEl.classList.add('cancelled'); }
    conv._streaming = false;
    conv._abortController = null;
    if (state.currentId === conv.id) setBusy(false);
    renderConvList();
  };
  // Expose to main stop button
  window._delegStop = window['_mcStop_' + mcId];

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
        isDelegation: true,
        useFigmaMCP: !!(agent.permissions && agent.permissions.figma),
        usePlaywrightMCP: !!(agent.permissions && agent.permissions.browser),
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
  if (typeof maybeUpdateConversationTitle === 'function') maybeUpdateConversationTitle(conv);

  forceScrollBottom();
  if (typeof renderAgentChips === 'function') renderAgentChips();
}

async function streamResponse(conv) {
  var convId = conv.id;
  function isActive() { return state.currentId === convId; }

  conv._streaming = true;
  conv._streamingStart = Date.now();
  conv._cancelled = false;
  conv._abortController = new AbortController();
  if (isActive()) setBusy(true);
  renderConvList(); // show streaming spinner in sidebar

  // Create AI message placeholder — append to this conv's own DOM container (works in background too)
  var _currentAgentInfo = null;
  if (typeof isAgentActive === 'function' && isAgentActive()) {
    _currentAgentInfo = { name: activeAgent.name, displayName: activeAgent.displayName, icon: activeAgent.manifest.icon || 'ti-robot' };
  }
  var msgEl  = createMessageEl('ai', _currentAgentInfo);
  msgEl.dataset.streamingLive = '1';
  var bodyEl = msgEl.querySelector('.msg-body');
  function _ensureLiveMessageAttached() {
    if (!conv._streaming) return;
    if (msgEl.isConnected) return;
    var inner = getConvInner(convId);
    if (!inner) return;
    Array.from(inner.querySelectorAll('.msg.ai[data-streaming-live="1"]')).forEach(function(existing) {
      if (existing !== msgEl) existing.remove();
    });
    inner.appendChild(msgEl);
    if (isActive()) { showMessages(); forceScrollBottom(); }
  }
  function _streamingStatusHtml(label) {
    return '<div class="thinking streaming-status">' +
      '<div class="think-dot"></div><div class="think-dot"></div><div class="think-dot"></div>' +
      '<span class="thinking-label">' + escHtml(label || 'Fauna is working…') + '</span>' +
    '</div>';
  }
  function _bodyHasVisibleStreamContent() {
    if (!bodyEl) return false;
    if ((bodyEl.textContent || '').trim()) return true;
    return !!bodyEl.querySelector('img,svg,iframe,video,audio,canvas,.cot-pill,.tool-status-stack,.shell-output-block');
  }
  function _ensureStreamingStatus(label) {
    _ensureLiveMessageAttached();
    if (!conv._streaming || !isActive() || !bodyEl) return;
    if (!_bodyHasVisibleStreamContent()) bodyEl.innerHTML = _streamingStatusHtml(label);
  }
  bodyEl.innerHTML = _streamingStatusHtml('Fauna is thinking…');
  // Chain-merge: if this is a continuation from auto-feed, visually merge with previous AI message
  if (conv._chainMode) {
    msgEl.classList.add('chain-msg');
    conv._chainMode = false;
  }
  getConvInner(convId).appendChild(msgEl);
  if (isActive()) { showMessages(); forceScrollBottom(); }

  var buffer       = '';
  var renderTimer  = null;
  var lastScrolled = 0;
  var tokenCount   = 0;
  var _lastRenderTraceAt = 0;
  var _streamStartedAt = Date.now();
  var _lastToolOutputAccum = ''; // rolling last ~1000 chars of tool_output for input context
  var _reasoning = null; // { startedAt, durationSeconds } — compact thinking status only
  if (typeof resetDesignArtifactState === 'function') resetDesignArtifactState();

  // ── Ephemeral tool status stack (Clawpilot-style) ──────────────────
  var _toolStatuses = []; // { label, ts }
  var _toolStatusEl = null;
  function _addToolStatus(label) {
    _toolStatuses.push({ label: label, ts: Date.now() });
    if (_toolStatuses.length > 3) _toolStatuses.shift();
    _renderToolStatuses();
  }
  function _clearToolStatuses() {
    _toolStatuses = [];
    if (_toolStatusEl) { _toolStatusEl.remove(); _toolStatusEl = null; }
    _ensureStreamingStatus('Fauna is working…');
  }
  function _renderToolStatuses() {
    if (!_toolStatuses.length) { _clearToolStatuses(); return; }
    if (bodyEl && bodyEl.querySelector('.streaming-status') && !buffer) bodyEl.innerHTML = '';
    if (!_toolStatusEl) {
      _toolStatusEl = document.createElement('div');
      _toolStatusEl.className = 'tool-status-stack';
      bodyEl.appendChild(_toolStatusEl);
    }
    var html = '';
    var last = _toolStatuses.length - 1;
    for (var t = 0; t < _toolStatuses.length; t++) {
      var op = t === last ? 1 : t === last - 1 ? 0.6 : 0.4;
      html += '<div class="tool-status-line" style="opacity:' + op + '">' +
        '<span class="tool-status-icon">⚡</span>' +
        '<span class="' + (t === last ? 'tool-status-shimmer' : '') + '">' + escHtml(_toolStatuses[t].label) + '</span>' +
      '</div>';
    }
    _toolStatusEl.innerHTML = html;
  }

  function scheduleRender() {
    _ensureLiveMessageAttached();
    if (!isActive() || !bodyEl) return;
    if (renderTimer) return;
    renderTimer = setTimeout(() => {
      renderTimer = null;
      if (buffer) {
        bodyEl.classList.add('streaming-cursor');
        var renderStart = (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now();
        var liveBuffer = typeof redactWriteFileBlocksForStreaming === 'function' ? redactWriteFileBlocksForStreaming(buffer) : buffer;
        var rendered = (typeof renderStreamingActivity === 'function' ? renderStreamingActivity : renderStreamingCOT)(liveBuffer);
        var renderEnd = (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now();
        if (rendered && rendered.trim()) bodyEl.innerHTML = rendered;
        else _ensureStreamingStatus('Fauna is working…');
        var now = Date.now();
        if (now - _lastRenderTraceAt > 1000 || liveBuffer.length !== buffer.length) {
          _lastRenderTraceAt = now;
          dbg('stream render: raw=' + buffer.length + 'ch visible=' + liveBuffer.length + 'ch html=' + (rendered || '').length + 'ch renderMs=' + (renderEnd - renderStart).toFixed(1), 'info');
        }
        if (now - lastScrolled > 200) { scrollBottom(); lastScrolled = now; }
      } else {
        _ensureStreamingStatus('Fauna is working…');
      }
    }, 60);
  }

  function _updateReasoningPanel(durationSeconds, completed) {
    _ensureLiveMessageAttached();
    if (!isActive() || !msgEl) return;
    var panel = msgEl.querySelector('.reasoning-panel');
    if (completed && !_reasoning) {
      if (panel) panel.remove();
      return;
    }
    if (!panel) {
      panel = document.createElement('div');
      panel.className = 'reasoning-panel';
      msgEl.insertBefore(panel, msgEl.querySelector('.msg-body'));
    }
    var elapsed = durationSeconds != null ? durationSeconds
                : (_reasoning && _reasoning.startedAt) ? Math.round((Date.now() - _reasoning.startedAt) / 1000) : null;
    var label = completed
      ? ('Thought for ' + (elapsed != null ? elapsed + 's' : '…'))
      : (elapsed != null ? 'Thinking… ' + elapsed + 's' : 'Thinking…');
    var open = false;
    panel.dataset.completed = completed ? '1' : '';
    panel.dataset.open = panel.dataset.open === '0' ? '0' : (open ? '1' : '0');
    var isOpen = panel.dataset.open !== '0';
    panel.innerHTML =
      '<button class="reasoning-toggle" type="button">' +
        '<i class="ti ' + (completed ? 'ti-brain' : 'ti-loader-2') + '" ' + (completed ? '' : 'style="animation:spin .8s linear infinite"') + '></i>' +
        '<span class="reasoning-label">' + label + '</span>' +
      '</button>';
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
    var repoInstructionsCtx = typeof getRepositoryInstructionsPrompt === 'function' ? getRepositoryInstructionsPrompt() : '';
    var workspaceCtx   = typeof getWorkspaceContextPrompt === 'function' ? getWorkspaceContextPrompt() : '';

    // Concise chat directive: terse in conversation, verbose only when writing output
    var conciseDirective = '## Communication Style\n' +
      'Be concise in conversation. Drop filler, hedging, pleasantries. Short answers for simple questions.\n' +
      'Write FULL verbose content only when producing: code blocks, file content, specs, documents, artifacts, commit messages.\n' +
      'Security warnings and irreversible actions: always be explicit and clear.\n' +
      'Pattern: [thing] [action] [reason]. Not: "Sure! I\'d be happy to help you with that. The issue is likely..."';

    var systemPrompt   = [agentSysCtx ? agentSysCtx + '\n\n' + getAgentMetaContext() : (capsCtx + agentCtx), playbookCtx, memoryCtx, repoInstructionsCtx, workspaceCtx, figmaCtx, conciseDirective, typeof GEN_UI_CATALOG_PROMPT !== 'undefined' ? GEN_UI_CATALOG_PROMPT : '', userSysPrompt].filter(Boolean).join('\n\n');

    dbg('► fetch /api/chat model=' + state.model + ' msgs=' + messages.length + ' sysPrompt=' + systemPrompt.length + 'ch', 'cmd');

    // Track context sizes for the meter
    var _ctxSysChars = systemPrompt.length;
    var _ctxMsgChars = JSON.stringify(messages).length;
    var _ctxUsage = null;

    // Build chat request body — include agent info when active
    var chatBody = { messages, model: state.model, systemPrompt, useFigmaMCP: state.figmaMCPEnabled, usePlaywrightMCP: state.playwrightMCPEnabled || false, contextSummary: conv.contextSummary || '', thinkingBudget: state.thinkingBudget, maxContextTurns: state.maxContextTurns };
    if (typeof isAgentActive === 'function' && isAgentActive()) {
      chatBody.agentName = getActiveAgentName();
      chatBody.agentPermissions = getActiveAgentPermissions();
    }
    // Include active project + enabled context IDs
    if (state.activeProjectId) {
      chatBody.projectId = state.activeProjectId;
      var enabledCtxIds = Object.keys(state.projectContextEnabled || {}).filter(function(k) { return state.projectContextEnabled[k]; });
      if (enabledCtxIds.length) chatBody.projectContextIds = enabledCtxIds;
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

          // Close any open shell-output fence before non-output events
          if (evt.type !== 'tool_output' && buffer.includes('```shell-output\n')) {
            var lastOpen = buffer.lastIndexOf('```shell-output\n');
            var lastClose = buffer.indexOf('\n```', lastOpen + 16);
            if (lastClose === -1) buffer += '\n```\n';
          }

          if (evt.type === 'content')   { _clearToolStatuses(); buffer += evt.content; tokenCount++; if (tokenCount === 1) dbg('first token received', 'ok'); if (tokenCount % 25 === 0) dbg('stream chunk: tokens=' + tokenCount + ' buffer=' + buffer.length + 'ch elapsed=' + (Date.now() - _streamStartedAt) + 'ms lastChunk=' + (evt.content || '').length + 'ch', 'info'); if (typeof processDesignStreamChunk === 'function') processDesignStreamChunk(evt.content, buffer); scheduleRender(); }
          if (evt.type === 'error')     { _clearToolStatuses(); dbg('SSE error: ' + evt.error, 'err'); buffer += '\n\nError: ' + evt.error; scheduleRender(); }
          if (evt.type === 'reasoning') {
            if (!_reasoning) _reasoning = { startedAt: Date.now() };
            _updateReasoningPanel(null, false);
            scrollBottom();
          }
          if (evt.type === 'tool_call') {
            dbg('tool_call: ' + evt.name, 'cmd');
            _lastToolOutputAccum = ''; // reset per tool invocation
            // Ephemeral tool status — shown as shimmer stack, not baked into buffer
            var toolLabel = evt.label || evt.name || 'tool';
            _addToolStatus(toolLabel);
            if (isActive()) scrollBottom();
          }
          if (evt.type === 'tool_output') {
            // Live shell output — append to a collapsible output block
            // Also accumulate for use in the waiting-for-input context
            _lastToolOutputAccum = ((_lastToolOutputAccum || '') + evt.output).slice(-1000);
            if (!buffer.includes('```shell-output\n')) {
              buffer += '```shell-output\n';
            }
            // Insert before the closing ``` if present, otherwise just append
            var closingIdx = buffer.lastIndexOf('\n```\n');
            if (closingIdx > buffer.lastIndexOf('```shell-output\n')) {
              buffer = buffer.slice(0, closingIdx) + evt.output + buffer.slice(closingIdx);
            } else {
              buffer += evt.output;
            }
            scheduleRender();
          }
          if (evt.type === 'tool_waiting_for_input') {
            dbg('tool waiting for input: killId=' + evt.killId + ' hint=' + evt.hint, 'warn');
            if (typeof _showShellInput === 'function') {
              // Create a unique exec ID and show the input widget below the current AI message
              var stdinId = 'agent-stdin-' + Date.now();
              var resultEl = bodyEl.querySelector('.shell-output-block') || bodyEl;
              // Use server-side context if available, otherwise fall back to locally accumulated tool output
              var inputContext = (evt.context && evt.context.trim()) ? evt.context : (_lastToolOutputAccum || '');
              _showShellInput(stdinId, evt.killId, evt.hint || 'Waiting for input…', resultEl, inputContext);
            }
          }
          if (evt.type === 'done') {
            _clearToolStatuses();
            dbg('done: finish_reason=' + evt.finish_reason + ' usage=' + JSON.stringify(evt.usage), evt.finish_reason ? 'ok' : 'warn');
            if (evt.usage) _ctxUsage = evt.usage;
            // Finalize reasoning panel (collapse, freeze duration)
            if (evt.reasoning || _reasoning) {
              var doneReasoning = evt.reasoning || (_reasoning ? { durationSeconds: Math.round((Date.now() - _reasoning.startedAt) / 1000) } : null);
              if (doneReasoning) {
                _reasoning = doneReasoning;
                _updateReasoningPanel(doneReasoning.durationSeconds, true);
              }
            }
          }
        } catch (e) {}
      }
    }
  } catch (err) {
    dbg('stream error: ' + err.message, 'err');
    if (err.name !== 'AbortError') buffer += (buffer ? '\n\n' : '') + err.message;
  } finally {
    _clearToolStatuses();
    if (renderTimer) { clearTimeout(renderTimer); renderTimer = null; }
    dbg('■ stream done — buffer=' + buffer.length + 'ch tokens=' + tokenCount, buffer.length ? 'ok' : 'warn');
    dbg('stream timing: elapsed=' + (Date.now() - _streamStartedAt) + 'ms avgCharsPerToken=' + (tokenCount ? Math.round(buffer.length / tokenCount) : 0), 'info');
    dbg('  raw: ' + JSON.stringify(buffer), 'info');

    // Update context meter (granular breakdown)
    var _meterFn = typeof updateContextMeterGranular === 'function' ? updateContextMeterGranular : updateContextMeter;
    _meterFn({ sysChars: _ctxSysChars, msgChars: _ctxMsgChars, usage: _ctxUsage, outputTokens: tokenCount, model: state.model });

    // Always save the AI message regardless of which conv is active
    var aiMsg = { role: 'assistant', content: buffer };
    if (_currentAgentInfo) aiMsg.agentInfo = _currentAgentInfo;
    if (_reasoning) aiMsg.reasoning = { durationSeconds: _reasoning.durationSeconds != null ? _reasoning.durationSeconds : (_reasoning.startedAt ? Math.round((Date.now() - _reasoning.startedAt) / 1000) : null) };
    conv.messages.push(aiMsg);
    conv._streaming = false;
    conv._abortController = null;
    saveConversations();
    renderConvList(); // remove streaming spinner from sidebar
    if (typeof maybeUpdateConversationTitle === 'function') maybeUpdateConversationTitle(conv);

    // Background summarization — trigger when conversation is getting long
    // so older messages can be dropped without losing task context
    maybeCompressConversation(conv);

    if (isActive()) {
      _ensureLiveMessageAttached();
      delete msgEl.dataset.streamingLive;
      bodyEl.classList.remove('streaming-cursor');
      if (!_reasoning) _updateReasoningPanel(null, true);
      // Sanitize write-file blocks BEFORE rendering — extracts file content into
      // _wfContentStore so the markdown renderer never sees large file bytes.
      var renderBuffer = sanitizeWriteFileBlocks(buffer);

      // Orchestrator delegation — check for [DELEGATE:...] blocks
      var delegations = typeof parseDelegations === 'function' ? parseDelegations(buffer) : [];
      if (delegations.length > 0 && typeof isOrchestratorActive === 'function' && isOrchestratorActive()) {
        // Re-assert busy state during delegation (stream just ended and cleared _streaming)
        conv._streaming = true;
        if (isActive()) setBusy(true);

        // Strip delegation blocks from displayed content
        var cleanBuffer = stripDelegationBlocks(renderBuffer || buffer);
        bodyEl.innerHTML = cleanBuffer.trim() ? renderMarkdown(cleanBuffer) : '<span style="color:var(--fau-text-muted)">Delegating tasks…</span>';
        scrollBottom();

        // Extract last user message text for synthesis context
        var lastUserText = '';
        for (var _u = conv.messages.length - 1; _u >= 0; _u--) {
          if (conv.messages[_u].role === 'user') {
            lastUserText = typeof conv.messages[_u].content === 'string' ? conv.messages[_u].content : '';
            break;
          }
        }

        // Execute delegations with iterative pipeline support
        // After each synthesis round, check if the orchestrator emitted more [DELEGATE:] blocks
        try {
          var MAX_ROUNDS = 10;
          var round = 0;
          var currentDelegations = delegations;
          var allResults = [];
          var persistedMode = null; // remember mode choice across rounds
          while (currentDelegations.length > 0 && round < MAX_ROUNDS) {
            round++;
            conv._delegRound = round;
            dbg('Delegation round ' + round + ': ' + currentDelegations.length + ' agent(s)', 'cmd');
            var delResult = await executeDelegations(currentDelegations, conv, lastUserText, persistedMode);
            if (!persistedMode && delResult.chosenMode) persistedMode = delResult.chosenMode;
            if (delResult.results) allResults = allResults.concat(delResult.results);

            if (delResult.synthesis) {
              // Check if synthesis contains more delegation blocks (pipeline continuation)
              var nextDelegations = typeof parseDelegations === 'function' ? parseDelegations(delResult.synthesis) : [];
              if (nextDelegations.length > 0) {
                // More phases — show the synthesis as an intermediate message and continue
                var interClean = typeof stripDelegationBlocks === 'function' ? stripDelegationBlocks(delResult.synthesis) : delResult.synthesis;
                if (interClean.trim()) {
                  var interMsg = { role: 'assistant', content: interClean };
                  if (_currentAgentInfo) interMsg.agentInfo = _currentAgentInfo;
                  interMsg.isDelegationSynthesis = true;
                  conv.messages.push(interMsg);
                  saveConversations();
                  var interEl = createMessageEl('ai', _currentAgentInfo);
                  var interBody = interEl.querySelector('.msg-body');
                  interBody.innerHTML = renderMarkdown(interClean);
                  interEl.classList.add('synthesis-message');
                  getConvInner(convId).appendChild(interEl);
                  forceScrollBottom();
                }
                currentDelegations = nextDelegations;
                continue;
              }
              // No more delegations — this is the final synthesis
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
              forceScrollBottom();
            }
            break;
          }
          if (round >= MAX_ROUNDS) dbg('Delegation hit max rounds (' + MAX_ROUNDS + ')', 'warn');
          delete conv._delegRound;
        } catch (delErr) {
          dbg('Delegation error: ' + delErr.message, 'err');
          delete conv._delegRound;
        }
        conv._streaming = false;
        window._delegStop = null;
        setBusy(false);
        renderConvList();
      } else {
        bodyEl.innerHTML = renderBuffer ? renderMarkdown(renderBuffer) : '<span style="color:var(--fau-text-muted)">No response.</span>';
        if (typeof initMermaidInContainer === 'function') initMermaidInContainer(bodyEl);

        var shellBlocks = (msgEl.querySelectorAll('code.language-shell-exec')||[]).length;
        dbg('  code blocks found: shell-exec=' + shellBlocks, 'info');

        extractAndRenderFigmaExec(buffer, msgEl);
        var suppressShellAutoRun = !!(conv._suppressShellAutoRunOnce || conv._writeRepairMode);
        extractAndRenderShellExec(buffer, msgEl, suppressShellAutoRun, convId);
        extractAndRenderBrowserActions(buffer, msgEl, false, convId);
        if (typeof extractAndRenderBrowserExtActions === 'function') extractAndRenderBrowserExtActions(buffer, msgEl, false, convId);
        extractAndRenderWriteFile(msgEl, false, convId);
        extractAndRenderSaveInstruction(buffer, msgEl, false);
        extractArtifactsFromBuffer(buffer, msgEl);
        if (typeof postProcessDesignMessage === 'function') postProcessDesignMessage(bodyEl);
        if (typeof extractAndRenderCreateAgent === 'function') extractAndRenderCreateAgent(buffer, msgEl);
        if (typeof extractAndRenderPatchAgent === 'function') extractAndRenderPatchAgent(buffer, msgEl);
        if (typeof extractAndRenderUninstallAgent === 'function') extractAndRenderUninstallAgent(buffer, msgEl);
        if (typeof extractAndRenderTaskCreate === 'function') extractAndRenderTaskCreate(buffer, msgEl);
        if (typeof extractAndRenderGenUI === 'function') extractAndRenderGenUI(buffer, msgEl, false);
        (typeof wrapInActivityDetails === 'function' ? wrapInActivityDetails : wrapInChainOfThought)(msgEl);
        delete conv._suppressShellAutoRunOnce;
        if (typeof compactProcessClusters === 'function') compactProcessClusters(msgEl);
        if (typeof compactLongAssistantMessage === 'function') compactLongAssistantMessage(msgEl, buffer);
        extractAndRenderSuggestions(buffer, msgEl, true);
        if (state._lastMsgWasDesktopTask) {
          injectOrganizerCard(msgEl, buffer);
          state._lastMsgWasDesktopTask = false;
        }
        scrollBottom();
        setBusy(false);

        // Voice conversational reply: speak the AI response back
        if (window._voiceAwaitingReply && buffer && typeof _speak === 'function') {
          window._voiceAwaitingReply = false;
          // Strip markdown formatting, code blocks, and excessive detail for speech
          var spokenText = buffer
            .replace(/```[\s\S]*?```/g, '')        // remove code blocks
            .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1') // links → text
            .replace(/[#*_~`>|]/g, '')             // strip markdown chars
            .replace(/\n{2,}/g, '. ')              // paragraphs → pause
            .replace(/\n/g, ' ')                   // newlines → space
            .replace(/\s{2,}/g, ' ')               // collapse whitespace
            .trim();
          // Limit to ~500 chars for speech (avoid long monologues)
          if (spokenText.length > 500) spokenText = spokenText.slice(0, 497) + '…';
          if (spokenText) {
            _speak(spokenText);
            // Re-enter command mode after TTS finishes (persistent conversation)
            if (typeof _conversationMode !== 'undefined' && _conversationMode && typeof _reenterCommandMode === 'function') {
              // Wait for TTS to finish, then re-enter
              var _checkTTS = setInterval(function() {
                if (!window.speechSynthesis.speaking) {
                  clearInterval(_checkTTS);
                  setTimeout(_reenterCommandMode, 600);
                }
              }, 300);
            }
          }
        }
      }
    } else {
      // Background conversation — render into its (hidden) DOM and auto-run shell commands unless this turn explicitly suppresses them.
      dbg('■ background stream done for conv ' + convId, 'info');
      bodyEl.classList.remove('streaming-cursor');
      var renderBuffer = sanitizeWriteFileBlocks(buffer);
      bodyEl.innerHTML = renderBuffer ? renderMarkdown(renderBuffer) : '';
      if (typeof initMermaidInContainer === 'function') initMermaidInContainer(bodyEl);
      extractAndRenderFigmaExec(buffer, msgEl);
      var suppressShellAutoRunFinal = !!(conv._suppressShellAutoRunOnce || conv._writeRepairMode);
      extractAndRenderShellExec(buffer, msgEl, suppressShellAutoRunFinal, convId);  // auto-run continues in background unless explicitly suppressed
      extractAndRenderBrowserActions(buffer, msgEl, false, convId);
      if (typeof extractAndRenderBrowserExtActions === 'function') extractAndRenderBrowserExtActions(buffer, msgEl, false, convId);
      extractAndRenderWriteFile(msgEl, false, convId);
      extractAndRenderSaveInstruction(buffer, msgEl, false);
      extractArtifactsFromBuffer(buffer, msgEl, true);
      if (typeof postProcessDesignMessage === 'function') postProcessDesignMessage(bodyEl);
      if (typeof extractAndRenderCreateAgent === 'function') extractAndRenderCreateAgent(buffer, msgEl);
      if (typeof extractAndRenderPatchAgent === 'function') extractAndRenderPatchAgent(buffer, msgEl);
      if (typeof extractAndRenderUninstallAgent === 'function') extractAndRenderUninstallAgent(buffer, msgEl);
      if (typeof extractAndRenderTaskCreate === 'function') extractAndRenderTaskCreate(buffer, msgEl);
      if (typeof extractAndRenderGenUI === 'function') extractAndRenderGenUI(buffer, msgEl, true);
      (typeof wrapInActivityDetails === 'function' ? wrapInActivityDetails : wrapInChainOfThought)(msgEl);
      if (typeof compactProcessClusters === 'function') compactProcessClusters(msgEl);
      if (typeof compactLongAssistantMessage === 'function') compactLongAssistantMessage(msgEl, buffer);
      delete conv._suppressShellAutoRunOnce;
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

    // Archive old messages (strip image base64 to keep storage lean) instead of dropping
    var archiveBatch = toSummarize.map(function(m) {
      // Remove raw image bytes; keep text so the history is readable
      if (Array.isArray(m.content)) {
        var textOnly = m.content.filter(function(c) { return c.type === 'text'; }).map(function(c) { return c.text; }).join('\n');
        return Object.assign({}, m, { content: textOnly || '[image]', images: undefined });
      }
      if (m.images && m.images.length) {
        return Object.assign({}, m, { images: undefined });
      }
      return m;
    });
    conv.archivedMessages = (conv.archivedMessages || []).concat(archiveBatch);

    // Store summary and trim active history (only recent messages sent to AI)
    conv.contextSummary = data.summary;
    conv.messages = conv.messages.slice(-SUMMARIZE_KEEP_RECENT);
    saveConversations();
    dbg('context compressed — summary: ' + data.summary.length + ' chars, kept last ' + SUMMARIZE_KEEP_RECENT + ' messages, archived ' + archiveBatch.length + ' to history', 'ok');

    // Show an indicator in the active conversation
    if (state.currentId === conv.id) {
      var indicator = document.createElement('div');
      indicator.className = 'msg system-msg conv-archive-divider';
      indicator.innerHTML = renderContextArchiveDivider(conv);
      getConvInner(conv.id).appendChild(indicator);
      if (typeof reconcileBusyState === 'function') reconcileBusyState();
    }
  } catch (e) {
    dbg('summarize error: ' + e.message, 'warn');
  } finally {
    conv._summarizing = false;
  }
}

function renderContextArchiveDivider(conv) {
  var summary = conv && conv.contextSummary ? String(conv.contextSummary) : '';
  return '<div class="msg-body conv-archive-divider-inner">' +
    '<div class="conv-archive-head">' +
      '<i class="ti ti-history"></i>' +
      '<span>Older messages archived — full history preserved above, AI context starts here</span>' +
    '</div>' +
    (summary ? '<div class="conv-archive-summary">' + escHtml(summary) + '</div>' : '') +
  '</div>';
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
  if (!conv) return;
  var stoppedShell = 0;
  if (typeof stopActiveShellWorkForCurrentConversation === 'function') {
    stoppedShell = stopActiveShellWorkForCurrentConversation() || 0;
  }
  conv._cancelled = true;
  if (conv._abortController) conv._abortController.abort();
  // Also stop any active delegation
  if (typeof window._delegStop === 'function') window._delegStop();
  conv._streaming = false;
  conv._abortController = null;
  setBusy(false);
  renderConvList();
  showToast(stoppedShell ? 'Shell verification stopped' : 'Generation stopped');
}
