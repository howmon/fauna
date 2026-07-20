# @fauna-services/gen-ui

Generative UI rendering service. Converts a structured JSON component tree into sandboxed HTML, React, or React Native output — enabling any AI agent to produce interactive UI components on demand.

---

## What It Does

- **JSON → HTML** — renders a GenUI component tree to a self-contained HTML string
- **JSON → React** — emits a React component tree (JSX string or importable module)
- **25+ built-in components** — buttons, cards, lists, forms, charts, calendars, tables, kanban, maps, media players, and more
- **Action vocabulary** — handles `onClick`, `onSubmit`, `onInput`, `navigate`, `open_url` events
- **Sandboxed preview** — serves the rendered artifact in a sandboxed iframe with no external requests
- **Theme-aware** — injects CSS variable tokens from the active theme into the render

---

## Component Library

| Component | Description |
|---|---|
| `button` | Primary / secondary / ghost button with icon |
| `card` | Content card with header, body, footer, optional image |
| `list` | Ordered/unordered/icon list |
| `form` | Form with typed input fields (text, email, select, checkbox, date) |
| `table` | Data table with sortable columns, pagination |
| `chart` | Line, bar, pie, area charts (ApexCharts backed) |
| `calendar` | Month/week/day calendar view with events |
| `kanban` | Columnar kanban board with draggable cards |
| `timeline` | Vertical timeline of events |
| `progress` | Progress bar / step progress |
| `stat` | Metric card (value + label + trend) |
| `badge` | Status badge |
| `avatar` | User avatar with name |
| `image` | Responsive image with caption |
| `video` | Embeddable video player |
| `audio` | Audio player |
| `code` | Syntax-highlighted code block |
| `markdown` | Rendered markdown block |
| `map` | Static map or interactive map embed |
| `accordion` | Collapsible sections |
| `tabs` | Tabbed panel |
| `modal` | Dialog/modal overlay |
| `grid` | Responsive grid layout container |
| `flex` | Flexbox layout container |
| `text` | Styled text (h1–h6, p, span, label) |

---

## API

### Render to HTML

```
POST /api/genui/render/html
Content-Type: application/json

{
  "root": {
    "type": "card",
    "props": {
      "title": "User Stats",
      "children": [
        { "type": "stat", "props": { "label": "Active Users", "value": "1,204", "trend": "+12%" } },
        { "type": "chart", "props": { "variant": "bar", "series": [{ "name": "Users", "data": [120, 200, 180, 250] }] } }
      ]
    }
  },
  "theme": { "primaryColor": "#1A73E8", "fontFamily": "Inter" }
}
→ { "html": "<div class='card'>...</div>", "css": "..." }
```

### Render to React JSX

```
POST /api/genui/render/react
{ "root": { ... } }
→ { "jsx": "export default function Component() { return <Card>...</Card> }" }
```

### Validate a GenUI tree

```
POST /api/genui/validate
{ "root": { ... } }
→ { "valid": true, "errors": [] }
```

### List available components

```
GET /api/genui/components
→ [{ "type", "description", "propsSchema" }]
```

### Get component schema

```
GET /api/genui/components/:type
→ { "type", "propsSchema", "examples": [...] }
```

### Preview (serve sandboxed)

```
POST /api/genui/preview
{ "root": { ... } }
→ { "previewUrl": "http://localhost:4021/preview/uuid" }

GET /api/genui/preview/:id
→ sandboxed HTML page
```

---

## GenUI Tree Format

```ts
interface GenUINode {
  type: string          // Component type (see library above)
  props: {
    children?: GenUINode | GenUINode[]
    [key: string]: any  // Component-specific props
  }
  key?: string          // Optional stable key for list items
  actions?: {
    [eventName: string]: GenUIAction
  }
}

interface GenUIAction {
  type: 'navigate' | 'open_url' | 'call_tool' | 'set_state' | 'submit_form'
  payload: any
}
```

---

## Configuration

```js
import { createGenUIService } from '@fauna-services/gen-ui'

const svc = await createGenUIService({
  port: 4021,
  theme: {
    primaryColor: '#1A73E8',
    fontFamily: 'Inter',
    borderRadius: '8px'
  },
  sandboxCsp: "default-src 'self'; script-src 'unsafe-inline'",
  maxTreeDepth: 20
})
```

---

## Integration Examples

### AI generates a dashboard

```ts
import { GenUIClient } from '@fauna-services/gen-ui/client'
const genui = new GenUIClient('http://localhost:4021')

// AI produces a GenUI tree
const tree = await llm.generateGenUI('Create a sales dashboard with monthly revenue chart and top 5 products table')

// Validate then render
const { valid } = await genui.validate(tree)
if (valid) {
  const { html, css } = await genui.renderHtml(tree)
  // Inject into any UI
}
```

### Export as a React component for shipping to production

```ts
const { jsx } = await genui.renderReact(tree)
fs.writeFileSync('components/Dashboard.jsx', jsx)
```

---

## Dependencies

- `apexcharts` (server-side via `jsdom`) — chart rendering
- `marked` — markdown rendering
- `highlight.js` — code syntax highlighting
- `zod` — component schema validation
