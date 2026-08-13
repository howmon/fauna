# PCB Board Type

Use this type when the user asks to see a physical board layout, PCB design, or wants to go from circuit → manufactured board.

**Always follow the full pipeline:** circuit DSL → `fauna_layout_pcb` → `fauna_render_pcb` → `fauna_check_board` → `fauna_build_guide`. Do not skip stages.

---

## Tool chain

```
fauna_list_circuit_symbols          → confirm component types (if DSL not yet built)
fauna_render_circuit(doc)           → schematic SVG (optional, for side-by-side reference)
fauna_layout_pcb(doc)               → place footprints + autoroute → board model
fauna_render_pcb(board)             → board model → layer-view SVG
fauna_check_board(board)            → DRC: clearance, overlap, unrouted net check
fauna_build_guide(board)            → BOM + assembly sequence + test points
```

---

## Board model

`fauna_layout_pcb` accepts the same circuit DSL as `fauna_render_circuit` and returns a board model:

```json
{
  "width": 60,
  "height": 40,
  "footprints": [ { "id": "R1", "x": 10, "y": 8, "rot": 0, "pads": [...] } ],
  "traces": [ { "net": "VCC", "layer": "top", "path": [...], "width": 0.25 } ],
  "vias": [ { "x": 20, "y": 15, "drill": 0.3, "pad": 0.6 } ],
  "airwires": [],
  "drc": []
}
```

---

## Visual design

PCB board SVG uses fixed layer colors (not user-themeable — these are standard EDA conventions):

| Layer | Color | Opacity |
|---|---|---|
| FR-4 substrate | `#2d5016` | 1.0 |
| Top copper | `#cc4444` | 0.85 |
| Bottom copper | `#4444cc` | 0.85 |
| Tinned pads | `#c8a832` | 1.0 |
| Silkscreen refdes | `#f5f5f0` | 1.0 |
| Drill holes | `#111111` | 1.0 |
| Airwires (unrouted) | `#ffaa00` | 0.6, dashed |

The HTML wrapper uses the user's fauna `{paper}` background outside the board boundary.

---

## Editorial HTML wrapper

```html
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>{Board Title}</title>
  <link href="https://fonts.googleapis.com/css2?family=Instrument+Serif:ital@0;1&family=Geist:wght@400;500;600&family=Geist+Mono:wght@400;500;600&display=swap" rel="stylesheet">
  <style>
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
    body { background: {paper}; color: {ink}; font-family: 'Geist', sans-serif; padding: 2rem; }
    .eyebrow { font-family: 'Geist Mono', monospace; font-size: 0.75rem; letter-spacing: 0.14em;
                text-transform: uppercase; color: {muted}; margin-bottom: 0.5rem; }
    h1 { font-family: 'Instrument Serif', serif; font-size: 1.75rem; font-weight: 400;
         color: {ink}; margin-bottom: 0.5rem; }
    .subtitle { font-size: 0.875rem; color: {muted}; margin-bottom: 1.5rem; }
    .board-wrap { overflow-x: auto; border: 1px solid {rule}; border-radius: 8px; padding: 1rem;
                  background: {paper-2}; display: inline-block; }
    .legend { display: flex; gap: 1.5rem; margin-top: 1rem; flex-wrap: wrap; }
    .legend-item { display: flex; align-items: center; gap: 0.375rem;
                   font-family: 'Geist Mono', monospace; font-size: 0.75rem; color: {muted}; }
    .legend-swatch { width: 12px; height: 12px; border-radius: 2px; }
  </style>
</head>
<body>
  <p class="eyebrow">PCB LAYOUT</p>
  <h1>{Board Title}</h1>
  <p class="subtitle">{Width}mm × {Height}mm · {Component count} components · {Layer count} layers</p>
  <div class="board-wrap">
    {SVG from fauna_render_pcb — must carry data-fauna-pcb="v1"}
  </div>
  <div class="legend">
    <div class="legend-item"><div class="legend-swatch" style="background:#cc4444"></div>Top copper</div>
    <div class="legend-item"><div class="legend-swatch" style="background:#4444cc"></div>Bottom copper</div>
    <div class="legend-item"><div class="legend-swatch" style="background:#c8a832"></div>Pads</div>
    <div class="legend-item"><div class="legend-swatch" style="background:#f5f5f0"></div>Silkscreen</div>
  </div>
</body>
</html>
```

---

## DRC requirements

Always call `fauna_check_board(board)` and surface issues to the user before presenting the output:

- `CLEARANCE_VIOLATION` — copper features too close (risk of short after manufacturing)
- `PAD_OVERLAP` — two pads from different nets overlap
- `UNROUTED_NET` — airwire present (net wasn't routed — board will not function)
- `BOARD_EDGE_VIOLATION` — footprint or trace outside board boundary

Airwires (`board.airwires.length > 0`) mean the board is not complete — always note this.

---

## Anti-patterns

- Running `fauna_render_pcb` without `fauna_layout_pcb` first (no board model)
- Skipping `fauna_check_board` (silently ships a non-functional board)
- Presenting a board with unrouted nets without calling out the issue
- Changing PCB layer colors to match the user's theme (layer colors are EDA conventions, not design tokens)
