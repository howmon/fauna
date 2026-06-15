// ── Shell-exec block execution ────────────────────────────────────────────

function _parseShellExecResult(widget) {
  if (!widget || !widget.dataset.result) return null;
  try { return JSON.parse(widget.dataset.result); } catch (_) { return null; }
}

var _shellAutoRunStarted = Object.create(null);
var _shellAutoRunPending = Object.create(null);

function _shellStableHash(value) {
  var hash = 2166136261;
  var text = String(value || '');
  for (var i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(36);
}

function _shellEnsureMessageId(messageEl, convId) {
  if (!messageEl) return convId || 'msg';
  if (!messageEl.dataset.shellMsgId) {
    messageEl.dataset.shellMsgId = 'msg-' + _shellStableHash((convId || state.currentId || '') + ':' + Date.now() + ':' + Math.random());
  }
  return messageEl.dataset.shellMsgId;
}

function _findShellWidget(execId, shellKey) {
  var widget = execId ? document.querySelector('[data-exec-id="' + execId + '"]') : null;
  if (widget) return widget;
  if (!shellKey) return null;
  var candidates = Array.from(document.querySelectorAll('.shell-exec-block'));
  return candidates.find(function(candidate) { return candidate.dataset.shellKey === shellKey; }) || null;
}

// ── Interactive-command detection ───────────────────────────────────────
// nano / vim / vi / pico / emacs / micro opening a file → render an inline
// editor instead of trying to run the TUI (which would hang with no output).
// Returns { tool, filePath, fullCommand } or null.
function _detectInteractiveEditor(rawCode) {
  if (!rawCode) return null;
  // Strip leading comment lines so we can see the real command.
  var lines = String(rawCode).split('\n');
  var firstCmd = null;
  for (var i = 0; i < lines.length; i++) {
    var line = lines[i].trim();
    if (!line || line.charAt(0) === '#') continue;
    firstCmd = line;
    break;
  }
  if (!firstCmd) return null;
  // Match `nano <path>` / `vim <path>` / `vi <path>` (with optional flags before path).
  // Allow trailing comments and pipes (rare). Only intercept SIMPLE forms.
  var m = firstCmd.match(/^(?:sudo\s+)?(nano|vim|vi|pico|emacs|micro)\s+(?:-[^\s]+\s+)*([^\s|;&<>]+)\s*$/i);
  if (!m) return null;
  // Skip if combined with anything that looks risky / piped.
  if (/[|;&]|>>|>/.test(firstCmd.replace(m[0], ''))) return null;
  var rawPath = m[2].replace(/^['"]|['"]$/g, '');
  return { tool: m[1].toLowerCase(), filePath: rawPath, fullCommand: firstCmd };
}

// Other purely-interactive TUIs that can't run headless. Same skip-autorun,
// but no editor affordance — just a clear "run this in Terminal yourself" notice.
function _isPurelyInteractiveTui(rawCode) {
  if (!rawCode) return false;
  var lines = String(rawCode).split('\n');
  for (var i = 0; i < lines.length; i++) {
    var line = lines[i].trim();
    if (!line || line.charAt(0) === '#') continue;
    return /^(?:sudo\s+)?(top|htop|btop|man|less|more|ssh|telnet|mysql|psql|sqlite3|redis-cli|mongo|gdb|lldb)\b(?!.*[|<])/i.test(line);
  }
  return false;
}

// Fire-and-forget GUI launchers (`open`, `open -R`, `open -a`, `code`, `xdg-open`).
// These hand off to a desktop app and exit 0 with NO stdout/stderr on success.
// Auto-feeding their empty result back into the chain just makes the model
// guess another variant (`open` → `open -R` → `open subfolder` → …), producing a
// tool storm for a request as simple as "open the folder". When one of these
// succeeds silently we end the auto-feed chain; the user can still click
// "Feed to AI" manually if they want the model to react.
function _isFireAndForgetGuiCommand(rawCode) {
  if (!rawCode) return false;
  var lines = String(rawCode).split('\n');
  for (var i = 0; i < lines.length; i++) {
    var line = lines[i].trim();
    if (!line || line.charAt(0) === '#') continue;
    // Single, un-chained launcher invocation only (no pipes / redirects / && etc.).
    if (/[|;&]|>>|>|<|\$\(|`/.test(line)) return false;
    return /^(?:open|xdg-open|code|code-insiders|cursor)\b/i.test(line);
  }
  return false;
}

function _resolveHomePath(p) {
  if (!p) return p;
  if (p.charAt(0) === '~') {
    return p.replace(/^~/, '__HOME__'); // server resolves relative paths against $HOME; passing '~' literal won't work
  }
  return p;
}

// Render an inline file editor in place of a `nano <file>` shell block.
// Loads file content (or empty), shows textarea + Save. After save, marks the
// widget complete and (optionally) feeds a short summary to the AI.
function _renderInlineFileEditor(widget, info) {
  widget.classList.add('shell-exec-editor');
  widget.dataset.autoRun = 'false';
  var execId = widget.dataset.execId;
  // Path resolution: shell uses ~ for $HOME. We hand the literal string to
  // /api/read-file which already expands relative-to-home if not absolute.
  var displayPath = info.filePath;
  // Heuristic: turn ~/foo into /Users/<me>/foo client-side for read-file.
  // (server's read-file treats non-absolute as relative to homedir, but ~/x
  // is technically absolute-looking with a literal ~, so normalize it.)
  var requestPath = displayPath;
  if (requestPath.charAt(0) === '~') requestPath = requestPath.slice(1).replace(/^\//, '');
  widget.innerHTML =
    '<div class="shell-exec-header">' +
      '<i class="ti ti-edit"></i>' +
      '<span>Edit file</span>' +
      '<code class="shell-exec-editor-path">' + escHtml(displayPath) + '</code>' +
      '<span class="shell-exec-autorun-badge" style="background:var(--fau-surface2);color:var(--fau-text-dim)">interactive — fill in below</span>' +
      '<div class="shell-exec-btns">' +
        '<button class="shell-exec-run" id="' + execId + '-save"><i class="ti ti-device-floppy"></i> Save</button>' +
      '</div>' +
    '</div>' +
    '<div class="shell-exec-editor-status" id="' + execId + '-edit-status">Loading…</div>' +
    '<textarea class="shell-exec-editor-textarea" id="' + execId + '-textarea" spellcheck="false" placeholder="Loading…"></textarea>';

  var statusEl = widget.querySelector('#' + execId + '-edit-status');
  var taEl = widget.querySelector('#' + execId + '-textarea');
  var saveBtn = widget.querySelector('#' + execId + '-save');

  fetch('/api/read-file', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ path: requestPath }),
  }).then(function(r) { return r.json().then(function(d) { return { ok: r.ok, d: d }; }); })
    .then(function(out) {
      if (out.ok && out.d && out.d.content != null) {
        taEl.value = out.d.content;
        statusEl.textContent = 'Loaded ' + (out.d.bytes || 0) + ' bytes';
        widget.dataset.absPath = out.d.path || requestPath;
      } else {
        taEl.value = '';
        statusEl.textContent = 'New file (does not exist yet) — fill in and Save';
        widget.dataset.absPath = requestPath;
      }
      taEl.placeholder = info.tool === 'nano' && /\.env$/.test(displayPath)
        ? 'KEY=value\nANOTHER_KEY=value'
        : '';
    })
    .catch(function(e) {
      statusEl.textContent = 'Read failed: ' + (e && e.message ? e.message : e);
      taEl.placeholder = '';
    });

  saveBtn.addEventListener('click', function() {
    var content = taEl.value;
    var absPath = widget.dataset.absPath || requestPath;
    saveBtn.disabled = true;
    statusEl.textContent = 'Saving…';
    fetch('/api/write-file', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: absPath, content: content }),
    }).then(function(r) { return r.json().then(function(d) { return { ok: r.ok, d: d }; }); })
      .then(function(out) {
        if (!out.ok) {
          statusEl.textContent = 'Save failed: ' + (out.d && out.d.error ? out.d.error : 'unknown');
          saveBtn.disabled = false;
          return;
        }
        statusEl.textContent = 'Saved ' + (out.d.bytes || 0) + ' bytes';
        saveBtn.innerHTML = '<i class="ti ti-check"></i> Saved';
        widget.dataset.result = JSON.stringify({
          ok: true,
          exitCode: 0,
          stdout: 'File saved: ' + (out.d.path || absPath) + ' (' + (out.d.bytes || 0) + ' bytes)\n',
          stderr: '',
          command: info.fullCommand,
        });
        var msg = widget.closest('.msg');
        if (msg && typeof updateMessageShellVerification === 'function') updateMessageShellVerification(msg);
        // Auto-feed a short ack so the AI knows the user filled in their secret.
        if (typeof feedShellResultToAI === 'function') {
          setTimeout(function() { try { feedShellResultToAI(execId); } catch (_) {} }, 200);
        }
      })
      .catch(function(e) {
        statusEl.textContent = 'Save failed: ' + (e && e.message ? e.message : e);
        saveBtn.disabled = false;
      });
  });
}


function _scheduleShellAutoRun(execId, shellKey, delay, attemptsLeft) {
  _shellAutoRunPending[shellKey] = { execId: execId, attemptsLeft: attemptsLeft };
  setTimeout(function() {
    var pending = _shellAutoRunPending[shellKey];
    if (!pending) return;
    var liveWidget = _findShellWidget(pending.execId || execId, shellKey);
    if (!liveWidget) {
      if (pending.attemptsLeft > 0) {
        pending.attemptsLeft -= 1;
        _scheduleShellAutoRun(execId, shellKey, 180, pending.attemptsLeft);
        return;
      }
      delete _shellAutoRunPending[shellKey];
      dbg('runShellExec: auto-run skipped because widget was removed ' + execId, 'warn');
      return;
    }
    var liveExecId = liveWidget.dataset.execId || execId;
    if (_shellAutoRunStarted[liveExecId]) {
      delete _shellAutoRunPending[shellKey];
      return;
    }
    _shellAutoRunStarted[liveExecId] = true;
    delete _shellAutoRunPending[shellKey];
    runShellExec(liveExecId, { autoFeed: true, shellKey: shellKey });
  }, delay);
}

// Find the next chain-pending shell-exec widget in the same message and
// schedule it to auto-run. Called after a previous block completes. Skips
// when auto-exec was turned off mid-flight, when the user already started it
// manually, or when the prior block failed (exit != 0) — a failure shouldn't
// silently barrel into the next, possibly destructive, command.
function _maybeChainNextShellAutoRun(prevWidget, prevExitCode) {
  if (!prevWidget || prevExitCode !== 0) return;
  if (!state.autoRunShell) return;
  var msgEl = prevWidget.closest('.msg');
  if (!msgEl) return;
  var widgets = Array.from(msgEl.querySelectorAll('.shell-exec-block'));
  var startIdx = widgets.indexOf(prevWidget);
  if (startIdx < 0) return;
  for (var i = startIdx + 1; i < widgets.length; i++) {
    var next = widgets[i];
    if (next.dataset.pendingChain !== '1') continue;
    var nextExecId   = next.dataset.execId;
    var nextShellKey = next.dataset.shellKey;
    if (!nextExecId || _shellAutoRunStarted[nextExecId]) {
      delete next.dataset.pendingChain;
      continue;
    }
    delete next.dataset.pendingChain;
    next.dataset.autoRun = 'true';
    var badge = next.querySelector('.shell-exec-autorun-badge');
    if (badge) badge.textContent = 'auto-run';
    dbg('  ↳ chaining next auto-run: ' + nextExecId, 'info');
    _scheduleShellAutoRun(nextExecId, nextShellKey, 350, 8);
    return; // only kick the next one; further blocks chain off it in turn
  }
}

function cancelShellAutoRunsForMessage(messageEl, reason) {
  if (!messageEl) return;
  Array.from(messageEl.querySelectorAll('.shell-exec-block')).forEach(function(widget) {
    var shellKey = widget.dataset.shellKey;
    if (shellKey && _shellAutoRunPending[shellKey]) delete _shellAutoRunPending[shellKey];
    if (widget.dataset.pendingChain) delete widget.dataset.pendingChain;
    if (widget.dataset.result) return;
    widget.dataset.autoRun = 'false';
    var header = widget.querySelector('.shell-exec-header');
    if (header && !header.querySelector('.shell-exec-repair-badge')) {
      var badge = document.createElement('span');
      badge.className = 'shell-exec-autorun-badge shell-exec-repair-badge';
      badge.style.background = 'var(--fau-surface2)';
      badge.style.color = 'var(--fau-text-dim)';
      badge.textContent = 'manual — write repair';
      var btns = header.querySelector('.shell-exec-btns');
      header.insertBefore(badge, btns || null);
    }
    var resultEl = widget.querySelector('.shell-exec-result');
    if (resultEl) {
      resultEl.style.display = '';
      resultEl.innerHTML = '<span class="se-meta">Auto-run cancelled because a file write failed validation. Use structured file repair instead.</span>';
    }
  });
  if (reason) dbg('cancelled pending shell auto-runs: ' + reason, 'warn');
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

  var verificationWidgets = widgets.filter(function(widget) {
    var resultEl = widget.querySelector('.shell-exec-result');
    if (resultEl && resultEl.classList.contains('running')) return true;
    if (widget.dataset.result) return true;
    if (widget.dataset.autoRun === 'true') return true;
    return false;
  });

  if (!verificationWidgets.length) {
    if (banner) banner.remove();
    _updateShellNarrativeVisibility(msgEl, false);
    if (typeof setBusy === 'function') setBusy(false);
    return;
  }

  banner = _ensureShellVerificationBanner(msgEl);
  if (!banner) return;

  var completed = 0;
  var running = 0;
  var empty = 0;
  verificationWidgets.forEach(function(widget) {
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
    if (typeof setBusy === 'function') setBusy(true);
    return;
  }

  if (running > 0 || completed < verificationWidgets.length) {
    banner.className = 'msg-shell-verification pending';
    banner.innerHTML = '<i class="ti ti-loader"></i><span>Shell verification in progress — ' + completed + ' of ' + verificationWidgets.length + ' command' + (verificationWidgets.length === 1 ? '' : 's') + ' produced results.</span>';
    _updateShellNarrativeVisibility(msgEl, true);
    if (typeof setBusy === 'function') setBusy(true);
    return;
  }

  if (empty > 0) {
    banner.className = 'msg-shell-verification warn';
    banner.innerHTML = '<i class="ti ti-alert-triangle"></i><span>Shell results are incomplete. ' + empty + ' command' + (empty === 1 ? '' : 's') + ' produced no output, so the assistant text above remains unverified.</span>';
    _updateShellNarrativeVisibility(msgEl, true);
    if (typeof reconcileBusyState === 'function') reconcileBusyState();
    else if (typeof setBusy === 'function') setBusy(false);
    return;
  }

  banner.className = 'msg-shell-verification done';
  banner.innerHTML = '<i class="ti ti-check"></i><span>Shell results received. Review command output below before trusting any success claims in the assistant message.</span>';
  _updateShellNarrativeVisibility(msgEl, false);
  if (typeof reconcileBusyState === 'function') reconcileBusyState();
  else if (typeof setBusy === 'function') setBusy(false);
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
    // Ignore unexpanded shell variables (e.g. $TMPF, ${VAR}) — we can't resolve them client-side.
    if (/\$/.test(raw)) return;
    // Ignore glob/regex patterns (e.g. browser_[a-zA-Z_]*, *.log) — not real file paths.
    if (/[*?[\]{]/.test(raw)) return;
    // Ignore shell operators and bare punctuation that aren't file paths.
    if (/^[>|<;&]+$/.test(raw)) return;
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

  var existsData;
  try {
    var existsRes = await fetch('/api/preview-file/status?path=' + encodeURIComponent(filePath));
    existsData = await existsRes.json().catch(function() { return null; });
  } catch (_) {
    return null;
  }
  if (!existsData || !existsData.exists) return null;
  if (existsData.path) filePath = existsData.path;

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

// ── Inline permission prompt (replaces native dialog) ──────────────────

function _showInlinePermissionPrompt(execId, widget, resultEl, runBtn, feedBtn, command, explanation, opts) {
  // Hide the result area inside the accordion — we'll show the prompt outside
  if (resultEl) {
    resultEl.style.display = 'none';
    resultEl.className = 'shell-exec-result';
    resultEl.innerHTML = '';
  }

  // Remove any previous prompt for this execId
  var prev = document.getElementById('perm-' + execId);
  if (prev) prev.remove();

  // Build the prompt card as a standalone element outside the accordion
  var card = document.createElement('div');
  card.className = 'perm-prompt-card';
  card.id = 'perm-' + execId;
  card.innerHTML =
    '<div class="perm-prompt-header"><i class="ti ti-shield-lock"></i> Permission Required</div>' +
    '<div class="perm-prompt-cmd">' + escHtml(command) + '</div>' +
    (explanation ? '<div class="perm-prompt-explain">' + escHtml(explanation) + '</div>' : '') +
    '<div class="perm-prompt-actions">' +
      '<button class="perm-btn perm-allow" onclick="_handlePermission(\'' + execId + '\',\'allow\')"><i class="ti ti-check"></i> Allow Once</button>' +
      '<button class="perm-btn perm-always" onclick="_handlePermission(\'' + execId + '\',\'auto-allow\')"><i class="ti ti-checks"></i> Always Allow</button>' +
      '<button class="perm-btn perm-session" onclick="_handlePermission(\'' + execId + '\',\'session-allow\')"><i class="ti ti-lock-open"></i> Allow All This Conversation</button>' +
      '<button class="perm-btn perm-deny" onclick="_handlePermission(\'' + execId + '\',\'deny\')"><i class="ti ti-x"></i> Deny</button>' +
    '</div>';

  // Insert outside the outermost accordion/cluster so approval buttons are never hidden.
  var anchor = widget;
  var detail = widget.closest('details.cot-block, details.process-cluster');
  while (detail && detail.parentElement) {
    anchor = detail;
    detail = detail.parentElement.closest('details.cot-block, details.process-cluster');
  }
  if (anchor && anchor.parentNode) anchor.parentNode.insertBefore(card, anchor.nextSibling);
  try { card.scrollIntoView({ block: 'nearest', behavior: 'smooth' }); } catch (_) {}

  widget._permOpts = opts;
  if (runBtn) {
    runBtn.disabled = false;
    runBtn.innerHTML = '<i class="ti ti-player-play"></i> Run';
  }
  scrollBottom();
}

async function _handlePermission(execId, decision) {
  var widget = document.querySelector('[data-exec-id="' + execId + '"]');
  if (!widget) return;
  var code = widget.dataset.code;
  var resultEl = document.getElementById(execId + '-result');
  var runBtn = document.getElementById(execId + '-run');
  if (!resultEl) {
    resultEl = widget.querySelector('.shell-exec-result');
    if (!resultEl) {
      resultEl = document.createElement('div');
      resultEl.className = 'shell-exec-result';
      resultEl.id = execId + '-result';
      widget.appendChild(resultEl);
    }
  }

  // Remove the standalone permission card
  var card = document.getElementById('perm-' + execId);
  if (card) card.remove();

  if (decision === 'deny') {
    resultEl.style.display = 'block';
    resultEl.className = 'shell-exec-result';
    resultEl.innerHTML = '<span class="se-err"><i class="ti ti-shield-x"></i> Command denied</span>';
    widget.dataset.result = JSON.stringify({ ok: false, exitCode: 126, stdout: '', stderr: '', error: 'Command denied by user', command: code });
    updateMessageShellVerification(widget.closest('.msg'));
    return;
  }

  // Record decision server-side
  if (decision === 'auto-allow') {
    fetch('/api/shell-permission', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ command: code, decision: 'auto-allow' })
    }).catch(function() {});
  }

  // Session-allow: set flag so all subsequent commands in this session skip permissions
  if (decision === 'session-allow') {
    state._sessionAllowAllCommands = true;
  }

  // Clear the prompt and re-run with bypass
  resultEl.style.display = 'none';
  resultEl.className = 'shell-exec-result';
  resultEl.innerHTML = '';

  // Re-run the command with bypassPermissions=true
  var origOpts = widget._permOpts || {};
  origOpts._bypassPermissions = true;
  runShellExec(execId, origOpts);
}

function extractAndRenderShellExec(html, messageEl, noAutoRun, convId) {
  var container = messageEl.querySelector('.prose') || messageEl;
  var codeBlocks = Array.from(container.querySelectorAll('code.language-shell-exec, code.language-shell_exec'));
  dbg('extractAndRenderShellExec: found ' + codeBlocks.length + ' block(s)', 'info');
  if (codeBlocks.length) updateMessageShellVerification(messageEl);
  var shellMsgId = _shellEnsureMessageId(messageEl, convId);
  // When auto-exec is on we now run ALL blocks in the response sequentially:
  // the first block is scheduled immediately, every subsequent block is marked
  // pending-chain and gets started by the previous block's completion handler.
  // This matches what users expect from "auto execute": every command in the
  // response runs without per-block manual clicks.
  var _autoRunIdx = 0;
  codeBlocks.forEach(function(code, blockIdx) {
    var pre = code.parentElement;
    var rawCode = code.textContent.trim();
    if (!rawCode) {
      dbg('  ↳ empty shell block — replacing with model-error notice', 'warn');
      // Don't silently delete: an empty bash/shell-exec block almost always
      // means the model emitted a header like "Run this..." but forgot the
      // actual command (or worse, asked the user to "paste the output"
      // instead of using fauna_shell_exec). Show a visible scolding so the
      // user knows what happened and can re-prompt, and so the model sees
      // the warning in its next turn's context.
      var warn = document.createElement('div');
      warn.className = 'shell-empty-warning';
      warn.innerHTML =
        '<div class="shell-empty-warning-header">' +
          '<i class="ti ti-alert-triangle"></i>' +
          '<span>The model emitted an empty shell block — no command to run.</span>' +
        '</div>' +
        '<div class="shell-empty-warning-body">' +
          'Fauna should call the <code>fauna_shell_exec</code> tool itself ' +
          'instead of asking you to run something. Try replying ' +
          '<em>"call fauna_shell_exec yourself"</em> to nudge it.' +
        '</div>';
      pre.parentNode.replaceChild(warn, pre);
      return;
    }

    var shellKey = [convId || state.currentId || '', shellMsgId, blockIdx, _shellStableHash(rawCode)].join(':');
    var execId  = 'se-' + _shellStableHash(shellKey);
    var targetConv = getConv(convId || state.currentId);
    var depth = targetConv ? (targetConv._autoFeedDepth || 0) : 0;
    var DEPTH_LIMIT = 12;
    // Eligible-for-auto-run: every block in the response, when auto-exec is on
    // and we're under the depth cap. Only the FIRST block actually schedules
    // here; later blocks get tagged `data-pending-chain="1"` and are kicked
    // off serially when the prior block finishes (see runShellExec tail).
    var eligible = !noAutoRun && state.autoRunShell && depth < DEPTH_LIMIT;
    var autoRun = eligible && _autoRunIdx === 0;
    var chainPending = eligible && _autoRunIdx > 0;
    var depthLimited = !noAutoRun && state.autoRunShell && depth >= DEPTH_LIMIT;
    var suppressedAutoRun = !!noAutoRun && state.autoRunShell;
    if (eligible) _autoRunIdx++;
    dbg('  ↳ block: ' + rawCode.slice(0,60) + ' autoRun=' + autoRun + ' chain=' + chainPending + ' depth=' + depth, 'cmd');

    var widget = document.createElement('div');
    widget.className = 'shell-exec-block';
    widget.dataset.code = rawCode;
    widget.dataset.execId = execId;
    widget.dataset.shellKey = shellKey;
    widget.dataset.convId = convId || state.currentId || ''; // route auto-feed to correct conv
    widget.dataset.autoRun = autoRun ? 'true' : 'false';
    // Subsequent auto-run blocks are kicked off by the prior block's completion
    // handler — mark them so we can find the next one in DOM order.
    if (chainPending) widget.dataset.pendingChain = '1';

    // ── Interactive-command interception ──
    // nano/vim/vi/pico/emacs <file> → render inline editor instead of running.
    var editorInfo = _detectInteractiveEditor(rawCode);
    if (editorInfo) {
      pre.parentNode.replaceChild(widget, pre);
      _renderInlineFileEditor(widget, editorInfo);
      updateMessageShellVerification(messageEl);
      return; // skip the rest of the rendering / auto-run path
    }
    // top/htop/less/man/mysql REPL/etc. → don't auto-run, show notice.
    if (_isPurelyInteractiveTui(rawCode)) {
      widget.dataset.autoRun = 'false';
      autoRun = false;
      chainPending = false;
      delete widget.dataset.pendingChain;
    }

    widget.innerHTML =
      '<div class="shell-exec-header">' +
        '<i class="ti ti-terminal-2"></i>' +
        '<span>Shell Command</span>' +
        (autoRun ? '<span class="shell-exec-autorun-badge">auto-run</span>' : '') +
        (chainPending ? '<span class="shell-exec-autorun-badge">auto-run (chained)</span>' : '') +
        (suppressedAutoRun ? '<span class="shell-exec-autorun-badge" title="Auto-run was paused for this command because the previous step looked like a malformed write-file repair. Click Run to execute." style="background:var(--fau-surface2);color:var(--fau-text-dim)">paused — click Run</span>' : '') +
        (depthLimited ? '<span class="shell-exec-autorun-badge" style="background:var(--warn,#f59e0b);color:#000">paused — click Run</span>' : '') +
        '<div class="shell-exec-btns">' +
          '<button class="shell-exec-run" id="' + execId + '-run" ' +
            'onclick="runShellExec(\'' + execId + '\')"><i class="ti ti-player-play"></i> Run</button>' +
          '<button class="shell-exec-feed" id="' + execId + '-feed" ' +
            'onclick="feedShellResultToAI(\'' + execId + '\')"><i class="ti ti-arrow-right"></i> Feed to AI</button>' +
        '</div>' +
      '</div>' +
      '<div class="shell-exec-code">' + escHtml(rawCode) + '</div>' +
      '<div class="shell-exec-result" id="' + execId + '-result"' + (depthLimited || chainPending || suppressedAutoRun ? '' : ' style="display:none"') + '>' +
        (depthLimited ? '<span class="se-meta">Auto-run paused after ' + DEPTH_LIMIT + ' steps — click Run to continue.</span>' : '') +
        (chainPending ? '<span class="se-meta">Queued — will run automatically after the previous command.</span>' : '') +
        (suppressedAutoRun ? '<span class="se-meta">Auto-run paused — the previous step looked like a malformed write-file repair. Click <b>Run</b> to execute this command, or have Fauna retry with file-plan / append-file / replace-string instead.</span>' : '') +
      '</div>';
    pre.parentNode.replaceChild(widget, pre);
    updateMessageShellVerification(messageEl);

    // Auto-run after a short delay if enabled
    if (autoRun) {
      _scheduleShellAutoRun(execId, shellKey, 350, 8);
    }
    // If depth limit hit, notify AI once so it stops looping
    if (depthLimited && targetConv && !targetConv._depthLimitNotified) {
      targetConv._depthLimitNotified = true;
      setTimeout(function() {
        sendDirectMessage(
          'Auto-run paused after ' + DEPTH_LIMIT + ' consecutive markdown ```bash steps (safety guard against runaway loops). ' +
          'The command `' + rawCode.slice(0, 120) + '` was NOT run automatically.\n\n' +
          'Your tools are all still available — nothing has been disabled. Do NOT ask the user whether to proceed. Either:\n' +
          '  1. If the task is fully complete, give the final summary now.\n' +
          '  2. Otherwise, switch to the `fauna_shell_exec` function tool (NOT markdown ```bash) for the next step — it does not count against this depth cap and keeps the agent loop running in a single turn.\n' +
          '  3. Or use any other appropriate tool (browser-ext-action, figma_execute, file edit tools, etc.) to make progress.\n\n' +
          'Never claim "tools are unavailable" or "I am blocked" — that is incorrect. Never ask "should I continue?".',
          { fromAutoFeed: true, isAutoFeed: true, targetConvId: convId || state.currentId }
        );
      }, 400);
    }
  });

  // In chain messages (auto-fed responses), hide narration prose — only show the shell widgets
  if (messageEl.classList.contains('chain-msg') && container && codeBlocks.length) {
    Array.from(container.children).forEach(function(child) {
      if (!child.classList || !child.classList.contains('shell-exec-block')) {
        child.style.display = 'none';
      }
    });
    messageEl.classList.add('chain-shell-only');
  }
}

var _shellAbortControllers = {};
var _shellKillIds = {};

function _shellWidgetBelongsToActiveConversation(widget) {
  if (!widget) return false;
  var activeConvId = (typeof state !== 'undefined' && state.currentId) ? state.currentId : '';
  if (!activeConvId) return true;
  return !widget.dataset.convId || widget.dataset.convId === activeConvId;
}

function hasActiveShellWorkForCurrentConversation() {
  var activeWidgets = Array.from(document.querySelectorAll('.shell-exec-block')).filter(_shellWidgetBelongsToActiveConversation);
  if (!activeWidgets.length) return false;
  var hasRunning = activeWidgets.some(function(widget) {
    // Dev servers run in the background — they never count as blocking work
    // for the input bar. The user manages them from Settings → Dev Servers.
    if (widget.dataset.devServer === '1') return false;
    var resultEl = widget.querySelector('.shell-exec-result');
    return resultEl && resultEl.classList.contains('running');
  });
  if (hasRunning) return true;
  var pendingKeys = Object.keys(_shellAutoRunPending || {});
  if (pendingKeys.length && activeWidgets.some(function(widget) { return pendingKeys.indexOf(widget.dataset.shellKey || '') >= 0; })) return true;
  return false;
}

function hasPendingShellVerificationForCurrentConversation() {
  var activeWidgets = Array.from(document.querySelectorAll('.shell-exec-block')).filter(_shellWidgetBelongsToActiveConversation);
  if (!activeWidgets.length) return false;
  return activeWidgets.some(function(widget) {
    // If a result has been recorded, the widget is done — the `autoRun="true"`
    // dataset flag stays set after creation and would otherwise mark every
    // historical auto-run widget as "still pending" forever, keeping the Stop
    // button stuck on after the task is complete.
    if (widget.dataset.result) return false;
    var resultEl = widget.querySelector('.shell-exec-result');
    var isRunning = !!(resultEl && resultEl.classList.contains('running'));
    var isPendingAutoRun = !!(widget.dataset.shellKey && _shellAutoRunPending[widget.dataset.shellKey]);
    return isRunning || isPendingAutoRun || widget.dataset.autoRun === 'true';
  });
}

function stopActiveShellWorkForCurrentConversation() {
  var activeWidgets = Array.from(document.querySelectorAll('.shell-exec-block')).filter(_shellWidgetBelongsToActiveConversation);
  var stopped = 0;
  activeWidgets.forEach(function(widget) {
    var execId = widget.dataset.execId;
    var shellKey = widget.dataset.shellKey || '';
    var resultEl = widget.querySelector('.shell-exec-result');
    var isRunning = resultEl && resultEl.classList.contains('running');
    var isPendingAutoRun = shellKey && _shellAutoRunPending[shellKey];
    if (shellKey && _shellAutoRunPending[shellKey]) {
      delete _shellAutoRunPending[shellKey];
      stopped += 1;
    }
    if (execId && _shellAbortControllers[execId]) {
      killShellExec(execId);
      stopped += 1;
      return;
    }
    if (!widget.dataset.result && (isRunning || isPendingAutoRun || widget.dataset.autoRun === 'true')) {
      if (resultEl) {
        resultEl.style.display = 'block';
        resultEl.className = 'shell-exec-result';
        resultEl.innerHTML = '<span class="se-meta">Stopped</span>';
      }
      widget.dataset.result = JSON.stringify({ ok: false, exitCode: 130, stdout: '', stderr: '', error: 'Stopped', command: widget.dataset.code || '' });
    }
  });
  activeWidgets.forEach(function(widget) { updateMessageShellVerification(widget.closest('.msg')); });
  if (typeof reconcileBusyState === 'function') reconcileBusyState();
  else if (typeof setBusy === 'function') setBusy(false);
  return stopped;
}

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
  if (typeof reconcileBusyState === 'function') reconcileBusyState();
  else if (typeof setBusy === 'function') setBusy(visibleCount > 0 || hasActiveShellWorkForCurrentConversation());
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

// Non-blocking pill for dev servers. Lives in a separate container so it
// doesn't count toward `hasActiveShellWorkForCurrentConversation` and the
// send button stays enabled. Clicking it opens Settings → Dev Servers.
function showDevServerPill(regId, code, convId) {
  var container = document.getElementById('dev-server-pills');
  if (!container) {
    var anchor = document.getElementById('shell-running-pills');
    if (!anchor || !anchor.parentNode) return;
    container = document.createElement('div');
    container.id = 'dev-server-pills';
    container.className = 'dev-server-pills';
    anchor.parentNode.insertBefore(container, anchor.nextSibling);
  }
  // De-dupe by registry id when present
  var pillId = 'devpill-' + (regId || ('x-' + Date.now()));
  if (document.getElementById(pillId)) { syncDevServerPills(); return; }
  var label = (function() {
    var s = String(code || '').replace(/^[^&]*&&\s*/, '').trim();
    // Pick a meaningful binary token
    var m = s.match(/\b(npm|pnpm|yarn|bun)\s+(?:run\s+)?[\w:-]+|\bvite\b|\bnext\s+dev\b|\bphp\s+-S[^\s]*\s*[^\s]*|\b(?:uvicorn|gunicorn|nodemon|tsx|ts-node-dev|serve|http-server)\b[^|;]*/i);
    var pick = m ? m[0] : s.split(/\s+/).slice(0, 2).join(' ');
    return pick.length > 30 ? pick.slice(0, 30) + '…' : pick;
  })();
  var pill = document.createElement('span');
  pill.className = 'dev-server-pill';
  pill.id = pillId;
  pill.dataset.convId = convId || (typeof state !== 'undefined' ? (state.currentId || '') : '');
  pill.title = 'Dev server running — click to manage in Settings';
  pill.innerHTML =
    '<i class="ti ti-server-bolt"></i>' +
    '<span class="pill-label">' + escHtml(label) + '</span>' +
    '<i class="ti ti-external-link" style="opacity:.65;font-size:11px"></i>';
  pill.onclick = function() {
    try {
      if (typeof switchPage === 'function') switchPage('settings');
      setTimeout(function() {
        var nav = document.querySelector('[data-page="dev-servers"]');
        if (nav && typeof nav.click === 'function') nav.click();
      }, 50);
    } catch (_) {}
  };
  container.appendChild(pill);
  syncDevServerPills();
}

function syncDevServerPills() {
  var container = document.getElementById('dev-server-pills');
  if (!container) return;
  var activeConvId = (typeof state !== 'undefined' && state.currentId) ? state.currentId : '';
  var visible = 0;
  Array.from(container.children).forEach(function(pill) {
    var pillConvId = pill.dataset.convId || '';
    var show = !pillConvId || pillConvId === activeConvId;
    pill.style.display = show ? '' : 'none';
    if (show) visible += 1;
  });
  container.style.display = visible ? 'flex' : 'none';
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
  var widget   = _findShellWidget(execId, opts.shellKey || '');
  if (!widget) { dbg('runShellExec: widget not found ' + execId, 'err'); return; }
  execId = widget.dataset.execId || execId;
  var code     = widget.dataset.code;
  var convId2  = widget.dataset.convId || state.currentId;
  var runBtn   = document.getElementById(execId + '-run');
  var feedBtn  = document.getElementById(execId + '-feed');
  var resultEl = document.getElementById(execId + '-result');
  if (!resultEl) {
    resultEl = widget.querySelector('.shell-exec-result');
    if (!resultEl) {
      resultEl = document.createElement('div');
      resultEl.className = 'shell-exec-result';
      resultEl.id = execId + '-result';
      widget.appendChild(resultEl);
    }
  }

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
      if (runBtn) {
        runBtn.disabled = false;
        runBtn.innerHTML = '<i class="ti ti-player-play"></i> Run';
      }
      return;
    }
  }

  if (runBtn) {
    runBtn.disabled = true;
    runBtn.innerHTML = '<i class="ti ti-loader"></i>';
  }
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
    // Bypass permissions if settings toggle is on, session-allow-all is active, or re-running after approval
    if (state.bypassCommandPermissions || state._sessionAllowAllCommands || opts._bypassPermissions) {
      bodyObj.bypassPermissions = true;
    }
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

    // ── Handle permission-required response (inline prompt) ──
    var contentType = r.headers.get('content-type') || '';
    var jsonCompleted = null; // set when server returned a finished JSON result (e.g. sandbox endpoint)
    if (contentType.includes('application/json')) {
      var jsonResp = await r.json();
      if (jsonResp.permissionRequired) {
        clearInterval(timerInterval);
        hideShellRunningPill(execId);
        delete _shellAbortControllers[execId];
        delete _shellKillIds[execId];
        _showInlinePermissionPrompt(execId, widget, resultEl, runBtn, feedBtn, jsonResp.command, jsonResp.explanation, opts);
        return;
      }
      // Other JSON error responses (like 403 blocked)
      if (!jsonResp.ok || jsonResp.error) {
        clearInterval(timerInterval);
        hideShellRunningPill(execId);
        delete _shellAbortControllers[execId];
        delete _shellKillIds[execId];
        resultEl.className = 'shell-exec-result';
        resultEl.innerHTML = '<span class="se-err">' + escHtml(jsonResp.error || 'Unknown error') + '</span>';
        widget.dataset.result = JSON.stringify({ ok: false, exitCode: 1, stdout: '', stderr: '', error: jsonResp.error, command: code });
        updateMessageShellVerification(widget.closest('.msg'));
        if (runBtn) {
          runBtn.disabled = false;
          runBtn.innerHTML = '<i class="ti ti-player-play"></i> Run';
        }
        return;
      }
      // Successful completed JSON result (sandbox endpoint always returns this
      // shape — it never streams). Cannot call r.body.getReader() now: the
      // body is already locked by the r.json() above. Stash the result and
      // skip the SSE loop.
      jsonCompleted = jsonResp;
    }

    // ── Streaming mode: parse SSE events ──
    var stdoutBuf = '';
    var stderrBuf = '';
    var exitCode = 0;
    var errMsg = '';

    if (jsonCompleted) {
      stdoutBuf = jsonCompleted.stdout || '';
      stderrBuf = jsonCompleted.stderr || '';
      exitCode = jsonCompleted.exitCode || 0;
      errMsg = jsonCompleted.error || '';
    } else {
      var reader = r.body.getReader();
      var decoder = new TextDecoder();
      var sseBuf = '';

      while (true) {
        var chunk = await reader.read();
        if (chunk.done) break;
      if (!widget.isConnected) break;
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
            if (sseEvt.detached) {
              // Dev server was registered and the stream was closed. Keep the
              // widget in a "started" state without leaving it pinned to the
              // input bar as a blocking running pill.
              widget.dataset.devServer = '1';
              if (!stdoutBuf && !stderrBuf) {
                stdoutBuf = 'Dev server started in background. Manage it from Settings → Dev Servers.';
              }
            }
            _removeShellInput(execId);
          } else if (sseEvt.type === 'dev_server_detached') {
            widget.dataset.devServer = '1';
            widget.dataset.devServerId = sseEvt.id || '';
            stdoutBuf = (stdoutBuf ? stdoutBuf + '\n' : '') + (sseEvt.message || 'Dev server started in background.');
            resultEl.textContent = stdoutBuf;
            // Stop the running spinner UI immediately and free the input bar.
            clearInterval(timerInterval);
            resultEl.className = 'shell-exec-result';
            hideShellRunningPill(execId);
            if (typeof showDevServerPill === 'function') {
              showDevServerPill(sseEvt.id || execId, sseEvt.command || code, convId2);
            }
            if (typeof reconcileBusyState === 'function') reconcileBusyState();
          } else if (sseEvt.type === 'error') {
            errMsg = sseEvt.error || 'Unknown error';
          }
        } catch (_) {}
      }
    }
    } // end else (streaming branch)

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
    if (runBtn) {
      runBtn.disabled = false;
      runBtn.innerHTML = '<i class="ti ti-refresh"></i> Re-run';
    }

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
    updateMessageShellVerification(widget.closest('.msg'));
    if (typeof syncShellRunningPills === 'function') syncShellRunningPills();

    // Chain auto-run: kick off the next pending block in the same message.
    // Only when the user has auto-exec on AND this block actually succeeded —
    // a failed step shouldn't silently barrel into the next destructive one.
    _maybeChainNextShellAutoRun(widget, exitCode);

    // Auto-feed output back to AI always when autoFeed is set —
    // the AI needs to know about empty results and failures, not just successes
    if (opts.autoFeed) {
      // Exception: a fire-and-forget GUI launcher that succeeded with no output
      // has nothing useful to verify. Feeding its empty result back only invites
      // the model to retry endless `open`/`code` variants (tool storm). End the
      // chain here — the manual "Feed to AI" button remains available.
      var _silentLauncher = exitCode === 0
        && !(d.stdout && d.stdout.trim())
        && !(d.stderr && d.stderr.trim())
        && !d._screenshot
        && (!d._verifiedPaths || !d._verifiedPaths.length)
        && _isFireAndForgetGuiCommand(code);
      if (_silentLauncher) {
        dbg('  ↳ auto-feed skipped — fire-and-forget GUI launcher succeeded silently', 'info');
      } else {
        dbg('  ↳ auto-feeding output to AI' + (d._screenshot ? ' with screenshot' : ''), 'info');
        setTimeout(function() { feedShellResultToAI(execId, { silent: true }); }, 600);
      }
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
    if (runBtn) {
      runBtn.disabled = false;
      runBtn.innerHTML = '<i class="ti ti-player-play"></i> Run';
    }
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
    var bodyObj = { command: command };
    if (state.bypassCommandPermissions || state._sessionAllowAllCommands) {
      bodyObj.bypassPermissions = true;
    }
    var r = await fetch('/api/shell-exec', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(bodyObj)
    });
    var d = r.ok ? await r.json() : { ok: false, exitCode: 1, stdout: '', stderr: await r.text(), command };

    // Handle permission-required response
    if (d.permissionRequired) {
      resultEl.innerHTML =
        '<div class="perm-prompt-card" style="margin:0">' +
          '<div class="perm-prompt-header"><i class="ti ti-shield-lock"></i> Permission Required</div>' +
          '<div class="perm-prompt-cmd">' + escHtml(d.command) + '</div>' +
          (d.explanation ? '<div class="perm-prompt-explain">' + escHtml(d.explanation) + '</div>' : '') +
          '<div style="font-size:11px;color:var(--fau-text-muted)">Use the shell-exec widget or enable <em>Bypass command permissions</em> in Settings.</div>' +
        '</div>';
      if (btn) { btn.classList.remove('running'); btn.innerHTML = '<i class="ti ti-player-play"></i>'; }
      return;
    }

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

function _showShellInput(execId, killId, hint, resultEl, context) {
  if (document.getElementById('shell-input-' + execId)) return; // already showing

  var wrapper = document.createElement('div');
  wrapper.id = 'shell-input-' + execId;
  wrapper.className = 'shell-stdin-prompt';
  var hintText = hint || 'Waiting for input…';
  var quickOptions = _parseQuickOptions(hintText);

  // Derive a human-readable input placeholder from the hint
  // Strip trailing prompt chars (?, :, >, spaces) to get the question
  var cleanHint = hintText.replace(/[\s?:>]+$/, '').trim();
  var inputPlaceholder = quickOptions.length
    ? 'Or type a custom response…'
    : (cleanHint && cleanHint !== 'Waiting for input…' ? cleanHint + '…' : 'Type your response…');

  // Build context block showing what the process printed before going idle
  var contextHtml = '';
  if (context && context.trim()) {
    // Strip ANSI escape codes for display
    var cleanCtx = context.replace(/\x1b\[[0-9;]*[mGKHF]/g, '').trim();
    if (cleanCtx) {
      contextHtml =
        '<div style="margin-bottom:10px;border-radius:6px;background:var(--bg-secondary,#1e1e1e);border:1px solid var(--border,#3a3a3a);overflow:hidden">' +
          '<div style="padding:4px 10px;font-size:10px;font-weight:600;text-transform:uppercase;letter-spacing:.5px;color:var(--text-secondary,#aaa);border-bottom:1px solid var(--border,#3a3a3a)">Process output</div>' +
          '<div style="padding:8px 10px;font-size:12px;font-family:var(--font-mono,monospace);white-space:pre-wrap;line-height:1.5;color:var(--text-primary,#eee);max-height:180px;overflow-y:auto">' + escHtml(cleanCtx) + '</div>' +
        '</div>';
    }
  }

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
      contextHtml +
      '<div style="display:flex;align-items:flex-start;gap:8px;margin-bottom:10px">' +
        '<i class="ti ti-terminal-2" style="color:var(--accent,#7c5cff);font-size:14px;margin-top:2px;flex-shrink:0"></i>' +
        '<div>' +
          '<div style="color:var(--text-secondary,#aaa);font-size:10px;font-weight:600;text-transform:uppercase;letter-spacing:.5px;margin-bottom:3px">Waiting for input</div>' +
          '<div style="color:var(--text-primary,#eee);font-size:13px;font-family:var(--font-mono,monospace);white-space:pre-wrap;line-height:1.5">' + escHtml(hintText) + '</div>' +
        '</div>' +
      '</div>' +
      quickBtnsHtml +
      '<div style="display:flex;align-items:center;gap:8px">' +
        '<input type="text" id="shell-input-field-' + execId + '" ' +
          'style="flex:1;background:var(--bg-secondary,#1e1e1e);border:1px solid var(--accent,#7c5cff);border-radius:6px;padding:7px 11px;color:var(--text-primary,#eee);font-family:var(--font-mono,monospace);font-size:13px;outline:none" ' +
          'placeholder="' + escHtml(inputPlaceholder) + '" autocomplete="off">' +
        '<button onclick="_sendShellInput(\'' + execId + '\',\'' + killId + '\')" ' +
          'style="background:var(--accent,#7c5cff);color:#fff;border:none;border-radius:6px;padding:7px 13px;cursor:pointer;font-size:12px;display:flex;align-items:center;gap:4px">' +
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

