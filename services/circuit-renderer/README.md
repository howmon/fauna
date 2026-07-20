# @fauna-services/circuit-renderer

Electronic circuit and PCB design service. Converts circuit descriptions into SVG schematics, runs SPICE-compatible simulations, generates PCB layouts, performs design rule checks, and produces step-by-step build guides — without a GUI dependency.

---

## What It Does

- **SVG schematic rendering** — 44+ electronic symbols rendered from a circuit graph
- **SPICE simulation** — DC operating point, transient analysis, AC sweep
- **PCB autorouter** — grid-based rat's-nest routing with clearance rules
- **DRC (Design Rule Check)** — validates trace widths, clearances, pad sizes
- **Component footprint library** — through-hole and SMD footprints
- **Build guide generation** — step-by-step assembly instructions from BOM
- **Circuit validation** — electrical rule checking (floating nets, short circuits, missing grounds)

---

## API

### Render schematic to SVG

```
POST /api/circuit/render/schematic
Content-Type: application/json

{
  "components": [
    { "id": "R1", "type": "resistor", "value": "10k", "x": 100, "y": 50 },
    { "id": "C1", "type": "capacitor", "value": "100uF", "x": 200, "y": 50 },
    { "id": "U1", "type": "opamp", "x": 300, "y": 100 }
  ],
  "nets": [
    { "id": "NET1", "connections": [{ "component": "R1", "pin": "2" }, { "component": "U1", "pin": "+" }] }
  ],
  "options": { "width": 800, "height": 600, "theme": "dark" }
}
→ SVG string
```

### Simulate circuit

```
POST /api/circuit/simulate
{
  "netlist": "SPICE netlist string",
  "analysis": "transient",
  "options": { "stopTime": "10ms", "stepTime": "0.1ms" }
}
→ { "waveforms": [{ "net": "VOUT", "time": [...], "voltage": [...] }] }
```

### Generate PCB layout

```
POST /api/circuit/pcb/layout
{
  "components": [...],
  "nets": [...],
  "board": { "width": 100, "height": 80, "unit": "mm" }
}
→ { "placements": [...], "svg": "..." }
```

### Run DRC

```
POST /api/circuit/pcb/drc
{ "layout": { ... } }
→ { "passed": false, "violations": [{ "rule": "min_trace_width", "actual": "0.1mm", "required": "0.2mm", "location": [...] }] }
```

### Validate circuit (ERC)

```
POST /api/circuit/validate
{ "components": [...], "nets": [...] }
→ { "valid": true, "warnings": [], "errors": [] }
```

### Get component symbol SVG

```
GET /api/circuit/symbols/:type
→ SVG string

// Available: resistor, capacitor, inductor, diode, led, transistor_npn,
//            transistor_pnp, mosfet_n, mosfet_p, opamp, voltage_source,
//            ground, vcc, switch, relay, transformer, crystal, fuse, ...
```

### Get component footprint

```
GET /api/circuit/footprints/:packageType
// e.g., DIP-8, SOIC-8, 0402, 0603, TO-92, TO-220
```

### Generate build guide

```
POST /api/circuit/guide
{ "components": [...], "nets": [...] }
→ { "steps": [...], "bom": [...], "warnings": [...] }
```

---

## Configuration

```js
import { createCircuitService } from '@fauna-services/circuit-renderer'

const svc = await createCircuitService({
  port: 4016,
  spiceEngine: 'builtin', // 'builtin' | 'ngspice' (if installed)
  symbolTheme: 'ieee',    // 'ieee' | 'iec' | 'ansi'
  outputDir: '~/.myapp/circuits'
})
```

---

## Integration Examples

### AI circuit design assistant

```ts
import { CircuitClient } from '@fauna-services/circuit-renderer/client'
const circuit = new CircuitClient('http://localhost:4016')

// After AI generates a circuit description:
const svg = await circuit.renderSchematic({ components, nets })
// Display SVG in any UI

const sim = await circuit.simulate({ netlist: spiceNetlist, analysis: 'transient' })
// Plot waveforms
```

### Export pipeline

```ts
// Validate → Render → DRC → Guide
const validation = await circuit.validate({ components, nets })
if (validation.valid) {
  const schematic = await circuit.renderSchematic({ components, nets })
  const layout = await circuit.generatePcbLayout({ components, nets, board })
  const drc = await circuit.runDrc({ layout })
  const guide = await circuit.generateBuildGuide({ components, nets })
}
```

---

## Supported Component Types (44+)

Resistor, capacitor, inductor, diode, Zener diode, LED, transistor (NPN/PNP), MOSFET (N/P), JFET, op-amp, comparator, voltage regulator (linear/switching), voltage source (AC/DC), current source, ground, VCC, switch, relay, transformer, crystal, fuse, motor, speaker, microphone, antenna, battery, solar cell, photodiode, phototransistor, optocoupler, 555 timer, logic gates (AND/OR/NOT/NAND/NOR/XOR), flip-flop, multiplexer, ADC, DAC, EEPROM, microcontroller (generic).

---

## Dependencies

- `d3` / custom SVG emitter — schematic rendering
- Custom SPICE parser + solver — simulation (DC/transient)
- `better-sqlite3` — component library cache
