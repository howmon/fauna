// ── Circuit renderer (DSL → SVG) ────────────────────────────────────────
// Pure JS, no deps. Works in Node and browser.
//
// renderCircuit(doc, opts?) → { svg, width, height, warnings }
//
// Component placement: component.x/y are in grid units. Grid size (px) is
// configurable via doc.grid (default 16). Rotation is in degrees (0/90/180/270).
// Wire routing: obstacle-aware Manhattan router (L-shape with body avoidance).

import { SYMBOLS, getSymbol, resolvePin, setLabelRotation, setLabelSink, renderLabel, setSymbolTheme } from './circuit-symbols.js';

const GRID_DEFAULT = 16;
const PADDING = 44;
const HOP_RADIUS = 4;

// Built-in theme definitions keyed by fauna preset name.
// Each entry maps semantic roles to hex values for dark mode (fauna's default).
// Light-mode overrides are provided as a `.light` sub-object.
export const CIRCUIT_THEMES = {
  cyber: {
    ink: '#e2e8f0', paper: '#0a0f1a', muted: '#64748b', accent: '#00ff87',
    wire: 'rgba(226,232,240,0.85)', junction: '#e2e8f0',
    light: { ink: '#0f172a', paper: '#f0f4f8', muted: '#64748b', accent: '#00c96b',
             wire: 'rgba(15,23,42,0.85)', junction: '#0f172a' },
  },
  minimal: {
    ink: '#e8e8f0', paper: '#0f0f13', muted: '#6b6b80', accent: '#a78bfa',
    wire: 'rgba(232,232,240,0.85)', junction: '#e8e8f0',
    light: { ink: '#18181f', paper: '#f4f4f8', muted: '#6b6b80', accent: '#7c3aed',
             wire: 'rgba(24,24,31,0.85)', junction: '#18181f' },
  },
  ember: {
    ink: '#f5e6d0', paper: '#130e09', muted: '#7a6b5a', accent: '#f59e0b',
    wire: 'rgba(245,230,208,0.85)', junction: '#f5e6d0',
    light: { ink: '#1c1510', paper: '#fdf8f0', muted: '#7a6b5a', accent: '#d97706',
             wire: 'rgba(28,21,16,0.85)', junction: '#1c1510' },
  },
  violet: {
    ink: '#ede8f5', paper: '#0d0912', muted: '#7c6b9a', accent: '#c084fc',
    wire: 'rgba(237,232,245,0.85)', junction: '#ede8f5',
    light: { ink: '#160d1e', paper: '#f7f4fc', muted: '#7c6b9a', accent: '#9333ea',
             wire: 'rgba(22,13,30,0.85)', junction: '#160d1e' },
  },
};

// Resolve a theme object from a preset name + optional light-mode flag.
// Falls back to a neutral dark-on-white theme for bare SVG viewers.
function resolveTheme(preset, lightMode) {
  const base = CIRCUIT_THEMES[preset] || {};
  const resolved = lightMode ? { ...base, ...(base.light || {}) } : { ...base };
  return {
    ink:      resolved.ink      || '#111111',
    paper:    resolved.paper    || '#ffffff',
    muted:    resolved.muted    || '#555555',
    accent:   resolved.accent   || '#0066cc',
    wire:     resolved.wire     || 'rgba(17,17,17,0.85)',
    junction: resolved.junction || '#111111',
  };
}

// ── Obstacle-aware Manhattan wire router ────────────────────────────────
// Routes each wire as a multi-segment orthogonal path that avoids component
// bodies (compBoxes). Strategy: try the three candidate L-shapes (H-then-V,
// V-then-H, mid-column), pick the first that doesn't intersect any obstacle.
// Falls back to a simple 3-segment detour if all candidates fail.
// compBoxes: [{ x0, y0, x1, y1 }] in SVG px. a, b: { x, y } endpoints.
// Returns an array of { x1, y1, x2, y2 } horizontal or vertical segments.
function routeWire(a, b, compBoxes, clearance) {
  const cl = clearance || 8; // clearance around component bodies

  // Axis-aligned shortcut: already H or V, no obstacles possible between endpoints
  if (a.x === b.x || a.y === b.y) {
    return segmentsFromPoints([a, b]);
  }

  // Expand each compBox by `cl` on all sides for collision tests.
  const obs = compBoxes.map(bx => ({
    x0: bx.x0 - cl, y0: bx.y0 - cl,
    x1: bx.x1 + cl, y1: bx.y1 + cl,
  }));

  const segClear = (p1, p2) => !obs.some(bx => segIntersectsBox(p1, p2, bx));

  // Candidate 1: H-then-V (classic L, corner at (b.x, a.y))
  const c1 = { x: b.x, y: a.y };
  if (segClear(a, c1) && segClear(c1, b)) return segmentsFromPoints([a, c1, b]);

  // Candidate 2: V-then-H (corner at (a.x, b.y))
  const c2 = { x: a.x, y: b.y };
  if (segClear(a, c2) && segClear(c2, b)) return segmentsFromPoints([a, c2, b]);

  // Candidate 3: mid-column S-bend (H → V → H, split evenly)
  const mx = Math.round((a.x + b.x) / 2 / cl) * cl; // snap mid X to clearance grid
  const c3a = { x: mx, y: a.y };
  const c3b = { x: mx, y: b.y };
  if (segClear(a, c3a) && segClear(c3a, c3b) && segClear(c3b, b)) {
    return segmentsFromPoints([a, c3a, c3b, b]);
  }

  // Candidate 4: mid-row S-bend (V → H → V)
  const my = Math.round((a.y + b.y) / 2 / cl) * cl;
  const c4a = { x: a.x, y: my };
  const c4b = { x: b.x, y: my };
  if (segClear(a, c4a) && segClear(c4a, c4b) && segClear(c4b, b)) {
    return segmentsFromPoints([a, c4a, c4b, b]);
  }

  // Last resort: route around outside all obstacles with a 5-segment path.
  // Compute a bounding box that encloses all obstacles plus clearance,
  // then route up/over/down around it.
  let bx0 = Math.min(a.x, b.x), bx1 = Math.max(a.x, b.x);
  let by0 = Math.min(a.y, b.y), by1 = Math.max(a.y, b.y);
  for (const bx of obs) {
    if (bx.x0 < bx1 && bx.x1 > bx0 && bx.y0 < by1 && bx.y1 > by0) {
      bx0 = Math.min(bx0, bx.x0 - cl); bx1 = Math.max(bx1, bx.x1 + cl);
      by0 = Math.min(by0, bx.y0 - cl); by1 = Math.max(by1, bx.y1 + cl);
    }
  }
  // Route above (y = by0 - cl)
  const detour = by0 - cl;
  return segmentsFromPoints([
    a,
    { x: a.x, y: detour },
    { x: b.x, y: detour },
    b,
  ]);
}

// Decompose a polyline (array of {x,y} waypoints) into H/V segment records.
function segmentsFromPoints(pts) {
  const segs = [];
  for (let i = 0; i + 1 < pts.length; i++) {
    const p = pts[i], q = pts[i + 1];
    if (p.x === q.x && p.y === q.y) continue;
    segs.push({ x1: p.x, y1: p.y, x2: q.x, y2: q.y });
  }
  return segs;
}

// Does an axis-aligned segment (p1→p2) intersect box bx? (Both H and V cases.)
function segIntersectsBox(p1, p2, bx) {
  if (p1.y === p2.y) {
    // Horizontal segment
    const lx = Math.min(p1.x, p2.x), rx = Math.max(p1.x, p2.x);
    const y = p1.y;
    return lx < bx.x1 && rx > bx.x0 && y > bx.y0 && y < bx.y1;
  } else if (p1.x === p2.x) {
    // Vertical segment
    const ty = Math.min(p1.y, p2.y), by = Math.max(p1.y, p2.y);
    const x = p1.x;
    return x > bx.x0 && x < bx.x1 && ty < bx.y1 && by > bx.y0;
  }
  return false; // diagonal — shouldn't happen
}

// ────────────────────────────────────────────────────────────────────────

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

export function renderCircuit(doc, opts = {}) {
  if (!doc || typeof doc !== 'object') {
    return { svg: '', width: 0, height: 0, warnings: [{ code: 'BAD_DOC', message: 'doc must be an object' }] };
  }

  // Resolve theme — opts.theme > doc.theme > opts.preset > doc.preset > fallback.
  const presetName = opts.preset || doc.preset || 'cyber';
  const lightMode  = opts.light  || doc.light  || false;
  const theme = (opts.theme && typeof opts.theme === 'object')
    ? opts.theme
    : resolveTheme(presetName, lightMode);

  // Push resolved colors into the symbol library so all render() calls
  // pick up the correct ink/paper colors for this render pass.
  setSymbolTheme({ ink: theme.ink, paper: theme.paper });

  // Wire-stroke attribute string built from the resolved theme.
  const WIRE_STROKE = `stroke="${theme.wire}" stroke-width="1.4" fill="none" stroke-linecap="round"`;

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
  // World-space bounding box of each component's glyph, so the de-collision
  // pass can push neighbouring labels off symbol bodies (not just off each
  // other). Each label is tagged with its owner index so a label is never
  // repelled from its own symbol (where it's intentionally anchored).
  const compBoxes = [];
  const compSvg = components.map((c, ci) => {
    const cx = c.x * grid;
    const cy = c.y * grid;
    const transform = c.rot ? ` rotate(${c.rot})` : '';
    const displayValue = shortLabel(c.value);
    // Rotation-aware world bbox (90°/270° swap width/height).
    const swap = (c.rot || 0) % 180 !== 0;
    const bw = swap ? c._sym.bbox.h : c._sym.bbox.w;
    const bh = swap ? c._sym.bbox.w : c._sym.bbox.h;
    compBoxes.push({ x0: cx - bw / 2, y0: cy - bh / 2, x1: cx + bw / 2, y1: cy + bh / 2 });
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
      labels.push({ text: L.text, anchor: L.anchor, x: cx + p.x, y: cy + p.y, owner: ci });
    }
    const tooltip = (c.value && c.value !== displayValue) ? `<title>${escapeXml(c.id + ': ' + c.value)}</title>` : '';
    return `<g transform="translate(${cx},${cy})${transform}">${tooltip}${inner}</g>`;
  }).join('\n');

  // Render wires + junction dots + jumper hops.
  // Each wire is decomposed into orthogonal (H/V) segments. When a horizontal
  // segment's interior crosses a vertical segment's interior (neither endpoint
  // lies at the crossing), the horizontal one renders with a small semicircle
  // hop arc to indicate the wires pass over each other without connecting.
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
    // Obstacle-aware router: tries 4 L/S candidates that avoid component bodies,
    // falls back to a clearance-bounded detour if all fail.
    for (const seg of routeWire(a, b, compBoxes, grid * 0.5)) {
      const p1 = { x: seg.x1, y: seg.y1 }, p2 = { x: seg.x2, y: seg.y2 };
      addSeg(p1, p2);
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

  // Junction dots. A node's degree = (# of segment ENDS at the point) + 2 for
  // every segment whose interior runs through it (a pass-through contributes
  // two incident directions). A dot is drawn when degree ≥ 3 AND at least one
  // wire actually terminates there — so genuine T-taps / multi-way nodes get a
  // dot, while a pure interior×interior crossing (no terminating wire) stays a
  // hop (no-connect) instead of a misleading connection dot.
  const endDeg = new Map(); // "x,y" → count of segment endpoints landing here
  const bumpEnd = (x, y) => { const k = `${x},${y}`; endDeg.set(k, (endDeg.get(k) || 0) + 1); };
  for (const h of horizSegs) { bumpEnd(h.x1, h.y); bumpEnd(h.x2, h.y); }
  for (const v of vertSegs)  { bumpEnd(v.x, v.y1); bumpEnd(v.x, v.y2); }

  const dots = [];
  for (const [k, ends] of endDeg) {
    const [x, y] = k.split(',').map(Number);
    let degree = ends;
    for (const h of horizSegs) { if (h.y === y && x > h.x1 && x < h.x2) degree += 2; }
    for (const v of vertSegs)  { if (v.x === x && y > v.y1 && y < v.y2) degree += 2; }
    if (degree >= 3) {
      dots.push(`<circle cx="${x}" cy="${y}" r="2.5" fill="${theme.junction}"/>`);
    }
  }

  // Resolve overlapping refdes/value labels by nudging them vertically, then
  // emit as a top layer (the white halo in TEXT keeps them legible over wires).
  deCollideLabels(labels, compBoxes);
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

  const diagramSlug = 'circuit-' + (doc.id || Math.random().toString(36).slice(2, 7));
  const titleEl = `<title id="${diagramSlug}-title">${escapeXml(doc.title || 'Circuit schematic')}</title>`;
  const descEl  = doc.description
    ? `<desc id="${diagramSlug}-desc">${escapeXml(doc.description)}</desc>`
    : `<desc id="${diagramSlug}-desc">Circuit schematic diagram.</desc>`;
  const titleLabel = doc.title
    ? `<text x="${vbX + 12}" y="${vbY + 22}" font-family="'Geist','Geist Variable',system-ui,sans-serif" font-size="14" font-weight="600" fill="${theme.ink}">${escapeXml(doc.title)}</text>`
    : '';

  // data-fauna-circuit is a provenance marker: it proves this SVG came out of
  // the circuit engine (not hand-authored by the model). The chat verifier and
  // the UI key off it to distinguish a real render from invented markup.
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${vbX} ${vbY} ${vbW} ${vbH}" width="${vbW}" height="${vbH}" role="img" data-fauna-circuit="v1" aria-labelledby="${diagramSlug}-title ${diagramSlug}-desc">
${titleEl}
${descEl}
<rect x="${vbX}" y="${vbY}" width="${vbW}" height="${vbH}" fill="${theme.paper}"/>
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
// enough for typical schematic densities. `compBoxes` (optional) are the
// world-space symbol glyph boxes — labels are also pushed clear of any
// neighbouring symbol body (never their own, tracked via label.owner) so text
// doesn't land on top of a packed transistor/transformer/etc.
function deCollideLabels(labels, compBoxes) {
  if (!Array.isArray(labels) || labels.length < 2) return;
  const boxes = Array.isArray(compBoxes) ? compBoxes : [];
  const PAD = 1.5;
  for (let pass = 0; pass < 12; pass++) {
    let moved = false;
    // (1) Push labels off neighbouring symbol bodies (not their own).
    for (let i = 0; i < labels.length; i++) {
      const L = labels[i];
      const a = labelBox(L);
      for (let bi = 0; bi < boxes.length; bi++) {
        if (bi === L.owner) continue;
        const s = boxes[bi];
        const overlapX = a.x0 < s.x1 && s.x0 < a.x1;
        const overlapY = a.y0 < s.y1 && s.y0 < a.y1;
        if (!overlapX || !overlapY) continue;
        // Escape vertically out of the nearer horizontal edge of the symbol.
        const upShift = a.y1 - s.y0 + PAD;   // move label up (decrease y)
        const downShift = s.y1 - a.y0 + PAD; // move label down (increase y)
        L.y += upShift <= downShift ? -upShift : downShift;
        a.y0 = L.y - LABEL_H * 0.8; a.y1 = L.y + LABEL_H * 0.2;
        moved = true;
      }
    }
    // (2) Push overlapping labels apart along Y.
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
