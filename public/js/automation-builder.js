// ── Pipeline Builder — Full-screen overlay node editor ────────────────────
// Depends on: automation-canvas.js, tasks.js (for API calls)
//
// Public API:
//   openPipelineBuilder(taskId)   — open overlay for given task (or null = new)
//   closePipelineBuilder()        — close overlay
//   savePipelineToTask(taskId)    — save pipeline into task or create the current draft

var _pbCanvas   = null;   // canvas controller
var _pbTaskId   = null;   // task being edited
var _pbDirty    = false;

// ── Open / Close ─────────────────────────────────────────────────────────

function openPipelineBuilder(taskId) {
  _pbTaskId = taskId || null;
  _pbDirty  = false;

  // Ensure overlay exists
  var overlay = document.getElementById('pipeline-builder-overlay');
  if (!overlay) {
    overlay = document.createElement('div');
    overlay.id = 'pipeline-builder-overlay';
    overlay.style.cssText = [
      'position:fixed;inset:0;z-index:9000;display:flex;flex-direction:column;',
      'background:var(--fau-bg,#0e0e14);padding-top:36px;',
    ].join('');
    document.body.appendChild(overlay);
  }

  // Get pipeline from task, draft, or blank
  var pipeline = { nodes: [], edges: [] };
  if (taskId && typeof _tasksCache !== 'undefined') {
    var task = _tasksCache.find(function(t) { return t.id === taskId; });
    if (task && task.pipeline) pipeline = task.pipeline;
  } else if (!taskId && typeof _draft !== 'undefined' && _draft && _draft.pipeline) {
    pipeline = _draft.pipeline;
  }

  _buildOverlayHTML(overlay, pipeline);

  // Init canvas
  var canvasHost = document.getElementById('pb-canvas-host');
  _pbCanvas = pipelineCanvas.initCanvas(canvasHost, pipeline, {
    onChange: function(evt, data) {
      if (evt === 'change') { _pbDirty = true; _updateNodeCount(); }
      if (evt === 'select') { _renderConfigPanel(data); }
    },
  });

  // Fit if nodes exist
  if (pipeline.nodes && pipeline.nodes.length) {
    setTimeout(function() { _pbCanvas.fitAll(); }, 50);
  }
}

function closePipelineBuilder() {
  var overlay = document.getElementById('pipeline-builder-overlay');
  if (overlay) overlay.remove();
  _pbCanvas = null;
  _pbTaskId = null;
}

// ── Overlay HTML ─────────────────────────────────────────────────────────

function _buildOverlayHTML(overlay, pipeline) {
  var nodeCount = pipeline.nodes ? pipeline.nodes.length : 0;

  overlay.innerHTML =
    // ── Toolbar ──────────────────────────────────────────────────────────
    '<div id="pb-toolbar" style="display:flex;align-items:center;gap:8px;padding:10px 16px;border-bottom:1px solid var(--fau-border,#2a2a3a);flex-shrink:0;background:var(--fau-sidebar,#161622);">' +
      '<span style="font-size:14px;font-weight:600;color:var(--fau-text,#fff);margin-right:8px;display:flex;align-items:center;gap:6px;">' +
        '<i class="ti ti-git-branch" style="color:var(--accent,#6366f1)"></i> Pipeline Builder' +
      '</span>' +
      // Add node dropdown
      '<div style="position:relative;">' +
        '<button class="pb-btn" onclick="_pbToggleNodeMenu()" id="pb-add-btn"><i class="ti ti-plus"></i> Add Node</button>' +
        '<div id="pb-node-menu" style="display:none;position:absolute;top:100%;left:0;z-index:10;background:var(--fau-surface,#1a1a28);border:1px solid var(--fau-border,#2a2a3a);border-radius:8px;padding:6px;min-width:160px;margin-top:4px;box-shadow:0 8px 24px rgba(0,0,0,.4);">' +
          _nodeMenuItems() +
        '</div>' +
      '</div>' +
      '<button class="pb-btn" onclick="_pbZoomIn()"><i class="ti ti-zoom-in"></i></button>' +
      '<button class="pb-btn" onclick="_pbZoomOut()"><i class="ti ti-zoom-out"></i></button>' +
      '<button class="pb-btn" onclick="_pbFitAll()"><i class="ti ti-scan"></i> Fit</button>' +
      '<span style="flex:1"></span>' +
      '<span id="pb-node-count" style="font-size:11px;color:var(--fau-text-muted,#888);">' + nodeCount + ' nodes</span>' +
      '<button class="pb-btn primary" onclick="savePipelineToTask(_pbTaskId)"><i class="ti ti-check"></i> Save</button>' +
      '<button class="pb-btn" onclick="closePipelineBuilder()"><i class="ti ti-x"></i> Close</button>' +
    '</div>' +
    // ── Main area ─────────────────────────────────────────────────────────
    '<div style="display:flex;flex:1;min-height:0;">' +
      // Canvas
      '<div id="pb-canvas-host" style="flex:1;min-width:0;position:relative;outline:none;"></div>' +
      // Config sidebar
      '<div id="pb-config-panel" style="width:260px;flex-shrink:0;border-left:1px solid var(--fau-border,#2a2a3a);overflow-y:auto;background:var(--fau-sidebar,#161622);padding:16px;display:flex;flex-direction:column;gap:12px;">' +
        '<div style="font-size:12px;color:var(--fau-text-muted,#888);text-align:center;margin-top:40px;">Select a node to configure it</div>' +
      '</div>' +
    '</div>';

  // Close node menu when clicking outside
  document.addEventListener('click', function _pbMenuClose(e) {
    var menu = document.getElementById('pb-node-menu');
    var btn  = document.getElementById('pb-add-btn');
    if (menu && !menu.contains(e.target) && e.target !== btn) {
      menu.style.display = 'none';
      document.removeEventListener('click', _pbMenuClose);
    }
  });
}

function _nodeMenuItems() {
  var types = Object.keys(pipelineCanvas.NODE_TYPES);
  return types.map(function(t) {
    var def = pipelineCanvas.NODE_TYPES[t];
    return '<button class="pb-node-menu-item" onclick="_pbAddNode(\'' + t + '\')">' +
      '<i class="ti ' + def.icon + '" style="color:' + def.color + ';width:16px;"></i> ' + def.label +
    '</button>';
  }).join('');
}

// ── Toolbar actions ──────────────────────────────────────────────────────

function _pbToggleNodeMenu() {
  var menu = document.getElementById('pb-node-menu');
  if (!menu) return;
  menu.style.display = menu.style.display === 'none' ? 'block' : 'none';
}

function _pbAddNode(type) {
  var menu = document.getElementById('pb-node-menu');
  if (menu) menu.style.display = 'none';
  if (!_pbCanvas) return;
  // Place at visible center of canvas, accounting for current pan/zoom
  var host = document.getElementById('pb-canvas-host');
  var hostW = host ? host.clientWidth  : 400;
  var hostH = host ? host.clientHeight : 300;
  var vp = _pbCanvas.getViewport ? _pbCanvas.getViewport() : { zoom: 1, pan: { x: 0, y: 0 } };
  var cx = (hostW / 2 - vp.pan.x) / vp.zoom - 80;
  var cy = (hostH / 2 - vp.pan.y) / vp.zoom - 36;
  // Offset subsequent nodes so they don't stack exactly
  var count = _pbCanvas.getPipeline().nodes.length;
  _pbCanvas.addNode(type, cx + count * 30, cy + count * 30);
  _updateNodeCount();
}

function _pbZoomIn() {
  // Use canvas wheel simulation — just trigger viewport zoom
  var host = document.getElementById('pb-canvas-host');
  if (host) host.dispatchEvent(new WheelEvent('wheel', { deltaY: -100, bubbles: true }));
}

function _pbZoomOut() {
  var host = document.getElementById('pb-canvas-host');
  if (host) host.dispatchEvent(new WheelEvent('wheel', { deltaY: 100, bubbles: true }));
}

function _pbFitAll() {
  if (_pbCanvas) _pbCanvas.fitAll();
}

function _updateNodeCount() {
  var el = document.getElementById('pb-node-count');
  if (!el || !_pbCanvas) return;
  var count = _pbCanvas.getPipeline().nodes.length;
  el.textContent = count + ' node' + (count !== 1 ? 's' : '');
}

// ── Config panel ─────────────────────────────────────────────────────────

function _renderConfigPanel(nodeId) {
  var panel = document.getElementById('pb-config-panel');
  if (!panel || !_pbCanvas) return;

  if (!nodeId) {
    panel.innerHTML = '<div style="font-size:12px;color:var(--fau-text-muted,#888);text-align:center;margin-top:40px;">Select a node to configure it</div>';
    return;
  }

  var node = _pbCanvas.getNodeById(nodeId);
  if (!node) return;

  var def = pipelineCanvas.NODE_TYPES[node.type] || pipelineCanvas.NODE_TYPES.prompt;

  var configFields = _configFieldsForType(node);

  panel.innerHTML =
    '<div style="display:flex;align-items:center;gap:8px;margin-bottom:12px;">' +
      '<i class="ti ' + def.icon + '" style="color:' + def.color + ';font-size:18px"></i>' +
      '<span style="font-size:13px;font-weight:600;color:var(--fau-text,#fff);">' + def.label + '</span>' +
    '</div>' +
    // Label
    '<div class="pb-field-row">' +
      '<label class="pb-field-lbl">Label</label>' +
      '<input class="pb-field-input" value="' + _esc(node.label || def.label) + '" ' +
        'oninput="_pbUpdateNode(\'' + nodeId + '\',\'label\',this.value)">' +
    '</div>' +
    configFields +
    // Delete button
    '<div style="margin-top:auto;padding-top:16px;border-top:1px solid var(--fau-border,#2a2a3a);">' +
      '<button class="pb-btn danger" onclick="_pbCanvas.removeNode(\'' + nodeId + '\')" style="width:100%;">' +
        '<i class="ti ti-trash"></i> Remove Node' +
      '</button>' +
    '</div>';
}

function _configFieldsForType(node) {
  var config = node.config || {};
  var nid = node.id;
  var html = '';

  if (node.type === 'prompt' || node.type === 'agent') {
    html += _pbFieldTextarea(nid, 'prompt', 'Prompt / instruction', config.prompt || '', 'What should this step do? Use {{prevNode.output}} for variable interpolation.');
  }
  if (node.type === 'shell') {
    html += _pbFieldTextarea(nid, 'command', 'Shell command', config.command || '', 'bash command or script');
  }
  if (node.type === 'code') {
    html += _pbFieldTextarea(nid, 'code', 'JavaScript', config.code || 'return input;', 'Receives `input` (prev output), must return a value');
  }
  if (node.type === 'condition') {
    html += _pbFieldTextarea(nid, 'expression', 'Condition expression', config.expression || '', 'JS expression that evaluates to true/false. Use `input` for previous output.');
  }
  if (node.type === 'webhook') {
    html += _pbFieldInput(nid, 'url', 'URL', config.url || '', 'https://...');
    html += _pbFieldSelect(nid, 'method', 'Method', ['GET','POST','PUT','DELETE'], config.method || 'POST');
    html += _pbFieldTextarea(nid, 'body', 'Body (JSON)', config.body || '', '{"key": "{{input}}"}');
  }  if (node.type === 'notify') {
    html += _pbFieldInput(nid, 'title', 'Conversation title', config.title || '', 'e.g. Daily standup summary');
  }  if (node.type === 'delay') {
    html += _pbFieldInput(nid, 'ms', 'Delay (ms)', config.ms || '1000', 'Milliseconds to wait');
  }
  if (node.type === 'browser') {
    html += _pbFieldInput(nid, 'url', 'URL', config.url || '', 'Page URL to open/interact with');
    html += _pbFieldTextarea(nid, 'instruction', 'Browser instruction', config.instruction || '', 'What to do on this page');
  }
  if (node.type === 'figma') {
    html += _pbFieldTextarea(nid, 'instruction', 'Figma instruction', config.instruction || '', 'What to do in Figma');
  }
  if (node.type === 'loop') {
    html += _pbFieldInput(nid, 'maxIterations', 'Max iterations', config.maxIterations || '10', '');
    html += _pbFieldTextarea(nid, 'condition', 'Stop condition', config.condition || '', 'JS expression — true = stop loop. Use `iteration` and `input`.');
  }
  if (node.type === 'agent') {
    html += _pbFieldInput(nid, 'agentName', 'Agent name', config.agentName || '', 'Name of the agent to invoke');
  }

  return html;
}

function _pbFieldInput(nid, key, label, value, placeholder) {
  return '<div class="pb-field-row">' +
    '<label class="pb-field-lbl">' + label + '</label>' +
    '<input class="pb-field-input" value="' + _esc(value) + '" placeholder="' + _esc(placeholder) + '" ' +
      'oninput="_pbUpdateNodeConfig(\'' + nid + '\',\'' + key + '\',this.value)">' +
  '</div>';
}

function _pbFieldTextarea(nid, key, label, value, placeholder) {
  return '<div class="pb-field-row">' +
    '<label class="pb-field-lbl">' + label + '</label>' +
    '<textarea class="pb-field-textarea" rows="3" placeholder="' + _esc(placeholder) + '" ' +
      'oninput="_pbUpdateNodeConfig(\'' + nid + '\',\'' + key + '\',this.value)">' + _esc(value) + '</textarea>' +
  '</div>';
}

function _pbFieldSelect(nid, key, label, options, value) {
  var opts = options.map(function(o) {
    return '<option value="' + o + '"' + (value === o ? ' selected' : '') + '>' + o + '</option>';
  }).join('');
  return '<div class="pb-field-row">' +
    '<label class="pb-field-lbl">' + label + '</label>' +
    '<select class="pb-field-select" onchange="_pbUpdateNodeConfig(\'' + nid + '\',\'' + key + '\',this.value)">' + opts + '</select>' +
  '</div>';
}

function _pbUpdateNode(nodeId, key, val) {
  if (!_pbCanvas) return;
  var update = {}; update[key] = val;
  _pbCanvas.updateNodeConfig(nodeId, update);
  _pbDirty = true;
}

function _pbUpdateNodeConfig(nodeId, key, val) {
  if (!_pbCanvas) return;
  var node = _pbCanvas.getNodeById(nodeId);
  if (!node) return;
  var config = Object.assign({}, node.config || {});
  config[key] = val;
  _pbCanvas.updateNodeConfig(nodeId, { config: config });
  _pbDirty = true;
}

// ── Save ─────────────────────────────────────────────────────────────────

async function savePipelineToTask(taskId) {
  if (!_pbCanvas) return;
  var pipeline = _pbCanvas.getPipeline();

  try {
    if (taskId) {
      await fetch('/api/tasks/' + taskId, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ pipeline: pipeline }),
      });
      // Keep _draft in sync so the main Save form doesn't overwrite with stale pipeline
      if (typeof _draft !== 'undefined' && _draft && _draft.id === taskId) {
        _draft.pipeline = pipeline;
      }
      if (typeof showToast === 'function') showToast('Pipeline saved');
      if (typeof fetchTasks === 'function') fetchTasks();
    } else {
      // If no taskId, this is the builder for a new/generated automation draft.
      if (typeof _draft !== 'undefined' && _draft) {
        _draft.pipeline = pipeline;
        _draft.kind = 'pipeline';
        if (!_draft.title || !_draft.title.trim()) _draft.title = 'Generated automation';
        if (typeof submitAutomation === 'function') {
          var saved = await submitAutomation();
          if (!saved) return;
        } else {
          if (typeof _renderDetailKindRows === 'function') _renderDetailKindRows();
          if (typeof showToast === 'function') showToast('Pipeline saved to draft');
        }
      }
    }
    _pbDirty = false;
    closePipelineBuilder();
  } catch (e) {
    if (typeof showToast === 'function') showToast('Failed to save pipeline: ' + e.message);
  }
}

// ── Escape helper ────────────────────────────────────────────────────────

function _esc(s) {
  return String(s || '').replace(/&/g,'&amp;').replace(/"/g,'&quot;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
}
