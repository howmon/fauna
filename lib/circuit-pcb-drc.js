// ── PCB design-rule check (board model → violations) ────────────────────
// Pure JS, no deps. Structural/geometric checks on a routed board model from
// layoutPcb()/routePcb(). Mirrors validateCircuit's { ok, errors, warnings }
// shape so callers can treat schematic and board lint uniformly.
//
// checkBoard(board, opts) → { ok, errors, warnings, stats }

const DEFAULTS = { clearance: 0.25, edge: 0.3, drillGap: 0.4 };

export function checkBoard(board, opts = {}) {
  const errors = [];
  const warnings = [];
  if (!board || typeof board !== 'object' || !Array.isArray(board.pads)) {
    return { ok: false, errors: [{ code: 'BAD_BOARD', message: 'board must be a layoutPcb() model' }], warnings: [], stats: {} };
  }
  const minClear = num(opts.clearance, DEFAULTS.clearance);
  const minEdge = num(opts.edge, DEFAULTS.edge);
  const minDrill = num(opts.drillGap, DEFAULTS.drillGap);
  const pads = board.pads;
  const traces = Array.isArray(board.traces) ? board.traces : [];
  const { w: BW, h: BH } = board.board;

  // ── Unrouted nets ─────────────────────────────────────────────────────
  if (Array.isArray(board.ratsnest) && board.ratsnest.length > 0) {
    const nets = [...new Set(board.ratsnest.map(r => r.net))];
    warnings.push({ code: 'UNROUTED', message: `${board.ratsnest.length} airwire(s) on ${nets.length} net(s) not routed`, nets });
  }

  // ── Pad ↔ pad: copper overlap (foreign nets) + drill spacing ─────────
  for (let i = 0; i < pads.length; i++) {
    for (let j = i + 1; j < pads.length; j++) {
      const a = pads[i], b = pads[j];
      const d = dist(a, b);
      const copperGap = d - (maxHalf(a) + maxHalf(b));
      if (a.net && b.net && a.net !== b.net && copperGap < minClear) {
        errors.push({ code: 'PAD_CLEARANCE', message: `pads ${a.ref}.${a.num} (${a.net}) and ${b.ref}.${b.num} (${b.net}) are ${fmt(copperGap)} mm apart (< ${minClear})`, pads: [a.i, b.i] });
      }
      if (a.drill != null && b.drill != null) {
        const drillGap = d - (a.drill / 2 + b.drill / 2);
        if (drillGap < minDrill) {
          warnings.push({ code: 'DRILL_SPACING', message: `drill holes ${a.ref}.${a.num} and ${b.ref}.${b.num} are ${fmt(drillGap)} mm apart (< ${minDrill})`, pads: [a.i, b.i] });
        }
      }
    }
  }

  // ── Trace ↔ trace: same-layer clearance between different nets ───────
  const segs = [];
  for (const t of traces) {
    const pts = t.points || [];
    for (let k = 0; k < pts.length - 1; k++) {
      segs.push({ net: t.net, layer: t.layer || 'top', width: t.width || 0.4, a: pts[k], b: pts[k + 1] });
    }
  }
  for (let i = 0; i < segs.length; i++) {
    for (let j = i + 1; j < segs.length; j++) {
      const s1 = segs[i], s2 = segs[j];
      if (s1.layer !== s2.layer) continue;
      if (s1.net === s2.net) continue;
      const gap = segSegDist(s1.a, s1.b, s2.a, s2.b) - (s1.width / 2 + s2.width / 2);
      if (gap < minClear) {
        errors.push({ code: 'TRACE_CLEARANCE', message: `traces on nets "${s1.net}" and "${s2.net}" (${s1.layer}) are ${fmt(gap)} mm apart (< ${minClear})`, nets: [s1.net, s2.net], layer: s1.layer });
      }
    }
  }

  // ── Trace ↔ foreign pad clearance ────────────────────────────────────
  for (const s of segs) {
    for (const p of pads) {
      if (!p.net || p.net === s.net) continue;
      if (p.drill == null && p.layer === 'top' && s.layer === 'bottom') continue; // SMD pad not on this layer
      const gap = ptSegDist(p, s.a, s.b) - (maxHalf(p) + s.width / 2);
      if (gap < minClear) {
        errors.push({ code: 'TRACE_PAD_CLEARANCE', message: `trace on net "${s.net}" runs ${fmt(gap)} mm from pad ${p.ref}.${p.num} (${p.net}) (< ${minClear})`, net: s.net, pad: p.i });
      }
    }
  }

  // ── Board-edge clearance ──────────────────────────────────────────────
  for (const p of pads) {
    const m = Math.min(p.x - maxHalf(p), p.y - maxHalf(p), BW - (p.x + maxHalf(p)), BH - (p.y + maxHalf(p)));
    if (m < minEdge) {
      warnings.push({ code: 'EDGE_CLEARANCE', message: `pad ${p.ref}.${p.num} is ${fmt(m)} mm from the board edge (< ${minEdge})`, pad: p.i });
    }
  }

  // De-duplicate identical messages (symmetric checks can repeat).
  const dedupe = arr => {
    const seen = new Set();
    return arr.filter(v => { const k = v.code + '|' + v.message; if (seen.has(k)) return false; seen.add(k); return true; });
  };
  const errs = dedupe(errors);
  const warns = dedupe(warnings);

  return {
    ok: errs.length === 0,
    errors: errs,
    warnings: warns,
    stats: {
      pads: pads.length, traces: traces.length, segments: segs.length,
      vias: Array.isArray(board.vias) ? board.vias.length : 0,
      unrouted: Array.isArray(board.ratsnest) ? board.ratsnest.length : 0,
    },
  };
}

// ── geometry helpers ─────────────────────────────────────────────────────
function maxHalf(p) { return Math.max(p.w, p.h) / 2; }
function dist(a, b) { return Math.hypot(a.x - b.x, a.y - b.y); }
function fmt(n) { return (+n.toFixed(3)).toString(); }
function num(v, d) { return Number.isFinite(Number(v)) ? Number(v) : d; }

function ptSegDist(p, a, b) {
  const vx = b.x - a.x, vy = b.y - a.y;
  const wx = p.x - a.x, wy = p.y - a.y;
  const len2 = vx * vx + vy * vy;
  let t = len2 ? (wx * vx + wy * vy) / len2 : 0;
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  const cx = a.x + t * vx, cy = a.y + t * vy;
  return Math.hypot(p.x - cx, p.y - cy);
}

function segSegDist(p1, p2, p3, p4) {
  if (segSegIntersect(p1, p2, p3, p4)) return 0;
  return Math.min(
    ptSegDist(p1, p3, p4), ptSegDist(p2, p3, p4),
    ptSegDist(p3, p1, p2), ptSegDist(p4, p1, p2),
  );
}

function segSegIntersect(a, b, c, d) {
  const o = (p, q, r) => Math.sign((q.x - p.x) * (r.y - p.y) - (q.y - p.y) * (r.x - p.x));
  const o1 = o(a, b, c), o2 = o(a, b, d), o3 = o(c, d, a), o4 = o(c, d, b);
  return o1 !== o2 && o3 !== o4;
}
