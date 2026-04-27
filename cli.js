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

import { startServer } from './server.js';
import { createInterface } from 'readline';
import path from 'path';
import os from 'os';
import fs from 'fs';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ── Arg parsing ───────────────────────────────────────────────────────────

const args = process.argv.slice(2);
function flag(name)       { return args.includes(name); }
function option(name, fb) { const i = args.indexOf(name); return i >= 0 && args[i+1] ? args[i+1] : fb; }

const PORT        = parseInt(option('--port', '3737'), 10);
const SERVER_ONLY = flag('--server') || flag('-s');
const ONE_SHOT    = option('-q', null) || option('--query', null);
const SHOW_HELP   = flag('--help') || flag('-h');
let   VERBOSE     = flag('--verbose') || flag('-v');

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

// ── Chat streaming (calls the local server's SSE endpoint) ───────────────

async function chat(message, { model, agent, attachments } = {}) {
  const url = `${API}/api/chat`;

  // Build messages array from history + current message
  const messages = [
    ..._history,
    { role: 'user', content: message },
  ];

  const body = {
    messages,
    ...(model && { model }),
    ...(agent && { agentName: agent }),
    ...(attachments && attachments.length && { attachments }),
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
            process.stdout.write(evt.content);
            fullContent += evt.content;
            break;
          case 'tool_call':
            if (VERBOSE) process.stdout.write(`\n${DM}⚙ calling ${CY}${evt.name}${R}${DM}…${R}\n`);
            break;
          case 'tool_output':
            if (VERBOSE) {
              const out = (evt.output || '').slice(0, 200);
              process.stdout.write(`${GY}${out}${R}`);
            }
            break;
          case 'tool_waiting_for_input':
            process.stdout.write(`\n${YL}⏳ Waiting for input: ${evt.hint || 'stdin'}${R}\n`);
            // In interactive mode the user can type; in pipe mode this is informational
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

  if (fullContent) {
    process.stdout.write('\n');
    _history.push({ role: 'user', content: message });
    _history.push({ role: 'assistant', content: fullContent });
    if (_history.length > 40) _history = _history.slice(-30);
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
let _attachments = [];  // pending file attachments

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

// ── Terminal QR code renderer (no deps, uses qrcode-generator algorithm) ─

function renderTerminalQR(text) {
  // Minimal QR encoder — generates a version-appropriate QR code in the terminal
  // using Unicode block characters (▀▄█ ) to render 2 rows per line.
  // We shell out to a tiny inline Node script to avoid pulling in a dependency.
  // Uses the simple alphanumeric-safe approach: encode as a data URL via the API.

  // Actually — use the simplest possible approach: render a text-based QR code
  // by generating it with the built-in crypto module's randomness + a compact
  // QR encoding library. Since we can't import one, we'll use a different trick:
  // call the system's python3 qrcode or use a pure-JS fallback.

  // Best approach: use a compact QR Code generator in pure JS.
  const modules = qrEncode(text);
  if (!modules) { console.log(`${DM}  (QR generation failed — connect manually)${R}`); return; }

  const size = modules.length;
  // Use Unicode half-blocks to fit 2 QR rows into 1 terminal line
  // ▀ = top black, bottom white   ▄ = top white, bottom black
  // █ = both black                 ' ' = both white
  // In terminal: white QR on dark background, with quiet zone
  const BLK = `${T3}█${R}`;  // teal blocks for the QR
  const WHT = ' ';

  // Add quiet zone (2 modules)
  const q = 2;
  const full = size + q * 2;

  const get = (r, c) => {
    const rr = r - q, cc = c - q;
    if (rr < 0 || cc < 0 || rr >= size || cc >= size) return false;
    return modules[rr][cc];
  };

  const lines = [];
  for (let r = 0; r < full; r += 2) {
    let line = '  '; // left margin
    for (let c = 0; c < full; c++) {
      const top = get(r, c);
      const bot = get(r + 1, c);
      if (top && bot) line += BLK;
      else if (top && !bot) line += `${T3}▀${R}`;
      else if (!top && bot) line += `${T3}▄${R}`;
      else line += WHT;
    }
    lines.push(line);
  }
  console.log(lines.join('\n'));
}

// ── Minimal QR Code encoder (Version 1-6, byte mode, ECC-L) ─────────────
// Compact implementation sufficient for fauna://pair URLs (~80 chars).

function qrEncode(data) {
  const bytes = Buffer.from(data, 'utf8');
  const len = bytes.length;

  // Version capacity table (byte mode, ECC level L)
  const caps = [0, 17, 32, 53, 78, 106, 134, 154, 192, 230, 271, 321, 367, 425, 458, 520, 586];
  let ver = 1;
  while (ver <= 16 && caps[ver] < len) ver++;
  if (ver > 16) return null; // too long

  const size = ver * 4 + 17;
  const grid = Array.from({ length: size }, () => new Uint8Array(size));
  const mask = Array.from({ length: size }, () => new Uint8Array(size)); // 1 = reserved

  // ── Finder patterns ──────────────────────────────────────────────
  function setFinder(row, col) {
    for (let r = -1; r <= 7; r++) {
      for (let c = -1; c <= 7; c++) {
        const rr = row + r, cc = col + c;
        if (rr < 0 || cc < 0 || rr >= size || cc >= size) continue;
        const inOuter = r === 0 || r === 6 || c === 0 || c === 6;
        const inInner = r >= 2 && r <= 4 && c >= 2 && c <= 4;
        grid[rr][cc] = (inOuter || inInner) ? 1 : 0;
        mask[rr][cc] = 1;
      }
    }
  }
  setFinder(0, 0);
  setFinder(0, size - 7);
  setFinder(size - 7, 0);

  // ── Timing patterns ──────────────────────────────────────────────
  for (let i = 8; i < size - 8; i++) {
    grid[6][i] = grid[i][6] = (i % 2 === 0) ? 1 : 0;
    mask[6][i] = mask[i][6] = 1;
  }

  // ── Alignment patterns (version >= 2) ────────────────────────────
  const alignPos = [
    [], [6,18], [6,22], [6,26], [6,30], [6,34], [6,22,38],
    [6,24,42], [6,26,46], [6,28,50], [6,30,54], [6,32,58],
    [6,34,62], [6,26,46,66], [6,26,48,70], [6,26,50,74], [6,30,54,78],
  ];
  if (ver >= 2) {
    const positions = alignPos[ver - 1] || [];
    for (const r of positions) {
      for (const c of positions) {
        if (mask[r][c]) continue; // skip if overlaps finder
        for (let dr = -2; dr <= 2; dr++) {
          for (let dc = -2; dc <= 2; dc++) {
            const inBorder = Math.abs(dr) === 2 || Math.abs(dc) === 2;
            const isCenter = dr === 0 && dc === 0;
            grid[r + dr][c + dc] = (inBorder || isCenter) ? 1 : 0;
            mask[r + dr][c + dc] = 1;
          }
        }
      }
    }
  }

  // ── Reserve format info areas ────────────────────────────────────
  for (let i = 0; i < 8; i++) {
    mask[8][i] = mask[i][8] = 1;
    mask[8][size - 1 - i] = mask[size - 1 - i][8] = 1;
  }
  mask[8][8] = 1;
  grid[size - 8][8] = 1; mask[size - 8][8] = 1; // dark module

  // ── Reserve version info (ver >= 7) ──────────────────────────────
  if (ver >= 7) {
    for (let i = 0; i < 6; i++) for (let j = 0; j < 3; j++) {
      mask[i][size - 11 + j] = mask[size - 11 + j][i] = 1;
    }
  }

  // ── Data encoding (byte mode, ECC level L) ──────────────────────
  // ECC codewords per version (level L)
  const eccL = [0,7,10,15,20,26,18,20,24,30,18,20,24,26,30,22,24];
  const totalCW = [0,26,44,70,100,134,172,196,242,292,346,404,466,532,581,655,733];
  const numEcc = eccL[ver];
  const numData = totalCW[ver] - numEcc;

  // Build data bits
  let bits = '';
  // Mode indicator: byte = 0100
  bits += '0100';
  // Character count (8 bits for ver 1-9, 16 for 10+)
  const ccBits = ver <= 9 ? 8 : 16;
  bits += len.toString(2).padStart(ccBits, '0');
  for (const b of bytes) bits += b.toString(2).padStart(8, '0');
  // Terminator
  bits += '0000'.slice(0, Math.min(4, numData * 8 - bits.length));
  // Byte-align
  while (bits.length % 8) bits += '0';
  // Pad bytes
  const pads = ['11101100', '00010001'];
  let pi = 0;
  while (bits.length < numData * 8) { bits += pads[pi]; pi ^= 1; }

  const dataBytes = [];
  for (let i = 0; i < bits.length; i += 8) dataBytes.push(parseInt(bits.slice(i, i + 8), 2));

  // ── Reed-Solomon ECC ─────────────────────────────────────────────
  const eccBytes = rsEncode(dataBytes, numEcc);
  const allBytes = [...dataBytes, ...eccBytes];

  // ── Place data bits ──────────────────────────────────────────────
  let bitIdx = 0;
  const dataBits = allBytes.map(b => b.toString(2).padStart(8, '0')).join('');

  for (let right = size - 1; right >= 1; right -= 2) {
    if (right === 6) right = 5; // skip timing column
    for (let vert = 0; vert < size; vert++) {
      for (let j = 0; j < 2; j++) {
        const col = right - j;
        const row = ((Math.floor((size - 1 - right + (right < 6 ? 1 : 0)) / 2)) % 2 === 0)
          ? size - 1 - vert : vert;
        if (col < 0 || col >= size || row < 0 || row >= size) continue;
        if (mask[row][col]) continue;
        grid[row][col] = (bitIdx < dataBits.length) ? parseInt(dataBits[bitIdx++]) : 0;
      }
    }
  }

  // ── Apply mask pattern 0 (checkerboard: (row + col) % 2 === 0) ──
  for (let r = 0; r < size; r++) {
    for (let c = 0; c < size; c++) {
      if (!mask[r][c] && (r + c) % 2 === 0) grid[r][c] ^= 1;
    }
  }

  // ── Format info (ECC L = 01, mask 0 = 000 → 01000, with BCH) ───
  const fmtBits = [1,0,1,0,1,0,0,0,0,0,1,0,0,1,0]; // pre-computed for L/mask0
  // Place format info
  const fmtPos1 = [[8,0],[8,1],[8,2],[8,3],[8,4],[8,5],[8,7],[8,8],[7,8],[5,8],[4,8],[3,8],[2,8],[1,8],[0,8]];
  const fmtPos2 = [[size-1,8],[size-2,8],[size-3,8],[size-4,8],[size-5,8],[size-6,8],[size-7,8],[8,size-8],[8,size-7],[8,size-6],[8,size-5],[8,size-4],[8,size-3],[8,size-2],[8,size-1]];
  for (let i = 0; i < 15; i++) {
    grid[fmtPos1[i][0]][fmtPos1[i][1]] = fmtBits[i];
    grid[fmtPos2[i][0]][fmtPos2[i][1]] = fmtBits[i];
  }

  // ── Version info (ver >= 7) ──────────────────────────────────────
  if (ver >= 7) {
    const vInfo = computeVersionInfo(ver);
    let bi = 0;
    for (let i = 0; i < 6; i++) for (let j = 0; j < 3; j++) {
      const bit = (vInfo >> bi++) & 1;
      grid[i][size - 11 + j] = bit;
      grid[size - 11 + j][i] = bit;
    }
  }

  return grid.map(row => Array.from(row));
}

// GF(256) Reed-Solomon encoder
function rsEncode(data, numEcc) {
  // GF(256) with polynomial 0x11d
  const exp = new Uint8Array(512);
  const log = new Uint8Array(256);
  let v = 1;
  for (let i = 0; i < 255; i++) { exp[i] = v; log[v] = i; v = (v << 1) ^ (v >= 128 ? 0x11d : 0); }
  for (let i = 255; i < 512; i++) exp[i] = exp[i - 255];

  const gmul = (a, b) => (a === 0 || b === 0) ? 0 : exp[log[a] + log[b]];

  // Generator polynomial
  let gen = [1];
  for (let i = 0; i < numEcc; i++) {
    const ng = new Array(gen.length + 1).fill(0);
    for (let j = 0; j < gen.length; j++) {
      ng[j] ^= gen[j];
      ng[j + 1] ^= gmul(gen[j], exp[i]);
    }
    gen = ng;
  }

  const result = new Uint8Array(numEcc);
  const work = new Uint8Array(numEcc);
  for (const b of data) {
    const fb = b ^ work[0];
    for (let i = 0; i < numEcc - 1; i++) work[i] = work[i + 1] ^ gmul(fb, gen[i + 1]);
    work[numEcc - 1] = gmul(fb, gen[numEcc]);
  }
  for (let i = 0; i < numEcc; i++) result[i] = work[i];
  return Array.from(result);
}

function computeVersionInfo(ver) {
  let d = ver;
  for (let i = 0; i < 12; i++) d = (d << 1) ^ ((d >> 11) ? 0x1F25 : 0);
  return (ver << 12) | d;
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

${B}Tasks${R}
  ${CY}/tasks${R}                list all tasks
  ${CY}/task${R} <id>            show task detail + result + reasoning
  ${CY}/task create${R} <desc>   create a new task
  ${CY}/task run${R} <id>        run a task
  ${CY}/task stop${R} <id>       stop a running task
  ${CY}/task steer${R} <id> msg  inject guidance into running task
  ${CY}/task delete${R} <id>     delete a task
  ${CY}/task log${R} <id>        show task reasoning chain

${B}Tools${R}
  ${CY}/browse${R} <url>         fetch & summarize a URL
  ${CY}/shell${R} <cmd>          run a shell command

${B}Mobile${R}
  ${CY}/pair${R}                 show QR code for mobile app pairing
  ${CY}/pair reset${R}           regenerate pairing token

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
        console.log(`  ${CY}${m}${R}`);
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
    console.log(`${DM}Conversation cleared${R}`);
  },

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
      renderTerminalQR(qrUrl);
      console.log();
      console.log(`  ${B}Scan this QR code${R} with the Fauna mobile app`);
      console.log(`  ${DM}or connect manually:${R}`);
      for (const ip of data.ips || []) {
        console.log(`    ${CY}${ip}:${data.port}${R}`);
      }
      console.log(`    ${DM}Token: ${data.token}${R}`);
      console.log();
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
    if (_attachments.length) {
      const atts = _attachments.map(a => `\n\n---\nFile: ${a.name}\n\`\`\`\n${a.content}\n\`\`\``).join('');
      message = input + atts;
      _attachments = [];
    }

    // Chat message
    try {
      process.stdout.write(`\n${MG}fauna:${R} `);
      const response = await chat(message, { model: _currentModel, agent: _currentAgent });
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
