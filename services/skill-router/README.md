# @fauna-services/skill-router

Skill routing and intelligence service. Classifies user intent against a catalog of AI skill definitions, selects the best-matching skill, evaluates skill quality via automated gates, and injects the right system prompt and tools for any agent invocation.

---

## What It Does

- **Skill catalog** — CRUD for named skill definitions (system prompt, tools, model, keywords, personas)
- **Semantic routing** — hybrid keyword + embedding-based matching to select the best skill for a message
- **Evaluation gate** — automated quality gate that runs test cases against a skill before promotion
- **Seeds** — per-skill suggestion prompts surfaced in the UI
- **Personas** — cognitive lenses applied on top of any skill (e.g., "contrarian", "executor", "first principles")
- **Prompt audit** — analyses a system prompt for quality issues (vagueness, contradictions, over-constraining)

---

## Skill Schema

```ts
interface Skill {
  id: string
  name: string
  description: string
  systemPrompt: string
  tools: string[]               // Tool names the AI may use
  model?: string                // Override model for this skill
  keywords: string[]            // Routing keywords
  routingEmbedding?: number[]   // Pre-computed embedding of the skill description
  seeds: string[]               // Suggestion prompts
  tags: string[]
  evalTests?: SkillEvalTest[]
  version: number
}

interface SkillEvalTest {
  input: string
  expectedBehavior: string
  assertContains?: string[]
  assertToolCalled?: string
}
```

---

## API

### List skills

```
GET /api/skills?tag=coding&search=security
→ [{ "id", "name", "description", "tags", "toolCount", "seedCount" }]
```

### Get skill

```
GET /api/skills/:id
```

### Create skill

```
POST /api/skills
{ ...skill }
```

### Update skill

```
PUT /api/skills/:id
```

### Delete skill

```
DELETE /api/skills/:id
```

### Route a message to the best skill

```
POST /api/skills/route
{
  "message": "Can you review my code for security vulnerabilities?",
  "projectContext": { "tags": ["node", "express"] },
  "candidates": ["software-engineer", "security-reviewer", "code-reviewer"]  // optional restrict
}
→ {
    "skillId": "security-reviewer",
    "skill": { ...skillDefinition },
    "confidence": 0.88,
    "method": "semantic",
    "alternatives": [{ "skillId": "code-reviewer", "confidence": 0.72 }]
  }
```

### Get effective system prompt for a skill

```
POST /api/skills/:id/prompt
{
  "projectContext": { "name": "myapp", "path": "/home/user/myapp" },
  "persona": "contrarian",
  "variables": { "userName": "Solomon" }
}
→ { "systemPrompt": "You are a security expert...\n\n[Contrarian lens: challenge all assumptions...]" }
```

### Run evaluation gate

```
POST /api/skills/:id/evaluate
→ SSE stream:
  { type: 'test_start', testIndex: 0, input: '...' }
  { type: 'test_result', testIndex: 0, passed: true, response: '...' }
  { type: 'eval_done', passed: 3, failed: 1, score: 0.75 }
```

### Get skill seeds (suggestion prompts)

```
GET /api/skills/:id/seeds
→ [{ "prompt": "Review my latest commit for security issues", "category": "start" }]
```

### List all personas

```
GET /api/personas
→ [{ "id", "name", "description", "promptAddition" }]
```

### Audit a system prompt

```
POST /api/skills/audit-prompt
{ "prompt": "You are a helpful assistant that helps with code." }
→ {
    "score": 45,
    "issues": [
      { "severity": "high", "type": "vague_role", "message": "Role description too generic — be specific about the domain" },
      { "severity": "medium", "type": "missing_constraints", "message": "No output format or length guidance" }
    ],
    "suggestions": ["Specify the programming language focus", "Add examples of ideal responses"]
  }
```

---

## Built-In Personas

| ID | Name | Effect |
|---|---|---|
| `contrarian` | Contrarian | Challenges the current approach and proposes alternatives |
| `first_principles` | First Principles | Strips away assumptions and reasons from fundamentals |
| `executor` | Executor | Skips analysis, picks one approach, acts immediately |
| `mentor` | Mentor | Explains reasoning step-by-step, teaches the user |
| `critic` | Critic | Finds flaws and edge cases before declaring success |
| `optimist` | Optimist | Emphasises what's working and builds on it |

---

## Configuration

```js
import { createSkillRouterService } from '@fauna-services/skill-router'

const svc = await createSkillRouterService({
  port: 4030,
  skillsDir: '~/.myapp/skills',
  embeddings: {
    model: 'nomic-embed-text',
    dimensions: 768
  },
  routing: {
    method: 'hybrid',            // 'keyword' | 'semantic' | 'hybrid'
    keywordWeight: 0.4,
    semanticWeight: 0.6,
    confidenceThreshold: 0.5    // Below this: return default skill
  },
  defaultSkillId: 'general-assistant',
  evalAgentLoopUrl: 'http://localhost:4011'
})
```

---

## Integration Examples

### Route any user message before calling an AI

```ts
import { SkillRouterClient } from '@fauna-services/skill-router/client'
const router = new SkillRouterClient('http://localhost:4030')

// Route
const { skill, confidence } = await router.route({ message: userMessage })

// Get system prompt
const { systemPrompt } = await router.getEffectivePrompt(skill.id, {
  projectContext: activeProject,
  persona: userSelectedPersona
})

// Use in LLM call
const response = await llm.complete({ system: systemPrompt, message: userMessage, tools: skill.tools })
```

### Auto-route and switch skills mid-conversation

```ts
// Re-route on each turn (user might pivot from coding to deployment)
for (const turn of conversation) {
  const { skillId } = await router.route({ message: turn.message })
  if (skillId !== currentSkillId) {
    currentSkillId = skillId
    // Inject a context note that the assistant role has shifted
  }
}
```

---

## Storage

- `skills.db` — SQLite; tables: `skills`, `skill_versions`, `eval_runs`
- Skill files also written as `<id>.json` in `skillsDir` (human-readable, git-friendly)
- Routing embeddings stored as `BLOB` (quantized int8)

---

## Dependencies

- `better-sqlite3` — skill store + eval history
- `@xenova/transformers` — local embedding for semantic routing
- `zod` — skill schema validation
