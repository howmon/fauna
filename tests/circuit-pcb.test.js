import { describe, it, expect } from 'vitest';
import { layoutPcb } from '../lib/circuit-pcb.js';
import { renderBoard } from '../lib/circuit-board-renderer.js';

const rc = {
  title: 'RC',
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

describe('layoutPcb', () => {
  it('places every component with a footprint and produces a positive board', () => {
    const b = layoutPcb(rc);
    expect(b.ok).toBe(true);
    expect(b.components).toHaveLength(4);
    expect(b.board.w).toBeGreaterThan(0);
    expect(b.board.h).toBeGreaterThan(0);
    expect(b.units).toBe('mm');
  });

  it('assigns reference designators by family', () => {
    const b = layoutPcb(rc);
    const refs = Object.fromEntries(b.components.map(c => [c.id, c.ref]));
    expect(refs.r1).toBe('R1');
    expect(refs.c1).toBe('C1');
  });

  it('flattens pads to absolute coordinates and assigns nets', () => {
    const b = layoutPcb(rc);
    expect(b.pads.length).toBe(6); // 1+2+2+1
    const r1p1 = b.pads.find(p => p.compId === 'r1' && p.num === 1);
    // r1.p1 ties to vcc → VCC net
    expect(r1p1.net).toBe('VCC');
    // every pad has finite coords
    for (const p of b.pads) {
      expect(Number.isFinite(p.x)).toBe(true);
      expect(Number.isFinite(p.y)).toBe(true);
    }
  });

  it('identifies power nets', () => {
    const b = layoutPcb(rc);
    const vcc = b.nets.find(n => n.id === 'VCC');
    const gnd = b.nets.find(n => n.id === 'GND');
    expect(vcc.isPower).toBe('VCC');
    expect(gnd.isPower).toBe('GND');
  });

  it('builds a ratsnest spanning tree (n-1 edges per multi-pad net)', () => {
    const b = layoutPcb(rc);
    // VCC: vcc.p + r1.p1 = 2 pads → 1 edge; middle net r1.p2+c1.p1 = 1 edge; GND 2 pads → 1 edge
    expect(b.ratsnest.length).toBe(3);
    for (const r of b.ratsnest) {
      expect(r.a).toBeTruthy();
      expect(r.b).toBeTruthy();
    }
  });

  it('does not overlap component courtyards (auto-grid placement)', () => {
    const many = {
      components: Array.from({ length: 9 }, (_, i) => ({ id: `r${i}`, type: 'resistor', x: i, y: 0, value: '1k' })),
      wires: [],
    };
    const b = layoutPcb(many);
    for (let i = 0; i < b.components.length; i++) {
      for (let j = i + 1; j < b.components.length; j++) {
        const a = b.components[i], c = b.components[j];
        const dx = Math.abs(a.x - c.x), dy = Math.abs(a.y - c.y);
        const minDx = (a.courtyard.w + c.courtyard.w) / 2;
        const minDy = (a.courtyard.h + c.courtyard.h) / 2;
        // either separated horizontally OR vertically (grid layout)
        expect(dx >= minDx - 0.01 || dy >= minDy - 0.01).toBe(true);
      }
    }
  });

  it('honours manual placement overrides', () => {
    const b = layoutPcb(rc, { placements: { r1: { x: 20, y: 20, rot: 90 } } });
    const r1 = b.components.find(c => c.id === 'r1');
    expect(r1.x).toBe(20);
    expect(r1.y).toBe(20);
    expect(r1.rot).toBe(90);
  });

  it('honours a fixed board size', () => {
    const b = layoutPcb(rc, { board: { w: 50, h: 40 } });
    expect(b.board).toEqual({ w: 50, h: 40 });
  });

  it('fails closed on an invalid doc', () => {
    const b = layoutPcb({ components: [{ id: 'x', type: 'nope', x: 0, y: 0 }], wires: [] });
    expect(b.ok).toBe(false);
    expect(b.errors.length).toBeGreaterThan(0);
  });
});

describe('renderBoard', () => {
  it('renders an SVG with substrate, pads and ratsnest', () => {
    const b = layoutPcb(rc);
    const out = renderBoard(b);
    expect(out.svg).toContain('<svg');
    expect(out.svg).toContain('#0b6b3a');            // substrate
    expect(out.svg).toContain('stroke-dasharray');   // ratsnest airwires
    expect(out.width).toBeGreaterThan(0);
    expect(out.warnings).toHaveLength(0);
  });

  it('respects layer visibility flags', () => {
    const b = layoutPcb(rc);
    const out = renderBoard(b, { layers: { ratsnest: false, substrate: false } });
    expect(out.svg).not.toContain('stroke-dasharray');
    expect(out.svg).not.toContain('#0b6b3a');
  });

  it('rejects a non-board input', () => {
    const out = renderBoard({ nope: true });
    expect(out.warnings[0].code).toBe('BAD_BOARD');
  });
});
