// ── Circuit symbol library ──────────────────────────────────────────────
// Each symbol has:
//   - pins: { name: { x, y, dir: 'in'|'out'|'io'|'power'|'passive' } }
//     coordinates are in SVG units (1 unit ≈ 1 px) relative to component center
//   - bbox: { w, h } symbol bounding box (centered on 0,0)
//   - render(props) → SVG markup string (no <svg> wrapper, no transform)
//
// Renderer applies translate(cx,cy) rotate(rot) around component center.
// "value" is the user-visible label (e.g. "10k", "1u", "BC547").

const STROKE = 'stroke="#111" stroke-width="1.6" fill="none" stroke-linecap="round" stroke-linejoin="round"';
const FILL = 'fill="#111"';
const TEXT = 'font-family="ui-sans-serif,system-ui,sans-serif" font-size="11" fill="#111"';

function label(text, x, y, anchor = 'middle') {
  if (!text) return '';
  return `<text x="${x}" y="${y}" text-anchor="${anchor}" ${TEXT}>${escapeXml(text)}</text>`;
}

function escapeXml(s) {
  return String(s).replace(/[<>&"']/g, c => ({ '<':'&lt;','>':'&gt;','&':'&amp;','"':'&quot;',"'":'&#39;' }[c]));
}

export const SYMBOLS = {
  // ── Passive: resistor (zig-zag) ─────────────────────────────────────
  resistor: {
    bbox: { w: 60, h: 20 },
    pins: { p1: { x: -30, y: 0, dir: 'passive' }, p2: { x: 30, y: 0, dir: 'passive' } },
    polarized: false,
    render: ({ value, id }) => `
      <line x1="-30" y1="0" x2="-18" y2="0" ${STROKE}/>
      <polyline points="-18,0 -15,-7 -9,7 -3,-7 3,7 9,-7 15,7 18,0" ${STROKE}/>
      <line x1="18" y1="0" x2="30" y2="0" ${STROKE}/>
      ${label(id, 0, -12)}
      ${label(value, 0, 20)}
    `,
  },

  // ── Passive: capacitor (non-polarized, two parallel plates) ────────
  capacitor: {
    bbox: { w: 30, h: 22 },
    pins: { p1: { x: -15, y: 0, dir: 'passive' }, p2: { x: 15, y: 0, dir: 'passive' } },
    polarized: false,
    render: ({ value, id }) => `
      <line x1="-15" y1="0" x2="-3" y2="0" ${STROKE}/>
      <line x1="-3" y1="-10" x2="-3" y2="10" ${STROKE}/>
      <line x1="3" y1="-10" x2="3" y2="10" ${STROKE}/>
      <line x1="3" y1="0" x2="15" y2="0" ${STROKE}/>
      ${label(id, 0, -14)}
      ${label(value, 0, 22)}
    `,
  },

  // ── Passive: polarized cap (one curved plate, + on left) ───────────
  capacitor_pol: {
    bbox: { w: 30, h: 22 },
    pins: { pos: { x: -15, y: 0, dir: 'passive' }, neg: { x: 15, y: 0, dir: 'passive' } },
    polarized: true,
    pinAliases: { p1: 'pos', p2: 'neg', '+': 'pos', '-': 'neg' },
    render: ({ value, id }) => `
      <line x1="-15" y1="0" x2="-3" y2="0" ${STROKE}/>
      <line x1="-3" y1="-10" x2="-3" y2="10" ${STROKE}/>
      <path d="M 5 -10 Q 9 0 5 10" ${STROKE}/>
      <line x1="5" y1="0" x2="15" y2="0" ${STROKE}/>
      <text x="-9" y="-12" ${TEXT}>+</text>
      ${label(id, 0, -14)}
      ${label(value, 0, 22)}
    `,
  },

  // ── Passive: inductor (3 humps) ────────────────────────────────────
  inductor: {
    bbox: { w: 60, h: 14 },
    pins: { p1: { x: -30, y: 0, dir: 'passive' }, p2: { x: 30, y: 0, dir: 'passive' } },
    polarized: false,
    render: ({ value, id }) => `
      <line x1="-30" y1="0" x2="-18" y2="0" ${STROKE}/>
      <path d="M -18 0 Q -12 -10 -6 0 Q 0 -10 6 0 Q 12 -10 18 0" ${STROKE}/>
      <line x1="18" y1="0" x2="30" y2="0" ${STROKE}/>
      ${label(id, 0, -12)}
      ${label(value, 0, 18)}
    `,
  },

  // ── Diode (anode → cathode) ────────────────────────────────────────
  diode: {
    bbox: { w: 30, h: 16 },
    pins: { a: { x: -15, y: 0, dir: 'passive' }, k: { x: 15, y: 0, dir: 'passive' } },
    polarized: true,
    pinAliases: { p1: 'a', p2: 'k', anode: 'a', cathode: 'k', '+': 'a', '-': 'k' },
    render: ({ value, id }) => `
      <line x1="-15" y1="0" x2="-6" y2="0" ${STROKE}/>
      <polygon points="-6,-7 -6,7 6,0" ${FILL}/>
      <line x1="6" y1="-7" x2="6" y2="7" ${STROKE}/>
      <line x1="6" y1="0" x2="15" y2="0" ${STROKE}/>
      ${label(id, 0, -12)}
      ${label(value, 0, 18)}
    `,
  },

  // ── LED (diode with arrows) ────────────────────────────────────────
  led: {
    bbox: { w: 30, h: 22 },
    pins: { a: { x: -15, y: 0, dir: 'passive' }, k: { x: 15, y: 0, dir: 'passive' } },
    polarized: true,
    pinAliases: { p1: 'a', p2: 'k', anode: 'a', cathode: 'k', '+': 'a', '-': 'k' },
    render: ({ value, id }) => `
      <line x1="-15" y1="0" x2="-6" y2="0" ${STROKE}/>
      <polygon points="-6,-7 -6,7 6,0" ${FILL}/>
      <line x1="6" y1="-7" x2="6" y2="7" ${STROKE}/>
      <line x1="6" y1="0" x2="15" y2="0" ${STROKE}/>
      <line x1="0" y1="-9" x2="6" y2="-15" ${STROKE}/>
      <polygon points="3,-15 7,-15 6,-11" ${FILL}/>
      <line x1="6" y1="-9" x2="12" y2="-15" ${STROKE}/>
      <polygon points="9,-15 13,-15 12,-11" ${FILL}/>
      ${label(id, -14, -14, 'start')}
      ${label(value, 0, 22)}
    `,
  },

  // ── NPN BJT ─────────────────────────────────────────────────────────
  npn: {
    bbox: { w: 36, h: 40 },
    pins: { c: { x: 10, y: -20, dir: 'io' }, b: { x: -18, y: 0, dir: 'in' }, e: { x: 10, y: 20, dir: 'io' } },
    polarized: true,
    render: ({ value, id }) => `
      <circle cx="0" cy="0" r="15" ${STROKE}/>
      <line x1="-18" y1="0" x2="-6" y2="0" ${STROKE}/>
      <line x1="-6" y1="-9" x2="-6" y2="9" ${STROKE}/>
      <line x1="-6" y1="-4" x2="10" y2="-12" ${STROKE}/>
      <line x1="10" y1="-12" x2="10" y2="-20" ${STROKE}/>
      <line x1="-6" y1="4" x2="10" y2="12" ${STROKE}/>
      <line x1="10" y1="12" x2="10" y2="20" ${STROKE}/>
      <polygon points="6,8 12,12 6,14" ${FILL}/>
      ${label(id, -20, -16, 'end')}
      ${label(value, 20, 4, 'start')}
    `,
  },

  // ── PNP BJT ─────────────────────────────────────────────────────────
  pnp: {
    bbox: { w: 36, h: 40 },
    pins: { c: { x: 10, y: 20, dir: 'io' }, b: { x: -18, y: 0, dir: 'in' }, e: { x: 10, y: -20, dir: 'io' } },
    polarized: true,
    render: ({ value, id }) => `
      <circle cx="0" cy="0" r="15" ${STROKE}/>
      <line x1="-18" y1="0" x2="-6" y2="0" ${STROKE}/>
      <line x1="-6" y1="-9" x2="-6" y2="9" ${STROKE}/>
      <line x1="-6" y1="-4" x2="10" y2="-12" ${STROKE}/>
      <line x1="10" y1="-12" x2="10" y2="-20" ${STROKE}/>
      <line x1="-6" y1="4" x2="10" y2="12" ${STROKE}/>
      <line x1="10" y1="12" x2="10" y2="20" ${STROKE}/>
      <polygon points="-2,-8 -8,-4 4,-2" ${FILL}/>
      ${label(id, -20, -16, 'end')}
      ${label(value, 20, 4, 'start')}
    `,
  },

  // ── Op-amp (triangle, in+ top, in- bottom, out right) ─────────────
  opamp: {
    bbox: { w: 56, h: 50 },
    pins: {
      'in+': { x: -28, y: -10, dir: 'in' },
      'in-': { x: -28, y: 10, dir: 'in' },
      out:   { x: 28,  y: 0,  dir: 'out' },
      vcc:   { x: 0,   y: -22, dir: 'power' },
      vee:   { x: 0,   y: 22,  dir: 'power' },
    },
    pinAliases: { '+': 'in+', '-': 'in-', VCC: 'vcc', VEE: 'vee', V_plus: 'vcc', V_minus: 'vee' },
    polarized: false,
    render: ({ value, id }) => `
      <polygon points="-22,-22 -22,22 22,0" ${STROKE}/>
      <line x1="-28" y1="-10" x2="-22" y2="-10" ${STROKE}/>
      <line x1="-28" y1="10"  x2="-22" y2="10"  ${STROKE}/>
      <line x1="22"  y1="0"   x2="28"  y2="0"   ${STROKE}/>
      <line x1="0"   y1="-22" x2="0"   y2="-16" ${STROKE}/>
      <line x1="0"   y1="22"  x2="0"   y2="16"  ${STROKE}/>
      <text x="-19" y="-7" ${TEXT}>+</text>
      <text x="-19" y="14" ${TEXT}>−</text>
      ${label(id, 0, -28)}
      ${label(value, 0, 36)}
    `,
  },

  // ── VCC rail (single pin going up) ─────────────────────────────────
  vcc: {
    bbox: { w: 20, h: 24 },
    pins: { p: { x: 0, y: 12, dir: 'power' } },
    polarized: false,
    isPower: 'VCC',
    render: ({ value, id }) => `
      <line x1="0" y1="-12" x2="0" y2="12" ${STROKE}/>
      <line x1="-10" y1="-12" x2="10" y2="-12" ${STROKE}/>
      ${label(value || id || 'VCC', 0, -16)}
    `,
  },

  // ── GND (downward triangle) ────────────────────────────────────────
  gnd: {
    bbox: { w: 20, h: 24 },
    pins: { p: { x: 0, y: -12, dir: 'power' } },
    polarized: false,
    isPower: 'GND',
    render: () => `
      <line x1="0" y1="-12" x2="0" y2="0" ${STROKE}/>
      <line x1="-10" y1="0" x2="10" y2="0" ${STROKE}/>
      <line x1="-6" y1="4" x2="6" y2="4" ${STROKE}/>
      <line x1="-2" y1="8" x2="2" y2="8" ${STROKE}/>
    `,
  },

  // ── SPST switch ────────────────────────────────────────────────────
  switch_spst: {
    bbox: { w: 40, h: 14 },
    pins: { p1: { x: -20, y: 0, dir: 'passive' }, p2: { x: 20, y: 0, dir: 'passive' } },
    polarized: false,
    render: ({ value, id, props }) => {
      const closed = props && props.closed;
      const arm = closed ? `<line x1="-12" y1="0" x2="12" y2="0" ${STROKE}/>` : `<line x1="-12" y1="0" x2="10" y2="-10" ${STROKE}/>`;
      return `
        <line x1="-20" y1="0" x2="-12" y2="0" ${STROKE}/>
        ${arm}
        <line x1="12" y1="0" x2="20" y2="0" ${STROKE}/>
        <circle cx="-12" cy="0" r="2" ${FILL}/>
        <circle cx="12"  cy="0" r="2" ${FILL}/>
        ${label(id, 0, -10)}
        ${label(value, 0, 18)}
      `;
    },
  },

  // ── Voltage source (circle with +/-) ───────────────────────────────
  vsource: {
    bbox: { w: 30, h: 30 },
    pins: { pos: { x: 0, y: -15, dir: 'power' }, neg: { x: 0, y: 15, dir: 'power' } },
    pinAliases: { p1: 'pos', p2: 'neg', '+': 'pos', '-': 'neg' },
    polarized: true,
    render: ({ value, id }) => `
      <circle cx="0" cy="0" r="12" ${STROKE}/>
      <line x1="0" y1="-15" x2="0" y2="-12" ${STROKE}/>
      <line x1="0" y1="15"  x2="0" y2="12" ${STROKE}/>
      <text x="0" y="-2" text-anchor="middle" ${TEXT}>+</text>
      <text x="0" y="9"  text-anchor="middle" ${TEXT}>−</text>
      ${label(id, -16, -4, 'end')}
      ${label(value, 16, 4, 'start')}
    `,
  },
};

// ── Helpers ──────────────────────────────────────────────────────────────
export function resolvePin(type, pinName) {
  const sym = SYMBOLS[type];
  if (!sym) return null;
  if (sym.pins[pinName]) return pinName;
  if (sym.pinAliases && sym.pinAliases[pinName]) return sym.pinAliases[pinName];
  return null;
}

export function getSymbol(type) {
  return SYMBOLS[type] || null;
}

export function listSymbolTypes() {
  return Object.keys(SYMBOLS);
}
