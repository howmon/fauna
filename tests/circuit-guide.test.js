import { describe, it, expect } from 'vitest';
import { buildGuide } from '../lib/circuit-guide.js';

const ledDriver = {
  title: 'LED Driver',
  components: [
    { id: 'vcc', type: 'vcc', x: 0, y: 0, value: '9' },
    { id: 'r1', type: 'resistor', x: 2, y: 0, value: '470' },
    { id: 'd1', type: 'led', x: 4, y: 0, value: 'red' },
    { id: 'c1', type: 'capacitor_pol', x: 5, y: 0, value: '10u' },
    { id: 'tp1', type: 'testpoint', x: 3, y: 1 },
    { id: 'gnd', type: 'gnd', x: 6, y: 0 },
  ],
  wires: [
    { from: 'vcc.p', to: 'r1.p1' },
    { from: 'r1.p2', to: 'd1.a' },
    { from: 'd1.a', to: 'tp1.p' },
    { from: 'd1.k', to: 'c1.pos' },
    { from: 'c1.neg', to: 'gnd.p' },
  ],
};

describe('buildGuide', () => {
  it('produces a BOM that excludes virtual rail/probe symbols', async () => {
    const g = await buildGuide(ledDriver, { runSim: false });
    expect(g.ok).toBe(true);
    const types = g.bom.map(e => e.type);
    expect(types).toContain('resistor');
    expect(types).toContain('led');
    expect(types).not.toContain('vcc');
    expect(types).not.toContain('gnd');
    expect(types).not.toContain('testpoint');
  });

  it('orders assembly low-profile first (resistor before LED before electrolytic)', async () => {
    const g = await buildGuide(ledDriver, { runSim: false });
    const order = g.steps.map(s => s.type);
    expect(order.indexOf('resistor')).toBeLessThan(order.indexOf('led'));
    expect(order.indexOf('led')).toBeLessThan(order.indexOf('capacitor_pol'));
  });

  it('flags polarity on polarized parts', async () => {
    const g = await buildGuide(ledDriver, { runSim: false });
    const d1 = g.steps.find(s => s.ref === 'D1');
    const c1 = g.steps.find(s => s.ref === 'C1');
    expect(d1.orientation).toBe('polarity');
    expect(c1.orientation).toBe('polarity');
    expect(g.solderNotes.some(n => /polariz/i.test(n))).toBe(true);
  });

  it('flags pin-1 orientation on ICs/transistors', async () => {
    const g = await buildGuide({
      title: 'amp',
      components: [
        { id: 'u1', type: 'opamp', x: 0, y: 0 },
        { id: 'q1', type: 'npn', x: 3, y: 0 },
      ],
      wires: [{ from: 'u1.out', to: 'q1.b' }],
    }, { runSim: false });
    expect(g.steps.find(s => s.ref === 'U1').orientation).toBe('pin1');
    expect(g.steps.find(s => s.ref === 'Q1').orientation).toBe('pin1');
  });

  it('includes explicit test points and net rows', async () => {
    const g = await buildGuide(ledDriver, { runSim: false });
    expect(g.testPoints.length).toBeGreaterThan(0);
    // explicit testpoint TP1 appears
    expect(g.testPoints.some(t => /TP1/.test(t.label))).toBe(true);
  });

  it('fills expected readings from a supplied simulation result', async () => {
    const sim = {
      available: true,
      results: { plots: [{ plotname: 'op', points: 1, nodeVoltages: { vcc: 9, n001: 1.8 } }] },
    };
    const g = await buildGuide(ledDriver, { sim });
    expect(g.simAvailable).toBe(true);
    const vcc = g.testPoints.find(t => t.node === 'VCC');
    expect(vcc.expected).toBe('9.000 V');
    const gnd = g.testPoints.find(t => t.node === 'GND');
    expect(gnd.expected).toMatch(/reference/);
  });

  it('degrades gracefully when ngspice is unavailable', async () => {
    const sim = { available: false, results: null, warnings: [{ code: 'NGSPICE_NOT_INSTALLED' }] };
    const g = await buildGuide(ledDriver, { sim });
    expect(g.simAvailable).toBe(false);
    expect(g.markdown).toMatch(/ngspice is not installed/i);
    // test points still listed (expected column reads "measure")
    expect(g.testPoints.some(t => t.expected === null || t.expected === 'measure')).toBe(true);
  });

  it('renders a Markdown guide with all sections', async () => {
    const g = await buildGuide(ledDriver, { runSim: false });
    expect(g.markdown).toMatch(/# LED Driver — Build Guide/);
    expect(g.markdown).toMatch(/## Bill of Materials/);
    expect(g.markdown).toMatch(/## Assembly Order/);
    expect(g.markdown).toMatch(/## Soldering Notes/);
    expect(g.markdown).toMatch(/## Test & Verify/);
  });

  it('fails closed on an invalid circuit', async () => {
    const g = await buildGuide({ components: [{ id: 'x', type: 'nope', x: 0, y: 0 }], wires: [] }, { runSim: false });
    expect(g.ok).toBe(false);
    expect(g.errors.length).toBeGreaterThan(0);
  });
});
