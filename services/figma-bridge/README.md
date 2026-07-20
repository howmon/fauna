# @fauna-services/figma-bridge

Figma integration service. Provides a WebSocket relay for Figma Plugin API code execution and an HTTP client for the Figma Dev Mode MCP server — giving any AI agent the ability to inspect and manipulate Figma designs.

---

## What It Does

- **Plugin relay** — bidirectional WebSocket bridge between an AI agent and the Fauna Figma plugin running inside Figma
- **Plugin API execution** — send arbitrary Figma Plugin API JavaScript to execute inside Figma's sandbox
- **Dev Mode MCP client** — connects to the Figma Dev Mode MCP server (port 3845) and exposes its tools
- **Design rules engine** — stores and injects user-defined design rules into the AI context
- **File tracking** — maintains state of which Figma files are open and which page/selection is active

---

## API

### Get connection status

```
GET /api/figma/status
→ {
    "pluginConnected": true,
    "mcpConnected": true,
    "activeFiles": [{ "fileName", "fileKey", "currentPage" }]
  }
```

### Execute Plugin API code

```
POST /api/figma/execute
Content-Type: application/json

{
  "fileKey": "abc123",
  "code": "return figma.currentPage.selection.map(n => ({ id: n.id, name: n.name, type: n.type }))"
}
→ { "result": [...], "error": null }
```

### Get current selection

```
GET /api/figma/selection
→ { "nodes": [{ "id", "name", "type", "x", "y", "width", "height" }] }
```

### List pages in active file

```
GET /api/figma/pages
→ [{ "id", "name", "nodeCount" }]
```

### Get design rules

```
GET /api/figma/rules
→ { "rules": [...] }
```

### Set design rules

```
POST /api/figma/rules
{ "rules": ["Always use 8px grid spacing", "Primary color must be #1A73E8"] }
```

### Get MCP tools from Figma Dev Mode

```
GET /api/figma/mcp/tools
→ [{ "name", "description", "inputSchema" }]
```

### Call a Figma MCP tool

```
POST /api/figma/mcp/tools/:toolName
{ ...args }
→ { "result": ... }
```

### WebSocket relay connection

The Figma plugin connects to:
```
ws://localhost:3335
```

Any consumer can also connect to this WebSocket to receive Figma events:
```
ws://localhost:4019/figma-events
```

Events: `selection_change`, `page_change`, `file_open`, `file_close`, `plugin_ready`

---

## Configuration

```js
import { createFigmaBridge } from '@fauna-services/figma-bridge'

const bridge = await createFigmaBridge({
  port: 4019,
  pluginRelayPort: 3335,      // port the Figma plugin connects to
  mcpServerPort: 3845,         // Figma Dev Mode MCP server port
  rulesFile: '~/.myapp/figma-rules.json',
  autoStartMcp: true           // spawn the MCP server subprocess
})
```

---

## Integration Examples

### AI design assistant in a custom IDE

```ts
import { FigmaBridgeClient } from '@fauna-services/figma-bridge/client'
const figma = new FigmaBridgeClient('http://localhost:4019')

// Check if Figma is connected
const { pluginConnected } = await figma.status()
if (!pluginConnected) return 'Please open the Fauna plugin in Figma'

// Get current selection
const { nodes } = await figma.getSelection()

// Execute Plugin API code
const result = await figma.execute({
  code: `
    const frame = figma.createFrame()
    frame.name = 'Hero Section'
    frame.resize(1440, 800)
    figma.currentPage.appendChild(frame)
    return frame.id
  `
})
```

### Inject design rules into any LLM context

```ts
const { rules } = await figma.getRules()
const systemPromptAddition = rules.length
  ? `\nDesign rules to follow:\n${rules.map(r => `- ${r}`).join('\n')}`
  : ''
```

---

## Figma Plugin Setup

1. Install the Fauna Figma plugin from `assets/figma-plugin/` (or load locally in Figma dev mode)
2. Open the plugin in Figma — it auto-connects to `ws://localhost:3335`
3. The bridge reports `pluginConnected: true` immediately

---

## Security

- Plugin API code execution is sandboxed within Figma's plugin runtime (no filesystem or network access from within Figma's sandbox)
- `toolGuard` reviews submitted code for unusual patterns before forwarding to the plugin
- Design rule injection is read-only (rules are text injected into context, never executed)

---

## Dependencies

- `ws` — WebSocket server (plugin relay)
- `node-fetch` — Figma MCP HTTP client
- `@modelcontextprotocol/sdk` — MCP protocol for Figma Dev Mode tools
