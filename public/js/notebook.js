// Jupyter notebook viewer — renders .ipynb files in the artifact pane

/**
 * Render a parsed .ipynb notebook object to an HTML string.
 * Depends on: escHtml(), renderMarkdown() (from markdown.js)
 */
function renderNotebookHtml(nb) {
  if (!nb || !Array.isArray(nb.cells)) {
    return '<div class="nb-empty">Empty or invalid notebook</div>';
  }

  var kernel = (nb.metadata && nb.metadata.kernelspec && nb.metadata.kernelspec.display_name)
    || (nb.metadata && nb.metadata.language_info && nb.metadata.language_info.name)
    || 'Python';

  var html = '<div class="nb-viewer">' +
    '<div class="nb-header">' +
      '<i class="ti ti-notebook"></i>' +
      '<span class="nb-kernel-label">' + escHtml(kernel) + '</span>' +
      '<span class="nb-cell-count">' + nb.cells.length + ' cell' + (nb.cells.length !== 1 ? 's' : '') + '</span>' +
    '</div>';

  for (var i = 0; i < nb.cells.length; i++) {
    html += _renderCell(nb.cells[i], i);
  }

  html += '</div>';
  return html;
}

function _renderCell(cell, idx) {
  var src = Array.isArray(cell.source) ? cell.source.join('') : (cell.source || '');

  if (cell.cell_type === 'markdown') {
    return '<div class="nb-cell nb-cell-markdown">' +
      '<div class="nb-md-body msg-body">' + renderMarkdown(src) + '</div>' +
    '</div>';
  }

  if (cell.cell_type === 'code') {
    var n = cell.execution_count != null ? String(cell.execution_count) : ' ';
    var outputs = cell.outputs || [];
    return '<div class="nb-cell nb-cell-code">' +
      '<div class="nb-cell-in">' +
        '<span class="nb-prompt nb-prompt-in">In&nbsp;[' + escHtml(n) + ']:</span>' +
        '<pre class="nb-src">' + escHtml(src) + '</pre>' +
      '</div>' +
      (outputs.length ? '<div class="nb-outputs">' + _renderOutputs(outputs, n) + '</div>' : '') +
    '</div>';
  }

  if (cell.cell_type === 'raw') {
    return '<div class="nb-cell nb-cell-raw">' +
      '<pre class="nb-src nb-src-raw">' + escHtml(src) + '</pre>' +
    '</div>';
  }

  return '';
}

function _renderOutputs(outputs, execCount) {
  var html = '';
  for (var i = 0; i < outputs.length; i++) {
    var out = outputs[i];

    if (out.output_type === 'stream') {
      var text = Array.isArray(out.text) ? out.text.join('') : (out.text || '');
      var isErr = out.name === 'stderr';
      html += '<div class="nb-output nb-output-stream' + (isErr ? ' nb-output-stderr' : '') + '">' +
        '<span class="nb-prompt nb-prompt-out">' + escHtml(out.name || 'stdout') + ':</span>' +
        '<pre class="nb-out-text">' + escHtml(text) + '</pre>' +
      '</div>';

    } else if (out.output_type === 'error') {
      var tb = Array.isArray(out.traceback) ? out.traceback.join('\n') : (out.traceback || '');
      // strip ANSI colour codes before display
      tb = tb.replace(/\x1b\[[0-9;]*[mGKHF]/g, '');
      html += '<div class="nb-output nb-output-error">' +
        '<span class="nb-prompt nb-prompt-err">Error:</span>' +
        '<pre class="nb-out-text nb-out-err">' +
          escHtml(out.ename + ': ' + out.evalue) + '\n' + escHtml(tb) +
        '</pre>' +
      '</div>';

    } else if (out.output_type === 'execute_result' || out.output_type === 'display_data') {
      var promptLabel = out.output_type === 'execute_result' ? 'Out&nbsp;[' + escHtml(execCount) + ']:' : '';
      html += _renderRichOutput(out, promptLabel);
    }
  }
  return html;
}

function _renderRichOutput(out, promptLabel) {
  var data = out.data || {};

  if (data['image/png']) {
    return '<div class="nb-output nb-output-display">' +
      (promptLabel ? '<span class="nb-prompt nb-prompt-out">' + promptLabel + '</span>' : '<span class="nb-prompt"></span>') +
      '<img class="nb-out-img" src="data:image/png;base64,' + data['image/png'] + '" alt="output">' +
    '</div>';
  }

  if (data['image/svg+xml']) {
    var svg = Array.isArray(data['image/svg+xml']) ? data['image/svg+xml'].join('') : data['image/svg+xml'];
    return '<div class="nb-output nb-output-display">' +
      (promptLabel ? '<span class="nb-prompt nb-prompt-out">' + promptLabel + '</span>' : '<span class="nb-prompt"></span>') +
      '<div class="nb-out-svg">' + svg + '</div>' +
    '</div>';
  }

  if (data['text/html']) {
    var htmlData = Array.isArray(data['text/html']) ? data['text/html'].join('') : data['text/html'];
    return '<div class="nb-output nb-output-display">' +
      (promptLabel ? '<span class="nb-prompt nb-prompt-out">' + promptLabel + '</span>' : '<span class="nb-prompt"></span>') +
      '<div class="nb-out-html">' + htmlData + '</div>' +
    '</div>';
  }

  if (data['text/plain']) {
    var plain = Array.isArray(data['text/plain']) ? data['text/plain'].join('') : (data['text/plain'] || '');
    return '<div class="nb-output nb-output-result">' +
      (promptLabel ? '<span class="nb-prompt nb-prompt-out">' + promptLabel + '</span>' : '<span class="nb-prompt"></span>') +
      '<pre class="nb-out-text">' + escHtml(plain) + '</pre>' +
    '</div>';
  }

  return '';
}

// ── Artifact integration ─────────────────────────────────────────────────

/** Open a .ipynb file as a notebook artifact */
async function openNotebookArtifact(filePath) {
  var title = (filePath.split('/').pop() || filePath);
  var id = addArtifact({ type: 'notebook', title: title, path: filePath });
  openArtifact(id);
  _loadNotebookData(id, filePath);
}

async function _loadNotebookData(artifactId, filePath) {
  var a = state.artifacts.find(function(x) { return x.id === artifactId; });
  if (!a) return;
  a._nbLoading = true;
  if (state.activeArtifact === artifactId) renderArtifactContent();

  try {
    var r = await fetch('/api/notebook/load?path=' + encodeURIComponent(filePath));
    var d = await r.json();
    if (d.ok) {
      a._nbData = d;
      a._nbError = null;
    } else {
      a._nbError = d.error || 'Failed to load notebook';
    }
  } catch (e) {
    a._nbError = e.message;
  }

  a._nbLoading = false;
  if (state.activeArtifact === artifactId) renderArtifactContent();
}

/** Execute a notebook in-place and refresh the artifact */
async function executeNotebookArtifact(artifactId) {
  var a = state.artifacts.find(function(x) { return x.id === artifactId; });
  if (!a || !a.path) return;
  a._nbExecuting = true;
  a._nbError = null;
  renderArtifactContent();

  try {
    var r = await fetch('/api/notebook/execute', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: a.path }),
    });
    var d = await r.json();
    if (d.ok) {
      if (!a._nbData) a._nbData = {};
      a._nbData.cells = d.cells;
      a._nbData.metadata = d.metadata;
      a._nbError = null;
    } else {
      a._nbError = d.error || 'Execution failed';
    }
  } catch (e) {
    a._nbError = e.message;
  }

  a._nbExecuting = false;
  renderArtifactContent();
}
