# Fauna Services

Independent, portable services extracted from Fauna's feature set. Each service is a self-contained Node.js package that can be embedded in any tool, IDE extension, CLI, web app, or Electron app.

## Architecture Principles

- **Standalone HTTP/WebSocket server** — each service runs on its own port with a clean REST or SSE API
- **Transport-agnostic SDK** — a thin JS/TS client package wraps each service's API for easy integration
- **Zero Fauna dependency** — no coupling to the Fauna Electron shell; each service operates independently
- **Composable** — services communicate with each other via their public APIs (no shared state)
- **Embeddable** — each service can be spawned as a subprocess (`npx @fauna-services/<name>`) or imported as a library

---

## Services

| Folder | Package | Description |
|---|---|---|
| `chat-engine/` | `@fauna-services/chat-engine` | Multi-model streaming chat with SSE, context management, auto-continue |
| `agentic-loop/` | `@fauna-services/agentic-loop` | Tool-calling agentic loop engine with safety caps and tool dispatch |
| `agent-builder/` | `@fauna-services/agent-builder` | Agent CRUD, scanning, harness import, orchestration |
| `artifacts/` | `@fauna-services/artifacts` | Artifact type registry, HTML sandboxing, PDF export |
| `auth-gateway/` | `@fauna-services/auth-gateway` | Multi-provider auth (GitHub Copilot, OpenAI, Anthropic, Gemini), model routing |
| `browser-automation/` | `@fauna-services/browser-automation` | Playwright browsing, action recorder, browser extension bridge |
| `circuit-renderer/` | `@fauna-services/circuit-renderer` | Electronic circuit SVG rendering, SPICE simulation, PCB autorouter |
| `sync-engine/` | `@fauna-services/sync-engine` | HLC-based CRDT sync across devices, conflict resolution |
| `mcp-broker/` | `@fauna-services/mcp-broker` | MCP server lifecycle management, tool aggregation, namespace routing |
| `figma-bridge/` | `@fauna-services/figma-bridge` | Figma Plugin relay WebSocket, Dev Mode MCP client |
| `file-ops/` | `@fauna-services/file-ops` | Atomic file writes, patch application, checkpoint/snapshot system |
| `gen-ui/` | `@fauna-services/gen-ui` | GenUI component renderer: JSON → HTML/React artifacts |
| `history-index/` | `@fauna-services/history-index` | Cross-harness session indexing, FTS5 search, RAG recall |
| `image-gen/` | `@fauna-services/image-gen` | Image generation and editing via configurable model backends |
| `kanban/` | `@fauna-services/kanban` | Kanban board with AI autopilot worker, governance rules |
| `memory/` | `@fauna-services/memory` | Facts store, decay, hybrid vector+BM25 search, context RAG |
| `playbooks/` | `@fauna-services/playbooks` | Playbook storage, step execution, instruction file management |
| `projects/` | `@fauna-services/projects` | Project schema, sources, context loading, audit |
| `security/` | `@fauna-services/security` | Permission guard, tool guard, agent scanner, prompt injection defense |
| `shell-runner/` | `@fauna-services/shell-runner` | Sandboxed shell execution, task scheduler, workflow manager |
| `skill-router/` | `@fauna-services/skill-router` | Skill catalog, semantic routing, evaluation gate, personas |
| `teams/` | `@fauna-services/teams` | Teams bot manager, enterprise bridge, webhook integration |
| `theming/` | `@fauna-services/theming` | CSS variable theme system, preset management, token export |
| `voice/` | `@fauna-services/voice` | Kokoro TTS worker, Whisper/Parakeet STT, dictation pipeline |

---

## Common Service Contract

Every service follows the same structural contract:

```
services/<name>/
├── README.md          # API reference and integration guide
├── package.json       # npm package with bin entry
├── src/
│   ├── index.js       # Library entry (importable)
│   ├── server.js      # HTTP/WS server entry (standalone)
│   └── client.js      # SDK client for consumers
└── tests/
    └── *.test.js
```

### Starting a Service

```bash
# Standalone (subprocess)
npx @fauna-services/memory --port 4001 --data-dir ~/.fauna-data

# Programmatic
import { createMemoryService } from '@fauna-services/memory'
const svc = await createMemoryService({ port: 4001, dataDir: '~/.fauna-data' })
```

### Health & Discovery

All services expose:
- `GET /health` — `{ status: 'ok', version, uptime }`
- `GET /api/info` — service metadata, capabilities, config schema

---

## Integration Patterns

### VS Code Extension
Spawn services as subprocesses from the extension host; communicate over localhost HTTP.

### CLI Tool
Import service libraries directly (no HTTP layer needed for single-process CLIs).

### Web App
Run services as a local proxy; frontend communicates via `localhost` REST/SSE.

### Other Electron Apps
Start services in the main process; renderer communicates over IPC or localhost.

### Docker
Each service ships a `Dockerfile`; compose them together for a containerized deployment.
