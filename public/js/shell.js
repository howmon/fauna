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

// ── Shell-block classifier ───────────────────────────────────────────────
// Models routinely fence non-shell content as ```bash``` (sample output,
// bare file paths, Python REPL input, etc.). Auto-running those produces
// nonsense `command not found` / parse errors that then get fed back into
// the model in a loop. We classify each block so the runner can:
//   • run anything that looks like a real command (default — autonomy intact)
//   • skip auto-run on obviously-non-shell content and surface a notice
//   • fold chained Python REPL input into a single `python3` heredoc so
//     `python3` → `name = "Solomon"` → `print(name)` works as one session
// Returns one of:
//   { kind: 'shell' }                    — runnable as-is
//   { kind: 'repl-launch', lang }        — bare `python3` / `node` REPL launcher
//   { kind: 'interpreter-input', lang }  — Python/JS code in a bash fence
//   { kind: 'bare-path' }                — single path, no command verb
//   { kind: 'literal' }                  — free-text / program output
//   { kind: 'empty' }                    — comments / whitespace only
function _classifyShellBlock(rawCode) {
  if (!rawCode) return { kind: 'empty' };
  var lines = String(rawCode).split(/\r?\n/);
  var first = '';
  for (var i = 0; i < lines.length; i++) {
    var ln = lines[i].trim();
    if (!ln || ln.charAt(0) === '#') continue;
    first = ln;
    break;
  }
  if (!first) return { kind: 'empty' };

  // Bare REPL launchers (no script arg, no -c/-m). Used as fold targets.
  if (/^(?:python|python3)(?:\s+-[iIquvOEBsS]+)*\s*$/.test(first)) {
    return { kind: 'repl-launch', lang: 'python' };
  }
  if (/^node(?:\s+-i)?\s*$/.test(first)) {
    return { kind: 'repl-launch', lang: 'node' };
  }

  // Python-syntax tells — these shapes don't appear in legal shell.
  var isPython =
    /^(?:>>>|\.\.\.)\s/.test(first) ||
    /^(?:def|class|import|from|elif|raise|yield|nonlocal|global|lambda|async|await|with|try|except|finally|pass)\b/.test(first) ||
    /^print\s*\(/.test(first) ||
    // `name = "Solomon"` — Python-style assignment (shell uses `name=value`, no spaces).
    /^[A-Za-z_][A-Za-z0-9_]*\s+=\s+(?:["'\d({\[]|f["']|None\b|True\b|False\b)/.test(first) ||
    /^(?:if|while|for)\s+.+:\s*$/.test(first);
  if (isPython) return { kind: 'interpreter-input', lang: 'python' };

  // JS-syntax tells.
  var isJs =
    /^(?:const|let|var)\s+[A-Za-z_$]/.test(first) ||
    /^console\.(?:log|error|warn|info|debug)\s*\(/.test(first) ||
    /^function\s+[A-Za-z_$]/.test(first);
  if (isJs) return { kind: 'interpreter-input', lang: 'node' };

  // Single token that's an absolute path or relative source file with no
  // args — almost always a file reference rendered as `bash`, not a command.
  // Running it triggers `command not found` (exit 127).
  var trimmed = String(rawCode).trim();
  if (trimmed === first && /^\/[^\s|;&<>$()`]+$/.test(first)) {
    return { kind: 'bare-path' };
  }
  if (trimmed === first &&
      /^[A-Za-z0-9_./-]+\.(?:py|js|ts|tsx|jsx|json|md|txt|csv|html|css|yaml|yml|toml)$/.test(first) &&
      !/\s/.test(first)) {
    return { kind: 'bare-path' };
  }

  // First token must look like an executable name or an env-var assignment.
  // Catches free text like "Hello, Solomon" (first token "Hello," has a
  // trailing comma — not a valid command name).
  var firstToken = first.split(/\s+/)[0];
  var execShape  = /^(?:\.{1,2}\/)?[A-Za-z_][A-Za-z0-9._+-]*$/;
  var pathShape  = /^\/[A-Za-z0-9._/+-]+$/;
  var envAssign  = /^[A-Za-z_][A-Za-z0-9_]*=/; // shell-style, no spaces
  if (!execShape.test(firstToken) && !pathShape.test(firstToken) && !envAssign.test(first)) {
    return { kind: 'literal' };
  }

  return { kind: 'shell' };
}

// Plan REPL folds for a list of classifications. Returns:
//   { foldedInto: { childIdx: parentIdx },
//     foldedExtra: { parentIdx: [textPieces] } }
// A `repl-launch python` block followed by `interpreter-input python` (and
// re-entries of the same REPL) is treated as one session.
function _planReplFolds(classes, rawCodes) {
  var foldedInto  = Object.create(null);
  var foldedExtra = Object.create(null);
  for (var i = 0; i < classes.length; i++) {
    var cls = classes[i];
    if (cls.kind !== 'repl-launch' || cls.lang !== 'python') continue;
    var pieces = [];
    for (var j = i + 1; j < classes.length; j++) {
      var c = classes[j];
      if (c.kind === 'interpreter-input' && c.lang === cls.lang) {
        pieces.push(rawCodes[j]);
        foldedInto[j] = i;
      } else if (c.kind === 'repl-launch' && c.lang === cls.lang) {
        foldedInto[j] = i; // absorb re-launch
      } else {
        break;
      }
    }
    if (pieces.length) foldedExtra[i] = pieces;
  }
  return { foldedInto: foldedInto, foldedExtra: foldedExtra };
}

function _buildPythonHeredoc(pieces) {
  var marker = '__FAUNA_PY_EOF__';
  var joined = pieces.join('\n');
  while (joined.indexOf(marker) !== -1) {
    marker = '__FAUNA_PY_EOF_' + Math.random().toString(36).slice(2, 8) + '__';
  }
  return "python3 - <<'" + marker + "'\n" + joined + "\n" + marker;
}

function _classifySkipNoticeHtml(cls) {
  var label, detail;
  if (cls.kind === 'interpreter-input') {
    label  = (cls.lang === 'python' ? 'Python' : 'JavaScript') + ' code (not a shell command)';
    detail = 'Auto-run skipped. Paste this into the matching REPL, or click <b>Run</b> to force-execute as shell anyway.';
  } else if (cls.kind === 'bare-path') {
    label  = 'File path (not a shell command)';
    detail = 'Auto-run skipped — running a bare path as a command would just emit “command not found”. Click <b>Run</b> to force-execute.';
  } else if (cls.kind === 'literal') {
    label  = 'Looks like program output, not a shell command';
    detail = 'Auto-run skipped. Click <b>Run</b> to force-execute as shell anyway.';
  } else {
    label  = 'Non-shell content';
    detail = 'Auto-run skipped.';
  }
  return '<span class="se-meta se-skip-notice"><i class="ti ti-info-circle"></i> ' +
         escHtml(label) + ' — ' + detail + '</span>';
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

  // Files written from INSIDE an inline program never appear as a shell
  // redirect — e.g. python-pptx `prs.save("deck.pptx")`, openpyxl
  // `wb.save('report.xlsx')`, python-docx `doc.save("memo.docx")`, or a PDF
  // export. Scan for quoted string literals ending in an office/document
  // extension so these generated artifacts still surface as a card. Scoped to
  // formats that are almost always OUTPUTS (not read inputs) to avoid false
  // positives on plain text/data files the program merely reads.
  var OUTPUT_DOC_EXT = /\.(pptx|ppt|key|odp|docx|doc|rtf|odt|xlsx|xls|ods|numbers|pdf)$/i;
  String(command || '').replace(/["']([^"'\n]{1,300}?\.[A-Za-z0-9]{1,6})["']/g, function(_, path) {
    if (OUTPUT_DOC_EXT.test(path)) pushMatch(path);
    return _;
  });

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
  // Binary office formats — never send through /api/read-file (it would return
  // garbage/base64). Deck & spreadsheet open in their native app; DOCX gets its
  // text extracted for the inline editor.
  if (['ppt','pptx','key','odp'].includes(ext)) {
    return addArtifact({ type: 'deck', title: title, path: filePath });
  }
  if (['xls','xlsx','ods','numbers'].includes(ext)) {
    return addArtifact({ type: 'xlsx', title: title, path: filePath });
  }
  if (['doc','docx','rtf','odt','pages'].includes(ext)) {
    try {
      var docRes = await fetch('/api/extract-document', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path: filePath })
      });
      var docData = await docRes.json().catch(function() { return null; });
      if (docData && docData.ok) {
        return addArtifact({ type: 'docx', title: title, path: docData.path || filePath, content: docData.content || '', editable: docData.editable !== false });
      }
    } catch (_) {}
    return addArtifact({ type: 'docx', title: title, path: filePath, editable: false });
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

  // ── Pre-pass: classify every block + plan Python REPL folds ─────────────
  // Lets the loop below skip auto-run on obvious non-shell content (file
  // paths, output lines, raw Python pasted into a bash fence) and combine
  // chained Python REPL input into a single heredoc invocation instead of
  // spawning N zsh processes that each try to parse Python syntax.
  var rawCodes = codeBlocks.map(function(c) { return c.textContent.trim(); });
  var classes  = rawCodes.map(_classifyShellBlock);
  var folds    = _planReplFolds(classes, rawCodes);
  // Mutate the rawCode of any fold-parent so the actual run is a single
  // python3 heredoc covering the whole REPL session.
  Object.keys(folds.foldedExtra).forEach(function(parentKey) {
    var parentIdx = Number(parentKey);
    rawCodes[parentIdx] = _buildPythonHeredoc(folds.foldedExtra[parentIdx]);
  });

  // When auto-exec is on we now run ALL blocks in the response sequentially:
  // the first runnable block is scheduled immediately, every subsequent
  // runnable block is marked pending-chain and started by the previous
  // block's completion handler. Non-shell blocks (and folded children) are
  // skipped — they don't advance the chain counter and they don't auto-run.
  var _autoRunIdx = 0;
  codeBlocks.forEach(function(code, blockIdx) {
    var pre = code.parentElement;
    var rawCode = rawCodes[blockIdx];
    var cls     = classes[blockIdx];
    var foldedParent = folds.foldedInto[blockIdx];
    var hasFoldedChildren = folds.foldedExtra[blockIdx] && folds.foldedExtra[blockIdx].length > 0;

    // Folded-into-parent: render a thin "absorbed" notice and skip auto-run.
    if (foldedParent !== undefined) {
      var foldEl = document.createElement('div');
      foldEl.className = 'shell-empty-warning shell-fold-notice';
      foldEl.innerHTML =
        '<div class="shell-empty-warning-header">' +
          '<i class="ti ti-arrow-merge"></i>' +
          '<span>Folded into the ' + (cls.lang === 'python' ? 'Python' : 'REPL') +
          ' session above (block #' + (foldedParent + 1) + ').</span>' +
        '</div>' +
        '<div class="shell-empty-warning-body"><code>' + escHtml(rawCode.slice(0, 200)) + '</code></div>';
      pre.parentNode.replaceChild(foldEl, pre);
      return;
    }
    // Non-shell content: render the block but suppress auto-run + chain.
    var classifySkip = (cls.kind === 'interpreter-input' || cls.kind === 'bare-path' || cls.kind === 'literal');
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
    // Non-shell content (interpreter input, bare paths, output text) is never
    // eligible — it would just emit nonsense errors and feed them back to the
    // model in a loop.
    var eligible = !noAutoRun && state.autoRunShell && depth < DEPTH_LIMIT && !classifySkip;
    var autoRun = eligible && _autoRunIdx === 0;
    var chainPending = eligible && _autoRunIdx > 0;
    var depthLimited = !noAutoRun && state.autoRunShell && depth >= DEPTH_LIMIT && !classifySkip;
    var suppressedAutoRun = !!noAutoRun && state.autoRunShell && !classifySkip;
    if (eligible) _autoRunIdx++;
    if (hasFoldedChildren) {
      dbg('  ↳ block: ' + rawCode.slice(0,60) + ' (Python REPL fold: ' + folds.foldedExtra[blockIdx].length + ' pieces) autoRun=' + autoRun + ' chain=' + chainPending, 'cmd');
    } else {
      dbg('  ↳ block: ' + rawCode.slice(0,60) + ' autoRun=' + autoRun + ' chain=' + chainPending + ' depth=' + depth + (classifySkip ? ' classified=' + cls.kind : ''), 'cmd');
    }

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
        (classifySkip ? '<span class="shell-exec-autorun-badge" title="Auto-run skipped — block does not look like a shell command. Click Run to force-execute." style="background:var(--fau-surface2);color:var(--fau-text-dim)">not a shell command</span>' : '') +
        (hasFoldedChildren ? '<span class="shell-exec-autorun-badge" title="This block runs as one Python session with the folded follow-up blocks." style="background:var(--fau-surface2);color:var(--fau-text-dim)">python session</span>' : '') +
        '<div class="shell-exec-btns">' +
          '<button class="shell-exec-run" id="' + execId + '-run" ' +
            'onclick="runShellExec(\'' + execId + '\')"><i class="ti ti-player-play"></i> Run</button>' +
          '<button class="shell-exec-feed" id="' + execId + '-feed" ' +
            'onclick="feedShellResultToAI(\'' + execId + '\')"><i class="ti ti-arrow-right"></i> Feed to AI</button>' +
        '</div>' +
      '</div>' +
      '<div class="shell-exec-code">' + escHtml(rawCode) + '</div>' +
      '<div class="shell-exec-result" id="' + execId + '-result"' + (depthLimited || chainPending || suppressedAutoRun || classifySkip ? '' : ' style="display:none"') + '>' +
        (depthLimited ? '<span class="se-meta">Auto-run paused after ' + DEPTH_LIMIT + ' steps — click Run to continue.</span>' : '') +
        (chainPending ? '<span class="se-meta">Queued — will run automatically after the previous command.</span>' : '') +
        (suppressedAutoRun ? '<span class="se-meta">Auto-run paused — the previous step looked like a malformed write-file repair. Click <b>Run</b> to execute this command, or have Fauna retry with file-plan / append-file / replace-string instead.</span>' : '') +
        (classifySkip ? _classifySkipNoticeHtml(cls) : '') +
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
// send button stays enabled. Clicking it opens the topbar dev-server widget.
function _devServerPillKey(code, convId) {
  return (convId || '') + '|' + String(code || '')
    .replace(/\bPATH=(?:"[^"]*"|'[^']*'|\S+)\s+/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

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
  var targetConvId = convId || (typeof state !== 'undefined' ? (state.currentId || '') : '');
  var serverKey = _devServerPillKey(code, targetConvId);
  var matchingPill = Array.from(container.children).find(function(candidate) {
    return candidate.dataset.serverKey === serverKey;
  });
  if (matchingPill) {
    var matchingIds;
    try { matchingIds = JSON.parse(matchingPill.dataset.regIds || '[]'); } catch (_) { matchingIds = []; }
    if (regId && matchingIds.indexOf(String(regId)) < 0) matchingIds.push(String(regId));
    matchingPill.dataset.regIds = JSON.stringify(matchingIds);
    matchingPill.dataset.regId = regId || matchingPill.dataset.regId || '';
    matchingPill.onclick = function() { openDevServerPill(matchingPill.dataset.regId); };
    syncDevServerPills();
    return;
  }

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
  pill.dataset.convId = targetConvId;
  pill.dataset.regId = regId || '';
  pill.dataset.regIds = JSON.stringify(regId ? [String(regId)] : []);
  pill.dataset.serverKey = serverKey;
  pill.title = 'Dev server running — click to open in the browser pane';
  pill.innerHTML =
    '<i class="ti ti-server-bolt"></i>' +
    '<span class="pill-label">' + escHtml(label) + '</span>' +
    '<i class="ti ti-external-link" style="opacity:.65;font-size:11px"></i>' +
    '<button class="dev-server-stop" type="button" title="Stop dev server" aria-label="Stop ' + escHtml(label) + '" ' +
      'onclick="stopDevServerPill(event,this.closest(\'.dev-server-pill\'))">' +
      '<i class="ti ti-player-stop-filled"></i>' +
    '</button>';
  pill.onclick = function() {
    openDevServerPill(regId);
  };
  container.appendChild(pill);
  syncDevServerPills();
}

async function stopDevServerPill(event, pill) {
  if (event) {
    event.preventDefault();
    event.stopPropagation();
  }
  if (!pill || pill.dataset.stopping === '1') return;
  var ids;
  try { ids = JSON.parse(pill.dataset.regIds || '[]'); } catch (_) { ids = []; }
  if (!ids.length && pill.dataset.regId) ids = [pill.dataset.regId];
  ids = Array.from(new Set(ids.map(String).filter(Boolean)));
  if (!ids.length) return;

  pill.dataset.stopping = '1';
  pill.classList.add('stopping');
  var button = pill.querySelector('.dev-server-stop');
  if (button) button.disabled = true;
  try {
    var results = await Promise.all(ids.map(async function(id) {
      var response = await fetch('/api/dev-servers/' + encodeURIComponent(id) + '/kill', { method: 'POST' });
      var result = await response.json();
      if (!response.ok || !result.ok) throw new Error(result.error || 'stop failed');
      return result;
    }));
    if (results.length) {
      pill.remove();
      syncDevServerPills();
      if (typeof _showToast === 'function') _showToast(results.length > 1 ? 'Stopped dev servers' : 'Stopped dev server');
    }
  } catch (error) {
    pill.dataset.stopping = '0';
    pill.classList.remove('stopping');
    if (button) button.disabled = false;
    if (typeof _showToast === 'function') _showToast('Stop failed: ' + error.message, true);
  }
}

function reconcileDevServerPills(servers) {
  var container = document.getElementById('dev-server-pills');
  if (!container) return;
  var activeIds = new Set((servers || []).filter(function(server) {
    return server && (server.status === 'running' || server.status === 'starting');
  }).map(function(server) { return String(server.id); }));

  Array.from(container.children).forEach(function(pill) {
    var ids;
    try { ids = JSON.parse(pill.dataset.regIds || '[]'); } catch (_) { ids = []; }
    ids = ids.filter(function(id) { return activeIds.has(String(id)); });
    if (!ids.length) {
      pill.remove();
      return;
    }
    pill.dataset.regIds = JSON.stringify(ids);
    pill.dataset.regId = ids[ids.length - 1];
    pill.onclick = function() { openDevServerPill(pill.dataset.regId); };
  });
  syncDevServerPills();
}

// Click handler for a dev-server pill. The port is sniffed asynchronously by
// the server registry, so it may not be known at pill-creation time — we look
// it up live from /api/dev-servers and open the URL in the in-app browser
// pane. If no port is known yet (server still booting) we fall back to the
// topbar dev-server manager.
function openDevServerPill(regId) {
  var openManager = function() {
    try {
      if (typeof switchPage === 'function') switchPage('settings');
      setTimeout(function() {
        var nav = document.querySelector('[data-page="dev-servers"]');
        if (nav && typeof nav.click === 'function') nav.click();
      }, 50);
    } catch (_) {}
  };
  if (!regId) { openManager(); return; }
  fetch('/api/dev-servers')
    .then(function(r) { return r.json(); })
    .then(function(d) {
      var servers = (d && d.servers) || [];
      var entry = null;
      for (var i = 0; i < servers.length; i++) {
        if (servers[i] && String(servers[i].id) === String(regId)) { entry = servers[i]; break; }
      }
      if (entry && entry.port) {
        var url = 'http://localhost:' + entry.port;
        if (typeof openRunInBrowser === 'function') openRunInBrowser(url);
        else window.open(url, '_blank');
      } else {
        openManager();
      }
    })
    .catch(function() { openManager(); });
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
    var exitCode = null;
    var errMsg = '';
    var devServerStatus = null;
    var devServerVerified = false;

    if (jsonCompleted) {
      stdoutBuf = jsonCompleted.stdout || '';
      stderrBuf = jsonCompleted.stderr || '';
      exitCode = jsonCompleted.exitCode != null ? jsonCompleted.exitCode : (jsonCompleted.ok ? 0 : 1);
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
            exitCode = sseEvt.exitCode == null ? null : sseEvt.exitCode;
            if (sseEvt.detached) {
              // Dev server was registered and the stream was closed. Keep the
              // widget in a "started" state without leaving it pinned to the
              // input bar as a blocking running pill.
              widget.dataset.devServer = '1';
              if (!stdoutBuf && !stderrBuf) {
                stdoutBuf = 'Dev server started in background. Manage it from the Running dev servers indicator.';
              }
            }
            _removeShellInput(execId);
          } else if (sseEvt.type === 'dev_server_detached') {
            widget.dataset.devServer = '1';
            widget.dataset.devServerId = sseEvt.id || '';
            widget.dataset.devServerStatus = sseEvt.status || 'starting';
            devServerStatus = sseEvt.status || 'starting';
            devServerVerified = sseEvt.verified === true;
            stdoutBuf = (stdoutBuf ? stdoutBuf + '\n' : '') + (sseEvt.message || 'Dev server readiness is unverified.');
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
      cwd: bodyObj.cwd || '',
      devServerStatus: devServerStatus,
      devServerVerified: devServerVerified
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
    if (d.devServerStatus && d.exitCode == null) {
      parts.push('<span class="se-meta">status ' + escHtml(d.devServerStatus) + ' (readiness unverified)</span>');
    } else if (!d.stdout && !d.stderr && !d.error) {
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
    var resumedBrowserActions = false;
    if (typeof runDeferredBrowserActionsForMessage === 'function') {
      resumedBrowserActions = runDeferredBrowserActionsForMessage(widget.closest('.msg'));
    }

    // Auto-feed output back to AI always when autoFeed is set —
    // the AI needs to know about empty results and failures, not just successes
    if (opts.autoFeed && !resumedBrowserActions) {
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
  if (d.devServerStatus && d.exitCode == null) {
    lines.push('status ' + d.devServerStatus + ' (readiness unverified)');
  } else {
    lines.push('exit ' + d.exitCode);
  }
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

