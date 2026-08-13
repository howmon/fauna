# Architecture Diagram Type

Components and connections in a system. Use when you need to show services, databases, queues, APIs, and the connections between them.

---

## When to use

- Microservice landscapes
- Application stacks (frontend → backend → DB → cache)
- Cloud infrastructure topology
- System-to-system integration maps
- Security boundaries and trust zones

**Don't use for:** Decision logic (→ Flowchart), time-ordered messages (→ Sequence), data transformation pipelines (→ Data flow), org structures (→ Org chart).

---

## Layout rules

**Direction:** Left-to-right (user → services → data) is the default. Top-to-bottom for layered stacks. Never mix axes within the same diagram.

**Zones:** Group related nodes inside a labeled region (dashed border, `rule` stroke, Geist Mono zone label). Zones don't get fills — only a border.

**Node shapes:**
- Services / APIs: rectangle (`rx=6`)
- Databases / stores: rectangle with bottom double-rule (two horizontal lines at `y+H-4` and `y+H-1`)
- Queues: rectangle with left/right curved ends (`rx=H/2`)
- External systems: rectangle with dashed border (`stroke-dasharray="4,3"`)
- Users / clients: rectangle with a person icon or lighter fill

**Connection types:**
- Sync call: solid arrow (`marker-end="url(#arrow)"`)
- Async / event: dashed arrow (`stroke-dasharray="5,4"`)
- Data read: solid, link-blue (`marker-end="url(#arrow-link)"`)
- Focal / highlighted: solid, accent (`marker-end="url(#arrow-accent)"`)

---

## Elbow-path formula

All connectors between off-axis nodes use orthogonal elbows with `r=8`:

```svg
<!-- Horizontal exit → vertical → horizontal entry -->
<!-- Source exits right: (x1, y1). Destination enters left: (x2, y2). y1 ≠ y2 -->
<!-- mid = (x1 + x2) / 2 — rounded to nearest 4px multiple -->
<path d="M x1 y1 H mid-8 Q mid y1 mid y1+8 V y2-8 Q mid y2 mid+8 y2 H x2"
      fill="none" stroke="{muted}" stroke-width="1" marker-end="url(#arrow)"/>
```

Quick reference: `H` draws a horizontal segment, `V` vertical, `Q` a quarter-arc quadratic bezier. The `r=8` arcs ensure smooth elbows. Always round the midpoint to the nearest 4px.

---

## Crossing-arrow bridge / hop

When two orthogonal connectors cross and no junction is intended, add a small arc on the horizontal one:

```svg
<!-- Horizontal wire crossing a vertical wire at (cx, y) -->
<path d="M x1 y H cx-5 A 5 5 0 0 1 cx+5 y H x2"
      fill="none" stroke="{muted}" stroke-width="1"/>
```

The arc's `sweep-flag=1` (clockwise in SVG's Y-down coords) creates an upward bump over the vertical wire.

---

## Zone / cluster container

```svg
<!-- Dashed zone border — drawn BEFORE nodes so it sits behind them -->
<rect x="X" y="Y" width="W" height="H" rx="8"
      fill="none" stroke="{rule-solid}" stroke-width="1" stroke-dasharray="6,4"/>
<!-- Zone label: top-left, Geist Mono eyebrow -->
<text x="X+12" y="Y+14" fill="{muted}" font-size="8" font-weight="500"
      font-family="'Geist Mono', monospace" letter-spacing="0.12em"
      text-anchor="start" text-transform="uppercase">ZONE NAME</text>
```

---

## Complexity budget

| Limit | Value |
|---|---|
| Max nodes | 9 |
| Max arrows | 12 |
| Max focal (accent) nodes | 2 |
| Max zones | 4 |

Above 9 nodes, split into overview (zones only) + detail (per-zone close-up).

---

## Security boundary variant

When a semantic "secure paved road" pattern is routed here:
- Boundary box uses `accent @ 0.50 dashed 4,4` stroke
- Forbidden-ingress paths get a red ✕ marker instead of an arrowhead
- Permitted paths use `accent` arrow
- Everything outside the boundary uses `muted` / dashed

---

## Example SVG structure (minimal)

```svg
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 640 320"
     role="img" aria-labelledby="arch-title arch-desc"
     data-fauna-diagram="v1">
  <title id="arch-title">System architecture</title>
  <desc id="arch-desc">Three-tier web app: browser talks to API gateway, which routes to auth service and product service; both services read from a shared Postgres database.</desc>
  <defs>
    <marker id="arrow" markerWidth="8" markerHeight="6" refX="7" refY="3" orient="auto">
      <polygon points="0 0, 8 3, 0 6" fill="{muted}"/>
    </marker>
    <marker id="arrow-accent" markerWidth="8" markerHeight="6" refX="7" refY="3" orient="auto">
      <polygon points="0 0, 8 3, 0 6" fill="{accent}"/>
    </marker>
    <marker id="arrow-link" markerWidth="8" markerHeight="6" refX="7" refY="3" orient="auto">
      <polygon points="0 0, 8 3, 0 6" fill="{link}"/>
    </marker>
  </defs>
  <!-- Background -->
  <rect width="100%" height="100%" fill="{paper}"/>
  <!-- Connectors drawn FIRST (behind nodes) -->
  <!-- ... path elements ... -->
  <!-- Nodes -->
  <!-- ... rect + text elements ... -->
</svg>
```

---

## Anti-patterns specific to architecture

- Diagonal connectors between any two nodes — always orthogonal elbows
- More than one arrow sharing the same path segment — offset by ≥12px
- Zone fills (a light tint) on every region — use borders only; tints flatten hierarchy
- More than 2 focal (accent-stroke) nodes — the eye doesn't know where to look
- Arrow labels without opaque mask rects — they bleed through the stroke
