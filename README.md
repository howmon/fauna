# Fauna — AI Desktop Assistant

<p align="center">
  <img src="https://raw.githubusercontent.com/howmon/fauna/main/assets/icon.png" alt="Fauna" width="128" height="128">
</p>

A cross-platform Electron app. Streaming AI with real shell execution, browser control, Figma integration, file editing, and a full agent system.

**macOS** (Apple Silicon & Intel) · **Windows** (x64 & ARM64)

---

## Features

**AI & Models**
- Streaming responses from GitHub Copilot, OpenAI, Anthropic, and Google
- Bring your own API keys — models fetched live from each provider's API
- Switch models mid-conversation; per-conversation system prompts and thinking budget controls

**Shell Execution**
- Runs `bash`, `python3`, `node`, `swift`, `osascript`, PowerShell
- Auto-run mode (no click needed) + auto-feed (output piped back to AI automatically)
- Screenshot capture — images auto-attach to next AI turn

**Interactive Browser**
- Built-in browser pane with multi-tab support per conversation
- AI controls it: navigate, type, click, extract, eval, ask-user
- Headless mode with stealth anti-bot detection (uses your real Edge profile)

**File Editing**
- `replace-string` — surgical find/replace
- `apply-patch` — multi-file unified diffs
- `write-file` / `stream-write` — new files or large rewrites
- Auto-recovery checkpoints before every write

**Figma**
- Dev Mode MCP (port 3845) — reads context, writes via `figma_execute` Plugin API
- Design spec generation — full A11y component specs using design system components
- Legacy WebSocket relay plugin also supported

**Agents**
- Builder wizard (7 steps) — name, system prompt, permissions, custom tools, test cases, security scan, publish
- AI-generated agents from a natural-language description
- Self-modifying — AI can patch agents mid-conversation; changes require user review
- Learnings journal — successful strategies recorded and injected into future sessions

**Agent Store**
- Browse, install, publish community agents
- Security scan required (score ≥ 80) to publish
- Auto-update with version history and rollback

**Multi-Agent Orchestration**
- Parallel: `@a + @b [parallel] message` — all agents run concurrently
- Sequential: `@a + @b message` — output chains agent to agent
- Delegation: orchestrator agent delegates via `[DELEGATE:name]` blocks

**Agent Security**
- File access restricted to declared paths (`.ssh`, `.aws` always blocked)
- Shell commands filtered against dangerous patterns
- Custom tools run in isolated VM — no `process`, `require`, or `fs`
- 300s timeout, 5MB output cap, 5 concurrent tools

**Other**
- Artifact pane — HTML, Markdown, JSON, CSV, charts, 30-day retention
- Generative UI — 18 reactive inline components rendered in chat
- Projects — group conversations, artifacts, and file contexts
- Playbook — learned instructions injected into future sessions
- Smart context summarization — auto-compresses history at 30k chars
- Multi-conversation with DOM isolation — background tasks keep running

---

## How It Works

```
User message
  → AI responds with tool blocks
      bash / browser-action / write-file / figma_execute / artifact:TYPE
  → Tools auto-execute (shell auto-runs, output fed back)
  → AI continues loop (up to 25 tool calls/turn) until task complete
  → Background conversations keep running when you switch away
```

```
[Fauna — port 3737]
  ├── /api/chat          streaming AI + agentic tool loop
  ├── /api/shell-exec    bash / PowerShell execution
  ├── /api/browse        headless browser (stealth)
  ├── /api/write-file    atomic file writes
  ├── /api/agents        agent CRUD, scan, learnings
  ├── /api/store         browse, install, publish
  ├── GET :3845/mcp      Figma Dev Mode MCP
  └── WS  :3335          Figma relay plugin
```

---

## Setup

**Prerequisites:** Node.js 18+ · GitHub Copilot subscription or API key (OpenAI / Anthropic / Google)

```bash
git clone https://github.com/howmon/FaunaApp.git
cd FaunaApp
npm install
npm start        # dev
npm run dist     # build
```

**Auth:** Settings → Authentication → paste a GitHub PAT or API key.  
**Figma:** Figma Desktop → Preferences → Enable Dev Mode MCP Server → toggle 🔷 MCP in toolbar.

### Fauna standalone updates

The desktop app can check `https://github.com/howmon/fauna` main for updates from Help → Check for Fauna Updates or Settings → About → App Updates. Build & Install downloads the main branch zip, extracts it into Fauna app data, runs `npm install`, builds the platform package, and launches the installer/relauncher on macOS or Windows.

### FaunaMCP standalone

Fauna can use the standalone [FaunaMCP app](https://github.com/howmon/faunaMCP) for shared browser and Figma MCP tooling. Start FaunaMCP first, then Fauna will auto-detect `http://localhost:3341/mcp` for browser MCP tools and `ws://localhost:3335` for the Figma plugin relay. When those are present, Fauna reuses the standalone app instead of starting duplicate bundled relay processes. You can get the source directly from [howmon/faunaMCP](https://github.com/howmon/faunaMCP), download the current main branch as a zip with [faunaMCP main.zip](https://github.com/howmon/faunaMCP/archive/refs/heads/main.zip), or use Settings → Browser use → FaunaMCP App → Build & Install to let Fauna download, compile, and install the standalone app when needed. The in-app installer supports macOS and Windows builds; Windows uses PowerShell extraction, `npm.cmd`, and the generated NSIS installer.

### CLI (no Electron)

```bash
npm install -g @eichho/fauna
fauna                          # interactive REPL
fauna --server                 # server only
fauna -q "summarize this repo" # one-shot
echo "explain this" | fauna    # pipe mode
```

Inside the REPL: `/store` searches Agent Store, `/store show <slug>` previews an agent, `/store install <slug>` installs it, `/projects` manages project context, and `/mcps` checks MCP/browser bridge status.

---

## Roadmap

- [ ] Linux builds (AppImage / Snap)
- [ ] Agent analytics — usage, token costs, success rates
- [ ] Conversation branching
- [ ] Voice input/output
- [ ] Local model support (Ollama, llama.cpp)
- [ ] Plugin system beyond agents
- [ ] MCP server marketplace
- [ ] Mobile companion app
- [ ] Workflow recorder and replay

---

## License

MIT — [Solomon Abey](https://github.com/howmon)
