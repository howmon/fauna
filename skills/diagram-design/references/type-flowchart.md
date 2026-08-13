# Flowchart Type

Decision logic with branches. Use when you need to show a process that has conditional paths, gates, or binary decisions.

---

## When to use

- Request processing pipelines (auth check → cache hit → DB fallback)
- User onboarding flows with branch points
- Approval / rejection decision trees
- Error-handling paths (try → succeed → done; fail → retry → escalate)
- Policy evaluation traces (semantic pattern: paired policy traces)

**Don't use for:** Time-ordered messages between actors (→ Sequence), simple sequential steps with no branches (→ Process or Swimlane), state transitions (→ State machine).

---

## Node shapes

| Node | Shape | When |
|---|---|---|
| Start | Circle, `r=16`, accent fill | First node, always |
| End / terminal | Circle, `r=16`, ink fill | Last node(s) |
| Step / action | Rectangle, `rx=6` | Action the system or user performs |
| Decision | Diamond (rotated square) | Yes/No or conditional branch |
| Sub-process | Rectangle with vertical double-rule on left edge | Reusable child process |
| Document | Rectangle with wavy bottom | Output that gets written/sent |

---

## Diamond (decision node) geometry

```svg
<!-- Diamond centered at (cx, cy), half-width=hw, half-height=hh -->
<!-- For readable labels, hw=48 and hh=28 works for 2–3 word conditions -->
<polygon points="cx,cy-hh cx+hw,cy cx,cy+hh cx-hw,cy"
         fill="{paper-2}" stroke="{ink}" stroke-width="1"/>
<!-- Label centered at (cx, cy) -->
<text x="cx" y="cy+4" fill="{ink}" font-size="11" font-weight="600"
      font-family="'Geist', sans-serif" text-anchor="middle">Condition?</text>
```

Branch labels ("Yes" / "No", "Pass" / "Fail") sit on the outgoing arrows, 8px Geist Mono, all-caps, opaque mask rect, 6–10px gap from the stroke.

---

## Layout rules

- **Flow direction:** Top-to-bottom (default). Left-to-right is acceptable for wide horizontal flows. Never both in the same diagram.
- **Happy path:** runs straight down (or straight right). Unhappy paths branch to the side and rejoin below.
- **Back-edges (loops):** When a retry arc goes upward, route it to the left or right outside the main column. Never send it through the interior of the diagram.
- **All connectors:** rounded orthogonal elbows (`r=8`). No diagonal lines.
- **Max decision nesting:** 2 levels deep. Beyond that, extract a sub-process.

---

## Complexity budget

| Limit | Value |
|---|---|
| Max nodes (steps + decisions) | 9 |
| Max arrows | 12 |
| Max focal (accent) nodes | 2 |
| Max branch nesting | 2 |

---

## Paired policy-trace variant (semantic pattern)

When two rule traces need to be compared (pass/fail/skipped/not-reached), use two side-by-side flowchart columns with a shared node-row grid. Color-code outcomes:
- Pass: `{accent}` checkmark annotation
- Fail: red annotation (use a warm `#e05555` tone — not full red, which clashes with accent)
- Skipped: `{muted}` dashed arrow
- Not-reached: node fill `{ink @ 0.04}`, stroke `{ink @ 0.20}`

Mark the first divergence point with an accent callout.

---

## Example SVG structure

```svg
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 480 520"
     role="img" aria-labelledby="flow-title flow-desc"
     data-fauna-diagram="v1">
  <title id="flow-title">Request auth flow</title>
  <desc id="flow-desc">Flowchart showing how an incoming API request is authenticated: token present check, expiry check, scope check, and a reject path if any check fails.</desc>
  <defs>
    <!-- Arrow markers as per SKILL.md §5 -->
  </defs>
  <rect width="100%" height="100%" fill="{paper}"/>
  <!-- Connectors first -->
  <!-- Start circle -->
  <circle cx="240" cy="32" r="16" fill="{accent}" stroke="none"/>
  <text x="240" y="36" fill="{paper}" font-size="9" font-weight="600"
        font-family="'Geist Mono', monospace" text-anchor="middle">START</text>
  <!-- Step nodes, decision diamonds, end circles ... -->
</svg>
```

---

## Anti-patterns specific to flowcharts

- Diamond nodes for steps that are always executed (not conditional) — use rectangles
- Back-edges routed through the interior of the diagram (creates visual knots)
- "Yes" / "No" labels on the arrow without a masking rect (bleeds through the line)
- More than two levels of nested diamonds — extract to sub-process
- Start/end shapes that aren't circles (rectangles with rounded corners look like steps)
