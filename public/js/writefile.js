// ── Write-file block: direct file write without shell ────────────────────

function extractAndRenderWriteFile(messageEl, isHistoryLoad, convId) {
  var container = messageEl.querySelector('.prose') || messageEl;
  var codeBlocks = container.querySelectorAll('code.language-write-file, code.language-file-plan');
  if (!codeBlocks.length) return;
  dbg('extractAndRenderWriteFile: found ' + codeBlocks.length + ' block(s)', 'info');
  codeBlocks.forEach(function(code) {
    var pre = code.parentElement;

    var storeId  = code.dataset.wfId   || '';
    var filePath = code.dataset.wfPath || '';
    var stored   = storeId ? _wfContentStore[storeId] : null;

    // Guard: storeId present but store entry missing means the content was lost
    // (e.g. page reload cleared _wfContentStore). Show error instead of writing empty file.
    if (storeId && !stored && !code.textContent.trim()) {
      dbg('write-file: store entry missing for id=' + storeId + ' — skipping to avoid empty write', 'err');
      var widget2 = document.createElement('div');
      widget2.className = 'wf-block err';
      widget2.innerHTML = '<div class="wf-header"><i class="ti ti-file-x"></i>' +
        '<span class="wf-path">write-file</span>' +
        '<span class="wf-status">Error: content store missing — refresh and retry</span></div>';
      code.closest('pre').replaceWith(widget2);
      return;
    }

    var content  = stored ? stored.content : code.textContent;
    var mode     = (stored && stored.mode) || 'write-file';
    if (!stored) filePath = filePath || code.dataset.wfPath || '';
    else         filePath = stored.path || filePath;

    if (!filePath) { dbg('write-file: missing path', 'warn'); return; }

    var isAppend  = mode === 'append-file';
    var isReplace = mode === 'replace-string';
    var isPatch   = mode === 'apply-patch';
    var isPlan    = mode === 'file-plan' || code.classList.contains('language-file-plan');

    function addActiveAgentContext(body) {
      if (typeof isAgentActive === 'function' && isAgentActive()) {
        body.agentName = typeof getActiveAgentName === 'function' ? getActiveAgentName() : undefined;
        body.permissions = typeof getActiveAgentPermissions === 'function' ? getActiveAgentPermissions() : undefined;
      }
      return body;
    }

    function getWriteCwd() {
      var cwd = _convCwd[wid];
      if (!cwd && typeof _activeProject === 'function') {
        var activeProj = _activeProject();
        if (activeProj && activeProj.rootPath) cwd = activeProj.rootPath;
      }
      if (!cwd && state.defaultSavePath) cwd = state.defaultSavePath;
      return cwd;
    }

    // Resolve relative paths against conversation CWD (write-file / append-file only)
    var wid = convId || state.currentId || '';
    if (!isReplace && !isPatch && !isPlan && filePath && !filePath.startsWith('/') && !filePath.startsWith('~')) {
      var cwd = getWriteCwd();
      filePath = cwd ? cwd.replace(/\/$/, '') + '/' + filePath
                     : '~/.fauna/workspaces/' + wid + '/' + filePath;
    }

    var widgetId  = storeId || ('wf-' + Date.now() + '-' + Math.random().toString(36).slice(2));
    var shortPath = isPlan ? 'workspace file plan' : (filePath.length > 60 ? '…' + filePath.slice(-57) : filePath);
    var lines     = content ? content.split('\n').length : 0;
    var preview   = (content || '').slice(0, 300);

    // ── icon / label / colours per mode ───────────────────────────────────
    var iconClass, modeLabel, modeColor, pendingMsg;
    if (isPlan) {
      iconClass  = 'ti-files';
      modeLabel  = 'plan';
      modeColor  = '#60a5fa';
      pendingMsg = '⏳ Applying plan…';
    } else if (isReplace) {
      iconClass  = 'ti-replace';
      modeLabel  = 'replace';
      modeColor  = '#fbbf24';   // amber
      pendingMsg = '⏳ Replacing…';
    } else if (isPatch) {
      iconClass  = 'ti-git-merge';
      modeLabel  = 'patch';
      modeColor  = '#fb923c';   // orange
      pendingMsg = '⏳ Patching…';
      shortPath  = 'apply-patch';
    } else if (isAppend) {
      iconClass  = 'ti-file-plus';
      modeLabel  = 'append';
      modeColor  = '#a78bfa';   // purple
      pendingMsg = '⏳ Appending…';
    } else {
      iconClass  = 'ti-file-arrow-up';
      modeLabel  = '';
      modeColor  = '';
      pendingMsg = '⏳ Writing…';
    }

    var widget = document.createElement('div');
    widget.className = 'wf-block writing';
    widget.id = widgetId;
    widget.dataset.convId = wid;
    widget.innerHTML =
      '<div class="wf-header">' +
        '<i class="ti ' + iconClass + '"></i>' +
        (modeLabel ? '<span style="font-size:10px;color:' + modeColor + ';margin-right:4px">' + modeLabel + '</span>' : '') +
        '<span class="wf-path" title="' + escHtml(filePath) + '">' + escHtml(shortPath) + '</span>' +
        '<span class="wf-status" id="' + widgetId + '-status">' + pendingMsg + '</span>' +
      '</div>' +
      '<div class="wf-preview">' + escHtml(preview) + ((content||'').length > 300 ? '\n…' : '') + '</div>';
    pre.parentNode.replaceChild(widget, pre);

    function updateWriteFileStatus(className, text) {
      if (!widget.isConnected) return false;
      widget.className = className;
      var statusEl = widget.querySelector('.wf-status') || document.getElementById(widgetId + '-status');
      if (statusEl) statusEl.textContent = text;
      return true;
    }

    if (isHistoryLoad) {
      updateWriteFileStatus('wf-block done', isPlan ? 'file plan' : lines + ' lines');
      return;
    }

    // ── execute ────────────────────────────────────────────────────────────
    var promise;

    if (isPlan) {
      var plan;
      try {
        plan = JSON.parse(content || '{}');
      } catch (parseErr) {
        updateWriteFileStatus('wf-block err', 'Invalid file plan JSON: ' + parseErr.message);
        return;
      }
      if (!plan || !Array.isArray(plan.files) || !plan.files.length) {
        updateWriteFileStatus('wf-block err', 'Invalid file plan: files array required');
        return;
      }
      var planCwd = plan.cwd || getWriteCwd() || undefined;
      var planBody = addActiveAgentContext(Object.assign({}, plan, { cwd: planCwd }));
      promise = fetch('/api/write-files', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(planBody)
      }).then(function(r) { return r.json(); }).then(function(d) {
        if (!d.ok) throw new Error(d.error || 'file plan failed');
        var results = d.results || [];
        var written = results.filter(function(r) { return r.op !== 'skip'; });
        updateWriteFileStatus('wf-block done', written.length + ' file' + (written.length === 1 ? '' : 's') + ' written atomically');
        dbg('file-plan: ' + written.length + ' file(s) written', 'ok');
        if (storeId) delete _wfContentStore[storeId];
        results.forEach(function(r) { if (r.op !== 'skip') trackConvFile(wid, r.path, r.bytes); });
        clearWriteRepairMode(wid);
      });

    } else if (isReplace) {
      // Parse SEARCH/REPLACE format
      var sepIdx = content.indexOf('=======');
      var searchBlock = content.indexOf('<<<<<<< SEARCH\n');
      var replaceBlock = content.indexOf('>>>>>>> REPLACE');
      var oldStr, newStr;
      if (searchBlock !== -1 && sepIdx !== -1 && replaceBlock !== -1) {
        oldStr = content.slice(searchBlock + '<<<<<<< SEARCH\n'.length, sepIdx).replace(/\n$/, '');
        newStr = content.slice(sepIdx + '=======\n'.length, replaceBlock).replace(/\n$/, '');
      } else if (sepIdx !== -1) {
        // Fallback: no SEARCH/REPLACE markers, just two halves split by =======
        oldStr = content.slice(0, sepIdx).trim();
        newStr = content.slice(sepIdx + 7).trim();
      } else {
        oldStr = content; newStr = '';
      }
      promise = fetch('/api/replace-string', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(addActiveAgentContext({ path: filePath, old_string: oldStr, new_string: newStr, cwd: _convCwd[wid] || undefined }))
      }).then(function(r) { return r.json(); }).then(function(d) {
        if (!d.ok) throw new Error(d.error || 'replace failed');
        updateWriteFileStatus('wf-block done', 'replaced');
        dbg('replace-string: patched → ' + d.path, 'ok');
        if (storeId) delete _wfContentStore[storeId];
        trackConvFile(wid, d.path, d.bytes);
        clearWriteRepairMode(wid);
      });

    } else if (isPatch) {
      promise = fetch('/api/apply-patch', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(addActiveAgentContext({ path: filePath, patch: content, cwd: _convCwd[wid] || undefined }))
      }).then(function(r) { return r.json(); }).then(function(d) {
        if (!d.ok) throw new Error(d.error || 'patch failed');
        var n = d.results ? d.results.length : 0;
        updateWriteFileStatus('wf-block done', n + ' file' + (n !== 1 ? 's' : '') + ' patched');
        dbg('apply-patch: ' + n + ' file(s) patched', 'ok');
        if (storeId) delete _wfContentStore[storeId];
        if (d.results) d.results.forEach(function(r) { if (r.op !== 'delete') trackConvFile(wid, r.path, r.bytes); });
        clearWriteRepairMode(wid);
      });

    } else {
      var apiUrl = isAppend ? '/api/append-file' : '/api/write-file';
      var writeBody = addActiveAgentContext({ path: filePath, content: content || '', cwd: _convCwd[wid] || undefined });
      promise = fetch(apiUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(writeBody)
      }).then(function(r) { return r.json(); }).then(function(d) {
        if (!d.ok) throw new Error(d.error || 'write failed');
        updateWriteFileStatus('wf-block done', (d.bytes / 1024).toFixed(1) + ' KB ' + (isAppend ? 'total' : 'written'));
        dbg('write-file: ' + (isAppend ? 'appended' : 'wrote') + ' → ' + d.path, 'ok');
        if (storeId) delete _wfContentStore[storeId];
        trackConvFile(wid, d.path, d.bytes);
        if (isAppend) validateWrittenFileFromDisk(d.path, widget, wid);
        else validateWrittenFile(d.path, content || '', widget);
        // Inline SVG preview
        var _wfExt = (d.path || filePath).split('.').pop().toLowerCase();
        if (_wfExt === 'svg' && content && !isAppend) _injectWfSvgPreview(widget, content);
      });
    }

    promise.catch(function(e) {
      updateWriteFileStatus('wf-block err', 'Error: ' + e.message);
      dbg((isReplace ? 'replace-string' : isPatch ? 'apply-patch' : 'write-file') + ' error: ' + e.message, 'err');
    });
  });

  // In chain messages (auto-fed responses), hide narration prose — only show the write-file widgets
  if (messageEl.classList.contains('chain-msg') && container) {
    Array.from(container.children).forEach(function(child) {
      if (!child.classList || (!child.classList.contains('wf-block'))) {
        child.style.display = 'none';
      }
    });
    messageEl.classList.add('chain-wf-only');
  }
}

function clearWriteRepairMode(convId) {
  var targetConv = getConv(convId || state.currentId);
  if (!targetConv) return;
  delete targetConv._writeRepairMode;
  delete targetConv._suppressShellAutoRunOnce;
}

function validateWrittenFileFromDisk(filePath, widget, convId) {
  fetch('/api/read-file', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ path: filePath })
  }).then(function(r) { return r.json(); }).then(function(d) {
    if (!d.ok) throw new Error(d.error || 'read failed');
    validateWrittenFile(d.path || filePath, d.content || '', widget);
  }).catch(function(e) {
    markWriteFileFailed(widget, filePath, 'Could not validate final appended file: ' + e.message, convId);
  });
}

// ── Post-write file validation — catches truncated/broken files early ─────────
// Validates JS/TS files with `node --check`, HTML by closing tag, CSS by braces.
// On failure, feed a constrained repair request back to the AI.

function validateWrittenFile(filePath, content, widget) {
  var ext = (filePath.split('.').pop() || '').toLowerCase();
  var convId = widget.dataset.convId || state.currentId;

  if (['js', 'mjs', 'cjs'].includes(ext)) {
    // node --check is fast and definitive for syntax errors
    fetch('/api/shell-exec', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ command: 'node --check ' + JSON.stringify(filePath) })
    }).then(function(r) { return r.json(); }).then(function(d) {
      if (d.exitCode !== 0) {
        var err = (d.stderr || d.stdout || 'Syntax error').trim().slice(0, 600);
        markWriteFileFailed(widget, filePath, err, convId);
      } else {
        clearWriteRepairMode(convId);
      }
    }).catch(function() {});

  } else if (ext === 'html') {
    if (!content.includes('</html>') && !content.includes('</body>')) {
      markWriteFileFailed(widget, filePath, 'HTML appears truncated — missing closing </html> tag', convId);
      return false;
    }
    clearWriteRepairMode(convId);
    return true;

  } else if (ext === 'css') {
    var open = (content.match(/\{/g) || []).length;
    var close = (content.match(/\}/g) || []).length;
    if (open !== close) {
      markWriteFileFailed(widget, filePath,
        'CSS has unbalanced braces (' + open + ' open, ' + close + ' close) — likely truncated', convId);
      return false;
    }
    clearWriteRepairMode(convId);
    return true;

  } else if (ext === 'md' || ext === 'markdown') {
    // Check for unclosed code blocks
    var codeBlockMarkers = (content.match(/```/g) || []).length;
    if (codeBlockMarkers % 2 !== 0) {
      markWriteFileFailed(widget, filePath,
        'Markdown has unclosed code block (``` count: ' + codeBlockMarkers + ') — likely truncated', convId);
      return false;
    }
    
    // Check for common truncation indicators
    var trimmed = content.trimEnd();
    var lastLine = trimmed.split('\n').pop() || '';

    function looksLikeCompleteMarkdownEnding(line) {
      var s = String(line || '').trim();
      if (!s) return true;
      if (/[.!?:;)\]}>]$/.test(s)) return true;
      if (/https?:\/\/|www\.|github\.com|linkedin\.com|mailto:|@/.test(s)) return true;
      if (/^\|.*\|$/.test(s)) return true;
      if (/^#{1,6}\s+\S/.test(s)) return true;
      if (/^[-*+]\s+\S/.test(s)) return true;
      if (/^\d+\.\s+\S/.test(s)) return true;
      if (/[·|•,]\s*[^·|•,]+$/.test(s)) return true;
      if (/\b(mentorship|leveling|leadership|strategy|planning|architecture|research|design|engineering|deepmind|resume|portfolio)$/i.test(s)) return true;
      return false;
    }

    function looksLikeDanglingMarkdownEnding(line) {
      var s = String(line || '').trim();
      if (!s) return false;
      if (/[`*_\[({<]$/.test(s)) return true;
      if (/\b(and|or|the|a|an|to|of|for|with|in|on|at|by|from|as|into|through|while|because|including|using)$/i.test(s)) return true;
      if (/[,;:]$/.test(s)) return true;
      return /[a-z]$/.test(s) && !looksLikeCompleteMarkdownEnding(s) && s.split(/\s+/).length >= 8;
    }
    
    // Red flags: dangling syntax or an obviously incomplete trailing phrase.
    if (trimmed.length > 100) {
      if (looksLikeDanglingMarkdownEnding(lastLine)) {
        markWriteFileFailed(widget, filePath,
          'Markdown ends mid-sentence or mid-word — likely truncated. Last line: "' + lastLine.slice(-50) + '"', convId);
        return false;
      }
      
      // Ends with unfinished markdown syntax (but NOT diagram elements)
      // Allow: lines of dashes/equals (------, ======) used in diagrams or heading underlines
      // Reject: single dash/asterisk with whitespace (- , * )
      var isDiagramLine = lastLine.match(/^[-=|+\/\\]{3,}$/);
      if (!isDiagramLine && lastLine.match(/^#+\s*$|^\s*[-*]\s*$|^\s*\d+\.\s*$/)) {
        markWriteFileFailed(widget, filePath,
          'Markdown ends with unfinished heading/list marker — likely truncated', convId);
        return false;
      }
    }
    
    // Check for suspiciously short "strategy" or "document" files (< 500 bytes)
    if (content.length < 500 && (filePath.match(/strategy|document|report|plan/i))) {
      markWriteFileFailed(widget, filePath,
        'File appears suspiciously short (' + content.length + ' bytes) for a ' + filePath.match(/strategy|document|report|plan/i)[0] + ' — likely incomplete', convId);
      return false;
    }
    clearWriteRepairMode(convId);
    return true;

  } else if (ext === 'json') {
    // Quick JSON validation for truncation
    try {
      JSON.parse(content);
    } catch (e) {
      var errorMsg = e.message || 'JSON parse error';
      if (errorMsg.includes('Unexpected end') || errorMsg.includes('Unexpected token')) {
        markWriteFileFailed(widget, filePath, 'JSON is invalid or truncated: ' + errorMsg, convId);
        return false;
      }
    }
    clearWriteRepairMode(convId);
    return true;
  }
  clearWriteRepairMode(convId);
  return true;
}

function _injectWfSvgPreview(widget, svgContent) {
  // Strip script/event-handler content for safety
  var safe = svgContent.replace(/<script[\s\S]*?<\/script>/gi, '')
                       .replace(/\son\w+\s*=\s*["'][^"']*["']/gi, '');
  var preview = document.createElement('div');
  preview.className = 'wf-svg-preview';
  preview.innerHTML = safe;
  var svgEl = preview.querySelector('svg');
  if (svgEl) {
    // Remove fixed dimensions so it scales with the container
    svgEl.removeAttribute('width');
    svgEl.removeAttribute('height');
  }
  widget.appendChild(preview);
}

function markWriteFileFailed(widget, filePath, errorMsg, convId) {
  widget.className = 'wf-block err';
  var statusEl = widget.querySelector('.wf-status');
  if (statusEl) statusEl.textContent = 'invalid — queued structured repair';
  dbg('write-file validation failed [' + filePath + ']: ' + errorMsg, 'err');

  var targetConv = getConv(convId);
  if (!targetConv) return;
  targetConv._writeRepairMode = true;
  targetConv._suppressShellAutoRunOnce = true;
  if (typeof cancelShellAutoRunsForMessage === 'function') {
    cancelShellAutoRunsForMessage(widget.closest('.msg'), 'write-file validation failed');
  }
  if ((targetConv._autoFeedDepth || 0) >= 3) return;
  targetConv._autoFeedDepth = (targetConv._autoFeedDepth || 0) + 1;

  var isLikelyTruncation = /truncated|unclosed|unexpected end|missing closing|mid-sentence|mid-word|unfinished|too short|incomplete/i.test(errorMsg || '');
  var msg = 'The file write validation failed. Repair it using structured file operations only.\n\n' +
    '**File:** `' + filePath + '`\n**Error:**\n```\n' + errorMsg + '\n```\n\n' +
    '**Rules for the repair response:**\n' +
    '- Do NOT emit `shell-exec`, bash, zsh, Python, `cat`, heredocs, or other shell commands.\n' +
    '- Do NOT narrate a backup/recreate plan. Output the actual structured fix.\n' +
    '- Prefer one `file-plan` block for a complete corrected final file, with `expected_file_count`, `minLines`, and `minBytes`.\n' +
    '- For a tiny known missing tail, `append-file` is allowed, but only append the missing tail.\n' +
    '- For localized syntax mistakes, use `replace-string`.\n' +
    (isLikelyTruncation ? '- Because this looks truncated, use `file-plan` unless you know the exact missing tail.\n' : '') +
    'If you need the current content, ask to read the file first; do not run shell commands.';
  setTimeout(function() {
    sendDirectMessage(msg, { fromAutoFeed: true, isAutoFeed: true, isWriteFileFeed: true, suppressShellAutoRun: true, targetConvId: convId });
  }, 800);
}

