import { describe, it, expect } from 'vitest';
import { compileToSpice } from '../lib/circuit-spice.js';

const rcLowPass = {
  title: 'RC low-pass',
  components: [
    { id: 'v1',  type: 'vsource', x: 0, y: 0, value: 'SIN(0 1 1k)' },
    { id: 'r1',  type: 'resistor', x: 2, y: 0, value: '1k' },
    { id: 'c1',  type: 'capacitor', x: 4, y: 0, value: '1u' },
    { id: 'gnd', type: 'gnd', x: 4, y: 2 },
  ],
  wires: [
    { from: 'v1.pos', to: 'r1.p1' },
    { from: 'r1.p2', to: 'c1.p1' },
    { from: 'c1.p2', to: 'gnd.p' },
    { from: 'v1.neg', to: 'gnd.p' },
  ],
};

const ledDriver = {
  title: 'LED with resistor',
  components: [
    { id: 'vcc', type: 'vcc', x: 0, y: 0, value: '5' },
    { id: 'r1',  type: 'resistor', x: 0, y: 2, value: '330' },
    { id: 'd1',  type: 'led', x: 0, y: 4, value: 'red' },
    { id: 'gnd', type: 'gnd', x: 0, y: 6 },
  ],
  wires: [
    { from: 'vcc.p', to: 'r1.p1' },
    { from: 'r1.p2', to: 'd1.a' },
    { from: 'd1.k', to: 'gnd.p' },
  ],
};

const opampBuffer = {
  title: 'Op-amp buffer',
  components: [
    { id: 'vcc', type: 'vcc', x: 0, y: 0, value: '5' },
    { id: 'gnd', type: 'gnd', x: 4, y: 4 },
    { id: 'vin', type: 'vsource', x: 0, y: 4, value: 'DC 2' },
    { id: 'u1',  type: 'opamp', x: 4, y: 2 },
  ],
  wires: [
    { from: 'vin.pos', to: 'u1.in+' },
    { from: 'vin.neg', to: 'gnd.p' },
    { from: 'u1.vcc', to: 'vcc.p' },
    { from: 'u1.vee', to: 'gnd.p' },
    { from: 'u1.out', to: 'u1.in-' }, // unity gain
  ],
};

describe('compileToSpice — basic structure', () => {
  it('rejects an invalid doc', () => {
    const r = compileToSpice({ components: [{ id: 'r1', type: 'NOPE', x: 0, y: 0 }], wires: [] });
    expect(r.ok).toBe(false);
    expect(r.errors.length).toBeGreaterThan(0);
  });

  it('emits a title line, devices, and .END', () => {
    const r = compileToSpice(rcLowPass, { type: 'tran', step: '10u', stop: '5m' });
    expect(r.ok).toBe(true);
    const lines = r.netlist.split('\n');
    expect(lines[0]).toMatch(/^\* RC low-pass/);
    expect(lines[lines.length - 2]).toBe('.END');
  });

  it('renames GND nets to 0', () => {
    const r = compileToSpice(rcLowPass, { type: 'op' });
    expect(r.ok).toBe(true);
    // c1's bottom plate and v1's neg both connect to gnd.p → must be node 0
    expect(r.netlist).toMatch(/^Cc1 \S+ 0 1u$/m);
    expect(r.netlist).toMatch(/^Vv1 \S+ 0 SIN\(0 1 1k\)$/m);
  });
});

describe('compileToSpice — devices', () => {
  it('emits resistors and capacitors with values', () => {
    const r = compileToSpice(rcLowPass);
    expect(r.netlist).toMatch(/^Rr1 \S+ \S+ 1k$/m);
    expect(r.netlist).toMatch(/^Cc1 \S+ 0 1u$/m);
  });

  it('auto-injects VVCC when a vcc rail exists and no explicit source', () => {
    const r = compileToSpice(ledDriver, { type: 'op' });
    expect(r.ok).toBe(true);
    expect(r.netlist).toMatch(/^VVCC VCC 0 DC 5$/m);
  });

  it('emits LED model and uses LEDMOD reference', () => {
    const r = compileToSpice(ledDriver, { type: 'op' });
    expect(r.netlist).toMatch(/^Dd1 \S+ 0 LEDMOD$/m);
    expect(r.netlist).toMatch(/^\.MODEL LEDMOD D/m);
  });

  it('does NOT re-inject VVCC when an explicit vsource spans VCC↔GND', () => {
    const explicitDoc = {
      title: 'explicit',
      components: [
        { id: 'vcc', type: 'vcc', x: 0, y: 0, value: '5' },
        { id: 'gnd', type: 'gnd', x: 0, y: 4 },
        { id: 'vs',  type: 'vsource', x: 0, y: 2, value: 'DC 9' },
      ],
      wires: [
        { from: 'vs.pos', to: 'vcc.p' },
        { from: 'vs.neg', to: 'gnd.p' },
      ],
    };
    const r = compileToSpice(explicitDoc, { type: 'op' });
    expect(r.ok).toBe(true);
    expect(r.netlist).not.toMatch(/^VVCC /m);
    expect(r.netlist).toMatch(/^Vvs VCC 0 DC 9$/m);
  });

  it('emits op-amp subckt and instance', () => {
    const r = compileToSpice(opampBuffer, { type: 'tran', step: '1u', stop: '1m' });
    expect(r.ok).toBe(true);
    expect(r.netlist).toMatch(/^XUu1 \S+ \S+ VCC 0 \S+ OPAMP_IDEAL$/m);
    expect(r.netlist).toMatch(/^\.SUBCKT OPAMP_IDEAL/m);
    expect(r.netlist).toMatch(/^\.ENDS OPAMP_IDEAL$/m);
  });

  it('open switch is omitted with a warning; closed switch becomes a small R', () => {
    const open = compileToSpice({
      components: [
        { id: 's1', type: 'switch_spst', x: 0, y: 0 },
        { id: 'r1', type: 'resistor', x: 2, y: 0, value: '1k' },
        { id: 'gnd', type: 'gnd', x: 4, y: 0 },
      ],
      wires: [
        { from: 's1.p2', to: 'r1.p1' },
        { from: 'r1.p2', to: 'gnd.p' },
      ],
    });
    expect(open.ok).toBe(true);
    expect(open.warnings.some(w => w.code === 'OPEN_SWITCH_OMITTED')).toBe(true);
    expect(open.netlist).not.toMatch(/^Rs1 /m);

    const closed = compileToSpice({
      components: [
        { id: 's1', type: 'switch_spst', x: 0, y: 0, props: { closed: true } },
        { id: 'r1', type: 'resistor', x: 2, y: 0, value: '1k' },
        { id: 'gnd', type: 'gnd', x: 4, y: 0 },
      ],
      wires: [
        { from: 's1.p2', to: 'r1.p1' },
        { from: 'r1.p2', to: 'gnd.p' },
      ],
    });
    expect(closed.netlist).toMatch(/^Rs1 \S+ \S+ 1m$/m);
  });
});

describe('compileToSpice — analyses', () => {
  it('defaults to .OP when none specified', () => {
    const r = compileToSpice(rcLowPass);
    expect(r.netlist).toMatch(/^\.OP$/m);
    expect(r.netlist).toMatch(/^\.SAVE all$/m);
  });

  it('formats a .TRAN with step and stop', () => {
    const r = compileToSpice(rcLowPass, { type: 'tran', step: '10u', stop: '5m', uic: true });
    expect(r.netlist).toMatch(/^\.TRAN 10u 5m UIC$/m);
  });

  it('formats an .AC sweep', () => {
    const r = compileToSpice(rcLowPass, { type: 'ac', sweep: 'dec', points: 20, fstart: '10', fstop: '100k' });
    expect(r.netlist).toMatch(/^\.AC DEC 20 10 100k$/m);
  });

  it('formats a .DC sweep', () => {
    const r = compileToSpice(opampBuffer, { type: 'dc', source: 'Vvin', start: '0', stop: '5', step: '0.1' });
    expect(r.netlist).toMatch(/^\.DC Vvin 0 5 0\.1$/m);
  });

  it('rejects unknown analysis types', () => {
    const r = compileToSpice(rcLowPass, { type: 'wibble' });
    expect(r.ok).toBe(false);
    expect(r.errors[0].code).toBe('BAD_ANALYSIS');
  });
});

describe('compileToSpice — extended catalog', () => {
  it('emits an NMOS device + model', () => {
    const r = compileToSpice({
      components: [
        { id: 'vcc', type: 'vcc', x: 0, y: 0, value: '5' },
        { id: 'm1', type: 'nmos', x: 0, y: 2 },
        { id: 'gnd', type: 'gnd', x: 0, y: 4 },
      ],
      wires: [
        { from: 'm1.d', to: 'vcc.p' },
        { from: 'm1.g', to: 'vcc.p' },
        { from: 'm1.s', to: 'gnd.p' },
      ],
    }, { type: 'op' });
    expect(r.ok).toBe(true);
    expect(r.netlist).toMatch(/^Mm1 VCC VCC 0 0 NMOSMOD$/m);
    expect(r.netlist).toMatch(/^\.MODEL NMOSMOD NMOS/m);
  });

  it('emits a per-device zener model carrying the breakdown voltage', () => {
    const r = compileToSpice({
      components: [
        { id: 'vcc', type: 'vcc', x: 0, y: 0, value: '12' },
        { id: 'r1', type: 'resistor', x: 0, y: 1, value: '1k' },
        { id: 'd1', type: 'zener', x: 0, y: 2, value: '5.1' },
        { id: 'gnd', type: 'gnd', x: 0, y: 4 },
      ],
      wires: [
        { from: 'vcc.p', to: 'r1.p1' },
        { from: 'r1.p2', to: 'd1.k' },
        { from: 'd1.a', to: 'gnd.p' },
      ],
    }, { type: 'op' });
    expect(r.ok).toBe(true);
    expect(r.netlist).toMatch(/^Dd1 \S+ \S+ ZENMOD_d1$/m);
    expect(r.netlist).toMatch(/^\.MODEL ZENMOD_d1 D\(.*BV=5\.1.*\)$/m);
  });

  it('splits a potentiometer into two resistors at the wiper', () => {
    const r = compileToSpice({
      components: [
        { id: 'vcc', type: 'vcc', x: 0, y: 0, value: '5' },
        { id: 'p1', type: 'potentiometer', x: 0, y: 2, value: '10k', props: { wiper: 0.25 } },
        { id: 'gnd', type: 'gnd', x: 0, y: 4 },
      ],
      wires: [
        { from: 'vcc.p', to: 'p1.p1' },
        { from: 'p1.p2', to: 'gnd.p' },
        { from: 'p1.w', to: 'gnd.p' },
      ],
    }, { type: 'op' });
    expect(r.ok).toBe(true);
    expect(r.netlist).toMatch(/^Rp1A VCC 0 2\.5k$/m);   // 10k * 0.25
    expect(r.netlist).toMatch(/^Rp1B 0 0 7\.5k$/m);     // 10k * 0.75
  });

  it('emits a current source and a battery as a V source', () => {
    const cs = compileToSpice({
      components: [
        { id: 'i1', type: 'isource', x: 0, y: 0, value: '2m' },
        { id: 'r1', type: 'resistor', x: 0, y: 2, value: '1k' },
        { id: 'gnd', type: 'gnd', x: 0, y: 4 },
      ],
      wires: [
        { from: 'i1.pos', to: 'r1.p1' },
        { from: 'i1.neg', to: 'gnd.p' },
        { from: 'r1.p2', to: 'gnd.p' },
      ],
    }, { type: 'op' });
    expect(cs.ok).toBe(true);
    expect(cs.netlist).toMatch(/^Ii1 \S+ 0 DC 2m$/m);

    const bat = compileToSpice({
      components: [
        { id: 'b1', type: 'battery', x: 0, y: 0, value: '9' },
        { id: 'r1', type: 'resistor', x: 0, y: 2, value: '1k' },
        { id: 'gnd', type: 'gnd', x: 0, y: 4 },
      ],
      wires: [
        { from: 'b1.pos', to: 'r1.p1' },
        { from: 'r1.p2', to: 'b1.neg' },
        { from: 'b1.neg', to: 'gnd.p' },
      ],
    }, { type: 'op' });
    expect(bat.netlist).toMatch(/^Vb1 \S+ 0 DC 9$/m);
  });

  it('emits an ammeter as a 0V sense source and SPDT as a short to the selected throw', () => {
    const r = compileToSpice({
      components: [
        { id: 'vcc', type: 'vcc', x: 0, y: 0, value: '5' },
        { id: 'a1', type: 'ammeter', x: 0, y: 1 },
        { id: 'sw', type: 'switch_spdt', x: 0, y: 2, props: { throw: 'no' } },
        { id: 'r1', type: 'resistor', x: 0, y: 3, value: '1k' },
        { id: 'gnd', type: 'gnd', x: 0, y: 4 },
      ],
      wires: [
        { from: 'vcc.p', to: 'a1.p1' },
        { from: 'a1.p2', to: 'sw.com' },
        { from: 'sw.no', to: 'r1.p1' },
        { from: 'r1.p2', to: 'gnd.p' },
      ],
    }, { type: 'op' });
    expect(r.ok).toBe(true);
    expect(r.netlist).toMatch(/^Va1 \S+ \S+ DC 0$/m);
    expect(r.netlist).toMatch(/^Rsw \S+ \S+ 1m$/m);
  });

  it('draws logic gates but flags them as not analog-simulated (warning, not error)', () => {
    const r = compileToSpice({
      components: [
        { id: 'u1', type: 'gate_and', x: 0, y: 0 },
      ],
      wires: [],
    }, { type: 'op' });
    expect(r.ok).toBe(true);
    expect(r.warnings.some(w => w.code === 'DIGITAL_NOT_SIMULATED')).toBe(true);
  });

  it('emits a coupled transformer with a K statement', () => {
    const r = compileToSpice({
      components: [
        { id: 't1', type: 'transformer', x: 0, y: 0, value: '1m' },
        { id: 'gnd', type: 'gnd', x: 0, y: 4 },
      ],
      wires: [
        { from: 't1.p2', to: 'gnd.p' },
        { from: 't1.s2', to: 'gnd.p' },
      ],
    }, { type: 'op' });
    expect(r.ok).toBe(true);
    expect(r.netlist).toMatch(/^Lt1P \S+ \S+ 1m$/m);
    expect(r.netlist).toMatch(/^Lt1S \S+ \S+ 1m$/m);
    expect(r.netlist).toMatch(/^Kt1 Lt1P Lt1S 0\.99$/m);
  });
});

