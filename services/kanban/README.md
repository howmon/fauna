# @fauna-services/kanban

AI-augmented Kanban board service. Manages a columnar task board with card CRUD, drag-and-drop reordering, an optional AI autopilot worker, governance rules, and project audit — embeddable in any project management tool.

---

## What It Does

- **Board CRUD** — create/read/update/delete boards, columns, and cards
- **Card ordering** — fractional index ordering for O(1) drag-and-drop without full re-sort
- **Subtasks** — cards can have nested subtask lists
- **Labels, assignees, due dates** — standard card metadata
- **AI autopilot** — background worker that processes cards using an AI agent
- **Governance rules** — configurable rules constraining which cards can move between columns
- **Project audit** — AI-generated health assessment of the board
- **SSE live updates** — any board change emitted to subscribers in real time

---

## API

### Get board

```
GET /api/kanban/boards/:boardId
→ { "id", "name", "columns": [{ "id", "name", "cards": [...] }] }
```

### Create board

```
POST /api/kanban/boards
{ "name": "Product Roadmap", "columns": ["Backlog", "In Progress", "Review", "Done"] }
```

### Create card

```
POST /api/kanban/boards/:boardId/cards
{
  "title": "Implement OAuth flow",
  "description": "Add GitHub OAuth to the signup page",
  "columnId": "backlog",
  "labels": ["auth", "backend"],
  "dueDate": "2026-08-01",
  "assignee": "solomon"
}
```

### Move card

```
PATCH /api/kanban/cards/:cardId
{
  "columnId": "in-progress",
  "order": 0.5   // fractional index between 0 (top) and 1 (bottom)
}
```

### Update card

```
PUT /api/kanban/cards/:cardId
{ "title": "...", "description": "...", "labels": [...] }
```

### Delete card

```
DELETE /api/kanban/cards/:cardId
```

### Add subtask

```
POST /api/kanban/cards/:cardId/subtasks
{ "title": "Write unit tests", "done": false }
```

### Start AI autopilot on a card

```
POST /api/kanban/cards/:cardId/autopilot
{
  "agent": "software-engineer",
  "model": "claude-sonnet-4-5",
  "taskContext": { "projectPath": "/home/user/my-app" }
}
→ SSE stream of autopilot progress events
```

### Get governance rules

```
GET /api/kanban/boards/:boardId/rules
```

### Set governance rules

```
PUT /api/kanban/boards/:boardId/rules
{
  "rules": [
    { "from": "Backlog", "to": "In Progress", "requiresField": "assignee" },
    { "from": "Review", "to": "Done", "requiresLabel": "approved" }
  ]
}
```

### Run project audit

```
POST /api/kanban/boards/:boardId/audit
→ { "health": "yellow", "issues": [...], "recommendations": [...] }
```

### Subscribe to board changes (SSE)

```
GET /api/kanban/boards/:boardId/events
→ SSE stream: { type: 'card_created'|'card_moved'|'card_updated'|'card_deleted', data: {...} }
```

---

## Configuration

```js
import { createKanbanService } from '@fauna-services/kanban'

const svc = await createKanbanService({
  port: 4024,
  dataDir: '~/.myapp/kanban',
  autopilot: {
    enabled: true,
    maxConcurrentCards: 2,
    agentLoopUrl: 'http://localhost:4011' // @fauna-services/agentic-loop
  }
})
```

---

## Card Schema

```ts
interface KanbanCard {
  id: string
  boardId: string
  columnId: string
  title: string
  description?: string
  labels: string[]
  assignee?: string
  dueDate?: string
  order: number           // fractional index
  subtasks: { id, title, done }[]
  autopilotStatus?: 'idle' | 'running' | 'done' | 'error'
  createdAt: string
  updatedAt: string
}
```

---

## Integration Examples

### Embed a live kanban in any web app

```html
<script>
const evtSource = new EventSource('http://localhost:4024/api/kanban/boards/my-board/events')
evtSource.onmessage = (e) => {
  const event = JSON.parse(e.data)
  updateBoardUI(event)
}
</script>
```

### AI task creation from a backlog description

```ts
import { KanbanClient } from '@fauna-services/kanban/client'
const kanban = new KanbanClient('http://localhost:4024')

const cards = await llm.parseTaskList('Build a REST API with auth, CRUD for users, and tests')
for (const card of cards) {
  await kanban.createCard({ boardId: 'sprint-1', ...card })
}
```

---

## Storage

- `kanban.db` — SQLite; tables: `boards`, `columns`, `cards`, `subtasks`, `card_labels`

---

## Dependencies

- `better-sqlite3` — board/card storage
- `ws` — real-time event broadcast
