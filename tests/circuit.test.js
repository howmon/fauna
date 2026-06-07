import { describe, it, expect } from 'vitest';
import { renderCircuit } from '../lib/circuit-renderer.js';
import { validateCircuit } from '../lib/circuit-validate.js';
import { listSymbolTypes } from '../lib/circuit-symbols.js';

// ── Fixtures ────────────────────────────────────────────────────────────
const voltageDivider = {
  title: 'Voltage Divider',
  components: [
    { id: 'vcc', type: 'vcc', x: 0,  y: -4 },
    { id: 'r1',  type: 'resistor', x: 0, y: 0, rot: 90, value: '10k' },
    { id: 'r2',  type: 'resistor', x: 0, y: 6, rot: 90, value: '10k' },
    { id: 'gnd', type: 'gnd', x: 0,  y: 10 },
  ],
  wires: [
    { from: 'vcc.p',  to: 'r1.p1' },
    { from: 'r1.p2',  to: 'r2.p1' },
    { from: 'r2.p2',  to: 'gnd.p' },
  ],
};

const ledWithResistor = {
  title: 'LED + Resistor',
  components: [
    { id: 'vcc', type: 'vcc', x: 0, y: -4 },
    { id: 'r1',  type: 'resistor', x: 0, y: 0, rot: 90, value: '330' },
    { id: 'd1',  type: 'led', x: 0, y: 6, rot: 90, value: 'RED' },
    { id: 'gnd', type: 'gnd', x: 0, y: 10 },
  ],
  wires: [
    { from: 'vcc.p', to: 'r1.p1' },
    { from: 'r1.p2', to: 'd1.a' },
    { from: 'd1.k',  to: 'gnd.p' },
  ],
};

const rcLowPass = {
  title: 'RC Low-Pass',
  components: [
    { id: 'vin', type: 'vsource', x: -4, y: 0, value: '1V' },
    { id: 'r1',  type: 'resistor', x: 0, y: -3, value: '1k' },
    { id: 'c1',  type: 'capacitor', x: 4, y: 0, rot: 90, value: '1u' },
    { id: 'gnd', type: 'gnd', x: 4, y: 4 },
  ],
  wires: [
    { from: 'vin.pos', to: 'r1.p1' },
    { from: 'r1.p2',   to: 'c1.p1' },
    { from: 'c1.p2',   to: 'gnd.p' },
    { from: 'vin.neg', to: 'gnd.p' },
  ],
};

// Broken: VCC tied straight to GND
const powerShort = {
  components: [
    { id: 'vcc', type: 'vcc', x: 0, y: -4 },
    { id: 'gnd', type: 'gnd', x: 0, y: 4 },
  ],
  wires: [{ from: 'vcc.p', to: 'gnd.p' }],
};

// Broken: dangling pin
const dangling = {
  components: [
    { id: 'vcc', type: 'vcc', x: 0, y: -4 },
    { id: 'r1',  type: 'resistor', x: 0, y: 0, rot: 90 },
  ],
  wires: [{ from: 'vcc.p', to: 'r1.p1' }],
};

// Broken: floating island
const floating = {
  components: [
    { id: 'vcc', type: 'vcc', x: 0, y: -4 },
    { id: 'gnd', type: 'gnd', x: 0, y: 4 },
    { id: 'r1',  type: 'resistor', x: 0, y: 0, rot: 90 },
    { id: 'c1',  type: 'capacitor', x: 6, y: 0 },
    { id: 'c2',  type: 'capacitor', x: 10, y: 0 },
  ],
  wires: [
    { from: 'vcc.p', to: 'r1.p1' },
    { from: 'r1.p2', to: 'gnd.p' },
    { from: 'c1.p2', to: 'c2.p1' }, // c1+c2 form a floating island
  ],
};

// Broken: reversed polarized cap
const reversedCap = {
  components: [
    { id: 'vcc', type: 'vcc', x: 0, y: -4 },
    { id: 'c1',  type: 'capacitor_pol', x: 0, y: 0, rot: 90, value: '10u' },
    { id: 'gnd', type: 'gnd', x: 0, y: 4 },
  ],
  // wire VCC → c1.neg and GND → c1.pos  → polarity reversed
  wires: [
    { from: 'vcc.p', to: 'c1.neg' },
    { from: 'c1.pos', to: 'gnd.p' },
  ],
};

// Broken: bad pin name
const badPin = {
  components: [{ id: 'r1', type: 'resistor', x: 0, y: 0 }],
  wires: [{ from: 'r1.bogus', to: 'r1.p2' }],
};

// ── Renderer tests ──────────────────────────────────────────────────────
describe('circuit renderer', () => {
  it('renders a voltage divider with no warnings', () => {
    const out = renderCircuit(voltageDivider);
    expect(out.warnings).toHaveLength(0);
    expect(out.svg).toContain('<svg');
    expect(out.svg).toContain('</svg>');
    expect(out.svg).toContain('Voltage Divider');
    expect(out.width).toBeGreaterThan(0);
    expect(out.height).toBeGreaterThan(0);
  });

  it('renders an LED+resistor circuit', () => {
    const out = renderCircuit(ledWithResistor);
    expect(out.warnings).toHaveLength(0);
    expect(out.svg).toMatch(/<line /);     // wires
    expect(out.svg).toMatch(/<polygon /);  // LED arrowhead
  });

  it('renders an RC low-pass circuit', () => {
    const out = renderCircuit(rcLowPass);
    expect(out.warnings).toHaveLength(0);
    expect(out.svg).toContain('RC Low-Pass');
  });

  it('reports unknown component types as warnings, not throws', () => {
    const out = renderCircuit({ components: [{ id: 'x1', type: 'wormhole', x: 0, y: 0 }], wires: [] });
    expect(out.warnings.some(w => w.code === 'UNKNOWN_TYPE')).toBe(true);
  });

  it('reports unknown pin names as warnings', () => {
    const out = renderCircuit(badPin);
    expect(out.warnings.some(w => w.code === 'UNKNOWN_PIN')).toBe(true);
  });

  it('handles empty doc gracefully', () => {
    const out = renderCircuit({});
    expect(out.svg).toContain('<svg');
  });

  it('routes wires as L-shapes when endpoints are not aligned', () => {
    const out = renderCircuit({
      components: [
        { id: 'r1', type: 'resistor', x: 0, y: 0 },
        { id: 'r2', type: 'resistor', x: 8, y: 4 },
      ],
      wires: [{ from: 'r1.p2', to: 'r2.p1' }],
    });
    // L-shape route → one horizontal + one vertical segment
    const lines = out.svg.match(/<line /g) || [];
    expect(lines.length).toBeGreaterThanOrEqual(2);
  });

  it('draws jumper hops where wires cross without connecting', () => {
    // Two crossing wires that do not share an endpoint at the crossing.
    const out = renderCircuit({
      components: [
        { id: 'r1', type: 'resistor', x: 0,  y: 0 },
        { id: 'r2', type: 'resistor', x: 10, y: 0 },
        { id: 'r3', type: 'resistor', x: 5,  y: -4, rot: 90 },
        { id: 'r4', type: 'resistor', x: 5,  y: 4,  rot: 90 },
      ],
      wires: [
        { from: 'r1.p2', to: 'r2.p1' }, // horizontal across the middle
        { from: 'r3.p2', to: 'r4.p1' }, // vertical through the middle
      ],
    });
    // Horizontal segment should render as a <path> with an arc (A command).
    expect(out.svg).toMatch(/<path d="[^"]*A /);
  });

  it('keeps id/value labels upright for rotated components', () => {
    const out = renderCircuit({
      components: [
        { id: 'R1', type: 'resistor', x: 0, y: 0, rot: 90, value: '1.59k' },
      ],
      wires: [],
    });
    expect(out.warnings).toHaveLength(0);
    // The component group is rotated 90°, so each text label must carry a
    // counter-rotation (rotate(-90 ...)) to stay readable/upright.
    const texts = out.svg.match(/<text[^>]*>/g) || [];
    const labelTexts = texts.filter(t => /rotate\(/.test(t));
    expect(labelTexts.length).toBeGreaterThanOrEqual(2); // id + value
    expect(out.svg).toMatch(/<text[^>]*transform="rotate\(-90 /);
  });

  it('does not add counter-rotation to labels of unrotated components', () => {
    const out = renderCircuit({
      components: [{ id: 'R1', type: 'resistor', x: 0, y: 0, value: '10k' }],
      wires: [],
    });
    expect(out.svg).not.toMatch(/<text[^>]*transform="rotate\(/);
  });
});

// ── Validator tests ─────────────────────────────────────────────────────
describe('circuit validator', () => {
  it('passes a clean voltage divider', () => {
    const r = validateCircuit(voltageDivider);
    expect(r.ok).toBe(true);
    expect(r.errors).toHaveLength(0);
  });

  it('detects POWER_SHORT', () => {
    const r = validateCircuit(powerShort);
    expect(r.ok).toBe(false);
    expect(r.errors.some(e => e.code === 'POWER_SHORT')).toBe(true);
  });

  it('detects DANGLING_PIN', () => {
    const r = validateCircuit(dangling);
    expect(r.warnings.some(w => w.code === 'DANGLING_PIN' && w.pin === 'p2')).toBe(true);
  });

  it('detects FLOATING_ISLAND', () => {
    const r = validateCircuit(floating);
    expect(r.warnings.some(w => w.code === 'FLOATING_ISLAND' && w.components.includes('c1') && w.components.includes('c2'))).toBe(true);
  });

  it('detects POLARITY_REVERSED', () => {
    const r = validateCircuit(reversedCap);
    expect(r.warnings.some(w => w.code === 'POLARITY_REVERSED' && w.component === 'c1')).toBe(true);
  });

  it('reports UNKNOWN_PIN as a hard error', () => {
    const r = validateCircuit(badPin);
    expect(r.ok).toBe(false);
    expect(r.errors.some(e => e.code === 'UNKNOWN_PIN' && e.pin === 'bogus')).toBe(true);
  });

  it('reports UNKNOWN_TYPE as a hard error', () => {
    const r = validateCircuit({ components: [{ id: 'x1', type: 'wormhole', x: 0, y: 0 }], wires: [] });
    expect(r.errors.some(e => e.code === 'UNKNOWN_TYPE')).toBe(true);
  });

  it('reports stats', () => {
    const r = validateCircuit(voltageDivider);
    expect(r.stats.components).toBe(4);
    expect(r.stats.wires).toBe(3);
    expect(r.stats.nets).toBeGreaterThan(0);
  });
});

// ── Symbol catalog test ─────────────────────────────────────────────────
describe('circuit symbol catalog', () => {
  it('exposes at least 12 component types', () => {
    const types = listSymbolTypes();
    expect(types.length).toBeGreaterThanOrEqual(12);
    for (const t of ['resistor', 'capacitor', 'diode', 'led', 'npn', 'pnp', 'opamp', 'vcc', 'gnd']) {
      expect(types).toContain(t);
    }
  });
});
