// ── Write-file block: direct file write without shell ────────────────────

function _wfFileName(filePath) {
  return String(filePath || '').split(/[\\/]/).pop() || String(filePath || 'File');
}

function _wfArtifactType(filePath) {
  var ext = (_wfFileName(filePath).split('.').pop() || '').toLowerCase();
  if (ext === 'md' || ext === 'markdown') return 'markdown';
  if (ext === 'json') return 'json';
  if (ext === 'csv') return 'csv';
  if (ext === 'html' || ext === 'htm') return 'html';
  if (ext === 'svg') return 'svg';
  if (ext === 'pdf') return 'pdf';
  if (['doc', 'docx', 'rtf', 'odt', 'pages'].includes(ext)) return 'docx';
  if (['js','mjs','cjs','ts','tsx','jsx','py','rb','go','rs','java','cs','php','sh','zsh','bash','css','xml','yaml','yml'].includes(ext)) return 'code';
  return 'text';
}

function _wfArtifactContainer(widget) {
  var body = widget && widget.closest ? widget.closest('.msg-body') : null;
  var host = body || widget;
  if (!host) return null;
  var container = host.querySelector(':scope > .wf-created-artifacts');
  if (!container) {
    container = document.createElement('div');
    container.className = 'wf-created-artifacts';
    host.appendChild(container);
  } else if (body) {
    body.appendChild(container);
  }
  return container;
}

function _wfAddCreatedFileArtifact(widget, filePath, content, opts) {
  opts = opts || {};
  if (!widget || !filePath || typeof addArtifact !== 'function' || typeof injectArtifactCard !== 'function') return null;
  var startedAt = (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now();
  var type = opts.type || _wfArtifactType(filePath);
  var title = opts.title || _wfFileName(filePath);
  var artifact = { type: type, title: title, path: filePath };
  if (content != null && type !== 'pdf') artifact.content = content;
  var id = addArtifact(artifact);
  var container = _wfArtifactContainer(widget);
  injectArtifactCard(id, container);
  var endedAt = (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now();
  dbg('write-file artifact: id=' + id + ' type=' + type + ' path=' + filePath + ' content=' + (content ? content.length : 0) + 'ch ms=' + (endedAt - startedAt).toFixed(1), 'info');
  return id;
}

function _wfAddCreatedFilesArtifact(widget, files) {
  if (!widget || !files || !files.length || typeof addArtifact !== 'function' || typeof injectArtifactCard !== 'function') return null;
  var paths = files.map(function(f) { return f.path; }).filter(Boolean);
  if (!paths.length) return null;
  var title = paths.length === 1 ? _wfFileName(paths[0]) : paths.length + ' created files';
  var id = addArtifact({ type: 'files', title: title, content: paths.join('\n') });
  injectArtifactCard(id, _wfArtifactContainer(widget));
  dbg('write-file artifact: id=' + id + ' type=files count=' + paths.length + ' paths=' + paths.join(', '), 'info');
  return id;
}

function _wfAddArtifactFromDisk(widget, filePath) {
  if (!filePath || typeof previewFilePath !== 'function') return;
  // Prefer the artifact pane's existing file previewer when final content must be read from disk.
  var row = document.createElement('div');
  row.className = 'wf-created-file-action';
  row.innerHTML = '<button class="artifact-card-open wf-open-created" type="button"><i class="ti ti-eye"></i> View created file</button>';
  var btn = row.querySelector('button');
  btn.onclick = function() { previewFilePath(filePath); };
  var container = _wfArtifactContainer(widget);
  if (container) container.appendChild(row);
}

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

    function historyStatusText() {
      if (isPlan) {
        try {
          var plan = JSON.parse(content || '{}');
          var count = plan && Array.isArray(plan.files) ? plan.files.length : 0;
          return 'Loaded file plan' + (count ? ' (' + count + ' file' + (count === 1 ? '' : 's') + ')' : '');
        } catch (_) {
          return 'Loaded file plan';
        }
      }
      if (isPatch) return 'Loaded patch (' + lines + ' lines)';
      if (isReplace) return 'Loaded replace edit';
      if (isAppend) return 'Loaded append (' + lines + ' lines)';
      return 'Loaded file write (' + lines + ' lines)';
    }

    if (isHistoryLoad) {
      updateWriteFileStatus('wf-block done', historyStatusText());
      return;
    }

    // ── execute ────────────────────────────────────────────────────────────
    var promise;
    var writeStartedAt = (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now();
    dbg('write-file execute: mode=' + mode + ' path=' + filePath + ' chars=' + (content || '').length + ' lines=' + lines + ' history=' + !!isHistoryLoad, 'cmd');

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
      dbg('file-plan request: files=' + plan.files.length + ' cwd=' + (planCwd || '') + ' expected=' + (plan.expected_file_count || plan.expectedFileCount || ''), 'info');
      promise = fetch('/api/write-files', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(planBody)
      }).then(function(r) { return r.json(); }).then(function(d) {
        if (!d.ok) throw new Error(d.error || 'file plan failed');
        var results = d.results || [];
        var written = results.filter(function(r) { return r.op !== 'skip'; });
        updateWriteFileStatus('wf-block done', written.length + ' file' + (written.length === 1 ? '' : 's') + ' written atomically');
        dbg('file-plan: ' + written.length + ' file(s) written in ' + (((typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now()) - writeStartedAt).toFixed(1) + 'ms results=' + results.map(function(r) { return r.op + ':' + r.path + ':' + r.bytes + 'b'; }).join(', '), 'ok');
        if (storeId) delete _wfContentStore[storeId];
        results.forEach(function(r) { if (r.op !== 'skip') trackConvFile(wid, r.path, r.bytes); });
        if (written.length === 1) {
          var writtenIdx = results.findIndex(function(r) { return r.op !== 'skip'; });
          var sourceItem = writtenIdx >= 0 && plan.files ? plan.files[writtenIdx] : null;
          if (sourceItem && sourceItem.content != null && !sourceItem.append) _wfAddCreatedFileArtifact(widget, written[0].path, String(sourceItem.content));
          else _wfAddArtifactFromDisk(widget, written[0].path);
        } else if (written.length > 1) {
          _wfAddCreatedFilesArtifact(widget, written);
        }
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
        _wfAddArtifactFromDisk(widget, d.path);
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
        var patched = (d.results || []).filter(function(r) { return r.op !== 'delete'; });
        if (patched.length === 1) _wfAddArtifactFromDisk(widget, patched[0].path);
        else if (patched.length > 1) _wfAddCreatedFilesArtifact(widget, patched);
        clearWriteRepairMode(wid);
      });

    } else {
      var apiUrl = isAppend ? '/api/append-file' : '/api/write-file';
      var writeBody = addActiveAgentContext({ path: filePath, content: content || '', cwd: _convCwd[wid] || undefined });
      var useRawStreamWrite = !isAppend && (content || '').length > 256 * 1024;
      if (useRawStreamWrite) {
        var params = new URLSearchParams();
        params.set('path', filePath);
        if (_convCwd[wid]) params.set('cwd', _convCwd[wid]);
        if (writeBody.agentName) params.set('agentName', writeBody.agentName);
        dbg('write-file request: transport=raw-stream chars=' + (content || '').length + ' path=' + filePath + ' cwd=' + (_convCwd[wid] || ''), 'info');
        promise = fetch('/api/write-file-stream?' + params.toString(), {
          method: 'PUT',
          headers: { 'Content-Type': 'text/plain; charset=utf-8' },
          body: content || ''
        });
      } else {
        dbg('write-file request: transport=json endpoint=' + apiUrl + ' chars=' + (content || '').length + ' path=' + filePath, 'info');
        promise = fetch(apiUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(writeBody)
        });
      }
      promise = promise.then(function(r) { return r.json(); }).then(function(d) {
        if (!d.ok) throw new Error(d.error || 'write failed');
        updateWriteFileStatus('wf-block done', (d.bytes / 1024).toFixed(1) + ' KB ' + (isAppend ? 'total' : 'written'));
        dbg('write-file: ' + (isAppend ? 'appended' : 'wrote') + ' → ' + d.path + ' bytes=' + d.bytes + ' transport=' + (useRawStreamWrite ? 'raw-stream' : 'json') + ' totalMs=' + (((typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now()) - writeStartedAt).toFixed(1), 'ok');
        if (storeId) delete _wfContentStore[storeId];
        trackConvFile(wid, d.path, d.bytes);
        if (isAppend) {
          _wfAddArtifactFromDisk(widget, d.path);
          validateWrittenFileFromDisk(d.path, widget, wid);
        } else if (validateWrittenFile(d.path, content || '', widget) !== false) {
          _wfAddCreatedFileArtifact(widget, d.path, content || '');
        }
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
  var validationStartedAt = (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now();
  dbg('write-file validation: read-back start path=' + filePath, 'info');
  fetch('/api/read-file', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ path: filePath })
  }).then(function(r) { return r.json(); }).then(function(d) {
    if (!d.ok) throw new Error(d.error || 'read failed');
    dbg('write-file validation: read-back complete path=' + (d.path || filePath) + ' bytes=' + d.bytes + ' ms=' + (((typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now()) - validationStartedAt).toFixed(1), 'info');
    validateWrittenFile(d.path || filePath, d.content || '', widget);
  }).catch(function(e) {
    markWriteFileFailed(widget, filePath, 'Could not validate final appended file: ' + e.message, convId);
  });
}

// ── Post-write file validation — catches truncated/broken files early ─────────
// Validates JS/TS files with `node --check`, HTML by closing tag, CSS by braces.
// On failure, feed a constrained repair request back to the AI.

function validateWrittenFile(filePath, content, widget) {
  var validationStartedAt = (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now();
  var ext = (filePath.split('.').pop() || '').toLowerCase();
  var convId = widget.dataset.convId || state.currentId;
  dbg('write-file validation: start path=' + filePath + ' ext=' + ext + ' chars=' + (content || '').length, 'info');

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
        dbg('write-file validation: node --check passed path=' + filePath + ' ms=' + (((typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now()) - validationStartedAt).toFixed(1), 'ok');
        clearWriteRepairMode(convId);
      }
    }).catch(function() {});

  } else if (ext === 'html') {
    if (!content.includes('</html>') && !content.includes('</body>')) {
      markWriteFileFailed(widget, filePath, 'HTML appears truncated — missing closing </html> tag', convId);
      return false;
    }
    clearWriteRepairMode(convId);
    dbg('write-file validation: html passed path=' + filePath + ' ms=' + (((typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now()) - validationStartedAt).toFixed(1), 'ok');
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
    dbg('write-file validation: css passed path=' + filePath + ' ms=' + (((typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now()) - validationStartedAt).toFixed(1), 'ok');
    return true;

  } else if (ext === 'md' || ext === 'markdown') {
    var importantDocMatch = filePath.match(/(implementation[_-]?guide|guide|handbook|spec|strategy|report|plan|architecture|runbook)/i);
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

    if (/^#{1,6}\s+\S/.test(lastLine.trim()) && trimmed.split('\n').length > 3) {
      markWriteFileFailed(widget, filePath,
        'Markdown ends immediately after a heading ("' + lastLine.trim().slice(0, 80) + '") — likely truncated', convId);
      return false;
    }

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
    
    // Check for suspiciously short long-form deliverables. This catches cases where
    // an inner ``` fence was mistaken for the outer write-file fence.
    if (importantDocMatch && (content.length < 4000 || trimmed.split('\n').length < 80)) {
      markWriteFileFailed(widget, filePath,
        'File appears suspiciously short (' + content.length + ' bytes, ' + trimmed.split('\n').length + ' lines) for a ' + importantDocMatch[0] + ' — likely incomplete', convId);
      return false;
    }
    clearWriteRepairMode(convId);
    dbg('write-file validation: markdown passed path=' + filePath + ' lines=' + trimmed.split('\n').length + ' ms=' + (((typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now()) - validationStartedAt).toFixed(1), 'ok');
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
    dbg('write-file validation: json passed path=' + filePath + ' ms=' + (((typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now()) - validationStartedAt).toFixed(1), 'ok');
    return true;
  }
  clearWriteRepairMode(convId);
  dbg('write-file validation: no-op passed path=' + filePath + ' ext=' + ext + ' ms=' + (((typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now()) - validationStartedAt).toFixed(1), 'ok');
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

