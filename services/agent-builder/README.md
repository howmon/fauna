# @fauna-services/agent-builder

Agent definition management service. Handles creating, editing, storing, importing, and orchestrating AI agents — independent of any shell or UI layer.

---

## What It Does

- **CRUD** for agent manifests (`agent.json` schema)
- **Synthesizes agents** from raw instruction folders (`AGENT.md`, `system-prompt.md`, `SKILL.md`)
- **Security scanning** of agent definitions (prompt injection, data exfiltration patterns)
- **Harness-format import** — converts external agent folders into the unified manifest format
- **Agent orchestration** — routes user messages to the right agent based on metadata
- **Import / export** — `.fauna-agent` bundle format (zip of manifest + assets)

---

## Agent Manifest Schema

```json
{
  "id": "uuid",
  "name": "Security Reviewer",
  "description": "Reviews code for OWASP Top 10 vulnerabilities",
  "systemPrompt": "You are a security expert...",
  "model": "claude-sonnet-4-5",
  "tools": ["read_file", "run_shell", "search_web"],
  "capabilities": {
    "shell": false,
    "fileRead": ["src/**"],
    "fileWrite": [],
    "browser": false,
    "figma": false
  },
  "persona": "security",
  "tags": ["security", "code-review"],
  "version": "1.0.0"
}
```

---

## API

### List agents

```
GET /api/agents?tag=security&search=reviewer
```

### Get agent

```
GET /api/agents/:id
```

### Create agent

```
POST /api/agents
Content-Type: application/json
{ ...agentManifest }
```

### Update agent

```
PUT /api/agents/:id
```

### Delete agent

```
DELETE /api/agents/:id
```

### Scan agent for vulnerabilities

```
POST /api/agents/:id/scan
```

Response:
```json
{
  "safe": false,
  "issues": [
    { "severity": "high", "field": "systemPrompt", "message": "Potential prompt injection via unescaped user input interpolation" }
  ]
}
```

### Import from folder

```
POST /api/agents/import
Content-Type: application/json
{ "path": "/path/to/agent-folder" }
```

Supports: `agent.json`, `AGENT.md`, `system-prompt.md`, `SKILL.md`, `.claude/agents/*.md`

### Export bundle

```
GET /api/agents/:id/export
→ application/zip (.fauna-agent bundle)
```

### Import bundle

```
POST /api/agents/import-bundle
Content-Type: multipart/form-data
file: <bundle.fauna-agent>
```

### Route a message to an agent

```
POST /api/agents/route
{ "message": "Can you review my auth code for security issues?" }
→ { "agentId": "...", "agent": { ... }, "confidence": 0.92 }
```

---

## Configuration

```js
import { createAgentBuilderService } from '@fauna-services/agent-builder'

const svc = await createAgentBuilderService({
  port: 4012,
  agentsDir: '~/.myapp/agents',
  legacyDirs: ['~/.config/copilot-chat/agents'],
  scanOnSave: true
})
```

---

## Integration Examples

### Custom IDE plugin

```ts
import { AgentBuilderClient } from '@fauna-services/agent-builder/client'
const client = new AgentBuilderClient('http://localhost:4012')

// List all agents
const agents = await client.list()

// Route user input to the best agent
const { agentId } = await client.route(userMessage)

// Get agent definition to pass to agentic-loop
const agent = await client.get(agentId)
```

### Import a Claude-format agent directory

```ts
await client.importFromFolder('/path/to/.claude/agents/my-agent')
```

---

## Storage

- `agents/` directory — one `agent.json` per agent (human-readable, git-friendly)
- `agent-scan-log.jsonl` — security scan history

---

## Dependencies

- `better-sqlite3` — agent search index
- `archiver` / `unzipper` — bundle import/export
- `zod` — manifest validation
