# @fauna-services/browser-automation

Portable browser automation service built on Playwright. Provides AI-accessible browsing, form interaction, action recording, screenshot capture, and a browser extension bridge — usable from any tool that needs a web-browsing agent capability.

---

## What It Does

- **AI browsing** — navigate, click, type, scroll, extract content via Playwright
- **Accessibility snapshot** — returns a structured accessibility tree (not raw HTML) for LLM consumption
- **Action recorder** — records user browser actions into a replayable script
- **Screenshot capture** — full-page or element-level screenshots
- **System capture** — screen recordings of the desktop (Electron context)
- **Browser extension bridge** — communicates with a companion browser extension for tab-level context
- **Network interception** — inspect and mock network requests

---

## API

### Navigate

```
POST /api/browser/navigate
{ "url": "https://example.com", "waitFor": "networkidle" }
```

### Take accessibility snapshot

```
GET /api/browser/snapshot
→ { "tree": { "role": "WebArea", "children": [...] } }
```

### Take screenshot

```
POST /api/browser/screenshot
{ "selector": "#main", "fullPage": false }
→ { "image": "base64...", "mimeType": "image/png" }
```

### Click element

```
POST /api/browser/click
{ "selector": "#submit-btn" }
```

### Fill form field

```
POST /api/browser/fill
{ "selector": "input[name=email]", "value": "user@example.com" }
```

### Extract page content

```
GET /api/browser/content
→ { "text": "...", "html": "...", "url": "...", "title": "..." }
```

### Start action recording

```
POST /api/browser/recording/start
```

### Stop and get recorded script

```
POST /api/browser/recording/stop
→ { "actions": [...], "playwrightScript": "..." }
```

### Replay a script

```
POST /api/browser/recording/replay
{ "script": "..." }
```

### List open tabs (via extension bridge)

```
GET /api/browser/tabs
→ [{ "id", "title", "url", "active" }]
```

### Get tab content (via extension bridge)

```
GET /api/browser/tabs/:id/content
→ { "text": "...", "html": "..." }
```

### Intercept network requests

```
POST /api/browser/route
{ "pattern": "**/api/v1/**", "handler": "log" }
GET /api/browser/network → [{ method, url, status, body }]
```

---

## Configuration

```js
import { createBrowserService } from '@fauna-services/browser-automation'

const svc = await createBrowserService({
  port: 4015,
  browser: 'chromium', // 'chromium' | 'firefox' | 'webkit'
  headless: true,
  extensionBridgePort: 4016, // WebSocket port for extension comms
  screenshotDir: '~/.myapp/screenshots',
  maxConcurrentPages: 3
})
```

---

## Integration Examples

### AI web research agent

```ts
import { BrowserClient } from '@fauna-services/browser-automation/client'
const browser = new BrowserClient('http://localhost:4015')

await browser.navigate('https://news.ycombinator.com')
const snapshot = await browser.snapshot()
// Feed snapshot.tree to LLM — no raw HTML bloat
const reply = await llm.complete(`Given this page: ${JSON.stringify(snapshot.tree)}, find the top 3 stories`)
```

### Automated form filler

```ts
await browser.navigate('https://myapp.com/signup')
await browser.fill('input[name=email]', 'test@example.com')
await browser.fill('input[name=password]', 'securepass')
await browser.click('button[type=submit]')
const content = await browser.content()
```

### Record a workflow, replay it later

```ts
await browser.startRecording()
// User manually interacts with the browser
const { playwrightScript } = await browser.stopRecording()
// Later:
await browser.replay(playwrightScript)
```

---

## Storage

- `recordings/` — saved action scripts as JSON
- `screenshots/` — timestamped screenshot files
- `network-logs.jsonl` — network request logs

---

## Dependencies

- `playwright` — browser automation
- `ws` — WebSocket server for extension bridge
- `sharp` — screenshot processing
