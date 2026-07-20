# @fauna-services/history-index

Cross-harness AI session indexing and recall service. Indexes past coding sessions from multiple AI tools into a searchable SQLite database and exposes them for RAG-based context injection into any current AI conversation.

---

## What It Does

- **Session indexing** — reads conversation logs from Claude Code, Codex CLI, Cursor, GitHub Copilot CLI, Gemini CLI, and OpenCode
- **Full-text search** — FTS5 across all indexed sessions (summaries, file paths, tool calls)
- **Semantic search** — vector embedding of session summaries for similarity queries
- **RAG injection** — retrieves the top-N most relevant past sessions and formats them as context for any LLM prompt
- **Deduplication** — content-hash deduplication prevents re-indexing the same session across harnesses
- **Incremental indexing** — only indexes new sessions since the last run

---

## Supported Harnesses

| Harness | Log Location | Format |
|---|---|---|
| Claude Code | `~/.claude/projects/**/*.jsonl` | JSONL conversation turns |
| Codex CLI | `~/.codex/sessions/**/*.json` | JSON session files |
| Cursor | `~/.config/Cursor/logs/**` | SQLite workspace storage |
| GitHub Copilot CLI | `~/.config/gh-copilot/sessions/` | JSONL |
| Gemini CLI | `~/.gemini/sessions/` | JSONL |
| OpenCode | `~/.opencode/sessions/` | JSONL |
| Custom | Configurable path + parser | Pluggable |

---

## API

### Trigger index run

```
POST /api/history/index
{ "harnesses": ["claude", "codex"], "since": "2026-07-01T00:00:00Z" }
→ { "indexed": 42, "skipped": 5, "durationMs": 3200 }
```

### Full-text search

```
GET /api/history/search?q=authentication+JWT&limit=10&harness=claude
→ {
    "results": [
      {
        "sessionId": "...",
        "harness": "claude",
        "timestamp": "2026-07-15T14:23:00Z",
        "summary": "Refactored auth module to use JWT refresh tokens...",
        "relevantFiles": ["src/auth.js", "src/middleware/auth.js"],
        "snippet": "...switched from session-based to JWT-based auth...",
        "score": 0.94
      }
    ]
  }
```

### Semantic search

```
POST /api/history/search/semantic
{ "query": "how did I implement rate limiting", "limit": 5 }
→ { "results": [...] }
```

### Get session detail

```
GET /api/history/sessions/:id
→ { "sessionId", "harness", "turns": [...], "files": [...], "summary" }
```

### Get RAG context for a prompt

```
POST /api/history/context
{
  "query": "I need to add OAuth to my Express app",
  "maxSessions": 3,
  "maxTokens": 2000
}
→ {
    "context": "## Relevant past work\n\n### [Jul 15] JWT auth refactor...\n",
    "sessions": [...]
  }
```

### List all indexed sessions

```
GET /api/history/sessions?harness=claude&from=2026-07-01&limit=50
```

### Delete a session from the index

```
DELETE /api/history/sessions/:id
```

### Get index stats

```
GET /api/history/stats
→ { "totalSessions": 312, "byHarness": { "claude": 180, "cursor": 90, ... }, "lastIndexed": "..." }
```

---

## Configuration

```js
import { createHistoryIndexService } from '@fauna-services/history-index'

const svc = await createHistoryIndexService({
  port: 4022,
  indexDir: '~/.myapp/history-index',
  harnesses: {
    claude: { enabled: true, logsPath: '~/.claude/projects' },
    codex: { enabled: true, logsPath: '~/.codex/sessions' },
    cursor: { enabled: false }
  },
  embeddings: {
    enabled: true,
    model: 'nomic-embed-text', // local Ollama embedding model
    dimensions: 768
  },
  autoIndexIntervalMs: 3_600_000 // re-index every hour
})
```

---

## Integration Examples

### Inject history context into any AI prompt

```ts
import { HistoryIndexClient } from '@fauna-services/history-index/client'
const history = new HistoryIndexClient('http://localhost:4022')

// Before sending to LLM:
const { context } = await history.getContext({ query: userMessage, maxTokens: 1500 })
const systemPrompt = baseSystemPrompt + '\n\n' + context
```

### CLI: search your own AI history

```bash
fauna-history search "how did I deploy to Railway"
fauna-history sessions --harness claude --last 7d
```

---

## Storage

- `history.db` — SQLite; tables: `sessions`, `turns`, `session_files`, `search_index` (FTS5), `embeddings`
- Indexed files never copied; only metadata and summaries stored

---

## Dependencies

- `better-sqlite3` — FTS5 search store
- `@xenova/transformers` — local embedding model (optional)
- `glob` — log file discovery
