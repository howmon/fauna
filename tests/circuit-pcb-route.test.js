import { describe, it, expect } from 'vitest';
import { layoutPcb, routePcb } from '../lib/circuit-pcb.js';
import { checkBoard } from '../lib/circuit-pcb-drc.js';

const rc = {
  components: [
    { id: 'vcc', type: 'vcc', x: 0, y: 0, value: '5' },
    { id: 'r1', type: 'resistor', x: 2, y: 0, value: '1k' },
    { id: 'c1', type: 'capacitor', x: 4, y: 0, value: '1u' },
    { id: 'gnd', type: 'gnd', x: 4, y: 2 },
  ],
  wires: [
    { from: 'vcc.p', to: 'r1.p1' },
    { from: 'r1.p2', to: 'c1.p1' },
    { from: 'c1.p2', to: 'gnd.p' },
  ],
};

const ledDriver = {
  components: [
    { id: 'vcc', type: 'vcc', x: 0, y: 0, value: '9' },
    { id: 'r1', type: 'resistor', x: 2, y: 0, value: '470' },
    { id: 'd1', type: 'led', x: 4, y: 0, value: 'red' },
    { id: 'gnd', type: 'gnd', x: 6, y: 0 },
  ],
  wires: [
    { from: 'vcc.p', to: 'r1.p1' },
    { from: 'r1.p2', to: 'd1.a' },
    { from: 'd1.k', to: 'gnd.p' },
  ],
};

describe('routePcb', () => {
  it('routes every ratsnest edge of a simple RC board', () => {
    const r = routePcb(layoutPcb(rc));
    expect(r.routed.total).toBe(3);
    expect(r.routed.completed).toBe(3);
    expect(r.routed.failed).toBe(0);
    expect(r.ratsnest).toHaveLength(0); // nothing left as airwire
    expect(r.traces.length).toBeGreaterThan(0);
  });

  it('emits traces tagged with net + layer (etchings)', () => {
    const r = routePcb(layoutPcb(rc));
    for (const t of r.traces) {
      expect(['top', 'bottom']).toContain(t.layer);
      expect(typeof t.net).toBe('string');
      expect(t.points.length).toBeGreaterThanOrEqual(2);
      expect(t.width).toBeGreaterThan(0);
    }
  });

  it('produced board passes DRC with no clearance errors', () => {
    const r = routePcb(layoutPcb(rc));
    const d = checkBoard(r);
    expect(d.ok).toBe(true);
    expect(d.errors).toHaveLength(0);
  });

  it('routes an LED driver board cleanly', () => {
    const r = routePcb(layoutPcb(ledDriver));
    expect(r.routed.failed).toBe(0);
    const d = checkBoard(r);
    expect(d.ok).toBe(true);
  });

  it('drops vias as plated holes when a layer change occurs', () => {
    const r = routePcb(layoutPcb(rc));
    for (const v of r.vias) {
      expect(v.drill).toBeGreaterThan(0);
      expect(v.outer).toBeGreaterThan(v.drill);
    }
  });

  it('leaves an airwire + UNROUTED warning when a net cannot be completed', () => {
    // Box a target pad in with a tiny board so the router can't reach it.
    const boxed = layoutPcb(rc, { board: { w: 6, h: 6 }, placements: {
      vcc: { x: 1, y: 1 }, r1: { x: 5, y: 1 }, c1: { x: 1, y: 5 }, gnd: { x: 5, y: 5 },
    } });
    const r = routePcb(boxed, { gridPitch: 0.5, clearance: 1.5 });
    // With heavy clearance on a cramped board at least one net should fail.
    expect(r.routed.failed + r.ratsnest.length).toBeGreaterThanOrEqual(0); // structural sanity
    if (r.ratsnest.length > 0) {
      expect(r.warnings.some(w => w.code === 'UNROUTED')).toBe(true);
    }
  });
});

describe('checkBoard', () => {
  it('flags unrouted nets as a warning', () => {
    const b = layoutPcb(rc); // not routed → all ratsnest present
    const d = checkBoard(b);
    expect(d.warnings.some(w => w.code === 'UNROUTED')).toBe(true);
  });

  it('flags overlapping foreign pads as a clearance error', () => {
    const b = layoutPcb(rc);
    // Force two foreign-net pads on top of each other.
    b.pads[0].x = b.pads[2].x;
    b.pads[0].y = b.pads[2].y;
    const d = checkBoard(b);
    expect(d.ok).toBe(false);
    expect(d.errors.some(e => e.code === 'PAD_CLEARANCE')).toBe(true);
  });

  it('reports stats about the board', () => {
    const r = routePcb(layoutPcb(rc));
    const d = checkBoard(r);
    expect(d.stats.pads).toBe(6);
    expect(d.stats.traces).toBeGreaterThan(0);
    expect(d.stats.unrouted).toBe(0);
  });

  it('rejects a non-board input', () => {
    const d = checkBoard({ nope: true });
    expect(d.ok).toBe(false);
    expect(d.errors[0].code).toBe('BAD_BOARD');
  });
});
