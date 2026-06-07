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
// Labels get a white halo via paint-order so they stay readable when wires
// (or other component lines) cross underneath them.
const TEXT = 'font-family="ui-sans-serif,system-ui,sans-serif" font-size="11" fill="#111" stroke="#fff" stroke-width="3" paint-order="stroke" stroke-linejoin="round"';
const TEXT_PLAIN = 'font-family="ui-sans-serif,system-ui,sans-serif" font-size="11" fill="#111"';

// The renderer rotates the whole component group (translate+rotate) so the
// glyph geometry orients correctly. Text labels, however, must stay upright and
// readable regardless of component rotation. `_labelRot` carries the current
// component rotation so `label()` can counter-rotate each text element around
// its own anchor — net glyph rotation is 0 (upright) while the anchor still
// tracks the rotated component position.
let _labelRot = 0;
export function setLabelRotation(deg) {
  _labelRot = (((Number(deg) || 0) % 360) + 360) % 360;
}

function label(text, x, y, anchor = 'middle') {
  if (!text) return '';
  const counter = _labelRot ? ` transform="rotate(${-_labelRot} ${x} ${y})"` : '';
  return `<text x="${x}" y="${y}" text-anchor="${anchor}"${counter} ${TEXT}>${escapeXml(text)}</text>`;
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
      <polygon points="-22,-22 -22,22 22,0" fill="#fff" ${STROKE}/>
      <line x1="-28" y1="-10" x2="-22" y2="-10" ${STROKE}/>
      <line x1="-28" y1="10"  x2="-22" y2="10"  ${STROKE}/>
      <line x1="22"  y1="0"   x2="28"  y2="0"   ${STROKE}/>
      <line x1="0"   y1="-22" x2="0"   y2="-16" ${STROKE}/>
      <line x1="0"   y1="22"  x2="0"   y2="16"  ${STROKE}/>
      <text x="-18" y="-6" ${TEXT_PLAIN}>+</text>
      <text x="-18" y="14" ${TEXT_PLAIN}>−</text>
      ${label(id, -24, -26, 'start')}
      ${label(value, 24, 36, 'end')}
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
    bbox: { w: 40, h: 30 },
    pins: { pos: { x: 0, y: -15, dir: 'power' }, neg: { x: 0, y: 15, dir: 'power' } },
    pinAliases: { p1: 'pos', p2: 'neg', '+': 'pos', '-': 'neg' },
    polarized: true,
    render: ({ value, id }) => `
      <circle cx="0" cy="0" r="12" fill="#fff" ${STROKE}/>
      <line x1="0" y1="-15" x2="0" y2="-12" ${STROKE}/>
      <line x1="0" y1="15"  x2="0" y2="12" ${STROKE}/>
      <text x="0" y="-3" text-anchor="middle" ${TEXT_PLAIN}>+</text>
      <text x="0" y="9"  text-anchor="middle" ${TEXT_PLAIN}>−</text>
      ${label(id, -18, -2, 'end')}
      ${label(value, 18, 6, 'start')}
    `,
  },

  // ── Current source (circle with arrow) ─────────────────────────────
  isource: {
    bbox: { w: 30, h: 40 },
    pins: { pos: { x: 0, y: -20, dir: 'power' }, neg: { x: 0, y: 20, dir: 'power' } },
    pinAliases: { p1: 'pos', p2: 'neg', '+': 'pos', '-': 'neg' },
    polarized: true,
    render: ({ value, id }) => `
      <circle cx="0" cy="0" r="12" fill="#fff" ${STROKE}/>
      <line x1="0" y1="-20" x2="0" y2="-12" ${STROKE}/>
      <line x1="0" y1="20"  x2="0" y2="12" ${STROKE}/>
      <line x1="0" y1="7" x2="0" y2="-7" ${STROKE}/>
      <polygon points="-4,-3 4,-3 0,-9" ${FILL}/>
      ${label(id, -16, -2, 'end')}
      ${label(value, 16, 4, 'start')}
    `,
  },

  // ── Battery (multi-cell) ───────────────────────────────────────────
  battery: {
    bbox: { w: 30, h: 36 },
    pins: { pos: { x: 0, y: -18, dir: 'power' }, neg: { x: 0, y: 18, dir: 'power' } },
    pinAliases: { p1: 'pos', p2: 'neg', '+': 'pos', '-': 'neg' },
    polarized: true,
    render: ({ value, id }) => `
      <line x1="0" y1="-18" x2="0" y2="-10" ${STROKE}/>
      <line x1="-10" y1="-10" x2="10" y2="-10" ${STROKE}/>
      <line x1="-5" y1="-5" x2="5" y2="-5" ${STROKE}/>
      <line x1="-10" y1="0" x2="10" y2="0" ${STROKE}/>
      <line x1="-5" y1="5" x2="5" y2="5" ${STROKE}/>
      <line x1="-10" y1="10" x2="10" y2="10" ${STROKE}/>
      <line x1="0" y1="10" x2="0" y2="18" ${STROKE}/>
      <text x="-12" y="-8" ${TEXT}>+</text>
      ${label(id, 14, -8, 'start')}
      ${label(value, 14, 8, 'start')}
    `,
  },

  // ── Zener diode (bent cathode bar) ─────────────────────────────────
  zener: {
    bbox: { w: 30, h: 16 },
    pins: { a: { x: -15, y: 0, dir: 'passive' }, k: { x: 15, y: 0, dir: 'passive' } },
    polarized: true,
    pinAliases: { p1: 'a', p2: 'k', anode: 'a', cathode: 'k', '+': 'a', '-': 'k' },
    render: ({ value, id }) => `
      <line x1="-15" y1="0" x2="-6" y2="0" ${STROKE}/>
      <polygon points="-6,-7 -6,7 6,0" ${FILL}/>
      <polyline points="2,-11 6,-7 6,7 10,11" ${STROKE}/>
      <line x1="6" y1="0" x2="15" y2="0" ${STROKE}/>
      ${label(id, 0, -13)}
      ${label(value, 0, 19)}
    `,
  },

  // ── Schottky diode (bracketed cathode bar) ─────────────────────────
  schottky: {
    bbox: { w: 30, h: 16 },
    pins: { a: { x: -15, y: 0, dir: 'passive' }, k: { x: 15, y: 0, dir: 'passive' } },
    polarized: true,
    pinAliases: { p1: 'a', p2: 'k', anode: 'a', cathode: 'k', '+': 'a', '-': 'k' },
    render: ({ value, id }) => `
      <line x1="-15" y1="0" x2="-6" y2="0" ${STROKE}/>
      <polygon points="-6,-7 -6,7 6,0" ${FILL}/>
      <polyline points="2,-7 2,-11 6,-11 6,7 10,7 10,11" ${STROKE}/>
      <line x1="6" y1="0" x2="15" y2="0" ${STROKE}/>
      ${label(id, 0, -13)}
      ${label(value, 0, 19)}
    `,
  },

  // ── Photodiode (diode with inward arrows) ──────────────────────────
  photodiode: {
    bbox: { w: 30, h: 26 },
    pins: { a: { x: -15, y: 0, dir: 'passive' }, k: { x: 15, y: 0, dir: 'passive' } },
    polarized: true,
    pinAliases: { p1: 'a', p2: 'k', anode: 'a', cathode: 'k', '+': 'a', '-': 'k' },
    render: ({ value, id }) => `
      <line x1="-15" y1="0" x2="-6" y2="0" ${STROKE}/>
      <polygon points="-6,-7 -6,7 6,0" ${FILL}/>
      <line x1="6" y1="-7" x2="6" y2="7" ${STROKE}/>
      <line x1="6" y1="0" x2="15" y2="0" ${STROKE}/>
      <line x1="-10" y1="-16" x2="-4" y2="-10" ${STROKE}/>
      <polygon points="-5,-12 -3,-9 -8,-10" ${FILL}/>
      <line x1="-3" y1="-18" x2="3" y2="-12" ${STROKE}/>
      <polygon points="2,-14 4,-11 -1,-12" ${FILL}/>
      ${label(id, 0, 18)}
      ${label(value, 0, 26)}
    `,
  },

  // ── Potentiometer (resistor + wiper arrow) ─────────────────────────
  potentiometer: {
    bbox: { w: 60, h: 30 },
    pins: {
      p1: { x: -30, y: 0, dir: 'passive' },
      p2: { x: 30, y: 0, dir: 'passive' },
      w:  { x: 0, y: -20, dir: 'passive' },
    },
    polarized: false,
    pinAliases: { wiper: 'w', '3': 'w' },
    render: ({ value, id }) => `
      <line x1="-30" y1="0" x2="-18" y2="0" ${STROKE}/>
      <polyline points="-18,0 -15,-7 -9,7 -3,-7 3,7 9,-7 15,7 18,0" ${STROKE}/>
      <line x1="18" y1="0" x2="30" y2="0" ${STROKE}/>
      <line x1="0" y1="-20" x2="0" y2="-7" ${STROKE}/>
      <polygon points="-4,-7 4,-7 0,-1" ${FILL}/>
      ${label(id, 16, -10, 'start')}
      ${label(value, 0, 20)}
    `,
  },

  // ── Thermistor (resistor with diagonal slash) ──────────────────────
  thermistor: {
    bbox: { w: 60, h: 24 },
    pins: { p1: { x: -30, y: 0, dir: 'passive' }, p2: { x: 30, y: 0, dir: 'passive' } },
    polarized: false,
    render: ({ value, id }) => `
      <line x1="-30" y1="0" x2="-18" y2="0" ${STROKE}/>
      <rect x="-18" y="-7" width="36" height="14" fill="#fff" ${STROKE}/>
      <line x1="18" y1="0" x2="30" y2="0" ${STROKE}/>
      <line x1="-16" y1="12" x2="10" y2="-12" ${STROKE}/>
      <line x1="-16" y1="6" x2="-16" y2="12" ${STROKE}/>
      ${label(id, 0, -12)}
      ${label(value, 0, 24)}
    `,
  },

  // ── Fuse ───────────────────────────────────────────────────────────
  fuse: {
    bbox: { w: 50, h: 16 },
    pins: { p1: { x: -25, y: 0, dir: 'passive' }, p2: { x: 25, y: 0, dir: 'passive' } },
    polarized: false,
    render: ({ value, id }) => `
      <line x1="-25" y1="0" x2="-16" y2="0" ${STROKE}/>
      <rect x="-16" y="-6" width="32" height="12" fill="#fff" ${STROKE}/>
      <line x1="-16" y1="0" x2="16" y2="0" ${STROKE}/>
      <line x1="16" y1="0" x2="25" y2="0" ${STROKE}/>
      ${label(id, 0, -10)}
      ${label(value, 0, 18)}
    `,
  },

  // ── Lamp / bulb (circle with X) ────────────────────────────────────
  lamp: {
    bbox: { w: 30, h: 30 },
    pins: { p1: { x: -15, y: 0, dir: 'passive' }, p2: { x: 15, y: 0, dir: 'passive' } },
    polarized: false,
    render: ({ value, id }) => `
      <line x1="-15" y1="0" x2="-11" y2="0" ${STROKE}/>
      <circle cx="0" cy="0" r="11" fill="#fff" ${STROKE}/>
      <line x1="-8" y1="-8" x2="8" y2="8" ${STROKE}/>
      <line x1="-8" y1="8" x2="8" y2="-8" ${STROKE}/>
      <line x1="11" y1="0" x2="15" y2="0" ${STROKE}/>
      ${label(id, 0, -14)}
      ${label(value, 0, 22)}
    `,
  },

  // ── Speaker ────────────────────────────────────────────────────────
  speaker: {
    bbox: { w: 36, h: 28 },
    pins: { p1: { x: -18, y: -6, dir: 'passive' }, p2: { x: -18, y: 6, dir: 'passive' } },
    polarized: false,
    render: ({ value, id }) => `
      <line x1="-18" y1="-6" x2="-8" y2="-6" ${STROKE}/>
      <line x1="-18" y1="6" x2="-8" y2="6" ${STROKE}/>
      <rect x="-8" y="-8" width="6" height="16" fill="#fff" ${STROKE}/>
      <polygon points="-2,-8 -2,8 10,16 10,-16" fill="#fff" ${STROKE}/>
      ${label(id, 2, -16, 'middle')}
      ${label(value, 2, 26)}
    `,
  },

  // ── Buzzer / piezo ─────────────────────────────────────────────────
  buzzer: {
    bbox: { w: 30, h: 30 },
    pins: { p1: { x: -10, y: 15, dir: 'passive' }, p2: { x: 10, y: 15, dir: 'passive' } },
    polarized: false,
    render: ({ value, id }) => `
      <path d="M -13 4 A 13 13 0 0 1 13 4 Z" fill="#fff" ${STROKE}/>
      <line x1="-10" y1="4" x2="-10" y2="15" ${STROKE}/>
      <line x1="10" y1="4" x2="10" y2="15" ${STROKE}/>
      ${label(id, 0, -2)}
      ${label(value, 0, 26)}
    `,
  },

  // ── Crystal / resonator ────────────────────────────────────────────
  crystal: {
    bbox: { w: 34, h: 22 },
    pins: { p1: { x: -17, y: 0, dir: 'passive' }, p2: { x: 17, y: 0, dir: 'passive' } },
    polarized: false,
    render: ({ value, id }) => `
      <line x1="-17" y1="0" x2="-7" y2="0" ${STROKE}/>
      <line x1="-7" y1="-9" x2="-7" y2="9" ${STROKE}/>
      <rect x="-3" y="-9" width="6" height="18" fill="#fff" ${STROKE}/>
      <line x1="7" y1="-9" x2="7" y2="9" ${STROKE}/>
      <line x1="7" y1="0" x2="17" y2="0" ${STROKE}/>
      ${label(id, 0, -13)}
      ${label(value, 0, 21)}
    `,
  },

  // ── Motor ──────────────────────────────────────────────────────────
  motor: {
    bbox: { w: 30, h: 30 },
    pins: { p1: { x: 0, y: -15, dir: 'passive' }, p2: { x: 0, y: 15, dir: 'passive' } },
    polarized: false,
    render: ({ value, id }) => `
      <line x1="0" y1="-15" x2="0" y2="-11" ${STROKE}/>
      <circle cx="0" cy="0" r="11" fill="#fff" ${STROKE}/>
      <text x="0" y="4" text-anchor="middle" ${TEXT_PLAIN}>M</text>
      <line x1="0" y1="11" x2="0" y2="15" ${STROKE}/>
      ${label(id, -14, 0, 'end')}
      ${label(value, 14, 0, 'start')}
    `,
  },

  // ── Ammeter ────────────────────────────────────────────────────────
  ammeter: {
    bbox: { w: 30, h: 30 },
    pins: { p1: { x: -15, y: 0, dir: 'passive' }, p2: { x: 15, y: 0, dir: 'passive' } },
    polarized: false,
    render: ({ id }) => `
      <line x1="-15" y1="0" x2="-11" y2="0" ${STROKE}/>
      <circle cx="0" cy="0" r="11" fill="#fff" ${STROKE}/>
      <text x="0" y="4" text-anchor="middle" ${TEXT_PLAIN}>A</text>
      <line x1="11" y1="0" x2="15" y2="0" ${STROKE}/>
      ${label(id, 0, -14)}
    `,
  },

  // ── Voltmeter ──────────────────────────────────────────────────────
  voltmeter: {
    bbox: { w: 30, h: 30 },
    pins: { p1: { x: -15, y: 0, dir: 'passive' }, p2: { x: 15, y: 0, dir: 'passive' } },
    polarized: false,
    render: ({ id }) => `
      <line x1="-15" y1="0" x2="-11" y2="0" ${STROKE}/>
      <circle cx="0" cy="0" r="11" fill="#fff" ${STROKE}/>
      <text x="0" y="4" text-anchor="middle" ${TEXT_PLAIN}>V</text>
      <line x1="11" y1="0" x2="15" y2="0" ${STROKE}/>
      ${label(id, 0, -14)}
    `,
  },

  // ── Push-button (momentary, normally open) ─────────────────────────
  switch_push: {
    bbox: { w: 40, h: 22 },
    pins: { p1: { x: -20, y: 0, dir: 'passive' }, p2: { x: 20, y: 0, dir: 'passive' } },
    polarized: false,
    render: ({ value, id, props }) => {
      const closed = props && props.closed;
      const bar = closed
        ? `<line x1="-10" y1="-4" x2="10" y2="-4" ${STROKE}/><line x1="0" y1="-4" x2="0" y2="-12" ${STROKE}/>`
        : `<line x1="-10" y1="-8" x2="10" y2="-8" ${STROKE}/><line x1="0" y1="-8" x2="0" y2="-14" ${STROKE}/>`;
      return `
        <line x1="-20" y1="0" x2="-10" y2="0" ${STROKE}/>
        <line x1="10" y1="0" x2="20" y2="0" ${STROKE}/>
        <line x1="-10" y1="-2" x2="-10" y2="2" ${STROKE}/>
        <line x1="10" y1="-2" x2="10" y2="2" ${STROKE}/>
        ${bar}
        ${label(id, 0, -18)}
        ${label(value, 0, 16)}
      `;
    },
  },

  // ── SPDT switch (common + two throws) ──────────────────────────────
  switch_spdt: {
    bbox: { w: 40, h: 30 },
    pins: {
      com: { x: -20, y: 0, dir: 'passive' },
      no:  { x: 20, y: -10, dir: 'passive' },
      nc:  { x: 20, y: 10, dir: 'passive' },
    },
    polarized: false,
    pinAliases: { p1: 'com', p2: 'no', p3: 'nc', common: 'com' },
    render: ({ value, id, props }) => {
      const toNo = props && props.throw === 'no';
      const arm = toNo
        ? `<line x1="-12" y1="0" x2="11" y2="-10" ${STROKE}/>`
        : `<line x1="-12" y1="0" x2="11" y2="10" ${STROKE}/>`;
      return `
        <line x1="-20" y1="0" x2="-12" y2="0" ${STROKE}/>
        <line x1="11" y1="-10" x2="20" y2="-10" ${STROKE}/>
        <line x1="11" y1="10" x2="20" y2="10" ${STROKE}/>
        ${arm}
        <circle cx="-12" cy="0" r="2" ${FILL}/>
        <circle cx="11" cy="-10" r="2" ${FILL}/>
        <circle cx="11" cy="10" r="2" ${FILL}/>
        ${label(id, 0, -16)}
        ${label(value, 0, 24)}
      `;
    },
  },

  // ── N-channel MOSFET (enhancement) ─────────────────────────────────
  nmos: {
    bbox: { w: 40, h: 44 },
    pins: { d: { x: 14, y: -20, dir: 'io' }, g: { x: -20, y: 0, dir: 'in' }, s: { x: 14, y: 20, dir: 'io' } },
    polarized: true,
    render: ({ value, id }) => `
      <line x1="-20" y1="0" x2="-8" y2="0" ${STROKE}/>
      <line x1="-8" y1="-12" x2="-8" y2="12" ${STROKE}/>
      <line x1="-3" y1="-12" x2="-3" y2="-4" ${STROKE}/>
      <line x1="-3" y1="-4" x2="-3" y2="4" ${STROKE}/>
      <line x1="-3" y1="4" x2="-3" y2="12" ${STROKE}/>
      <line x1="-3" y1="-8" x2="14" y2="-8" ${STROKE}/>
      <line x1="14" y1="-8" x2="14" y2="-20" ${STROKE}/>
      <line x1="-3" y1="8" x2="14" y2="8" ${STROKE}/>
      <line x1="14" y1="8" x2="14" y2="20" ${STROKE}/>
      <line x1="-3" y1="0" x2="6" y2="0" ${STROKE}/>
      <polygon points="0,-4 0,4 6,0" ${FILL}/>
      ${label(id, -10, -16, 'end')}
      ${label(value, 20, 4, 'start')}
    `,
  },

  // ── P-channel MOSFET (enhancement) ─────────────────────────────────
  pmos: {
    bbox: { w: 40, h: 44 },
    pins: { d: { x: 14, y: 20, dir: 'io' }, g: { x: -20, y: 0, dir: 'in' }, s: { x: 14, y: -20, dir: 'io' } },
    polarized: true,
    render: ({ value, id }) => `
      <line x1="-20" y1="0" x2="-8" y2="0" ${STROKE}/>
      <line x1="-8" y1="-12" x2="-8" y2="12" ${STROKE}/>
      <line x1="-3" y1="-12" x2="-3" y2="-4" ${STROKE}/>
      <line x1="-3" y1="-4" x2="-3" y2="4" ${STROKE}/>
      <line x1="-3" y1="4" x2="-3" y2="12" ${STROKE}/>
      <line x1="-3" y1="-8" x2="14" y2="-8" ${STROKE}/>
      <line x1="14" y1="-8" x2="14" y2="-20" ${STROKE}/>
      <line x1="-3" y1="8" x2="14" y2="8" ${STROKE}/>
      <line x1="14" y1="8" x2="14" y2="20" ${STROKE}/>
      <line x1="6" y1="0" x2="14" y2="0" ${STROKE}/>
      <polygon points="6,-4 6,4 0,0" ${FILL}/>
      ${label(id, -10, -16, 'end')}
      ${label(value, 20, 4, 'start')}
    `,
  },

  // ── N-channel JFET ─────────────────────────────────────────────────
  njfet: {
    bbox: { w: 40, h: 44 },
    pins: { d: { x: 12, y: -20, dir: 'io' }, g: { x: -20, y: 0, dir: 'in' }, s: { x: 12, y: 20, dir: 'io' } },
    polarized: true,
    render: ({ value, id }) => `
      <line x1="-20" y1="0" x2="-6" y2="0" ${STROKE}/>
      <line x1="-6" y1="-12" x2="-6" y2="12" ${STROKE}/>
      <line x1="-6" y1="-8" x2="12" y2="-8" ${STROKE}/>
      <line x1="12" y1="-8" x2="12" y2="-20" ${STROKE}/>
      <line x1="-6" y1="8" x2="12" y2="8" ${STROKE}/>
      <line x1="12" y1="8" x2="12" y2="20" ${STROKE}/>
      <polygon points="-14,-4 -14,4 -8,0" ${FILL}/>
      ${label(id, -10, -16, 'end')}
      ${label(value, 18, 4, 'start')}
    `,
  },

  // ── P-channel JFET ─────────────────────────────────────────────────
  pjfet: {
    bbox: { w: 40, h: 44 },
    pins: { d: { x: 12, y: -20, dir: 'io' }, g: { x: -20, y: 0, dir: 'in' }, s: { x: 12, y: 20, dir: 'io' } },
    polarized: true,
    render: ({ value, id }) => `
      <line x1="-20" y1="0" x2="-6" y2="0" ${STROKE}/>
      <line x1="-6" y1="-12" x2="-6" y2="12" ${STROKE}/>
      <line x1="-6" y1="-8" x2="12" y2="-8" ${STROKE}/>
      <line x1="12" y1="-8" x2="12" y2="-20" ${STROKE}/>
      <line x1="-6" y1="8" x2="12" y2="8" ${STROKE}/>
      <line x1="12" y1="8" x2="12" y2="20" ${STROKE}/>
      <polygon points="-12,-4 -12,4 -6,0" ${FILL}/>
      ${label(id, -10, -16, 'end')}
      ${label(value, 18, 4, 'start')}
    `,
  },

  // ── Phototransistor (NPN with inward arrows) ───────────────────────
  phototransistor: {
    bbox: { w: 40, h: 44 },
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
      <line x1="-24" y1="-22" x2="-16" y2="-14" ${STROKE}/>
      <polygon points="-17,-16 -15,-13 -20,-14" ${FILL}/>
      <line x1="-18" y1="-26" x2="-10" y2="-18" ${STROKE}/>
      <polygon points="-11,-20 -9,-17 -14,-18" ${FILL}/>
      ${label(id, -20, 18, 'end')}
      ${label(value, 18, 4, 'start')}
    `,
  },

  // ── Transformer (two coupled coils) ────────────────────────────────
  transformer: {
    bbox: { w: 50, h: 50 },
    pins: {
      p1: { x: -20, y: -18, dir: 'passive' },
      p2: { x: -20, y: 18, dir: 'passive' },
      s1: { x: 20, y: -18, dir: 'passive' },
      s2: { x: 20, y: 18, dir: 'passive' },
    },
    polarized: false,
    render: ({ value, id }) => `
      <line x1="-20" y1="-18" x2="-12" y2="-18" ${STROKE}/>
      <line x1="-20" y1="18" x2="-12" y2="18" ${STROKE}/>
      <path d="M -12 -18 Q -22 -12 -12 -6 Q -22 0 -12 6 Q -22 12 -12 18" ${STROKE}/>
      <line x1="-3" y1="-22" x2="-3" y2="22" ${STROKE}/>
      <line x1="3" y1="-22" x2="3" y2="22" ${STROKE}/>
      <path d="M 12 -18 Q 22 -12 12 -6 Q 22 0 12 6 Q 22 12 12 18" ${STROKE}/>
      <line x1="12" y1="-18" x2="20" y2="-18" ${STROKE}/>
      <line x1="12" y1="18" x2="20" y2="18" ${STROKE}/>
      ${label(id, 0, -26)}
      ${label(value, 0, 32)}
    `,
  },

  // ── Relay (coil + SPST contact) ────────────────────────────────────
  relay: {
    bbox: { w: 54, h: 44 },
    pins: {
      c1: { x: -27, y: -10, dir: 'passive' },
      c2: { x: -27, y: 10, dir: 'passive' },
      p1: { x: 27, y: -14, dir: 'passive' },
      p2: { x: 27, y: 14, dir: 'passive' },
    },
    polarized: false,
    pinAliases: { coil1: 'c1', coil2: 'c2', a: 'p1', b: 'p2' },
    render: ({ value, id, props }) => {
      const energized = props && props.energized;
      const arm = energized
        ? `<line x1="12" y1="-10" x2="22" y2="-12" ${STROKE}/>`
        : `<line x1="12" y1="-10" x2="22" y2="-2" ${STROKE}/>`;
      return `
        <line x1="-27" y1="-10" x2="-18" y2="-10" ${STROKE}/>
        <line x1="-27" y1="10" x2="-18" y2="10" ${STROKE}/>
        <rect x="-18" y="-12" width="14" height="24" fill="#fff" ${STROKE}/>
        <line x1="-4" y1="0" x2="8" y2="0" stroke="#111" stroke-width="1" stroke-dasharray="3 2"/>
        <line x1="12" y1="-14" x2="27" y2="-14" ${STROKE}/>
        <line x1="22" y1="14" x2="27" y2="14" ${STROKE}/>
        <line x1="12" y1="-14" x2="12" y2="-10" ${STROKE}/>
        ${arm}
        <circle cx="12" cy="-10" r="2" ${FILL}/>
        <circle cx="22" cy="14" r="2" ${FILL}/>
        ${label(id, 0, -16)}
        ${label(value, 0, 28)}
      `;
    },
  },

  // ── Test point ─────────────────────────────────────────────────────
  testpoint: {
    bbox: { w: 16, h: 16 },
    pins: { p: { x: 0, y: 6, dir: 'passive' } },
    polarized: false,
    isLabelOnly: true,
    render: ({ value, id }) => `
      <line x1="0" y1="6" x2="0" y2="0" ${STROKE}/>
      <circle cx="0" cy="-4" r="4" fill="#fff" ${STROKE}/>
      ${label(value || id, 0, -12)}
    `,
  },

  // ── 2-input AND gate ───────────────────────────────────────────────
  gate_and: {
    bbox: { w: 50, h: 40 },
    pins: { a: { x: -25, y: -8, dir: 'in' }, b: { x: -25, y: 8, dir: 'in' }, y: { x: 25, y: 0, dir: 'out' } },
    polarized: false,
    isLogic: true,
    render: ({ id }) => `
      <line x1="-25" y1="-8" x2="-14" y2="-8" ${STROKE}/>
      <line x1="-25" y1="8" x2="-14" y2="8" ${STROKE}/>
      <path d="M -14 -14 L 0 -14 A 14 14 0 0 1 0 14 L -14 14 Z" fill="#fff" ${STROKE}/>
      <line x1="14" y1="0" x2="25" y2="0" ${STROKE}/>
      ${label(id, 0, -18)}
    `,
  },

  // ── 2-input OR gate ────────────────────────────────────────────────
  gate_or: {
    bbox: { w: 50, h: 40 },
    pins: { a: { x: -25, y: -8, dir: 'in' }, b: { x: -25, y: 8, dir: 'in' }, y: { x: 25, y: 0, dir: 'out' } },
    polarized: false,
    isLogic: true,
    render: ({ id }) => `
      <line x1="-25" y1="-8" x2="-11" y2="-8" ${STROKE}/>
      <line x1="-25" y1="8" x2="-11" y2="8" ${STROKE}/>
      <path d="M -16 -14 Q -6 0 -16 14 Q 2 14 14 0 Q 2 -14 -16 -14 Z" fill="#fff" ${STROKE}/>
      <line x1="14" y1="0" x2="25" y2="0" ${STROKE}/>
      ${label(id, 0, -18)}
    `,
  },

  // ── NOT gate / inverter ────────────────────────────────────────────
  gate_not: {
    bbox: { w: 44, h: 32 },
    pins: { a: { x: -22, y: 0, dir: 'in' }, y: { x: 22, y: 0, dir: 'out' } },
    polarized: false,
    isLogic: true,
    pinAliases: { in: 'a', out: 'y' },
    render: ({ id }) => `
      <line x1="-22" y1="0" x2="-12" y2="0" ${STROKE}/>
      <polygon points="-12,-12 -12,12 10,0" fill="#fff" ${STROKE}/>
      <circle cx="13" cy="0" r="3" fill="#fff" ${STROKE}/>
      <line x1="16" y1="0" x2="22" y2="0" ${STROKE}/>
      ${label(id, 0, -16)}
    `,
  },

  // ── 2-input NAND gate ──────────────────────────────────────────────
  gate_nand: {
    bbox: { w: 54, h: 40 },
    pins: { a: { x: -27, y: -8, dir: 'in' }, b: { x: -27, y: 8, dir: 'in' }, y: { x: 27, y: 0, dir: 'out' } },
    polarized: false,
    isLogic: true,
    render: ({ id }) => `
      <line x1="-27" y1="-8" x2="-14" y2="-8" ${STROKE}/>
      <line x1="-27" y1="8" x2="-14" y2="8" ${STROKE}/>
      <path d="M -14 -14 L 0 -14 A 14 14 0 0 1 0 14 L -14 14 Z" fill="#fff" ${STROKE}/>
      <circle cx="17" cy="0" r="3" fill="#fff" ${STROKE}/>
      <line x1="20" y1="0" x2="27" y2="0" ${STROKE}/>
      ${label(id, 0, -18)}
    `,
  },

  // ── 2-input NOR gate ───────────────────────────────────────────────
  gate_nor: {
    bbox: { w: 54, h: 40 },
    pins: { a: { x: -27, y: -8, dir: 'in' }, b: { x: -27, y: 8, dir: 'in' }, y: { x: 27, y: 0, dir: 'out' } },
    polarized: false,
    isLogic: true,
    render: ({ id }) => `
      <line x1="-27" y1="-8" x2="-13" y2="-8" ${STROKE}/>
      <line x1="-27" y1="8" x2="-13" y2="8" ${STROKE}/>
      <path d="M -18 -14 Q -8 0 -18 14 Q 0 14 12 0 Q 0 -14 -18 -14 Z" fill="#fff" ${STROKE}/>
      <circle cx="15" cy="0" r="3" fill="#fff" ${STROKE}/>
      <line x1="18" y1="0" x2="27" y2="0" ${STROKE}/>
      ${label(id, 0, -18)}
    `,
  },

  // ── 2-input XOR gate ───────────────────────────────────────────────
  gate_xor: {
    bbox: { w: 54, h: 40 },
    pins: { a: { x: -27, y: -8, dir: 'in' }, b: { x: -27, y: 8, dir: 'in' }, y: { x: 27, y: 0, dir: 'out' } },
    polarized: false,
    isLogic: true,
    render: ({ id }) => `
      <line x1="-27" y1="-8" x2="-13" y2="-8" ${STROKE}/>
      <line x1="-27" y1="8" x2="-13" y2="8" ${STROKE}/>
      <path d="M -20 -14 Q -10 0 -20 14" ${STROKE}/>
      <path d="M -16 -14 Q -6 0 -16 14 Q 2 14 14 0 Q 2 -14 -16 -14 Z" fill="#fff" ${STROKE}/>
      <line x1="14" y1="0" x2="27" y2="0" ${STROKE}/>
      ${label(id, 0, -18)}
    `,
  },
};
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
