# Circuit Schematic Type

Use this type when the user asks for a circuit schematic, electronics diagram, or wants to visualize a circuit with components and wires.

**Do not hand-author circuit SVG.** Always use `fauna_render_circuit` to produce the schematic. The self-tool returns SVG marked with `data-fauna-circuit="v1"`; wrap it in the editorial HTML template.

---

## Tool chain

```
fauna_list_circuit_symbols          → discover available symbols + pin names
fauna_render_circuit(doc)           → circuit DSL → schematic SVG
fauna_validate_circuit(doc)         → structural lint (always run after render)
fauna_simulate_circuit(doc, ...)    → SPICE simulation (optional)
```

For physical board layout: see `type-pcb.md`.

---

## Circuit DSL

```json
{
  "components": [
    { "type": "resistor", "id": "R1", "value": "10k", "x": 5, "y": 3 },
    { "type": "capacitor", "id": "C1", "value": "100n", "x": 8, "y": 3 },
    { "type": "npn", "id": "Q1", "value": "BC547", "x": 10, "y": 5 }
  ],
  "wires": [
    { "from": "R1.p2", "to": "C1.p1" },
    { "from": "C1.p2", "to": "Q1.b" }
  ],
  "labels": [
    { "net": "VCC", "x": 5, "y": 0 },
    { "net": "GND", "x": 5, "y": 9 }
  ],
  "grid": 16
}
```

Grid units: coordinates are in grid units (default 16px per unit). Always use integer grid coordinates — never fractional.

---

## Available symbol categories

Call `fauna_list_circuit_symbols` before building the DSL. Key categories:

| Category | Types |
|---|---|
| Passives | resistor, capacitor, inductor, transformer, crystal, fuse |
| Diodes | diode, zener, led, schottky, tvs |
| Transistors | npn, pnp, nfet, pfet, jfet |
| ICs | op-amp, comparator, and, or, not, xor, nand, nor, xnor, timer-555, vreg |
| Power | battery, vsource, isource, gnd, vcc, vss |
| Connectors | header2, header3, header4, bnc |

---

## Layout rules

- **Component placement**: space components at least 3 grid units apart to avoid wire-routing conflicts.
- **Wire routing**: wires are routed as Manhattan L-shapes by the renderer. Place components so that direct L-routes don't pass through other component bodies.
- **Grid alignment**: all `x`/`y` must be integers. Non-integer coords trigger a `BAD_COMPONENT` warning.
- **Maximum components**: 20 per schematic (complexity budget). Split into sub-circuits if more.

---

## Editorial HTML wrapper

After `fauna_render_circuit` returns the SVG string, wrap it:

```html
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>{Circuit Title}</title>
  <link href="https://fonts.googleapis.com/css2?family=Instrument+Serif:ital@0;1&family=Geist:wght@400;500;600&family=Geist+Mono:wght@400;500;600&display=swap" rel="stylesheet">
  <style>
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
    body { background: {paper}; color: {ink}; font-family: 'Geist', sans-serif; padding: 2rem; }
    .eyebrow { font-family: 'Geist Mono', monospace; font-size: 0.75rem; letter-spacing: 0.14em;
                text-transform: uppercase; color: {muted}; margin-bottom: 0.5rem; }
    h1 { font-family: 'Instrument Serif', serif; font-size: 1.75rem; font-weight: 400;
         color: {ink}; margin-bottom: 1.5rem; }
    .diagram-wrap { overflow-x: auto; }
    .diagram-wrap svg { display: block; max-width: 100%; height: auto; }
  </style>
</head>
<body>
  <p class="eyebrow">CIRCUIT SCHEMATIC</p>
  <h1>{Circuit Title}</h1>
  <div class="diagram-wrap">
    {SVG from fauna_render_circuit — must carry data-fauna-circuit="v1"}
  </div>
</body>
</html>
```

Add `role="img"` and `aria-labelledby="{slug}-title {slug}-desc"` to the `<svg>` element. Insert `<title>` and `<desc>` as the first children (before `<defs>`).

---

## Validation

Always call `fauna_validate_circuit(doc)` after rendering. Surface warnings to the user:
- `POWER_SHORT` — two different voltage sources on the same net
- `DANGLING_PIN` — unconnected pin (may be intentional for open-collector, etc.)
- `FLOATING_ISLAND` — group of components not connected to GND or power
- `REVERSED_POLARITY` — polarized component (electrolytic cap, LED, diode) may be reversed
- `MISSING_DECOUPLING` — IC with no bypass capacitor near power pin

---

## Anti-patterns

- Hand-authoring circuit SVG (always produces wrong pin positions and non-standard symbols)
- Placing components at non-integer or non-grid coordinates
- Routing wires through component bodies (space components further apart or adjust layout)
- Omitting `fauna_validate_circuit` call
- Using more than 20 components in a single schematic
