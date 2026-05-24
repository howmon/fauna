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
- **Local AI models** — run privately on your machine via Ollama, LM Studio, llama.cpp, vLLM, Jan, Text-Gen-WebUI, or any OpenAI-compatible `/v1` endpoint. Auto-discovery on standard ports, per-model capability overrides for tools/vision. Traffic never leaves your computer.
- Switch models mid-conversation; per-conversation system prompts and thinking budget controls

**Shell Execution**
- Runs `bash`, `python3`, `node`, `swift`, `osascript`, PowerShell
- Native `fauna_shell_exec` function tool (Codex-style) — server-side execution inside a single agent turn, no client round-trips, no "want me to continue?" half-stops
- Markdown ```bash blocks supported as a fallback (auto-run / auto-feed) for models without tool-call support
- Streaming stdout/stderr, AbortController-based cancel on the Stop button, screenshot capture auto-attaches to next AI turn

**Interactive Browser**
- Built-in browser pane with multi-tab support per conversation
- Native `fauna_browser` function tool drives navigate / click / type / extract / evaluate / screenshot from inside the agent loop
- Headless mode with stealth anti-bot detection (uses your real Edge profile)

**File Editing**
- Native function tools (preferred): `fauna_read_file`, `fauna_replace_string` (exact unique-match), `fauna_apply_patch` (multi-file unified-diff DSL), `fauna_write_file` / `fauna_write_files` (atomic, with `minLines` / `sha256` guards)
- Markdown fallback when tools are unavailable: `replace-string`, `apply-patch`, `write-file` / `stream-write`, `file-plan`
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

**Automation**
- Workflows — recorded multi-step agent runs, replayable on demand
- Heartbeat — scheduled background conversations (cron-style)
- Task runner — concurrent background tasks with status pane
- Teams Bridge — drive Fauna from a Microsoft Teams chat
- Browser extension — Chrome side panel + CDP screenshot/automation

**Other**
- Artifact pane — HTML, Markdown, JSON, CSV, charts, 30-day retention
- Generative UI — 18 reactive inline components rendered in chat
- Projects — group conversations, artifacts, and file contexts
- Playbook — learned instructions injected into future sessions
- Token-aware auto-compaction. Manual `/compact` slash command, toggle in Settings.
- Multi-conversation with DOM isolation — background tasks keep running

---

## How It Works

```
User message
  → AI streams response with native function tool calls
      fauna_shell_exec / fauna_read_file / fauna_replace_string /
      fauna_apply_patch / fauna_browser / fauna_write_file /
      figma_execute / artifact:TYPE
  → Server executes each tool, pushes role:tool result back into the
      same conversation, re-invokes the model — all in ONE HTTP response
  → Loop continues (up to 50 tool calls/turn) until the model emits a
      tool-free final message. No client round-trips, no half-stops.
  → Markdown tool fences (```bash, ```browser-action, etc.) remain as a
      fallback path for models that don't support function tools.
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

**Prerequisites:** Node.js 18+ · GitHub Copilot subscription, an API key (OpenAI / Anthropic / Google), or a local OpenAI-compatible endpoint (Ollama, LM Studio, llama.cpp, vLLM, …)

```bash
git clone https://github.com/howmon/FaunaApp.git
cd FaunaApp
npm install
npm start        # dev
npm run dist     # build
```

**Auth:** Settings → Authentication → paste a GitHub PAT or API key.  
**Figma:** Figma Desktop → Preferences → Enable Dev Mode MCP Server → toggle 🔷 MCP in toolbar.

### Local AI Models

Fauna can talk to any local OpenAI-compatible endpoint — your tokens, your hardware, no cloud round-trip.

**Setup:** Settings → Authentication → **Local Models** tab.

- **Refresh** auto-discovers Ollama (`localhost:11434/v1`), LM Studio (`localhost:1234/v1`), llama.cpp (`localhost:8080/v1`), vLLM (`localhost:8000/v1`), Jan (`localhost:1337/v1`), and Text-Gen-WebUI (`localhost:5000/v1`).
- Or paste any custom `/v1` URL + optional API key + a default model id, click **Test**, then **Save & Enable**.
- Local models appear in the model picker under the **Local** vendor group with a `· local` suffix. Pick one to route that conversation through your local backend; switch back to Copilot/OpenAI/Anthropic/Google at any time.
- **Capability overrides** — by default Fauna assumes local models don't support OpenAI `tool_calls` or vision. Enable the checkbox for either if your model is known to handle them. When tools are off, Fauna still streams chat normally but the agent loop (shell, browser, file edits) is disabled to avoid hallucinated tool invocations.
- **Disable** reverts to Copilot.

**Quick start with Ollama:**

```bash
brew install ollama
ollama serve &
ollama pull qwen2.5-coder:14b
# In Fauna: Settings → Authentication → Local Models → Refresh → Use → Save & Enable
```

Config persists at `$FAUNA_CONFIG_DIR/local-llm.json` (defaults to `~/.config/copilot-chat/local-llm.json`).

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
- [x] Local model support (Ollama, llama.cpp, LM Studio, vLLM, any OpenAI-compatible `/v1`)
- [ ] Plugin system beyond agents
- [ ] MCP server marketplace
- [ ] Mobile companion app
- [x] Workflow recorder and replay

---

## License

MIT — [Solomon Abey](https://github.com/howmon)
