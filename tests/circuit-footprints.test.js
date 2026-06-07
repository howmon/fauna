import { describe, it, expect } from 'vitest';
import {
  getFootprint, listFootprints, padForPin, auditFootprints,
} from '../lib/circuit-footprints.js';
import { listSymbolTypes } from '../lib/circuit-symbols.js';

describe('circuit-footprints — coverage', () => {
  it('provides a footprint for every schematic symbol type', () => {
    for (const type of listSymbolTypes()) {
      const fp = getFootprint(type);
      expect(fp, `${type} has no footprint`).toBeTruthy();
      expect(fp.pads.length, `${type} has no pads`).toBeGreaterThan(0);
    }
  });

  it('audit reports zero pin/pad mismatches', () => {
    expect(auditFootprints()).toEqual([]);
  });

  it('lists 44 footprints with names and variants', () => {
    const list = listFootprints();
    expect(list).toHaveLength(44);
    for (const e of list) {
      expect(typeof e.name).toBe('string');
      expect(e.variants).toContain('tht');
    }
  });
});

describe('circuit-footprints — pad geometry', () => {
  it('gives THT pads a drill and round/rect land', () => {
    const r = getFootprint('resistor');
    expect(r.kind).toBe('THT');
    for (const p of r.pads) {
      expect(p.drill).toBeGreaterThan(0);
      expect(['round', 'rect', 'oval']).toContain(p.shape);
    }
    // pad 1 is squared for keying
    expect(r.pads.find(p => p.num === 1).shape).toBe('rect');
  });

  it('axial resistor pads sit on a 10.16 mm (0.4") span', () => {
    const r = getFootprint('resistor');
    const xs = r.pads.map(p => p.x).sort((a, b) => a - b);
    expect(+(xs[1] - xs[0]).toFixed(2)).toBe(10.16);
  });

  it('SMD variant of resistor has no drilled holes', () => {
    const r = getFootprint('resistor', 'smd');
    expect(r.kind).toBe('SMD');
    for (const p of r.pads) expect(p.drill).toBeUndefined();
  });

  it('falls back to THT when an SMD variant is unavailable', () => {
    const fp = getFootprint('opamp', 'smd');
    expect(fp.variant).toBe('tht');
    expect(fp.kind).toBe('THT');
  });

  it('computes a body and courtyard that enclose the pads', () => {
    const fp = getFootprint('transformer');
    const maxPadX = Math.max(...fp.pads.map(p => Math.abs(p.x) + p.w / 2));
    expect(fp.body.w / 2).toBeGreaterThanOrEqual(maxPadX);
    expect(fp.courtyard.w).toBeGreaterThanOrEqual(fp.body.w);
  });
});

describe('circuit-footprints — pin mapping', () => {
  it('maps canonical pins to pad numbers', () => {
    expect(padForPin('diode', 'a')).toBe(1);
    expect(padForPin('diode', 'k')).toBe(2);
    expect(padForPin('opamp', 'out')).toBe(6);
    expect(padForPin('opamp', 'vcc')).toBe(7);
  });

  it('resolves alias pin names through the symbol library', () => {
    // diode aliases: p1→a, cathode→k
    expect(padForPin('diode', 'p1')).toBe(padForPin('diode', 'a'));
    expect(padForPin('diode', 'cathode')).toBe(padForPin('diode', 'k'));
    // potentiometer alias wiper→w
    expect(padForPin('potentiometer', 'wiper')).toBe(padForPin('potentiometer', 'w'));
  });

  it('returns null for unknown types or pins', () => {
    expect(getFootprint('nope')).toBeNull();
    expect(padForPin('resistor', 'zzz')).toBeNull();
  });

  it('marks the positive pad on polarized parts', () => {
    const led = getFootprint('led');
    expect(led.polarMark).toBe(led.pinMap.a); // anode is the marked pad
  });
});
