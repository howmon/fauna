# Sequence Diagram Type

Time-ordered messages between actors. Use when you need to show how components communicate over time, especially the order and causality of calls.

---

## When to use

- API call flows (bearer auth, token refresh on 401)
- Service-to-service RPC chains
- User interaction sequences (click → API → DB → response)
- Protocol handshakes (OAuth, WebSocket upgrade, mTLS)
- Async event pipelines with callbacks or acknowledgements

**Don't use for:** System topology (→ Architecture), decision logic (→ Flowchart), state changes without message passing (→ State machine).

---

## Primitives

### Lifelines

Each actor gets a vertical dashed lifeline. Lifeline column spacing: `160px` (minimum `120px` for compact sequences).

```svg
<!-- Lifeline header box -->
<rect x="X-48" y="20" width="96" height="32" rx="4"
      fill="{paper-2}" stroke="{ink}" stroke-width="1"/>
<text x="X" y="41" fill="{ink}" font-size="12" font-weight="600"
      font-family="'Geist', sans-serif" text-anchor="middle">Actor Name</text>
<!-- Dashed lifeline down -->
<line x1="X" y1="52" x2="X" y2="{bottom}"
      stroke="{rule-solid}" stroke-width="1" stroke-dasharray="4,4"/>
```

### Activation bars

Show an actor is actively processing. Width: `8px`, color: `{accent-tint}`, stroke `{accent}`.

```svg
<rect x="X-4" y="Y_start" width="8" height="Y_end-Y_start"
      fill="{accent-tint}" stroke="{accent}" stroke-width="0.8"/>
```

### Synchronous call arrow

Solid arrow from sender lifeline to receiver lifeline, horizontal:

```svg
<line x1="X_sender" y1="Y" x2="X_receiver-4" y2="Y"
      stroke="{muted}" stroke-width="1" marker-end="url(#arrow)"/>
<!-- Arrow label: 6–10px above the line, opaque mask rect, Geist Mono 8px -->
<rect x="MID_X-20" y="Y-16" width="40" height="11" rx="2" fill="{paper}"/>
<text x="MID_X" y="Y-8" fill="{muted}" font-size="8"
      font-family="'Geist Mono', monospace" text-anchor="middle">GET /token</text>
```

### Return arrow

Dashed, reversed direction (receiver → sender), same Y row spacing:

```svg
<line x1="X_receiver" y1="Y" x2="X_sender+4" y2="Y"
      stroke="{muted}" stroke-width="1" stroke-dasharray="4,3" marker-end="url(#arrow)"/>
```

### Self-call

A right-angle loop: exits right, goes down, re-enters from right:

```svg
<path d="M X Y H X+24 V Y+24 H X+4"
      fill="none" stroke="{muted}" stroke-width="1" marker-end="url(#arrow)"/>
```

---

## Combined fragments (ALT / OPT / LOOP)

A combined fragment is a labeled box drawn around a group of messages. Max: **1 per diagram** by default; 2 only if each is a single-region opt/loop. Max **1 nesting level**.

```svg
<!-- Fragment box (dashed border) -->
<rect x="X_left" y="Y_top" width="W" height="H"
      fill="none" stroke="{muted}" stroke-width="1" stroke-dasharray="5,3" rx="4"/>
<!-- Fragment type label in top-left pentagon -->
<rect x="X_left" y="Y_top" width="40" height="16" rx="3"
      fill="{paper-2}" stroke="{muted}" stroke-width="1"/>
<text x="X_left+20" y="Y_top+11" fill="{ink}" font-size="9" font-weight="600"
      font-family="'Geist Mono', monospace" text-anchor="middle">ALT</text>
<!-- Divider between ALT regions -->
<line x1="X_left" y1="Y_divider" x2="X_right" y2="Y_divider"
      stroke="{muted}" stroke-width="0.8" stroke-dasharray="3,3"/>
<!-- Region guard label -->
<text x="X_left+8" y="Y_top+28" fill="{muted}" font-size="8"
      font-family="'Geist Mono', monospace">[200 OK]</text>
```

---

## Layout rules

- **Vertical spacing between messages:** 40px (minimum 32px for compact)
- **Lifeline column spacing:** 160px (minimum 120px)
- **Activation bar:** starts at the incoming call arrow Y, ends at the return arrow Y
- **Fragment box:** 8px padding inside on all sides; the fragment's top edge is 16px above the first enclosed message
- **No diagonal arrows** — all message arrows are horizontal
- **Message labels:** Geist Mono 8px, all-caps, opaque mask rect, 6–10px gap above the stroke

---

## Complexity budget

| Limit | Value |
|---|---|
| Max lifelines | 5 |
| Max messages (arrows) | 12 |
| Max combined fragments | 1 (default); 2 if each single-region |
| Max alt regions | 2 |
| Max fragment nesting | 1 |
| Max focal (accent) elements | 2 |

---

## Token-refresh ALT grammar (canonical)

For bearer-token flows with a 401-triggered refresh branch, the combined fragment looks like:

```
ALT [token valid]
  Client → API: GET /resource  (token in header)
  API → Client: 200 OK + data
[401 → refresh]
  Client → AuthService: POST /refresh  (refresh token)
  AuthService → Client: new access token
  Client → API: GET /resource  (new token)
  API → Client: 200 OK + data
```

The refresh branch is the ALT's second region. The `[401 → refresh]` guard label sits immediately below the fragment divider line.

---

## Example SVG structure

```svg
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 640 480"
     role="img" aria-labelledby="seq-title seq-desc"
     data-fauna-diagram="v1">
  <title id="seq-title">OAuth token-refresh sequence</title>
  <desc id="seq-desc">Sequence showing a client making an API request. If the token is valid, the API returns data. If it returns 401, the client refreshes the token from AuthService and retries.</desc>
  <defs><!-- arrow markers --></defs>
  <rect width="100%" height="100%" fill="{paper}"/>
  <!-- Lifeline headers + dashed lines -->
  <!-- Message arrows (drawn top-to-bottom) -->
  <!-- Activation bars on top -->
  <!-- Combined fragment box last (on top of lines, behind labels) -->
</svg>
```

---

## Anti-patterns specific to sequence diagrams

- Diagonal arrows (all messages must be horizontal)
- Lifelines crossing each other (reorder actors so arrows flow left-to-right)
- Activation bars without a visible start/end arrow pair (orphaned bars confuse readers)
- Fragment type labels written in prose ("if token valid") — use formal guard syntax `[guard]`
- More than one combined fragment nesting level
- Self-call loops that don't close (the right-angle path must return to the lifeline)
