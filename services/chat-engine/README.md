# @fauna-services/chat-engine

Portable, multi-model streaming chat service. Drop-in engine for any tool that needs SSE-streamed AI conversations with persistent history, context injection, thinking budgets, and auto-continuation.

---

## What It Does

- Streams AI responses over **Server-Sent Events** (SSE)
- Supports any model exposed by a compatible chat completions API (OpenAI-compatible)
- Manages multi-turn **conversation history** (stored in SQLite)
- Injects structured **context** (files, facts, project info, tool results) into the system prompt
- Handles model-specific quirks: Claude thinking budgets, o-series reasoning effort, token limits
- **Auto-continues** long responses that hit the model's max-token limit
- Emits structured tool-call events for downstream agentic consumers

---

## Transport

| Protocol | Use Case |
|---|---|
| `GET /api/chat/stream` (SSE) | Streaming responses to browser/UI clients |
| `POST /api/chat/complete` (JSON) | Non-streaming completion for CLI/scripting |
| WebSocket `/ws/chat` | Bidirectional chat for real-time UIs |

---

## API

### Start a streaming chat turn

```
POST /api/chat/stream
Content-Type: application/json

{
  "conversationId": "uuid",
  "message": "Explain the auth flow",
  "model": "claude-sonnet-4-5",
  "systemPrompt": "...",
  "context": [
    { "type": "file", "path": "src/auth.js", "content": "..." },
    { "type": "fact", "content": "We use JWT, not sessions." }
  ],
  "options": {
    "thinkingBudget": "medium",
    "maxTokens": 32000,
    "autoContinue": true
  }
}
```

**SSE events emitted:**

| Event | Payload |
|---|---|
| `delta` | `{ text }` — incremental text chunk |
| `thinking` | `{ text }` — model reasoning chunk (Claude) |
| `tool_call` | `{ name, arguments }` — tool invocation request |
| `done` | `{ finishReason, usage }` — stream complete |
| `error` | `{ message, code }` |

### Get conversation history

```
GET /api/conversations/:id
```

### List conversations

```
GET /api/conversations?projectId=&limit=50&offset=0
```

### Delete conversation

```
DELETE /api/conversations/:id
```

---

## Configuration

```js
import { createChatEngine } from '@fauna-services/chat-engine'

const engine = await createChatEngine({
  port: 4010,
  dataDir: '~/.myapp/chat',
  defaultModel: 'gpt-4.1',
  modelProviders: {
    openai: { apiKey: process.env.OPENAI_KEY },
    copilot: { token: process.env.COPILOT_TOKEN }
  },
  maxHistoryMessages: 100,
  autoContinueLimit: 5
})

await engine.start()
```

---

## Integration Examples

### VS Code Extension

```ts
import { ChatEngineClient } from '@fauna-services/chat-engine/client'

const client = new ChatEngineClient('http://localhost:4010')
const stream = client.stream({ message: 'Review this code', context: [...] })
for await (const event of stream) {
  if (event.type === 'delta') panel.append(event.text)
}
```

### CLI

```ts
import { chatOnce } from '@fauna-services/chat-engine'

const reply = await chatOnce({
  message: 'Summarize this file',
  context: [{ type: 'file', path: './main.js' }],
  model: 'gpt-4o-mini'
})
console.log(reply.text)
```

---

## Storage

- `conversations.db` — SQLite; tables: `conversations`, `messages`, `attachments`
- Messages stored as JSONL snapshots for fast append; SQLite for indexing

---

## Dependencies

- `express` / `fastify` — HTTP server
- `better-sqlite3` — conversation store
- `eventsource-parser` — upstream SSE parsing from model API
- `tiktoken` — token counting for context window management
