// ── Pipeline Canvas — Low-level node graph renderer ───────────────────────
// Used by automation-builder.js to render/edit pipeline graphs.
//
// Public API:
//   initCanvas(hostEl, pipeline, options)   — mount into hostEl
//   getCanvas(canvasId)                     — get canvas controller
//
// Canvas controller:
//   .getPipeline()           — { nodes, edges }
//   .addNode(type, x, y)
//   .removeNode(id)
//   .addEdge(fromId, fromPort, toId, toPort)
//   .removeEdge(id)
//   .selectNode(id)
//   .fitAll()
//   .destroy()
//   .onChange(callback)      — fires when graph changes

var pipelineCanvas = (function () {

  var _canvases = {};
  var _nextId = 1;
  function uid(prefix) { return (prefix || 'n') + (_nextId++); }

  // ── Node type catalogue ─────────────────────────────────────────────────

  var NODE_TYPES = {
    trigger:   { label: 'Trigger',   icon: 'ti-bolt',              color: '#6366f1', ports: { out: ['out'] } },
    prompt:    { label: 'Prompt',    icon: 'ti-message-circle',    color: '#0ea5e9', ports: { in: ['in'],  out: ['out'] } },
    condition: { label: 'Condition', icon: 'ti-git-branch',        color: '#f59e0b', ports: { in: ['in'],  out: ['true', 'false'] } },
    shell:     { label: 'Shell',     icon: 'ti-terminal-2',        color: '#10b981', ports: { in: ['in'],  out: ['out'] } },
    browser:   { label: 'Browser',   icon: 'ti-world-www',         color: '#3b82f6', ports: { in: ['in'],  out: ['out'] } },
    figma:     { label: 'Figma',     icon: 'ti-brand-figma',       color: '#a855f7', ports: { in: ['in'],  out: ['out'] } },
    agent:     { label: 'Agent',     icon: 'ti-robot',             color: '#ec4899', ports: { in: ['in'],  out: ['out'] } },
    loop:      { label: 'Loop',      icon: 'ti-repeat',            color: '#f97316', ports: { in: ['in'],  out: ['body', 'done'] } },
    webhook:   { label: 'Webhook',   icon: 'ti-webhook',           color: '#14b8a6', ports: { in: ['in'],  out: ['out'] } },
    delay:     { label: 'Delay',     icon: 'ti-clock-pause',       color: '#6b7280', ports: { in: ['in'],  out: ['out'] } },
    code:      { label: 'Code',      icon: 'ti-code',              color: '#8b5cf6', ports: { in: ['in'],  out: ['out'] } },
  };

  var NODE_W = 160;
  var NODE_H = 72;
  var PORT_R = 5;

  // ── Init ────────────────────────────────────────────────────────────────

  function initCanvas(hostEl, pipeline, opts) {
    var id = uid('c');
    opts = opts || {};

    var state = {
      id:        id,
      nodes:     [],
      edges:     [],
      selected:  null,         // selected node id
      pan:       { x: 0, y: 0 },
      zoom:      1,
      dragging:  null,         // { nodeId, startX, startY, origX, origY }
      connecting:null,         // { fromNodeId, fromPort, fromSide, mx, my }
      onChange:  opts.onChange || null,
    };

    // Hydrate from pipeline
    if (pipeline && pipeline.nodes) {
      state.nodes = pipeline.nodes.map(function(n) { return Object.assign({}, n); });
    }
    if (pipeline && pipeline.edges) {
      state.edges = pipeline.edges.map(function(e) { return Object.assign({}, e); });
    }

    _canvases[id] = state;

    // Build DOM
    hostEl.innerHTML = '';
    hostEl.style.position = 'relative';
    hostEl.style.overflow = 'hidden';
    hostEl.style.background = 'var(--fau-bg, #111)';
    hostEl.style.width = '100%';
    hostEl.style.height = '100%';

    var viewport = document.createElement('div');
    viewport.className = 'pcv-viewport';
    viewport.id = 'pcv-viewport-' + id;
    viewport.style.cssText = 'position:absolute;top:0;left:0;transform-origin:0 0;width:5000px;height:5000px;';

    var svgEl = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svgEl.id = 'pcv-svg-' + id;
    svgEl.style.cssText = 'position:absolute;top:0;left:0;width:5000px;height:5000px;pointer-events:none;';
    svgEl.setAttribute('width', '5000');
    svgEl.setAttribute('height', '5000');

    var nodeLayer = document.createElement('div');
    nodeLayer.id = 'pcv-nodes-' + id;
    nodeLayer.style.cssText = 'position:absolute;top:0;left:0;width:5000px;height:5000px;';

    viewport.appendChild(svgEl);
    viewport.appendChild(nodeLayer);
    hostEl.appendChild(viewport);

    // Events on host
    hostEl.addEventListener('wheel', function(e) { _onWheel(id, e); }, { passive: false });
    hostEl.addEventListener('pointerdown', function(e) { _onHostDown(id, e); });
    hostEl.addEventListener('pointermove', function(e) { _onHostMove(id, e); });
    hostEl.addEventListener('pointerup',   function(e) { _onHostUp(id, e); });
    hostEl.addEventListener('pointerleave',function(e) { _onHostUp(id, e); });

    // Delete key
    hostEl.setAttribute('tabindex', '0');
    hostEl.addEventListener('keydown', function(e) {
      if ((e.key === 'Delete' || e.key === 'Backspace') && state.selected) {
        _removeNode(id, state.selected);
      }
    });

    _redrawAll(id);
    return _controller(id);
  }

  // ── Controller ──────────────────────────────────────────────────────────

  function _controller(canvasId) {
    return {
      getPipeline: function() {
        var s = _canvases[canvasId];
        if (!s) return { nodes: [], edges: [] };
        return { nodes: s.nodes.slice(), edges: s.edges.slice() };
      },
      addNode: function(type, x, y) { return _addNode(canvasId, type, x, y); },
      removeNode: function(id) { _removeNode(canvasId, id); },
      addEdge: function(fId, fP, tId, tP) { return _addEdge(canvasId, fId, fP, tId, tP); },
      removeEdge: function(id) { _removeEdge(canvasId, id); },
      selectNode: function(id) { _select(canvasId, id); },
      fitAll: function() { _fitAll(canvasId); },
      destroy: function() { _destroy(canvasId); },
      onChange: function(cb) { if (_canvases[canvasId]) _canvases[canvasId].onChange = cb; },
      getNodeById: function(id) {
        var s = _canvases[canvasId];
        return s ? s.nodes.find(function(n) { return n.id === id; }) : null;
      },
      updateNodeConfig: function(nodeId, config) {
        var s = _canvases[canvasId];
        if (!s) return;
        var n = s.nodes.find(function(n) { return n.id === nodeId; });
        if (n) { Object.assign(n, config); _redrawNode(canvasId, nodeId); _fire(canvasId); }
      },
    };
  }

  // ── Node CRUD ───────────────────────────────────────────────────────────

  function _addNode(canvasId, type, x, y) {
    var s = _canvases[canvasId];
    if (!s) return;
    var def = NODE_TYPES[type] || NODE_TYPES.prompt;
    var node = { id: uid('n'), type: type, label: def.label, x: x || 100, y: y || 100, config: {} };
    s.nodes.push(node);
    _renderNode(canvasId, node);
    _fire(canvasId);
    return node;
  }

  function _removeNode(canvasId, nodeId) {
    var s = _canvases[canvasId];
    if (!s) return;
    s.nodes = s.nodes.filter(function(n) { return n.id !== nodeId; });
    // Remove connected edges
    s.edges = s.edges.filter(function(e) { return e.from !== nodeId && e.to !== nodeId; });
    if (s.selected === nodeId) s.selected = null;
    _redrawAll(canvasId);
    _fire(canvasId);
  }

  // ── Edge CRUD ───────────────────────────────────────────────────────────

  function _addEdge(canvasId, fromId, fromPort, toId, toPort) {
    var s = _canvases[canvasId];
    if (!s) return;
    // Prevent duplicate edges
    var dup = s.edges.find(function(e) { return e.from === fromId && e.fromPort === fromPort && e.to === toId && e.toPort === toPort; });
    if (dup) return dup;
    var edge = { id: uid('e'), from: fromId, fromPort: fromPort, to: toId, toPort: toPort };
    s.edges.push(edge);
    _redrawEdges(canvasId);
    _fire(canvasId);
    return edge;
  }

  function _removeEdge(canvasId, edgeId) {
    var s = _canvases[canvasId];
    if (!s) return;
    s.edges = s.edges.filter(function(e) { return e.id !== edgeId; });
    _redrawEdges(canvasId);
    _fire(canvasId);
  }

  // ── Selection ───────────────────────────────────────────────────────────

  function _select(canvasId, nodeId) {
    var s = _canvases[canvasId];
    if (!s) return;
    s.selected = nodeId;
    // Update visual selection
    document.querySelectorAll('[data-cv="' + canvasId + '"]').forEach(function(el) {
      el.classList.remove('pcv-selected');
    });
    if (nodeId) {
      var el = document.querySelector('[data-cv="' + canvasId + '"][data-nid="' + nodeId + '"]');
      if (el) el.classList.add('pcv-selected');
    }
    if (s.onChange) s.onChange('select', nodeId);
  }

  // ── Render ──────────────────────────────────────────────────────────────

  function _redrawAll(canvasId) {
    var s = _canvases[canvasId];
    if (!s) return;
    var layer = document.getElementById('pcv-nodes-' + canvasId);
    if (layer) layer.innerHTML = '';
    s.nodes.forEach(function(n) { _renderNode(canvasId, n); });
    _redrawEdges(canvasId);
  }

  function _renderNode(canvasId, node) {
    var s = _canvases[canvasId];
    var layer = document.getElementById('pcv-nodes-' + canvasId);
    if (!s || !layer) return;

    var def = NODE_TYPES[node.type] || NODE_TYPES.prompt;

    var el = document.createElement('div');
    el.className = 'pcv-node' + (s.selected === node.id ? ' pcv-selected' : '');
    el.dataset.cv  = canvasId;
    el.dataset.nid = node.id;
    el.style.cssText = 'position:absolute;width:' + NODE_W + 'px;height:' + NODE_H + 'px;' +
      'left:' + node.x + 'px;top:' + node.y + 'px;' +
      'background:var(--fau-surface,#1e1e2e);border:2px solid ' + def.color + ';border-radius:10px;' +
      'display:flex;flex-direction:column;align-items:center;justify-content:center;gap:3px;' +
      'cursor:grab;user-select:none;z-index:1;box-sizing:border-box;padding:6px;';

    el.innerHTML =
      '<div style="color:' + def.color + ';font-size:16px"><i class="ti ' + def.icon + '"></i></div>' +
      '<div style="font-size:11px;font-weight:600;color:var(--fau-text,#fff);text-align:center;line-height:1.2;max-width:140px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">' +
        (node.label || def.label) +
      '</div>' +
      '<div style="font-size:9px;color:var(--fau-text-muted,#888);text-transform:uppercase;">' + node.type + '</div>';

    // Port dots
    var inPorts  = (def.ports && def.ports.in)  || [];
    var outPorts = (def.ports && def.ports.out) || [];

    inPorts.forEach(function(p, i) {
      var dot = document.createElement('div');
      var top = (NODE_H / (inPorts.length + 1)) * (i + 1);
      dot.className = 'pcv-port pcv-port-in';
      dot.dataset.cv   = canvasId;
      dot.dataset.nid  = node.id;
      dot.dataset.port = p;
      dot.dataset.side = 'in';
      dot.style.cssText = 'position:absolute;left:-' + PORT_R + 'px;top:' + (top - PORT_R) + 'px;' +
        'width:' + (PORT_R * 2) + 'px;height:' + (PORT_R * 2) + 'px;border-radius:50%;' +
        'background:var(--fau-surface3,#333);border:2px solid ' + def.color + ';cursor:crosshair;z-index:2;';
      el.appendChild(dot);
    });

    outPorts.forEach(function(p, i) {
      var dot = document.createElement('div');
      var top = (NODE_H / (outPorts.length + 1)) * (i + 1);
      var portColor = p === 'false' ? '#ef4444' : (p === 'true' ? '#22c55e' : def.color);
      dot.className = 'pcv-port pcv-port-out';
      dot.dataset.cv   = canvasId;
      dot.dataset.nid  = node.id;
      dot.dataset.port = p;
      dot.dataset.side = 'out';
      dot.style.cssText = 'position:absolute;right:-' + PORT_R + 'px;top:' + (top - PORT_R) + 'px;' +
        'width:' + (PORT_R * 2) + 'px;height:' + (PORT_R * 2) + 'px;border-radius:50%;' +
        'background:var(--fau-surface3,#333);border:2px solid ' + portColor + ';cursor:crosshair;z-index:2;';
      if (p !== 'in') {
        var lbl = document.createElement('span');
        lbl.style.cssText = 'position:absolute;left:12px;top:-1px;font-size:9px;color:' + portColor + ';white-space:nowrap;';
        lbl.textContent = p;
        dot.appendChild(lbl);
      }
      el.appendChild(dot);
    });

    // Delete button (shown on hover)
    var del = document.createElement('button');
    del.className = 'pcv-node-del';
    del.dataset.nid = node.id;
    del.dataset.cv  = canvasId;
    del.style.cssText = 'position:absolute;top:-8px;right:-8px;background:#ef4444;border:none;' +
      'border-radius:50%;width:16px;height:16px;color:#fff;font-size:10px;cursor:pointer;' +
      'display:none;align-items:center;justify-content:center;z-index:3;padding:0;line-height:1;';
    del.innerHTML = '×';
    del.onclick = function(e) { e.stopPropagation(); _removeNode(canvasId, node.id); };
    el.appendChild(del);

    el.addEventListener('mouseenter', function() { del.style.display = 'flex'; });
    el.addEventListener('mouseleave', function() { del.style.display = 'none'; });

    el.addEventListener('pointerdown', function(e) { _onNodeDown(canvasId, node.id, e); });

    layer.appendChild(el);
  }

  function _redrawNode(canvasId, nodeId) {
    var s = _canvases[canvasId];
    if (!s) return;
    var layer = document.getElementById('pcv-nodes-' + canvasId);
    if (!layer) return;
    var old = layer.querySelector('[data-nid="' + nodeId + '"]');
    if (old) old.remove();
    var node = s.nodes.find(function(n) { return n.id === nodeId; });
    if (node) _renderNode(canvasId, node);
    _redrawEdges(canvasId);
  }

  function _redrawEdges(canvasId) {
    var s = _canvases[canvasId];
    var svgEl = document.getElementById('pcv-svg-' + canvasId);
    if (!s || !svgEl) return;

    svgEl.innerHTML = '';

    // Defs for arrowhead
    var defs = document.createElementNS('http://www.w3.org/2000/svg', 'defs');
    var marker = document.createElementNS('http://www.w3.org/2000/svg', 'marker');
    marker.setAttribute('id', 'arrowhead-' + canvasId);
    marker.setAttribute('viewBox', '0 -5 10 10');
    marker.setAttribute('refX', '9');
    marker.setAttribute('refY', '0');
    marker.setAttribute('markerWidth', '6');
    marker.setAttribute('markerHeight', '6');
    marker.setAttribute('orient', 'auto');
    var arrow = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    arrow.setAttribute('d', 'M0,-5L10,0L0,5');
    arrow.setAttribute('fill', '#6366f1');
    marker.appendChild(arrow);
    defs.appendChild(marker);
    svgEl.appendChild(defs);

    s.edges.forEach(function(e) {
      var fromNode = s.nodes.find(function(n) { return n.id === e.from; });
      var toNode   = s.nodes.find(function(n) { return n.id === e.to; });
      if (!fromNode || !toNode) return;

      var fromDef = NODE_TYPES[fromNode.type] || NODE_TYPES.prompt;
      var toDef   = NODE_TYPES[toNode.type]   || NODE_TYPES.prompt;

      var fromPorts = (fromDef.ports && fromDef.ports.out) || ['out'];
      var toPorts   = (toDef.ports   && toDef.ports.in)   || ['in'];

      var fi = Math.max(0, fromPorts.indexOf(e.fromPort));
      var ti = Math.max(0, toPorts.indexOf(e.toPort));

      var x1 = fromNode.x + NODE_W + PORT_R;
      var y1 = fromNode.y + (NODE_H / (fromPorts.length + 1)) * (fi + 1);
      var x2 = toNode.x - PORT_R;
      var y2 = toNode.y + (NODE_H / (toPorts.length + 1)) * (ti + 1);

      var cx = Math.abs(x2 - x1) * 0.5;
      var portColor = e.fromPort === 'false' ? '#ef4444' : (e.fromPort === 'true' ? '#22c55e' : fromDef.color);

      var path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
      path.setAttribute('d', 'M' + x1 + ',' + y1 + ' C' + (x1 + cx) + ',' + y1 + ' ' + (x2 - cx) + ',' + y2 + ' ' + x2 + ',' + y2);
      path.setAttribute('stroke', portColor);
      path.setAttribute('stroke-width', '2');
      path.setAttribute('fill', 'none');
      path.setAttribute('marker-end', 'url(#arrowhead-' + canvasId + ')');
      path.setAttribute('opacity', '0.8');
      path.style.pointerEvents = 'auto';
      path.style.cursor = 'pointer';
      path.addEventListener('click', function() { _removeEdge(canvasId, e.id); });
      svgEl.appendChild(path);
    });

    // Draw in-progress connection wire
    if (s.connecting) {
      var conn = s.connecting;
      var wire = document.createElementNS('http://www.w3.org/2000/svg', 'path');
      var cx2 = Math.abs(conn.mx - conn.x1) * 0.5;
      wire.setAttribute('d', 'M' + conn.x1 + ',' + conn.y1 + ' C' + (conn.x1 + cx2) + ',' + conn.y1 + ' ' + (conn.mx - cx2) + ',' + conn.my + ' ' + conn.mx + ',' + conn.my);
      wire.setAttribute('stroke', '#6366f1');
      wire.setAttribute('stroke-width', '2');
      wire.setAttribute('fill', 'none');
      wire.setAttribute('stroke-dasharray', '6 3');
      wire.setAttribute('opacity', '0.6');
      svgEl.appendChild(wire);
    }
  }

  // ── Input events ────────────────────────────────────────────────────────

  function _onNodeDown(canvasId, nodeId, e) {
    // Check if clicking a port
    if (e.target.classList.contains('pcv-port')) { return; }
    e.stopPropagation();
    var s = _canvases[canvasId];
    if (!s) return;
    _select(canvasId, nodeId);
    var node = s.nodes.find(function(n) { return n.id === nodeId; });
    if (!node) return;
    s.dragging = { nodeId: nodeId, startX: e.clientX, startY: e.clientY, origX: node.x, origY: node.y };
    e.target.setPointerCapture(e.pointerId);
  }

  function _onHostDown(canvasId, e) {
    var s = _canvases[canvasId];
    if (!s) return;

    // Port click → start connecting
    if (e.target.classList.contains('pcv-port')) {
      e.stopPropagation();
      var side = e.target.dataset.side;
      if (side === 'out') {
        var nodeId = e.target.dataset.nid;
        var port   = e.target.dataset.port;
        var node   = s.nodes.find(function(n) { return n.id === nodeId; });
        if (!node) return;
        var def = NODE_TYPES[node.type] || NODE_TYPES.prompt;
        var outPorts = (def.ports && def.ports.out) || ['out'];
        var pi = Math.max(0, outPorts.indexOf(port));
        var hostRect = e.currentTarget.getBoundingClientRect();
        var viewport = document.getElementById('pcv-viewport-' + canvasId);
        var vpRect = viewport ? viewport.getBoundingClientRect() : hostRect;
        var vx = node.x + NODE_W + PORT_R;
        var vy = node.y + (NODE_H / (outPorts.length + 1)) * (pi + 1);
        s.connecting = { fromNodeId: nodeId, fromPort: port, x1: vx, y1: vy, mx: vx, my: vy };
      }
      return;
    }

    // Background pan
    if (e.target === e.currentTarget || e.target.id === 'pcv-nodes-' + canvasId || e.target.id === 'pcv-svg-' + canvasId) {
      _select(canvasId, null);
      s._panning = true;
      s._panStart = { x: e.clientX, y: e.clientY, px: s.pan.x, py: s.pan.y };
    }
  }

  function _onHostMove(canvasId, e) {
    var s = _canvases[canvasId];
    if (!s) return;

    // Node drag
    if (s.dragging) {
      var dx = (e.clientX - s.dragging.startX) / s.zoom;
      var dy = (e.clientY - s.dragging.startY) / s.zoom;
      var node = s.nodes.find(function(n) { return n.id === s.dragging.nodeId; });
      if (node) {
        node.x = Math.max(0, s.dragging.origX + dx);
        node.y = Math.max(0, s.dragging.origY + dy);
        var el = document.querySelector('[data-cv="' + canvasId + '"][data-nid="' + node.id + '"]');
        if (el) { el.style.left = node.x + 'px'; el.style.top = node.y + 'px'; }
        _redrawEdges(canvasId);
      }
    }

    // Pan
    if (s._panning && s._panStart) {
      s.pan.x = s._panStart.px + (e.clientX - s._panStart.x);
      s.pan.y = s._panStart.py + (e.clientY - s._panStart.y);
      _applyTransform(canvasId);
    }

    // Connecting wire
    if (s.connecting) {
      var hostRect = e.currentTarget.getBoundingClientRect();
      s.connecting.mx = (e.clientX - hostRect.left - s.pan.x) / s.zoom;
      s.connecting.my = (e.clientY - hostRect.top  - s.pan.y) / s.zoom;
      _redrawEdges(canvasId);
    }
  }

  function _onHostUp(canvasId, e) {
    var s = _canvases[canvasId];
    if (!s) return;

    if (s.dragging) {
      _fire(canvasId);
      s.dragging = null;
    }

    if (s._panning) { s._panning = false; s._panStart = null; }

    // Complete connection
    if (s.connecting) {
      var conn = s.connecting;
      s.connecting = null;
      // Check if pointer is over an in-port
      if (e.target.classList.contains('pcv-port') && e.target.dataset.side === 'in') {
        var toNodeId = e.target.dataset.nid;
        var toPort   = e.target.dataset.port;
        if (toNodeId !== conn.fromNodeId) {
          _addEdge(canvasId, conn.fromNodeId, conn.fromPort, toNodeId, toPort);
        }
      }
      _redrawEdges(canvasId);
    }
  }

  function _onWheel(canvasId, e) {
    var s = _canvases[canvasId];
    if (!s) return;
    e.preventDefault();
    var delta = e.deltaY > 0 ? 0.9 : 1.1;
    s.zoom = Math.min(3, Math.max(0.2, s.zoom * delta));
    _applyTransform(canvasId);
  }

  function _applyTransform(canvasId) {
    var s = _canvases[canvasId];
    var viewport = document.getElementById('pcv-viewport-' + canvasId);
    if (!s || !viewport) return;
    viewport.style.transform = 'translate(' + s.pan.x + 'px,' + s.pan.y + 'px) scale(' + s.zoom + ')';
  }

  // ── Fit all ─────────────────────────────────────────────────────────────

  function _fitAll(canvasId) {
    var s = _canvases[canvasId];
    if (!s || !s.nodes.length) return;
    var hostEl = document.getElementById('pcv-viewport-' + canvasId);
    if (!hostEl) return;
    var parent = hostEl.parentElement;

    var minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    s.nodes.forEach(function(n) {
      minX = Math.min(minX, n.x);
      minY = Math.min(minY, n.y);
      maxX = Math.max(maxX, n.x + NODE_W);
      maxY = Math.max(maxY, n.y + NODE_H);
    });

    var pad = 60;
    var graphW = maxX - minX + pad * 2;
    var graphH = maxY - minY + pad * 2;
    var parentW = parent.clientWidth  || 600;
    var parentH = parent.clientHeight || 400;

    var zoom = Math.min(parentW / graphW, parentH / graphH, 1.5);
    var cx = parentW / 2 - ((minX + maxX) / 2) * zoom;
    var cy = parentH / 2 - ((minY + maxY) / 2) * zoom;

    s.zoom  = zoom;
    s.pan.x = cx;
    s.pan.y = cy;
    _applyTransform(canvasId);
  }

  // ── Helpers ─────────────────────────────────────────────────────────────

  function _fire(canvasId) {
    var s = _canvases[canvasId];
    if (s && s.onChange) s.onChange('change', { nodes: s.nodes.slice(), edges: s.edges.slice() });
  }

  function _destroy(canvasId) {
    delete _canvases[canvasId];
  }

  function getCanvas(canvasId) {
    return _canvases[canvasId] ? _controller(canvasId) : null;
  }

  return {
    initCanvas:  initCanvas,
    getCanvas:   getCanvas,
    NODE_TYPES:  NODE_TYPES,
  };
})();
