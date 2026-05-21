// ── Circuit renderer (DSL → SVG) ────────────────────────────────────────
// Pure JS, no deps. Works in Node and browser.
//
// renderCircuit(doc) → { svg, width, height, warnings }
//
// Component placement: component.x/y are in grid units. Grid size (px) is
// configurable via doc.grid (default 10). Rotation is in degrees (0/90/180/270).
// Wires are routed as L-shaped (Manhattan) two-segment polylines.

import { SYMBOLS, getSymbol, resolvePin } from './circuit-symbols.js';

const GRID_DEFAULT = 10;
const PADDING = 40;

// Rotate point (x,y) around origin by deg (0/90/180/270).
function rot(p, deg) {
  const d = ((deg % 360) + 360) % 360;
  switch (d) {
    case 90:  return { x: -p.y, y:  p.x };
    case 180: return { x: -p.x, y: -p.y };
    case 270: return { x:  p.y, y: -p.x };
    default:  return { x: p.x,  y: p.y };
  }
}

// Compute the absolute (SVG) coordinates of a component pin.
function pinWorld(comp, pinName, grid) {
  const sym = comp._sym;
  const realPin = resolvePin(comp.type, pinName);
  if (!realPin) return null;
  const local = sym.pins[realPin];
  const rotated = rot(local, comp.rot || 0);
  const cx = comp.x * grid;
  const cy = comp.y * grid;
  return { x: cx + rotated.x, y: cy + rotated.y };
}

// L-shaped (Manhattan) route between two points. Prefer horizontal-first.
function routeWire(a, b) {
  if (a.x === b.x || a.y === b.y) {
    return `${a.x},${a.y} ${b.x},${b.y}`;
  }
  // Horizontal then vertical
  return `${a.x},${a.y} ${b.x},${a.y} ${b.x},${b.y}`;
}

export function renderCircuit(doc) {
  if (!doc || typeof doc !== 'object') {
    return { svg: '', width: 0, height: 0, warnings: [{ code: 'BAD_DOC', message: 'doc must be an object' }] };
  }

  const grid = Number(doc.grid) > 0 ? Number(doc.grid) : GRID_DEFAULT;
  const compList = Array.isArray(doc.components) ? doc.components : [];
  const wireList = Array.isArray(doc.wires) ? doc.wires : [];
  const warnings = [];

  // Resolve components (filter unknowns, attach symbol)
  const components = [];
  const byId = new Map();
  for (const c of compList) {
    if (!c || !c.id || !c.type) {
      warnings.push({ code: 'BAD_COMPONENT', message: 'component missing id/type', component: c && c.id });
      continue;
    }
    const sym = getSymbol(c.type);
    if (!sym) {
      warnings.push({ code: 'UNKNOWN_TYPE', message: `unknown component type "${c.type}"`, component: c.id });
      continue;
    }
    if (byId.has(c.id)) {
      warnings.push({ code: 'DUP_COMPONENT_ID', message: `duplicate component id "${c.id}"`, component: c.id });
      continue;
    }
    const resolved = { ...c, _sym: sym, x: Number(c.x) || 0, y: Number(c.y) || 0, rot: Number(c.rot) || 0 };
    components.push(resolved);
    byId.set(c.id, resolved);
  }

  // Compute bounding box
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const c of components) {
    const cx = c.x * grid;
    const cy = c.y * grid;
    const r = Math.max(c._sym.bbox.w, c._sym.bbox.h) / 2 + 8;
    if (cx - r < minX) minX = cx - r;
    if (cy - r < minY) minY = cy - r;
    if (cx + r > maxX) maxX = cx + r;
    if (cy + r > maxY) maxY = cy + r;
  }
  if (!isFinite(minX)) { minX = 0; minY = 0; maxX = 100; maxY = 60; }

  // Render component glyphs
  const compSvg = components.map(c => {
    const cx = c.x * grid;
    const cy = c.y * grid;
    const transform = c.rot ? ` rotate(${c.rot})` : '';
    const inner = c._sym.render({ value: c.value, id: c.id, props: c.props || {} });
    return `<g transform="translate(${cx},${cy})${transform}">${inner}</g>`;
  }).join('\n');

  // Render wires + junction dots
  const junctionCount = new Map(); // "x,y" → count
  function bump(p) {
    const k = `${p.x},${p.y}`;
    junctionCount.set(k, (junctionCount.get(k) || 0) + 1);
  }

  const wireSegments = [];
  for (let i = 0; i < wireList.length; i++) {
    const w = wireList[i];
    if (!w || w.from == null || w.to == null) {
      warnings.push({ code: 'BAD_WIRE', message: 'wire missing from/to', wire: i });
      continue;
    }
    const a = resolveEnd(w.from, byId, grid, warnings, i);
    const b = resolveEnd(w.to, byId, grid, warnings, i);
    if (!a || !b) continue;
    const pts = routeWire(a, b);
    wireSegments.push(`<polyline points="${pts}" stroke="#111" stroke-width="1.4" fill="none"/>`);
    bump(a); bump(b);
    // expand bbox
    const xs = pts.split(' ').map(s => Number(s.split(',')[0]));
    const ys = pts.split(' ').map(s => Number(s.split(',')[1]));
    minX = Math.min(minX, ...xs); maxX = Math.max(maxX, ...xs);
    minY = Math.min(minY, ...ys); maxY = Math.max(maxY, ...ys);
  }

  // Junction dots where ≥3 wire endpoints meet
  const dots = [];
  for (const [k, n] of junctionCount) {
    if (n >= 3) {
      const [x, y] = k.split(',').map(Number);
      dots.push(`<circle cx="${x}" cy="${y}" r="2.5" fill="#111"/>`);
    }
  }

  const vbX = Math.floor(minX) - PADDING;
  const vbY = Math.floor(minY) - PADDING;
  const vbW = Math.ceil(maxX - minX) + PADDING * 2;
  const vbH = Math.ceil(maxY - minY) + PADDING * 2;

  const title = doc.title ? `<title>${escapeXml(doc.title)}</title>` : '';
  const titleLabel = doc.title ? `<text x="${vbX + 12}" y="${vbY + 22}" font-family="ui-sans-serif,system-ui,sans-serif" font-size="14" font-weight="600" fill="#111">${escapeXml(doc.title)}</text>` : '';

  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${vbX} ${vbY} ${vbW} ${vbH}" width="${vbW}" height="${vbH}" role="img" aria-label="${escapeXml(doc.title || 'circuit diagram')}">
${title}
<rect x="${vbX}" y="${vbY}" width="${vbW}" height="${vbH}" fill="#fff"/>
${titleLabel}
${wireSegments.join('\n')}
${dots.join('\n')}
${compSvg}
</svg>`;

  return { svg, width: vbW, height: vbH, warnings };
}

function resolveEnd(end, byId, grid, warnings, wireIdx) {
  if (typeof end === 'object' && end !== null && typeof end.x === 'number' && typeof end.y === 'number') {
    return { x: end.x * grid, y: end.y * grid };
  }
  if (typeof end !== 'string') {
    warnings.push({ code: 'BAD_PIN_REF', message: `wire ${wireIdx} endpoint is not a string or {x,y}`, wire: wireIdx });
    return null;
  }
  const i = end.indexOf('.');
  if (i <= 0) { warnings.push({ code: 'BAD_PIN_REF', message: `bad pin ref "${end}"`, wire: wireIdx }); return null; }
  const compId = end.slice(0, i), pinName = end.slice(i + 1);
  const c = byId.get(compId);
  if (!c) { warnings.push({ code: 'UNKNOWN_COMPONENT', message: `wire ${wireIdx} → unknown component "${compId}"`, wire: wireIdx, component: compId }); return null; }
  const p = pinWorld(c, pinName, grid);
  if (!p) { warnings.push({ code: 'UNKNOWN_PIN', message: `component "${compId}" (${c.type}) has no pin "${pinName}"`, wire: wireIdx, component: compId, pin: pinName }); return null; }
  return p;
}

function escapeXml(s) {
  return String(s).replace(/[<>&"']/g, c => ({ '<':'&lt;','>':'&gt;','&':'&amp;','"':'&quot;',"'":'&#39;' }[c]));
}
