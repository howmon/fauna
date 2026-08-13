---
name: diagram-design
description: Create editorial architecture, flowchart, sequence, ER, state machine, timeline, swimlane, quadrant, radar, loop, nested, tree, org chart, layer stack, Venn, pyramid, bar, line, Gantt, scatter, high-level, process, medallion, data flow, IT current-state, DP integration, and DP security matrix diagrams — plus fauna-native circuit schematics and PCB board views — as standalone self-contained HTML/SVG artifacts. Inherits fauna's active theme preset. Redraw draw.io / Mermaid sources; add brand tokens from a website.
---

# Diagram Design

Editorial diagrams that inherit fauna's active theme. No Mermaid slop, no generic rounded boxes, no shadows.

---

## 0. First-time setup — style guide gate

Before generating a diagram in a project, check `references/style-guide.md`. If the tokens are still at their defaults (fauna `cyber` preset values), ask the user:

> "This is your first diagram in this project. The style guide is still at the default (cyber palette). Options: (a) pull tokens from your website URL, (b) use fauna's active theme preset, (c) paste tokens manually, (d) proceed with defaults."

- **(a)** → follow `references/onboarding.md § URL`
- **(b)** → read `--fau-bg`, `--fau-fg`, `--fau-fg-muted`, `--accent` from fauna's resolved CSS tokens (ask the user to confirm the active preset), write to `style-guide.md`
- **(c)** → accept tokens, write to `style-guide.md`
- **(d)** → proceed; skip gate on subsequent runs in this project

Detect customization: if `accent` in `style-guide.md` differs from the cyber default (`#00ff87`), assume custom.

---

## 1. Philosophy

The highest-quality move is usually deletion.

- Every node represents a distinct idea. Two nodes that always travel together are one node.
- Every connection carries information. If the relationship is obvious from layout, remove the line.
- Accent is editorial, not a flag. 1–2 focal nodes per diagram.
- The diagram isn't done when everything is added. It's done when nothing can be removed.

**Target density: 4/10.** Above 9 nodes it's probably two diagrams.

---

## 2. When to Use

Use for any of the visual types in §3 when a reader will learn more from a visual than from prose, a table, or a bulleted list.

**Don't use for:**
- Quick unicode diagrams → wiretext
- Lists of things → table or bullets
- Simple before/after → table
- One-shape "diagrams" → write the sentence

Before drawing: *Would the reader learn more from this than from a well-written paragraph? If no, don't draw.*

---

## 3. Selection: semantic pattern, then visual type

When behavior, state, enforcement, or risk carries the meaning, first load `references/semantic-patterns.md` and choose one primary pattern. Then choose the nearest visual type for layout.

### Semantic pattern routing

| Trigger | Pattern → Visual type |
|---|---|
| Fan-in, queue depth, finite capacity, bottleneck | Fan-in queue / bottleneck → Data flow |
| Repeated Question / Input / Governance / Output slots across stages | Stage framework with semantic slots → Process |
| Conversation or loose input becomes a structured durable artifact | Unstructured input → structured artifact → Data flow |
| Two rule traces need pass/fail/skipped/not-reached and first divergence | Paired policy-evaluation traces → Flowchart |
| Trust boundaries plus permitted/forbidden ingress or deploy paths | Secure paved road → Architecture |
| Controls grouped by where they are enforced | Governance / control catalog → Layer stack |
| Defenses compensate for prior gaps and residual risk propagates | Compensating security layers → Layer stack |

### Visual-type guide (27 + 2 fauna-native)

| Use when you need to show | Type | Reference |
|---|---|---|
| Components + connections in a system | Architecture | type-architecture.md |
| Legacy IT landscape grouped by phase/department | IT current-state | type-it-state.md |
| Decision logic with branches | Flowchart | type-flowchart.md |
| Time-ordered messages between actors | Sequence | type-sequence.md |
| States + transitions + guards | State machine | type-state.md |
| Entities + fields + relationships | ER / data model | type-er.md |
| Events positioned in time | Timeline | type-timeline.md |
| Cross-functional process with handoffs | Swimlane | type-swimlane.md |
| Two-axis positioning / prioritization | Quadrant | type-quadrant.md |
| Multiple entities scored across 3–5 quantitative criteria | Radar / Spider | type-radar.md |
| Reinforcing cycle where last step feeds first | Loop / Flywheel | type-loop.md |
| Hierarchy through containment / scope | Nested | type-nested.md |
| Parent → children relationships | Tree | type-tree.md |
| Ownership, reporting, routing, escalation | Org chart | type-org-chart.md |
| Stacked abstraction levels | Layer stack | type-layers.md |
| Overlap between sets | Venn | type-venn.md |
| Ranked hierarchy or conversion drop-off | Pyramid / funnel | type-pyramid.md |
| Quantitative comparison across categories | Bar chart | type-bar.md |
| Continuous trends over time | Line chart | type-line.md |
| Tasks and phases on a timeline | Gantt | type-gantt.md |
| Distribution and correlation between two variables | Scatter plot | type-scatter.md |
| End-to-end data stack on a container cluster | High-Level | type-high-level.md |
| Multi-actor sequential process with data handoffs | Process | type-process.md |
| Multi-tier data storage with quality levels | Medallion | type-medallion.md |
| Role-scoped data flow: who does what at each step | Data flow | type-data-flow.md |
| Integration topology: sources → core → consumers | DP integration | type-dp-integration.md |
| Per-role / per-component access permissions matrix | DP security matrix | type-dp-security-matrix.md |
| **Electronics schematic (circuit)** | **Circuit** | **type-circuit.md** |
| **PCB physical board layout** | **PCB board** | **type-pcb.md** |

**Rules:**
- If a 3-column table communicates the same thing, pick the table.
- If two types seem useful, pick the dominant axis.
- If past the complexity budget (§7), split into overview + detail.

Always load the chosen `references/type-*.md` before drawing.

### Confirm before drawing

Before rendering, state the plan in one short message: the chosen visual type (and semantic pattern, if routed), the size preset, and anything the complexity budget will force out. Let the user redirect before drawing; if not reachable, proceed and note assumptions.

---

## 4. Universal Anti-patterns

| Pattern | Why it fails |
|---|---|
| Dark mode + cyan/purple glow | Looks "technical" without design decisions |
| JetBrains Mono as blanket "dev" font | Mono is for ports, commands, URLs. Names go in Geist sans. |
| Identical boxes for every node | Erases hierarchy |
| Legend floating inside the diagram area | Collides with nodes |
| Arrow labels with no masking rect | Bleeds through the line |
| Vertical `writing-mode` text on arrows | Unreadable |
| 3 equal-width summary cards as default | Generic grid — vary widths |
| Shadow on any element | Shadows are out. Borders are in. |
| `rounded-2xl` on boxes | Max radius 6–10px or none |
| Accent on every "important" node | Accent is 1–2 editorial elements, not a signaling system |
| Diagonal / slanted connectors | Rounded right-angle elbows are mandatory |
| Arrow label sitting on its connector | Label must have 6–10px gap above the line |
| Two connectors overlapping | Each connection must be independently traceable |

---

## 5. Design System

All colors and typography read from `references/style-guide.md` (semantic roles). When specs mention "ink", "accent", etc., look up the current value there.

### Semantic roles (fauna mapping)

| Role | Fauna CSS token | Default (cyber preset) |
|---|---|---|
| `paper` | `--fau-bg` | `#0a0f1a` (dark) / `#f0f4f8` (light) |
| `paper-2` | `--fau-surface` | `#111827` dark / `#ffffff` light |
| `ink` | `--fau-fg` | `#e2e8f0` dark / `#0f172a` light |
| `muted` | `--fau-fg-muted` | `#64748b` |
| `soft` | `--fau-fg-subtle` | `#475569` |
| `rule` | `rgba(--fau-fg, 0.10)` | hairline border |
| `accent` | `--accent` | `#00ff87` (emerald) |
| `accent-tint` | `rgba(--accent, 0.12)` | focal fill |
| `link` | `--fau-link` | `#38bdf8` |

**Focal rule:** `accent` goes on 1–2 elements max. Everything else is `ink` / `muted` / `soft`.

### Node type → treatment

| Node role | Fill | Stroke |
|---|---|---|
| Focal (1–2 max) | accent-tint | accent |
| Backend / API / Step | paper-2 | ink |
| Store / State | ink @ 0.05 | muted |
| External / Cloud | ink @ 0.03 | ink @ 0.30 |
| Input / User | muted @ 0.10 | soft |
| Optional / Async | ink @ 0.02 | ink @ 0.20 dashed 4,3 |
| Security / Boundary | accent @ 0.05 | accent @ 0.50 dashed 4,4 |

### Typography

- **Title** — Instrument Serif, 1.75rem, 400 — H1 only
- **Node name** — Geist (sans), 12px, 600 — human-readable labels
- **Sublabel** — Geist Mono, 9px — ports, URLs, field types
- **Eyebrow / tag** — Geist Mono, 7–8px, uppercase, tracked
- **Arrow label** — Geist Mono, 8px
- **Annotation callout** — Instrument Serif italic, 14px

```html
<link href="https://fonts.googleapis.com/css2?family=Instrument+Serif:ital@0;1&family=Geist:wght@400;500;600&family=Geist+Mono:wght@400;500;600&display=swap" rel="stylesheet">
```

Mono is for technical content. Names are Geist sans. Page title is Instrument Serif.

### Mandatory connector rules

1. **Orthogonal only.** Rounded right-angle elbows, `r=8`. Never diagonal `<line>` between off-axis nodes. Diagonal connectors are an automatic fail.
2. **Label margin: 6–10px gap.** Label must never sit on its arrow — the connector must remain visible.
3. **No overlapping connectors.** When two orthogonal arrows must cross, apply the bridge/hop primitive. When two arrows want to overlap, offset routing by ≥12px.
4. **Shared edge → fan attach points.** When 2+ connectors enter/exit the same edge of a box, each must have its own distinct attach point (≥12px apart).
5. **Don't route behind non-endpoint boxes** — except the unavoidable-intervening-box case (stroke must be dashed, label at visible end, no arrowhead on the intervening box).

### Node box — full pattern

```svg
<!-- 1. Opaque paper mask — prevents arrows bleeding through -->
<rect x="X" y="Y" width="W" height="H" rx="6" fill="{paper}"/>
<!-- 2. Styled box -->
<rect x="X" y="Y" width="W" height="H" rx="6" fill="{FILL}" stroke="{STROKE}" stroke-width="1"/>
<!-- 3. Type tag (rx=2, not a pill) -->
<rect x="X+8" y="Y+6" width="28" height="12" rx="2" fill="transparent" stroke="{STROKE@0.40}" stroke-width="0.8"/>
<text x="X+22" y="Y+15" fill="{STROKE@0.8}" font-size="7" font-family="'Geist Mono', monospace"
      text-anchor="middle" letter-spacing="0.08em">API</text>
<!-- 4. Node name (Geist sans) -->
<text x="CX" y="CY+2" fill="{ink}" font-size="12" font-weight="600"
      font-family="'Geist', sans-serif" text-anchor="middle">Node Name</text>
<!-- 5. Sublabel (Geist Mono) -->
<text x="CX" y="CY+18" fill="{muted}" font-size="9"
      font-family="'Geist Mono', monospace" text-anchor="middle">tech:port</text>
```

### Arrow markers (define all three, always)

```svg
<marker id="arrow" markerWidth="8" markerHeight="6" refX="7" refY="3" orient="auto">
  <polygon points="0 0, 8 3, 0 6" fill="{muted}"/>
</marker>
<marker id="arrow-accent" markerWidth="8" markerHeight="6" refX="7" refY="3" orient="auto">
  <polygon points="0 0, 8 3, 0 6" fill="{accent}"/>
</marker>
<marker id="arrow-link" markerWidth="8" markerHeight="6" refX="7" refY="3" orient="auto">
  <polygon points="0 0, 8 3, 0 6" fill="{link}"/>
</marker>
```

Draw arrows before boxes so z-order puts lines behind nodes.

### Arrow labels — always mask, always with margin

```svg
<!-- Mask sits 14px above the arrow (8px text height + 6px gap). -->
<rect x="MID_X-18" y="ARROW_Y-20" width="36" height="12" rx="2" fill="{paper}"/>
<text x="MID_X" y="ARROW_Y-11" fill="{muted}" font-size="8"
      font-family="'Geist Mono', monospace" text-anchor="middle" letter-spacing="0.06em">WRITE</text>
```

- ≤14 characters, all-caps, centered on segment midpoint.
- Mandatory 6–10px gap between mask bottom and arrow stroke.
- Never `writing-mode` vertical.

### Background

Default: clean paper, no dot pattern.
```svg
<rect width="100%" height="100%" fill="{paper}"/>
```

Optional dotted variant (hero diagrams only, not for product pages or slides):
```svg
<defs>
  <pattern id="dots" width="22" height="22" patternUnits="userSpaceOnUse">
    <circle cx="1" cy="1" r="0.9" fill="rgba({ink-rgb},0.10)"/>
  </pattern>
</defs>
<rect width="100%" height="100%" fill="{paper}"/>
<rect width="100%" height="100%" fill="url(#dots)" opacity="0.6"/>
```

### Legend — horizontal strip at bottom

Never put the legend inside the diagram area.
```svg
<line x1="30" y1="LEGEND_Y-8" x2="VIEWBOX_W-30" y2="LEGEND_Y-8"
      stroke="rgba({ink-rgb},0.10)" stroke-width="0.8"/>
<text x="30" y="LEGEND_Y+8" fill="{muted}" font-size="8" font-family="'Geist Mono', monospace"
      letter-spacing="0.14em">LEGEND</text>
```
Expand SVG `viewBox` height by ~60px.

---

## 6. Circuit & PCB Specifics

For circuit schematics and PCB boards, use `fauna_render_circuit` / `fauna_render_pcb` to produce the SVG from the DSL. Wrap in the editorial HTML template (§10) and apply the accessible SVG contract (§12). Do **not** hand-author circuit SVG.

Circuit-specific design rules:
- Component refdes labels: Geist sans, 11px, 500, `{ink}`
- Value labels: Geist Mono, 9px, `{muted}`
- Wire strokes: 1.4px, `{ink}` at 0.85 opacity
- Junction dots: filled `{ink}` circles, r=3px
- Power rails / net labels: Geist Mono, 9px, uppercase, `{accent}` for highlighted nets
- Grid: 16px default; all component coords must be grid-aligned

See `references/type-circuit.md` for full DSL schema and symbol library reference.

---

## 7. Layout & Spacing

### 4px grid (non-negotiable)

| Element | Values |
|---|---|
| Font sizes | 8, 12, 16, 20, 24, 28, 32, 40 |
| Node width / height | 80, 96, 112, 120, 128, 140, 144, 160, 180, 200, 240, 320 |
| x / y coordinates | multiples of 4 |
| Gap between nodes | 20, 24, 32, 40, 48 |
| Padding inside boxes | 8, 12, 16 |
| Border radius | 4, 6, 8 |

Exempt: stroke widths (0.8, 1, 1.2), opacity values, dot-pattern spacing.

Quick check: if a coordinate ends in 1, 2, 3, 5, 6, 7, 9 — fix it.

### Complexity budget

| Limit | Value |
|---|---|
| Max nodes | 9 |
| Max arrows / transitions | 12 |
| Max focal (accent) elements | 2 |
| Max lifelines (sequence) | 5 |
| Max lanes (swimlane) | 5 |
| Max items (quadrant) | 12 |
| Max entities (ER) | 8 |
| Max layers (layer stack / pyramid) | 6 |
| Max bars (bar chart) | 8 |
| Max series (line chart) | 5 |
| Max tasks (Gantt) | 12 |
| Max points (scatter) | 30 |
| Max circuit components (schematic) | 20 |

If you exceed, split into two diagrams (overview + detail).

### Page layout

1. **Header** — eyebrow (Geist Mono), title (Instrument Serif), optional subtitle (Geist muted)
2. **Diagram container** — SVG sits directly on page paper; optional framed variant for hero placements
3. **Summary cards** — 2–3 col grid with varied widths (e.g., `1.1fr 1fr 0.9fr`)
4. **Footer** — colophon in Geist Mono, muted, hairline top border

---

## 8. Summary Card Pattern

```html
<div class="card">
  <p class="eyebrow">SECTION LABEL</p>
  <div class="card-header">
    <span class="card-dot coral"></span>
    <h3>Card Title</h3>
  </div>
  <ul><li>Item</li></ul>
</div>
```

- `background: {paper-2}` (slight lift without shadow)
- `border: 1px solid rgba({ink-rgb}, 0.12)`
- `border-radius: 6px`, `padding: 1.25rem`
- No `box-shadow`
- Card dots: 7px, `border-radius: 50%` — ink / muted / accent / link variants

---

## 9. Pre-Output Checklist (Taste Gate)

Run before producing any diagram.

**Type fit:**
- [ ] Right visual type for the layout? (§3 visual-type guide)
- [ ] Semantic pattern chosen first if behavior carries the meaning?
- [ ] Stated type, pattern, size, and planned cuts before drawing — confirmed or assumptions noted?
- [ ] Would a table / paragraph do the same job? (If yes — don't draw.)
- [ ] Loaded the matching `references/type-*.md`?

**Remove test:**
- [ ] Can I remove any node? Can I merge any two nodes?
- [ ] Can I remove any arrow? Can I remove any label?

**Signal:**
- [ ] Accent used on ≤2 elements?
- [ ] Legend covers every type used — and nothing extra?
- [ ] Within the complexity budget (§7)?

**Technical:**
- [ ] SVG has `role="img"` and `aria-labelledby` resolving to `<title>` and `<desc>`?
- [ ] `<title>` is the first child of `<svg>` (before `<defs>`) and both slots are filled?
- [ ] `<title>` / `<desc>` IDs prefixed for this diagram — never bare `title` / `desc`?
- [ ] Arrows drawn before boxes (z-order)?
- [ ] Every connector between off-axis nodes uses a rounded right-angle elbow (`r=8`)? No diagonal lines?
- [ ] Every arrow label has a visible 6–10px gap above its connector?
- [ ] No two connectors overlap or share a stroke path?
- [ ] When connectors enter/exit the same edge, each has its own attach point (≥12px apart)?
- [ ] No connector passes behind a non-endpoint box (except the dashed-transit exception)?
- [ ] Every arrow label has an opaque mask rect behind it?
- [ ] Legend is a horizontal bottom strip, not floating?
- [ ] No vertical `writing-mode` text?
- [ ] Every font size, coord, width, height, gap divisible by 4?

**Typography:**
- [ ] Human-readable names in Geist sans?
- [ ] Technical sublabels (ports, commands, URLs) in Geist Mono?
- [ ] Page title in Instrument Serif?
- [ ] No JetBrains Mono anywhere?

---

## 10. Templates & Variants

Every diagram ships in three variants:

| Variant | Template | Use case |
|---|---|---|
| Minimal light | template.html | Screenshot-ready. Diagram + title. |
| Minimal dark | template-dark.html | Dark mode sites, slides. |
| Full editorial | template-full.html | Long-form posts where diagram is the hero. |

Optional overlays:
- **Sketchy** — SVG turbulence filter for hand-drawn feel. Essays only, not technical docs. See `references/primitive-sketchy.md`.
- **Terminal** — CLI-window chrome, monospace, one red-orange accent. Dev-tool posts. See `references/primitive-terminal.md`.
- **Animation** — optional `reveal`, `step`, or `loop` motion. Static default. See `references/animation.md`.

### To create a new diagram

1. Copy the variant closest to what you want.
2. Load the matching `references/type-<name>.md`. If behavior is load-bearing, also load `semantic-patterns.md`.
3. Replace the eyebrow, h1, and SVG body. Replace `[diagram-slug]` and fill `<title>` / `<desc>`.
4. If motion is requested, load `animation.md`; otherwise keep mode `none`.
5. Run the §9 taste gate.

---

## 11. Importing an Existing Diagram

Route by source: `.drawio*` → `references/import-drawio.md`; `.mmd`, `.mermaid`, or Markdown fenced block → `references/import-mermaid.md`.

Short version:
1. Run `drawio_extract.py` or `mermaid_extract.py` (in `scripts/`). Never render source coordinates, colors, or fonts.
2. Set the four dials: **format** (html/svg/png), **size** (doc-inline/slide-16x9/…), **detail** (faithful ≤24 / balanced ≤12 / simplified ≤7), **audience** (engineer/mixed/executive).
3. Redraw — never convert. Keep: components, relationships, grouping, direction. Drop: source coordinates, palette, fonts.
4. Report the fidelity ledger — what was merged, collapsed, or dropped.

---

## 12. Output

Always produce a single self-contained `.html` file:
- Embedded CSS (no external except Google Fonts)
- Inline SVG (no external images)
- Static by default; minimal inline JavaScript only for animation controls

### Accessible SVG contract

Every diagram SVG must have:

1. `role="img"` and `aria-labelledby="{slug}-title {slug}-desc"` on the `<svg>`
2. `<title id="{slug}-title">` as the **first child** of `<svg>`, before `<defs>`
3. `<desc id="{slug}-desc">` — one sentence describing the content (not the geometry)
4. IDs prefixed per diagram and variant: `{slug}-title` / `{slug}-desc` — never bare `title` / `desc`
5. Decorative SVG carries `aria-hidden="true"` instead

Slug matches the file: `architecture`, `architecture-dark`, `architecture-full`.

### Provenance marker

Every diagram SVG produced by fauna must carry `data-fauna-diagram="v1"` on its root `<svg>`. The chat route verifies this marker; if the model hand-authors SVG without it, a re-prompt forces use of the diagram skill.

Circuit schematics use `data-fauna-circuit="v1"` (already implemented). PCB boards use `data-fauna-pcb="v1"`.
