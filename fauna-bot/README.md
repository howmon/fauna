# Fauna Teams Bot

A Microsoft Teams bot for [Fauna](https://github.com/howmon/fauna) — your AI desktop assistant, accessible from anywhere.

Chat with Fauna's AI, run shell commands, control the browser, manage agents and tasks, and more — all from Teams on your phone, tablet, or desktop.

---

## What it does

| Command | Description |
|---|---|
| _(any message)_ | Chat with Fauna AI (full model selection) |
| `/help` | Show all commands |
| `/status` | Check desktop connection |
| `/shell <cmd>` | Run a shell command on your desktop |
| `/browse <url>` | Navigate in Fauna's browser |
| `/screenshot` | Capture your desktop screen |
| `/agents` | List installed Fauna agents |
| `/task <desc>` | Create a background task |
| `/search <query>` | Web search via Fauna |
| `/models` | List available AI models |
| `/playbook` | View your playbook instructions |
| `/pair` | Get a QR code to pair with desktop |

All responses use rich **Adaptive Cards** (Teams web, mobile, desktop).

---

## Architecture

```
Teams Client
    │  Bot Framework (HTTPS)
    ▼
fauna-bot/server/index.js  (this bot, port 3978)
    │
    │  WebSocket /api/teams-relay
    ▼
Fauna Desktop App (port 3737)
    │
    ├── AI chat (Copilot / OpenAI / Anthropic / Google)
    ├── Shell execution
    ├── Browser control
    └── Agents / Tasks / Playbook
```

### Shared gateway mode

If you want users to install a generated Teams zip without entering their own Azure Bot App ID and client secret, use the PHP gateway in `php-gateway/` on `bot.pointlabel.com`.

Important: Teams does **not** route to a URL inside the sideloaded zip. Teams routes to the messaging endpoint configured on the Azure Bot registration for the manifest's `botId`. The gateway pattern is therefore:

```
Teams → Azure Bot endpoint https://bot.pointlabel.com/api/messages
    → gateway route lookup
    → https://<user-subdomain>.loca.lt/api/messages
```

In this mode the Microsoft app password stays only on `bot.pointlabel.com`. Fauna generates a temporary local tunnel and a separate `FAUNA_GATEWAY_SECRET`, registers that route with the PHP gateway, and starts the local bot with `FAUNA_GATEWAY_MODE=1`.

---

## Setup

### 1. Prerequisites

- Node.js 18+
- [Fauna desktop app](https://github.com/howmon/fauna) running
- Azure subscription (free tier works)
- Microsoft Teams

### 2. Create an Azure Bot

1. Go to [Azure Portal](https://portal.azure.com) → **Create a resource** → **Azure Bot**
2. Fill in:
   - **Bot handle**: `fauna-bot` (or any name)
   - **Subscription / Resource Group**: your choice
   - **Pricing tier**: F0 (free)
   - **Microsoft App ID**: choose *Create new Microsoft App ID*
3. After creation, go to the bot's **Configuration** blade:
   - Copy the **Microsoft App ID**
   - Click **Manage Password** → **Certificates & secrets** → **New client secret** → copy the value
4. Set the **Messaging endpoint** after you have a public URL (see step 4)

### 3. Install and configure

```bash
cd fauna-bot
cp .env.example .env
# Edit .env with your values
npm install
```

### 4. Expose a public URL (local dev)

Use [ngrok](https://ngrok.com/) to tunnel the bot to the internet:

```bash
ngrok http 3978
# Copy the https URL: e.g. https://abc123.ngrok-free.app
```

Update in **Azure Portal → Azure Bot → Configuration**:
```
Messaging endpoint: https://abc123.ngrok-free.app/api/messages
```

Also set `BOT_DOMAIN=abc123.ngrok-free.app` in your `.env`.

### 5. Start the bot

```bash
npm start
# or: npm run dev (auto-restart on file changes)
```

Check the health endpoint:
```bash
curl http://localhost:3978/health
```

### 6. Configure Fauna Desktop

The bot server connects to Fauna desktop over WebSocket at `ws://localhost:3737/api/teams-relay`.

In **Fauna desktop → Settings → Teams Bot**:
- Enable the Teams relay endpoint
- Set the same `FAUNA_SECRET` value you put in `.env`

### 7. Sideload to Teams

1. Build the app package:
   ```bash
   # From the fauna-bot/ directory
   # Replace {{MICROSOFT_APP_ID}} and {{BOT_DOMAIN}} in manifest.json first
   sed -i '' "s/{{MICROSOFT_APP_ID}}/$MICROSOFT_APP_ID/g" manifest.json
   sed -i '' "s/{{BOT_DOMAIN}}/$BOT_DOMAIN/g" manifest.json
   zip -j fauna-teams-bot.zip manifest.json color.png outline.png
   ```
2. In Teams → **Apps** → **Manage your apps** → **Upload an app** → choose `fauna-teams-bot.zip`
3. Install it and open the chat with **Fauna**

### 8. Production deployment (Azure App Service)

```bash
# From fauna-bot/
az webapp up --name fauna-teams-bot --runtime "NODE:20-lts" --sku F1
az webapp config appsettings set --name fauna-teams-bot \
  --settings MicrosoftAppId=$APP_ID MicrosoftAppPassword=$APP_PW \
             BOT_DOMAIN=fauna-teams-bot.azurewebsites.net \
             FAUNA_WS_URL=wss://your-fauna-relay.example.com/api/teams-relay \
             FAUNA_SECRET=$SECRET
```

---

## Development

```bash
npm run dev     # node --watch (auto-restart)
```

Useful endpoints:
- `GET /health` — liveness probe (relay status, uptime)
- `GET /pair`   — QR code pairing page
- `POST /api/messages` — Bot Framework messages (Teams only)

---

## Environment variables

| Variable | Required | Default | Description |
|---|---|---|---|
| `MicrosoftAppId` | ✅ | — | Azure Bot App ID |
| `MicrosoftAppPassword` | ✅ | — | Azure Bot client secret |
| `BOT_DOMAIN` | ✅ | `localhost:3978` | Public hostname of this bot |
| `FAUNA_WS_URL` | — | `ws://localhost:3737/api/teams-relay` | Fauna desktop WS URL |
| `FAUNA_SECRET` | — | _(empty)_ | Shared auth secret |
| `PORT` | — | `3978` | Server port |

---

## License

MIT — [Solomon Abey](https://github.com/howmon)
