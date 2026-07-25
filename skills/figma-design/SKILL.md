---
name: figma-design
description: "Design work in Figma via the figma_execute tool. Use whenever the user asks to design, mock up, style, lay out, restyle, prototype, or wireframe anything in Figma — dashboards, landing pages, marketing pages, cards, components, icon sets, spec pages, or design-system pieces. Also use for auto-layout audits, palette suggestions, and visual QA on an existing frame."
---

# Figma design skill

The `figma_execute` tool runs arbitrary Figma Plugin API JS via the Fauna
plugin. This skill covers the design decisions the API leaves to you.
For plugin-runtime rules (async APIs, dynamic-page loads, HUG-first frame
ordering, page-creation confirmation), read
`server/agentinstruction.md` from the workspace first — it's authoritative
on the mechanics. This file adds the *design* layer on top.

## Before you touch the file

1. **Confirm the target page.** Never silently `figma.createPage()`.
   Call `fauna_ask_user_decision` with two options ("use current page"
   vs. "create new page named X") before running any code that creates
   a page.
2. **Pick a palette from the topic, not from habit.** Never default to
   blue. Use the table below as inspiration and adapt to the domain
   (fintech ≠ wellness ≠ dev tool).
3. **Commit to a visual motif.** Pick ONE repeated element — rounded
   image frames, icons in colored circles, bold section numbers, a
   consistent card shape. Carry it across every frame.
4. **Reject accent stripes.** Do NOT use color bars, sidebar stripes,
   under-title accent lines, or single-side borders as a motif. They
   read as AI-generated filler. Use whitespace, a subtle tint, a drop
   shadow, or an icon instead.

## Palettes

Every palette dominates with one color (60–70% visual weight), supports
with 1–2 mid tones, and punches with one accent. Never give all colors
equal weight.

| Theme | Primary | Secondary | Accent |
|-------|---------|-----------|--------|
| Midnight Executive | `1E2761` (navy) | `CADCFC` (ice blue) | `FFFFFF` (white) |
| Forest & Moss | `2C5F2D` (forest) | `97BC62` (moss) | `F5F5F5` (cream) |
| Coral Energy | `F96167` (coral) | `F9E795` (gold) | `2F3C7E` (navy) |
| Warm Terracotta | `B85042` (terracotta) | `E7E8D1` (sand) | `A7BEAE` (sage) |
| Ocean Gradient | `065A82` (deep blue) | `1C7293` (teal) | `21295C` (midnight) |
| Charcoal Minimal | `36454F` (charcoal) | `F2F2F2` (off-white) | `212121` (black) |
| Teal Trust | `028090` (teal) | `00A896` (seafoam) | `02C39A` (mint) |
| Berry & Cream | `6D2E46` (berry) | `A26769` (dusty rose) | `ECE2D0` (cream) |
| Sage Calm | `84B59F` (sage) | `69A297` (eucalyptus) | `50808E` (slate) |
| Cherry Bold | `990011` (cherry) | `FCF6F5` (off-white) | `2F3C7E` (navy) |

**Backgrounds:** default to white (`FFFFFF`) or the user's brand palette.
Never default to cream/beige (`F5F5DC`, `FAF0E6`, `FAEBD7`, `FFF8E1`) —
they read as generic template output.

## Typography

| Element | Size | Weight |
|---------|------|--------|
| Frame title | 32–48px | Bold |
| Section header | 20–24px | Semibold |
| Body | 14–16px | Regular |
| Caption | 11–12px | Regular, muted |

- Left-align paragraphs and lists. Center only titles.
- Use `Inter`, `SF Pro Display`, `Segoe UI`, or the user's brand font.
  Avoid `Aptos` — inconsistent rendering across Figma / export targets.

## Layout patterns per frame

Every frame needs a visual element beyond text. Rotate through these:

- Two-column (text left, illustration/image right)
- Icon + text rows (icon in colored circle, bold header, body below)
- 2×2 or 2×3 grid of content blocks alongside a hero image
- Half-bleed image (full left or right side) with content overlay
- Big stat callout (60–96px number, small label below)
- Comparison columns (before/after, pros/cons, tier A/B/C)
- Timeline / process flow (numbered steps + arrows)

Vary layouts across a multi-frame set — do not repeat the same shell.

## Spacing

- 32px+ padding on outer frames; 24px between major content blocks
- 8/12/16/24 rhythm for internal gaps — never mix random values
- Leave breathing room; don't fill every pixel

## Avoid (checklist)

- Same layout on every frame
- Centered body text
- Titles < 24px sitting next to body ≥ 14px (no contrast)
- Blue defaults, cream defaults
- Accent lines under titles, sidebar stripes, edge borders
- Low-contrast icons/text (light-on-light, dark-on-dark)
- Text-only frames — always add an image, icon, chart, or shape
- Text that overflows its container — shrink font, split content, or
  enlarge the frame; never ship overflow

## QA loop (required)

1. Export the finished frame(s) via `figma.currentPage.selection[0].exportAsync({ format: 'PNG', constraint: { type: 'SCALE', value: 2 } })`.
2. Attach the image(s) to the reply so the user sees them.
3. Inspect fresh. Check in this order:
   - **Text overflow / cut-off at any shape or frame edge** — most common defect
   - Overlapping elements (text through shapes, lines through words)
   - Uneven gaps (cramped in one place, huge empty area in another)
   - Insufficient outer margin (< 24px from frame edge)
   - Columns not aligned consistently
   - Low-contrast text or icons
   - Leftover placeholder text (`Lorem`, `TODO`, `xxx`, sample data)
4. If defects found, patch in one round of `figma_execute` and re-export.
   Stop after 2 rounds — hand back to the user if issues persist.

## When to hand back to the user

- Copy is ambiguous or missing (don't invent it)
- Brand palette wasn't provided (pick from table above and confirm)
- The design would need > 3 frames of net-new content (propose an
  outline first, get approval, then build)
