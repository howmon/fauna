// ── File-edits Keep / Undo / View-all-edits bar ──────────────────────────
// Shown above the composer after any chat turn that writes project files.
// Three actions: Keep (dismiss), Undo (revert all changes), View (diff modal).
//
// Also houses the persistent Todo / plan bar that replaces in-message plan
// panels. Updated by overriding window.renderPlanPanel after load.

// ── Todo bar ─────────────────────────────────────────────────────────────

var _todoPersistKey = 'fauna-todo-bar-open'; // collapsed state localStorage key

var _todoDismissTimer = null;
var _currentPlan = null;

// Returns uncompleted todo titles for the active plan, or empty array.
function getUncompletedTodos() {
  if (!_currentPlan || !Array.isArray(_currentPlan.items)) return [];
  return _currentPlan.items
    .filter(function(x) { return x.status !== 'completed' && x.status !== 'cancelled'; })
    .map(function(x) { return x.title || ''; })
    .filter(Boolean);
}
window.getUncompletedTodos = getUncompletedTodos;

function updateTodoBar(plan, isLive) {
  if (!plan || !Array.isArray(plan.items) || !plan.items.length) { clearTodoBar(); return; }
  _currentPlan = plan;
  var bar = document.getElementById('todo-bar');
  if (!bar) return;

  var items = plan.items;
  var done  = items.filter(function(x) { return x.status === 'completed'; }).length;
  var total = items.filter(function(x) { return x.status !== 'cancelled'; }).length;
  var allDone = done >= total && !isLive;

  // Auto-dismiss when every non-cancelled item is completed (after a short pause)
  if (allDone) {
    if (!_todoDismissTimer) {
      _todoDismissTimer = setTimeout(function() {
        _todoDismissTimer = null;
        clearTodoBar();
      }, 2000);
    }
    // Still render the final state so the user sees 100% briefly
  } else {
    // Cancel any pending dismiss if new/incomplete items appeared
    if (_todoDismissTimer) { clearTimeout(_todoDismissTimer); _todoDismissTimer = null; }
  }

  // Preserve open/closed state; default open
  if (!bar.dataset.open) bar.dataset.open = localStorage.getItem(_todoPersistKey) === '0' ? '0' : '1';

  var summaryEl = bar.querySelector('.todo-bar-summary');
  if (summaryEl) summaryEl.textContent = done + '/' + total;

  var listEl = bar.querySelector('.todo-bar-list');
  if (listEl) {
    listEl.innerHTML = items.map(function(it) {
      var st = it.status || 'not-started';
      var icon = st === 'completed'   ? '<i class="ti ti-circle-check-filled"></i>'
               : st === 'in-progress' ? '<i class="ti ti-loader-2 plan-spin"></i>'
               : st === 'cancelled'   ? '<i class="ti ti-circle-x"></i>'
               :                        '<i class="ti ti-circle"></i>';
      return '<li class="todo-bar-item" data-status="' + st + '">' +
        '<span class="todo-bar-item-icon">' + icon + '</span>' +
        '<span>' + escHtml(it.title || '') + '</span>' +
      '</li>';
    }).join('');
  }

  // Re-show bar if it was previously hidden (new todo was added)
  bar.style.display = '';
  document.body.classList.add('todo-bar-open');
}
window.updateTodoBar = updateTodoBar;

function clearTodoBar() {
  if (_todoDismissTimer) { clearTimeout(_todoDismissTimer); _todoDismissTimer = null; }
  _currentPlan = null;
  var bar = document.getElementById('todo-bar');
  if (bar) bar.style.display = 'none';
  document.body.classList.remove('todo-bar-open');
}
window.clearTodoBar = clearTodoBar;

function toggleTodoBar() {
  var bar = document.getElementById('todo-bar');
  if (!bar) return;
  var next = bar.dataset.open === '1' ? '0' : '1';
  bar.dataset.open = next;
  try { localStorage.setItem(_todoPersistKey, next); } catch (_) {}
}
window.toggleTodoBar = toggleTodoBar;

// Restore todo bar from the latest plan in a conversation
function restoreTodoBar(conv) {
  if (!conv || !Array.isArray(conv.messages)) { clearTodoBar(); return; }
  var lastPlan = null;
  for (var i = conv.messages.length - 1; i >= 0; i--) {
    var m = conv.messages[i];
    if (m && m.role === 'assistant' && m.plan && Array.isArray(m.plan.items) && m.plan.items.length) {
      lastPlan = m.plan;
      break;
    }
  }
  if (lastPlan) updateTodoBar(lastPlan, false);
  else clearTodoBar();
}
window.restoreTodoBar = restoreTodoBar;

// Override window.renderPlanPanel to also update the persistent bar.
// The original lives in ui.js and is set synchronously; we patch it here
// after both files have loaded (file-edits-bar.js loads after ui.js).
(function() {
  var _origRenderPlanPanel = window.renderPlanPanel;
  window.renderPlanPanel = function renderPlanPanel(msgEl, plan, isLive) {
    // Update the persistent bar above the input
    if (plan && Array.isArray(plan.items)) updateTodoBar(plan, isLive);
    // Do NOT call the original (suppresses in-message panel)
    // _origRenderPlanPanel is still available if history rendering is needed
  };
  // Keep original accessible for explicit history rendering
  window._origRenderPlanPanel = _origRenderPlanPanel;
})();

// ── File-edits Keep / Undo / View-all-edits bar ──────────────────────────

var _febConvId = null;
var _febFiles  = [];
var _febDiffData = null;
var _febDiffTabIdx = 0;

var _langIcons = {
  '.js': 'ti-brand-javascript', '.mjs': 'ti-brand-javascript', '.cjs': 'ti-brand-javascript',
  '.ts': 'ti-brand-typescript', '.jsx': 'ti-brand-react', '.tsx': 'ti-brand-react',
  '.py': 'ti-brand-python', '.html': 'ti-brand-html5', '.htm': 'ti-brand-html5',
  '.css': 'ti-brand-css3', '.scss': 'ti-brand-css3', '.json': 'ti-braces',
  '.md': 'ti-markdown', '.sh': 'ti-terminal-2', '.rs': 'ti-brand-rust',
  '.go': 'ti-brand-golang', '.rb': 'ti-brand-ruby', '.php': 'ti-brand-php',
  '.vue': 'ti-brand-vue', '.svelte': 'ti-brand-svelte',
};
function _fileIcon(name) {
  var m = name.match(/\.[^.]+$/);
  return (_langIcons[m ? m[0].toLowerCase() : '']) || 'ti-file-code';
}
function _fileDir(fullPath, name) {
  if (!fullPath) return '';
  var dir = fullPath.slice(0, fullPath.length - name.length - 1).replace(/\\/g, '/');
  var parts = dir.split('/');
  return parts.slice(-2).join('/');
}
function showFileEditsBar(files, convId) {
  _febConvId = convId;
  _febFiles  = Array.isArray(files) ? files : [];
  _febDiffData = null;

  var bar = document.getElementById('file-edits-bar');
  if (!bar) return;

  var totalAdded   = _febFiles.reduce(function(s, f) { return s + (f.added || 0); }, 0);
  var totalRemoved = _febFiles.reduce(function(s, f) { return s + (f.removed || 0); }, 0);
  var cnt = _febFiles.length;

  var headerStats = '';
  if (totalAdded)   headerStats += ' <span class="feb-added">+' + totalAdded + '</span>';
  if (totalRemoved) headerStats += ' <span style="color:var(--fau-text-muted)">·</span> <span class="feb-removed">-' + totalRemoved + '</span>';

  var fileRows = _febFiles.map(function(f) {
    var icon = _fileIcon(f.name);
    var dir  = _fileDir(f.path, f.name);
    var fstats = '';
    if (f.added)   fstats += '<span class="feb-added">+' + f.added + '</span>';
    if (f.removed) fstats += ' <span class="feb-removed">-' + f.removed + '</span>';
    return '<li class="feb-file-row">' +
      '<i class="ti ' + icon + ' feb-lang-icon"></i>' +
      '<span class="feb-fname">' + escHtml(f.name) + '</span>' +
      (dir ? '<span class="feb-fdir">' + escHtml(dir) + '</span>' : '') +
      (fstats ? '<span class="feb-fstats">' + fstats + '</span>' : '') +
    '</li>';
  }).join('');

  var isOpen = bar.dataset.open !== '0';
  bar.innerHTML =
    '<div class="feb-header">' +
      '<button class="feb-toggle" onclick="toggleFileEditsBar()" type="button">' +
        '<i class="ti ti-chevron-down feb-chevron"></i>' +
        '<span class="feb-count">' + cnt + ' file' + (cnt === 1 ? '' : 's') + ' changed</span>' +
        headerStats +
      '</button>' +
      '<div class="feb-actions">' +
        '<button class="feb-btn feb-keep" onclick="hideFileEditsBar()" title="Keep changes"><i class="ti ti-check"></i> Keep</button>' +
        '<button class="feb-btn feb-undo" onclick="_fileEditsUndo()" title="Revert all"><i class="ti ti-rotate-left"></i> Undo</button>' +
        '<button class="feb-btn feb-view" onclick="openFileEditsDiffModal()" title="View diff"><i class="ti ti-git-diff"></i></button>' +
      '</div>' +
    '</div>' +
    '<ul class="feb-file-list">' + fileRows + '</ul>';

  bar.dataset.open = isOpen ? '1' : '0';
  bar.classList.add('visible');
}
window.showFileEditsBar = showFileEditsBar;

function hideFileEditsBar() {
  var bar = document.getElementById('file-edits-bar');
  if (bar) bar.classList.remove('visible');
}
window.hideFileEditsBar = hideFileEditsBar;

function toggleFileEditsBar() {
  var bar = document.getElementById('file-edits-bar');
  if (!bar) return;
  bar.dataset.open = bar.dataset.open === '0' ? '1' : '0';
}
window.toggleFileEditsBar = toggleFileEditsBar;

async function _fileEditsUndo() {
  if (!_febConvId) return;
  try {
    var r = await fetch('/api/undo-edits', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ convId: _febConvId }),
    });
    var j = await r.json().catch(function() { return {}; });
    if (j.ok) {
      var msg = 'Reverted ' + (j.restored || []).join(', ');
      if (typeof _showToast === 'function') _showToast(msg);
      hideFileEditsBar();
      // Refresh file tree if a project is open
      if (typeof _projSpLoadTree === 'function' && typeof state !== 'undefined' && state.activeProjectId) {
        _projSpLoadTree();
      }
      // Refresh open file in hub viewer if any
      if (typeof _activeFileTabKey !== 'undefined' && _activeFileTabKey && typeof switchFileTab === 'function') {
        switchFileTab(_activeFileTabKey);
      }
    } else {
      if (typeof _showToast === 'function') _showToast('Undo failed: ' + (j.error || 'unknown'), true);
    }
  } catch (e) {
    if (typeof _showToast === 'function') _showToast('Undo failed: ' + e.message, true);
  }
}
window._fileEditsUndo = _fileEditsUndo;

// ── Diff modal ───────────────────────────────────────────────────────────

async function openFileEditsDiffModal() {
  var modal = document.getElementById('file-edits-diff-modal');
  if (!modal) return;

  // Show loading state
  document.getElementById('file-edits-diff-tabs').innerHTML = '';
  document.getElementById('file-edits-diff-content').innerHTML =
    '<span style="color:var(--fau-text-muted);font-size:12px">Loading diff…</span>';
  modal.classList.add('show');

  try {
    var r = await fetch('/api/undo-edits/diff?convId=' + encodeURIComponent(_febConvId || ''));
    var j = await r.json().catch(function() { return {}; });
    if (!j.ok || !Array.isArray(j.files)) throw new Error(j.error || 'Failed to load diff');
    _febDiffData = j.files;
    _febDiffTabIdx = 0;
    _renderDiffTabs();
    _renderDiffContent(_febDiffTabIdx);
  } catch (e) {
    document.getElementById('file-edits-diff-content').innerHTML =
      '<span style="color:var(--fau-danger,#e06c75)">Error: ' + escHtml(e.message) + '</span>';
  }
}
window.openFileEditsDiffModal = openFileEditsDiffModal;

function closeFileEditsDiffModal() {
  var modal = document.getElementById('file-edits-diff-modal');
  if (modal) modal.classList.remove('show');
}
window.closeFileEditsDiffModal = closeFileEditsDiffModal;

function _renderDiffTabs() {
  var tabsEl = document.getElementById('file-edits-diff-tabs');
  if (!tabsEl || !_febDiffData) return;
  tabsEl.innerHTML = _febDiffData.map(function(f, i) {
    return '<button class="fedt-tab' + (i === _febDiffTabIdx ? ' active' : '') + '" onclick="_switchDiffTab(' + i + ')" title="' + escHtml(f.path) + '">' +
      escHtml(f.name) + '</button>';
  }).join('');
}

function _switchDiffTab(idx) {
  _febDiffTabIdx = idx;
  _renderDiffTabs();
  _renderDiffContent(idx);
}
window._switchDiffTab = _switchDiffTab;

function _renderDiffContent(idx) {
  var el = document.getElementById('file-edits-diff-content');
  if (!el || !_febDiffData || !_febDiffData[idx]) return;
  var f = _febDiffData[idx];
  el.innerHTML = _buildDiffHtml(f.before, f.after);
}

// Build a simple unified-diff-style HTML view
function _buildDiffHtml(before, after) {
  var oldLines = String(before || '').split('\n');
  var newLines = String(after  || '').split('\n');
  var MAX_CONTEXT = 4;

  // Compute LCS-based diff hunks
  var hunks = _computeDiffHunks(oldLines, newLines, MAX_CONTEXT);
  if (!hunks.length) {
    return '<span class="fed-unchanged">No changes detected.</span>';
  }

  var html = '';
  for (var h = 0; h < hunks.length; h++) {
    var hunk = hunks[h];
    html += '<div class="fed-hunk">';
    for (var i = 0; i < hunk.length; i++) {
      var ln = hunk[i];
      if (ln.type === 'add') {
        html += '<div class="fed-line fed-line-add">+ ' + escHtml(ln.text) + '</div>';
      } else if (ln.type === 'del') {
        html += '<div class="fed-line fed-line-del">- ' + escHtml(ln.text) + '</div>';
      } else if (ln.type === 'ctx') {
        html += '<div class="fed-line fed-line-ctx">  ' + escHtml(ln.text) + '</div>';
      } else if (ln.type === 'gap') {
        html += '<div class="fed-unchanged">… ' + ln.count + ' unchanged line' + (ln.count !== 1 ? 's' : '') + '</div>';
      }
    }
    html += '</div>';
  }
  return html;
}

// Patience-lite diff: Myers O(ND) abbreviated for display purposes
// Returns array of hunks, each hunk is array of {type, text} or {type:'gap', count}
function _computeDiffHunks(oldLines, newLines, ctxSize) {
  // Build edit script using simple DP LCS
  var o = oldLines.length, n = newLines.length;
  // Limit for perf — if files are large, do a simpler line-by-line compare
  if (o > 2000 || n > 2000) {
    return _simpleDiff(oldLines, newLines, ctxSize);
  }

  // LCS table
  var dp = [];
  for (var i = 0; i <= o; i++) {
    dp[i] = new Array(n + 1).fill(0);
  }
  for (var i = 1; i <= o; i++) {
    for (var j = 1; j <= n; j++) {
      if (oldLines[i-1] === newLines[j-1]) dp[i][j] = dp[i-1][j-1] + 1;
      else dp[i][j] = Math.max(dp[i-1][j], dp[i][j-1]);
    }
  }

  // Traceback
  var ops = []; // {type:'eq'|'del'|'add', text}
  var i = o, j = n;
  while (i > 0 || j > 0) {
    if (i > 0 && j > 0 && oldLines[i-1] === newLines[j-1]) {
      ops.unshift({ type: 'eq', text: oldLines[i-1] });
      i--; j--;
    } else if (j > 0 && (i === 0 || dp[i][j-1] >= dp[i-1][j])) {
      ops.unshift({ type: 'add', text: newLines[j-1] });
      j--;
    } else {
      ops.unshift({ type: 'del', text: oldLines[i-1] });
      i--;
    }
  }

  return _opsToHunks(ops, ctxSize);
}

function _simpleDiff(oldLines, newLines, ctxSize) {
  var ops = [];
  var len = Math.max(oldLines.length, newLines.length);
  for (var i = 0; i < len; i++) {
    if (i < oldLines.length && i < newLines.length) {
      if (oldLines[i] === newLines[i]) ops.push({ type: 'eq', text: oldLines[i] });
      else { ops.push({ type: 'del', text: oldLines[i] }); ops.push({ type: 'add', text: newLines[i] }); }
    } else if (i < oldLines.length) {
      ops.push({ type: 'del', text: oldLines[i] });
    } else {
      ops.push({ type: 'add', text: newLines[i] });
    }
  }
  return _opsToHunks(ops, ctxSize);
}

function _opsToHunks(ops, ctxSize) {
  // Find changed regions and add context around them
  var changed = [];
  for (var k = 0; k < ops.length; k++) {
    if (ops[k].type !== 'eq') changed.push(k);
  }
  if (!changed.length) return [];

  // Merge ranges with context
  var ranges = [];
  var start = Math.max(0, changed[0] - ctxSize);
  var end   = Math.min(ops.length - 1, changed[0] + ctxSize);
  for (var m = 1; m < changed.length; m++) {
    var ns = Math.max(0, changed[m] - ctxSize);
    var ne = Math.min(ops.length - 1, changed[m] + ctxSize);
    if (ns <= end + 1) { end = ne; }
    else { ranges.push([start, end]); start = ns; end = ne; }
  }
  ranges.push([start, end]);

  // Build hunk output with gap markers
  var hunks = [];
  var prev = -1;
  for (var r = 0; r < ranges.length; r++) {
    var rs = ranges[r][0], re = ranges[r][1];
    var hunk = [];
    if (prev >= 0 && rs > prev + 1) {
      hunk.push({ type: 'gap', count: rs - prev - 1 });
    } else if (prev < 0 && rs > 0) {
      hunk.push({ type: 'gap', count: rs });
    }
    for (var x = rs; x <= re; x++) {
      var op = ops[x];
      hunk.push({ type: op.type === 'eq' ? 'ctx' : op.type, text: op.text });
    }
    if (re < ops.length - 1) {
      // trailing gap added by next range or final check
    }
    hunks.push(hunk);
    prev = re;
  }
  if (prev < ops.length - 1) {
    var lastHunk = hunks[hunks.length - 1];
    if (lastHunk) lastHunk.push({ type: 'gap', count: ops.length - 1 - prev });
  }
  return hunks;
}
