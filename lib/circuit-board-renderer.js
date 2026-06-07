// ── PCB board renderer (board model → SVG) ──────────────────────────────
// Pure JS, no deps. Renders the layoutPcb() board model as an SVG top view:
// FR-4 substrate, copper traces (etchings), pads with tinned-solder fillets
// and plated drill holes, silkscreen outlines/refdes, vias, and ratsnest
// airwires. Layer visibility is configurable.
//
// renderBoard(board, opts) → { svg, width, height, warnings }

const PXMM_DEFAULT = 8;   // pixels per millimetre
const PAD_BORDER = 40;    // px border around the board

// Layer palette (KiCad-ish).
const COL = {
  substrate: '#0b6b3a',     // FR-4 green
  substrateEdge: '#073d22',
  copperTop: '#c0392b',     // red  = top copper
  copperBottom: '#2566c2',  // blue = bottom copper
  padTin: '#d9d2c5',        // tinned solder
  padTinHi: '#f3efe7',
  padCopper: '#e0a23c',     // exposed copper / SMD
  drill: '#1b1b1b',
  silk: '#f4f4f2',
  via: '#9aa0a6',
  rats: '#9fe6c0',
  text: '#f4f4f2',
};

const VISIBLE_DEFAULT = {
  substrate: true, copperBottom: true, copperTop: true, pads: true,
  vias: true, silk: true, ratsnest: true, drill: true,
};

export function renderBoard(board, opts = {}) {
  if (!board || typeof board !== 'object' || !Array.isArray(board.pads)) {
    return { svg: '', width: 0, height: 0, warnings: [{ code: 'BAD_BOARD', message: 'board must be a layoutPcb() model' }] };
  }
  const pxmm = Number(opts.pxmm) > 0 ? Number(opts.pxmm) : PXMM_DEFAULT;
  const show = { ...VISIBLE_DEFAULT, ...(opts.layers || {}) };
  const warnings = [];
  const S = v => +(v * pxmm).toFixed(2);                 // mm → px (size)
  const X = v => +(v * pxmm + PAD_BORDER).toFixed(2);    // mm → px (board x)
  const Y = v => +(v * pxmm + PAD_BORDER).toFixed(2);    // mm → px (board y)

  const W = S(board.board.w) + PAD_BORDER * 2;
  const H = S(board.board.h) + PAD_BORDER * 2;
  const layerFor = side => (side === 'bottom' ? COL.copperBottom : COL.copperTop);

  const parts = [];

  // ── Substrate ─────────────────────────────────────────────────────────
  if (show.substrate) {
    parts.push(`<rect x="${X(0)}" y="${Y(0)}" width="${S(board.board.w)}" height="${S(board.board.h)}" rx="${S(1.5)}" fill="${COL.substrate}" stroke="${COL.substrateEdge}" stroke-width="2"/>`);
    // subtle copper-pour hatch border
    parts.push(`<rect x="${X(0) + 3}" y="${Y(0) + 3}" width="${S(board.board.w) - 6}" height="${S(board.board.h) - 6}" rx="${S(1.2)}" fill="none" stroke="${COL.substrateEdge}" stroke-width="0.6" opacity="0.5"/>`);
  }

  // ── Copper traces (etchings) — bottom first, then top ────────────────
  const traces = Array.isArray(board.traces) ? board.traces : [];
  for (const side of ['bottom', 'top']) {
    const vis = side === 'bottom' ? show.copperBottom : show.copperTop;
    if (!vis) continue;
    for (const t of traces) {
      if ((t.layer || 'top') !== side) continue;
      const pts = (t.points || []).map(p => `${X(p.x)},${Y(p.y)}`).join(' ');
      if (!pts) continue;
      const wpx = S(t.width || 0.4);
      parts.push(`<polyline points="${pts}" fill="none" stroke="${layerFor(side)}" stroke-width="${wpx}" stroke-linecap="round" stroke-linejoin="round" opacity="${side === 'bottom' ? 0.85 : 1}"/>`);
    }
  }

  // ── Ratsnest (unrouted airwires) ─────────────────────────────────────
  if (show.ratsnest && Array.isArray(board.ratsnest)) {
    for (const r of board.ratsnest) {
      parts.push(`<line x1="${X(r.a.x)}" y1="${Y(r.a.y)}" x2="${X(r.b.x)}" y2="${Y(r.b.y)}" stroke="${COL.rats}" stroke-width="0.8" stroke-dasharray="3 3" opacity="0.9"/>`);
    }
  }

  // ── Silkscreen: component body outlines + refdes ─────────────────────
  if (show.silk && Array.isArray(board.components)) {
    for (const c of board.components) {
      if (!c.body) continue;
      const rot = c.rot ? ` rotate(${c.rot} ${X(c.x)} ${Y(c.y)})` : '';
      const bw = S(c.body.w), bh = S(c.body.h);
      parts.push(`<g transform="translate(0,0)${rot}"><rect x="${X(c.x) - bw / 2}" y="${Y(c.y) - bh / 2}" width="${bw}" height="${bh}" rx="2" fill="none" stroke="${COL.silk}" stroke-width="1" opacity="0.85"/></g>`);
      parts.push(`<text x="${X(c.x)}" y="${Y(c.y) - bh / 2 - 3}" text-anchor="middle" font-family="ui-sans-serif,system-ui,sans-serif" font-size="9" fill="${COL.text}">${escapeXml(c.ref)}</text>`);
    }
  }

  // ── Vias ──────────────────────────────────────────────────────────────
  if (show.vias && Array.isArray(board.vias)) {
    for (const v of board.vias) {
      parts.push(`<circle cx="${X(v.x)}" cy="${Y(v.y)}" r="${S((v.outer || 0.8) / 2)}" fill="${COL.via}" stroke="#5f6368" stroke-width="0.6"/>`);
      parts.push(`<circle cx="${X(v.x)}" cy="${Y(v.y)}" r="${S((v.drill || 0.4) / 2)}" fill="${COL.drill}"/>`);
    }
  }

  // ── Pads + solder joints ──────────────────────────────────────────────
  if (show.pads) {
    for (const p of board.pads) {
      const cx = X(p.x), cy = Y(p.y);
      const w = S(p.w), h = S(p.h);
      const tinned = p.drill != null; // THT pads get a tinned-solder fillet
      const fill = tinned ? COL.padTin : COL.padCopper;
      if (p.shape === 'rect') {
        parts.push(`<rect x="${cx - w / 2}" y="${cy - h / 2}" width="${w}" height="${h}" rx="1.5" fill="${fill}" stroke="#8a7a3f" stroke-width="0.6"/>`);
      } else if (p.shape === 'oval') {
        parts.push(`<rect x="${cx - w / 2}" y="${cy - h / 2}" width="${w}" height="${h}" rx="${Math.min(w, h) / 2}" fill="${fill}" stroke="#8a7a3f" stroke-width="0.6"/>`);
      } else {
        parts.push(`<circle cx="${cx}" cy="${cy}" r="${Math.max(w, h) / 2}" fill="${fill}" stroke="#8a7a3f" stroke-width="0.6"/>`);
      }
      // Solder-joint highlight ring + plated drill hole.
      if (p.drill != null) {
        parts.push(`<circle cx="${cx}" cy="${cy}" r="${Math.max(w, h) / 2 - 1}" fill="none" stroke="${COL.padTinHi}" stroke-width="0.8" opacity="0.7"/>`);
        parts.push(`<circle cx="${cx}" cy="${cy}" r="${S(p.drill / 2)}" fill="${COL.drill}"/>`);
      }
      // pad 1 / polarity key marker.
      if (p.shape === 'rect' && p.num === 1) {
        parts.push(`<rect x="${cx - w / 2 - 1.5}" y="${cy - h / 2 - 1.5}" width="${w + 3}" height="${h + 3}" rx="1.5" fill="none" stroke="${COL.silk}" stroke-width="0.8" opacity="0.7"/>`);
      }
    }
  }

  const title = board.title ? `<title>${escapeXml(board.title)}</title>` : '';
  // data-fauna-pcb: provenance marker proving this SVG came from the board
  // engine (see circuit-renderer.js for the rationale).
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" role="img" data-fauna-pcb="v1" aria-label="PCB board layout">
${title}
<rect x="0" y="0" width="${W}" height="${H}" fill="#15171a"/>
${parts.join('\n')}
</svg>`;

  return { svg, width: W, height: H, warnings };
}

function escapeXml(s) {
  return String(s).replace(/[<>&"']/g, c => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&#39;' }[c]));
}
