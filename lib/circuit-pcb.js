// ── PCB layout (DSL → board model) ──────────────────────────────────────
// Pure JS, no deps. Turns a circuit DSL into a physical board model: places
// footprints, assigns nets to copper pads, sizes the board outline, and builds
// a ratsnest (airwires) for the autorouter (circuit-pcb route step, phase 3).
//
// layoutPcb(doc, opts) → {
//   ok, errors, warnings, units:'mm',
//   board:   { w, h },
//   components: [{ id, type, ref, x, y, rot, footprint, kind, pads:[...] }],
//   pads:    [{ i, compId, num, net, x, y, shape, w, h, drill, layer }],
//   nets:    [{ id, isPower, pads:[padIndex...] }],
//   ratsnest:[{ net, a:{x,y}, b:{x,y} }],
//   traces:  [],   // filled by routePcb (phase 3)
//   vias:    [],
// }

import { buildGraph } from './circuit-graph.js';
import { getFootprint } from './circuit-footprints.js';

const PLACE_GAP = 2.0;     // mm gap between component courtyards
const BOARD_MARGIN = 3.0;  // mm border around all parts

// Rotate a component-local mm point by 0/90/180/270 (SVG axis: +y down).
function rotMM(x, y, deg) {
  const d = ((deg % 360) + 360) % 360;
  switch (d) {
    case 90:  return { x: -y, y: x };
    case 180: return { x: -x, y: -y };
    case 270: return { x: y, y: -x };
    default:  return { x, y };
  }
}

// Default reference-designator prefix per component family.
const REF_PREFIX = {
  resistor: 'R', potentiometer: 'RV', thermistor: 'RT',
  capacitor: 'C', capacitor_pol: 'C', inductor: 'L', crystal: 'Y',
  diode: 'D', zener: 'D', schottky: 'D', photodiode: 'D', led: 'D',
  npn: 'Q', pnp: 'Q', phototransistor: 'Q', nmos: 'Q', pmos: 'Q', njfet: 'Q', pjfet: 'Q',
  opamp: 'U', gate_and: 'U', gate_or: 'U', gate_not: 'U', gate_nand: 'U', gate_nor: 'U', gate_xor: 'U',
  vsource: 'V', isource: 'I', battery: 'BT', vcc: 'PWR', gnd: 'GND',
  fuse: 'F', lamp: 'LP', speaker: 'LS', buzzer: 'BZ', motor: 'M',
  switch_spst: 'SW', switch_push: 'SW', switch_spdt: 'SW',
  ammeter: 'MA', voltmeter: 'MV', transformer: 'T', relay: 'K', testpoint: 'TP',
};

/**
 * Lay out a circuit DSL onto a board.
 * @param {object} doc   circuit DSL (same shape as renderCircuit/validateCircuit)
 * @param {object} [opts]
 * @param {Object<string,'tht'|'smd'>} [opts.variants]  per-type footprint variant
 * @param {Object<string,{x,y,rot}>}   [opts.placements] manual component placement (mm)
 * @param {{w,h}} [opts.board]  fixed board size (mm); auto-sized when omitted
 * @param {number} [opts.columns]  auto-place column count
 */
export function layoutPcb(doc, opts = {}) {
  const graph = buildGraph(doc);
  const errors = [...graph.errors];
  const warnings = [...graph.warnings];
  if (!graph.ok) {
    return { ok: false, errors, warnings, units: 'mm', board: { w: 0, h: 0 }, components: [], pads: [], nets: [], ratsnest: [], traces: [], vias: [] };
  }

  const variants = opts.variants || {};
  const placements = opts.placements || {};

  // ── Resolve footprints + per-family reference designators ─────────────
  const refCount = new Map();
  const placed = [];
  let maxCourt = 4;
  for (const [id, c] of graph.components) {
    const fp = getFootprint(c.type, variants[c.type]);
    if (!fp) { warnings.push({ code: 'NO_FOOTPRINT', message: `no footprint for type "${c.type}"`, component: id }); continue; }
    const prefix = REF_PREFIX[c.type] || 'X';
    const n = (refCount.get(prefix) || 0) + 1;
    refCount.set(prefix, n);
    maxCourt = Math.max(maxCourt, fp.courtyard.w, fp.courtyard.h);
    placed.push({ id, type: c.type, comp: c, fp, ref: `${prefix}${n}` });
  }

  // ── Placement: manual overrides, else a non-overlapping auto-grid ─────
  const cell = maxCourt + PLACE_GAP;
  const cols = Math.max(1, opts.columns || Math.ceil(Math.sqrt(placed.length)) || 1);
  // Preserve schematic intent: order by schematic (y, x) before grid-filling.
  const order = [...placed].sort((a, b) => {
    const ay = Number(a.comp.y) || 0, by = Number(b.comp.y) || 0;
    if (ay !== by) return ay - by;
    return (Number(a.comp.x) || 0) - (Number(b.comp.x) || 0);
  });
  order.forEach((p, idx) => {
    const man = placements[p.id];
    if (man && Number.isFinite(man.x) && Number.isFinite(man.y)) {
      p.x = man.x; p.y = man.y; p.rot = Number(man.rot) || 0;
    } else {
      const col = idx % cols, row = Math.floor(idx / cols);
      p.x = BOARD_MARGIN + cell / 2 + col * cell;
      p.y = BOARD_MARGIN + cell / 2 + row * cell;
      p.rot = 0;
    }
  });

  // ── Flatten pads to absolute board coords + assign nets ──────────────
  const pads = [];
  const components = [];
  for (const p of placed) {
    const inv = invertPinMap(p.fp.pinMap); // padNum → [pinNames]
    const compPads = [];
    for (const pad of p.fp.pads) {
      const r = rotMM(pad.x, pad.y, p.rot);
      const absX = +(p.x + r.x).toFixed(3);
      const absY = +(p.y + r.y).toFixed(3);
      // Resolve the net for this pad via the pin(s) it carries.
      let net = null;
      const pins = inv.get(pad.num) || [];
      for (const pinName of pins) {
        const nid = graph.pinToNet.get(`${p.id}.${pinName}`);
        if (nid) { net = nid; break; }
      }
      const padObj = {
        i: pads.length, compId: p.id, ref: p.ref, num: pad.num, net,
        x: absX, y: absY, shape: pad.shape, w: pad.w, h: pad.h,
        drill: pad.drill, layer: p.fp.kind === 'SMD' ? 'top' : 'through',
      };
      pads.push(padObj);
      compPads.push(padObj);
    }
    components.push({
      id: p.id, type: p.type, ref: p.ref, value: p.comp.value ?? null,
      x: p.x, y: p.y, rot: p.rot,
      footprint: p.fp.name, kind: p.fp.kind, body: p.fp.body, courtyard: p.fp.courtyard,
      polarMark: p.fp.polarMark ?? null, pads: compPads,
    });
  }

  // ── Board outline ─────────────────────────────────────────────────────
  let board;
  if (opts.board && opts.board.w > 0 && opts.board.h > 0) {
    board = { w: opts.board.w, h: opts.board.h };
  } else {
    let maxX = 0, maxY = 0;
    for (const c of components) {
      maxX = Math.max(maxX, c.x + c.courtyard.w / 2);
      maxY = Math.max(maxY, c.y + c.courtyard.h / 2);
    }
    board = { w: +(maxX + BOARD_MARGIN).toFixed(2), h: +(maxY + BOARD_MARGIN).toFixed(2) };
  }

  // ── Nets + ratsnest (MST per net) ─────────────────────────────────────
  const netMap = new Map();
  for (const pad of pads) {
    if (!pad.net) continue;
    if (!netMap.has(pad.net)) netMap.set(pad.net, { id: pad.net, isPower: null, pads: [] });
    netMap.get(pad.net).pads.push(pad.i);
  }
  for (const [, gnet] of graph.nets) {
    if (gnet.isPower && netMap.has(gnet.id)) netMap.get(gnet.id).isPower = gnet.isPower;
  }
  const nets = [...netMap.values()];

  const ratsnest = [];
  for (const net of nets) {
    if (net.pads.length < 2) continue;
    const pts = net.pads.map(i => ({ i, x: pads[i].x, y: pads[i].y }));
    for (const e of primMST(pts)) {
      ratsnest.push({ net: net.id, a: { x: e.a.x, y: e.a.y }, b: { x: e.b.x, y: e.b.y }, pads: [e.a.i, e.b.i] });
    }
  }

  return {
    ok: errors.length === 0, errors, warnings, units: 'mm',
    board, components, pads, nets, ratsnest, traces: [], vias: [],
  };
}

// padNum → [pinName, ...] (a pad may carry more than one schematic pin name).
function invertPinMap(pinMap) {
  const m = new Map();
  for (const [pin, pad] of Object.entries(pinMap)) {
    if (!m.has(pad)) m.set(pad, []);
    m.get(pad).push(pin);
  }
  return m;
}

// Minimum spanning tree (Prim) over points → list of { a, b } edges.
function primMST(points) {
  const edges = [];
  if (points.length < 2) return edges;
  const inTree = new Set([0]);
  const dist = points.map((p, i) => (i === 0 ? 0 : sq(p, points[0])));
  const from = points.map(() => 0);
  while (inTree.size < points.length) {
    let best = -1, bestD = Infinity;
    for (let i = 0; i < points.length; i++) {
      if (inTree.has(i)) continue;
      if (dist[i] < bestD) { bestD = dist[i]; best = i; }
    }
    if (best === -1) break;
    inTree.add(best);
    edges.push({ a: points[from[best]], b: points[best] });
    for (let i = 0; i < points.length; i++) {
      if (inTree.has(i)) continue;
      const d = sq(points[best], points[i]);
      if (d < dist[i]) { dist[i] = d; from[i] = best; }
    }
  }
  return edges;
}
function sq(a, b) { const dx = a.x - b.x, dy = a.y - b.y; return dx * dx + dy * dy; }

// ── Autorouter ──────────────────────────────────────────────────────────
// A 2-layer maze (A*) router with vias. Routes each ratsnest edge on a grid;
// top layer biases horizontal, bottom biases vertical (classic 2-layer style).
// Nets that can't be completed stay as ratsnest airwires + an UNROUTED warning.
//
// routePcb(board, opts) → board clone with { traces, vias, ratsnest(unrouted),
//   routed: { total, completed, failed } }

const VIA_COST = 12;        // grid-steps penalty for a layer change
const TURN_COST = 1;        // penalty against the layer's preferred direction

/**
 * Route a laid-out board.
 * @param {object} board  output of layoutPcb()
 * @param {object} [opts]
 * @param {number} [opts.gridPitch=0.635] router grid pitch (mm)
 * @param {number} [opts.clearance=0.3]   copper-to-copper clearance (mm)
 * @param {number} [opts.traceWidth=0.4]  trace width (mm)
 * @param {number} [opts.maxCells=400000] grid-cell safety cap (auto-coarsens)
 */
export function routePcb(board, opts = {}) {
  const out = {
    ...board,
    traces: [], vias: [],
    warnings: [...(board.warnings || [])],
    ratsnest: [],
    routed: { total: 0, completed: 0, failed: 0 },
  };
  if (!board || !board.ok || !Array.isArray(board.pads) || board.pads.length === 0) {
    return out;
  }

  const clearance = num(opts.clearance, 0.3);
  const traceWidth = num(opts.traceWidth, 0.4);
  let pitch = num(opts.gridPitch, 0.8);
  const maxCells = num(opts.maxCells, 400000);

  const W = board.board.w, H = board.board.h;
  // Coarsen the grid if a fine pitch would blow the cell budget.
  let cols = Math.ceil(W / pitch) + 1;
  let rows = Math.ceil(H / pitch) + 1;
  while (cols * rows > maxCells && pitch < 4) {
    pitch *= 1.5;
    cols = Math.ceil(W / pitch) + 1;
    rows = Math.ceil(H / pitch) + 1;
  }
  const cellOf = (x, y) => ({ col: clampi(Math.round(x / pitch), 0, cols - 1), row: clampi(Math.round(y / pitch), 0, rows - 1) });
  const centerOf = (row, col) => ({ x: +(col * pitch).toFixed(3), y: +(row * pitch).toFixed(3) });
  const idx = (row, col) => row * cols + col;

  // routedOcc[layer]: 0 = free, else (netIndex+1) that owns the cell.
  const routedOcc = [new Int32Array(rows * cols), new Int32Array(rows * cols)];
  const LAYER = { top: 0, bottom: 1 };

  // Pad obstacle disks keyed by net (foreign pads block; same-net pads pass).
  // Each entry: { cells:Set(idx), layers:[bool top, bool bottom], net }
  // Keep-out radius includes the trace half-width plus a half-cell of slack so
  // a routed centerline (which only passes through cell centres) can never sag
  // closer than `clearance` to foreign copper between samples.
  const padBlocks = board.pads.map(p => {
    const half = Math.max(p.w, p.h) / 2 + clearance + traceWidth / 2 + pitch * 0.5;
    const rCells = Math.ceil(half / pitch);
    const { row, col } = cellOf(p.x, p.y);
    const cells = new Set();
    for (let dr = -rCells; dr <= rCells; dr++) {
      for (let dc = -rCells; dc <= rCells; dc++) {
        const rr = row + dr, cc = col + dc;
        if (rr < 0 || cc < 0 || rr >= rows || cc >= cols) continue;
        if ((dr * dr + dc * dc) * pitch * pitch <= half * half) cells.add(idx(rr, cc));
      }
    }
    const through = p.drill != null;
    return { net: p.net, cells, layers: [true, through], center: cellOf(p.x, p.y), padIndex: p.i };
  });

  // Order ratsnest edges shortest-first (Manhattan) for higher completion.
  const edges = [...board.ratsnest].sort((a, b) =>
    (Math.abs(a.a.x - a.b.x) + Math.abs(a.a.y - a.b.y)) - (Math.abs(b.a.x - b.b.x) + Math.abs(b.a.y - b.b.y)));

  const netIndexOf = new Map();
  board.nets.forEach((n, i) => netIndexOf.set(n.id, i + 1));

  for (const edge of edges) {
    out.routed.total++;
    const netI = netIndexOf.get(edge.net) || 0;

    // Build the blocked predicate for this net.
    const blocked = (layer, row, col) => {
      const id = idx(row, col);
      const occ = routedOcc[layer][id];
      if (occ !== 0 && occ !== netI) return true; // foreign trace
      // foreign pad disks on this layer
      for (const pb of padBlocks) {
        if (pb.net === edge.net) continue;
        if (!pb.layers[layer]) continue;
        if (pb.cells.has(id)) return true;
      }
      return false;
    };

    const start = pickCell(edge.a, cellOf);
    const goal = pickCell(edge.b, cellOf);
    const path = aStar(start, goal, { rows, cols, blocked, idx });
    if (!path) {
      out.ratsnest.push(edge);
      out.warnings.push({ code: 'UNROUTED', message: `net "${edge.net}" segment left as airwire (router could not complete it)`, net: edge.net });
      out.routed.failed++;
      continue;
    }

    // Mark occupancy (+ a one-cell clearance halo so foreign nets keep their
    // distance) and emit traces/vias.
    let runLayer = path[0].layer;
    let run = [centerOf(path[0].row, path[0].col)];
    for (let k = 0; k < path.length; k++) {
      const node = path[k];
      routedOcc[node.layer][idx(node.row, node.col)] = netI;
      for (const [dr, dc] of [[0, 1], [0, -1], [1, 0], [-1, 0]]) {
        const hr = node.row + dr, hc = node.col + dc;
        if (hr < 0 || hc < 0 || hr >= rows || hc >= cols) continue;
        const hid = idx(hr, hc);
        if (routedOcc[node.layer][hid] === 0) routedOcc[node.layer][hid] = netI; // reserve for clearance
      }
      if (k > 0 && node.layer !== path[k - 1].layer) {
        // via: close the run on the old layer, drop a via, start a new run
        const c = centerOf(path[k - 1].row, path[k - 1].col);
        run.push(c);
        if (run.length >= 2) out.traces.push({ net: edge.net, layer: layerName(runLayer, LAYER), width: traceWidth, points: simplify(run) });
        out.vias.push({ x: c.x, y: c.y, net: edge.net, drill: 0.4, outer: 0.8 });
        runLayer = node.layer;
        run = [c, centerOf(node.row, node.col)];
      } else {
        run.push(centerOf(node.row, node.col));
      }
    }
    if (run.length >= 2) out.traces.push({ net: edge.net, layer: layerName(runLayer, LAYER), width: traceWidth, points: simplify(run) });
    out.routed.completed++;
  }
  return out;
}

function layerName(l, LAYER) { return l === LAYER.bottom ? 'bottom' : 'top'; }
function pickCell(pt, cellOf) { const c = cellOf(pt.x, pt.y); return { row: c.row, col: c.col, layer: 0 }; }
function num(v, d) { return Number.isFinite(Number(v)) && Number(v) > 0 ? Number(v) : d; }
function clampi(v, lo, hi) { return v < lo ? lo : v > hi ? hi : v; }

// A* over a 2-layer grid. Nodes keyed layer*rows*cols + idx. Top (layer 0)
// biases horizontal moves; bottom (layer 1) biases vertical. Vias cost extra.
function aStar(start, goal, { rows, cols, blocked, idx }) {
  const key = (l, r, c) => (l * rows * cols) + r * cols + c;
  const open = new MinHeap();
  const g = new Map();
  const came = new Map();
  const h = (r, c) => Math.abs(r - goal.row) + Math.abs(c - goal.col);
  const startK = key(0, start.row, start.col);
  g.set(startK, 0);
  open.push(startK, h(start.row, start.col));
  const startNode = { layer: 0, row: start.row, col: start.col };
  const nodeOf = new Map([[startK, startNode]]);

  while (open.size) {
    const curK = open.pop();
    const cur = nodeOf.get(curK);
    if (cur.row === goal.row && cur.col === goal.col) return reconstruct(came, nodeOf, curK);
    const cg = g.get(curK);
    // same-layer 4-neighbours
    const moves = [
      { dr: 0, dc: 1, horiz: true }, { dr: 0, dc: -1, horiz: true },
      { dr: 1, dc: 0, horiz: false }, { dr: -1, dc: 0, horiz: false },
    ];
    for (const mv of moves) {
      const nr = cur.row + mv.dr, nc = cur.col + mv.dc;
      if (nr < 0 || nc < 0 || nr >= rows || nc >= cols) continue;
      if (blocked(cur.layer, nr, nc)) continue;
      const preferred = cur.layer === 0 ? mv.horiz : !mv.horiz;
      const step = 1 + (preferred ? 0 : 1); // bias against the off-axis direction
      const nk = key(cur.layer, nr, nc);
      const ng = cg + step;
      if (ng < (g.get(nk) ?? Infinity)) {
        g.set(nk, ng); came.set(nk, curK);
        nodeOf.set(nk, { layer: cur.layer, row: nr, col: nc });
        open.push(nk, ng + h(nr, nc));
      }
    }
    // via to the other layer (same cell)
    const ol = cur.layer ^ 1;
    if (!blocked(ol, cur.row, cur.col)) {
      const nk = key(ol, cur.row, cur.col);
      const ng = cg + 12; // VIA_COST
      if (ng < (g.get(nk) ?? Infinity)) {
        g.set(nk, ng); came.set(nk, curK);
        nodeOf.set(nk, { layer: ol, row: cur.row, col: cur.col });
        open.push(nk, ng + h(cur.row, cur.col));
      }
    }
  }
  return null;
}

function reconstruct(came, nodeOf, endK) {
  const path = [];
  let k = endK;
  while (k !== undefined) { path.push(nodeOf.get(k)); k = came.get(k); }
  return path.reverse();
}

// Drop collinear interior points from a polyline.
function simplify(points) {
  if (points.length <= 2) return points.slice();
  const out = [points[0]];
  for (let i = 1; i < points.length - 1; i++) {
    const a = out[out.length - 1], b = points[i], c = points[i + 1];
    const cross = (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);
    if (Math.abs(cross) > 1e-6) out.push(b);
  }
  out.push(points[points.length - 1]);
  return out;
}

// Tiny binary min-heap keyed by priority; stores opaque values.
class MinHeap {
  constructor() { this.v = []; this.p = []; }
  get size() { return this.v.length; }
  push(val, pri) {
    this.v.push(val); this.p.push(pri);
    let i = this.v.length - 1;
    while (i > 0) {
      const par = (i - 1) >> 1;
      if (this.p[par] <= this.p[i]) break;
      this.swap(i, par); i = par;
    }
  }
  pop() {
    const top = this.v[0];
    const lastV = this.v.pop(), lastP = this.p.pop();
    if (this.v.length) {
      this.v[0] = lastV; this.p[0] = lastP;
      let i = 0;
      for (;;) {
        const l = 2 * i + 1, r = 2 * i + 2; let s = i;
        if (l < this.v.length && this.p[l] < this.p[s]) s = l;
        if (r < this.v.length && this.p[r] < this.p[s]) s = r;
        if (s === i) break;
        this.swap(i, s); i = s;
      }
    }
    return top;
  }
  swap(a, b) {
    [this.v[a], this.v[b]] = [this.v[b], this.v[a]];
    [this.p[a], this.p[b]] = [this.p[b], this.p[a]];
  }
}
