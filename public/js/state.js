// ── State ─────────────────────────────────────────────────────────────────
// One-time reset: clear any 'true' stored by the old auto-enable code
if (!localStorage.getItem('fauna-figma-mcp-explicit')) {
  localStorage.removeItem('fauna-figma-mcp');
  localStorage.setItem('fauna-figma-mcp-explicit', '1');
}

var state = {
  conversations: JSON.parse(localStorage.getItem('fauna-convs') || '[]'),
  currentId:     null,
  model:         localStorage.getItem('fauna-model') || 'claude-sonnet-4.6',
  systemPrompt:  localStorage.getItem('fauna-sys')   || '',
  pendingAttachments: [],   // { type: 'file'|'url', name, content }
  autoRunShell:  localStorage.getItem('fauna-autorun-shell') !== 'false', // default ON
  figmaMCPEnabled: localStorage.getItem('fauna-figma-mcp') === 'true',   // default OFF
  playwrightMCPEnabled: localStorage.getItem('fauna-playwright-mcp') === 'true', // default OFF
  thinkingBudget: localStorage.getItem('fauna-thinking-budget') || 'high',
  maxContextTurns: parseInt(localStorage.getItem('fauna-max-turns') || '20', 10),
  defaultSavePath: localStorage.getItem('fauna-default-save-path') || null, // user-specified default directory for file saves
  // streaming/abortController/_autoFeedDepth are per-conversation (conv._streaming etc.)
  artifacts:      [],  // active conv's artifacts { id, type, title, content, base64, mime, path, url }
  activeArtifact: null,
  // ── Projects
  projects:         [],         // all projects (loaded from /api/projects)
  activeProjectId:  localStorage.getItem('fauna-active-project') || null,
  projectHubOpen:   false,
  projectHubTab:    'files',    // 'files' | 'contexts' | 'sources' | 'tasks' | 'settings'
  projectFilePath:  null,       // currently viewed file path in file tree
  projectFileContent: null,     // content of viewed file
  projectContextEnabled: {},    // { ctxId: bool } — which contexts are active for chat
};

// ── Write-file side-channel store ─────────────────────────────────────────
// File content is NEVER put in the DOM. We extract it here before rendering,
// store by placeholder-id, and ExtractAndRenderWriteFile reads from here.
// (VS Code equivalent: workspace.applyEdit() bypasses the chat renderer entirely)
var _wfContentStore = {};  // { [id]: { path, content, mode } }
var _convFileLog    = {};  // { convId: [{path, bytes, time}] }
var _convCwd        = {};  // { convId: string } — project working dir for relative paths
var _promptHistIdx  = -1;  // current arrow-up/down cursor (-1 = draft)
var _promptHistDraft = ''; // stashed draft text while cycling

// ── Conversation file bar ─────────────────────────────────────────────────
function _cfbEsc(s) { return String(s).replace(/'/g, "\\'").replace(/"/g, '&quot;'); }

function trackConvFile(convId, resolvedPath, bytes) {
  if (!convId) return;
  if (!_convFileLog[convId]) _convFileLog[convId] = [];
  _convFileLog[convId] = _convFileLog[convId].filter(function(f) { return f.path !== resolvedPath; });
  _convFileLog[convId].push({ path: resolvedPath, bytes: bytes, time: Date.now() });
  renderConvFileBar(convId);
}

function getConvFileBar(convId) {
  var id = 'cfb-' + convId;
  var bar = document.getElementById(id);
  if (bar) return bar;
  bar = document.createElement('div');
  bar.id = id; bar.className = 'conv-file-bar'; bar.dataset.open = '1';
  var inner = getConvInner(convId);
  if (inner) inner.insertBefore(bar, inner.firstChild);
  return bar;
}

function renderConvFileBar(convId) {
  var files = _convFileLog[convId] || [];
  if (!files.length) return;
  var bar = getConvFileBar(convId);
  var isOpen = bar.dataset.open !== '0';
  var cwd = _convCwd[convId] || '';
  var cwdLabel = cwd ? cwd.replace(/^\/Users\/[^\/]+/, '~') : 'no project dir';
  bar.innerHTML =
    '<div class="cfb-header">' +
      '<span class="cfb-icon">📁</span>' +
      '<span class="cfb-title">' + files.length + ' file' + (files.length !== 1 ? 's' : '') + ' written</span>' +
      (cwd ? '<span class="cfb-cwd-badge" title="' + _cfbEsc(cwd) + '" onclick="setCwdFromBadge(\'' + _cfbEsc(convId) + '\')">' + _cfbEsc(cwdLabel) + '</span>' : '') +
      '<div class="cfb-actions">' +
        '<button class="cfb-btn" onclick="moveConvFilesToProject(\'' + _cfbEsc(convId) + '\')">Move to…</button>' +
        '<button class="cfb-btn" style="color:#f87171;border-color:rgba(248,113,113,.3)" onclick="clearConvFiles(\'' + _cfbEsc(convId) + '\')">Clear</button>' +
        '<button class="cfb-toggle" onclick="toggleConvFileBar(\'' + _cfbEsc(convId) + '\')">' + (isOpen ? '▲' : '▼') + '</button>' +
      '</div>' +
    '</div>';
  if (isOpen) {
    var list = document.createElement('div');
    list.className = 'cfb-list';
    files.slice().reverse().forEach(function(f) {
      var sp = f.path.length > 70 ? '…' + f.path.slice(-67) : f.path;
      var sz = f.bytes >= 1024 ? (f.bytes / 1024).toFixed(1) + ' KB' : f.bytes + ' B';
      var row = document.createElement('div');
      row.className = 'cfb-file';
      row.innerHTML =
        '<span class="cfb-file-path" title="' + _cfbEsc(f.path) + '">' + escHtml(sp) + '</span>' +
        '<span class="cfb-file-size">' + sz + '</span>' +
        '<button class="cfb-file-btn" title="Reveal in Finder" onclick="revealInFinder(\'' + _cfbEsc(f.path) + '\')">📂</button>' +
        '<button class="cfb-file-btn" title="Copy path" onclick="navigator.clipboard.writeText(\'' + _cfbEsc(f.path) + '\')">📋</button>' +
        '<button class="cfb-file-btn" title="Delete file" onclick="deleteConvFile(\'' + _cfbEsc(convId) + '\',\'' + _cfbEsc(f.path) + '\')">🗑</button>';
      list.appendChild(row);
    });
    // CWD row
    var cwdRow = document.createElement('div');
    cwdRow.className = 'cfb-cwd-row';
    cwdRow.innerHTML =
      '<span class="cfb-cwd-label">Project dir:</span>' +
      '<input class="cfb-cwd-input" id="cfb-cwd-' + convId + '" placeholder="/Users/you/myproject" value="' + _cfbEsc(cwd) + '"/>' +
      '<button class="cfb-btn" style="padding:2px 6px;font-size:10px" onclick="saveConvCwd(\'' + _cfbEsc(convId) + '\')">Set</button>';
    list.appendChild(cwdRow);
    bar.appendChild(list);
  }
}

function toggleConvFileBar(convId) {
  var bar = document.getElementById('cfb-' + convId);
  if (!bar) return;
  bar.dataset.open = bar.dataset.open === '0' ? '1' : '0';
  renderConvFileBar(convId);
}

function saveConvCwd(convId) {
  var input = document.getElementById('cfb-cwd-' + convId);
  if (!input) return;
  _convCwd[convId] = input.value.trim();
  renderConvFileBar(convId);
  // Trigger workspace discovery when CWD is set
  if (typeof onCwdChanged === 'function') onCwdChanged(_convCwd[convId]);
}

function setCwdFromBadge(convId) {
  var bar = document.getElementById('cfb-' + convId);
  if (bar) { bar.dataset.open = '1'; renderConvFileBar(convId); }
  setTimeout(function() {
    var input = document.getElementById('cfb-cwd-' + convId);
    if (input) input.focus();
  }, 50);
}

function revealInFinder(filePath) {
  fetch('/api/shell-exec', { method:'POST', headers:{'Content-Type':'application/json'},
    body: JSON.stringify({ command: 'open -R ' + JSON.stringify(filePath) }) });
}

function deleteConvFile(convId, filePath) {
  if (!confirm('Delete ' + filePath + '?')) return;
  fetch('/api/shell-exec', { method:'POST', headers:{'Content-Type':'application/json'},
    body: JSON.stringify({ command: 'rm -f ' + JSON.stringify(filePath) })
  }).then(function() {
    if (_convFileLog[convId])
      _convFileLog[convId] = _convFileLog[convId].filter(function(f) { return f.path !== filePath; });
    renderConvFileBar(convId);
  });
}

function clearConvFiles(convId) {
  if (!confirm('Delete all ' + (_convFileLog[convId] || []).length + ' files written in this conversation?')) return;
  var files = (_convFileLog[convId] || []).slice();
  Promise.all(files.map(function(f) {
    return fetch('/api/shell-exec', { method:'POST', headers:{'Content-Type':'application/json'},
      body: JSON.stringify({ command: 'rm -f ' + JSON.stringify(f.path) }) });
  })).then(function() {
    _convFileLog[convId] = [];
    var bar = document.getElementById('cfb-' + convId);
    if (bar) bar.remove();
  });
}

function moveConvFilesToProject(convId) {
  var dest = prompt('Copy all written files to project directory (will recreate path structure):', _convCwd[convId] || '');
  if (!dest || !dest.trim()) return;
  dest = dest.trim();
  var files = (_convFileLog[convId] || []).slice();
  var cmds = files.map(function(f) {
    return 'mkdir -p ' + JSON.stringify(require('path').dirname(f.path)) + ' && cp ' + JSON.stringify(f.path) + ' ' + JSON.stringify(dest + '/' + require('path').basename(f.path));
  });
  fetch('/api/shell-exec', { method:'POST', headers:{'Content-Type':'application/json'},
    body: JSON.stringify({ command: cmds.join(' && ') })
  }).then(function(r) { return r.json(); }).then(function(d) {
    alert(d.exitCode === 0 ? 'Copied ' + files.length + ' file(s) to ' + dest : 'Error: ' + (d.stderr || d.stdout));
  });
}

// Set default save path for all new files (user preference)
function setDefaultSavePath(path) {
  if (path && path.trim()) {
    state.defaultSavePath = path.trim();
    localStorage.setItem('fauna-default-save-path', path.trim());
    console.log('[fauna] Default save path set to:', path.trim());
  } else {
    state.defaultSavePath = null;
    localStorage.removeItem('fauna-default-save-path');
    console.log('[fauna] Default save path cleared');
  }
}


function sanitizeWriteFileBlocks(rawBuffer) {
  // write-file and append-file
  rawBuffer = rawBuffer.replace(/```(write-file|append-file)([:/][^\n]*)\n([\s\S]*?)```/g, function(match, mode, langSuffix, content) {
    var filePath = langSuffix.replace(/^[:/]/, '').trim();
    var id = 'wf-' + Date.now() + '-' + Math.random().toString(36).slice(2);
    _wfContentStore[id] = { path: filePath, content: content, mode: mode };
    return '```write-file-ready:' + id + ':' + filePath + '\n```';
  });
  // replace-string:/path  (SEARCH/REPLACE format inside)
  rawBuffer = rawBuffer.replace(/```replace-string([:/][^\n]*)\n([\s\S]*?)```/g, function(match, langSuffix, content) {
    var filePath = langSuffix.replace(/^[:/]/, '').trim();
    var id = 'wf-' + Date.now() + '-' + Math.random().toString(36).slice(2);
    _wfContentStore[id] = { path: filePath, content: content, mode: 'replace-string' };
    return '```write-file-ready:' + id + ':' + filePath + '\n```';
  });
  // apply-patch  (no path in the fence — paths go inside the patch body)
  rawBuffer = rawBuffer.replace(/```apply-patch[ \t]*\n([\s\S]*?)```/g, function(match, content) {
    var id = 'wf-' + Date.now() + '-' + Math.random().toString(36).slice(2);
    _wfContentStore[id] = { path: '(patch)', content: content, mode: 'apply-patch' };
    return '```write-file-ready:' + id + ':(patch)\n```';
  });
  return rawBuffer;
}

// ── Utilities (loaded early since most files need these) ──────────────────

function escHtml(s) {
  return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

