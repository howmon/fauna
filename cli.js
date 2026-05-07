#!/usr/bin/env node
/**
 * Fauna CLI — headless mode
 *
 * Starts the Fauna server without Electron, providing:
 *   - Interactive REPL for chatting with agents
 *   - Full API server on http://127.0.0.1:3737
 *   - Browser extension WebSocket relay
 *   - Task scheduler & runner
 *
 * Usage:
 *   node cli.js                  # start server + interactive REPL
 *   node cli.js --server         # server only (no REPL)
 *   node cli.js --port 4000      # custom port
 *   node cli.js -q "summarize this repo"   # one-shot query
 *   echo "explain this" | node cli.js      # pipe mode
 */

import { createInterface } from 'readline';
import path from 'path';
import os from 'os';
import fs from 'fs';
import { fileURLToPath } from 'url';
import QRCode from 'qrcode';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
let startServer;

// ── Arg parsing ───────────────────────────────────────────────────────────

const args = process.argv.slice(2);
function flag(name)       { return args.includes(name); }
function option(name, fb) { const i = args.indexOf(name); return i >= 0 && args[i+1] ? args[i+1] : fb; }

const PORT        = parseInt(option('--port', '3737'), 10);
const SERVER_ONLY = flag('--server') || flag('-s');
const ONE_SHOT    = option('-q', null) || option('--query', null);
const SHOW_HELP   = flag('--help') || flag('-h');
let   VERBOSE     = flag('--verbose') || flag('-v');

// ── Colors (no deps) ─────────────────────────────────────────────────────

const R  = '\x1b[0m';      // reset
const DM = '\x1b[2m';      // dim
const B  = '\x1b[1m';      // bold
const UL = '\x1b[4m';      // underline
const CY = '\x1b[36m';     // cyan
const GR = '\x1b[32m';     // green
const YL = '\x1b[33m';     // yellow
const RD = '\x1b[31m';     // red
const MG = '\x1b[35m';     // magenta
const GY = '\x1b[90m';     // gray
const BG_DIM = '\x1b[48;5;236m'; // subtle bg for code blocks

if (SHOW_HELP) {
  console.log(`
  ${B}✦ Fauna CLI${R}

  Usage:
    fauna                           interactive REPL + server
    fauna --server                  server only (API on port 3737)
    fauna --port 4000               custom port
    fauna -q "summarize README"     one-shot query, print result, exit
    echo "question" | fauna         pipe mode (reads stdin, prints answer, exits)

  Options:
    -q, --query <text>   send a single message and exit
    -s, --server         server-only mode (no REPL)
    --port <num>         port (default: 3737)
    -v, --verbose        show tool calls & usage stats
    -h, --help           show this help
`);
  process.exit(0);
}

// ── True-color helpers (logo) ────────────────────────────────────────────

const rgb = (r, g, b) => `\x1b[38;2;${r};${g};${b}m`;
const T1 = rgb(15, 118, 110);    // dark teal
const T2 = rgb(13, 148, 136);    // mid teal
const T3 = rgb(20, 184, 166);    // bright teal
const T4 = rgb(45, 212, 191);    // light teal
const T5 = rgb(94, 234, 212);    // pale teal/highlight
const AM = rgb(245, 158, 11);    // amber (eye)

const FAUNA_LOGO = [
  `${T1}            ▄▄${T2}██████${T1}▄▄`,
  `${T1}         ▄${T2}████████████${T3}██▄`,
  `${T2}       ▄${T3}██████████████████${T2}█▄`,
  `${T2}      ${T3}█████████████████████${T1}▀▀`,
  `${T3}     ███████████████████████`,
  `${T3}     █████████ ${AM}◉${T3}  ██████████`,
  `${T3}     ▀${T4}██████████████████████`,
  `${T2}      ▀▀${T3}█████████████████${T2}▀`,
  `${T1}         ▀${T2}████████████${T1}█▀`,
  `${T1}            ▀▀${T2}████${T1}▀▀`,
];

async function printBanner() {
  const ver = `${DM}v${_version()}${R}`;
  const title = `${B}${T4}  Fauna CLI${R}  ${ver}`;
  const sub = `${DM}  AI assistant · headless mode${R}`;
  const lines = ['', ...FAUNA_LOGO, '', title, sub, ''];
  for (const line of lines) {
    console.log(line);
    await new Promise(r => setTimeout(r, 35));
  }
}

// ── Terminal markdown rendering ──────────────────────────────────────────

function renderMarkdown(text) {
  return text
    // Code blocks — dim bg
    .replace(/```(\w*)\n([\s\S]*?)```/g, (_, lang, code) =>
      `${DM}${lang ? `[${lang}]` : ''}${R}\n${GY}${code.trimEnd()}${R}\n`)
    // Inline code
    .replace(/`([^`]+)`/g, `${CY}$1${R}`)
    // Bold
    .replace(/\*\*(.+?)\*\*/g, `${B}$1${R}`)
    // Italic
    .replace(/(?<!\*)\*([^*]+)\*(?!\*)/g, `${DM}$1${R}`)
    // Headers
    .replace(/^### (.+)$/gm, `\n${B}${YL}   $1${R}`)
    .replace(/^## (.+)$/gm,  `\n${B}${CY}  $1${R}`)
    .replace(/^# (.+)$/gm,   `\n${B}${MG} $1${R}`)
    // Bullet lists
    .replace(/^(\s*)[-*] /gm, '$1• ')
    // Horizontal rule
    .replace(/^---+$/gm, `${DM}${'─'.repeat(40)}${R}`);
}

// ── API helpers ──────────────────────────────────────────────────────────

const API = `http://127.0.0.1:${PORT}`;

async function apiGet(path) {
  const res = await fetch(`${API}${path}`);
  if (!res.ok) throw new Error(`${res.status}: ${await res.text()}`);
  return res.json();
}

async function apiPost(path, body) {
  const res = await fetch(`${API}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`${res.status}: ${await res.text()}`);
  return res.json();
}

async function apiDelete(path) {
  const res = await fetch(`${API}${path}`, { method: 'DELETE' });
  if (!res.ok) throw new Error(`${res.status}: ${await res.text()}`);
  return res.json();
}

async function apiPut(path, body) {
  const res = await fetch(`${API}${path}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`${res.status}: ${await res.text()}`);
  return res.json();
}

// ── Chat streaming (calls the local server's SSE endpoint) ───────────────

async function chat(message, { model, agent, userContent } = {}) {
  const url = `${API}/api/chat`;

  // Build messages array from history + current message
  // userContent may be a multipart array (with images) or defaults to plain text
  const messages = [
    ..._history,
    { role: 'user', content: userContent || message },
  ];

  const body = {
    messages,
    clientContext: 'cli',
    ...(model && { model }),
    ...(agent && { agentName: agent }),
    ...(_currentProjectId && { projectId: _currentProjectId }),
  };

  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Chat failed (${res.status}): ${text}`);
  }

  let fullContent = '';
  let usage = null;
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  // Spinner shown while model is generating (replaced by rendered output when done)
  const SPINNER = ['⠋','⠙','⠹','⠸','⠼','⠴','⠦','⠧','⠇','⠏'];
  let _spinFrame = 0;
  let _toolLabel = '';
  const _spinner = setInterval(() => {
    const label = _toolLabel ? ` ${DM}${_toolLabel}${R}` : '';
    process.stdout.write(`\r${DM}${SPINNER[_spinFrame++ % SPINNER.length]}${R}${label} `);
  }, 80);

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    const lines = buffer.split('\n');
    buffer = lines.pop() || '';

    for (const line of lines) {
      if (!line.startsWith('data: ')) continue;
      const data = line.slice(6);
      if (data === '[DONE]') continue;
      try {
        const evt = JSON.parse(data);
        switch (evt.type) {
          case 'content':
            fullContent += evt.content;
            break;
          case 'tool_call':
            _toolLabel = evt.name || '';
            if (VERBOSE) process.stdout.write(`\n${DM}⚙ calling ${CY}${evt.name}${R}${DM}…${R}\n`);
            break;
          case 'tool_output':
            _toolLabel = '';
            if (VERBOSE) {
              const out = (evt.output || '').slice(0, 200);
              process.stdout.write(`\n${GY}${out}${R}`);
            }
            break;
          case 'tool_waiting_for_input':
            clearInterval(_spinner);
            process.stdout.write(`\r${YL}⏳ ${evt.hint || 'waiting for input'}${R}\n`);
            break;
          case 'error':
            process.stderr.write(`\n${RD}✗ ${evt.error}${R}\n`);
            break;
          case 'done':
            if (evt.usage) usage = evt.usage;
            break;
        }
      } catch (_) {}
    }
  }

  clearInterval(_spinner);
  process.stdout.write('\r\x1b[K'); // clear spinner line

  // Strip browser-action / browser-ext-action code blocks from final output
  const stripped = fullContent.replace(/```browser(-ext)?-action[\s\S]*?```/g, '').trim();

  // Render and print the full response with markdown → ANSI formatting
  if (stripped) process.stdout.write(renderMarkdown(stripped));

  if (fullContent) {
    if (stripped) process.stdout.write('\n');
    // Store the user content (may be multipart with images) in history
    _history.push({ role: 'user', content: userContent || message });
    _history.push({ role: 'assistant', content: fullContent });
    if (_history.length > 40) _history = _history.slice(-30);
    // Auto-save conversation to server
    _saveConv();
  }

  // Show usage stats
  if (usage && VERBOSE) {
    const { prompt_tokens: pt, completion_tokens: ct, total_tokens: tt } = usage;
    console.log(`${GY}tokens: ${pt || '?'} prompt + ${ct || '?'} completion = ${tt || '?'} total${R}`);
  }

  return fullContent;
}

// ── Conversation state ───────────────────────────────────────────────────

let _history = [];
let _currentModel = null;
let _currentAgent = null;
let _currentProjectId = null;
let _currentProjectName = null;
let _attachments = [];  // pending file attachments
let _convId = 'conv-' + Date.now(); // current conversation ID for auto-save

// Save current conversation to server (non-blocking)
function _saveConv() {
  const msgs = _history.filter(m => m.role === 'user' || m.role === 'assistant');
  if (!msgs.length) return;
  const title = (typeof msgs[0]?.content === 'string' ? msgs[0].content : '').slice(0, 60) || 'CLI chat';
  apiPut('/api/conversations/' + _convId, {
    id: _convId,
    title,
    messages: msgs.map(m => ({ role: m.role, content: typeof m.content === 'string' ? m.content : JSON.stringify(m.content) })),
    model: _currentModel || undefined,
    projectId: _currentProjectId || undefined,
    createdAt: parseInt(_convId.replace('conv-', '')) || Date.now(),
  }).catch(() => {});
  if (_currentProjectId) {
    apiPost('/api/projects/' + _currentProjectId + '/conversations', { convId: _convId }).catch(() => {});
  }
}

// ── Formatting helpers ───────────────────────────────────────────────────

function taskStatusIcon(status) {
  switch (status) {
    case 'completed': return `${GR}✓${R}`;
    case 'failed':    return `${RD}✗${R}`;
    case 'running':   return `${YL}⟳${R}`;
    case 'paused':    return `${YL}⏸${R}`;
    case 'scheduled': return `${CY}⏰${R}`;
    default:          return `${DM}○${R}`;
  }
}

function shortId(id) { return (id || '').slice(0, 8); }

function duration(ms) {
  if (!ms) return '';
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60000) return `${(ms/1000).toFixed(1)}s`;
  return `${Math.floor(ms/60000)}m ${Math.round((ms%60000)/1000)}s`;
}

// ── Terminal QR code renderer (uses qrcode library) ──────────────────────

async function renderTerminalQR(text) {
  try {
    const modules = QRCode.create(text, { errorCorrectionLevel: 'L' }).modules;
    const size = modules.size;
    const getData = (r, c) => {
      if (r < 0 || c < 0 || r >= size || c >= size) return false;
      return modules.get(r, c);
    };

    const BLK = `${T3}█${R}`;
    const q = 2; // quiet zone
    const full = size + q * 2;
    const lines = [];
    for (let r = 0; r < full; r += 2) {
      let line = '  ';
      for (let c = 0; c < full; c++) {
        const top = getData(r - q, c - q);
        const bot = getData(r - q + 1, c - q);
        if (top && bot) line += BLK;
        else if (top && !bot) line += `${T3}▀${R}`;
        else if (!top && bot) line += `${T3}▄${R}`;
        else line += ' ';
      }
      lines.push(line);
    }
    console.log(lines.join('\n'));
  } catch (e) {
    console.log(`${DM}  (QR generation failed — connect manually)${R}`);
  }
}

// ── REPL commands ────────────────────────────────────────────────────────

const COMMANDS = {
  '/help': () => {
    console.log(`
${B}Chat${R}
  ${CY}/model${R} <name>         switch model (e.g. /model gpt-4o)
  ${CY}/agent${R} <name>         switch agent (e.g. /agent research)
  ${CY}/agents${R}               list available agents
  ${CY}/models${R}               list available models
  ${CY}/attach${R} <path>        attach file to next message
  ${CY}/clear${R}                clear conversation history
  ${CY}/conversations${R}        list saved conversations (alias: /sessions)
  ${CY}/conv${R} <id>            load a conversation by ID (alias: /session)

${B}Tasks${R}
  ${CY}/tasks${R}                list all tasks
  ${CY}/task${R} <id>            show task detail + result + reasoning
  ${CY}/task create${R} <desc>   create a new task
  ${CY}/task run${R} <id>        run a task
  ${CY}/task stop${R} <id>       stop a running task
  ${CY}/task steer${R} <id> msg  inject guidance into running task
  ${CY}/task delete${R} <id>     delete a task
  ${CY}/task log${R} <id>        show task reasoning chain
  ${CY}/automations${R}          alias for /tasks
  ${CY}/automation${R} ...       alias for /task ...

${B}Projects${R}
  ${CY}/projects${R}             list projects
  ${CY}/project${R} <id>         show project detail
  ${CY}/project use${R} <id>     set active project for chat context
  ${CY}/project clear${R}        clear active project
  ${CY}/project create${R} <name> create a project
  ${CY}/project source${R} <id> <path> add local source folder
  ${CY}/project sync${R} <id> <sourceId> sync a source

${B}Agent Store${R}
  ${CY}/store${R} [query]        search Agent Store
  ${CY}/store categories${R}     list store categories
  ${CY}/store show${R} <slug>    show store agent details
  ${CY}/store install${R} <slug> install or update a store agent

${B}Tools${R}
  ${CY}/browse${R} <url>         fetch & summarize a URL
  ${CY}/shell${R} <cmd>          run a shell command
  ${CY}/mcps${R}                 status of MCPs and browser bridge
  ${CY}/mcp start${R} <id>       start custom MCP server
  ${CY}/mcp stop${R} <id>        stop custom MCP server

${B}Mobile${R}
  ${CY}/pair${R}                 show QR code for mobile app pairing
  ${CY}/pair reset${R}           regenerate pairing token
  ${CY}/tunnel${R}               start remote access tunnel (outside LAN)
  ${CY}/tunnel stop${R}          stop tunnel

${B}System${R}
  ${CY}/status${R}               server & auth status
  ${CY}/config${R}               show config (PAT, model, etc.)
  ${CY}/config set${R} <k> <v>   set a config value
  ${CY}/verbose${R}              toggle verbose mode (tool calls, usage)
  ${CY}/quit${R}                 exit
`);
  },

  '/model': async (arg) => {
    if (!arg) { console.log(`${DM}Current: ${_currentModel || 'default'}${R}`); return; }
    _currentModel = arg;
    console.log(`${GR}Model → ${arg}${R}`);
  },

  '/agent': async (arg) => {
    if (!arg) { console.log(`${DM}Current: ${_currentAgent || 'none'}${R}`); return; }
    _currentAgent = arg;
    console.log(`${GR}Agent → ${arg}${R}`);
  },

  '/agents': async () => {
    try {
      const data = await apiGet('/api/agents');
      const agents = data.agents || data;
      if (!agents.length) { console.log(`${DM}No agents installed${R}`); return; }
      for (const a of agents) {
        const badge = a.builtin ? `${DM}(built-in)${R}` : '';
        const cat = a.category ? `${GY}[${a.category}]${R} ` : '';
        console.log(`  ${CY}${(a.displayName || a.name).padEnd(20)}${R} ${cat}${(a.description || '').slice(0, 60)} ${badge}`);
      }
    } catch (e) { console.log(`${RD}Failed: ${e.message}${R}`); }
  },

  '/models': async () => {
    try {
      const data = await apiGet('/api/models');
      for (const m of data.models || []) {
        const name = typeof m === 'string' ? m : (m.id || m.name || m.model || JSON.stringify(m));
        console.log(`  ${CY}${name}${R}`);
      }
    } catch (e) { console.log(`${RD}Failed: ${e.message}${R}`); }
  },

  '/attach': (arg) => {
    if (!arg) {
      if (!_attachments.length) { console.log(`${DM}No attachments${R}`); return; }
      console.log(`${DM}Pending attachments:${R}`);
      for (const a of _attachments) console.log(`  ${CY}${a.name}${R} (${a.content.length} chars)`);
      return;
    }
    const p = path.resolve(arg);
    if (!fs.existsSync(p)) { console.log(`${RD}File not found: ${p}${R}`); return; }
    try {
      const content = fs.readFileSync(p, 'utf8');
      _attachments.push({ name: path.basename(p), content: content.slice(0, 50000) });
      console.log(`${GR}Attached: ${path.basename(p)}${R} (${content.length} chars, capped at 50k)`);
    } catch (e) { console.log(`${RD}Cannot read: ${e.message}${R}`); }
  },

  '/clear': () => {
    _history = [];
    _attachments = [];
    _convId = 'conv-' + Date.now();
    console.log(`${DM}Conversation cleared${R}`);
  },

  '/conversations': async () => {
    try {
      const convs = await apiGet('/api/conversations');
      if (!convs.length) { console.log(`${DM}No saved conversations${R}`); return; }
      console.log(`\n  ${B}${'ID'.padEnd(14)} ${'Title'.padEnd(35)} ${'Msgs'.padEnd(6)} Date${R}`);
      console.log(`  ${DM}${'─'.repeat(70)}${R}`);
      for (const c of convs) {
        const date = c.createdAt ? new Date(c.createdAt).toLocaleDateString() : '';
        console.log(`  ${DM}${(c.id || '').slice(0, 13).padEnd(14)}${R} ${(c.title || '').slice(0, 34).padEnd(35)} ${String(c.messageCount || 0).padEnd(6)} ${GY}${date}${R}`);
      }
      console.log();
    } catch (e) { console.log(`${RD}Failed: ${e.message}${R}`); }
  },

  '/conv': async (arg) => {
    if (!arg) { console.log(`${DM}Usage: /conv <id> — load a conversation by ID${R}`); return; }
    try {
      const convs = await apiGet('/api/conversations');
      const match = convs.find(c => c.id === arg || c.id.startsWith(arg));
      if (!match) { console.log(`${RD}Conversation not found: ${arg}${R}`); return; }
      const conv = await apiGet('/api/conversations/' + match.id);
      _history = (conv.messages || []).filter(m => m.role === 'user' || m.role === 'assistant');
      if (conv.model) _currentModel = conv.model;
      _convId = match.id;
      console.log(`${GR}Loaded "${conv.title}" (${_history.length} messages)${R}`);
    } catch (e) { console.log(`${RD}Failed: ${e.message}${R}`); }
  },

  // Aliases
  '/sessions': async (arg) => { await COMMANDS['/conversations'](arg); },
  '/session': async (arg) => { await COMMANDS['/conv'](arg); },

  // ── Task commands ────────────────────────────────────────────────────

  '/tasks': async () => {
    try {
      const tasks = await apiGet('/api/tasks');
      if (!tasks.length) { console.log(`${DM}No tasks${R}`); return; }
      console.log(`\n  ${B}${'ID'.padEnd(10)} ${'Title'.padEnd(28)} ${'Status'.padEnd(12)} Schedule${R}`);
      console.log(`  ${DM}${'─'.repeat(68)}${R}`);
      for (const t of tasks) {
        const icon = taskStatusIcon(t.status);
        const sched = t.schedule?.type || '';
        console.log(`  ${icon} ${DM}${shortId(t.id).padEnd(9)}${R} ${(t.title || '').slice(0,27).padEnd(28)} ${t.status.padEnd(12)} ${GY}${sched}${R}`);
      }
      console.log();
    } catch (e) { console.log(`${RD}Failed: ${e.message}${R}`); }
  },

  '/task': async (arg) => {
    if (!arg) { console.log(`${DM}Usage: /task <id|create|run|stop|steer|delete|log> ...${R}`); return; }
    const parts = arg.split(/\s+/);
    const sub = parts[0].toLowerCase();

    // Sub-commands
    if (sub === 'create') return _taskCreate(parts.slice(1).join(' '));
    if (sub === 'run')    return _taskRun(parts[1]);
    if (sub === 'stop')   return _taskStop(parts[1]);
    if (sub === 'steer')  return _taskSteer(parts[1], parts.slice(2).join(' '));
    if (sub === 'delete') return _taskDelete(parts[1]);
    if (sub === 'log')    return _taskLog(parts[1]);

    // Otherwise treat as task ID — show detail
    return _taskDetail(sub);
  },

  '/automations': async (arg) => { await COMMANDS['/tasks'](arg); },
  '/automation': async (arg) => { await COMMANDS['/task'](arg); },

  // ── Project commands ─────────────────────────────────────────────────

  '/projects': async () => {
    try {
      const projects = await apiGet('/api/projects');
      if (!projects.length) { console.log(`${DM}No projects${R}`); return; }
      console.log(`\n  ${B}${'ID'.padEnd(10)} ${'Name'.padEnd(28)} ${'Sources'.padEnd(8)} Updated${R}`);
      console.log(`  ${DM}${'─'.repeat(70)}${R}`);
      for (const p of projects) {
        const active = p.id === _currentProjectId ? `${GR}*${R}` : ' ';
        const updated = p.updatedAt || p.lastActiveAt || p.createdAt;
        const date = updated ? new Date(updated).toLocaleDateString() : '';
        console.log(`${active} ${DM}${shortId(p.id).padEnd(9)}${R} ${(p.name || '').slice(0,27).padEnd(28)} ${String((p.sources || []).length).padEnd(8)} ${GY}${date}${R}`);
      }
      console.log();
    } catch (e) { console.log(`${RD}Failed: ${e.message}${R}`); }
  },

  '/project': async (arg) => {
    if (!arg) { console.log(`${DM}Usage: /project <id|use|clear|create|source|sync> ...${R}`); return; }
    const parts = arg.split(/\s+/);
    const sub = parts[0].toLowerCase();
    if (sub === 'use') return _projectUse(parts[1]);
    if (sub === 'clear') return _projectClear();
    if (sub === 'create') return _projectCreate(parts.slice(1).join(' '));
    if (sub === 'source') return _projectAddSource(parts[1], parts.slice(2).join(' '));
    if (sub === 'sync') return _projectSync(parts[1], parts[2]);
    return _projectDetail(sub);
  },

  // ── MCP commands ─────────────────────────────────────────────────────

  '/mcps': async () => { await _mcpStatus(); },
  '/mcp': async (arg) => {
    const parts = (arg || '').split(/\s+/).filter(Boolean);
    const sub = parts[0];
    if (sub === 'start') return _mcpStart(parts[1]);
    if (sub === 'stop') return _mcpStop(parts[1]);
    if (sub === 'logs') return _mcpLogs(parts[1]);
    console.log(`${DM}Usage: /mcps | /mcp start <id> | /mcp stop <id> | /mcp logs <id>${R}`);
  },

  // ── Agent Store commands ──────────────────────────────────────────────

  '/store': async (arg) => {
    const parts = (arg || '').split(/\s+/).filter(Boolean);
    const sub = parts[0];
    if (sub === 'categories') return _storeCategories();
    if (sub === 'show') return _storeShow(parts[1]);
    if (sub === 'install') return _storeInstall(parts[1]);
    if (sub === 'search') return _storeSearch(parts.slice(1).join(' '));
    return _storeSearch(arg || '');
  },

  // ── Browse & Shell ───────────────────────────────────────────────────

  '/browse': async (arg) => {
    if (!arg) { console.log(`${DM}Usage: /browse <url>${R}`); return; }
    try {
      process.stdout.write(`${DM}Fetching ${arg}…${R}\n`);
      const data = await apiPost('/api/browse', { url: arg, mode: 'markdown' });
      const text = data.markdown || data.text || data.content || JSON.stringify(data);
      console.log(renderMarkdown(text.slice(0, 5000)));
      if (text.length > 5000) console.log(`${DM}…truncated (${text.length} chars total)${R}`);
    } catch (e) { console.log(`${RD}Failed: ${e.message}${R}`); }
  },

  '/shell': async (arg) => {
    if (!arg) { console.log(`${DM}Usage: /shell <command>${R}`); return; }
    try {
      const data = await apiPost('/api/shell-exec', { command: arg });
      if (data.stdout) process.stdout.write(data.stdout);
      if (data.stderr) process.stderr.write(`${RD}${data.stderr}${R}`);
      if (data.exitCode !== 0 && data.exitCode != null) {
        console.log(`${YL}exit: ${data.exitCode}${R}`);
      }
    } catch (e) { console.log(`${RD}Failed: ${e.message}${R}`); }
  },

  // ── Config ───────────────────────────────────────────────────────────

  '/config': async (arg) => {
    const cfgPath = path.join(os.homedir(), '.config', 'fauna', 'config.json');
    if (arg && arg.startsWith('set ')) {
      const [, key, ...vals] = arg.split(/\s+/);
      const val = vals.join(' ');
      if (!key || !val) { console.log(`${DM}Usage: /config set <key> <value>${R}`); return; }
      try {
        let cfg = {};
        try { cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8')); } catch (_) {}
        cfg[key] = val;
        fs.mkdirSync(path.dirname(cfgPath), { recursive: true });
        fs.writeFileSync(cfgPath, JSON.stringify(cfg, null, 2));
        console.log(`${GR}Set ${key} = ${val}${R}`);
      } catch (e) { console.log(`${RD}Failed: ${e.message}${R}`); }
      return;
    }
    // Show current config
    try {
      const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
      const safe = { ...cfg };
      if (safe.pat) safe.pat = safe.pat.slice(0, 8) + '…' + safe.pat.slice(-4);
      console.log(`${B}Config${R} ${DM}(${cfgPath})${R}`);
      for (const [k, v] of Object.entries(safe)) {
        console.log(`  ${CY}${k}${R}: ${v}`);
      }
    } catch (_) {
      console.log(`${DM}No config file yet. Use /config set <key> <value>${R}`);
    }
  },

  // ── System ───────────────────────────────────────────────────────────

  '/status': async () => {
    try {
      const data = await apiGet('/api/system-context');
      console.log(`\n  ${B}Fauna CLI${R}  ${DM}v${_version()}${R}`);
      console.log(`  ${B}Auth:${R}       ${data.auth === 'granted' ? GR + '✓ granted' : RD + '✗ denied'}${R}`);
      console.log(`  ${B}Port:${R}       ${PORT}`);
      console.log(`  ${B}Mode:${R}       CLI (headless)`);
      console.log(`  ${B}Platform:${R}   ${process.platform} ${process.arch}`);
      console.log(`  ${B}Node:${R}       ${process.version}`);
      console.log(`  ${B}Model:${R}      ${_currentModel || 'default'}`);
      console.log(`  ${B}Agent:${R}      ${_currentAgent || 'none'}`);
      console.log(`  ${B}Project:${R}    ${_currentProjectName || _currentProjectId || 'none'}`);
      console.log(`  ${B}Verbose:${R}    ${VERBOSE ? GR + 'on' : DM + 'off'}${R}`);
      console.log();
    } catch (e) { console.log(`${RD}Failed: ${e.message}${R}`); }
  },

  '/pair': async (arg) => {
    if (arg === 'reset') {
      try {
        await apiPost('/api/mobile/pair/reset');
        console.log(`${GR}Pairing token regenerated${R}`);
      } catch (e) { console.log(`${RD}Failed: ${e.message}${R}`); return; }
    }
    try {
      const data = await apiGet('/api/mobile/pair');
      const qrUrl = data.primaryQr || data.qrData?.[0];
      if (!qrUrl) { console.log(`${RD}No pairing data available${R}`); return; }
      console.log();
      await renderTerminalQR(qrUrl);
      console.log();
      console.log(`  ${B}Scan this QR code${R} with the Fauna mobile app`);
      console.log(`  ${DM}or connect manually:${R}`);
      for (const ip of data.ips || []) {
        console.log(`    ${CY}${ip}:${data.port}${R}`);
      }
      if (data.tunnelUrl) console.log(`    ${CY}${data.tunnelUrl}${R}  ${DM}(tunnel)${R}`);
      console.log(`    ${DM}Token: ${data.token}${R}`);
      console.log();
    } catch (e) { console.log(`${RD}Failed: ${e.message}${R}`); }
  },

  '/tunnel': async (arg) => {
    if (arg === 'stop') {
      try {
        await apiPost('/api/tunnel/stop');
        console.log(`${DM}Tunnel stopped${R}`);
      } catch (e) { console.log(`${RD}Failed: ${e.message}${R}`); }
      return;
    }
    // Check if already running
    try {
      const status = await apiGet('/api/tunnel/status');
      if (status.active) {
        console.log(`${GR}Tunnel already running:${R} ${CY}${status.url}${R}`);
        console.log(`${DM}Use /tunnel stop to stop it${R}`);
        return;
      }
    } catch (_) {}
    console.log(`${DM}Starting tunnel…${R}`);
    try {
      const res = await apiPost('/api/tunnel/start');
      console.log(`${GR}Tunnel started:${R} ${CY}${res.url}${R}`);
      console.log(`${DM}Run /pair to get a QR code with the tunnel URL${R}`);
    } catch (e) { console.log(`${RD}Failed: ${e.message}${R}`); }
  },

  '/verbose': () => {
    // Toggle verbose at runtime — uses module-level variable
    _setVerbose(!VERBOSE);
    console.log(`${DM}Verbose: ${VERBOSE ? GR + 'on' : 'off'}${R}`);
  },

  '/quit': () => { process.exit(0); },
  '/exit': () => { process.exit(0); },
  '/q':    () => { process.exit(0); },
};

// ── Task sub-command implementations ─────────────────────────────────────

async function _taskCreate(desc) {
  if (!desc) { console.log(`${DM}Usage: /task create <description>${R}`); return; }
  try {
    const task = await apiPost('/api/tasks', { title: desc, goal: desc });
    console.log(`${GR}Created task ${shortId(task.id)}${R}: ${task.title}`);
  } catch (e) { console.log(`${RD}Failed: ${e.message}${R}`); }
}

async function _taskRun(id) {
  if (!id) { console.log(`${DM}Usage: /task run <id>${R}`); return; }
  const task = await _resolveTask(id);
  if (!task) return;
  try {
    await apiPost(`/api/tasks/${task.id}/run`);
    console.log(`${GR}Running task ${shortId(task.id)}${R}: ${task.title}`);
    console.log(`${DM}Use /task ${shortId(task.id)} to check status, /task stop ${shortId(task.id)} to abort${R}`);
  } catch (e) { console.log(`${RD}Failed: ${e.message}${R}`); }
}

async function _taskStop(id) {
  if (!id) { console.log(`${DM}Usage: /task stop <id>${R}`); return; }
  const task = await _resolveTask(id);
  if (!task) return;
  try {
    await apiPost(`/api/tasks/${task.id}/stop`);
    console.log(`${YL}Stopped task ${shortId(task.id)}${R}`);
  } catch (e) { console.log(`${RD}Failed: ${e.message}${R}`); }
}

async function _taskSteer(id, msg) {
  if (!id || !msg) { console.log(`${DM}Usage: /task steer <id> <message>${R}`); return; }
  const task = await _resolveTask(id);
  if (!task) return;
  try {
    await apiPost(`/api/tasks/${task.id}/steer`, { message: msg });
    console.log(`${GR}Steered task ${shortId(task.id)}${R}: ${msg}`);
  } catch (e) { console.log(`${RD}Failed: ${e.message}${R}`); }
}

async function _taskDelete(id) {
  if (!id) { console.log(`${DM}Usage: /task delete <id>${R}`); return; }
  const task = await _resolveTask(id);
  if (!task) return;
  try {
    await apiDelete(`/api/tasks/${task.id}`);
    console.log(`${RD}Deleted task ${shortId(task.id)}${R}`);
  } catch (e) { console.log(`${RD}Failed: ${e.message}${R}`); }
}

async function _taskDetail(id) {
  const task = await _resolveTask(id);
  if (!task) return;
  console.log(`\n  ${B}${task.title}${R}`);
  console.log(`  ${DM}ID:${R}       ${task.id}`);
  console.log(`  ${DM}Status:${R}   ${taskStatusIcon(task.status)} ${task.status}`);
  if (task.goal && task.goal !== task.title)
    console.log(`  ${DM}Goal:${R}     ${task.goal}`);
  if (task.agents?.length)
    console.log(`  ${DM}Agents:${R}   ${task.agents.join(', ')}`);
  if (task.schedule)
    console.log(`  ${DM}Schedule:${R} ${task.schedule}`);
  if (task.createdAt)
    console.log(`  ${DM}Created:${R}  ${new Date(task.createdAt).toLocaleString()}`);

  // Result
  if (task.result) {
    const r = task.result;
    console.log();
    if (r.ok) {
      console.log(`  ${GR}${B}Result: SUCCESS${R}`);
      if (r.summary) console.log(`  ${r.summary.slice(0, 300)}`);
    } else {
      console.log(`  ${RD}${B}Result: FAILED${R}`);
      if (r.error) console.log(`  ${RD}${r.error.slice(0, 300)}${R}`);
    }
    if (r.stats) {
      const s = r.stats;
      const pct = s.actionsTotal ? Math.round((s.actionsOk / s.actionsTotal) * 100) : 0;
      console.log(`  ${DM}Actions: ${s.actionsOk}/${s.actionsTotal} ok (${pct}%)  Steps: ${r.totalSteps || '?'}  Duration: ${duration(r.duration)}${R}`);
    }
  }

  // Reasoning chain summary
  if (task.result?.reasoning?.length) {
    console.log(`\n  ${B}Reasoning chain${R} (${task.result.reasoning.length} steps):`);
    for (const step of task.result.reasoning.slice(-10)) {
      const acts = (step.actions || []).map(a =>
        `${a.ok ? GR : RD}${a.type || a.action}${R}`
      ).join(', ');
      console.log(`  ${DM}Step ${step.step}:${R} ${step.intent || '?'}${acts ? ` [${acts}]` : ''}`);
      if (step.outcome) console.log(`    ${GY}→ ${step.outcome.slice(0, 120)}${R}`);
    }
  }

  // History
  if (task.history?.length) {
    console.log(`\n  ${DM}History (last 5):${R}`);
    for (const h of task.history.slice(-5)) {
      console.log(`  ${GY}${new Date(h.ts).toLocaleTimeString()} ${h.event}: ${(h.detail || '').slice(0, 80)}${R}`);
    }
  }
  console.log();
}

async function _taskLog(id) {
  const task = await _resolveTask(id);
  if (!task) return;
  const reasoning = task.result?.reasoning;
  if (!reasoning?.length) { console.log(`${DM}No reasoning chain for this task${R}`); return; }
  console.log(`\n${B}Reasoning chain for ${task.title}${R} (${reasoning.length} steps)\n`);
  for (const step of reasoning) {
    console.log(`${B}Step ${step.step}${R}: ${step.intent || ''}`);
    if (step.actions?.length) {
      for (const a of step.actions) {
        const icon = a.ok ? `${GR}✓${R}` : `${RD}✗${R}`;
        console.log(`  ${icon} ${a.type || a.action} ${a.ok ? '' : RD + (a.error || '') + R}`);
      }
    }
    if (step.outcome) console.log(`  ${GY}→ ${step.outcome}${R}`);
    console.log();
  }
}

async function _resolveTask(idPrefix) {
  try {
    const tasks = await apiGet('/api/tasks');
    const match = tasks.find(t => t.id === idPrefix || t.id.startsWith(idPrefix));
    if (!match) {
      // Try fetching directly in case it's a full ID
      try { return await apiGet(`/api/tasks/${idPrefix}`); } catch (_) {}
      console.log(`${RD}No task matching "${idPrefix}"${R}`);
      return null;
    }
    // Fetch full detail
    return await apiGet(`/api/tasks/${match.id}`);
  } catch (e) {
    console.log(`${RD}Failed: ${e.message}${R}`);
    return null;
  }
}

// ── Project sub-command implementations ─────────────────────────────────

async function _projectCreate(name) {
  if (!name) { console.log(`${DM}Usage: /project create <name>${R}`); return; }
  try {
    const project = await apiPost('/api/projects', { name });
    _currentProjectId = project.id;
    _currentProjectName = project.name;
    console.log(`${GR}Created and selected project ${shortId(project.id)}${R}: ${project.name}`);
  } catch (e) { console.log(`${RD}Failed: ${e.message}${R}`); }
}

async function _projectUse(id) {
  if (!id) { console.log(`${DM}Usage: /project use <id>${R}`); return; }
  const project = await _resolveProject(id);
  if (!project) return;
  _currentProjectId = project.id;
  _currentProjectName = project.name;
  await apiPost('/api/projects/' + project.id + '/touch').catch(() => {});
  console.log(`${GR}Project → ${project.name}${R} ${DM}(${shortId(project.id)})${R}`);
}

function _projectClear() {
  _currentProjectId = null;
  _currentProjectName = null;
  console.log(`${DM}Project cleared${R}`);
}

async function _projectDetail(id) {
  const project = await _resolveProject(id);
  if (!project) return;
  console.log(`\n  ${B}${project.name}${R}`);
  console.log(`  ${DM}ID:${R}          ${project.id}`);
  if (project.description) console.log(`  ${DM}Description:${R} ${project.description}`);
  if (project.rootPath) console.log(`  ${DM}Root:${R}        ${project.rootPath}`);
  console.log(`  ${DM}Sources:${R}     ${(project.sources || []).length}`);
  for (const s of project.sources || []) {
    const label = s.path || s.url || s.repo || '';
    console.log(`    ${CY}${shortId(s.id)}${R} ${s.type} ${s.name || ''} ${GY}${label}${R}`);
  }
  console.log(`  ${DM}Contexts:${R}    ${(project.contexts || []).length}`);
  console.log(`  ${DM}Conversations:${R} ${(project.conversationIds || []).length}`);
  console.log();
}

async function _projectAddSource(id, sourcePath) {
  if (!id || !sourcePath) { console.log(`${DM}Usage: /project source <projectId> <localPath>${R}`); return; }
  const project = await _resolveProject(id);
  if (!project) return;
  const abs = path.resolve(sourcePath.replace(/^~/, os.homedir()));
  try {
    const source = await apiPost('/api/projects/' + project.id + '/sources', { type: 'local', path: abs });
    console.log(`${GR}Added source ${shortId(source.id)}${R}: ${source.path || source.name}`);
  } catch (e) { console.log(`${RD}Failed: ${e.message}${R}`); }
}

async function _projectSync(id, sourceId) {
  if (!id || !sourceId) { console.log(`${DM}Usage: /project sync <projectId> <sourceId>${R}`); return; }
  const project = await _resolveProject(id);
  if (!project) return;
  const source = (project.sources || []).find(s => s.id === sourceId || s.id.startsWith(sourceId));
  if (!source) { console.log(`${RD}No source matching "${sourceId}"${R}`); return; }
  try {
    const updated = await apiPost('/api/projects/' + project.id + '/sources/' + source.id + '/sync');
    console.log(`${GR}Synced source ${shortId(updated.id)}${R}: ${updated.name || updated.path || updated.url}`);
  } catch (e) { console.log(`${RD}Failed: ${e.message}${R}`); }
}

async function _resolveProject(idPrefix) {
  try {
    const projects = await apiGet('/api/projects');
    const match = projects.find(p => p.id === idPrefix || p.id.startsWith(idPrefix) || (p.name || '').toLowerCase() === idPrefix.toLowerCase());
    if (!match) {
      try { return await apiGet('/api/projects/' + idPrefix); } catch (_) {}
      console.log(`${RD}No project matching "${idPrefix}"${R}`);
      return null;
    }
    return await apiGet('/api/projects/' + match.id);
  } catch (e) {
    console.log(`${RD}Failed: ${e.message}${R}`);
    return null;
  }
}

// ── MCP sub-command implementations ─────────────────────────────────────

function _okLabel(ok) { return ok ? `${GR}connected${R}` : `${DM}offline${R}`; }
function _runLabel(ok) { return ok ? `${GR}running${R}` : `${DM}stopped${R}`; }

async function _mcpStatus() {
  try {
    const [fauna, ext, legacyFigma, devFigma, playwright, custom] = await Promise.all([
      apiGet('/api/faunamcp/status').catch(e => ({ error: e.message })),
      apiGet('/api/ext/status').catch(e => ({ error: e.message })),
      apiGet('/api/figma/mcp-status').catch(e => ({ error: e.message })),
      apiGet('/api/figma-mcp/status').catch(e => ({ error: e.message })),
      apiGet('/api/playwright-mcp/status').catch(e => ({ error: e.message })),
      apiGet('/api/custom-mcp-servers').catch(e => ({ error: e.message })),
    ]);

    console.log(`\n  ${B}MCP Status${R}`);
    console.log(`  ${DM}${'─'.repeat(58)}${R}`);
    console.log(`  FaunaMCP relay       ${_okLabel(!!fauna.connected)} ${GY}${fauna.url || ''}${R} ${fauna.toolCount != null ? `${DM}${fauna.toolCount} tools${R}` : ''}`);
    console.log(`  Browser bridge       ${_okLabel(!!ext.connected)} ${(ext.browsers || []).map(b => `${b.browser}${b.source ? '/' + b.source : ''}`).join(', ')}`);
    console.log(`  Figma relay plugin   ${_runLabel(!!legacyFigma.running)} ${legacyFigma.pid ? `${DM}pid ${legacyFigma.pid}${R}` : ''}`);
    console.log(`  Figma Dev Mode MCP   ${_okLabel(!!devFigma.connected)} ${devFigma.toolCount != null ? `${DM}${devFigma.toolCount} tools${R}` : devFigma.error ? RD + devFigma.error + R : ''}`);
    console.log(`  Playwright MCP       ${_runLabel(!!playwright.running)} ${playwright.installed === false ? RD + 'not installed' + R : ''} ${playwright.toolCount != null ? `${DM}${playwright.toolCount} tools${R}` : ''}`);
    if (Array.isArray(custom) && custom.length) {
      console.log(`\n  ${B}Custom MCP servers${R}`);
      for (const s of custom) {
        console.log(`  ${CY}${shortId(s.id)}${R} ${(s.name || '').padEnd(22)} ${_runLabel(!!s.running)} ${GY}${s.transport || ''} ${s.command || s.url || ''}${R}`);
      }
    } else {
      console.log(`\n  ${DM}No custom MCP servers configured${R}`);
    }
    console.log();
  } catch (e) { console.log(`${RD}Failed: ${e.message}${R}`); }
}

async function _mcpStart(id) {
  if (!id) { console.log(`${DM}Usage: /mcp start <id>${R}`); return; }
  const server = await _resolveCustomMcp(id);
  if (!server) return;
  try {
    const res = await apiPost('/api/custom-mcp-servers/' + server.id + '/start');
    console.log(`${GR}Started ${server.name}${R} ${res.pid ? `${DM}pid ${res.pid}${R}` : ''}`);
  } catch (e) { console.log(`${RD}Failed: ${e.message}${R}`); }
}

async function _mcpStop(id) {
  if (!id) { console.log(`${DM}Usage: /mcp stop <id>${R}`); return; }
  const server = await _resolveCustomMcp(id);
  if (!server) return;
  try {
    await apiPost('/api/custom-mcp-servers/' + server.id + '/stop');
    console.log(`${YL}Stopped ${server.name}${R}`);
  } catch (e) { console.log(`${RD}Failed: ${e.message}${R}`); }
}

async function _mcpLogs(id) {
  if (!id) { console.log(`${DM}Usage: /mcp logs <id>${R}`); return; }
  const server = await _resolveCustomMcp(id);
  if (!server) return;
  try {
    const data = await apiGet('/api/custom-mcp-servers/' + server.id + '/logs');
    const logs = data.logs || [];
    if (!logs.length) { console.log(`${DM}No logs for ${server.name}${R}`); return; }
    for (const l of logs.slice(-40)) console.log(`${GY}${new Date(l.t).toLocaleTimeString()} ${l.s}:${R} ${l.m}`);
  } catch (e) { console.log(`${RD}Failed: ${e.message}${R}`); }
}

async function _resolveCustomMcp(idPrefix) {
  try {
    const servers = await apiGet('/api/custom-mcp-servers');
    const match = servers.find(s => s.id === idPrefix || s.id.startsWith(idPrefix) || (s.name || '').toLowerCase() === idPrefix.toLowerCase());
    if (!match) console.log(`${RD}No custom MCP matching "${idPrefix}"${R}`);
    return match || null;
  } catch (e) {
    console.log(`${RD}Failed: ${e.message}${R}`);
    return null;
  }
}

// ── Agent Store sub-command implementations ─────────────────────────────

function _storeAgentName(agent) {
  return agent.displayName || agent.name || agent.slug || 'Untitled';
}

async function _storeSearch(query) {
  try {
    const qs = new URLSearchParams({ page: '1' });
    if (query && query.trim()) qs.set('q', query.trim());
    const data = await apiGet('/api/store/agents?' + qs.toString());
    const agents = data.agents || data.data || data || [];
    if (!Array.isArray(agents) || !agents.length) { console.log(`${DM}No store agents found${R}`); return; }
    console.log(`\n  ${B}${'Slug'.padEnd(24)} ${'Name'.padEnd(28)} ${'Score'.padEnd(7)} Downloads${R}`);
    console.log(`  ${DM}${'─'.repeat(78)}${R}`);
    for (const a of agents.slice(0, 25)) {
      const slug = a.slug || a.name || '';
      const score = a.scanScore ?? a.scan_score ?? '—';
      const downloads = a.downloads ?? a.installCount ?? a.install_count ?? 0;
      console.log(`  ${CY}${slug.slice(0,23).padEnd(24)}${R} ${_storeAgentName(a).slice(0,27).padEnd(28)} ${String(score).padEnd(7)} ${GY}${downloads}${R}`);
    }
    console.log(`\n  ${DM}Use /store show <slug> or /store install <slug>${R}\n`);
  } catch (e) { console.log(`${RD}Failed: ${e.message}${R}`); }
}

async function _storeCategories() {
  try {
    const data = await apiGet('/api/store/categories');
    const categories = data.categories || data.data || data || [];
    if (!Array.isArray(categories) || !categories.length) { console.log(`${DM}No categories found${R}`); return; }
    for (const c of categories) console.log(`  ${CY}${c.slug || c.id || c.name}${R} ${c.name || ''}`);
  } catch (e) { console.log(`${RD}Failed: ${e.message}${R}`); }
}

async function _storeShow(slug) {
  if (!slug) { console.log(`${DM}Usage: /store show <slug>${R}`); return; }
  try {
    const a = await apiGet('/api/store/agents/' + encodeURIComponent(slug));
    console.log(`\n  ${B}${_storeAgentName(a)}${R}`);
    console.log(`  ${DM}Slug:${R}      ${a.slug || slug}`);
    if (a.version) console.log(`  ${DM}Version:${R}   ${a.version}`);
    if (a.author?.name) console.log(`  ${DM}Author:${R}    ${a.author.name}${a.author.verified ? ' ✓' : ''}`);
    if (a.category?.name || a.category) console.log(`  ${DM}Category:${R}  ${a.category.name || a.category}`);
    console.log(`  ${DM}Score:${R}     ${a.scanScore ?? a.scan_score ?? '—'}`);
    console.log(`  ${DM}Downloads:${R} ${a.downloads ?? a.installCount ?? a.install_count ?? 0}`);
    if (a.description) console.log(`\n${renderMarkdown(String(a.description).slice(0, 1200))}`);
    console.log(`\n  ${DM}Install with:${R} ${CY}/store install ${a.slug || slug}${R}\n`);
  } catch (e) { console.log(`${RD}Failed: ${e.message}${R}`); }
}

async function _storeInstall(slug) {
  if (!slug) { console.log(`${DM}Usage: /store install <slug>${R}`); return; }
  try {
    console.log(`${DM}Downloading ${slug}…${R}`);
    const zipRes = await fetch(`${API}/api/store/agents/${encodeURIComponent(slug)}/zip`);
    if (!zipRes.ok) throw new Error(`${zipRes.status}: ${await zipRes.text()}`);
    const zip = Buffer.from(await zipRes.arrayBuffer());

    const importOnce = async (force) => {
      const res = await fetch(`${API}/api/agents/import${force ? '?force=1' : ''}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/zip' },
        body: zip,
      });
      const data = await res.json().catch(() => ({}));
      return { res, data };
    };

    let { res, data } = await importOnce(false);
    if (!res.ok && (res.status === 409 || String(data.error || '').includes('already exists'))) {
      console.log(`${YL}${data.error || 'Agent already exists'}${R}`);
      console.log(`${DM}Reinstalling with overwrite…${R}`);
      ({ res, data } = await importOnce(true));
    }
    if (!res.ok || data.error) throw new Error(data.error || `Import failed (${res.status})`);

    await apiPost('/api/agents/' + encodeURIComponent(data.name) + '/meta', {
      storeSlug: slug,
      installedFromStore: true,
      installedAt: new Date().toISOString(),
      storeVersion: '1.0',
      installedBy: 'cli',
    }).catch(() => {});

    console.log(`${GR}Installed ${data.displayName || data.name}${R} ${DM}(${data.name})${R}`);
    console.log(`${DM}Use it with:${R} ${CY}/agent ${data.name}${R}`);
  } catch (e) { console.log(`${RD}Install failed: ${e.message}${R}`); }
}

// ── Helpers ──────────────────────────────────────────────────────────────

function _version() {
  try { return JSON.parse(fs.readFileSync(path.join(__dirname, 'package.json'), 'utf8')).version; }
  catch (_) { return '?'; }
}

function _setVerbose(v) { VERBOSE = v; }

// ── Stdin pipe detection ─────────────────────────────────────────────────

function readStdin() {
  return new Promise((resolve) => {
    if (process.stdin.isTTY) { resolve(null); return; }
    let data = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', chunk => { data += chunk; });
    process.stdin.on('end', () => resolve(data.trim() || null));
    // Timeout in case stdin hangs
    setTimeout(() => resolve(data.trim() || null), 1000);
  });
}

// ── REPL ─────────────────────────────────────────────────────────────────

var _rl = null;  // module-level ref so server logs can refresh prompt

// Call after any async console.log to redraw the prompt
function refreshPrompt() {
  if (_rl) { _rl.prompt(true); }
}
process._refreshCliPrompt = refreshPrompt;

function startRepl() {
  const rl = createInterface({
    input: process.stdin,
    output: process.stdout,
    prompt: `${CY}fauna ▸${R} `,
    historySize: 500,
    completer: (line) => {
      const cmds = Object.keys(COMMANDS);
      const hits = cmds.filter(c => c.startsWith(line));
      return [hits.length ? hits : cmds, line];
    },
  });
  _rl = rl;

  // Listen for browser extension push events (snapshot, send-page, selection)
  process.on('ext:event', (msg) => {
    const d = msg.data || {};
    const browser = msg.browser || 'Browser';

    if (msg.event === 'user:send-page') {
      const title = d.title || d.url || browser + ' page';
      const short = title.length > 45 ? title.slice(0, 42) + '…' : title;
      const content = (d.url ? 'Source: ' + d.url + '\n' : '') +
                      (d.title ? 'Title: ' + d.title + '\n\n' : '') +
                      (d.text || '');
      _attachments.push({ type: 'url', name: browser + ': ' + short, content });
      console.log(`\n${GR}  ✦ Page from ${browser} attached${R} — ${short}`);
      console.log(`${DM}  Type your question to include it${R}`);
      refreshPrompt();
    }

    if (msg.event === 'user:snapshot') {
      if (!d.base64) return;
      const snapTitle = d.title || d.url || browser + ' tab';
      const short = snapTitle.length > 40 ? snapTitle.slice(0, 37) + '…' : snapTitle;
      // Store as image attachment for the chat API
      _attachments.push({ type: 'image', name: 'Snapshot — ' + short, base64: d.base64, mime: d.mime || 'image/png' });
      console.log(`\n${GR}  ✦ Snapshot from ${browser} attached${R} — ${short}`);
      console.log(`${DM}  Type your question to include it${R}`);
      refreshPrompt();
    }

    if (msg.event === 'user:selection') {
      if (!d.text) return;
      let domain = '';
      try { domain = ' · ' + new URL(d.url).hostname; } catch (_) {}
      const content = (d.url ? 'Source: ' + d.url + '\n' : '') +
                      (d.title ? 'Page: ' + d.title + '\n\n' : '') +
                      'Selected text:\n' + d.text;
      _attachments.push({ type: 'url', name: 'Selection from ' + browser + domain, content });
      console.log(`\n${GR}  ✦ Selection from ${browser} attached${R}${domain}`);
      console.log(`${DM}  Type your question to include it${R}`);
      refreshPrompt();
    }
  });

  rl.prompt();

  rl.on('line', async (line) => {
    const input = line.trim();
    if (!input) { rl.prompt(); return; }

    // Check for REPL commands
    const spaceIdx = input.indexOf(' ');
    const cmd = (spaceIdx > 0 ? input.slice(0, spaceIdx) : input).toLowerCase();
    const rest = spaceIdx > 0 ? input.slice(spaceIdx + 1) : '';

    if (COMMANDS[cmd]) {
      try { await COMMANDS[cmd](rest); }
      catch (e) { console.log(`${RD}Error: ${e.message}${R}`); }
      rl.prompt();
      return;
    }

    // Build message with attachments
    let message = input;
    let pendingImages = [];
    if (_attachments.length) {
      const textAtts = _attachments.filter(a => a.type !== 'image');
      const imgAtts = _attachments.filter(a => a.type === 'image');
      if (textAtts.length) {
        const atts = textAtts.map(a => `\n\n---\nFile: ${a.name}\n\`\`\`\n${a.content}\n\`\`\``).join('');
        message = input + atts;
      }
      pendingImages = imgAtts;
      _attachments = [];
    }

    // If there are images, convert the user message to multipart vision format
    // (same format the web UI uses: [{type:'text', text:...}, {type:'image_url', image_url:{url:'data:...'}}])
    const userContent = pendingImages.length
      ? [
          { type: 'text', text: message },
          ...pendingImages.map(img => ({
            type: 'image_url',
            image_url: { url: `data:${img.mime || 'image/png'};base64,${img.base64}`, detail: 'high' }
          }))
        ]
      : undefined;

    // Chat message
    try {
      process.stdout.write(`\n${MG}fauna:${R} `);
      const response = await chat(message, { model: _currentModel, agent: _currentAgent, userContent });
    } catch (e) {
      console.log(`${RD}Error: ${e.message}${R}`);
    }
    console.log();
    rl.prompt();
  });

  rl.on('close', () => {
    console.log(`\n${DM}bye${R}`);
    process.exit(0);
  });
}

// ── Main ─────────────────────────────────────────────────────────────────

async function main() {
  await printBanner();

  try {
    // Expose chat debug logs to stdout only in verbose mode
    if (VERBOSE) process.env.FAUNA_CHAT_DEBUG = '1';
    ({ startServer } = await import('./server.js'));
    await startServer(PORT);
  } catch (e) {
    if (e.code === 'EADDRINUSE') {
      console.error(`${RD}  Port ${PORT} is in use. Is Fauna already running?${R}`);
      console.error(`${DM}  Try: --port <number>${R}`);
      process.exit(1);
    }
    throw e;
  }

  // Pipe mode: read from stdin
  const piped = await readStdin();
  if (piped && !ONE_SHOT) {
    try {
      process.stdout.write(`${MG}fauna:${R} `);
      await chat(piped, { model: _currentModel, agent: _currentAgent });
    } catch (e) {
      console.error(`${RD}Error: ${e.message}${R}`);
      process.exit(1);
    }
    process.exit(0);
  }

  // One-shot mode: send query, print result, exit
  if (ONE_SHOT) {
    try {
      process.stdout.write(`${MG}fauna:${R} `);
      await chat(ONE_SHOT);
    } catch (e) {
      console.error(`${RD}Error: ${e.message}${R}`);
      process.exit(1);
    }
    process.exit(0);
  }

  // Server-only mode
  if (SERVER_ONLY) {
    console.log(`${DM}  Server-only mode. Press Ctrl+C to stop.${R}\n`);
    return;
  }

  // Interactive REPL
  console.log(`${DM}  Type /help for commands, /quit to exit${R}\n`);
  startRepl();
}

main().catch(e => {
  console.error(`${RD}Fatal: ${e.message}${R}`);
  process.exit(1);
});
