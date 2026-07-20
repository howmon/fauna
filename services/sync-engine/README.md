# @fauna-services/sync-engine

Hybrid Logical Clock (HLC) based CRDT sync service. Synchronises any structured data across multiple devices or processes — with conflict resolution, namespace isolation, and a pluggable relay backend.

---

## What It Does

- **HLC-based vector clocks** — monotonically ordered events even across machines with clock skew
- **CRDT merge** — last-write-wins per field; field-level conflict granularity
- **Namespace isolation** — `conversations`, `facts`, `agents`, `tasks`, `kanban`, `projects` (or custom)
- **Pluggable relay** — push/pull over HTTP relay, or peer-to-peer via WebSocket
- **Offline support** — accumulate changes locally; merge on reconnect
- **Change subscriptions** — callers subscribe to namespace changes and receive real-time diffs

---

## API

### Push changes

```
POST /api/sync/push
Content-Type: application/json

{
  "deviceId": "mac-home",
  "namespace": "facts",
  "objects": [
    {
      "id": "fact-uuid",
      "hlc": "2026-07-20T10:00:00.000Z-0001-mac-home",
      "payload": { "content": "We use PostgreSQL 16", "tags": ["database"] },
      "deleted": false
    }
  ]
}
→ { "accepted": 1, "conflicts": [] }
```

### Pull changes

```
POST /api/sync/pull
{ "deviceId": "mac-home", "namespace": "facts", "since": "2026-07-19T00:00:00.000Z" }
→ { "objects": [...], "serverTime": "..." }
```

### Get sync status

```
GET /api/sync/status
→ {
    "deviceId": "mac-home",
    "namespaces": [
      { "name": "facts", "localCount": 42, "pendingPush": 0, "lastSync": "..." }
    ]
  }
```

### Subscribe to namespace changes (SSE)

```
GET /api/sync/subscribe?namespace=facts&deviceId=mac-home
→ SSE stream of { type: 'change', namespace, objects: [...] }
```

### Resolve a conflict manually

```
POST /api/sync/conflicts/:conflictId/resolve
{ "resolution": "local" | "remote" | "merge", "mergedPayload": { ... } }
```

### List unresolved conflicts

```
GET /api/sync/conflicts
```

### Force full resync

```
POST /api/sync/resync
{ "namespace": "facts" }
```

---

## Sync Object Schema

```ts
interface SyncObject {
  id: string           // Stable UUID for the object
  namespace: string    // Which data category this belongs to
  hlc: string          // Hybrid logical clock timestamp
  payload: object      // The actual data (namespace-specific schema)
  deleted: boolean     // Soft delete flag
  deviceId: string     // Originating device
  checksum: string     // SHA-256 of payload for integrity
}
```

---

## Configuration

```js
import { createSyncEngine } from '@fauna-services/sync-engine'

const engine = await createSyncEngine({
  port: 4017,
  deviceId: 'my-laptop',
  dataDir: '~/.myapp/sync',
  relay: {
    url: 'https://my-relay.example.com',
    authToken: process.env.SYNC_TOKEN
  },
  namespaces: ['facts', 'agents', 'conversations'],
  conflictPolicy: 'auto', // 'auto' | 'manual' | 'local-wins' | 'remote-wins'
  syncIntervalMs: 30_000
})
```

---

## Integration Examples

### Sync a custom data type across devices

```ts
import { SyncClient } from '@fauna-services/sync-engine/client'
const sync = new SyncClient('http://localhost:4017')

// Push a local change
await sync.push('my-notes', [{
  id: 'note-123',
  payload: { title: 'Meeting notes', content: '...' },
  deleted: false
}])

// Subscribe to remote changes
sync.subscribe('my-notes', (changes) => {
  for (const obj of changes) {
    localStore.upsert(obj.id, obj.payload)
  }
})
```

### Self-hosted relay setup

```bash
docker run -p 8080:8080 fauna-services/sync-relay \
  --auth-secret $RELAY_SECRET \
  --storage-dir /data/sync
```

---

## Conflict Resolution Logic

1. For each field in the incoming object, compare HLC timestamps.
2. The field with the higher HLC timestamp wins (last-write-wins).
3. If timestamps are equal, tie-break by `deviceId` (lexicographic).
4. Objects flagged `conflictPolicy: 'manual'` are held in `conflicts` table for user resolution.

---

## Storage

- `sync.db` — SQLite; tables: `sync_objects`, `sync_log`, `conflicts`, `device_registry`
- All tables indexed by `(namespace, hlc)` for efficient range pull queries

---

## Dependencies

- `better-sqlite3` — local sync store
- `node-fetch` — relay HTTP client
- `ws` — WebSocket relay transport
