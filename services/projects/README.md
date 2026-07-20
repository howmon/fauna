# @fauna-services/projects

Project and workspace management service. Defines, stores, and loads AI project contexts — including source paths, active files, context snapshots, and audit trails — for injection into any AI agent's working context.

---

## What It Does

- **Project CRUD** — create, read, update, delete named project profiles
- **Source management** — register directories, files, and URLs as project context sources
- **Context loading** — reads project sources, computes relevant file content, and formats an LLM-ready context block
- **Project audit** — AI-generated health and completeness assessment of a project
- **Checkpoint integration** — hooks into `@fauna-services/file-ops` for pre-task snapshotting
- **Multi-project navigation** — switch active project; all services pick up the new context

---

## Project Schema

```ts
interface Project {
  id: string
  name: string
  path: string                   // Absolute root path
  description?: string
  sources: ProjectSource[]
  capabilities: {
    shell: boolean
    fileRead: string[]           // Glob patterns
    fileWrite: string[]
    browser: boolean
    figma: boolean
    mcp: string[]                // Allowed MCP server IDs
  }
  model?: string                 // Default model for this project
  skill?: string                 // Default skill routing ID
  tags: string[]
  createdAt: string
  updatedAt: string
}

interface ProjectSource {
  type: 'directory' | 'file' | 'url' | 'glob'
  path: string
  include?: string[]             // Glob include patterns
  exclude?: string[]             // Glob exclude patterns
  maxSize?: number               // Max bytes to include in context
  description?: string
}
```

---

## API

### List projects

```
GET /api/projects?tag=backend&search=auth
→ [{ "id", "name", "path", "description", "tags" }]
```

### Get project

```
GET /api/projects/:id
```

### Create project

```
POST /api/projects
{
  "name": "My App Backend",
  "path": "/home/user/projects/myapp",
  "sources": [
    { "type": "directory", "path": "src/", "exclude": ["node_modules/**", "dist/**"] }
  ],
  "capabilities": { "shell": true, "fileRead": ["**"], "fileWrite": ["src/**"] },
  "model": "claude-sonnet-4-5",
  "tags": ["node", "express", "postgresql"]
}
```

### Update project

```
PUT /api/projects/:id
```

### Delete project

```
DELETE /api/projects/:id
```

### Load project context (LLM-ready)

```
POST /api/projects/:id/context
{
  "query": "How is authentication implemented?",
  "maxTokens": 8000,
  "includeFileTree": true,
  "includePackageJson": true
}
→ {
    "context": "## Project: My App Backend\n\n### File Tree\n...\n\n### Relevant Files\n...",
    "filesIncluded": ["src/auth.js", "src/middleware/auth.js"],
    "tokenCount": 3420
  }
```

### Run project audit

```
POST /api/projects/:id/audit
→ {
    "health": "yellow",
    "score": 72,
    "issues": [
      { "severity": "high", "message": "No test files found", "path": "src/" }
    ],
    "recommendations": ["Add Jest test suite", "Add input validation to API routes"]
  }
```

### Get active project

```
GET /api/projects/active
```

### Set active project

```
POST /api/projects/active
{ "projectId": "my-project-id" }
```

### Detect project from path

```
POST /api/projects/detect
{ "path": "/home/user/projects/myapp" }
→ { "projectId": "...", "confidence": 0.95 } | { "projectId": null }
```

---

## Configuration

```js
import { createProjectsService } from '@fauna-services/projects'

const svc = await createProjectsService({
  port: 4027,
  dataDir: '~/.myapp/projects',
  contextDefaults: {
    maxTokens: 8000,
    includeFileTree: true,
    excludePatterns: ['node_modules/**', '.git/**', 'dist/**', '*.lock']
  },
  fileOpsUrl: 'http://localhost:4020' // @fauna-services/file-ops for checkpointing
})
```

---

## Integration Examples

### Load project context before each agent turn

```ts
import { ProjectsClient } from '@fauna-services/projects/client'
const projects = new ProjectsClient('http://localhost:4027')

// Detect project from current directory
const { projectId } = await projects.detect({ path: process.cwd() })

// Load context for the user's question
const { context } = await projects.loadContext(projectId, {
  query: userMessage,
  maxTokens: 6000
})

// Inject into AI call
const response = await llm.complete({
  system: baseSystemPrompt + '\n\n' + context,
  message: userMessage
})
```

### CLI: switch projects

```bash
fauna-projects use my-app-backend
fauna-projects audit
fauna-projects context --query "auth implementation" --max-tokens 4000
```

---

## Storage

- `projects.db` — SQLite; tables: `projects`, `project_sources`, `audit_history`
- Project configs also written as `project.json` files in `dataDir/<id>/` for git-friendliness

---

## Dependencies

- `better-sqlite3` — project index
- `glob` — source file discovery
- `tiktoken` — context token counting
- `ignore` — `.gitignore`-style exclude pattern evaluation
