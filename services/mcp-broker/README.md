# @fauna-services/mcp-broker

Model Context Protocol (MCP) broker service. Manages the lifecycle of multiple MCP servers, aggregates their tools into a unified namespace, handles conflicts, and exposes a single tool-call endpoint for any AI agent.

---

## What It Does

- **Lifecycle management** — start, stop, restart MCP servers (stdio or HTTP transport)
- **Tool aggregation** — collects tool definitions from all running servers into one catalogue
- **Namespace routing** — routes tool calls to the correct upstream server transparently
- **Conflict resolution** — detects duplicate tool names and applies prefix or priority rules
- **Auto-discovery** — detects well-known MCP servers running on standard ports (Browser MCP: 9009, Figma: 3845)
- **Health monitoring** — periodic heartbeat to each server; auto-restart on failure

---

## API

### List configured servers

```
GET /api/mcp/servers
→ [{ id, name, transport, status, toolCount, lastPing }]
```

### Add a server

```
POST /api/mcp/servers
Content-Type: application/json

{
  "name": "github-mcp",
  "transport": "stdio",
  "command": "npx",
  "args": ["-y", "@modelcontextprotocol/server-github"],
  "env": { "GITHUB_PERSONAL_ACCESS_TOKEN": "..." },
  "autoRestart": true
}
```

or HTTP transport:

```json
{
  "name": "figma-mcp",
  "transport": "http",
  "url": "http://localhost:3845"
}
```

### Remove a server

```
DELETE /api/mcp/servers/:id
```

### Start / stop / restart a server

```
POST /api/mcp/servers/:id/start
POST /api/mcp/servers/:id/stop
POST /api/mcp/servers/:id/restart
```

### List all aggregated tools

```
GET /api/mcp/tools
→ [{ name, description, inputSchema, serverId, serverName }]
```

### Call a tool

```
POST /api/mcp/tools/:toolName
Content-Type: application/json
{ ...toolArguments }
→ { result: any, error?: string, serverId, durationMs }
```

### Get tool call history

```
GET /api/mcp/logs?serverId=github-mcp&limit=50
→ [{ timestamp, toolName, arguments, result, durationMs }]
```

### Auto-discover running servers

```
POST /api/mcp/discover
→ [{ port, name, toolCount, added: true }]
```

### Get conflict report

```
GET /api/mcp/conflicts
→ [{ toolName, servers: ['github-mcp', 'gitlab-mcp'], resolution: 'prefix' }]
```

---

## Conflict Resolution Rules

When two servers expose the same tool name:

1. **Auto-prefix** (default): tools renamed `<serverName>__<toolName>` (e.g., `github__create_issue`)
2. **Priority**: configure `priority` on each server — higher priority server's tool takes the unqualified name
3. **Manual alias**: define explicit rename rules in config

```js
conflicts: {
  'create_issue': { prefer: 'github-mcp' }
}
```

---

## Configuration

```js
import { createMcpBroker } from '@fauna-services/mcp-broker'

const broker = await createMcpBroker({
  port: 4018,
  configFile: '~/.myapp/mcp-servers.json',
  autoDiscover: true,
  conflictResolution: 'prefix', // 'prefix' | 'priority' | 'error'
  healthCheckIntervalMs: 30_000,
  maxRestartAttempts: 3
})
```

---

## Integration Examples

### Pass all MCP tools to an AI agent

```ts
import { McpBrokerClient } from '@fauna-services/mcp-broker/client'
const broker = new McpBrokerClient('http://localhost:4018')

// Get tools in OpenAI function-calling format
const tools = await broker.getToolsForModel()

// AI returns a tool call → route it through the broker
const result = await broker.callTool(toolName, toolArgs)
```

### VS Code extension adding tools to the agentic loop

```ts
// Register extension-native tools alongside MCP tools
const allTools = [
  ...await broker.getTools(),
  { name: 'vscode_open_file', description: '...', inputSchema: {...} }
]
```

---

## Storage

- `mcp-servers.json` — server configurations
- `mcp-logs.db` — SQLite; tool call history and timing

---

## Dependencies

- `@modelcontextprotocol/sdk` — MCP JSON-RPC protocol
- `node-pty` / `child_process` — stdio server spawning
- `ws` — WebSocket server
