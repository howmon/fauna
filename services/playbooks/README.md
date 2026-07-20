# @fauna-services/playbooks

Playbook and instruction management service. Stores, versions, and executes structured AI workflow playbooks — multi-step task definitions with conditions, variables, and per-step tool requirements — usable from any agent orchestration system.

---

## What It Does

- **Playbook CRUD** — create, read, update, delete named playbooks with versioning
- **Step execution** — orchestrates playbook steps via a connected agentic loop
- **Instruction file management** — reads and watches `.md` instruction files with hierarchy support
- **Parameter injection** — typed playbook parameters substituted at runtime
- **Conditional steps** — steps with `condition` and `onFailure` policies
- **Run history** — persistent log of all playbook executions with step-level detail
- **Export / import** — `.fauna-playbook` bundle format

---

## Playbook Schema

```ts
interface Playbook {
  id: string
  name: string
  description: string
  version: number
  parameters: {
    [name: string]: {
      type: 'string' | 'number' | 'boolean' | 'path'
      required: boolean
      default?: any
      description: string
    }
  }
  steps: PlaybookStep[]
  tags: string[]
}

interface PlaybookStep {
  id: string
  title: string
  instruction: string           // AI instruction for this step
  tools?: string[]              // Tools the AI may use in this step
  condition?: string            // Skip if falsy (evaluated as JS expression)
  onFailure?: 'abort' | 'skip' | 'retry' | `retry(${number})`
  parallel?: boolean            // Run alongside previous step
  timeout?: number              // Max ms for this step
}
```

---

## API

### List playbooks

```
GET /api/playbooks?tag=deployment&search=deploy
→ [{ "id", "name", "description", "version", "tags", "stepCount" }]
```

### Get playbook

```
GET /api/playbooks/:id
GET /api/playbooks/:id?version=2
```

### Create playbook

```
POST /api/playbooks
{ ...playbook }
```

### Update playbook (creates new version)

```
PUT /api/playbooks/:id
{ ...updatedPlaybook }
→ { "id", "version": 3 }
```

### Delete playbook

```
DELETE /api/playbooks/:id
```

### Run playbook

```
POST /api/playbooks/:id/run
Content-Type: application/json

{
  "parameters": {
    "repoUrl": "https://github.com/myorg/myapp",
    "environment": "production"
  },
  "agentLoopUrl": "http://localhost:4011",
  "model": "claude-sonnet-4-5"
}
→ SSE stream of step execution events:
  { type: 'step_start', stepId, title }
  { type: 'step_progress', stepId, delta }
  { type: 'step_done', stepId, result }
  { type: 'step_skipped', stepId, reason }
  { type: 'step_failed', stepId, error }
  { type: 'run_done', runId, status, durationMs }
```

### Cancel a running playbook

```
POST /api/playbooks/runs/:runId/cancel
```

### Get run history

```
GET /api/playbooks/:id/runs?limit=20
→ [{ "runId", "status", "startedAt", "durationMs", "stepResults" }]
```

### Export playbook bundle

```
GET /api/playbooks/:id/export
→ application/zip (.fauna-playbook)
```

### Import playbook bundle

```
POST /api/playbooks/import
Content-Type: multipart/form-data
file: <bundle.fauna-playbook>
```

---

## Instruction Files API

### List instruction files

```
GET /api/instructions
→ [{ "path", "scope": 'global'|'project'|'agent', "name", "active" }]
```

### Get instruction file content

```
GET /api/instructions/:id
→ { "content": "..." }
```

### Update instruction file

```
PUT /api/instructions/:id
{ "content": "..." }
```

### Get merged effective instructions

```
GET /api/instructions/effective?projectId=my-project&agentId=my-agent
→ { "merged": "# Global\n...\n# Project\n...", "sources": [...] }
```

---

## Configuration

```js
import { createPlaybooksService } from '@fauna-services/playbooks'

const svc = await createPlaybooksService({
  port: 4026,
  dataDir: '~/.myapp/playbooks',
  instructionDirs: {
    global: '~/.myapp/instructions',
    project: '.fauna/instructions.md'
  },
  watchInstructions: true,  // live reload on file change
  maxRunHistory: 100
})
```

---

## Integration Examples

### Run a deployment playbook from a CI system

```ts
import { PlaybooksClient } from '@fauna-services/playbooks/client'
const playbooks = new PlaybooksClient('http://localhost:4026')

const stream = playbooks.run('deploy-to-production', {
  parameters: { repoUrl: 'https://github.com/myorg/myapp', environment: 'prod' }
})

for await (const event of stream) {
  if (event.type === 'step_done') console.log(`✓ ${event.title}`)
  if (event.type === 'step_failed') {
    console.error(`✗ ${event.title}: ${event.error}`)
    break
  }
}
```

### Get effective instructions for an agent

```ts
const { merged } = await playbooks.getEffectiveInstructions({ projectId: 'my-app' })
// Prepend to agent system prompt
const systemPrompt = merged + '\n\n' + agentBasePrompt
```

---

## Storage

- `playbooks.db` — SQLite; tables: `playbooks`, `playbook_versions`, `runs`, `step_results`
- Instruction files stored as `.md` files on disk (human-readable, git-friendly)

---

## Dependencies

- `better-sqlite3` — playbook and run storage
- `archiver` / `unzipper` — bundle import/export
- `chokidar` — instruction file watching
- `zod` — playbook schema validation
