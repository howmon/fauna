# @fauna-services/memory

AI memory and knowledge retrieval service. Stores, decays, and semantically searches facts — providing RAG-based long-term memory to any AI agent across sessions and projects.

---

## What It Does

- **Facts store** — CRUD for structured knowledge facts with tags, categories, and decay scoring
- **Temporal decay** — facts accessed less frequently naturally decay in retrieval ranking (not deleted)
- **Hybrid search** — BM25 keyword + vector cosine similarity for relevance-ranked fact retrieval
- **Context RAG** — formats the top-N relevant facts as a context block ready for LLM injection
- **Context store** — per-conversation short-lived context (embeddings computed from conversation history)
- **Quantized embeddings** — int8-quantized 768-dim embeddings stored in SQLite for fast similarity search
- **Namespacing** — user / project / team namespaces; each scoped independently

---

## API

### Add a fact

```
POST /api/memory/facts
Content-Type: application/json

{
  "content": "The production database is PostgreSQL 16 hosted on Railway",
  "tags": ["database", "infrastructure", "production"],
  "category": "infrastructure",
  "namespace": "my-project",
  "source": "conversation:uuid"
}
→ { "id": "fact-uuid", "embedding": "computed", "decayScore": 1.0 }
```

### Get a fact

```
GET /api/memory/facts/:id
```

### Update a fact

```
PUT /api/memory/facts/:id
{ "content": "...", "tags": [...] }
```

### Delete a fact

```
DELETE /api/memory/facts/:id
```

### List facts

```
GET /api/memory/facts?namespace=my-project&category=infrastructure&tag=database&limit=50
```

### Search facts (hybrid BM25 + vector)

```
POST /api/memory/search
{
  "query": "What database do we use in production?",
  "namespace": "my-project",
  "limit": 5,
  "minScore": 0.3
}
→ {
    "facts": [
      {
        "id": "...",
        "content": "The production database is PostgreSQL 16...",
        "score": 0.91,
        "accessCount": 12,
        "decayScore": 0.87,
        "tags": ["database", "infrastructure"]
      }
    ]
  }
```

### Get RAG context block

```
POST /api/memory/context
{
  "query": "How do we handle database migrations?",
  "namespace": "my-project",
  "maxFacts": 5,
  "maxTokens": 1500
}
→ {
    "context": "## Relevant Knowledge\n\n- The production database is PostgreSQL 16...\n- Migrations managed with Flyway...\n",
    "factsUsed": [...]
  }
```

### Record a fact access (for decay scoring)

```
POST /api/memory/facts/:id/access
```

### Run decay update (normalizes scores)

```
POST /api/memory/decay/run
→ { "updated": 42, "durationMs": 120 }
```

### Bulk import facts

```
POST /api/memory/facts/bulk
{ "facts": [{ "content", "tags", "namespace" }, ...] }
→ { "created": 10, "skipped": 2 }
```

### Export facts

```
GET /api/memory/export?namespace=my-project
→ application/json (array of facts)
```

---

## Configuration

```js
import { createMemoryService } from '@fauna-services/memory'

const svc = await createMemoryService({
  port: 4025,
  dataDir: '~/.myapp/memory',
  embeddings: {
    model: 'nomic-embed-text', // or 'text-embedding-3-small' (OpenAI)
    dimensions: 768,
    quantized: true            // int8 quantization for 4× smaller storage
  },
  decay: {
    enabled: true,
    halfLifeDays: 30,           // fact score halves after 30 days without access
    runIntervalHours: 24
  },
  namespaces: ['global', 'my-project', 'team']
})
```

---

## Integration Examples

### Inject memory context into any AI agent

```ts
import { MemoryClient } from '@fauna-services/memory/client'
const memory = new MemoryClient('http://localhost:4025')

// Before each AI turn:
const { context } = await memory.getContext({
  query: userMessage,
  namespace: activeProjectId,
  maxTokens: 1000
})
const systemPrompt = basePrompt + '\n\n' + context
```

### Extract and store facts from a conversation

```ts
// After AI responds, extract facts
const facts = await llm.extractFacts(aiResponse)
for (const fact of facts) {
  await memory.addFact({ content: fact, namespace: projectId, source: `conversation:${convId}` })
}
```

### CLI: manage your AI's memory

```bash
fauna-memory add "We deploy to Fly.io, not Heroku" --tag deployment --namespace my-app
fauna-memory search "where do we deploy" --namespace my-app
fauna-memory list --namespace my-app --category infrastructure
```

---

## Decay Algorithm

```
decayScore = baseScore × (0.5 ^ (daysSinceLastAccess / halfLifeDays))
```

Facts are never deleted by decay — only ranked lower. The `deleteThreshold` config can purge facts that drop below a minimum score.

---

## Storage

- `memory.db` — SQLite; tables: `facts`, `fact_embeddings`, `facts_fts` (FTS5), `access_log`
- Embeddings stored as `BLOB` (int8 quantized) for efficient cosine similarity via SQLite

---

## Dependencies

- `better-sqlite3` — facts store + FTS5
- `@xenova/transformers` — local embedding model (optional; falls back to API)
- `openai` — embedding API (optional)
