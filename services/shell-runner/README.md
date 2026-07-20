# @fauna-services/shell-runner

Sandboxed shell execution and task scheduling service. Runs shell commands in isolated subprocesses with permission checking, output streaming, task queuing, and workflow orchestration — usable from any AI agent that needs to interact with the OS.

---

## What It Does

- **Command execution** — runs shell commands in a subprocess with configurable cwd, env, and timeout
- **Output streaming** — streams stdout/stderr over SSE in real time
- **Permission guard integration** — validates commands against the active capability profile before running
- **Task scheduler** — cron and one-shot task scheduling; persistent across restarts
- **Task runner** — executes multi-step AI tasks with tool access, logging, and lifecycle management
- **Workflow manager** — runs named workflows (sequences of shell commands + AI steps)
- **Safety analysis** — blocks dangerous command patterns before execution

---

## API

### Execute a command

```
POST /api/shell/exec
Content-Type: application/json

{
  "command": "npm run test -- --filter=auth",
  "cwd": "/home/user/projects/myapp",
  "env": { "NODE_ENV": "test" },
  "timeout": 60000,
  "stream": true
}
→ SSE stream:
  { type: 'stdout', data: '...' }
  { type: 'stderr', data: '...' }
  { type: 'exit', code: 0, signal: null }
```

Non-streaming:

```
POST /api/shell/exec
{ "command": "...", "stream": false }
→ { "stdout": "...", "stderr": "...", "exitCode": 0, "durationMs": 1230 }
```

### Check if a command is safe

```
POST /api/shell/analyse
{ "command": "rm -rf ./dist && npm run build" }
→ { "safe": true, "risk": "low", "patterns": [] }
```

### Kill a running process

```
POST /api/shell/exec/:execId/kill
```

### List running processes

```
GET /api/shell/processes
→ [{ "execId", "command", "cwd", "pid", "startedAt", "status" }]
```

---

## Task Scheduler API

### Create a scheduled task

```
POST /api/tasks
{
  "name": "Nightly test run",
  "schedule": "0 2 * * *",     // cron expression
  "command": "npm test",
  "cwd": "/home/user/projects/myapp",
  "enabled": true
}
```

### Create a one-shot task

```
POST /api/tasks
{
  "name": "Deploy to staging",
  "runAt": "2026-07-21T09:00:00Z",
  "command": "npm run deploy:staging",
  "cwd": "/home/user/projects/myapp"
}
```

### List tasks

```
GET /api/tasks
→ [{ "id", "name", "schedule", "status", "lastRun", "nextRun" }]
```

### Enable / disable task

```
PATCH /api/tasks/:id
{ "enabled": false }
```

### Trigger task now

```
POST /api/tasks/:id/run
→ SSE stream of execution output
```

### Get task run history

```
GET /api/tasks/:id/runs?limit=10
→ [{ "runId", "startedAt", "exitCode", "durationMs", "output" }]
```

---

## Workflow Manager API

### Define a workflow

```
POST /api/workflows
{
  "name": "test-and-deploy",
  "steps": [
    { "id": "lint", "command": "npm run lint" },
    { "id": "test", "command": "npm test", "dependsOn": ["lint"] },
    { "id": "build", "command": "npm run build", "dependsOn": ["test"] },
    { "id": "deploy", "command": "npm run deploy:prod", "dependsOn": ["build"] }
  ]
}
```

### Run a workflow

```
POST /api/workflows/:id/run
{ "env": { "DEPLOY_TARGET": "production" } }
→ SSE stream of step events:
  { type: 'step_start', stepId: 'lint' }
  { type: 'step_stdout', stepId: 'lint', data: '...' }
  { type: 'step_done', stepId: 'lint', exitCode: 0 }
  { type: 'workflow_done', status: 'success', durationMs: 45000 }
```

---

## Configuration

```js
import { createShellRunnerService } from '@fauna-services/shell-runner'

const svc = await createShellRunnerService({
  port: 4029,
  dataDir: '~/.myapp/shell',
  allowedPaths: ['/home/user/projects'],  // sandbox: restrict cwd to these prefixes
  defaultTimeout: 120_000,                // 2 minutes
  maxConcurrentProcesses: 5,
  securityUrl: 'http://localhost:4028',   // @fauna-services/security for pre-execution checks
  shell: '/bin/zsh'
})
```

---

## Integration Examples

### AI agent runs tests and reports results

```ts
import { ShellRunnerClient } from '@fauna-services/shell-runner/client'
const shell = new ShellRunnerClient('http://localhost:4029')

// Analyse before running
const { safe, patterns } = await shell.analyse('npm test -- --coverage')
if (!safe) return `Command blocked: ${patterns[0].description}`

// Run and stream output
const stream = shell.exec({ command: 'npm test -- --coverage', cwd: projectPath })
let output = ''
for await (const event of stream) {
  if (event.type === 'stdout') output += event.data
  if (event.type === 'exit') {
    return event.code === 0 ? `Tests passed\n${output}` : `Tests failed\n${output}`
  }
}
```

### Schedule nightly maintenance

```ts
await shell.createTask({
  name: 'Nightly dependency audit',
  schedule: '0 3 * * *',
  command: 'npm audit --json > audit-report.json',
  cwd: '/home/user/projects/myapp'
})
```

---

## Security

- All commands validated against `allowedPaths` (cwd must be within allowed prefixes)
- Dangerous patterns blocked before execution (configurable — see `@fauna-services/security`)
- Process isolation: each command runs in a fresh subprocess (no shared shell state)
- Environment variable scrubbing: parent `PATH`, `HOME`, `USER` passed; secrets from parent env not forwarded unless explicitly included in `env`

---

## Storage

- `shell.db` — SQLite; tables: `tasks`, `task_runs`, `workflows`, `workflow_runs`
- Task run output stored as JSONL

---

## Dependencies

- `node-pty` — pseudo-terminal for interactive command support
- `node-cron` — cron scheduling
- `better-sqlite3` — task and run storage
