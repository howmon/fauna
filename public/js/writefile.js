// ── Write-file block: direct file write without shell ────────────────────

function extractAndRenderWriteFile(messageEl, isHistoryLoad, convId) {
  var container = messageEl.querySelector('.prose') || messageEl;
  var codeBlocks = container.querySelectorAll('code.language-write-file');
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

    function addActiveAgentContext(body) {
      if (typeof isAgentActive === 'function' && isAgentActive()) {
        body.agentName = typeof getActiveAgentName === 'function' ? getActiveAgentName() : undefined;
        body.permissions = typeof getActiveAgentPermissions === 'function' ? getActiveAgentPermissions() : undefined;
      }
      return body;
    }

    // Resolve relative paths against conversation CWD (write-file / append-file only)
    var wid = convId || state.currentId || '';
    if (!isReplace && !isPatch && filePath && !filePath.startsWith('/') && !filePath.startsWith('~')) {
      var cwd = _convCwd[wid];
      
      // Priority: 1) conversation CWD, 2) active project rootPath, 3) user default save path, 4) workspace folder
      if (!cwd && typeof _activeProject === 'function') {
        var activeProj = _activeProject();
        if (activeProj && activeProj.rootPath) {
          cwd = activeProj.rootPath;
          dbg('write-file: using active project rootPath: ' + cwd, 'info');
        }
      }
      
      if (!cwd && state.defaultSavePath) {
        cwd = state.defaultSavePath;
        dbg('write-file: using default save path: ' + cwd, 'info');
      }
      
      filePath = cwd ? cwd.replace(/\/$/, '') + '/' + filePath
                     : '~/.fauna/workspaces/' + wid + '/' + filePath;
    }

    var widgetId  = storeId || ('wf-' + Date.now() + '-' + Math.random().toString(36).slice(2));
    var shortPath = filePath.length > 60 ? '…' + filePath.slice(-57) : filePath;
    var lines     = content ? content.split('\n').length : 0;
    var preview   = (content || '').slice(0, 300);

    // ── icon / label / colours per mode ───────────────────────────────────
    var iconClass, modeLabel, modeColor, pendingMsg;
    if (isReplace) {
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

    if (isHistoryLoad) {
      widget.className = 'wf-block done';
      var statusEl = widget.querySelector('.wf-status');
      if (statusEl) statusEl.textContent = lines + ' lines';
      return;
    }

    // ── execute ────────────────────────────────────────────────────────────
    var promise;

    if (isReplace) {
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
        var statusEl = document.getElementById(widgetId + '-status');
        widget.className = 'wf-block done';
        statusEl.textContent = 'replaced';
        dbg('replace-string: patched → ' + d.path, 'ok');
        if (storeId) delete _wfContentStore[storeId];
        trackConvFile(wid, d.path, d.bytes);
      });

    } else if (isPatch) {
      promise = fetch('/api/apply-patch', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(addActiveAgentContext({ path: filePath, patch: content, cwd: _convCwd[wid] || undefined }))
      }).then(function(r) { return r.json(); }).then(function(d) {
        if (!d.ok) throw new Error(d.error || 'patch failed');
        var statusEl = document.getElementById(widgetId + '-status');
        widget.className = 'wf-block done';
        var n = d.results ? d.results.length : 0;
        statusEl.textContent = n + ' file' + (n !== 1 ? 's' : '') + ' patched';
        dbg('apply-patch: ' + n + ' file(s) patched', 'ok');
        if (storeId) delete _wfContentStore[storeId];
        if (d.results) d.results.forEach(function(r) { if (r.op !== 'delete') trackConvFile(wid, r.path, r.bytes); });
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
        var statusEl = document.getElementById(widgetId + '-status');
        widget.className = 'wf-block done';
        statusEl.textContent = (d.bytes / 1024).toFixed(1) + ' KB ' + (isAppend ? 'total' : 'written');
        dbg('write-file: ' + (isAppend ? 'appended' : 'wrote') + ' → ' + d.path, 'ok');
        if (storeId) delete _wfContentStore[storeId];
        trackConvFile(wid, d.path, d.bytes);
        if (!isAppend) validateWrittenFile(d.path, content || '', widget);
      });
    }

    promise.catch(function(e) {
      widget.className = 'wf-block err';
      var statusEl = document.getElementById(widgetId + '-status');
      if (statusEl) statusEl.textContent = 'Error: ' + e.message;
      dbg((isReplace ? 'replace-string' : isPatch ? 'apply-patch' : 'write-file') + ' error: ' + e.message, 'err');
    });
  });
}

// ── Post-write file validation — catches truncated/broken files early ─────────
// Validates JS/TS files with `node --check`, HTML by closing tag, CSS by braces.
// On failure, auto-feeds the error back to the AI so it can self-correct.

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
      }
    }).catch(function() {});

  } else if (ext === 'html') {
    if (!content.includes('</html>') && !content.includes('</body>')) {
      markWriteFileFailed(widget, filePath, 'HTML appears truncated — missing closing </html> tag', convId);
    }

  } else if (ext === 'css') {
    var open = (content.match(/\{/g) || []).length;
    var close = (content.match(/\}/g) || []).length;
    if (open !== close) {
      markWriteFileFailed(widget, filePath,
        'CSS has unbalanced braces (' + open + ' open, ' + close + ' close) — likely truncated', convId);
    }

  } else if (ext === 'md' || ext === 'markdown') {
    // Check for unclosed code blocks
    var codeBlockMarkers = (content.match(/```/g) || []).length;
    if (codeBlockMarkers % 2 !== 0) {
      markWriteFileFailed(widget, filePath,
        'Markdown has unclosed code block (``` count: ' + codeBlockMarkers + ') — likely truncated', convId);
      return;
    }
    
    // Check for common truncation indicators
    var trimmed = content.trimEnd();
    var lastLine = trimmed.split('\n').pop() || '';
    
    // Red flags: ends with incomplete sentence/word
    if (trimmed.length > 100) {
      // Ends mid-word (lowercase letter without punctuation)
      if (lastLine.match(/[a-z]$/) && !lastLine.match(/[.!?:;)\]}>]$/)) {
        markWriteFileFailed(widget, filePath,
          'Markdown ends mid-sentence or mid-word — likely truncated. Last line: "' + lastLine.slice(-50) + '"', convId);
        return;
      }
      
      // Ends with unfinished markdown syntax (but NOT diagram elements)
      // Allow: lines of dashes/equals (------, ======) used in diagrams or heading underlines
      // Reject: single dash/asterisk with whitespace (- , * )
      var isDiagramLine = lastLine.match(/^[-=|+\/\\]{3,}$/);
      if (!isDiagramLine && lastLine.match(/^#+\s*$|^\s*[-*]\s*$|^\s*\d+\.\s*$/)) {
        markWriteFileFailed(widget, filePath,
          'Markdown ends with unfinished heading/list marker — likely truncated', convId);
        return;
      }
    }
    
    // Check for suspiciously short "strategy" or "document" files (< 500 bytes)
    if (content.length < 500 && (filePath.match(/strategy|document|report|plan/i))) {
      markWriteFileFailed(widget, filePath,
        'File appears suspiciously short (' + content.length + ' bytes) for a ' + filePath.match(/strategy|document|report|plan/i)[0] + ' — likely incomplete', convId);
      return;
    }

  } else if (ext === 'json') {
    // Quick JSON validation for truncation
    try {
      JSON.parse(content);
    } catch (e) {
      var errorMsg = e.message || 'JSON parse error';
      if (errorMsg.includes('Unexpected end') || errorMsg.includes('Unexpected token')) {
        markWriteFileFailed(widget, filePath, 'JSON is invalid or truncated: ' + errorMsg, convId);
      }
    }
  }
}

function markWriteFileFailed(widget, filePath, errorMsg, convId) {
  widget.className = 'wf-block err';
  var statusEl = widget.querySelector('.wf-status');
  if (statusEl) statusEl.textContent = 'invalid — feeding error to AI';
  dbg('write-file validation failed [' + filePath + ']: ' + errorMsg, 'err');

  var targetConv = getConv(convId);
  if (!targetConv || (targetConv._autoFeedDepth || 0) >= 3) return;
  targetConv._autoFeedDepth = (targetConv._autoFeedDepth || 0) + 1;

  var msg = 'The file I just wrote has an error:\n\n**File:** `' + filePath + '`\n**Error:**\n```\n' + errorMsg +
    '\n```\n\n' +
    '**DO NOT rewrite the whole file.** Fix it with a targeted edit:\n' +
    '- If the file was truncated (missing closing tags/braces): use `append-file` to add only the missing tail.\n' +
    '- If there is a syntax error in a specific function: use `replace-string` to fix just that section.\n' +
    'Read the file first with the read-file API if needed, then apply the minimal fix.';
  setTimeout(function() {
    sendDirectMessage(msg, { fromAutoFeed: true, isAutoFeed: true, isWriteFileFeed: true, targetConvId: convId });
  }, 800);
}

