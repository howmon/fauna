# Style Guide

Single source of truth for colors and typography. All diagram types read from here.
To customize: edit the table below, or run the onboarding flow (`references/onboarding.md`).

---

## Semantic Tokens

| Role | Default (cyber preset dark) | Default (cyber preset light) | Description |
|---|---|---|---|
| `paper` | `#0a0f1a` | `#f0f4f8` | Page / SVG background |
| `paper-2` | `#111827` | `#ffffff` | Card / container background |
| `ink` | `#e2e8f0` | `#0f172a` | Primary text and stroke |
| `muted` | `#64748b` | `#64748b` | Secondary text, default arrows |
| `soft` | `#475569` | `#94a3b8` | Subtle text, optional nodes |
| `rule` | `rgba(226,232,240,0.10)` | `rgba(15,23,42,0.10)` | Hairline borders |
| `accent` | `#00ff87` | `#00c96b` | 1–2 focal elements per diagram |
| `accent-tint` | `rgba(0,255,135,0.12)` | `rgba(0,201,107,0.12)` | Focal fill |
| `link` | `#38bdf8` | `#0284c7` | HTTP/API calls, external arrows |

Detect the active fauna preset from `localStorage['fauna-preset']` or `html[data-preset]` and substitute the resolved token values when generating diagrams in a live fauna session.

---

## Typography

| Role | Family | Size | Weight | Use |
|---|---|---|---|---|
| Title | Instrument Serif | 28px (1.75rem) | 400 | Diagram H1 only |
| Node name | Geist | 12px | 600 | Human-readable labels |
| Sublabel | Geist Mono | 9px | 400 | Ports, URLs, field types |
| Eyebrow / tag | Geist Mono | 8px, uppercase, ls 0.14em | 400 | Section labels, axis labels |
| Arrow label | Geist Mono | 8px | 400 | Connector annotations |
| Callout | Instrument Serif italic | 14px | 400 italic | Editorial asides |

Google Fonts import (required in all diagram HTML):
```html
<link href="https://fonts.googleapis.com/css2?family=Instrument+Serif:ital@0;1&family=Geist:wght@400;500;600&family=Geist+Mono:wght@400;500;600&display=swap" rel="stylesheet">
```

---

## Fauna Preset Mapping

When the user has changed their fauna appearance preset, substitute these token groups:

### cyber (default — emerald on dark)
```
paper:       #0a0f1a   paper-2: #111827
ink:         #e2e8f0   muted:   #64748b
accent:      #00ff87   link:    #38bdf8
```

### minimal (violet on dark)
```
paper:       #0f0f13   paper-2: #18181f
ink:         #e8e8f0   muted:   #6b6b80
accent:      #a78bfa   link:    #60a5fa
```

### ember (amber on dark)
```
paper:       #130e09   paper-2: #1c1510
ink:         #f5e6d0   muted:   #7a6b5a
accent:      #f59e0b   link:    #fb923c
```

### violet (purple on dark)
```
paper:       #0d0912   paper-2: #160d1e
ink:         #ede8f5   muted:   #7c6b9a
accent:      #c084fc   link:    #a78bfa
```

---

## Circuit-Specific Tokens

Circuit schematics and PCB boards add these on top of the base tokens:

| Token | Value (dark) | Value (light) | Use |
|---|---|---|---|
| `wire` | `rgba(226,232,240,0.85)` | `rgba(15,23,42,0.85)` | Wire / trace strokes |
| `junction` | `{ink}` | `{ink}` | Junction dots |
| `net-label` | `{accent}` | `{accent}` | Power rails, highlighted nets |
| `pcb-fr4` | `#2d5016` | `#2d5016` | PCB substrate |
| `pcb-top` | `#cc4444` | `#cc4444` | Top copper layer |
| `pcb-bottom` | `#4444cc` | `#4444cc` | Bottom copper layer |
| `pcb-silk` | `#f5f5f0` | `#f5f5f0` | Silkscreen refdes |
| `pcb-pad` | `#c8a832` | `#c8a832` | Tinned solder pads |
