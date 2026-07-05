# Fauna — AI Desktop Assistant

<p align="center">
  <img src="https://raw.githubusercontent.com/howmon/fauna/main/assets/icon.png" alt="Fauna" width="128" height="128">
</p>

Streaming AI with real shell, browser, Figma, file editing, voice, video, and a full agent system. **macOS** (Apple Silicon & Intel) · **Windows** (x64 & ARM64).

---

## Features

**Models** — GitHub Copilot, OpenAI, Anthropic, Google. Plus any OpenAI-compatible `/v1` (Ollama, LM Studio, llama.cpp, vLLM, NVIDIA NIM, Groq, Together, Fireworks, DeepInfra, Mistral, DeepSeek, OpenRouter). Switch mid-conversation; per-conversation system prompts and thinking budgets.

**Agent loop** — Native function tools run server-side in one HTTP response (up to 50 calls/turn) with no client round-trips and no "want me to continue?" stops. Markdown fences (```bash, etc.) are kept as a fallback for models without tool calls.

**Shell** — `bash`, `python3`, `node`, `swift`, `osascript`, PowerShell. Streaming stdout/stderr, cancel via Stop, auto-attached screenshots.

**Browser** — Built-in multi-tab pane plus headless `fauna_browser` with stealth (uses your real Edge profile): navigate / click / type / extract / evaluate / screenshot.

**Files** — `fauna_read_file`, `fauna_replace_string` (exact match), `fauna_apply_patch` (multi-file diffs), `fauna_write_file(s)` (atomic, `minLines` / `sha256` guards). Auto-recovery checkpoints.

**Memory & RAG** — Hybrid lexical + semantic recall over remembered facts and ingested documents, with project/tag scoping and an allowlist pre-filter for two-stage retrieval. Optional TurboQuant embedding quantization shrinks stored vectors ~6× (4-bit) / ~12× (2-bit) with near-lossless ranking — off by default, see Setup.

**Figma** — Dev Mode MCP (port 3845) + Plugin API via `figma_execute`. Full A11y design-spec generation against design-system components.

**Voice** — Wake-word, push-to-talk dictation, full voice chat. Parakeet (sherpa-onnx) transcription, Kokoro TTS, resident always-listening mode. Settings → Voice.

**Whiteboard lessons** — `fauna_lesson_create` generates a multi-scene interactive whiteboard with synced narration, KaTeX, pen-drawn diagrams. Source a `.pptx`, `.docx`, `.pdf`, `.md`, `.html`, or URL — speaker notes included. Download as **MP4** or as a **portable HTML+audio zip** for any web host.

**Video** — Storyteller pipeline (`fauna_video_create`) stitches stock footage + narration + burned-in subs with ffmpeg in 9:16, 16:9, or 1:1. Background music, voice mix, captions, all configurable.

**Podcasts** — Two-host conversational podcasts from a topic or document, voiced with Kokoro.

**Generative UI** — 18+ reactive inline components, plus dynamic widgets the model writes on the fly (circuit simulator, charts, calculators).

**Agents** — Builder wizard (name, prompt, perms, tools, tests, security scan, publish), or generate one from a description. Self-modifying with user review. Learnings journal injects past wins into new sessions.

**Agent Store** — Browse, install, publish. Security scan score ≥ 80 to publish. Versioned with rollback.

**Multi-agent** — Parallel `@a + @b [parallel] msg`, sequential `@a + @b msg`, or orchestrator `[DELEGATE:name]` blocks.

**Sandbox** — Declared file paths only (`.ssh`/`.aws` always blocked). Shell command filtering. Custom tools run in isolated VM with 300s timeout, 5MB cap, 5 concurrent slots.

**Automation** — Recorded workflows, cron-style heartbeat conversations, background task runner with status pane, Microsoft Teams bridge, Chrome side-panel extension with CDP automation.

**Projects** — First-class workspace with sources (local folders + GitHub repos), contexts, multiple conversations, a built-in **Git UI** (commit / push / pull / rebase / stash / diff / branches / discard) per source, a **file hub** with drag-and-drop upload, manual upload, right-click context menu (Reveal in Finder, Copy Path, Rename, Delete), inline Monaco viewer, persistent project-scoped **terminals** with streaming I/O, **dev-server** lifecycle management, and versioned **checkpoints** with restore.

**Kanban / Autopilot** — Project board where cards drive AI runs end-to-end with retries, comments, and work-item verification. Native + widget-panel alerts on completion / failure / out-of-retries. Live SSE stream at `/api/board/stream`.

**Skills** — First-class skill packs (spec-driven development, TDD, debugging-and-error-recovery, incremental implementation, code review, …) installable, lintable, and authored to a documented anatomy. See [docs/skill-anatomy.md](docs/skill-anatomy.md) and [skills/](skills).

**Connectors & RAG** — Ingest documents, folders, or GitHub repos as RAG sources outside projects. Memory facts have decay, recall, stats, import/export, and reviewer proposals.

**MCP everywhere** — Wire arbitrary **custom MCP servers** (OAuth, logs, start/stop). Fauna also exposes itself at `/mcp` so other agents can call its tools. Auto-detects Figma Dev Mode MCP (3845) and shared [faunaMCP](https://github.com/howmon/faunaMCP) (3341 / 3335).

**Cloud sync** — Cross-device project / conversation / memory sync with login, encrypted vault, lock / unlock, push / pull, backfill, change-password, live event stream.

**PCB / Circuit lab** — Beyond the inline circuit widget: schematic renderer, footprints, graph model, design-rule checks, SPICE simulation, symbol library, and harness adapter ([lib/circuit-*.js](lib)).

**Microsoft 365 / Teams** — Standalone **Fauna Teams bot** (publishable app with manifest + PHP gateway, in [fauna-bot/](fauna-bot)), Teams bridge for in-app messaging, and **Workiq** Microsoft Graph integration.

**Other** — Artifacts pane (HTML/MD/JSON/CSV/charts, 30-day retention), Playbook (learned instructions), token-aware auto-compaction (`/compact`), multi-conversation with DOM isolation, multi-window orchestration, system context / region capture, browser extension (Chrome sidepanel + popup + content script), webhook hooks, document tools (Markdown→PDF, extract-document), bundled binaries (ffmpeg, etc.), built-in `/api/doctor` diagnostics, enterprise SSO, and a mobile companion app (Expo, in [mobile/](mobile)) paired via `/api/mobile/pair`.

---

## How It Works

```
User → AI streams response with native function tool calls
     → Server runs each tool through the permission guard + sandbox
     → Feeds role:tool result back, re-invokes model (up to 50 hops/turn)
     → Loop continues until model emits a tool-free message (one HTTP response)
     → Background conversations keep running when you switch away

[Fauna — port 3737 · ~420 routes · Electron + preload IPC]
  Core agent loop
  ├── /api/chat                    streaming AI + agentic tool loop
  ├── /api/conversations[/stream]  CRUD + SSE
  ├── /api/shell-exec /-stdin      bash / PowerShell with cancel
  ├── /api/browse                  stealth headless browser
  ├── /api/{read,write,append}-file, /apply-patch, /replace-string
  └── /api/checkpoints, /restore-checkpoint

  Projects · Kanban · Git
  ├── /api/projects/:id/{board,workitems,runs,checkpoints,sources,terminal,design}
  ├── /api/projects/:id/sources/:srcId/{files,file,raw,abspath,reveal,entry,upload,run,sync}
  ├── /api/projects/:id/github/:sourceId/{status,commit,push,pull,rebase,stash,diff,…}
  ├── /api/board[/stream]          SSE board events
  └── /api/dev-servers             managed dev-server lifecycle

  Memory · RAG · Skills
  ├── /api/facts[/recall,/decay,/stats,/proposals]
  ├── /api/memory[/category,/proposals]
  ├── /api/connectors/{documents,folder,github}
  └── /api/skills[/import,/lint]

  Agents · Store · MCP
  ├── /api/agents…                 CRUD, scan, learnings, MCP start/stop, tests
  ├── /api/store…                  browse, install, publish, sync, admin
  ├── /api/custom-mcp-servers/:id  user-wired MCP servers (OAuth, logs)
  ├── /api/agent-builder/*         wizard: decompose/generate/save/scan/test
  └── /mcp                         Fauna's own MCP endpoint

  Media · Voice · Lessons · Video
  ├── /api/lesson-*                whiteboard lessons + MP4 / HTML export
  ├── /api/video/jobs/:id[/events] storyteller pipeline, SSE per job
  ├── /api/kokoro-tts /-podcast    Kokoro voice synth + 2-host podcasts
  ├── /api/parakeet-model-*        Parakeet STT download / status / delete
  └── /api/transcribe              speech-to-text

  Automation · Sync · Devices
  ├── /api/workflows…              recorded + scheduled (cron / RRULE)
  ├── /api/heartbeat/alerts[/stream]
  ├── /api/tasks…                  background task runner w/ steer / pause
  ├── /api/sync/*                  cross-device sync (login, lock, events)
  ├── /api/tunnel/{start,status,stop}
  ├── /api/mobile/pair             Expo companion handshake
  ├── /api/browser-ext/{install,info,download}
  ├── /api/teams-bot /teams        Fauna Teams bot + bridge
  └── /api/workiq/connect          Microsoft Graph / M365

  Figma · Design
  ├── GET  :3845/mcp               Figma Dev Mode MCP
  ├── WS   :3335                   Figma relay plugin
  ├── /api/figma/{execute,plugin-*,mcp-*,rules}
  └── /api/design/{directions,skills,systems}

  System
  ├── /api/doctor                  built-in diagnostics
  ├── /api/{capture-region,window-arrange,system-context,preview-file}
  ├── /api/credentials             secure secret store
  ├── /api/github/accounts/*       multi-account GitHub
  ├── /api/llm/{config,discover,models,probe,providers}
  ├── /api/enterprise-auth/*       SSO
  └── /api/widget/alerts/settings  always-on-top alert widget
```

---

## Setup

**Prereqs:** Node.js 18+ · Copilot subscription, an API key (OpenAI / Anthropic / Google), or any OpenAI-compatible endpoint.

```bash
git clone https://github.com/howmon/FaunaApp.git
cd FaunaApp
npm install
npm start        # dev
npm run dist     # build
```

**Auth:** Settings → Authentication → paste GitHub PAT or API key.
**Figma:** Figma Desktop → Preferences → Enable Dev Mode MCP Server → toggle 🔷 MCP in toolbar.

**Data layout:** Per-user data lives under `$FAUNA_CONFIG_DIR` (defaults to Electron's `app.getPath('userData')` — `~/Library/Application Support/Fauna` on macOS, `%APPDATA%\Fauna` on Windows). Holds `projects.json`, `conversations/`, `memory/`, `skills/`, `agents/`, `local-llm.json`, and the sync vault.

**Diagnostics:** Help → Run Doctor (or `GET /api/doctor`) checks node / ffmpeg / Whisper / Figma MCP / sandbox / network.

### Custom Endpoints (local & hosted OpenAI-compatible)

Settings → Authentication → **Custom Endpoints**. Hosted presets for NVIDIA NIM / Groq / Together / Fireworks / DeepInfra / Mistral / DeepSeek / OpenRouter. **Refresh** auto-discovers Ollama (11434), LM Studio (1234), llama.cpp (8080), vLLM (8000), Jan (1337), Text-Gen-WebUI (5000). Or paste any `/v1` URL. Per-endpoint tool-call and vision overrides. Config at `$FAUNA_CONFIG_DIR/local-llm.json`.

```bash
brew install ollama && ollama serve &
ollama pull qwen2.5-coder:14b
# Fauna → Settings → Custom Endpoints → Refresh → Use → Save & Enable
```

### Embedding quantization (optional)

Pure-JS TurboQuant scalar quantization for stored embeddings. **Off by default** and fully backward-compatible — existing fp32 vectors keep working, and search auto-detects each vector's format. Enable it to cut embedding storage ~6× (4-bit) / ~12× (2-bit) with effectively unchanged retrieval quality.

```bash
export FAUNA_QUANTIZE_EMBEDDINGS=1   # turn on (default: off)
export FAUNA_QUANTIZE_BITS=4         # 4 (default) or 2
node scripts/quantize-embeddings.cjs # migrate existing vectors in place
```

### Skills

Drop a skill pack into [skills/](skills) or import from disk (Settings → Skills → Import) or a URL. Each skill follows the documented anatomy in [docs/skill-anatomy.md](docs/skill-anatomy.md): `SKILL.md`, optional `tools/`, `prompts/`, `tests/`. Lint with `POST /api/skills/lint` before shipping.

### Mobile companion

In the app: Settings → Mobile → Generate pairing code. In the Expo app ([mobile/](mobile)): scan or paste the code; pairing uses `/api/mobile/pair`. Same network or via `/api/tunnel/start` for remote.

### Browser extension

In the app: Settings → Browser Extension → Install. Or call `POST /api/browser-ext/install` directly. The extension ([browser-extension/](browser-extension)) ships a Chrome sidepanel, popup, background worker, and content script that bridges to Fauna over the local port.

### Cloud sync

Settings → Sync → Sign in. Choose a vault passphrase; projects, conversations, memory, and checkpoints replicate across devices. Lock/unlock per session, exclude specific projects, monitor live events at `/api/sync/events`.

### Microsoft Teams bot

The standalone Teams app lives in [fauna-bot/](fauna-bot) — manifest, PHP gateway, and Node server. For the in-app bridge (DM your running Fauna from Teams): Settings → Teams → paste bot token, then `POST /api/teams-bot/start`.

### Standalone updates / FaunaMCP

Help → Check for Fauna Updates pulls the main branch zip and rebuilds. For shared browser/Figma MCP across apps, install [howmon/faunaMCP](https://github.com/howmon/faunaMCP) — Fauna auto-detects `http://localhost:3341/mcp` and `ws://localhost:3335`.

### CLI (no Electron)

```bash
npm install -g @eichho/fauna
fauna                          # REPL
fauna --server                 # server only
fauna -q "summarize this repo" # one-shot
echo "explain this" | fauna    # pipe mode
```

Slash commands: `/store`, `/store install <slug>`, `/projects`, `/board`, `/skills`, `/mcps`, `/sync`, `/compact`.

---

## Roadmap

- [x] Local model support (Ollama, llama.cpp, LM Studio, vLLM, …, any OpenAI `/v1`)
- [x] Workflow recorder + cron / RRULE scheduling
- [x] Voice input/output (wake-word, dictation, voice chat, TTS)
- [x] Whiteboard lessons with MP4 + HTML export
- [x] Mobile companion app (Expo, in `/mobile`) with pairing
- [x] Plugin system beyond agents — skills, custom MCP servers, custom endpoints
- [x] Cross-device cloud sync (encrypted vault, live events)
- [x] Kanban autopilot with native + widget alerts
- [x] Project Git UI (commit / push / pull / rebase / stash)
- [ ] Linux builds (AppImage / Snap)
- [ ] Agent analytics — usage, token costs, success rates (basic telemetry exists at `/api/internal-ai/telemetry`)
- [ ] Conversation branching
- [ ] MCP server marketplace

---

## License

MIT — [Solomon Abey](https://github.com/howmon)

