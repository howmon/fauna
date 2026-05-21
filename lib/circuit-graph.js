// ── Circuit graph (DSL → net graph via union-find) ──────────────────────
// Used by both validate_circuit and (future) simulate_circuit.
//
// DSL doc shape:
//   {
//     title?: string,
//     grid?: number (default 10),
//     components: [{ id, type, x, y, rot?: 0|90|180|270, value?, props? }],
//     wires: [{ from: "compId.pinName", to: "compId.pinName" | { x, y } }]
//   }

import { SYMBOLS, resolvePin, getSymbol } from './circuit-symbols.js';

// ── Union-find ──────────────────────────────────────────────────────────
class DSU {
  constructor() { this.parent = new Map(); this.rank = new Map(); }
  add(x) { if (!this.parent.has(x)) { this.parent.set(x, x); this.rank.set(x, 0); } }
  find(x) {
    this.add(x);
    let r = x;
    while (this.parent.get(r) !== r) r = this.parent.get(r);
    while (this.parent.get(x) !== r) { const n = this.parent.get(x); this.parent.set(x, r); x = n; }
    return r;
  }
  union(a, b) {
    const ra = this.find(a), rb = this.find(b);
    if (ra === rb) return false;
    const sa = this.rank.get(ra), sb = this.rank.get(rb);
    if (sa < sb) this.parent.set(ra, rb);
    else if (sa > sb) this.parent.set(rb, ra);
    else { this.parent.set(rb, ra); this.rank.set(ra, sa + 1); }
    return true;
  }
}

function parsePinRef(ref) {
  if (typeof ref !== 'string') return null;
  const i = ref.indexOf('.');
  if (i <= 0 || i === ref.length - 1) return null;
  return { compId: ref.slice(0, i), pinName: ref.slice(i + 1) };
}

export function buildGraph(doc) {
  const errors = [];
  const warnings = [];

  if (!doc || typeof doc !== 'object') {
    return { ok: false, errors: [{ code: 'BAD_DOC', message: 'doc must be an object' }], warnings: [], nets: new Map(), pinToNet: new Map(), components: new Map() };
  }

  const components = new Map();
  const compList = Array.isArray(doc.components) ? doc.components : [];
  const wireList = Array.isArray(doc.wires) ? doc.wires : [];

  // Validate components
  for (const c of compList) {
    if (!c || !c.id || !c.type) {
      errors.push({ code: 'BAD_COMPONENT', message: 'component missing id or type', component: c && c.id });
      continue;
    }
    if (components.has(c.id)) {
      errors.push({ code: 'DUP_COMPONENT_ID', message: `duplicate component id "${c.id}"`, component: c.id });
      continue;
    }
    const sym = getSymbol(c.type);
    if (!sym) {
      errors.push({ code: 'UNKNOWN_TYPE', message: `unknown component type "${c.type}"`, component: c.id });
      continue;
    }
    components.set(c.id, { ...c, _sym: sym });
  }

  // Union-find over wires
  const dsu = new DSU();
  // seed: every (validated) pin gets a node
  for (const [id, c] of components) {
    for (const pinName of Object.keys(c._sym.pins)) {
      dsu.add(`${id}.${pinName}`);
    }
  }

  // Coordinate endpoints (for wires that go to {x,y}) get their own union key
  function coordKey(p) { return `@${p.x},${p.y}`; }

  for (let i = 0; i < wireList.length; i++) {
    const w = wireList[i];
    if (!w || w.from == null || w.to == null) {
      errors.push({ code: 'BAD_WIRE', message: 'wire missing from/to', wire: i });
      continue;
    }

    const ends = [w.from, w.to].map(end => {
      if (typeof end === 'object' && end !== null && typeof end.x === 'number' && typeof end.y === 'number') {
        return { kind: 'coord', key: coordKey(end) };
      }
      const ref = parsePinRef(end);
      if (!ref) { errors.push({ code: 'BAD_PIN_REF', message: `bad pin reference "${end}"`, wire: i }); return null; }
      const comp = components.get(ref.compId);
      if (!comp) { errors.push({ code: 'UNKNOWN_COMPONENT', message: `wire ${i} references unknown component "${ref.compId}"`, wire: i, component: ref.compId }); return null; }
      const realPin = resolvePin(comp.type, ref.pinName);
      if (!realPin) { errors.push({ code: 'UNKNOWN_PIN', message: `component "${ref.compId}" (${comp.type}) has no pin "${ref.pinName}"`, wire: i, component: ref.compId, pin: ref.pinName }); return null; }
      return { kind: 'pin', key: `${ref.compId}.${realPin}`, compId: ref.compId, pinName: realPin };
    });

    if (ends[0] && ends[1]) {
      dsu.add(ends[0].key); dsu.add(ends[1].key);
      dsu.union(ends[0].key, ends[1].key);
    }
  }

  // Build nets: group pins by root
  const nets = new Map(); // netId -> { id, pins:[{compId,pinName}], isPower }
  const pinToNet = new Map();
  let netCounter = 0;
  const rootToNet = new Map();

  // First: assign power-rail nets explicitly
  for (const [id, c] of components) {
    const power = c._sym.isPower;
    if (!power) continue;
    for (const pinName of Object.keys(c._sym.pins)) {
      const root = dsu.find(`${id}.${pinName}`);
      if (!rootToNet.has(root)) {
        rootToNet.set(root, { id: power, pins: [], isPower: power, components: new Set() });
      } else {
        const existing = rootToNet.get(root);
        // Collision: two different power rails tied together — flag as POWER_SHORT later via VCC==GND check
        if (existing.isPower && existing.isPower !== power) {
          existing.shortedWith = power;
        }
      }
    }
  }

  // Then: every other root gets a synthetic name
  for (const [id, c] of components) {
    for (const pinName of Object.keys(c._sym.pins)) {
      const root = dsu.find(`${id}.${pinName}`);
      if (!rootToNet.has(root)) {
        rootToNet.set(root, { id: `N${String(++netCounter).padStart(3, '0')}`, pins: [], isPower: null, components: new Set() });
      }
      const net = rootToNet.get(root);
      net.pins.push({ compId: id, pinName });
      net.components.add(id);
      pinToNet.set(`${id}.${pinName}`, net.id);
      if (!nets.has(net.id)) nets.set(net.id, net);
    }
  }

  return {
    ok: errors.length === 0,
    errors,
    warnings,
    nets,
    pinToNet,
    components,
    dsu, // exposed for validators that need root lookup
  };
}

// Detect VCC↔GND short by checking whether any pin on a VCC component shares a root with any pin on a GND component.
export function findPowerShorts(graph) {
  const { components, dsu } = graph;
  const vccRoots = new Set();
  const gndRoots = new Set();
  for (const [id, c] of components) {
    if (c._sym.isPower === 'VCC') for (const p of Object.keys(c._sym.pins)) vccRoots.add(dsu.find(`${id}.${p}`));
    if (c._sym.isPower === 'GND') for (const p of Object.keys(c._sym.pins)) gndRoots.add(dsu.find(`${id}.${p}`));
  }
  const shorts = [];
  for (const r of vccRoots) if (gndRoots.has(r)) shorts.push(r);
  return shorts;
}

// Walk connected components of the net graph (ignoring power rails) to find floating islands.
export function findIslands(graph) {
  const { components, dsu } = graph;
  // Build component → set of roots it touches
  const compRoots = new Map();
  for (const [id, c] of components) {
    const roots = new Set();
    for (const p of Object.keys(c._sym.pins)) roots.add(dsu.find(`${id}.${p}`));
    compRoots.set(id, roots);
  }
  // Mark roots that connect to a power rail
  const powerRoots = new Set();
  for (const [id, c] of components) {
    if (!c._sym.isPower) continue;
    for (const p of Object.keys(c._sym.pins)) powerRoots.add(dsu.find(`${id}.${p}`));
  }
  // BFS: components linked if they share any root
  const rootToComps = new Map();
  for (const [id, roots] of compRoots) {
    for (const r of roots) {
      if (!rootToComps.has(r)) rootToComps.set(r, []);
      rootToComps.get(r).push(id);
    }
  }
  const visited = new Set();
  const islands = [];
  for (const [start] of compRoots) {
    if (visited.has(start)) continue;
    const queue = [start];
    const island = new Set();
    let touchesPower = false;
    while (queue.length) {
      const cur = queue.shift();
      if (visited.has(cur)) continue;
      visited.add(cur);
      island.add(cur);
      const c = components.get(cur);
      if (c._sym.isPower) touchesPower = true;
      for (const r of compRoots.get(cur)) {
        if (powerRoots.has(r)) touchesPower = true;
        for (const nbr of rootToComps.get(r) || []) if (!visited.has(nbr)) queue.push(nbr);
      }
    }
    if (!touchesPower && island.size > 0) {
      // skip islands consisting only of power components themselves (impossible here since !touchesPower)
      islands.push([...island]);
    }
  }
  return islands;
}
