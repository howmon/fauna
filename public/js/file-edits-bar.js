// ── File-edits Keep / Undo / View-all-edits bar ──────────────────────────
// Shown above the composer after any chat turn that writes project files.
// Three actions: Keep (dismiss), Undo (revert all changes), View (diff modal).
//
// Public API used by chat.js:
//   showFileEditsBar(files, convId)
//   hideFileEditsBar()
//
// Public API used by diff modal footer button in HTML:
//   _fileEditsUndo()
//   closeFileEditsDiffModal()

var _febConvId = null;
var _febFiles  = [];
var _febDiffData = null;
var _febDiffTabIdx = 0;

function showFileEditsBar(files, convId) {
  _febConvId = convId;
  _febFiles  = Array.isArray(files) ? files : [];
  _febDiffData = null; // invalidate cached diff

  var bar = document.getElementById('file-edits-bar');
  if (!bar) return;

  var names = _febFiles.slice(0, 5).map(function(f) {
    return '<span class="feb-file-chip" title="' + escHtml(f.path || f.name) + '">' +
      '<i class="ti ti-file-code"></i> ' + escHtml(f.name) + '</span>';
  });
  var extra = _febFiles.length > 5 ? ' <span style="color:var(--fau-text-muted);font-size:11px">+' + (_febFiles.length - 5) + ' more</span>' : '';

  bar.innerHTML =
    '<i class="ti ti-pencil-check feb-icon"></i>' +
    '<span class="feb-label">Fauna edited <span class="feb-files">' + names.join('') + extra + '</span></span>' +
    '<span class="feb-actions">' +
      '<button class="feb-btn feb-view" onclick="openFileEditsDiffModal()" title="View a diff of every change"><i class="ti ti-git-diff"></i> View all edits</button>' +
      '<button class="feb-btn feb-undo" onclick="_fileEditsUndo()" title="Revert all changes from this turn"><i class="ti ti-rotate-left"></i> Undo</button>' +
      '<button class="feb-btn feb-keep" onclick="hideFileEditsBar()" title="Keep changes and dismiss"><i class="ti ti-check"></i> Keep</button>' +
    '</span>';

  bar.classList.add('visible');
}
window.showFileEditsBar = showFileEditsBar;

function hideFileEditsBar() {
  var bar = document.getElementById('file-edits-bar');
  if (bar) bar.classList.remove('visible');
}
window.hideFileEditsBar = hideFileEditsBar;

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
