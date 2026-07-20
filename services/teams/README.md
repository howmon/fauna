# @fauna-services/teams

Enterprise team communication bridge service. Connects AI agents to Microsoft Teams, manages bot lifecycle, handles enterprise SSO authentication, and provides a webhook gateway for integrating any AI workflow with team communication channels.

---

## What It Does

- **Teams bot manager** — registers, starts, and manages a Microsoft Teams bot via Azure Bot Service
- **Message routing** — receives Teams messages, dispatches to an AI agent, posts replies
- **Enterprise SSO** — enterprise GitHub authentication flow for organization members
- **Internal AI caller** — direct internal API endpoint for Teams-triggered AI conversations
- **Webhook gateway** — inbound and outbound webhooks for connecting any system to the AI pipeline
- **Audit trail** — logs all Teams interactions for compliance

---

## API

### Get Teams bot status

```
GET /api/teams/status
→ {
    "botRegistered": true,
    "connected": true,
    "tenantsConnected": ["tenant-uuid"],
    "messageCount24h": 42
  }
```

### Register / configure bot

```
POST /api/teams/bot/configure
{
  "appId": "azure-app-id",
  "appPassword": "azure-app-secret",
  "tenantId": "azure-tenant-id",
  "botName": "My AI Assistant"
}
```

### Start bot

```
POST /api/teams/bot/start
→ { "webhookUrl": "https://myserver.example.com/api/teams/messages" }
```

### Stop bot

```
POST /api/teams/bot/stop
```

### Handle incoming Teams message (Bot Framework webhook)

```
POST /api/teams/messages
Content-Type: application/json
Body: Teams Bot Framework activity payload
→ 200 OK (response sent asynchronously to Teams)
```

### Trigger AI conversation from Teams context

```
POST /api/teams/ai/invoke
{
  "message": "Summarise the sprint status",
  "conversationId": "teams-conv-id",
  "userId": "teams-user-id",
  "projectId": "my-project",
  "model": "claude-sonnet-4-5"
}
→ SSE stream of AI response events
```

### Enterprise SSO: get auth status

```
GET /api/enterprise-auth/status
→ { "authenticated": true, "organization": "myorg", "user": "solomon", "scopes": [...] }
```

### Enterprise SSO: initiate login

```
POST /api/enterprise-auth/login
{ "organization": "myorg" }
→ { "authUrl": "https://github.com/login/oauth/authorize?..." }
```

---

## Webhook Gateway

### Register an inbound webhook

```
POST /api/webhooks/inbound
{
  "name": "PR opened trigger",
  "agentId": "code-reviewer",
  "projectId": "my-project",
  "secret": "webhook-secret-for-hmac-validation"
}
→ { "webhookId": "...", "url": "http://localhost:4031/api/webhooks/in/uuid/token" }
```

### Inbound webhook endpoint (called by external systems)

```
POST /api/webhooks/in/:id/:token
Content-Type: application/json
X-Hub-Signature-256: sha256=...
Body: { "message": "PR #42 was opened by solomon: Add OAuth flow" }
→ 202 Accepted (AI processes asynchronously)
```

### Register an outbound webhook

```
POST /api/webhooks/outbound
{
  "name": "Notify Slack on task completion",
  "trigger": "task_completed",
  "url": "https://hooks.slack.com/services/...",
  "template": { "text": "Task '{{task.name}}' completed by Fauna AI" }
}
```

### List webhooks

```
GET /api/webhooks/inbound
GET /api/webhooks/outbound
```

### Get webhook call log

```
GET /api/webhooks/:id/log?limit=20
→ [{ "timestamp", "payload", "status", "responseCode" }]
```

---

## Configuration

```js
import { createTeamsService } from '@fauna-services/teams'

const svc = await createTeamsService({
  port: 4031,
  teams: {
    appId: process.env.TEAMS_APP_ID,
    appPassword: process.env.TEAMS_APP_PASSWORD,
    tenantId: process.env.TEAMS_TENANT_ID
  },
  enterpriseAuth: {
    githubOrg: 'myorg',
    clientId: process.env.GITHUB_CLIENT_ID,
    clientSecret: process.env.GITHUB_CLIENT_SECRET
  },
  aiGatewayUrl: 'http://localhost:4010',  // @fauna-services/chat-engine
  webhookSigningSecret: process.env.WEBHOOK_SECRET,
  dataDir: '~/.myapp/teams'
})
```

---

## Integration Examples

### Teams bot that answers questions about your codebase

```ts
// The service handles the full bot lifecycle
// Teams message → service → AI → Teams reply

// Configure once:
await teams.configurBot({
  appId, appPassword, tenantId,
  botName: 'CodeHelper'
})
await teams.startBot()
// Bot is now live in Teams
```

### Trigger an AI workflow from an external webhook

```ts
// Register a webhook trigger
const { url } = await teams.registerInboundWebhook({
  name: 'GitHub PR trigger',
  agentId: 'code-reviewer',
  projectId: 'my-app'
})

// Configure GitHub to POST to `url` on PR events
// Fauna AI will automatically review each PR
```

### Outbound notification on AI task completion

```ts
await teams.registerOutboundWebhook({
  trigger: 'task_completed',
  url: 'https://myteams.webhook.office.com/...',
  template: { text: "✅ AI completed: {{task.name}}" }
})
```

---

## Security

- Bot Framework messages validated with HMAC signature verification
- Inbound webhooks validated with HMAC-SHA256 shared secret
- Enterprise tokens stored in OS keychain (never plaintext)
- Webhook payloads sanitised before forwarding to AI (prevents injection via external systems)

---

## Storage

- `teams.db` — SQLite; tables: `bot_config`, `conversations`, `webhooks_inbound`, `webhooks_outbound`, `webhook_log`
- All Teams messages logged for audit purposes

---

## Dependencies

- `botbuilder` — Microsoft Bot Framework SDK
- `@azure/msal-node` — Azure Active Directory auth
- `node-fetch` — outbound webhook delivery
- `crypto` — HMAC webhook signature verification
