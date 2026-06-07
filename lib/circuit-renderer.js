// ── Circuit renderer (DSL → SVG) ────────────────────────────────────────
// Pure JS, no deps. Works in Node and browser.
//
// renderCircuit(doc) → { svg, width, height, warnings }
//
// Component placement: component.x/y are in grid units. Grid size (px) is
// configurable via doc.grid (default 10). Rotation is in degrees (0/90/180/270).
// Wires are routed as L-shaped (Manhattan) two-segment polylines.

import { SYMBOLS, getSymbol, resolvePin, setLabelRotation, setLabelSink, renderLabel } from './circuit-symbols.js';

const GRID_DEFAULT = 16;
const PADDING = 44;
const HOP_RADIUS = 4;
const WIRE_STROKE = 'stroke="#111" stroke-width="1.4" fill="none" stroke-linecap="round"';

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

  // Render component glyphs. Labels (refdes/value) are diverted into `labels`
  // in world-space so a collision-avoidance pass can keep them legible when
  // components are packed tightly; they're emitted as a top layer below.
  const labels = [];
  const compSvg = components.map(c => {
    const cx = c.x * grid;
    const cy = c.y * grid;
    const transform = c.rot ? ` rotate(${c.rot})` : '';
    const displayValue = shortLabel(c.value);
    const sink = [];
    setLabelRotation(c.rot || 0);
    setLabelSink(sink);
    const inner = c._sym.render({ value: displayValue, id: c.id, props: c.props || {} });
    setLabelSink(null);
    setLabelRotation(0);
    // Map each collected label from local symbol coords → world coords. The
    // component group applies translate(cx,cy) rotate(rot); labels stay upright.
    for (const L of sink) {
      const p = rot({ x: L.x, y: L.y }, c.rot || 0);
      labels.push({ text: L.text, anchor: L.anchor, x: cx + p.x, y: cy + p.y });
    }
    const tooltip = (c.value && c.value !== displayValue) ? `<title>${escapeXml(c.id + ': ' + c.value)}</title>` : '';
    return `<g transform="translate(${cx},${cy})${transform}">${tooltip}${inner}</g>`;
  }).join('\n');

  // Render wires + junction dots + jumper hops.
  // Each wire is decomposed into orthogonal (H/V) segments. When a horizontal
  // segment's interior crosses a vertical segment's interior (neither endpoint
  // lies at the crossing), the horizontal one renders with a small semicircle
  // hop arc to indicate the wires pass over each other without connecting.
  const junctionCount = new Map(); // "x,y" → count of wire endpoints
  function bumpJunction(p) {
    const k = `${p.x},${p.y}`;
    junctionCount.set(k, (junctionCount.get(k) || 0) + 1);
  }

  const horizSegs = []; // { x1, x2, y }
  const vertSegs  = []; // { y1, y2, x }
  function addSeg(p1, p2) {
    if (p1.x === p2.x && p1.y === p2.y) return;
    if (p1.y === p2.y) {
      horizSegs.push({ x1: Math.min(p1.x, p2.x), x2: Math.max(p1.x, p2.x), y: p1.y });
    } else if (p1.x === p2.x) {
      vertSegs.push({ y1: Math.min(p1.y, p2.y), y2: Math.max(p1.y, p2.y), x: p1.x });
    }
  }

  for (let i = 0; i < wireList.length; i++) {
    const w = wireList[i];
    if (!w || w.from == null || w.to == null) {
      warnings.push({ code: 'BAD_WIRE', message: 'wire missing from/to', wire: i });
      continue;
    }
    const a = resolveEnd(w.from, byId, grid, warnings, i);
    const b = resolveEnd(w.to, byId, grid, warnings, i);
    if (!a || !b) continue;
    bumpJunction(a); bumpJunction(b);
    if (a.x === b.x || a.y === b.y) {
      addSeg(a, b);
    } else {
      // L-shape: horizontal first, then vertical
      const corner = { x: b.x, y: a.y };
      addSeg(a, corner);
      addSeg(corner, b);
    }
    minX = Math.min(minX, a.x, b.x); maxX = Math.max(maxX, a.x, b.x);
    minY = Math.min(minY, a.y, b.y); maxY = Math.max(maxY, a.y, b.y);
  }

  // Detect H/V interior crossings — these get jumper hops on the H segment.
  for (const h of horizSegs) h.hops = [];
  for (const h of horizSegs) {
    for (const v of vertSegs) {
      if (v.x > h.x1 && v.x < h.x2 && h.y > v.y1 && h.y < v.y2) {
        h.hops.push(v.x);
      }
    }
    h.hops.sort((a, b) => a - b);
  }

  const wireSegments = [];
  for (const h of horizSegs) {
    if (h.hops.length === 0) {
      wireSegments.push(`<line x1="${h.x1}" y1="${h.y}" x2="${h.x2}" y2="${h.y}" ${WIRE_STROKE}/>`);
    } else {
      // Build a path: straight runs interrupted by small upward arcs at each hop X.
      // sweep-flag=0 with SVG's Y-down axis bulges the arc upward (negative Y).
      let d = `M ${h.x1} ${h.y}`;
      for (const hx of h.hops) {
        d += ` L ${hx - HOP_RADIUS} ${h.y} A ${HOP_RADIUS} ${HOP_RADIUS} 0 0 0 ${hx + HOP_RADIUS} ${h.y}`;
      }
      d += ` L ${h.x2} ${h.y}`;
      wireSegments.push(`<path d="${d}" ${WIRE_STROKE}/>`);
    }
  }
  for (const v of vertSegs) {
    wireSegments.push(`<line x1="${v.x}" y1="${v.y1}" x2="${v.x}" y2="${v.y2}" ${WIRE_STROKE}/>`);
  }

  // Junction dots where ≥3 wire endpoints meet
  const dots = [];
  for (const [k, n] of junctionCount) {
    if (n >= 3) {
      const [x, y] = k.split(',').map(Number);
      dots.push(`<circle cx="${x}" cy="${y}" r="2.5" fill="#111"/>`);
    }
  }

  // Resolve overlapping refdes/value labels by nudging them vertically, then
  // emit as a top layer (the white halo in TEXT keeps them legible over wires).
  deCollideLabels(labels);
  const labelSvg = [];
  for (const L of labels) {
    labelSvg.push(renderLabel(L.text, round1(L.x), round1(L.y), L.anchor));
    // Make sure nudged labels stay inside the viewBox.
    const [lx0, lx1] = labelXExtent(L);
    if (lx0 < minX) minX = lx0;
    if (lx1 > maxX) maxX = lx1;
    if (L.y - LABEL_H * 0.8 < minY) minY = L.y - LABEL_H * 0.8;
    if (L.y + LABEL_H * 0.4 > maxY) maxY = L.y + LABEL_H * 0.4;
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
${labelSvg.join('\n')}
</svg>`;

  return { svg, width: vbW, height: vbH, warnings };
}

// ── Label collision avoidance ───────────────────────────────────────────
// Approximate glyph metrics for the 11px label font.
const LABEL_CHAR_W = 6.0;
const LABEL_H = 12;

function labelXExtent(L) {
  const w = (L.text ? L.text.length : 0) * LABEL_CHAR_W;
  if (L.anchor === 'start') return [L.x, L.x + w];
  if (L.anchor === 'end')   return [L.x - w, L.x];
  return [L.x - w / 2, L.x + w / 2]; // middle
}

// Build the axis-aligned box for a label (baseline-relative).
function labelBox(L) {
  const [x0, x1] = labelXExtent(L);
  return { x0, x1, y0: L.y - LABEL_H * 0.8, y1: L.y + LABEL_H * 0.2 };
}

// Iteratively push overlapping labels apart along Y. Horizontal position is
// kept (labels read best near their component); a few relaxation passes are
// enough for typical schematic densities.
function deCollideLabels(labels) {
  if (!Array.isArray(labels) || labels.length < 2) return;
  const PAD = 1.5;
  for (let pass = 0; pass < 12; pass++) {
    let moved = false;
    for (let i = 0; i < labels.length; i++) {
      for (let j = i + 1; j < labels.length; j++) {
        const a = labelBox(labels[i]);
        const b = labelBox(labels[j]);
        const overlapX = a.x0 < b.x1 && b.x0 < a.x1;
        const overlapY = a.y0 < b.y1 && b.y0 < a.y1;
        if (!overlapX || !overlapY) continue;
        // Vertical separation needed to clear, split between the two.
        const sep = (Math.min(a.y1, b.y1) - Math.max(a.y0, b.y0)) / 2 + PAD;
        if (sep <= 0) continue;
        if (labels[i].y <= labels[j].y) { labels[i].y -= sep; labels[j].y += sep; }
        else                            { labels[i].y += sep; labels[j].y -= sep; }
        moved = true;
      }
    }
    if (!moved) break;
  }
}

function round1(n) {
  return Math.round(n * 10) / 10;
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

// Truncate a value label so it doesn't bleed over neighbouring components.
// Returns null for nullish input. SPICE source expressions (PULSE/SIN/PWL/...)
// get a friendly short form; otherwise we cap at 10 chars with an ellipsis.
function shortLabel(value) {
  if (value == null) return null;
  const s = String(value).trim();
  if (!s) return null;
  const m = s.match(/^\s*(DC|AC|SIN|PULSE|PWL|EXP|SFFM|AM)\b/i);
  if (m) return m[1].toUpperCase();
  if (s.length <= 10) return s;
  return s.slice(0, 9) + '…';
}
