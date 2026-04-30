// ── Shell-exec block execution ────────────────────────────────────────────

function extractAndRenderShellExec(html, messageEl, noAutoRun, convId) {
  var container = messageEl.querySelector('.prose') || messageEl;
  var codeBlocks = container.querySelectorAll('code.language-shell-exec, code.language-shell_exec');
  dbg('extractAndRenderShellExec: found ' + codeBlocks.length + ' block(s)', 'info');
  codeBlocks.forEach(function(code) {
    var pre = code.parentElement;
    var rawCode = code.textContent.trim();
    if (!rawCode) { dbg('  ↳ skipped empty block', 'warn'); pre.remove(); return; }

    var execId  = 'se-' + Date.now() + '-' + Math.random().toString(36).slice(2);
    var targetConv = getConv(convId || state.currentId);
    var autoRun = !noAutoRun && state.autoRunShell && (targetConv ? (targetConv._autoFeedDepth || 0) : 0) < 10;
    dbg('  ↳ block: ' + rawCode.slice(0,60) + ' autoRun=' + autoRun + ' depth=' + (targetConv ? targetConv._autoFeedDepth || 0 : 0), 'cmd');

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
        '<div class="shell-exec-btns">' +
          '<button class="shell-exec-run" id="' + execId + '-run" ' +
            'onclick="runShellExec(\'' + execId + '\')"><i class="ti ti-player-play"></i> Run</button>' +
          '<button class="shell-exec-feed" id="' + execId + '-feed" ' +
            'onclick="feedShellResultToAI(\'' + execId + '\')"><i class="ti ti-arrow-right"></i> Feed to AI</button>' +
        '</div>' +
      '</div>' +
      '<div class="shell-exec-code">' + escHtml(rawCode) + '</div>' +
      '<div class="shell-exec-result" id="' + execId + '-result" style="display:none"></div>';
    pre.parentNode.replaceChild(widget, pre);

    // Auto-run after a short delay if enabled
    if (autoRun) {
      setTimeout(function() { runShellExec(execId, { autoFeed: true }); }, 350);
    }
  });
}

var _shellAbortControllers = {};
var _shellKillIds = {};

function showShellRunningPill(execId, code) {
  var container = document.getElementById('shell-running-pills');
  if (!container) return;
  var short = code.length > 46 ? code.slice(0, 46) + '…' : code;
  var pill = document.createElement('span');
  pill.className = 'shell-running-pill';
  pill.id = 'pill-' + execId;
  pill.innerHTML =
    '<i class="ti ti-loader spin"></i>' +
    '<span class="pill-label">' + escHtml(short) + '</span>' +
    '<button class="pill-stop" title="Stop command" onclick="killShellExec(\'' + execId + '\')">' +
      '<i class="ti ti-player-stop-filled"></i>' +
    '</button>';
  container.appendChild(pill);
  container.style.display = 'flex';
}
function hideShellRunningPill(execId) {
  var pill = document.getElementById('pill-' + execId);
  if (pill) pill.remove();
  var container = document.getElementById('shell-running-pills');
  if (container && !container.children.length) container.style.display = 'none';
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
  showShellRunningPill(execId, code);

  try {
    // Route through sandbox endpoint when an agent is active
    var endpoint = '/api/shell-exec';
    // Resolve working directory: prefer conversation CWD, then active project source root
    var convId2 = widget.dataset.convId || state.currentId;
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
    } else {
      dbg('runShellExec error: ' + e.message, 'err');
      resultEl.className = 'shell-exec-result';
      resultEl.innerHTML = '<span class="se-err">Error: ' + escHtml(e.message) + '</span>';
    }
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
  var lines = ['**Shell output:**', '```', '$ ' + code, ''];
  if (d.stdout && d.stdout.trim()) lines.push(d.stdout.trimEnd());
  if (d.stderr && d.stderr.trim()) lines.push('[stderr] ' + d.stderr.trimEnd());
  if (!d.stdout && !d.stderr && d._screenshot) lines.push('(no stdout — screenshot captured)');
  if (!d.stdout && !d.stderr && !d._screenshot && d.exitCode !== 0) lines.push('(no output — command not found or path does not exist)');
  lines.push('exit ' + d.exitCode);
  lines.push('```');
  lines.push('Continue working on the task. If more steps are needed, run the next command. If done, summarize.');

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

