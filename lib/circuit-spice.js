// ── DSL → SPICE netlist compiler ────────────────────────────────────────
// Phase 7: behavioural simulation support.
//
// Maps the circuit DSL onto a Berkeley-SPICE-3 / ngspice netlist:
//
//   * Title
//   <devices>
//   <models / subckts>
//   <analysis>
//   .END
//
// Ground (any pin shorted to a `gnd` component) is renamed to "0".
// A power rail tied to a `vcc` component is renamed to "VCC" and, if no
// explicit `vsource` is wired between VCC and 0, we auto-inject one:
//
//   VVCC VCC 0 DC <vcc.value or 5>
//
// Value strings are passed through after a small normalisation pass
// (μ → u, strip whitespace) since ngspice already understands 10k / 1u / etc.

import { buildGraph } from './circuit-graph.js';

const DEFAULT_VCC = 5;

// ── Public API ─────────────────────────────────────────────────────────
export function compileToSpice(doc, analysis) {
  const graph = buildGraph(doc);
  if (!graph.ok) {
    return { ok: false, errors: graph.errors, warnings: graph.warnings, netlist: null };
  }
  const errors = [];
  const warnings = [];

  // ── Map nets: GND → "0", VCC → "VCC", others keep their synthetic id ─
  const netName = new Map(); // graph.netId → SPICE node label
  for (const [nid, net] of graph.nets) {
    if (net.isPower === 'GND') netName.set(nid, '0');
    else if (net.isPower === 'VCC') netName.set(nid, 'VCC');
    else netName.set(nid, nid);
  }

  const pinNet = (compId, pinName) => {
    const nid = graph.pinToNet.get(`${compId}.${pinName}`);
    if (!nid) return null;
    return netName.get(nid);
  };

  // ── Emit devices ────────────────────────────────────────────────────
  const lines = [];
  const zenerModels = []; // per-device .MODEL lines (breakdown varies by value)
  const need = {
    diode: false, led: false, npn: false, pnp: false, opamp: false,
    schottky: false, nmos: false, pmos: false,
    njfet: false, pjfet: false,
  };
  let hasExplicitVccSource = false;
  let vccVoltage = null;

  for (const [id, c] of graph.components) {
    const t = c.type;
    const v = normValue(c.value);
    switch (t) {
      case 'resistor': {
        const a = pinNet(id, 'p1'), b = pinNet(id, 'p2');
        lines.push(`R${id} ${a} ${b} ${v || '1k'}`);
        break;
      }
      case 'capacitor': {
        const a = pinNet(id, 'p1'), b = pinNet(id, 'p2');
        lines.push(`C${id} ${a} ${b} ${v || '1u'}`);
        break;
      }
      case 'capacitor_pol': {
        const a = pinNet(id, 'pos'), b = pinNet(id, 'neg');
        lines.push(`C${id} ${a} ${b} ${v || '10u'}`);
        break;
      }
      case 'inductor': {
        const a = pinNet(id, 'p1'), b = pinNet(id, 'p2');
        lines.push(`L${id} ${a} ${b} ${v || '1m'}`);
        break;
      }
      case 'diode': {
        const a = pinNet(id, 'a'), k = pinNet(id, 'k');
        lines.push(`D${id} ${a} ${k} DMOD`);
        need.diode = true;
        break;
      }
      case 'led': {
        const a = pinNet(id, 'a'), k = pinNet(id, 'k');
        lines.push(`D${id} ${a} ${k} LEDMOD`);
        need.led = true;
        break;
      }
      case 'npn': {
        const cN = pinNet(id, 'c'), b = pinNet(id, 'b'), e = pinNet(id, 'e');
        lines.push(`Q${id} ${cN} ${b} ${e} QNPN`);
        need.npn = true;
        break;
      }
      case 'pnp': {
        const cN = pinNet(id, 'c'), b = pinNet(id, 'b'), e = pinNet(id, 'e');
        lines.push(`Q${id} ${cN} ${b} ${e} QPNP`);
        need.pnp = true;
        break;
      }
      case 'opamp': {
        const ip = pinNet(id, 'in+');
        const im = pinNet(id, 'in-');
        const vp = pinNet(id, 'vcc');
        const vn = pinNet(id, 'vee');
        const o  = pinNet(id, 'out');
        lines.push(`XU${id} ${ip} ${im} ${vp} ${vn} ${o} OPAMP_IDEAL`);
        need.opamp = true;
        break;
      }
      case 'vsource': {
        const p = pinNet(id, 'pos'), n = pinNet(id, 'neg');
        // Prefer an explicit SPICE source spec when present; fall back to the display label.
        const spec = parseSourceValue(c.spice != null ? c.spice : c.value);
        lines.push(`V${id} ${p} ${n} ${spec}`);
        // Track if it spans VCC↔0
        if ((p === 'VCC' && n === '0') || (p === '0' && n === 'VCC')) {
          hasExplicitVccSource = true;
        }
        break;
      }
      case 'switch_spst': {
        const closed = c.props && c.props.closed;
        const a = pinNet(id, 'p1'), b = pinNet(id, 'p2');
        if (closed) {
          lines.push(`R${id} ${a} ${b} 1m`); // closed ≈ short
        } else {
          warnings.push({ code: 'OPEN_SWITCH_OMITTED', message: `switch "${id}" is open; not emitted`, component: id });
        }
        break;
      }
      case 'switch_push': {
        const closed = c.props && c.props.closed;
        const a = pinNet(id, 'p1'), b = pinNet(id, 'p2');
        if (closed) {
          lines.push(`R${id} ${a} ${b} 1m`);
        } else {
          warnings.push({ code: 'OPEN_SWITCH_OMITTED', message: `push-button "${id}" is open; not emitted`, component: id });
        }
        break;
      }
      case 'switch_spdt': {
        const com = pinNet(id, 'com'), no = pinNet(id, 'no'), nc = pinNet(id, 'nc');
        const toNo = c.props && c.props.throw === 'no';
        const target = toNo ? no : nc;
        lines.push(`R${id} ${com} ${target} 1m`); // selected throw ≈ short
        break;
      }
      case 'isource': {
        const p = pinNet(id, 'pos'), n = pinNet(id, 'neg');
        const spec = parseSourceValue(c.spice != null ? c.spice : c.value);
        lines.push(`I${id} ${p} ${n} ${spec}`);
        break;
      }
      case 'battery': {
        const p = pinNet(id, 'pos'), n = pinNet(id, 'neg');
        const spec = parseSourceValue(c.spice != null ? c.spice : (c.value || '9'));
        lines.push(`V${id} ${p} ${n} ${spec}`);
        if ((p === 'VCC' && n === '0') || (p === '0' && n === 'VCC')) hasExplicitVccSource = true;
        break;
      }
      case 'zener': {
        const a = pinNet(id, 'a'), k = pinNet(id, 'k');
        lines.push(`D${id} ${a} ${k} ZENMOD_${id}`);
        // Per-device model: the label value sets the breakdown voltage.
        const bv = parseVolts(v) || 5.1;
        zenerModels.push(`.MODEL ZENMOD_${id} D(IS=1e-14 N=1 BV=${bv} IBV=0.01)`);
        break;
      }
      case 'schottky': {
        const a = pinNet(id, 'a'), k = pinNet(id, 'k');
        lines.push(`D${id} ${a} ${k} SCHMOD`);
        need.schottky = true;
        break;
      }
      case 'photodiode': {
        const a = pinNet(id, 'a'), k = pinNet(id, 'k');
        lines.push(`D${id} ${a} ${k} DMOD`);
        need.diode = true;
        break;
      }
      case 'phototransistor': {
        const cN = pinNet(id, 'c'), b = pinNet(id, 'b'), e = pinNet(id, 'e');
        lines.push(`Q${id} ${cN} ${b} ${e} QNPN`);
        need.npn = true;
        break;
      }
      case 'nmos': {
        const d = pinNet(id, 'd'), g = pinNet(id, 'g'), s = pinNet(id, 's');
        lines.push(`M${id} ${d} ${g} ${s} ${s} NMOSMOD`);
        need.nmos = true;
        break;
      }
      case 'pmos': {
        const d = pinNet(id, 'd'), g = pinNet(id, 'g'), s = pinNet(id, 's');
        lines.push(`M${id} ${d} ${g} ${s} ${s} PMOSMOD`);
        need.pmos = true;
        break;
      }
      case 'njfet': {
        const d = pinNet(id, 'd'), g = pinNet(id, 'g'), s = pinNet(id, 's');
        lines.push(`J${id} ${d} ${g} ${s} NJFMOD`);
        need.njfet = true;
        break;
      }
      case 'pjfet': {
        const d = pinNet(id, 'd'), g = pinNet(id, 'g'), s = pinNet(id, 's');
        lines.push(`J${id} ${d} ${g} ${s} PJFMOD`);
        need.pjfet = true;
        break;
      }
      case 'potentiometer': {
        const a = pinNet(id, 'p1'), b = pinNet(id, 'p2'), w = pinNet(id, 'w');
        const total = parseOhms(v) || 10000;
        let frac = Number(c.props && c.props.wiper);
        if (!Number.isFinite(frac)) frac = 0.5;
        frac = Math.min(0.999, Math.max(0.001, frac));
        lines.push(`R${id}A ${a} ${w} ${fmtOhms(total * frac)}`);
        lines.push(`R${id}B ${w} ${b} ${fmtOhms(total * (1 - frac))}`);
        break;
      }
      case 'thermistor': {
        const a = pinNet(id, 'p1'), b = pinNet(id, 'p2');
        lines.push(`R${id} ${a} ${b} ${v || '10k'}`);
        break;
      }
      case 'lamp': {
        const a = pinNet(id, 'p1'), b = pinNet(id, 'p2');
        lines.push(`R${id} ${a} ${b} ${v || '100'}`);
        break;
      }
      case 'speaker': {
        const a = pinNet(id, 'p1'), b = pinNet(id, 'p2');
        lines.push(`R${id} ${a} ${b} ${v || '8'}`);
        break;
      }
      case 'buzzer': {
        const a = pinNet(id, 'p1'), b = pinNet(id, 'p2');
        lines.push(`R${id} ${a} ${b} ${v || '100'}`);
        break;
      }
      case 'fuse': {
        const a = pinNet(id, 'p1'), b = pinNet(id, 'p2');
        lines.push(`R${id} ${a} ${b} 1m`); // intact fuse ≈ short
        break;
      }
      case 'motor': {
        // Series R + L lumped model via an internal node.
        const a = pinNet(id, 'p1'), b = pinNet(id, 'p2');
        const mid = `${a}_${id}m`;
        lines.push(`R${id} ${a} ${mid} ${v || '10'}`);
        lines.push(`L${id} ${mid} ${b} 1m`);
        break;
      }
      case 'crystal': {
        // Series RLC motional arm (simplified BVD model).
        const a = pinNet(id, 'p1'), b = pinNet(id, 'p2');
        const mid = `${a}_${id}x`;
        lines.push(`L${id} ${a} ${mid} ${v || '1m'}`);
        lines.push(`C${id} ${mid} ${b} 1p`);
        break;
      }
      case 'transformer': {
        const p1 = pinNet(id, 'p1'), p2 = pinNet(id, 'p2');
        const s1 = pinNet(id, 's1'), s2 = pinNet(id, 's2');
        lines.push(`L${id}P ${p1} ${p2} ${v || '1m'}`);
        lines.push(`L${id}S ${s1} ${s2} ${v || '1m'}`);
        lines.push(`K${id} L${id}P L${id}S 0.99`);
        break;
      }
      case 'relay': {
        const c1 = pinNet(id, 'c1'), c2 = pinNet(id, 'c2');
        const p1 = pinNet(id, 'p1'), p2 = pinNet(id, 'p2');
        lines.push(`L${id} ${c1} ${c2} 10m`); // coil
        if (c.props && c.props.energized) {
          lines.push(`R${id}C ${p1} ${p2} 1m`); // closed contact
        } else {
          warnings.push({ code: 'OPEN_CONTACT_OMITTED', message: `relay "${id}" contact is open; not emitted`, component: id });
        }
        break;
      }
      case 'ammeter': {
        const a = pinNet(id, 'p1'), b = pinNet(id, 'p2');
        lines.push(`V${id} ${a} ${b} DC 0`); // 0 V source = current sense
        break;
      }
      case 'voltmeter': {
        const a = pinNet(id, 'p1'), b = pinNet(id, 'p2');
        lines.push(`R${id} ${a} ${b} 1G`); // high-impedance meter
        break;
      }
      case 'testpoint':
        // pure probe label, nothing to emit
        break;
      case 'gate_and': case 'gate_or': case 'gate_not':
      case 'gate_nand': case 'gate_nor': case 'gate_xor':
        warnings.push({ code: 'DIGITAL_NOT_SIMULATED', message: `logic gate "${id}" (${t}) is drawn but not analog-simulated`, component: id });
        break;
      case 'vcc': {
        // Capture intended rail voltage; defer source emission until end.
        const parsed = Number(String(c.value || '').replace(/[^\d.+-eE]/g, ''));
        if (Number.isFinite(parsed) && parsed > 0) {
          vccVoltage = parsed;
        }
        break;
      }
      case 'gnd':
        // pure label, nothing to emit
        break;
      default:
        errors.push({ code: 'UNSIMULATABLE_TYPE', message: `no SPICE mapping for type "${t}"`, component: id });
    }
  }

  // Auto-inject VCC source if a vcc component exists but no explicit source spans VCC↔0.
  const hasVccRail = Array.from(graph.nets.values()).some(n => n.isPower === 'VCC');
  if (hasVccRail && !hasExplicitVccSource) {
    const v = vccVoltage != null ? vccVoltage : DEFAULT_VCC;
    lines.unshift(`VVCC VCC 0 DC ${v}`);
  }

  // ── Models / subcircuits ────────────────────────────────────────────
  const tail = [];
  if (need.diode) tail.push('.MODEL DMOD D(IS=1e-14 N=1)');
  if (need.led)   tail.push('.MODEL LEDMOD D(IS=1e-15 N=2 BV=5 IBV=0.01)');
  if (need.npn)   tail.push('.MODEL QNPN NPN(BF=200 IS=1e-15)');
  if (need.pnp)   tail.push('.MODEL QPNP PNP(BF=200 IS=1e-15)');
  if (need.schottky) tail.push('.MODEL SCHMOD D(IS=1e-7 N=1 RS=2)');
  if (need.nmos)  tail.push('.MODEL NMOSMOD NMOS(VTO=2 KP=20u LAMBDA=0.01)');
  if (need.pmos)  tail.push('.MODEL PMOSMOD PMOS(VTO=-2 KP=20u LAMBDA=0.01)');
  if (need.njfet) tail.push('.MODEL NJFMOD NJF(VTO=-2 BETA=1m LAMBDA=0.01)');
  if (need.pjfet) tail.push('.MODEL PJFMOD PJF(VTO=2 BETA=1m LAMBDA=0.01)');
  for (const m of zenerModels) tail.push(m);
  if (need.opamp) {
    tail.push('.SUBCKT OPAMP_IDEAL inp inm vcc vee out');
    tail.push('* Ideal single-pole op-amp, gain 1e5, fp ≈ 10 Hz, rail-limited.');
    tail.push('EGAIN nout 0 inp inm 1e5');
    tail.push('RP nout npole 1k');
    tail.push('CP npole 0 16u');
    tail.push('EOUT out 0 npole 0 1');
    tail.push('.ENDS OPAMP_IDEAL');
  }

  // ── Analysis ────────────────────────────────────────────────────────
  const analyses = normaliseAnalysis(analysis, errors);

  if (errors.length) {
    return { ok: false, errors, warnings, netlist: null };
  }

  const title = String(doc.title || 'fauna-circuit').replace(/[\r\n]+/g, ' ');
  const netlist = [
    `* ${title}`,
    ...lines,
    ...tail,
    ...analyses,
    '.END',
    '',
  ].join('\n');

  return {
    ok: true,
    errors: [],
    warnings,
    netlist,
    nets: Array.from(graph.nets.values()).map(n => ({
      id: netName.get(n.id),
      isPower: n.isPower,
      pins: n.pins,
    })),
  };
}

// ── Helpers ─────────────────────────────────────────────────────────────
function normValue(v) {
  if (v == null) return null;
  return String(v).trim().replace(/μ/g, 'u').replace(/Ω/g, '');
}

// Parse a value with optional SI suffix into a base-unit number.
// Understands k/M/G/m/u/n/p (and µ). Returns null when no number is present.
const SI_MULT = { p: 1e-12, n: 1e-9, u: 1e-6, µ: 1e-6, m: 1e-3, k: 1e3, K: 1e3, M: 1e6, G: 1e9, g: 1e9, meg: 1e6 };
function parseSI(v) {
  if (v == null) return null;
  const s = String(v).trim().replace(/μ/g, 'u').replace(/[ΩFHV]/gi, '');
  const m = s.match(/^([+-]?\d*\.?\d+(?:[eE][+-]?\d+)?)\s*(meg|[pnumµkKMGg])?/);
  if (!m) return null;
  const base = parseFloat(m[1]);
  if (!Number.isFinite(base)) return null;
  const mult = m[2] ? (SI_MULT[m[2]] ?? 1) : 1;
  return base * mult;
}

function parseOhms(v) { return parseSI(v); }
function parseVolts(v) { return parseSI(v); }

// Format a resistance back into a compact ngspice-friendly literal.
function fmtOhms(ohms) {
  if (!Number.isFinite(ohms) || ohms <= 0) return '1';
  if (ohms >= 1e6) return `${+(ohms / 1e6).toFixed(4)}meg`;
  if (ohms >= 1e3) return `${+(ohms / 1e3).toFixed(4)}k`;
  return `${+ohms.toFixed(4)}`;
}

// Voltage source value:
//   number / "5"        → "DC 5"
//   "DC 5"              → "DC 5"
//   "AC 1"              → "AC 1"
//   "SIN(0 1 1k)"       → "SIN(0 1 1k)"
//   "PULSE(0 5 0 1n 1n 5u 10u)" → unchanged
function parseSourceValue(v) {
  if (v == null || v === '') return 'DC 0';
  const s = String(v).trim();
  if (/^[+-]?\d+(\.\d+)?([eE][+-]?\d+)?[a-zA-Zµμ]*$/.test(s)) return `DC ${normValue(s)}`;
  return normValue(s);
}

function normaliseAnalysis(spec, errors) {
  if (!spec) return ['.OP', '.SAVE all'];
  const out = [];
  const list = Array.isArray(spec) ? spec : [spec];
  for (const a of list) {
    if (!a || !a.type) { errors.push({ code: 'BAD_ANALYSIS', message: 'analysis entry missing type' }); continue; }
    switch (a.type.toLowerCase()) {
      case 'op':
        out.push('.OP');
        break;
      case 'tran': {
        const step = normValue(a.step) || '1u';
        const stop = normValue(a.stop) || '1m';
        const start = a.start != null ? normValue(a.start) : null;
        const uic = a.uic ? ' UIC' : '';
        out.push(`.TRAN ${step} ${stop}${start ? ' ' + start : ''}${uic}`);
        break;
      }
      case 'ac': {
        const sweep = (a.sweep || 'dec').toUpperCase();
        const pts = a.points || 10;
        const fstart = normValue(a.fstart) || '1';
        const fstop = normValue(a.fstop) || '1Meg';
        out.push(`.AC ${sweep} ${pts} ${fstart} ${fstop}`);
        break;
      }
      case 'dc': {
        if (!a.source || a.start == null || a.stop == null || a.step == null) {
          errors.push({ code: 'BAD_ANALYSIS', message: 'dc sweep needs source/start/stop/step' });
          break;
        }
        out.push(`.DC ${a.source} ${normValue(a.start)} ${normValue(a.stop)} ${normValue(a.step)}`);
        break;
      }
      default:
        errors.push({ code: 'BAD_ANALYSIS', message: `unknown analysis type "${a.type}"` });
    }
  }
  out.push('.SAVE all');
  return out;
}
