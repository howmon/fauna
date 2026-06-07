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

  it('draws a junction dot where a wire taps the interior of another wire', () => {
    // A horizontal rail spanning x=0..6 (grid units); a second wire taps its
    // midpoint and drops down. The tap is a real 3-way node → needs a dot.
    const out = renderCircuit({
      components: [
        { id: 'A', type: 'vcc', x: 0, y: 0 },
        { id: 'B', type: 'gnd', x: 6, y: 0 },
        { id: 'C', type: 'gnd', x: 3, y: 4 },
      ],
      wires: [
        { from: { x: 0, y: 0 }, to: { x: 6, y: 0 } }, // through-rail
        { from: { x: 3, y: 0 }, to: { x: 3, y: 4 } }, // taps the rail's interior
      ],
    });
    const dots = (out.svg.match(/<circle /g) || []).length;
    expect(dots).toBeGreaterThanOrEqual(1);
  });

  it('does not draw a junction dot at a pure (no-connect) wire crossing', () => {
    const out = renderCircuit({
      components: [
        { id: 'r1', type: 'resistor', x: 0,  y: 0 },
        { id: 'r2', type: 'resistor', x: 10, y: 0 },
        { id: 'r3', type: 'resistor', x: 5,  y: -4, rot: 90 },
        { id: 'r4', type: 'resistor', x: 5,  y: 4,  rot: 90 },
      ],
      wires: [
        { from: 'r1.p2', to: 'r2.p1' },
        { from: 'r3.p2', to: 'r4.p1' },
      ],
    });
    // Crossing wires that share no endpoint must hop, never connect with a dot.
    expect(out.svg).toMatch(/<path d="[^"]*A /);
    expect(out.svg).not.toMatch(/<circle /);
  });

  it('stamps engine-rendered SVG with the data-fauna-circuit provenance marker', () => {
    const out = renderCircuit(voltageDivider);
    // The marker lives on the root <svg> so the chat verifier and UI can prove
    // this came from the engine rather than being hand-authored by the model.
    expect(out.svg).toMatch(/<svg[^>]*\bdata-fauna-circuit="v1"/);
  });

  it('pushes labels off neighbouring component symbol bodies', () => {
    // Two parts deliberately packed so their glyphs overlap — the kind of
    // dense cluster (gate resistor + pulldown + MOSFET) that made the inverter
    // schematic crowd refdes/value text onto the transistor body.
    const out = renderCircuit({
      components: [
        { id: 'q1',  type: 'nmos',     x: 4, y: 0,        value: 'IRFZ44' },
        { id: 'gs1', type: 'resistor', x: 3, y: 0, rot: 90, value: '10k' },
      ],
      wires: [],
    });
    // World-space glyph boxes (grid=16). resistor 60×20 rot90 → 20×60.
    const boxes = {
      q1:  { x0: 64 - 20, y0: -22, x1: 64 + 20, y1: 22 },  // nmos 40×44 @ (64,0)
      gs1: { x0: 48 - 10, y0: -30, x1: 48 + 10, y1: 30 },  // res rot90 @ (48,0)
    };
    // Each label's owner (by text) — labels may only sit on their OWN body.
    const owner = { q1: 'q1', IRFZ44: 'q1', gs1: 'gs1', '10k': 'gs1' };
    const re = /<text x="(-?[\d.]+)" y="(-?[\d.]+)" text-anchor="(\w+)"[^>]*>([^<]+)<\/text>/g;
    const CW = 6.0, H = 12;
    let m, checked = 0;
    while ((m = re.exec(out.svg)) !== null) {
      const x = +m[1], y = +m[2], anchor = m[3], text = m[4];
      const w = text.length * CW;
      const x0 = anchor === 'start' ? x : anchor === 'end' ? x - w : x - w / 2;
      const x1 = anchor === 'start' ? x + w : anchor === 'end' ? x : x + w / 2;
      const lb = { x0, x1, y0: y - H * 0.8, y1: y + H * 0.2 };
      const own = owner[text];
      for (const [id, s] of Object.entries(boxes)) {
        if (id === own) continue; // a label may rest on its own glyph
        const hit = lb.x0 < s.x1 && s.x0 < lb.x1 && lb.y0 < s.y1 && s.y0 < lb.y1;
        expect(hit, `label "${text}" overlaps foreign body ${id}`).toBe(false);
      }
      checked++;
    }
    expect(checked).toBeGreaterThanOrEqual(4);
  });

  it('keeps id/value labels upright for rotated components', () => {
    const out = renderCircuit({
      components: [
        { id: 'R1', type: 'resistor', x: 0, y: 0, rot: 90, value: '1.59k' },
      ],
      wires: [],
    });
    expect(out.warnings).toHaveLength(0);
    // Labels are emitted by the renderer in world-space, always upright — so no
    // text element carries a rotate() transform even when the glyph is rotated.
    expect(out.svg).not.toMatch(/<text[^>]*transform="rotate\(/);
    // Both the refdes and the value must still be present.
    expect(out.svg).toContain('>R1<');
    expect(out.svg).toContain('>1.59k<');
  });

  it('does not add counter-rotation to labels of unrotated components', () => {
    const out = renderCircuit({
      components: [{ id: 'R1', type: 'resistor', x: 0, y: 0, value: '10k' }],
      wires: [],
    });
    expect(out.svg).not.toMatch(/<text[^>]*transform="rotate\(/);
  });

  it('de-collides refdes/value labels on tightly packed components', () => {
    const out = renderCircuit({
      components: [
        { id: 'R1', type: 'resistor', x: 0, y: 0, value: '150k' },
        { id: 'C1', type: 'capacitor', x: 1, y: 0, value: '100nF' },
        { id: 'R2', type: 'resistor', x: 3, y: 0, value: '150k' },
      ],
      wires: [],
    });
    // Pull the renderer's label layer (anchored <text> with no font-weight).
    const labels = [...out.svg.matchAll(
      /<text x="(-?[\d.]+)" y="(-?[\d.]+)" text-anchor="(\w+)"[^>]*>([^<]+)<\/text>/g
    )].map(m => ({ x: +m[1], y: +m[2], anchor: m[3], text: m[4] }));
    expect(labels.length).toBe(6); // id + value for 3 parts

    const CW = 6, CH = 12;
    const box = (L) => {
      const w = L.text.length * CW;
      let x0 = L.x - w / 2, x1 = L.x + w / 2;
      if (L.anchor === 'start') { x0 = L.x; x1 = L.x + w; }
      if (L.anchor === 'end')   { x0 = L.x - w; x1 = L.x; }
      return { x0, x1, y0: L.y - CH * 0.8, y1: L.y + CH * 0.2 };
    };
    let overlaps = 0;
    for (let i = 0; i < labels.length; i++) {
      for (let j = i + 1; j < labels.length; j++) {
        const a = box(labels[i]), b = box(labels[j]);
        if (a.x0 < b.x1 && b.x0 < a.x1 && a.y0 < b.y1 && b.y0 < a.y1) overlaps++;
      }
    }
    expect(overlaps).toBe(0);
  });

  it('renders every symbol in the catalog without unknown-type warnings', () => {
    for (const type of listSymbolTypes()) {
      const out = renderCircuit({
        components: [{ id: 'x1', type, x: 0, y: 0, value: '1k' }],
        wires: [],
      });
      expect(out.warnings.some(w => w.code === 'UNKNOWN_TYPE'), `${type} unknown`).toBe(false);
      expect(out.svg, `${type} empty svg`).toContain('<svg');
      // Each glyph emits at least one drawn primitive.
      expect(/<(line|path|polygon|polyline|rect|circle|text)\b/.test(out.svg), `${type} no glyph`).toBe(true);
    }
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
