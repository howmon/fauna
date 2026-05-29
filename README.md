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

**Figma** — Dev Mode MCP (port 3845) + Plugin API via `figma_execute`. Full A11y design-spec generation against design-system components.

**Voice** — Wake-word, push-to-talk dictation, full voice chat. Whisper transcription, Kokoro TTS, resident always-listening mode. Settings → Voice.

**Whiteboard lessons** — `fauna_lesson_create` generates a multi-scene interactive whiteboard with synced narration, KaTeX, pen-drawn diagrams. Source a `.pptx`, `.docx`, `.pdf`, `.md`, `.html`, or URL — speaker notes included. Download as **MP4** or as a **portable HTML+audio zip** for any web host.

**Video** — Storyteller pipeline (`fauna_video_create`) stitches stock footage + narration + burned-in subs with ffmpeg in 9:16, 16:9, or 1:1. Background music, voice mix, captions, all configurable.

**Podcasts** — Two-host conversational podcasts from a topic or document, voiced with Kokoro.

**Generative UI** — 18+ reactive inline components, plus dynamic widgets the model writes on the fly (circuit simulator, charts, calculators).

**Agents** — Builder wizard (name, prompt, perms, tools, tests, security scan, publish), or generate one from a description. Self-modifying with user review. Learnings journal injects past wins into new sessions.

**Agent Store** — Browse, install, publish. Security scan score ≥ 80 to publish. Versioned with rollback.

**Multi-agent** — Parallel `@a + @b [parallel] msg`, sequential `@a + @b msg`, or orchestrator `[DELEGATE:name]` blocks.

**Sandbox** — Declared file paths only (`.ssh`/`.aws` always blocked). Shell command filtering. Custom tools run in isolated VM with 300s timeout, 5MB cap, 5 concurrent slots.

**Automation** — Recorded workflows, cron-style heartbeat conversations, background task runner with status pane, Microsoft Teams bridge, Chrome side-panel extension with CDP automation.

**Other** — Artifacts pane (HTML/MD/JSON/CSV/charts, 30-day retention), Projects (group convos + contexts), Playbook (learned instructions), token-aware auto-compaction (`/compact`), multi-conversation with DOM isolation. Mobile companion app (Expo, in `/mobile`).

---

## How It Works

```
User → AI streams response with native function tool calls
     → Server runs each tool, feeds role:tool result back, re-invokes model
     → Loop continues until model emits a tool-free message (one HTTP response)
     → Background conversations keep running when you switch away

[Fauna — port 3737]
  ├── /api/chat              streaming AI + agentic tool loop
  ├── /api/shell-exec        bash / PowerShell
  ├── /api/browse            stealth headless browser
  ├── /api/write-file        atomic file writes
  ├── /api/agents /store     agent CRUD, browse, publish
  ├── /api/lesson-*          whiteboard lessons + MP4 / HTML export
  ├── /api/video             storyteller video render
  ├── /api/kokoro-tts        Kokoro voice synth
  ├── /api/whisper           transcription
  ├── GET :3845/mcp          Figma Dev Mode MCP
  └── WS  :3335              Figma relay plugin
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

### Custom Endpoints (local & hosted OpenAI-compatible)

Settings → Authentication → **Custom Endpoints**. Hosted presets for NVIDIA NIM / Groq / Together / Fireworks / DeepInfra / Mistral / DeepSeek / OpenRouter. **Refresh** auto-discovers Ollama (11434), LM Studio (1234), llama.cpp (8080), vLLM (8000), Jan (1337), Text-Gen-WebUI (5000). Or paste any `/v1` URL. Per-endpoint tool-call and vision overrides. Config at `$FAUNA_CONFIG_DIR/local-llm.json`.

```bash
brew install ollama && ollama serve &
ollama pull qwen2.5-coder:14b
# Fauna → Settings → Custom Endpoints → Refresh → Use → Save & Enable
```

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

Slash commands: `/store`, `/store install <slug>`, `/projects`, `/mcps`, `/compact`.

---

## Roadmap

- [x] Local model support (Ollama, llama.cpp, LM Studio, vLLM, …, any OpenAI `/v1`)
- [x] Workflow recorder and replay
- [x] Voice input/output (wake-word, dictation, voice chat, TTS)
- [x] Whiteboard lessons with MP4 + HTML export
- [x] Mobile companion app (Expo, in `/mobile`)
- [ ] Linux builds (AppImage / Snap)
- [ ] Agent analytics — usage, token costs, success rates
- [ ] Conversation branching
- [ ] Plugin system beyond agents
- [ ] MCP server marketplace

---

## License

MIT — [Solomon Abey](https://github.com/howmon)

