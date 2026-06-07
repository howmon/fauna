// ── PCB footprint library (land patterns) ──────────────────────────────
// Pure JS, no deps. Companion to circuit-symbols.js: every schematic symbol
// type maps to a physical footprint (copper pads + silkscreen body) so a
// circuit DSL can be laid out as a board.
//
// A footprint:
//   {
//     name:   'R_AXIAL_0.4in',
//     kind:   'THT' | 'SMD',
//     pads:   [ { num, x, y, shape:'round'|'rect'|'oval', w, h, drill? } ],   // mm
//     body:   { w, h },        // silkscreen outline (centered rect), mm
//     courtyard: { w, h },     // keep-out (centered rect), mm
//     pinMap: { <canonical schematic pin name>: <pad num> },
//   }
//
// Coordinates are in millimetres, component-centred (0,0), +x right / +y down
// (matching the schematic renderer's SVG axis convention).

import { resolvePin, getSymbol } from './circuit-symbols.js';

const ROUND = 'round', RECT = 'rect', OVAL = 'oval';

// Compute a silkscreen body + courtyard that comfortably encloses the pads.
function envelope(pads, { bodyMargin = 0.6, courtMargin = 0.25 } = {}) {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const p of pads) {
    const hw = (p.w || 1) / 2, hh = (p.h || 1) / 2;
    minX = Math.min(minX, p.x - hw); maxX = Math.max(maxX, p.x + hw);
    minY = Math.min(minY, p.y - hh); maxY = Math.max(maxY, p.y + hh);
  }
  if (!isFinite(minX)) { minX = -1; minY = -1; maxX = 1; maxY = 1; }
  const w = maxX - minX, h = maxY - minY;
  return {
    body: { w: +(w + bodyMargin * 2).toFixed(3), h: +(h + bodyMargin * 2).toFixed(3) },
    courtyard: { w: +(w + (bodyMargin + courtMargin) * 2).toFixed(3), h: +(h + (bodyMargin + courtMargin) * 2).toFixed(3) },
  };
}

// THT pad defaults: 0.9 mm drill, 1.8 mm round land (pad 1 squared for keying).
function thtPad(num, x, y, { drill = 0.9, land = 1.8, square = false } = {}) {
  return { num, x: +x.toFixed(3), y: +y.toFixed(3), shape: square ? RECT : ROUND, w: land, h: land, drill };
}
function smdPad(num, x, y, { w = 1.2, h = 1.4 } = {}) {
  return { num, x: +x.toFixed(3), y: +y.toFixed(3), shape: RECT, w, h };
}

// ── Factories ───────────────────────────────────────────────────────────
// Each returns { pads, pinMap, body, courtyard } given a pin→pad mapping.

function axial2(name, spacing, pinMap) {
  const [a, b] = Object.keys(pinMap);
  const pads = [
    thtPad(pinMap[a], -spacing / 2, 0, { square: true }),
    thtPad(pinMap[b], spacing / 2, 0),
  ];
  return { name, kind: 'THT', pads, ...envelope(pads), pinMap };
}

function radial2(name, spacing, pinMap, { posKey } = {}) {
  // Polarized 2-lead radial part: the positive/anode pad is squared & marked.
  const keys = Object.keys(pinMap);
  const pads = keys.map((k, i) =>
    thtPad(pinMap[k], (i === 0 ? -1 : 1) * spacing / 2, 0, { square: k === posKey }));
  return { name, kind: 'THT', pads, ...envelope(pads, { bodyMargin: 1.0 }), pinMap, polarMark: posKey ? pinMap[posKey] : null };
}

function inline3(name, pitch, pinMap, order) {
  // Three THT pads in a row. `order` lists pin names left→right.
  const pads = order.map((k, i) => thtPad(pinMap[k], (i - 1) * pitch, 0, { square: i === 0 }));
  return { name, kind: 'THT', pads, ...envelope(pads, { bodyMargin: 0.8 }), pinMap };
}

function quad4(name, dx, dy, pinMap, order) {
  // Four pads at the corners of a dx×dy rectangle. `order` = [TL,TR,BL,BR].
  const corners = [[-dx / 2, -dy / 2], [dx / 2, -dy / 2], [-dx / 2, dy / 2], [dx / 2, dy / 2]];
  const pads = order.map((k, i) => thtPad(pinMap[k], corners[i][0], corners[i][1], { square: i === 0 }));
  return { name, kind: 'THT', pads, ...envelope(pads, { bodyMargin: 1.0 }), pinMap };
}

function dip(name, nPins, pitch, rowGap, pinMap) {
  // DIP body: pins 1..n/2 down the left (top→bottom), then up the right.
  const perSide = nPins / 2;
  const pads = [];
  for (let i = 0; i < nPins; i++) {
    const num = i + 1;
    const left = i < perSide;
    const idx = left ? i : nPins - 1 - i;
    const x = (left ? -1 : 1) * rowGap / 2;
    const y = (idx - (perSide - 1) / 2) * pitch;
    pads.push(thtPad(num, x, y, { drill: 0.8, land: 1.6, square: num === 1 }));
  }
  return { name, kind: 'THT', pads, ...envelope(pads, { bodyMargin: 1.2 }), pinMap };
}

function singlePad(name, pinName, { land = 2.0, drill = 1.0 } = {}) {
  const pads = [thtPad(1, 0, 0, { land, drill })];
  return { name, kind: 'THT', pads, ...envelope(pads), pinMap: { [pinName]: 1 } };
}

function smd0805(name, pinMap) {
  const [a, b] = Object.keys(pinMap);
  const pads = [smdPad(pinMap[a], -1.0, 0), smdPad(pinMap[b], 1.0, 0)];
  return { name, kind: 'SMD', pads, ...envelope(pads, { bodyMargin: 0.3 }), pinMap };
}

// ── Type → footprint table ──────────────────────────────────────────────
// Values are factory thunks so each getFootprint call returns a fresh object
// (callers may translate/rotate pads during layout without mutating the table).
const P2 = { p1: 1, p2: 2 };

const TABLE = {
  // Generic 2-lead passives (0.4" axial THT).
  resistor:    { tht: () => axial2('R_AXIAL_0.4in', 10.16, P2), smd: () => smd0805('R_0805', P2) },
  capacitor:   { tht: () => axial2('C_DISC_0.2in', 5.08, P2),  smd: () => smd0805('C_0805', P2) },
  inductor:    { tht: () => axial2('L_AXIAL_0.4in', 10.16, P2) },
  thermistor:  { tht: () => axial2('TH_0.2in', 5.08, P2) },
  fuse:        { tht: () => axial2('FUSE_0.4in', 10.16, P2) },
  lamp:        { tht: () => axial2('LAMP_0.2in', 5.08, P2) },
  speaker:     { tht: () => axial2('SPKR_0.2in', 5.08, P2) },
  buzzer:      { tht: () => axial2('BUZZER_0.2in', 5.08, P2) },
  crystal:     { tht: () => axial2('XTAL_HC49', 4.88, P2) },
  motor:       { tht: () => axial2('MOTOR_0.2in', 5.08, P2) },
  ammeter:     { tht: () => axial2('METER_0.2in', 5.08, P2) },
  voltmeter:   { tht: () => axial2('METER_0.2in', 5.08, P2) },
  switch_spst: { tht: () => axial2('SW_0.2in', 5.08, P2) },
  switch_push: { tht: () => axial2('SW_PUSH_0.2in', 5.08, P2) },

  // Polarized 2-lead parts.
  capacitor_pol: { tht: () => radial2('CP_RADIAL_0.1in', 2.54, { pos: 1, neg: 2 }, { posKey: 'pos' }) },
  diode:         { tht: () => radial2('D_AXIAL_0.4in', 10.16, { a: 1, k: 2 }, { posKey: 'a' }) },
  zener:         { tht: () => radial2('D_AXIAL_0.4in', 10.16, { a: 1, k: 2 }, { posKey: 'a' }) },
  schottky:      { tht: () => radial2('D_AXIAL_0.4in', 10.16, { a: 1, k: 2 }, { posKey: 'a' }) },
  photodiode:    { tht: () => radial2('D_RADIAL_0.1in', 2.54, { a: 1, k: 2 }, { posKey: 'a' }) },
  led:           { tht: () => radial2('LED_5mm', 2.54, { a: 1, k: 2 }, { posKey: 'a' }) },
  vsource:       { tht: () => radial2('SRC_0.2in', 5.08, { pos: 1, neg: 2 }, { posKey: 'pos' }) },
  isource:       { tht: () => radial2('SRC_0.2in', 5.08, { pos: 1, neg: 2 }, { posKey: 'pos' }) },
  battery:       { tht: () => radial2('BATT_0.2in', 5.08, { pos: 1, neg: 2 }, { posKey: 'pos' }) },

  // 3-lead semiconductors (TO-92 inline, 0.1" pitch).
  npn:             { tht: () => inline3('TO-92', 2.54, { e: 1, b: 2, c: 3 }, ['e', 'b', 'c']) },
  pnp:             { tht: () => inline3('TO-92', 2.54, { e: 1, b: 2, c: 3 }, ['e', 'b', 'c']) },
  phototransistor: { tht: () => inline3('TO-92', 2.54, { e: 1, b: 2, c: 3 }, ['e', 'b', 'c']) },
  nmos:            { tht: () => inline3('TO-92', 2.54, { s: 1, g: 2, d: 3 }, ['s', 'g', 'd']) },
  pmos:            { tht: () => inline3('TO-92', 2.54, { s: 1, g: 2, d: 3 }, ['s', 'g', 'd']) },
  njfet:           { tht: () => inline3('TO-92', 2.54, { s: 1, g: 2, d: 3 }, ['s', 'g', 'd']) },
  pjfet:           { tht: () => inline3('TO-92', 2.54, { s: 1, g: 2, d: 3 }, ['s', 'g', 'd']) },

  // 3-terminal mechanical.
  potentiometer: { tht: () => inline3('POT_0.1in', 2.54, { p1: 1, w: 2, p2: 3 }, ['p1', 'w', 'p2']) },
  switch_spdt:   { tht: () => inline3('SW_SPDT_0.1in', 2.54, { no: 1, com: 2, nc: 3 }, ['no', 'com', 'nc']) },

  // 4-terminal.
  transformer: { tht: () => quad4('XFMR_4P', 7.62, 5.08, { p1: 1, p2: 2, s1: 3, s2: 4 }, ['p1', 'p2', 's1', 's2']) },
  relay:       { tht: () => quad4('RELAY_4P', 7.62, 5.08, { c1: 1, c2: 2, p1: 3, p2: 4 }, ['c1', 'c2', 'p1', 'p2']) },

  // Op-amp: single op-amp DIP-8 pinout (e.g. TL071): 2=in-, 3=in+, 4=vee, 6=out, 7=vcc.
  opamp: { tht: () => dip('DIP-8', 8, 2.54, 7.62, { 'in-': 2, 'in+': 3, vee: 4, out: 6, vcc: 7 }) },

  // Power rails / probes → single pad.
  vcc:       { tht: () => singlePad('VCC_PAD', 'p', { land: 2.2, drill: 1.0 }) },
  gnd:       { tht: () => singlePad('GND_PAD', 'p', { land: 2.2, drill: 1.0 }) },
  testpoint: { tht: () => singlePad('TP_1mm', 'p', { land: 1.6, drill: 0.7 }) },

  // Logic gates: stand-alone inline footprints (a,[b,]y). Real designs share a
  // multi-gate IC, but for single-gate boards an inline land pattern is enough.
  gate_and:  { tht: () => inline3('GATE_3P', 2.54, { a: 1, b: 2, y: 3 }, ['a', 'b', 'y']) },
  gate_or:   { tht: () => inline3('GATE_3P', 2.54, { a: 1, b: 2, y: 3 }, ['a', 'b', 'y']) },
  gate_nand: { tht: () => inline3('GATE_3P', 2.54, { a: 1, b: 2, y: 3 }, ['a', 'b', 'y']) },
  gate_nor:  { tht: () => inline3('GATE_3P', 2.54, { a: 1, b: 2, y: 3 }, ['a', 'b', 'y']) },
  gate_xor:  { tht: () => inline3('GATE_3P', 2.54, { a: 1, b: 2, y: 3 }, ['a', 'b', 'y']) },
  gate_not:  { tht: () => axial2('GATE_2P', 2.54, { a: 1, y: 2 }) },
};

/**
 * Return the footprint for a component type.
 * @param {string} type   schematic symbol type
 * @param {string} [variant='tht']  'tht' | 'smd' (falls back to tht)
 */
export function getFootprint(type, variant = 'tht') {
  const entry = TABLE[type];
  if (!entry) return null;
  const make = entry[variant] || entry.tht;
  if (!make) return null;
  const fp = make();
  fp.type = type;
  fp.variant = entry[variant] ? variant : 'tht';
  return fp;
}

/** List every component type that has a footprint, with its available variants. */
export function listFootprints() {
  return Object.keys(TABLE).map(type => ({
    type,
    variants: Object.keys(TABLE[type]),
    name: TABLE[type].tht().name,
  }));
}

/**
 * Resolve the pad number a schematic pin reference lands on.
 * Accepts canonical or alias pin names (via the symbol's resolvePin).
 * @returns {number|null}
 */
export function padForPin(type, pinName, variant = 'tht') {
  const fp = getFootprint(type, variant);
  if (!fp) return null;
  const canonical = resolvePin(type, pinName) || pinName;
  const pad = fp.pinMap[canonical];
  return pad == null ? null : pad;
}

/**
 * Sanity check that every footprint pad maps to a real schematic pin and that
 * every connectable schematic pin maps to a pad. Returns a list of problems
 * (empty array = all good). Used by tests and tooling.
 */
export function auditFootprints() {
  const problems = [];
  for (const type of Object.keys(TABLE)) {
    const sym = getSymbol(type);
    if (!sym) { problems.push({ type, issue: 'no symbol' }); continue; }
    const fp = getFootprint(type);
    const symPins = Object.keys(sym.pins);
    const mappedPins = Object.keys(fp.pinMap);
    // Every mapped pin must be a real (canonical) symbol pin.
    for (const p of mappedPins) {
      if (!symPins.includes(p)) problems.push({ type, issue: `pinMap references unknown pin "${p}"` });
    }
    // Every symbol pin must map to a pad.
    for (const p of symPins) {
      if (!mappedPins.includes(p)) problems.push({ type, issue: `symbol pin "${p}" has no pad` });
    }
    // Every mapped pad number must exist in pads[].
    const padNums = new Set(fp.pads.map(p => p.num));
    for (const p of mappedPins) {
      if (!padNums.has(fp.pinMap[p])) problems.push({ type, issue: `pin "${p}" maps to missing pad ${fp.pinMap[p]}` });
    }
  }
  return problems;
}
