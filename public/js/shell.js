// ── Shell-exec block execution ────────────────────────────────────────────

function _parseShellExecResult(widget) {
  if (!widget || !widget.dataset.result) return null;
  try { return JSON.parse(widget.dataset.result); } catch (_) { return null; }
}

function _ensureShellVerificationBanner(msgEl) {
  if (!msgEl) return null;
  var body = msgEl.querySelector('.msg-body');
  if (!body) return null;
  var banner = body.querySelector('.msg-shell-verification');
  if (banner) return banner;
  banner = document.createElement('div');
  banner.className = 'msg-shell-verification pending';
  body.insertBefore(banner, body.firstChild || null);
  return banner;
}

function _updateShellNarrativeVisibility(msgEl, shouldHide) {
  if (!msgEl) return;
  var body = msgEl.querySelector('.msg-body');
  if (!body) return;
  Array.from(body.children).forEach(function(child) {
    if (child.classList.contains('msg-shell-verification')) return;
    if (child.classList.contains('shell-exec-block')) return;
    if (child.classList.contains('system-inline-card')) return;
    if (shouldHide) child.classList.add('shell-narrative-hidden');
    else child.classList.remove('shell-narrative-hidden');
  });
}

function updateMessageShellVerification(msgEl) {
  if (!msgEl) return;
  var widgets = Array.from(msgEl.querySelectorAll('.shell-exec-block'));
  var banner = msgEl.querySelector('.msg-shell-verification');
  if (!widgets.length) {
    if (banner) banner.remove();
    _updateShellNarrativeVisibility(msgEl, false);
    return;
  }
  banner = _ensureShellVerificationBanner(msgEl);
  if (!banner) return;

  var completed = 0;
  var running = 0;
  var empty = 0;
  widgets.forEach(function(widget) {
    var resultEl = widget.querySelector('.shell-exec-result');
    if (resultEl && resultEl.classList.contains('running')) running += 1;
    var result = _parseShellExecResult(widget);
    if (!result) return;
    completed += 1;
    if (!(result.stdout && result.stdout.trim()) && !(result.stderr && result.stderr.trim()) && !result.error && !result._screenshot) {
      empty += 1;
    }
  });

  if (completed === 0) {
    banner.className = 'msg-shell-verification pending';
    banner.innerHTML = '<i class="ti ti-hourglass"></i><span>Shell commands pending verification. Ignore assistant claims below until command results appear.</span>';
    _updateShellNarrativeVisibility(msgEl, true);
    return;
  }

  if (running > 0 || completed < widgets.length) {
    banner.className = 'msg-shell-verification pending';
    banner.innerHTML = '<i class="ti ti-loader"></i><span>Shell verification in progress — ' + completed + ' of ' + widgets.length + ' command' + (widgets.length === 1 ? '' : 's') + ' produced results.</span>';
    _updateShellNarrativeVisibility(msgEl, true);
    return;
  }

  if (empty > 0) {
    banner.className = 'msg-shell-verification warn';
    banner.innerHTML = '<i class="ti ti-alert-triangle"></i><span>Shell results are incomplete. ' + empty + ' command' + (empty === 1 ? '' : 's') + ' produced no output, so the assistant text above remains unverified.</span>';
    _updateShellNarrativeVisibility(msgEl, true);
    return;
  }

  banner.className = 'msg-shell-verification done';
  banner.innerHTML = '<i class="ti ti-check"></i><span>Shell results received. Review command output below before trusting any success claims in the assistant message.</span>';
  _updateShellNarrativeVisibility(msgEl, false);
}

function _resolveShellFilePath(filePath, cwd) {
  if (!filePath) return '';
  var raw = String(filePath).trim().replace(/^['"]|['"]$/g, '');
  if (!raw) return '';
  if (raw.startsWith('~/')) return raw;
  if (raw[0] === '/') return raw;
  if (/^[A-Za-z]:[\\/]/.test(raw)) return raw;
  if (!cwd) return raw;
  var base = cwd.replace(/\/+$|\/+$/g, '');
  return base + '/' + raw.replace(/^\.\//, '');
}

function _extractCreatedFileCandidates(command, cwd) {
  var paths = [];
  function pushMatch(path) {
    var raw = String(path || '').trim().replace(/^['"]|['"]$/g, '');
    if (!raw) return;
    // Ignore option-like tokens accidentally captured from commands such as `find ... -o -name`.
    if (/^-[A-Za-z]/.test(raw)) return;
    var resolved = _resolveShellFilePath(path, cwd);
    if (!resolved) return;
    if (/[|;&]$/.test(resolved)) resolved = resolved.slice(0, -1);
    if (!paths.includes(resolved)) paths.push(resolved);
  }

  String(command || '').replace(/(?:^|\s)(?:>|1>|>>)\s*(?:"([^"]+)"|'([^']+)'|([^\s|;&<]+))/g, function(_, a, b, c) {
    pushMatch(a || b || c);
    return _;
  });
  String(command || '').replace(/(?:^|\s)tee(?:\s+-a)?\s+(?:"([^"]+)"|'([^']+)'|([^\s|;&]+))/g, function(_, a, b, c) {
    pushMatch(a || b || c);
    return _;
  });
  String(command || '').replace(/(?:^|\s)(?:-o\s+|--output(?:=|\s+))(?:"([^"]+)"|'([^']+)'|([^\s|;&]+))/g, function(_, a, b, c) {
    pushMatch(a || b || c);
    return _;
  });

  var cpMv = String(command || '').match(/^(?:cp|mv)\s+(?:-[^\s]+\s+)*(?:"[^"]+"|'[^']+'|[^\s]+)\s+(?:"([^"]+)"|'([^']+)'|([^\s|;&]+))\s*$/m);
  if (cpMv) pushMatch(cpMv[1] || cpMv[2] || cpMv[3]);

  return paths;
}

async function _createArtifactForFilePath(filePath) {
  if (!filePath) return null;
  var existing = state.artifacts.find(function(a) { return a.path === filePath; });
  if (existing) return existing.id;

  var existsRes;
  try {
    existsRes = await fetch('/api/preview-file?path=' + encodeURIComponent(filePath), { method: 'HEAD' });
  } catch (_) {
    return null;
  }
  if (!existsRes || !existsRes.ok) return null;

  var ext = (filePath.split('.').pop() || '').toLowerCase();
  var title = filePath.split('/').pop() || filePath;
  if (['png','jpg','jpeg','gif','webp'].includes(ext)) {
    return addArtifact({ type: 'image', title: title, path: filePath });
  }
  if (ext === 'pdf') {
    return addArtifact({ type: 'pdf', title: title, path: filePath });
  }

  var readRes;
  try {
    readRes = await fetch('/api/read-file', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: filePath })
    });
  } catch (_) {
    return null;
  }
  if (!readRes.ok) return null;
  var readData;
  try { readData = await readRes.json(); } catch (_) { return null; }
  if (!readData || typeof readData.content !== 'string') return null;

  var type = ['html','htm'].includes(ext) ? 'html'
           : ext === 'svg' ? 'svg'
           : ['md','markdown'].includes(ext) ? 'markdown'
           : ext === 'json' ? 'json'
           : ext === 'csv' ? 'csv'
           : 'text';
  return addArtifact({ type: type, title: title, path: filePath, content: readData.content });
}

async function maybeAttachCreatedFileArtifact(command, result, containerEl) {
  if (!result || result.exitCode !== 0) return [];
  var candidates = _extractCreatedFileCandidates(command, result.cwd || '');
  var verified = [];
  if (!candidates.length) return verified;
  for (var i = 0; i < candidates.length; i++) {
    try {
      var artId = await _createArtifactForFilePath(candidates[i]);
      if (artId) {
        verified.push(candidates[i]);
        if (containerEl) injectArtifactCard(artId, containerEl);
      }
    } catch (_) {}
  }
  return verified;
}

function _firstCommandToken(command) {
  var lines = String(command || '').split('\n').map(function(line) { return line.trim(); }).filter(function(line) {
    return line && !line.startsWith('#');
  });
  if (!lines.length) return '';
  var line = lines[0].replace(/^sudo\s+/, '');
  var match = line.match(/^([^\s|;&()]+)/);
  return match ? match[1] : '';
}

function _escapeDoubleQuoted(text) {
  return String(text || '').replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

function _buildTroubleshootCommand(command, result) {
  var pieces = [];
  pieces.push('echo "[troubleshoot] command produced no stdout/stderr; collecting diagnostics"');
  pieces.push('pwd');

  var token = _firstCommandToken(command);
  if (token) {
    pieces.push('echo "[command] ' + _escapeDoubleQuoted(token) + '"');
    pieces.push('command -v ' + JSON.stringify(token) + ' || true');
  }

  var candidates = _extractCreatedFileCandidates(command, result.cwd || '');
  if (candidates.length) {
    candidates.forEach(function(filePath) {
      pieces.push('if [ -e ' + JSON.stringify(filePath) + ' ]; then echo "[exists] ' + _escapeDoubleQuoted(filePath) + '"; ls -ld ' + JSON.stringify(filePath) + '; else echo "[missing] ' + _escapeDoubleQuoted(filePath) + '"; fi');
    });
  } else {
    pieces.push('echo "[note] no explicit output path inferred from command"');
  }

  return pieces.join(' ; ');
}

async function _runTroubleshootForEmptyResult(widget, command, result) {
  if (!widget || result._troubleshoot) return result;
  var diagCommand = _buildTroubleshootCommand(command, result);
  var bodyObj = { command: diagCommand };
  if (result.cwd) bodyObj.cwd = result.cwd;
  try {
    var resp = await fetch('/api/shell-exec', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(bodyObj)
    });
    var diag = resp.ok ? await resp.json() : { ok: false, exitCode: 1, stdout: '', stderr: await resp.text() };
    result._troubleshoot = {
      command: diagCommand,
      stdout: diag.stdout || '',
      stderr: diag.stderr || '',
      exitCode: (diag.exitCode != null) ? diag.exitCode : (diag.ok ? 0 : 1)
    };
    widget.dataset.result = JSON.stringify(result);
  } catch (e) {
    result._troubleshoot = {
      command: diagCommand,
      stdout: '',
      stderr: e.message || 'Troubleshoot failed',
      exitCode: 1
    };
    widget.dataset.result = JSON.stringify(result);
  }
  return result;
}

function extractAndRenderShellExec(html, messageEl, noAutoRun, convId) {
  var container = messageEl.querySelector('.prose') || messageEl;
  var codeBlocks = container.querySelectorAll('code.language-shell-exec, code.language-shell_exec');
  dbg('extractAndRenderShellExec: found ' + codeBlocks.length + ' block(s)', 'info');
  if (codeBlocks.length) updateMessageShellVerification(messageEl);
  var _autoRunIdx = 0; // only the first block in a response auto-runs; rest wait for user
  codeBlocks.forEach(function(code) {
    var pre = code.parentElement;
    var rawCode = code.textContent.trim();
    if (!rawCode) { dbg('  ↳ skipped empty block', 'warn'); pre.remove(); return; }

    var execId  = 'se-' + Date.now() + '-' + Math.random().toString(36).slice(2);
    var targetConv = getConv(convId || state.currentId);
    var depth = targetConv ? (targetConv._autoFeedDepth || 0) : 0;
    var DEPTH_LIMIT = 10;
    // Only the first block in this response may auto-run; subsequent blocks must be manually triggered.
    var autoRun = !noAutoRun && state.autoRunShell && depth < DEPTH_LIMIT && _autoRunIdx === 0;
    var depthLimited = !noAutoRun && state.autoRunShell && depth >= DEPTH_LIMIT;
    var pendingSerial = !noAutoRun && state.autoRunShell && depth < DEPTH_LIMIT && _autoRunIdx > 0;
    if (autoRun || pendingSerial) _autoRunIdx++;
    dbg('  ↳ block: ' + rawCode.slice(0,60) + ' autoRun=' + autoRun + ' depth=' + depth, 'cmd');

    var widget = document.createElement('div');
    widget.className = 'shell-exec-block';
    widget.dataset.code = rawCode;
    widget.dataset.execId = execId;
    widget.dataset.convId = convId || state.currentId || ''; // route auto-feed to correct conv
    widget.innerHTML =
      '<div class="shell-exec-header">' +
        '<i class="ti ti-terminal-2"></i>' +
        '<span>Shell Command</span>' +
        (autoRun ? '<span class="shell-exec-autorun-badge">auto-run</span>' : '') +
        (pendingSerial ? '<span class="shell-exec-autorun-badge" style="background:var(--fau-surface2);color:var(--fau-text-dim)">pending — click Run</span>' : '') +
        (depthLimited ? '<span class="shell-exec-autorun-badge" style="background:var(--warn,#f59e0b);color:#000">paused — click Run</span>' : '') +
        '<div class="shell-exec-btns">' +
          '<button class="shell-exec-run" id="' + execId + '-run" ' +
            'onclick="runShellExec(\'' + execId + '\')"><i class="ti ti-player-play"></i> Run</button>' +
          '<button class="shell-exec-feed" id="' + execId + '-feed" ' +
            'onclick="feedShellResultToAI(\'' + execId + '\')"><i class="ti ti-arrow-right"></i> Feed to AI</button>' +
        '</div>' +
      '</div>' +
      '<div class="shell-exec-code">' + escHtml(rawCode) + '</div>' +
      '<div class="shell-exec-result" id="' + execId + '-result"' + (depthLimited || pendingSerial ? '' : ' style="display:none"') + '>' +
        (depthLimited ? '<span class="se-meta">Auto-run paused after ' + DEPTH_LIMIT + ' steps — click Run to continue.</span>' : '') +
        (pendingSerial ? '<span class="se-meta">Waiting for previous command — click Run to execute now.</span>' : '') +
      '</div>';
    pre.parentNode.replaceChild(widget, pre);
    updateMessageShellVerification(messageEl);

    // Auto-run after a short delay if enabled
    if (autoRun) {
      setTimeout(function() { runShellExec(execId, { autoFeed: true }); }, 350);
    }
    // If depth limit hit, notify AI once so it stops looping
    if (depthLimited && targetConv && !targetConv._depthLimitNotified) {
      targetConv._depthLimitNotified = true;
      setTimeout(function() {
        sendDirectMessage(
          'Auto-run has been paused after ' + DEPTH_LIMIT + ' consecutive steps as a safety measure. ' +
          'The command `' + rawCode.slice(0, 120) + '` was NOT run automatically. ' +
          'Please summarise what has been completed so far and ask the user if they want to continue.',
          { fromAutoFeed: true, isAutoFeed: true, targetConvId: convId || state.currentId }
        );
      }, 400);
    }
  });
}

var _shellAbortControllers = {};
var _shellKillIds = {};

function syncShellRunningPills() {
  var container = document.getElementById('shell-running-pills');
  if (!container) return;
  var activeConvId = (typeof state !== 'undefined' && state.currentId) ? state.currentId : '';
  var visibleCount = 0;
  Array.from(container.children).forEach(function(pill) {
    var pillConvId = pill.dataset.convId || '';
    var show = !pillConvId || pillConvId === activeConvId;
    pill.style.display = show ? '' : 'none';
    if (show) visibleCount += 1;
  });
  container.style.display = visibleCount ? 'flex' : 'none';
}

function clearShellRunningPillsForConversation(convId) {
  if (!convId) return;
  var container = document.getElementById('shell-running-pills');
  if (!container) return;
  Array.from(container.children).forEach(function(pill) {
    if ((pill.dataset.convId || '') === convId) pill.remove();
  });
  syncShellRunningPills();
}

function showShellRunningPill(execId, code, convId) {
  var container = document.getElementById('shell-running-pills');
  if (!container) return;
  var short = code.length > 46 ? code.slice(0, 46) + '…' : code;
  var pill = document.createElement('span');
  pill.className = 'shell-running-pill';
  pill.id = 'pill-' + execId;
  pill.dataset.convId = convId || (typeof state !== 'undefined' ? (state.currentId || '') : '');
  pill.innerHTML =
    '<i class="ti ti-loader spin"></i>' +
    '<span class="pill-label">' + escHtml(short) + '</span>' +
    '<button class="pill-stop" title="Stop command" onclick="killShellExec(\'' + execId + '\')">' +
      '<i class="ti ti-player-stop-filled"></i>' +
    '</button>';
  container.appendChild(pill);
  syncShellRunningPills();
}
function hideShellRunningPill(execId) {
  var pill = document.getElementById('pill-' + execId);
  if (pill) pill.remove();
  syncShellRunningPills();
}

function killShellExec(execId) {
  var killId = _shellKillIds[execId];
  // Ask server to kill the process
  if (killId) {
    fetch('/api/shell-kill', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ killId: killId })
    }).catch(function() {});
  }
  // Abort the pending fetch so runShellExec's catch fires
  var ctrl = _shellAbortControllers[execId];
  if (ctrl) ctrl.abort();
}

async function runShellExec(execId, opts) {
  opts = opts || {};
  var widget   = document.querySelector('[data-exec-id="' + execId + '"]');
  if (!widget) { dbg('runShellExec: widget not found ' + execId, 'err'); return; }
  var code     = widget.dataset.code;
  var convId2  = widget.dataset.convId || state.currentId;
  var runBtn   = document.getElementById(execId + '-run');
  var feedBtn  = document.getElementById(execId + '-feed');
  var resultEl = document.getElementById(execId + '-result');

  dbg('▶ runShellExec: ' + code.slice(0,80), 'cmd');

  // ── Agent sandbox check ──────────────────────────────────────────────
  if (typeof isAgentActive === 'function' && isAgentActive()) {
    var perm = checkAgentPermission('shell');
    if (!perm.allowed) {
      showSandboxBlock(perm.reason);
      resultEl.style.display = 'block';
      resultEl.className = 'shell-exec-result';
      resultEl.innerHTML = '<span class="se-err"><i class="ti ti-shield-check"></i> ' + escHtml(perm.reason) + '</span>';
      widget.dataset.result = JSON.stringify({ ok: false, exitCode: 126, stdout: '', stderr: '', error: perm.reason, command: code });
      updateMessageShellVerification(widget.closest('.msg'));
      runBtn.disabled = false;
      runBtn.innerHTML = '<i class="ti ti-player-play"></i> Run';
      return;
    }
  }

  runBtn.disabled = true;
  runBtn.innerHTML = '<i class="ti ti-loader"></i>';
  resultEl.style.display = 'block';
  resultEl.className = 'shell-exec-result running';

  // Live elapsed timer so user can see progress
  var startTime = Date.now();
  resultEl.textContent = 'Running… 0s';
  var timerInterval = setInterval(function() {
    var secs = Math.floor((Date.now() - startTime) / 1000);
    resultEl.textContent = 'Running… ' + secs + 's';
  }, 1000);

  // AbortController so the pill's stop button can cancel the fetch
  var abortCtrl = new AbortController();
  var killId = 'k-' + Date.now() + '-' + Math.random().toString(36).slice(2);
  _shellAbortControllers[execId] = abortCtrl;
  _shellKillIds[execId] = killId;

  // Show a status pill in the input bar (with stop button)
  showShellRunningPill(execId, code, convId2);

  try {
    // Route through sandbox endpoint when an agent is active
    var endpoint = '/api/shell-exec';
    // Resolve working directory: prefer conversation CWD, then active project source root
    var shellCwd = _convCwd[convId2] || '';
    if (!shellCwd && state.activeProjectId) {
      var activeProj = typeof _activeProject === 'function' ? _activeProject() : null;
      if (activeProj && activeProj.sources) {
        var firstLocal = activeProj.sources.find(function(s) { return s.type === 'local' && s.path; });
        if (firstLocal) shellCwd = firstLocal.path;
      }
    }
    var bodyObj = { command: code, killId: killId, stream: true };
    if (shellCwd) bodyObj.cwd = shellCwd;
    if (typeof isAgentActive === 'function' && isAgentActive()) {
      var sb = getSandboxedEndpoint('/api/shell-exec');
      endpoint = sb.url;
      Object.assign(bodyObj, sb.extra);
    }
    var r = await fetch(endpoint, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(bodyObj),
      signal: abortCtrl.signal
    });

    // ── Streaming mode: parse SSE events ──
    var stdoutBuf = '';
    var stderrBuf = '';
    var exitCode = 0;
    var errMsg = '';

    var reader = r.body.getReader();
    var decoder = new TextDecoder();
    var sseBuf = '';

    while (true) {
      var chunk = await reader.read();
      if (chunk.done) break;
      sseBuf += decoder.decode(chunk.value, { stream: true });

      var sseLines = sseBuf.split('\n');
      sseBuf = sseLines.pop(); // keep incomplete line

      for (var si = 0; si < sseLines.length; si++) {
        var sseLine = sseLines[si];
        if (!sseLine.startsWith('data: ')) continue;
        try {
          var sseEvt = JSON.parse(sseLine.slice(6));
          if (sseEvt.type === 'stdout') {
            stdoutBuf += sseEvt.text;
            resultEl.textContent = stdoutBuf + stderrBuf;
            resultEl.scrollTop = resultEl.scrollHeight;
            _removeShellInput(execId); // clear any input prompt on new output
          } else if (sseEvt.type === 'stderr') {
            stderrBuf += sseEvt.text;
            resultEl.textContent = stdoutBuf + stderrBuf;
            resultEl.scrollTop = resultEl.scrollHeight;
            _removeShellInput(execId);
          } else if (sseEvt.type === 'waiting_for_input') {
            _showShellInput(execId, killId, sseEvt.hint, resultEl);
          } else if (sseEvt.type === 'exit') {
            exitCode = sseEvt.exitCode || 0;
            _removeShellInput(execId);
          } else if (sseEvt.type === 'error') {
            errMsg = sseEvt.error || 'Unknown error';
          }
        } catch (_) {}
      }
    }

    // Build a compat result object matching the old JSON response shape
    var d = {
      ok: exitCode === 0,
      exitCode: exitCode,
      stdout: stdoutBuf,
      stderr: stderrBuf,
      error: errMsg || undefined,
      command: code,
      cwd: bodyObj.cwd || ''
    };

    clearInterval(timerInterval);
    hideShellRunningPill(execId);
    delete _shellAbortControllers[execId];
    delete _shellKillIds[execId];

    dbg('◀ shell exit=' + exitCode + ' stdout=' + (d.stdout||'').length + 'ch stderr=' + (d.stderr||'').length + 'ch', exitCode === 0 ? 'ok' : 'warn');

    // Auto-track CWD from successful shell commands (for chat-first repo detection)
    if (exitCode === 0 && d.cwd && state.currentId) {
      _convCwd[state.currentId] = d.cwd;
    }

    resultEl.className = 'shell-exec-result';
    var parts = [];
    if (d.stdout && d.stdout.trim()) {
      parts.push('<span class="se-stdout">' + escHtml(d.stdout.trimEnd()) + '</span>');
    }
    if (d.stderr && d.stderr.trim()) {
      parts.push('<span class="se-stderr">' + escHtml(d.stderr.trimEnd()) + '</span>');
    }
    if (d.error) {
      parts.push('<span class="se-err">' + escHtml(d.error) + '</span>');
    }
    if (!d.stdout && !d.stderr && !d.error) {
      parts.push('<span class="se-meta">(no output — exit ' + exitCode + (exitCode === 0 ? ' <i class="ti ti-check"></i>' : ' <i class="ti ti-x"></i>') + ')</span>');
    } else {
      parts.push('<span class="se-meta">exit ' + exitCode + (exitCode !== 0 ? ' <i class="ti ti-x"></i>' : ' <i class="ti ti-check"></i>') + '</span>');
    }
    resultEl.innerHTML = parts.join('\n');

    // Store result for feed-to-AI
    widget.dataset.result = JSON.stringify(d);
    updateMessageShellVerification(widget.closest('.msg'));

    // Show feed button
    if (feedBtn) { feedBtn.style.display = ''; }

    // Re-enable run button
    runBtn.disabled = false;
    runBtn.innerHTML = '<i class="ti ti-refresh"></i> Re-run';

    // Detect screencapture output — try to read the image for vision
    var screenshotPath = null;
    var screenshotMatch = code.match(/screencapture[^;|&]*?\s(\/[^\s;|&'"]+\.(?:png|jpg|jpeg))/i);
    if (screenshotMatch && exitCode === 0) {
      screenshotPath = screenshotMatch[1];
      try {
        var imgRes = await fetch('/api/read-image?path=' + encodeURIComponent(screenshotPath));
        if (imgRes.ok) {
          var imgData = await imgRes.json();
          d._screenshot = { base64: imgData.base64, mime: imgData.mime, path: screenshotPath };
          dbg('  ↳ screenshot read: ' + screenshotPath + ' (' + imgData.size + ' bytes)', 'ok');
          // Show thumbnail in result
          parts.push('<img src="data:' + imgData.mime + ';base64,' + imgData.base64 + '" style="max-width:100%;max-height:200px;border-radius:4px;margin-top:6px;display:block">');
          resultEl.innerHTML = parts.join('\n');
          // Inject artifact card into the parent msg-body (not inside the shell widget)
          var artId = addArtifact({ type: 'image', title: 'Screenshot', base64: imgData.base64, mime: imgData.mime, path: screenshotPath });
          injectArtifactCard(artId, widget.closest('.msg-body') || resultEl);
        }
      } catch (e) { dbg('  ↳ screenshot read failed: ' + e.message, 'warn'); }
      widget.dataset.result = JSON.stringify(d);
    }

    // Auto-detect artifacts from shell output (file lists, JSON)
    if (exitCode === 0 && d.stdout && !screenshotPath) {
      detectShellArtifacts(code, d.stdout, widget.closest('.msg-body') || resultEl);
    }

    var verifiedPaths = await maybeAttachCreatedFileArtifact(code, d, widget.closest('.msg-body') || resultEl);
    if (verifiedPaths.length) d._verifiedPaths = verifiedPaths;
    widget.dataset.result = JSON.stringify(d);

    // Auto-feed output back to AI always when autoFeed is set —
    // the AI needs to know about empty results and failures, not just successes
    if (opts.autoFeed) {
      dbg('  ↳ auto-feeding output to AI' + (d._screenshot ? ' with screenshot' : ''), 'info');
      setTimeout(function() { feedShellResultToAI(execId, { silent: true }); }, 600);
    }
  } catch (e) {
    clearInterval(timerInterval);
    hideShellRunningPill(execId);
    delete _shellAbortControllers[execId];
    delete _shellKillIds[execId];
    if (e.name === 'AbortError' || e.message === 'signal is aborted without reason') {
      dbg('runShellExec cancelled by user', 'warn');
      resultEl.className = 'shell-exec-result';
      resultEl.innerHTML = '<span class="se-meta">⏹ Cancelled</span>';
      widget.dataset.result = JSON.stringify({ ok: false, exitCode: 130, stdout: '', stderr: '', error: 'Cancelled', command: code });
    } else {
      dbg('runShellExec error: ' + e.message, 'err');
      resultEl.className = 'shell-exec-result';
      resultEl.innerHTML = '<span class="se-err">Error: ' + escHtml(e.message) + '</span>';
      widget.dataset.result = JSON.stringify({ ok: false, exitCode: 1, stdout: '', stderr: '', error: e.message, command: code });
    }
    updateMessageShellVerification(widget.closest('.msg'));
    runBtn.disabled = false;
    runBtn.innerHTML = '<i class="ti ti-player-play"></i> Run';
  }
  scrollBottom();
}

async function feedShellResultToAI(execId, opts) {
  opts = opts || {};
  var widget = document.querySelector('[data-exec-id="' + execId + '"]');
  if (!widget) return;
  var code   = widget.dataset.code;
  var raw    = widget.dataset.result;
  if (!raw) return;
  var targetConvId = widget.dataset.convId || state.currentId;

  var d = JSON.parse(raw);
  var _hasPrimaryOutput = (d.stdout && d.stdout.trim()) || (d.stderr && d.stderr.trim()) || d._screenshot;
  if (!_hasPrimaryOutput && !d._screenshot && (!d._verifiedPaths || !d._verifiedPaths.length) && opts.silent) {
    d = await _runTroubleshootForEmptyResult(widget, code, d);
  }
  var _hasOutput = _hasPrimaryOutput || (d._verifiedPaths && d._verifiedPaths.length) || (d._troubleshoot && ((d._troubleshoot.stdout && d._troubleshoot.stdout.trim()) || (d._troubleshoot.stderr && d._troubleshoot.stderr.trim())));
  var lines = ['**Shell output:**', '```', '$ ' + code, ''];
  if (d.stdout && d.stdout.trim()) lines.push(d.stdout.trimEnd());
  if (d.stderr && d.stderr.trim()) lines.push('[stderr] ' + d.stderr.trimEnd());
  if (d._verifiedPaths && d._verifiedPaths.length) lines.push('[verified files]\n' + d._verifiedPaths.join('\n'));
  if (!_hasOutput && d._screenshot) lines.push('(no stdout — screenshot captured)');
  if (!_hasOutput && !d._screenshot && d.exitCode !== 0) lines.push('(no output — command not found or path does not exist)');
  if (!_hasOutput && !d._screenshot && d.exitCode === 0) lines.push('(no output — cannot confirm whether command had any effect)');
  lines.push('exit ' + d.exitCode);
  lines.push('```');
  if (d._troubleshoot) {
    lines.push('**Automatic troubleshoot:**');
    lines.push('```');
    lines.push('$ ' + d._troubleshoot.command);
    lines.push('');
    if (d._troubleshoot.stdout && d._troubleshoot.stdout.trim()) lines.push(d._troubleshoot.stdout.trimEnd());
    if (d._troubleshoot.stderr && d._troubleshoot.stderr.trim()) lines.push('[stderr] ' + d._troubleshoot.stderr.trimEnd());
    if (!(d._troubleshoot.stdout && d._troubleshoot.stdout.trim()) && !(d._troubleshoot.stderr && d._troubleshoot.stderr.trim())) lines.push('(troubleshoot also produced no output)');
    lines.push('exit ' + d._troubleshoot.exitCode);
    lines.push('```');
  }

  // Track consecutive empty-output results (kept for non-auto-feed reference)
  var _emptyKey = '_emptyShellCount_' + (targetConvId || 'default');
  if (!_hasOutput) {
    window[_emptyKey] = (window[_emptyKey] || 0) + 1;
  } else {
    window[_emptyKey] = 0;
  }

  // Increment chain depth on the target conversation
  if (opts.silent) {
    var targetConv = getConv(targetConvId);
    if (targetConv) {
      targetConv._autoFeedDepth = (targetConv._autoFeedDepth || 0) + 1;
      dbg('  auto-feed depth now ' + targetConv._autoFeedDepth + (d._screenshot ? ' (vision)' : ''), 'info');
    }
  }

  var fromAutoFeed = !!opts.silent;

  if (d._screenshot) {
    // Vision message — include the screenshot so the AI can SEE the screen
    var content = [
      { type: 'text', text: lines.join('\n') },
      { type: 'image_url', image_url: { url: 'data:' + d._screenshot.mime + ';base64,' + d._screenshot.base64 } }
    ];
    await sendDirectMessage(content, { fromAutoFeed: fromAutoFeed, isAutoFeed: true, targetConvId: targetConvId });
  } else {
    await sendDirectMessage(lines.join('\n'), { fromAutoFeed: fromAutoFeed, isAutoFeed: true, targetConvId: targetConvId });
  }
}

// runCodeBlock — Run button on regular bash/sh/zsh code blocks
async function runCodeBlock(btn) {
  var pre  = btn.closest('pre');
  if (!pre) return;
  var code = pre.querySelector('code');
  if (!code) return;
  var command = code.textContent.trim();

  // Reuse or create result element
  var resultEl = pre.querySelector('.code-run-result');
  if (!resultEl) {
    resultEl = document.createElement('div');
    resultEl.className = 'code-run-result';
    pre.appendChild(resultEl);
  }

  // Empty command — show inline input so user can provide the command
  if (!command) {
    resultEl.style.display = 'block';
    resultEl.innerHTML =
      '<div style="display:flex;gap:6px;align-items:center;padding:2px 0">' +
        '<input id="inline-cmd-input" style="flex:1;background:#1a1a2e;border:1px solid rgba(30,200,130,.4);' +
          'border-radius:4px;color:#c9d1d9;font:12px var(--mono);padding:4px 8px;outline:none" ' +
          'placeholder="Enter shell command…" onkeydown="if(event.key===\'Enter\')runInlineCmd(this,\'' + encodeURIComponent(pre.id || '') + '\')">' +
        '<button onclick="runInlineCmd(this.previousElementSibling)" ' +
          'style="background:#1ec882;border:none;color:#0d1117;border-radius:4px;padding:4px 10px;font-size:11px;font-weight:700;cursor:pointer">' +
          '<i class="ti ti-player-play"></i> Run</button>' +
      '</div>';
    resultEl.querySelector('input').focus();
    btn.innerHTML = '<i class="ti ti-player-play"></i> Run';
    scrollBottom();
    return;
  }

  await _executeCommand(btn, resultEl, command);
}

async function runInlineCmd(input) {
  var command  = input.value.trim();
  if (!command) return;
  var resultEl = input.closest('.code-run-result');
  var btn      = resultEl.closest('pre').querySelector('.code-run');
  resultEl.innerHTML = '<span style="color:#1ec882;font-style:italic">Running…</span>';
  await _executeCommand(btn, resultEl, command);
}

async function _executeCommand(btn, resultEl, command) {
  if (btn) { btn.classList.add('running'); btn.innerHTML = '<i class="ti ti-loader"></i>'; }
  resultEl.style.display = 'block';
  resultEl.innerHTML = '<span style="color:#1ec882;font-style:italic">Running…</span>';

  try {
    var r = await fetch('/api/shell-exec', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ command })
    });
    var d = r.ok ? await r.json() : { ok: false, exitCode: 1, stdout: '', stderr: await r.text(), command };

    var exitCode = (d.exitCode != null) ? d.exitCode : (d.ok ? 0 : 1);
    var parts = [];
    if (d.stdout && d.stdout.trim()) parts.push(escHtml(d.stdout.trimEnd()));
    if (d.stderr && d.stderr.trim()) parts.push('<span class="se-stderr">' + escHtml(d.stderr.trimEnd()) + '</span>');
    if (!d.stdout && !d.stderr) parts.push('<span style="color:#6e7681">(no output)</span>');
    parts.push('<span class="se-meta">exit ' + exitCode + (exitCode !== 0 ? ' <i class="ti ti-x"></i>' : ' <i class="ti ti-check"></i>') +
      ' — <a href="#" style="color:var(--accent2)" onclick="feedCodeResult(this);return false">Feed to AI</a></span>');
    resultEl.innerHTML = parts.join('\n');
    resultEl.dataset.result = JSON.stringify({ command, stdout: d.stdout||'', stderr: d.stderr||'', exitCode });
  } catch (e) {
    resultEl.innerHTML = '<span style="color:#f87171">Error: ' + escHtml(e.message) + '</span>';
  }

  if (btn) { btn.classList.remove('running'); btn.innerHTML = '<i class="ti ti-refresh"></i>'; }
  scrollBottom();
}

// ── Interactive stdin input for waiting processes ────────────────────────

function _parseQuickOptions(hint) {
  if (!hint) return [];
  var options = [];
  // (Y/n), (y/N), (Yes/No), [y/n], [yes/no/quit]
  var bracketMatch = hint.match(/[\(\[]([\w]+(?:[\/|][\w]+)+)[\)\]]\s*$/i);
  if (bracketMatch) {
    var parts = bracketMatch[1].split(/[\/|]/);
    for (var i = 0; i < parts.length; i++) {
      var p = parts[i].trim();
      if (p) options.push({ label: p, value: p, isDefault: p === p.toUpperCase() && p.length <= 3 });
    }
    return options;
  }
  // "Would you like to proceed?" / "Continue?" / "Do you want to..." → yes/no
  if (/\?\s*$/.test(hint) && /would you|do you|continue|proceed|overwrite|replace|delete|remove|confirm|accept|install|update/i.test(hint)) {
    options.push({ label: 'Yes', value: 'yes', isDefault: true });
    options.push({ label: 'No', value: 'no', isDefault: false });
    return options;
  }
  // "Enter password:", "Enter name:", "Type something:" → no quick options, just free text
  return options;
}

function _showShellInput(execId, killId, hint, resultEl) {
  if (document.getElementById('shell-input-' + execId)) return; // already showing

  var wrapper = document.createElement('div');
  wrapper.id = 'shell-input-' + execId;
  wrapper.className = 'shell-stdin-prompt';
  var hintText = hint || 'Waiting for input…';
  var quickOptions = _parseQuickOptions(hintText);

  var quickBtnsHtml = '';
  if (quickOptions.length > 0) {
    quickBtnsHtml = '<div style="display:flex;flex-wrap:wrap;gap:6px;margin-bottom:8px">';
    for (var i = 0; i < quickOptions.length; i++) {
      var opt = quickOptions[i];
      var bg = opt.isDefault ? 'var(--accent,#7c5cff)' : 'var(--bg-secondary,#1e1e1e)';
      var border = opt.isDefault ? 'var(--accent,#7c5cff)' : 'var(--border,#555)';
      var color = opt.isDefault ? '#fff' : 'var(--text-primary,#eee)';
      quickBtnsHtml +=
        '<button onclick="_sendShellQuickOption(\'' + execId + '\',\'' + killId + '\',\'' + escHtml(opt.value) + '\')" ' +
          'style="background:' + bg + ';color:' + color + ';border:1px solid ' + border + ';border-radius:6px;padding:5px 14px;cursor:pointer;font-size:13px;font-family:var(--font-mono,monospace);transition:all .15s"' +
          ' onmouseenter="this.style.opacity=\'0.8\'" onmouseleave="this.style.opacity=\'1\'">' +
          escHtml(opt.label) +
        '</button>';
    }
    quickBtnsHtml += '</div>';
  }

  wrapper.innerHTML =
    '<div style="margin-top:8px;padding:10px 12px;background:var(--bg-tertiary,#2a2a2a);border-radius:8px;border:1px solid var(--border,#3a3a3a)">' +
      '<div style="color:var(--text-primary,#eee);font-size:13px;font-family:var(--font-mono,monospace);margin-bottom:8px;white-space:pre-wrap;line-height:1.4">' +
        '<i class="ti ti-terminal-2" style="color:var(--accent,#7c5cff);margin-right:4px"></i>' + escHtml(hintText) +
      '</div>' +
      quickBtnsHtml +
      '<div style="display:flex;align-items:center;gap:8px">' +
        '<input type="text" id="shell-input-field-' + execId + '" ' +
          'style="flex:1;background:var(--bg-secondary,#1e1e1e);border:1px solid var(--border,#444);border-radius:4px;padding:6px 10px;color:var(--text-primary,#eee);font-family:var(--font-mono,monospace);font-size:13px;outline:none" ' +
          'placeholder="' + (quickOptions.length ? 'Or type a custom response…' : 'Type response and press Enter…') + '" autocomplete="off">' +
        '<button onclick="_sendShellInput(\'' + execId + '\',\'' + killId + '\')" ' +
          'style="background:var(--accent,#7c5cff);color:#fff;border:none;border-radius:4px;padding:6px 12px;cursor:pointer;font-size:12px">' +
          '<i class="ti ti-send"></i>' +
        '</button>' +
      '</div>' +
    '</div>';

  resultEl.parentNode.insertBefore(wrapper, resultEl.nextSibling);

  var inputField = document.getElementById('shell-input-field-' + execId);
  if (inputField) {
    inputField.focus();
    inputField.addEventListener('keydown', function(e) {
      if (e.key === 'Enter') { e.preventDefault(); _sendShellInput(execId, killId); }
    });
  }
}

function _removeShellInput(execId) {
  var el = document.getElementById('shell-input-' + execId);
  if (el) el.remove();
}

async function _sendShellInput(execId, killId) {
  var field = document.getElementById('shell-input-field-' + execId);
  if (!field) return;
  var input = field.value;
  field.value = '';
  field.placeholder = 'Sending…';
  field.disabled = true;

  try {
    await fetch('/api/shell-stdin', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ killId: killId, input: input })
    });
    _removeShellInput(execId);
  } catch (e) {
    field.placeholder = 'Failed — try again';
    field.disabled = false;
  }
}

async function _sendShellQuickOption(execId, killId, value) {
  // Disable all quick buttons to prevent double-click
  var wrapper = document.getElementById('shell-input-' + execId);
  if (wrapper) {
    var btns = wrapper.querySelectorAll('button');
    for (var i = 0; i < btns.length; i++) btns[i].disabled = true;
  }
  try {
    await fetch('/api/shell-stdin', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ killId: killId, input: value })
    });
    _removeShellInput(execId);
  } catch (e) {
    if (wrapper) {
      var btns2 = wrapper.querySelectorAll('button');
      for (var j = 0; j < btns2.length; j++) btns2[j].disabled = false;
    }
  }
}

