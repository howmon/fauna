# @fauna-services/security

Defense-in-depth security service for AI agents. Provides permission checking, command safety analysis, tool rate limiting, agent vulnerability scanning, prompt injection detection, and an audit log — all as an independent middleware layer.

---

## What It Does

- **Permission guard** — validates every file/shell/browser action against a declared capability profile
- **Command safety analysis** — pattern-based and semantic analysis of shell commands for dangerous operations
- **Tool rate limiter** — caps tool calls per minute to prevent runaway loops
- **Agent scanner** — static analysis of agent definitions for injection patterns and data exfiltration risks
- **Prompt injection detector** — scans tool results for embedded instructions targeting the AI
- **Audit log** — persistent log of all security events (allowed, denied, suspicious)
- **Redactor** — removes PII and secrets from content before it reaches the AI model

---

## API

### Check permission for an action

```
POST /api/security/check
Content-Type: application/json

{
  "action": "file_write",
  "resource": "/home/user/projects/myapp/src/auth.js",
  "capabilities": {
    "fileWrite": ["src/**"],
    "shell": false,
    "browser": false
  }
}
→ { "allowed": true, "reason": null }
```

or denied:

```json
{ "allowed": false, "reason": "Path 'src/auth.js' is outside fileWrite allow-list" }
```

### Analyse a shell command

```
POST /api/security/analyse-command
{ "command": "rm -rf /tmp/build && npm run deploy" }
→ {
    "safe": false,
    "risk": "high",
    "patterns": [{ "pattern": "rm -rf", "severity": "high", "description": "Recursive forced delete" }],
    "recommendation": "Avoid rm -rf with absolute paths outside the project directory"
  }
```

### Check tool rate limit

```
POST /api/security/rate-limit/check
{ "toolName": "fauna_shell_exec", "sessionId": "conv-uuid" }
→ { "allowed": true, "callsThisMinute": 12, "limit": 30 }
```

### Scan an agent definition

```
POST /api/security/scan-agent
{ "agent": { ...agentManifest } }
→ {
    "safe": false,
    "issues": [
      { "severity": "high", "field": "systemPrompt", "pattern": "ignore all previous instructions", "description": "Prompt injection attempt" },
      { "severity": "medium", "field": "tools", "pattern": "exfil", "description": "Tool name suggests data exfiltration" }
    ]
  }
```

### Scan content for prompt injection

```
POST /api/security/scan-content
{ "content": "Tool result from web page...", "source": "browser:example.com" }
→ {
    "injectionDetected": true,
    "redactedContent": "Tool result from web page...\n[SECURITY: Potential prompt injection removed]",
    "patterns": [{ "match": "ignore your previous instructions", "position": 42 }]
  }
```

### Redact sensitive content

```
POST /api/security/redact
{ "content": "My SSN is 123-45-6789 and my API key is sk-abc123..." }
→ { "redacted": "My SSN is [REDACTED-SSN] and my API key is [REDACTED-KEY]", "count": 2 }
```

### Get audit log

```
GET /api/security/audit?from=2026-07-01&action=file_write&outcome=denied&limit=50
→ [{ "timestamp", "action", "resource", "outcome", "reason", "sessionId" }]
```

### Get security summary

```
GET /api/security/summary?period=24h
→ {
    "total": 1204,
    "allowed": 1189,
    "denied": 15,
    "injectionAttempts": 2,
    "topDeniedActions": [...]
  }
```

---

## Configuration

```js
import { createSecurityService } from '@fauna-services/security'

const svc = await createSecurityService({
  port: 4028,
  auditLogPath: '~/.myapp/security-audit.jsonl',
  rateLimits: {
    default: { callsPerMinute: 30 },
    fauna_shell_exec: { callsPerMinute: 10 },
    fauna_browse_web: { callsPerMinute: 20 }
  },
  redactPatterns: [
    { name: 'SSN', pattern: /\d{3}-\d{2}-\d{4}/g },
    { name: 'API_KEY', pattern: /sk-[a-zA-Z0-9]{20,}/g },
    { name: 'IP_INTERNAL', pattern: /10\.\d+\.\d+\.\d+|192\.168\.\d+\.\d+/g }
  ],
  injectionPatterns: [
    'ignore.*previous.*instructions',
    'disregard.*system.*prompt',
    'you are now',
    'new instructions'
  ]
})
```

---

## Dangerous Command Patterns

Built-in pattern database (configurable):

| Pattern | Severity | Description |
|---|---|---|
| `rm -rf /` | critical | Delete filesystem root |
| `:(){ :\|:& };:` | critical | Fork bomb |
| `curl.*\| sh` | high | Remote code execution |
| `rm -rf` | high | Recursive forced delete |
| `sudo` | high | Privilege escalation |
| `chmod 777` | medium | World-writable permissions |
| `> /dev/null 2>&1` | low | Suppresses all output (may hide errors) |
| `eval` | medium | Dynamic code execution |
| `env \| curl` | high | Potential env var exfiltration |

---

## Integration Examples

### Wrap any tool executor with permission checking

```ts
import { SecurityClient } from '@fauna-services/security/client'
const security = new SecurityClient('http://localhost:4028')

async function executeTool(toolName, args, capabilities) {
  // Check permission before executing
  const { allowed, reason } = await security.check({
    action: toolName,
    resource: args.path || args.command,
    capabilities
  })
  if (!allowed) throw new Error(`Permission denied: ${reason}`)

  // Execute the tool
  const result = await doExecute(toolName, args)

  // Scan result for injection
  const { redactedContent, injectionDetected } = await security.scanContent({
    content: result,
    source: toolName
  })
  if (injectionDetected) log.warn('Prompt injection detected in tool result')

  return redactedContent
}
```

---

## Storage

- `security-audit.jsonl` — append-only audit log (one JSON event per line)
- `rate-limit.db` — SQLite; in-memory sliding window rate limit counters

---

## Dependencies

- `better-sqlite3` — rate limit store
- Custom pattern engine — command safety analysis
