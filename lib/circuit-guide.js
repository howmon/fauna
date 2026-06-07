// ── Circuit build guide (DSL → assembly instructions) ───────────────────
// Pure JS (async for the optional simulation step). Produces a structured
// build guide + Markdown from a circuit DSL: bill of materials, assembly
// order (low-profile parts first), polarity/orientation callouts, soldering
// steps, and a "test & verify" section whose expected readings come from the
// SPICE simulation (degrading gracefully when ngspice is absent).
//
// buildGuide(doc, opts) → {
//   ok, errors, warnings, title,
//   bom:        [{ refs, qty, value, type, footprint }],
//   steps:      [{ n, ref, type, value, action, orientation, padCount, mount }],
//   solderNotes:[string],
//   testPoints: [{ node, label, expected }],
//   simAvailable: boolean|null,
//   markdown:   string,
// }

import { validateCircuit } from './circuit-validate.js';
import { layoutPcb } from './circuit-pcb.js';
import { getSymbol, resolvePin } from './circuit-symbols.js';
import { simulateCircuit } from './circuit-simulate.js';

// Lower rank = assembled first (lies flatter / less heat-sensitive).
const PROFILE = {
  resistor: 1, fuse: 1, diode: 1, zener: 1, schottky: 1, photodiode: 1,
  opamp: 2, gate_and: 2, gate_or: 2, gate_not: 2, gate_nand: 2, gate_nor: 2, gate_xor: 2,
  npn: 3, pnp: 3, nmos: 3, pmos: 3, njfet: 3, pjfet: 3, phototransistor: 3, thermistor: 3,
  capacitor: 4, crystal: 4, inductor: 4,
  led: 5, potentiometer: 5,
  capacitor_pol: 6,
  switch_spst: 7, switch_push: 7, switch_spdt: 7, relay: 7, transformer: 7,
  motor: 7, speaker: 7, buzzer: 7, lamp: 7, ammeter: 7, voltmeter: 7,
  battery: 8, vsource: 8, isource: 8,
};

// Parts that have a wrong-way-round failure mode.
const POLARITY = new Set(['capacitor_pol', 'diode', 'led', 'zener', 'schottky', 'photodiode', 'battery', 'vsource', 'isource']);
const PIN1 = new Set(['opamp', 'npn', 'pnp', 'nmos', 'pmos', 'njfet', 'pjfet', 'phototransistor', 'gate_and', 'gate_or', 'gate_not', 'gate_nand', 'gate_nor', 'gate_xor']);
// Virtual symbols (rails / probes) — not physical BOM line items.
const VIRTUAL = new Set(['vcc', 'gnd', 'testpoint']);

const TYPE_LABEL = {
  resistor: 'resistor', capacitor: 'capacitor', capacitor_pol: 'electrolytic capacitor',
  inductor: 'inductor', diode: 'diode', led: 'LED', zener: 'Zener diode', schottky: 'Schottky diode',
  photodiode: 'photodiode', npn: 'NPN transistor', pnp: 'PNP transistor', phototransistor: 'phototransistor',
  nmos: 'N-MOSFET', pmos: 'P-MOSFET', njfet: 'N-JFET', pjfet: 'P-JFET', opamp: 'op-amp',
  potentiometer: 'potentiometer', thermistor: 'thermistor', fuse: 'fuse', lamp: 'lamp', speaker: 'speaker',
  buzzer: 'buzzer', crystal: 'crystal', motor: 'motor', ammeter: 'ammeter', voltmeter: 'voltmeter',
  switch_spst: 'SPST switch', switch_push: 'push-button', switch_spdt: 'SPDT switch',
  transformer: 'transformer', relay: 'relay', battery: 'battery', vsource: 'voltage source', isource: 'current source',
  gate_and: 'AND gate', gate_or: 'OR gate', gate_not: 'NOT gate', gate_nand: 'NAND gate', gate_nor: 'NOR gate', gate_xor: 'XOR gate',
};

/**
 * @param {object} doc  circuit DSL
 * @param {object} [opts]
 * @param {object} [opts.board]    pre-computed layoutPcb() board (else built here)
 * @param {object} [opts.sim]      pre-computed simulateCircuit() result
 * @param {object} [opts.analysis] analysis spec for the simulation (default .OP)
 * @param {boolean}[opts.runSim=true] run ngspice when no sim result supplied
 */
export async function buildGuide(doc, opts = {}) {
  const vr = validateCircuit(doc);
  const errors = [...(vr.errors || [])];
  const warnings = [...(vr.warnings || [])];
  const title = (doc && doc.title) ? String(doc.title) : 'Circuit';

  const board = opts.board || layoutPcb(doc, opts.boardOpts || {});
  if (!board.ok) {
    return { ok: false, errors: [...errors, ...board.errors], warnings, title, bom: [], steps: [], solderNotes: [], testPoints: [], simAvailable: null, markdown: '' };
  }

  // Index board components by id for footprint/ref/pad lookup.
  const byId = new Map(board.components.map(c => [c.id, c]));

  // ── Bill of materials (group identical parts) ─────────────────────────
  const bomMap = new Map();
  for (const c of board.components) {
    if (VIRTUAL.has(c.type)) continue;
    const key = `${c.type}|${c.value ?? ''}|${c.footprint}`;
    if (!bomMap.has(key)) bomMap.set(key, { refs: [], qty: 0, value: c.value ?? '', type: c.type, footprint: c.footprint });
    const e = bomMap.get(key);
    e.refs.push(c.ref);
    e.qty++;
  }
  const bom = [...bomMap.values()].map(e => ({ ...e, refs: e.refs.sort(naturalRef) }))
    .sort((a, b) => naturalRef(a.refs[0], b.refs[0]));

  // ── Assembly steps (profile order) ───────────────────────────────────
  const physical = board.components.filter(c => !VIRTUAL.has(c.type));
  physical.sort((a, b) => {
    const pa = PROFILE[a.type] ?? 5, pb = PROFILE[b.type] ?? 5;
    if (pa !== pb) return pa - pb;
    return naturalRef(a.ref, b.ref);
  });
  const steps = physical.map((c, i) => {
    const mount = c.kind === 'SMD' ? 'SMD' : 'THT';
    const orientation = POLARITY.has(c.type) ? 'polarity' : (PIN1.has(c.type) ? 'pin1' : null);
    return {
      n: i + 1, ref: c.ref, type: c.type, value: c.value ?? null,
      label: TYPE_LABEL[c.type] || c.type, padCount: c.pads.length, mount, orientation,
      action: actionText(c, mount, orientation),
    };
  });

  // ── Soldering notes ───────────────────────────────────────────────────
  const hasSmd = physical.some(c => c.kind === 'SMD');
  const hasTht = physical.some(c => c.kind !== 'SMD');
  const solderNotes = [];
  if (hasTht) solderNotes.push('THT parts: seat the part flush, splay the leads slightly to hold it, then heat the pad and lead together and feed solder into the joint — aim for a shiny concave fillet. Trim leads after.');
  if (hasSmd) solderNotes.push('SMD parts: tin one pad, tack the part in place against it, solder the opposite pad, then reflow the first joint.');
  if (steps.some(s => s.orientation === 'polarity')) solderNotes.push('Polarized parts (diodes, LEDs, electrolytics, sources): match the marked pad/band to the silkscreen + marker before soldering — reversing them can fail the circuit or damage the part.');
  if (steps.some(s => s.orientation === 'pin1')) solderNotes.push('ICs / transistors: align pin 1 (the squared pad) to the silkscreen key. Use a socket for ICs where possible to avoid heat damage.');
  solderNotes.push('Keep iron tip tinned and joints under ~2 s of heat. Inspect each joint for a smooth fillet — no balls, bridges, or dull "cold" joints.');

  // ── Test & verify (simulation-backed) ─────────────────────────────────
  let sim = opts.sim || null;
  if (!sim && opts.runSim !== false) {
    try { sim = await simulateCircuit(doc, opts.analysis || { type: 'op' }); }
    catch { sim = null; }
  }
  const simAvailable = sim ? sim.available : null;
  const testPoints = [];
  const nodeVoltages = pickNodeVoltages(sim);
  // Test points: explicit testpoint components first, then power rails, then signal nets.
  const seen = new Set();
  for (const c of board.components) {
    if (c.type !== 'testpoint') continue;
    const net = padNet(byId.get(c.id));
    if (net) testPoints.push({ node: net, label: `${c.ref} (${net})`, expected: fmtVolt(nodeVoltages, net) });
    if (net) seen.add(net.toLowerCase());
  }
  for (const n of board.nets) {
    const lname = String(n.id).toLowerCase();
    if (seen.has(lname)) continue;
    seen.add(lname);
    testPoints.push({ node: n.id, label: n.isPower ? `${n.id} rail` : `net ${n.id}`, expected: fmtVolt(nodeVoltages, n.id) });
  }

  const markdown = renderMarkdown({ title, bom, steps, solderNotes, testPoints, simAvailable, board, validation: vr });

  return {
    ok: errors.length === 0,
    errors, warnings, title, bom, steps, solderNotes, testPoints, simAvailable, markdown,
  };
}

// ── helpers ──────────────────────────────────────────────────────────────
function actionText(c, mount, orientation) {
  const part = TYPE_LABEL[c.type] || c.type;
  const val = c.value ? ` (${c.value})` : '';
  const pol = orientation === 'polarity' ? ' Observe polarity — align the marked lead/band to the squared pad.'
    : orientation === 'pin1' ? ' Align pin 1 to the squared pad / silkscreen key.' : '';
  if (mount === 'SMD') return `Place ${c.ref}, the ${part}${val}, and reflow its ${c.pads.length} pads.${pol}`;
  return `Insert ${c.ref}, the ${part}${val}, and solder its ${c.pads.length} through-hole pad(s); trim the leads.${pol}`;
}

function padNet(comp) {
  if (!comp || !comp.pads) return null;
  for (const p of comp.pads) if (p.net) return p.net;
  return null;
}

function pickNodeVoltages(sim) {
  if (!sim || !sim.results || !Array.isArray(sim.results.plots)) return null;
  for (const p of sim.results.plots) if (p.nodeVoltages) return p.nodeVoltages;
  return null;
}

function fmtVolt(nodeVoltages, netId) {
  if (!nodeVoltages) return null;
  // ngspice lowercases node names; '0'/GND is the reference (0 V).
  if (netId === 'GND' || netId === '0') return '0.000 V (reference)';
  const key = Object.keys(nodeVoltages).find(k => k.toLowerCase() === String(netId).toLowerCase());
  if (key == null) return null;
  const v = nodeVoltages[key];
  return Number.isFinite(v) ? `${v.toFixed(3)} V` : null;
}

// Natural sort for reference designators (R2 before R10).
function naturalRef(a, b) {
  const pa = String(a).match(/^([A-Za-z]+)(\d*)/) || [];
  const pb = String(b).match(/^([A-Za-z]+)(\d*)/) || [];
  if (pa[1] !== pb[1]) return (pa[1] || '').localeCompare(pb[1] || '');
  return (parseInt(pa[2] || '0', 10)) - (parseInt(pb[2] || '0', 10));
}

function renderMarkdown({ title, bom, steps, solderNotes, testPoints, simAvailable, board, validation }) {
  const L = [];
  L.push(`# ${title} — Build Guide`, '');
  L.push(`Board: ${board.board.w} × ${board.board.h} mm · ${board.components.filter(c => c.pads.length).length} placed parts · ${board.nets.length} nets`, '');

  L.push('## Bill of Materials', '');
  L.push('| Ref(s) | Qty | Value | Part | Footprint |', '|---|---|---|---|---|');
  for (const e of bom) {
    L.push(`| ${e.refs.join(', ')} | ${e.qty} | ${e.value || '—'} | ${TYPE_LABEL[e.type] || e.type} | ${e.footprint} |`);
  }
  L.push('');

  L.push('## Assembly Order', '');
  L.push('_Lowest-profile and most heat-tolerant parts first._', '');
  for (const s of steps) L.push(`${s.n}. **${s.ref}** — ${s.action}`);
  L.push('');

  L.push('## Soldering Notes', '');
  for (const n of solderNotes) L.push(`- ${n}`);
  L.push('');

  L.push('## Test & Verify', '');
  if (simAvailable === false) {
    L.push('> ngspice is not installed, so expected readings could not be computed. Install it (`brew install ngspice` / `apt install ngspice`) and re-run for predicted node voltages.', '');
  }
  L.push('Power the board and confirm these node readings:', '');
  L.push('| Test point | Expected |', '|---|---|');
  for (const t of testPoints) L.push(`| ${t.label} | ${t.expected || 'measure'} |`);
  L.push('');

  const issues = [...(validation.errors || []), ...(validation.warnings || [])];
  if (issues.length) {
    L.push('## Design Checks', '');
    for (const e of validation.errors || []) L.push(`- ❌ **${e.code}** — ${e.message}`);
    for (const w of validation.warnings || []) L.push(`- ⚠️ ${w.code} — ${w.message}`);
    L.push('');
  }
  return L.join('\n');
}
