# @fauna-services/auth-gateway

Multi-provider AI authentication and model routing gateway. Manages credentials for multiple AI providers, handles token refresh, routes requests to the right provider, and exposes a unified model catalogue.

---

## What It Does

- **Provider management** — store and validate API keys for OpenAI, Anthropic, Google, and custom OpenAI-compatible endpoints
- **GitHub Copilot auth chain** — PKCE OAuth flow → device code → token caching → auto-refresh
- **Unified model catalogue** — aggregates available models across all configured providers
- **Model routing** — transparent proxying; caller specifies a model ID, gateway routes to the correct provider
- **Fallback chain** — if a model is unavailable, automatically fall back to the next in a configured list
- **Usage tracking** — logs token consumption per provider, per model, per caller

---

## API

### List available models

```
GET /api/models
→ [{ id, name, provider, contextWindow, supportsTools, supportsVision, supportsThinking }]
```

### Get provider status

```
GET /api/providers
→ [{ name, status: 'connected'|'error'|'unconfigured', models: [...] }]
```

### Add / update provider key

```
PUT /api/providers/:name
{ "apiKey": "sk-..." }
```

### Remove provider

```
DELETE /api/providers/:name
```

### GitHub Copilot: start OAuth flow

```
POST /api/auth/copilot/login
→ { "deviceCode": "...", "verificationUri": "https://github.com/login/device", "userCode": "ABCD-1234" }
```

### GitHub Copilot: poll for token

```
POST /api/auth/copilot/poll
{ "deviceCode": "..." }
→ { "status": "pending" | "authorized", "token": "..." }
```

### Validate current credentials

```
POST /api/auth/validate
→ { "providers": [{ "name": "copilot", "valid": true, "expiresAt": "..." }] }
```

### Proxy a chat completion (unified API)

```
POST /api/proxy/chat
Content-Type: application/json

{
  "model": "claude-sonnet-4-5",
  "messages": [...],
  "stream": true,
  "tools": [...]
}
→ OpenAI-compatible SSE stream
```

The gateway transparently routes `claude-*` to Anthropic (or Copilot), `gpt-*` to OpenAI, `gemini-*` to Google.

### Get token usage stats

```
GET /api/usage?period=day|week|month&provider=openai
```

---

## Configuration

```js
import { createAuthGateway } from '@fauna-services/auth-gateway'

const gw = await createAuthGateway({
  port: 4014,
  credentialsFile: '~/.myapp/credentials.json',
  fallbackModels: ['gpt-4.1', 'claude-sonnet-4-5', 'gpt-4o-mini'],
  usageTracking: true,
  providers: {
    openai: { apiKey: process.env.OPENAI_KEY },
    copilot: {} // populated via OAuth flow
  }
})
```

---

## Integration Examples

### Any OpenAI-SDK-compatible client (zero code change)

```ts
import OpenAI from 'openai'

// Point any OpenAI SDK at the gateway — it handles routing
const client = new OpenAI({
  baseURL: 'http://localhost:4014/api/proxy',
  apiKey: 'gateway' // placeholder — gateway uses stored credentials
})

const response = await client.chat.completions.create({
  model: 'claude-sonnet-4-5', // gateway routes this to Anthropic/Copilot
  messages: [{ role: 'user', content: 'Hello' }]
})
```

### CLI tool: authenticate once, use everywhere

```bash
fauna-auth login --provider copilot
# Opens browser for GitHub OAuth
# Token cached in ~/.myapp/credentials.json
# All subsequent fauna-* CLI tools pick it up automatically
```

---

## Security

- API keys stored using OS keychain (`safeStorage`) — never written as plaintext
- Credentials file contains references only, not raw keys
- Token refresh handled transparently; expired tokens never reach the caller
- Usage logs contain only model IDs and token counts — no message content

---

## Storage

- `credentials.json` — encrypted key references (not raw keys)
- `usage.db` — SQLite; tables: `usage_events`, `daily_totals`

---

## Dependencies

- `keytar` / Electron `safeStorage` — secure credential storage
- `node-fetch` / `undici` — HTTP proxy
- `eventsource-parser` — SSE stream forwarding
