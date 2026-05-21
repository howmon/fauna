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
  const need = { diode: false, led: false, npn: false, pnp: false, opamp: false };
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
        const spec = parseSourceValue(c.value);
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
