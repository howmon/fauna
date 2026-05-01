# Fauna — AI Desktop Assistant

<p align="center">
  <img src="https://raw.githubusercontent.com/howmon/fauna/main/assets/icon.png" alt="Fauna" width="128" height="128">
</p>

A cross-platform Electron app that gives you a full AI-powered desktop assistant — streaming GitHub Copilot responses with real shell execution, interactive web browsing, Figma design integration, file editing, artifact previews, design spec generation, and smart context management.

Works on **macOS** (Apple Silicon & Intel) and **Windows** (x64 & ARM64).

---

## Features

### 🤖 AI Streaming & Multi-Provider
- Real-time token streaming with models from **GitHub Copilot**, **OpenAI**, **Anthropic**, and **Google**
- **Bring your own API keys** — add keys for OpenAI, Anthropic, or Google to use their models directly without a Copilot subscription
- **Dynamic model discovery** — when API keys are configured, available models are fetched live from each provider's API
- Models grouped by provider in the toolbar dropdown (GitHub CLI, OpenAI, Anthropic, Google)
- Switch models mid-conversation from the toolbar
- Per-conversation system prompts
- Auto-title generation for new conversations
- Thinking/reasoning budget controls (low, medium, high, max)

### 🖥️ Shell Execution
- AI can run real shell commands — `bash`, `python3`, `node`, `swift`, `osascript` (macOS), PowerShell (Windows)
- **Auto-run mode** — commands execute immediately without clicking Run
- **Auto-feed** — shell output is automatically fed back to the AI to continue multi-step tasks
- Inline-first execution: prefers `python3 -c`, `node -e`, `bash -c` over temp files
- Screenshot capture — images auto-attach to the next AI turn
- Full system access: open apps, control windows, manage files, install packages

### 🌐 Interactive Browser Panel
- Built-in browser pane (right side) with multi-tab support per conversation
- AI controls the browser via `browser-action` blocks: navigate, type, click, extract, eval, ask-user
- Form filling and registration flows with safe password handling (user types passwords directly)
- URL bar, back/forward navigation, loading indicator
- Anti-bot detection banner for protected sites

### 🌐 Headless Web Browsing
- JS-rendered page extraction using a headless browser (Microsoft Edge / Chrome)
- Anti-bot stealth mode — uses your real Edge profile for trusted session cookies
- Homepage warm-up before deep-linking to bot-protected sites
- Actions: `extract` (page → markdown), `screenshot`, `click`, `eval` (run JS on page)

### 🎨 Figma Integration
Two modes:

**MCP Mode** (recommended):
- Connects to Figma's built-in Dev Mode MCP server (port 3845)
- Reads design context, variables, metadata, screenshots
- Writes designs via `figma_execute` — runs Plugin API JS directly inside Figma
- Toggle with the 🔷 badge in the toolbar
- **Design spec generation** — creates full A11y component specs in Figma using design system components (GuidanceHeader, GuidanceTextBlock, BestPractice blocks) with proper tokens and fonts

**MCP Tools** (from Figma Dev Mode MCP on port 3845 + custom):

| Tool | Description |
|------|-------------|
| `figma_execute` | Execute Plugin API JavaScript directly inside Figma — create, modify, delete nodes (custom, always available) |
| `get_design_context` | Read current Figma state — node tree, component keys, text content, styles, layout |
| `get_metadata` | Lightweight XML overview of node IDs, layer types, names, positions, and sizes |
| `get_screenshot` | Capture a screenshot of a node or the current selection |
| `get_variable_defs` | Get design token / variable definitions (colors, spacing, fonts) for a node |
| `get_code_connect_map` | Get Code Connect mappings — which Figma nodes map to which code components |
| `add_code_connect_map` | Map a Figma node to a code component in your codebase |
| `get_figjam` | Read FigJam board content (FigJam files only) |
| `get_strategy_for_mapping` | Get a strategy for linking Figma nodes to code components |
| `send_get_strategy_response` | Submit Code Connect mapping results back to Figma |
| `create_design_system_rules` | Generate design system rules for the current repo |

**Plugin Mode** (legacy):
- WebSocket relay (port 3335) → Figma plugin → `eval()` in plugin sandbox
- Use when Dev Mode MCP is unavailable

### ✏️ File Editing
Four file editing tools, each optimized for different scenarios:
- **`replace-string`** — preferred for surgical edits to existing files (SEARCH/REPLACE blocks)
- **`apply-patch`** — multi-file edits, renames, or deletes (unified diff format)
- **`write-file`** — new files or complete rewrites (with `append-file` for large files)
- **`stream-write`** — very large files or binary content via streaming API
- Auto-recovery checkpoints for every write operation

### 🤖 Agent System

#### Agent Builder (7-step wizard)
Create custom AI agents with specific roles, permissions, and tools:

1. **Basic Info** — name, display name, description, category, icon
2. **System Prompt** — instructions with token counter and live testing
3. **Permissions** — granular toggle for shell, browser, Figma, file read/write paths, network domains, and MCP servers
4. **Custom Tools** — add JavaScript tools that run in a secure VM sandbox
5. **Test Cases** — input/output pairs for validation
6. **Security Scan** — automated vulnerability analysis before save
7. **Review** — summary with Save, Export, or Publish to Store

Agents can also be **AI-generated** from a natural-language description — the builder produces a complete config including system prompt, permissions, tools, and test cases.

**Built-in agents:**

| Agent | Role | Key Permissions |
|-------|------|-----------------|
| Research Agent | Web research and synthesis | browser, file write, network |
| Coding Agent | Code generation and shell tasks | shell, full file access |
| Writing Agent | Document creation and editing | browser, documents access, network |
| Design Agent | Figma design and prototyping | browser, Figma MCP, network |

#### Agent Patching
The AI can self-modify agents mid-conversation using `patch-agent` blocks — updating the system prompt, permissions, or tools. Changes open in the Agent Builder for user review before saving. An `uninstall-agent` block is also supported for removal with confirmation.

Agents also maintain a **learnings journal** — successful strategies are automatically recorded and injected into future sessions, so agents improve over time.

#### Agent Store
Browse, install, and publish agents through the built-in store:

- **Browse** community agents by category with search
- **Install** agents from the store (downloaded as zip, extracted locally)
- **Publish** your agents for others — requires a security scan score ≥ 80
- **Auto-update** — checks for new versions on startup and every 30 minutes
- **Version history** with rollback support
- **Review queue** for store admins to approve/reject submissions

#### Sub-Agents & Orchestration
Enable **orchestrator mode** to create agents that delegate tasks to sub-agents. Each sub-agent has its own system prompt, tools, and role. A **shared prompt** is automatically appended to all sub-agents for consistent context.

**Orchestration types:**

| Mode | Syntax | Behavior |
|------|--------|----------|
| **Orchestrator Delegation** | Set `orchestrator: true` on the agent | Parent agent delegates via `[DELEGATE:agent-name]` blocks; sub-agents signal `[TASK_COMPLETE]`, `[TASK_PARTIAL]`, `[TASK_BLOCKED]`, or `[TASK_FAILED]` |
| **Parallel Composition** | `@agent1 + @agent2 [parallel] message` | All agents run concurrently with the same input; results merged |
| **Sequential Composition** | `@agent1 + @agent2 message` | Agents run one after another; each receives prior agent's output as context |
| **Multi-Chip** | Add 2+ agent chips to the input bar | Mode picker appears: Parallel, Sequential, or Single — with per-agent result cards and durations |

#### Agent Security

**Sandbox** — every agent operation passes through server-side enforcement:
- File access restricted to declared paths (sensitive dirs like `~/.ssh`, `~/.aws` always blocked)
- Shell commands filtered against dangerous patterns (credential reads, encoded exfil, etc.)
- Network requests validated against allowed domains
- Custom tools run in an isolated VM with no access to `process`, `require`, or `fs`
- Resource limits: 300s timeout, 5MB output cap, 5 concurrent tools

**Scanner** — static analysis for agent code before install or publish:
- Checks for env access, network exfil, file traversal, code injection, credential access, obfuscation
- Severity levels: critical (25pts), high (15pts), medium (10pts), low (5pts)
- Score out of 100 — minimum 80 required for store publication

### 📋 Artifact Pane
- Slide-in preview pane for rich output — triggered by the AI automatically
- **Types**: HTML (interactive), Markdown, JSON, CSV, Images, SVG, Files list, Summary, Code
- Entity cards appear inline in the chat — click to open in the pane
- Resizable pane (drag handle)
- **30-day retention** — artifacts persist per-conversation for 30 days; closing the pane just hides it, nothing is lost
- Artifacts restore when you switch back to a conversation
- Charts/dashboards via Chart.js CDN in HTML artifacts
- Save any artifact to a project with one click

### ✨ Generative UI (inline widgets)
- AI can render interactive UI components **inline in the chat** using `gen-ui` code blocks — no pane required
- 18 components: `Card`, `Stack`, `Grid`, `Heading`, `Text`, `Badge`, `Stat`, `Alert`, `Button`, `Divider`, `KeyValue`, `Table`, `List`, `Progress`, `Code`, `Image`, `Select`, `Input`, `Tabs`
- **Reactive state** — components can read and write shared state; buttons can toggle visibility, copy text, set values, or open URLs
- **Smart routing** — the AI decides automatically:
  - **gen-ui** for ephemeral snapshots: dashboards, metric cards, status overviews, comparison tables
  - **Artifact pane** for saveable output: full HTML pages, documents, code files (>40 lines)
  - **Plain Markdown** for conversational prose
- Each widget has an **Add to Project** footer button (fades in on hover)

### 🗂️ Projects
- Group conversations, artifacts, and file contexts under named **Projects**
- **Project Hub** — dedicated panel with tabs for files, contexts, sources, conversations, and design settings
- Contexts (docs, code snippets, gen-ui specs) are injected into the AI's system prompt while the project is active
- **Move to Project** — assign any conversation to a project from the `⋯` topbar menu
- **Add to Project** — save any gen-ui widget or artifact directly into a project's context library
- Sources: link local folders or GitHub/GitLab repos; sync to keep them fresh
- Color-coded project switcher in the topbar pill

### 📓 Playbook — Learned Instructions
- AI saves successful strategies and approaches as playbook entries
- Entries are injected into the system prompt for future tasks
- View, edit, and manage entries via the Playbook panel in the sidebar
- Prevents repeated mistakes and builds institutional knowledge over sessions

### 🗂️ Desktop Organizer
- Smart file categorization when asked to organize desktop/files
- Dry-run preview before executing (shows planned moves by folder)
- One-click "Organise Now" or detailed file preview

### 💭 Chain of Thought
- Shell commands and code generation steps are collapsed into a COT component
- Shows a summary of what the AI is doing — expand to see full details
- Keeps chat clean during multi-step agentic tasks

### 🗂️ Multi-Conversation
- Unlimited concurrent conversations — each runs independently
- **Tab-based DOM isolation** — switching conversations never interrupts background work
  - Shell commands keep running in the background
  - Auto-feed chains continue even when you start a new conversation
  - Streaming spinner in the sidebar shows active background conversations
- Per-conversation model and system prompt settings

### 🧠 Smart Context Management
- **Auto-summarization** — when conversation history exceeds ~30k chars, older messages are automatically summarized into a compact task-state note
- Summary is injected into the system prompt so the AI always knows where it is in a task
- Per-message 6k char cap to prevent shell outputs from bloating history
- 60k char total context budget (char-based sliding window)
- Vision message images stripped from older turns to save tokens

### 🔧 Self-Repair
- The AI can read its own source code, diagnose bugs, patch them, and redeploy — all in one shot
- Auto-recovery system backs up files before every edit

### 🔐 Permissions (macOS)
The app requests and uses:
- **Full Disk Access** — read/write any file
- **Screen Recording** — screenshots, screen capture
- **Accessibility** — mouse control, UI automation, keyboard input
- **Automation** — AppleScript, app control

---

## Project Structure

```
fauna/
├── main.js                  # Electron main process
├── server.js                # Express server — multi-provider AI, shell exec, browse, Figma MCP
├── agent-sandbox.js         # Server-side security enforcement for agent operations
├── agent-scanner.js         # Static vulnerability analysis for agent code
├── agent-tools.js           # Built-in agent tools (shell, file, fetch) with permission checks
├── package.json
├── public/
│   ├── index.html           # SPA shell — loads modular JS/CSS
│   ├── css/
│   │   └── styles.css       # All styles
│   ├── img/
│   └── js/
│       ├── app.js           # Boot, keyboard shortcuts, drag-drop
│       ├── state.js         # Global state management
│       ├── chat.js          # Message sending, streaming, context gathering
│       ├── conversations.js # Multi-conversation CRUD, persistence
│       ├── ui.js            # Settings, onboarding, system panel, organizer
│       ├── capabilities.js  # Dynamic system prompt generation
│       ├── shell.js         # Shell execution widgets, auto-run, auto-feed
│       ├── browser.js       # Interactive browser pane, tabs, resize
│       ├── figma.js         # Figma MCP/plugin connection, status
│       ├── artifacts.js     # Artifact pane, entity cards, preview rendering, 30-day retention
│       ├── gen-ui.js        # Generative UI renderer — 18 components, reactive state, smart routing
│       ├── markdown.js      # Markdown → HTML with code block handling
│       ├── writefile.js     # File write/replace/patch execution
│       ├── playbook.js      # Learned instructions CRUD
│       ├── smart-features.js# Context-aware suggestions and smart completions
│       ├── agents.js        # Agent activation, chip UI, delegation parsing
│       ├── agent-builder.js # 7-step agent creation wizard
│       ├── agent-store.js   # Store browse, install, publish, update
│       ├── agent-polish.js  # Auto-update checks, composition parsing
│       ├── projects.js      # Projects UI — hub panel, switcher, contexts, sources, gen-ui save
│       └── agent-system.js  # Built-in agents, orchestrator prompt injection
├── assets/
│   ├── figma-plugin/        # Bundled Figma plugin (assets/figma-plugin/)
│   │   ├── manifest.json
│   │   ├── code.js          # Plugin sandbox — executes figma_execute
│   │   └── ui.html          # Plugin panel — WebSocket relay + log
│   ├── entitlements.mac.plist
│   ├── icon.icns
│   ├── icon.png
│   └── logo.svg
├── relay/                   # Standalone Figma plugin + WebSocket relay server
│   ├── server/
│   │   ├── index.js         # WebSocket relay server (port 3335) + MCP tools
│   │   ├── index-tokens.js  # Design token indexer
│   │   └── systems.json     # Registered design system configurations
│   ├── manifest.json        # Figma plugin manifest
│   ├── code.js              # Plugin sandbox code
│   ├── ui.html              # Plugin panel UI
│   └── package.json
├── CODE_OF_CONDUCT.md
├── CONTRIBUTING.md
├── LICENSE
└── SECURITY.md
```

---

## How It Works

```
[Fauna app — port 3737]
      │
      ├── /api/chat          → multi-provider AI (SSE streaming + agentic tool loop)
      ├── /api/models        → dynamic model list (Copilot API + live provider queries)
      ├── /api/auth          → auth status (GitHub token + direct provider keys)
      ├── /api/shell-exec    → executes shell commands (bash/PowerShell)
      ├── /api/browse        → headless browser (Edge/Chrome + stealth)
      ├── /api/write-file    → atomic file writes with auto-recovery
      ├── /api/summarize     → background context compression
      ├── /api/organize-desktop → desktop file categorization
      ├── /api/agents          → agent CRUD, scan, learnings, sub-agents
      ├── /api/store           → agent store browse, install, publish
      ├── /api/providers       → direct API key management (OpenAI, Anthropic, Google)
      │
      ├── GET  http://127.0.0.1:3845/mcp   → Figma Dev Mode MCP (read/write)
      │
      └── WS   ws://localhost:3335         → FaunaMCP relay
                    └── Figma Plugin → figma sandbox → Plugin API
```

### Agentic Loop
1. User sends a message
2. AI responds — can include `bash` blocks (shell), `browser-action` blocks (browser panel), `artifact:TYPE` blocks (preview pane), `write-file`/`replace-string`/`apply-patch` blocks (file editing), or Figma MCP tool calls
3. Shell blocks auto-run; output is fed back to the AI
4. Tool calls (up to 25 per turn) execute and return results to the AI
5. AI continues until the task is complete
6. Background conversations keep running when you switch to a new one

---

## Setup

### Prerequisites

- **macOS** 12+ (Apple Silicon or Intel) or **Windows** 10+
- Node.js 18+
- **One of**: [GitHub Copilot](https://github.com/features/copilot) subscription **or** an API key from OpenAI, Anthropic, or Google
- [Microsoft Edge](https://www.microsoft.com/edge) (for web browsing — optional)
- [Figma Desktop](https://www.figma.com/downloads/) (for Figma integration — optional)

### Install

```bash
git clone https://github.com/howmon/FaunaApp.git
cd FaunaApp
npm install
npm start          # development
npm run dist       # build distributable
```

### CLI (npm)

Install the CLI globally from npm — no Electron required:

```bash
npm install -g @eichho/fauna
```

Then run it anywhere:

```bash
fauna                          # interactive REPL + server
fauna --server                 # server only (API on port 3737)
fauna -q "summarize this repo" # one-shot query
fauna --port 4000              # custom port
fauna -v                       # verbose (show tool calls & token usage)
echo "explain package.json" | fauna  # pipe mode
```

Requires Node.js 18+ and a [GitHub Copilot](https://github.com/features/copilot) subscription or an API key from OpenAI, Anthropic, or Google.

### Authentication

Open **Settings** (gear icon in the sidebar) → **Authentication** tab:

**GitHub CLI** (default) — uses your existing `gh auth` login. Token resolution order:
1. Saved PAT (set in Settings)
2. `GH_TOKEN` / `GITHUB_TOKEN` environment variable
3. `gh auth token` (active account)
4. macOS Keychain

**API Keys** — bring your own keys for direct provider access:
- **OpenAI** — `sk-…` key → access GPT-4.1, GPT-4o, o-series, and all models on your OpenAI account
- **Anthropic** — `sk-ant-…` key → access Claude Sonnet, Opus, Haiku families
- **Google AI** — `AIza…` key → access Gemini 2.5, 2.0, 1.5 families

When an API key is configured, available models are **fetched dynamically** from that provider's API — you get every model your key has access to, not just a hardcoded list. Models are grouped by provider in the dropdown.

### Figma Setup (optional)

**Dev Mode MCP** (recommended):
1. Figma Desktop → Preferences → **Enable Dev Mode MCP Server**
2. Toggle the 🔷 **MCP** badge in the app toolbar

**Relay plugin** (legacy):
1. App → Settings → **Reinstall Figma Plugin**
2. Figma → Plugins → Development → Import from manifest → `~/.config/fauna/figma-plugin/manifest.json`

### CLI Mode (headless)

Fauna can run entirely without Electron as a headless CLI — useful for servers, scripting, CI/CD, or terminal-first workflows.

```bash
# Interactive REPL + server
node cli.js

# Server only (API on port 3737, no REPL)
node cli.js --server

# One-shot query
node cli.js -q "summarize this repo"

# Pipe mode
echo "explain package.json" | node cli.js

# Custom port
node cli.js --port 4000

# Verbose (show tool calls & token usage)
node cli.js -v
```

Or use the npm scripts:
```bash
npm run cli          # interactive REPL
npm run serve        # server only
```

**REPL commands:**

| Command | Description |
|---------|-------------|
| `/help` | Show all commands |
| `/model <name>` | Switch model (e.g. `/model gpt-4o`) |
| `/agent <name>` | Switch agent (e.g. `/agent research`) |
| `/agents` | List available agents |
| `/models` | List available models |
| `/attach <path>` | Attach a file to the next message |
| `/tasks` | List all tasks |
| `/task <id>` | Show task detail, result & reasoning |
| `/task create <desc>` | Create a new task |
| `/task run <id>` | Run a task |
| `/task stop <id>` | Stop a running task |
| `/task steer <id> <msg>` | Inject guidance into a running task |
| `/task log <id>` | Show full reasoning chain |
| `/browse <url>` | Fetch & summarize a URL |
| `/shell <cmd>` | Run a shell command |
| `/config` | View config |
| `/config set <k> <v>` | Set a config value |
| `/status` | Server & auth status |
| `/verbose` | Toggle verbose mode |
| `/quit` | Exit |

The CLI shares the same server, API, auth, agents, tasks, browser extension relay, and Figma MCP as the desktop app — just without the Electron window.

---

## Example Prompts

### Shell / System
```
"What's using the most disk space on my Mac?"
"Find all node_modules folders and show their sizes"
"Download the latest release of ffmpeg and convert my screen recording to gif"
"Monitor CPU usage every 2 seconds for 30 seconds and chart it"
```

### Web Browsing
```
"Search Google for the latest macOS release notes and summarize them"
"Get the current Bitcoin price from CoinGecko"
"Scrape the top 10 GitHub trending repos today"
```

### Artifacts
```
"Create a bar chart of my disk usage by folder"
"Generate a markdown report of all running processes"
"Build an HTML dashboard showing system stats"
```

### Figma
```
"Create a threat dashboard with a SideNav, metric row, and alert cards"
"Swap all placeholder cards for Recommendation components"
"Update section titles to match a SOC dashboard theme"
```

---

## Architecture Notes

### Browser anti-detection
- Launches Microsoft Edge with the user's real profile (`~/Library/Application Support/Microsoft Edge/Default`)
- Sends Edge UA string + correct `sec-ch-ua` headers
- Homepage warm-up before navigating to protected deep pages (Akamai cookie seeding)
- `puppeteer-extra` + `puppeteer-extra-plugin-stealth` for JS-level fingerprint patching

### Per-conversation DOM isolation
Each conversation keeps its message elements alive in a hidden `<div>` — never destroyed on switch. This means:
- Shell widgets remain in DOM and can receive results mid-execution
- Auto-feed chains complete even in background conversations
- Switching back restores the full live state instantly

### Context summarization
- Threshold: 30,000 chars of raw history
- Keeps last 6 messages verbatim; summarizes everything older
- Summary is injected under `## Task Context` in the system prompt
- Runs in background after each AI response — zero latency impact

### Token overflow protection
- Max 25 Figma MCP tool calls per turn
- Tool results truncated at 40,000 chars
- Identical tool+args calls deduplicated
- Shell output in history capped at 6,000 chars per message

---

## Roadmap

### Now
- [x] Multi-provider AI (GitHub Copilot, OpenAI, Anthropic, Google)
- [x] Dynamic model discovery from provider APIs
- [x] Agent Builder — 7-step wizard with AI generation
- [x] Agent Store — browse, install, publish, auto-update
- [x] Multi-agent orchestration (parallel, sequential, delegation)
- [x] Agent security sandbox + vulnerability scanner
- [x] Shell execution with auto-run and auto-feed
- [x] Interactive browser panel with multi-tab support
- [x] Figma MCP integration + design spec generation
- [x] Artifact pane (HTML, Markdown, JSON, CSV, charts) with 30-day retention
- [x] Generative UI — inline reactive widgets in chat
- [x] Projects — group conversations, artifacts, and contexts
- [x] Smart artifact vs gen-ui routing (model decides based on content)
- [x] Playbook — learned instructions across sessions

### Next
- [ ] **Linux support** — AppImage / Snap / Flatpak builds
- [ ] **Agent analytics dashboard** — usage stats, token costs, success rates per agent
- [ ] **Agent versioning** — diff between versions, changelog generation
- [ ] **Conversation branching** — fork a conversation to explore alternatives
- [ ] **Voice input/output** — speech-to-text prompts, text-to-speech responses
- [ ] **Local model support** — Ollama, llama.cpp, LM Studio integration
- [ ] **Plugin system** — extend Fauna with community plugins (beyond agents)
- [ ] **Collaborative agents** — shared agent workspaces for teams
- [ ] **MCP server marketplace** — discover and connect to MCP servers

### Later
- [ ] **Mobile companion** — iOS/Android app for monitoring long-running agent tasks
- [ ] **Agent-to-agent communication** — agents can invoke other agents across users
- [ ] **Fine-tuning pipeline** — fine-tune models on your agent's learnings journal
- [ ] **Self-hosted agent store** — deploy a private store for enterprise teams
- [ ] **Workflow recorder** — record multi-step tasks and replay as automated workflows
- [ ] **Multi-user mode** — shared Fauna instance with per-user agent libraries and permissions

---

## License

MIT — [Solomon Abey](https://github.com/howmon) (solomonoabey@gmail.com)

