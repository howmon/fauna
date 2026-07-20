# @fauna-services/file-ops

Atomic file operation and checkpointing service. Provides safe, transactional file reads and writes with automatic backup, patch application, git integration, and named snapshots — usable from any AI agent that needs reliable filesystem manipulation.

---

## What It Does

- **Atomic writes** — every write goes to a `.tmp` file and is atomically renamed to prevent corruption
- **Backup-before-write** — creates `.bak.<timestamp>` before overwriting any existing file
- **Batch writes** — apply multiple file changes as an atomic transaction
- **Patch application** — unified diff patching with fuzzy matching and conflict detection
- **Checkpoints / snapshots** — named point-in-time snapshots of a project's files
- **Restore** — restore individual files or entire checkpoints
- **Git operations** — init, stage, commit, diff, log (wraps `simple-git`)

---

## API

### Read a file

```
GET /api/files/read?path=/abs/path/to/file.js
→ { "content": "...", "encoding": "utf8", "size": 1024 }
```

### Write a file (atomic)

```
POST /api/files/write
{ "path": "/abs/path/to/file.js", "content": "...", "encoding": "utf8" }
→ { "written": true, "backupPath": "/abs/path/to/file.js.bak.1721477200" }
```

### Batch write (all or nothing)

```
POST /api/files/batch-write
{
  "files": [
    { "path": "/src/auth.js", "content": "..." },
    { "path": "/src/auth.test.js", "content": "..." }
  ]
}
→ { "written": 2, "failed": 0 }
```

### Apply a unified diff patch

```
POST /api/files/patch
{
  "path": "/src/auth.js",
  "patch": "--- a/auth.js\n+++ b/auth.js\n@@ -1,3 +1,3 @@\n..."
}
→ { "applied": true, "hunks": 3, "conflictCount": 0 }
```

### Delete a file

```
DELETE /api/files?path=/abs/path/to/file.js
```

### List directory

```
GET /api/files/ls?path=/abs/path/to/dir&recursive=true&pattern=**/*.ts
→ [{ "path", "size", "mtime", "isDir" }]
```

### Create checkpoint

```
POST /api/checkpoints
{
  "projectId": "my-project",
  "name": "Before auth refactor",
  "paths": ["/src/auth.js", "/src/middleware/"]
}
→ { "id": "cp-0001", "fileCount": 12 }
```

### List checkpoints

```
GET /api/checkpoints?projectId=my-project
→ [{ "id", "name", "createdAt", "fileCount", "description" }]
```

### Restore checkpoint

```
POST /api/checkpoints/:id/restore
{ "files": ["src/auth.js"] }  // omit to restore all files
→ { "restored": 12 }
```

### Delete checkpoint

```
DELETE /api/checkpoints/:id
```

### Git: status

```
GET /api/git/status?repoPath=/abs/path
```

### Git: commit

```
POST /api/git/commit
{ "repoPath": "/abs/path", "message": "feat: add JWT refresh", "stage": ["src/auth.js"] }
```

### Git: diff

```
GET /api/git/diff?repoPath=/abs/path&from=HEAD~1&to=HEAD
→ { "diff": "unified diff string" }
```

---

## Configuration

```js
import { createFileOpsService } from '@fauna-services/file-ops'

const svc = await createFileOpsService({
  port: 4020,
  checkpointsDir: '~/.myapp/checkpoints',
  allowedPaths: ['/home/user/projects'], // sandbox: restrict to these prefixes
  maxCheckpointsPerProject: 100,
  gitEnabled: true
})
```

---

## Integration Examples

### AI coding agent with safe file manipulation

```ts
import { FileOpsClient } from '@fauna-services/file-ops/client'
const files = new FileOpsClient('http://localhost:4020')

// Checkpoint before making changes
const cp = await files.createCheckpoint({ projectId: 'my-app', name: 'pre-refactor', paths: ['src/'] })

// Apply AI-generated changes
await files.batchWrite([
  { path: 'src/auth.js', content: newAuthCode },
  { path: 'src/auth.test.js', content: newTests }
])

// Run tests — if they fail, restore
const testResult = await runTests()
if (!testResult.passed) {
  await files.restoreCheckpoint(cp.id)
}
```

### Apply a diff patch from a code review

```ts
const patch = await llm.generatePatch({ file: 'src/auth.js', instruction: 'convert to async/await' })
const result = await files.applyPatch({ path: 'src/auth.js', patch })
if (result.conflictCount > 0) {
  // Handle conflicts
}
```

---

## Security

- `allowedPaths` restricts all operations to declared directories (path traversal prevention)
- Symlink resolution checked before every operation
- Atomic writes prevent partial-write corruption

---

## Storage

- `checkpoints.db` — SQLite; checkpoint metadata
- `checkpoints/<id>/` — directory containing snapshot files

---

## Dependencies

- `simple-git` — git operations
- `diff` / `patch` — unified diff application
- `glob` — file pattern matching
- `better-sqlite3` — checkpoint index
