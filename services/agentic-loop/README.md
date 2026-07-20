# @fauna-services/agentic-loop

Standalone agentic loop engine. Drives an AI model through multi-step tool-calling tasks autonomously — dispatching tools, feeding results back, detecting completion, and applying safety caps — without requiring Fauna's shell or UI.

---

## What It Does

- Runs the **AI → tool → result → AI** loop until the task is done or a cap is hit
- Dispatches tools from a **pluggable tool registry** (bring your own tools)
- Enforces a **maximum iteration cap** (default: 40 turns) to prevent runaway loops
- Emits structured **loop events** over SSE or WebSocket for live observability
- Supports **parallel tool calls** (multiple tool calls in a single model turn)
- Detects completion signals: model emits no tool calls, explicit `done` signal, or task plan marked complete
- Provides **loop snapshots**: full history of every turn, tool call, and result

---

## Transport

| Protocol | Use Case |
|---|---|
| `POST /api/loop/run` (SSE) | Start a loop; stream all events to caller |
| `POST /api/loop/cancel/:runId` | Cancel a running loop |
| `GET /api/loop/runs` | List all past loop runs (with status) |
| `GET /api/loop/runs/:id` | Full loop transcript |

---

## API

### Start a loop

```
POST /api/loop/run
Content-Type: application/json

{
  "model": "claude-sonnet-4-5",
  "systemPrompt": "You are a senior engineer...",
  "initialMessage": "Refactor auth.js to use async/await throughout",
  "tools": [
    {
      "name": "read_file",
      "description": "Read a file from disk",
      "inputSchema": { "type": "object", "properties": { "path": { "type": "string" } } }
    },
    {
      "name": "write_file",
      "description": "Write content to a file",
      "inputSchema": { "type": "object", "properties": { "path": { "type": "string" }, "content": { "type": "string" } } }
    }
  ],
  "options": {
    "maxIterations": 40,
    "parallelToolCalls": true,
    "thinkingBudget": "low"
  }
}
```

**SSE events emitted:**

| Event | Payload |
|---|---|
| `loop_start` | `{ runId, model, timestamp }` |
| `turn_start` | `{ turn, messageCount }` |
| `delta` | `{ text }` — streamed AI text |
| `tool_call` | `{ id, name, arguments }` |
| `tool_result` | `{ id, name, result, error? }` |
| `turn_end` | `{ turn, finishReason }` |
| `loop_done` | `{ turns, tokensUsed, durationMs }` |
| `loop_error` | `{ message, turn }` |

### Tool result callback

When a tool is called, the service emits a `tool_call` event and **pauses** until the caller sends the result:

```
POST /api/loop/runs/:runId/tool-result
{ "toolCallId": "...", "result": "...", "isError": false }
```

This allows the host application to execute tools in its own environment (filesystem, shell, browser, etc.) and feed results back.

---

## Pluggable Tool Execution

The loop itself does **not** execute tools — it orchestrates. Tool execution is the caller's responsibility:

```js
import { AgenticLoop } from '@fauna-services/agentic-loop'

const loop = new AgenticLoop({
  model: 'gpt-4.1',
  tools: myToolDefinitions,
  onToolCall: async ({ name, arguments: args }) => {
    // Execute the tool in your environment
    return await myToolExecutor(name, args)
  }
})

const result = await loop.run('Build a REST API for user management')
```

---

## Configuration

```js
import { createAgenticLoopService } from '@fauna-services/agentic-loop'

const svc = await createAgenticLoopService({
  port: 4011,
  maxIterations: 40,
  parallelToolCallLimit: 5,
  loopStorageDir: '~/.myapp/loops'
})
```

---

## Storage

- `loops.db` — SQLite; tables: `runs`, `turns`, `tool_calls`
- Full transcript stored per run for replay and debugging

---

## Integration Examples

### Embed in a VS Code extension

```ts
const loop = new AgenticLoop({ model: 'claude-sonnet-4-5', tools: vscodeTools })
loop.on('delta', text => panel.append(text))
loop.on('tool_call', async call => {
  const result = await vscode.executeCommand(`fauna.tool.${call.name}`, call.arguments)
  loop.submitToolResult(call.id, result)
})
await loop.run(userInstruction)
```

### Headless CLI pipeline

```bash
fauna-loop run --model gpt-4.1 --task "Write tests for src/auth.js" --tools ./my-tools.json
```

---

## Dependencies

- `@fauna-services/chat-engine` — model streaming (optional peer dep; can substitute own)
- `better-sqlite3` — run persistence
- `zod` — tool input schema validation
