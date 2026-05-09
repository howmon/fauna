/**
 * Copilot Chat — backend server
 * Streams GitHub Copilot responses via SSE, serves the chat UI, fetches URLs.
 */

import express    from 'express';
import OpenAI     from 'openai';
import { execSync, exec as _exec, execFile as _execFile } from 'child_process';
import crypto     from 'crypto';
import path       from 'path';
import os         from 'os';
import fs         from 'fs';
import { createRequire } from 'module';
import { fileURLToPath } from 'url';
import { checkFilePath, checkNetworkAccess, checkShellCommand, getSandboxedEnv, getResourceLimits, audit, getAuditLog } from './agent-sandbox.js';
import { getAgentTools, startAgentMCPServers, stopAgentMCPServers, executeBuiltInTool, executeCustomTool } from './agent-tools.js';
import { scanAgent, formatScanReport } from './agent-scanner.js';

// Electron APIs — available when server runs inside the Electron main process.
// Gracefully degrade if run standalone (e.g. during testing).
const _require = createRequire(import.meta.url);
let systemPreferences, desktopCapturer, powerSaveBlocker;
try {
  ({ systemPreferences, desktopCapturer, powerSaveBlocker } = _require('electron'));
} catch (_) {}

// Power-save blocker — keeps screen/CPU awake while any chat request is active.
let _psBlockerId = null;
let _psActiveCount = 0;
function _psAcquire() {
  _psActiveCount++;
  if (_psActiveCount === 1 && powerSaveBlocker && _psBlockerId === null) {
    _psBlockerId = powerSaveBlocker.start('prevent-display-sleep');
  }
}
function _psRelease() {
  _psActiveCount = Math.max(0, _psActiveCount - 1);
  if (_psActiveCount === 0 && powerSaveBlocker && _psBlockerId !== null) {
    try { powerSaveBlocker.stop(_psBlockerId); } catch (_) {}
    _psBlockerId = null;
  }
}

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app    = express();
const PORT   = 3737;
const IS_WIN = process.platform === 'win32';
const PATH_SEP = IS_WIN ? ';' : ':';

app.use(express.json({ limit: '25mb' }));
app.use(express.urlencoded({ limit: '25mb', extended: false }));
app.use(express.static(path.join(__dirname, 'public')));

// ── Token resolution ──────────────────────────────────────────────────────
// Electron runs with a stripped PATH so `gh` may not be found.
// Resolution order:
//   1. GH_TOKEN / GITHUB_TOKEN env var
//   2. macOS Keychain via /usr/bin/security (macOS only)
//   3. gh binary — searched in common install locations
//   4. ~/.config/gh/hosts.yml oauth_token field (non-keychain fallback)

function findGhBinary() {
  const candidates = IS_WIN ? [
    'C:\\Program Files\\GitHub CLI\\gh.exe',
    path.join(os.homedir(), 'AppData', 'Local', 'Programs', 'GitHub CLI', 'gh.exe'),
    path.join(os.homedir(), 'scoop', 'shims', 'gh.exe'),
  ] : [
    '/opt/homebrew/bin/gh',        // Apple Silicon Homebrew
    '/usr/local/bin/gh',           // Intel Homebrew
    '/usr/bin/gh',
    '/snap/bin/gh',
  ];
  // Also try PATH entries
  const binName = IS_WIN ? 'gh.exe' : 'gh';
  const pathDirs = (process.env.PATH || '').split(PATH_SEP);
  for (const dir of pathDirs) candidates.push(path.join(dir, binName));

  for (const p of candidates) {
    try { fs.accessSync(p, fs.constants.X_OK); return p; } catch (_) {}
  }
  return null;
}

function readTokenFromKeychain() {
  if (IS_WIN) return null;  // macOS Keychain not available on Windows
  // gh stores tokens as base64 in the macOS Keychain under service "gh:github.com"
  // /usr/bin/security is always available even in Electron's stripped PATH
  try {
    const raw = execSync(
      '/usr/bin/security find-generic-password -s "gh:github.com" -w',
      { encoding: 'utf8', stdio: ['pipe','pipe','pipe'] }
    ).trim();
    // gh encodes tokens as "go-keyring-base64:<base64>"
    if (raw.startsWith('go-keyring-base64:')) {
      return Buffer.from(raw.slice('go-keyring-base64:'.length), 'base64').toString('utf8').trim();
    }
    return raw;
  } catch (_) { return null; }
}

function readTokenFromConfig() {
  // Fallback: parse ~/.config/gh/hosts.yml for oauth_token
  try {
    const yml = fs.readFileSync(path.join(os.homedir(), '.config', 'gh', 'hosts.yml'), 'utf8');
    const match = yml.match(/oauth_token:\s*(\S+)/);
    return match ? match[1].trim() : null;
  } catch (_) { return null; }
}

// ── PAT config file ───────────────────────────────────────────────────────

const CONFIG_DIR   = path.join(os.homedir(), '.config', 'copilot-chat');
const CONFIG_FILE  = path.join(CONFIG_DIR, 'config.json');
const RECOVERY_DIR = path.join(os.homedir(), '.copilotchat-recovery');

function readSavedConfig() {
  try { return JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8')); }
  catch (_) { return {}; }
}

function writeSavedConfig(data) {
  fs.mkdirSync(CONFIG_DIR, { recursive: true });
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(data, null, 2));
}

function getGhToken() {
  // 0. User-saved PAT (highest priority — explicitly set by user in UI)
  const cfg = readSavedConfig();
  if (cfg.pat && cfg.pat.trim()) return cfg.pat.trim();

  // 1. Env vars
  if (process.env.GH_TOKEN)     return process.env.GH_TOKEN.trim();
  if (process.env.GITHUB_TOKEN) return process.env.GITHUB_TOKEN.trim();

  // 2. macOS Keychain (most reliable in Electron)
  const keychainToken = readTokenFromKeychain();
  if (keychainToken) return keychainToken;

  // 3. gh binary (fallback, may fail in Electron .app)
  const gh = findGhBinary();
  if (gh) {
    try {
      return execSync(`"${gh}" auth token`, { encoding: 'utf8', stdio: ['pipe','pipe','pipe'] }).trim();
    } catch (_) {}
  }

  // 4. Config file oauth_token
  const cfgToken = readTokenFromConfig();
  if (cfgToken) return cfgToken;

  throw new Error('GitHub token not found. Run: gh auth login');
}

function getCopilotClient() {
  const token = getGhToken();
  return new OpenAI({
    baseURL: 'https://api.githubcopilot.com',
    apiKey:  token,
    defaultHeaders: {
      'Editor-Version':        'vscode/1.85.0',
      'Copilot-Integration-Id': 'vscode-chat'
    }
  });
}

const FALLBACK_MODELS = [
  { id: 'claude-sonnet-4.6',     name: 'Claude Sonnet 4.6',     vendor: 'Anthropic', fast: false },
  { id: 'claude-sonnet-4.5',     name: 'Claude Sonnet 4.5',     vendor: 'Anthropic', fast: false },
  { id: 'claude-sonnet-4',       name: 'Claude Sonnet 4',       vendor: 'Anthropic', fast: false },
  { id: 'claude-haiku-4.5',      name: 'Claude Haiku 4.5',      vendor: 'Anthropic', fast: true  },
  { id: 'claude-opus-4.6',       name: 'Claude Opus 4.6',       vendor: 'Anthropic', fast: false },
  { id: 'claude-opus-4.6-1m',    name: 'Claude Opus 4.6 1M',    vendor: 'Anthropic', fast: false },
  { id: 'claude-opus-4.5',       name: 'Claude Opus 4.5',       vendor: 'Anthropic', fast: false },
  { id: 'gpt-4.1',               name: 'GPT-4.1',               vendor: 'OpenAI',    fast: false },
  { id: 'gpt-4.1-mini',          name: 'GPT-4.1 mini',          vendor: 'OpenAI',    fast: true  },
  { id: 'gpt-5-mini',            name: 'GPT-5 mini',            vendor: 'OpenAI',    fast: true  },
  { id: 'gpt-5.1',               name: 'GPT-5.1',               vendor: 'OpenAI',    fast: false },
  { id: 'gpt-5.2',               name: 'GPT-5.2',               vendor: 'OpenAI',    fast: false },
  { id: 'gpt-5.4',               name: 'GPT-5.4',               vendor: 'OpenAI',    fast: false },
  { id: 'gpt-5.4-mini',          name: 'GPT-5.4 mini',          vendor: 'OpenAI',    fast: true  },
  { id: 'gpt-4o',                name: 'GPT-4o',                vendor: 'OpenAI',    fast: false },
  { id: 'o3-mini',               name: 'o3-mini',               vendor: 'OpenAI',    fast: false },
  { id: 'minimax-m2.5',          name: 'Minimax M2.5',          vendor: 'Minimax',   fast: true  },
  { id: 'gemini-3.1-pro-preview',name: 'Gemini 3.1 Pro Preview',vendor: 'Google',    fast: false },
  { id: 'gemini-3-flash-preview',name: 'Gemini 3 Flash Preview',vendor: 'Google',    fast: true  },
  { id: 'gemini-2.5-pro',        name: 'Gemini 2.5 Pro',        vendor: 'Google',    fast: false },
  { id: 'gemini-2.0-flash',      name: 'Gemini 2.0 Flash',      vendor: 'Google',    fast: true  },
];

// ── Auth check ────────────────────────────────────────────────────────────

app.get('/api/auth', (req, res) => {
  try {
    const token   = getGhToken();
    const cfg     = readSavedConfig();
    const source  = cfg.pat ? 'pat' : (process.env.GH_TOKEN || process.env.GITHUB_TOKEN) ? 'env' : 'keychain';
    const preview = token ? token.slice(0, 4) + '…' + token.slice(-4) : '?';
    res.json({ authenticated: true, preview, source });
  } catch (e) {
    res.json({ authenticated: false, error: e.message });
  }
});

// ── PAT management ────────────────────────────────────────────────────────

app.post('/api/token', (req, res) => {
  const { pat } = req.body;
  if (!pat || !pat.trim()) return res.status(400).json({ error: 'PAT required' });

  // Basic sanity: GitHub tokens start with ghp_, gho_, github_pat_, or are classic 40-char hex
  const trimmed = pat.trim();
  const looksValid = /^(ghp_|gho_|github_pat_|ghs_|ghr_)/.test(trimmed) || /^[a-f0-9]{40}$/i.test(trimmed);
  if (!looksValid) {
    return res.status(400).json({ error: 'This doesn\'t look like a valid GitHub token (should start with ghp_, gho_, or github_pat_)' });
  }

  const cfg = readSavedConfig();
  cfg.pat = trimmed;
  writeSavedConfig(cfg);
  res.json({ ok: true, preview: trimmed.slice(0, 4) + '…' + trimmed.slice(-4) });
});

app.delete('/api/token', (req, res) => {
  const cfg = readSavedConfig();
  delete cfg.pat;
  writeSavedConfig(cfg);
  res.json({ ok: true });
});

app.get('/api/token', (req, res) => {
  const cfg = readSavedConfig();
  if (cfg.pat) {
    const t = cfg.pat;
    res.json({ hasPat: true, preview: t.slice(0, 4) + '…' + t.slice(-4) });
  } else {
    res.json({ hasPat: false });
  }
});

// ── Model list ────────────────────────────────────────────────────────────

app.get('/api/models', async (req, res) => {
  try {
    const client   = getCopilotClient();
    const response = await client.models.list();
    // Only expose models that match our known-working list or are clearly chat models
    const apiIds  = new Set((response.data || []).map(m => m.id));
    // Return known models that are actually available, plus any new ones from API
    const known   = FALLBACK_MODELS.filter(m => apiIds.has(m.id));
    // Add any API models not in fallback list that look like chat-completions models
    // Exclude: embeddings, whisper, tts, dall-e, codex, internal routers, dated snapshots, non-chat
    const EXCLUDE_RE = /embed|whisper|tts|dall|codex|goldeneye|accounts\/|routers\/|realtime|audio|search|computer-use|\d{4}[-_]\d{2}[-_]\d{2}|^\d{4}-/i;
    const extra   = (response.data || [])
      .filter(m => {
        if (FALLBACK_MODELS.find(f => f.id === m.id)) return false;
        if (EXCLUDE_RE.test(m.id)) return false;
        // Must look like a known model family
        if (!/^(gpt|claude|gemini|o[1-9]|minimax|deepseek|phi|llama|mistral)/i.test(m.id)) return false;
        return true;
      })
      .map(m => ({
        id:     m.id,
        name:   m.id.replace(/-/g, ' ').replace(/\b\w/g, c => c.toUpperCase()),
        vendor: m.id.includes('claude') ? 'Anthropic' : m.id.includes('gemini') ? 'Google' : 'OpenAI',
        fast:   m.id.includes('mini') || m.id.includes('haiku') || m.id.includes('flash')
      }));
    const models = [...known, ...extra];
    res.json({ models: models.length ? models : FALLBACK_MODELS });
  } catch (e) {
    res.json({ models: FALLBACK_MODELS });
  }
});

// ── Figma layout knowledge ───────────────────────────────────────────────
// Injected into the system prompt when Figma MCP is enabled.

// ── Browser panel + app building context ────────────────────────────────
// Always injected so the AI knows how to use the built-in browser.
const BROWSER_BUILD_CONTEXT = `
## Built-in Browser Panel

You have a built-in browser panel that runs inside the app. You can control it using \`\`\`browser-action code blocks.

### Available browser actions:
- **navigate** — \`{"action":"navigate","url":"..."}\` — load a URL
- **extract** — \`{"action":"extract"}\` — get page text + links
- **eval** — \`{"action":"eval","js":"..."}\` — run JS in the page
- **click** — \`{"action":"click","selector":"..."}\` — click an element
- **type** — \`{"action":"type","selector":"...","value":"..."}\` — type into an input
- **wait** — \`{"action":"wait","ms":1500}\` — wait N milliseconds
- **new-tab** — \`{"action":"new-tab","url":"..."}\` — open a new browser tab (optionally with URL)
- **switch-tab** — \`{"action":"switch-tab","index":0}\` — switch to tab by 0-based index
- **close-tab** — \`{"action":"close-tab","index":0}\` — close a tab
- **list-tabs** — \`{"action":"list-tabs"}\` — list all open tabs
- **extract-all** — \`{"action":"extract-all"}\` — extract text from ALL tabs
- **console-logs** — \`{"action":"console-logs"}\` — read console errors/warnings/logs from the active tab
- **console-logs (filtered)** — \`{"action":"console-logs","level":"error"}\` — only errors
- **clear-console** — \`{"action":"clear-console"}\` — clear captured console logs

### Dev Server + Browser Debugging Workflow
When building a web app for the user, follow this workflow:
1. **Install ALL dependencies in one complete command** — never truncate \`npm install\`. Write the full package.json first, then run \`npm install\`.
2. **Start dev server in background** — use \`&\` or run it as a background process, then wait a moment
3. **Open in browser** — navigate to \`http://localhost:PORT\` in a new tab. Console errors/warnings from localhost pages are **automatically included** in the page extract — check them!
4. **Fix and iterate** — if there are errors, fix the code, navigate again or use console-logs to recheck
5. **Only report success after verifying** — don't tell the user it works until you've seen the page load without errors

### Critical Rules:
- **NEVER truncate shell commands or code blocks**. Write them fully in one go. Never stop mid-line or say "let me continue".
- **NEVER narrate what you're about to do**. Don't say "Let me...", "I'll now...", "I need to...". Just DO it — write the code, run the command.
- **ALWAYS write complete files**. When creating a file, write ALL of it in one code block. Never split a file across multiple blocks.
- **ALWAYS write complete package.json** before running npm install — don't rely on incremental installs.
- **Use console-logs to debug** — after loading a page, check for errors before telling the user it's done.
- **If your output was cut off**, you will be automatically asked to continue. Just pick up exactly where you left off.
- The browser keeps login sessions across pages (cookies persist). No need to re-authenticate.
- Each conversation has its own browser tabs — they don't interfere with other conversations.
`;

const FIGMA_LAYOUT_CONTEXT = `
## Figma MCP — MANDATORY EXECUTION RULES

You have two Figma tools available via MCP:
- **get_design_context** — reads current Figma state (node IDs, component keys, text, structure)
- **figma_execute** — executes Figma Plugin API JavaScript directly inside the open Figma document

### ⚠️ ABSOLUTE RULE: Always call figma_execute when asked to build or modify Figma

When the user asks you to create, build, modify, update, execute, or design anything in Figma:
1. Call \`get_design_context\` ONCE to get node IDs / existing state (skip if you already have it)
2. **IMMEDIATELY call \`figma_execute\`** with the complete code — do NOT output any text first
3. Never say "I'll execute now" / "Running the code" / "Let me do that" — **just call the tool**
4. Do NOT describe what you're about to do — **just do it**
5. Task is NOT complete until \`figma_execute\` has returned "Done" or a result summary

**WRONG** (do not do this):
> "I'll now call figma_execute to build the layout..." ← NO. Just call it.

**RIGHT** (do this):
> [call figma_execute immediately with the full code]

---
## Figma Layout & Component Swap Guide

Build and modify Figma designs using figma_execute (Plugin API JavaScript). All code runs inside Figma with full access to the \`figma\` object. \`return\` and \`await\` work at top level.

---
### ⚠️ CRITICAL: Auto-layout sizing rules (read before writing any sizing code)
\`layoutSizingVertical\`, \`layoutSizingHorizontal\`, \`layoutAlign\`, and \`layoutGrow\` only work on children of an auto-layout frame (\`layoutMode !== 'NONE'\`). Setting them on a node whose parent is NOT auto-layout throws an error.

**Safe pattern — always guard before setting child sizing:**
\`\`\`javascript
function safeChildSizing(node, horizontal, vertical) {
  const parent = node.parent;
  if (!parent || parent.layoutMode === 'NONE' || parent.type === 'PAGE') return;
  try {
    if (horizontal) node.layoutSizingHorizontal = horizontal; // 'FILL' | 'HUG' | 'FIXED'
    if (vertical)   node.layoutSizingVertical   = vertical;
  } catch(_) {}
}
// Usage after appendChild:
parent.appendChild(inst);
safeChildSizing(inst, 'FILL', 'HUG');

// The old API (still works but prefer safeChildSizing):
// child.layoutAlign = 'STRETCH';  // FILL cross-axis — only works inside auto-layout parent
// child.layoutGrow = 1;           // FILL main-axis  — only works inside auto-layout parent
\`\`\`

**When to use each value:**
- \`FILL\` — stretch to fill parent (parent must be auto-layout)
- \`HUG\` — shrink-wrap content (auto-layout children only)
- \`FIXED\` — explicit size; safe to set anywhere with \`node.resize(w,h)\`

**Rule: always call \`parent.appendChild(child)\` BEFORE setting child sizing on it.**

---
### Dashboard Frame Structure
\`\`\`
App frame (VERTICAL, 1920×1080)
  ├─ Header [STRETCH]
  └─ Main (HORIZONTAL, grow=1, gap=24)
      ├─ SideNav [STRETCH]  — key: 2249c2b1fb655e82e5b9fe5a9dfe2b797f2064cc
      └─ PageLayout (VERTICAL, grow=1, gap=24, pad=12)
          └─ Section rows (Section wrapper → LayoutGrid → content slots)
\`\`\`

---
### 1. Create auto-layout frames
\`\`\`javascript
const f = figma.createFrame();
f.name = 'MyFrame';
f.layoutMode = 'VERTICAL';   // or 'HORIZONTAL'
f.itemSpacing = 24;
f.paddingLeft = f.paddingRight = f.paddingTop = f.paddingBottom = 16;
f.primaryAxisSizingMode = 'FIXED';
f.counterAxisSizingMode = 'AUTO';   // or 'FIXED'
f.resize(1920, 1080);

// ✅ ALWAYS append to parent BEFORE setting child sizing
parent.appendChild(f);
safeChildSizing(f, 'FILL', 'HUG');  // use the safe helper defined above
\`\`\`

---
### 2. Place a component by key
\`\`\`javascript
const comp = await figma.importComponentByKeyAsync('KEY');
const inst = comp.createInstance();
parent.appendChild(inst);  // append FIRST
safeChildSizing(inst, 'FILL', 'HUG');
\`\`\`

---
### 3. Swap an instance's component (INSTANCE_SWAP slots)
This is the key pattern for swapping predefined content into Section/LayoutGrid slots:
\`\`\`javascript
// Find the INSTANCE_SWAP property keys on an instance
function getSwapSlots(instance) {
  const props = instance.componentProperties || {};
  return Object.entries(props)
    .filter(([, v]) => v.type === 'INSTANCE_SWAP')
    .map(([key]) => key);
}

// Swap a component into a slot by key
async function swapSlot(instance, slotKey, componentKey) {
  // slotKey may be short label — do case-insensitive prefix match if needed
  const liveProps = instance.componentProperties || {};
  let actualKey = slotKey;
  if (!liveProps[slotKey]) {
    const found = Object.keys(liveProps).find(k =>
      k.toLowerCase().startsWith(slotKey.toLowerCase())
    );
    if (found) actualKey = found;
  }
  const comp = await figma.importComponentByKeyAsync(componentKey);
  instance.setProperties({ [actualKey]: comp.id }); // Use node ID, NOT key
}

// Example: place a DataGrid into slot "Item 1" of a LayoutGrid
const lgInst = figma.currentPage.findAll(n => n.type === 'INSTANCE' && n.name.includes('LayoutGrid'))[0];
await swapSlot(lgInst, 'Item 1', 'YOUR_COMPONENT_KEY');
\`\`\`

---
### 4. Swap the selected node's component
\`\`\`javascript
const sel = figma.currentPage.selection[0];
if (sel && sel.type === 'INSTANCE') {
  const newComp = await figma.importComponentByKeyAsync('NEW_KEY');
  sel.swapComponent(newComp);  // replaces the master component in-place
}
\`\`\`

---
### 5. Section + LayoutGrid keys (Security AI UI Kit)
**Section wrapper** (content container with optional header):
- \`ec55e1cf42855ce08a89e90ba302bb531dcda8d1\`

**LayoutGrid_Section variants** (swap into Section's content slot):
| Layout       | Key |
|---|---|
| 1-col        | \`cd3267e90f83d7487d7f2976fb9ea3599aa48ff4\` |
| 2-col equal  | \`399160f011bf1cade3c078cf7b8df3abc1889176\` |
| 2-col 1:3    | \`c268d614669496370f588f1a432432da70871032\` |
| 2-col 3:1    | \`fadfc8ba7bea951815c228aa28b3fe1303fe612d\` |
| 3-col equal  | \`b27e456a69e7f81710fb82dd5635cd5abd1ee27d\` |
| 3-col 2:1:1  | \`14ac2eb8a0173da1509c9a880c659b47c3a1bc2d\` |
| 3-col 1:1:2  | \`b19eb1c9135bbdbc582c567ef47b6d9a37bc25a7\` |
| 4-col equal  | \`b7c46dd6c84ecd6e80f1cb020c49ddab7e8e8d1e\` |

**Navigation**:
- SideNav: \`2249c2b1fb655e82e5b9fe5a9dfe2b797f2064cc\`
- TopNav: \`e6b6b1b7c1f80aa538f4542ba66f59da03e9b606\`

**Cards / content blocks**:
- Recommendation (general): \`8d0a2578a95681d39205a030c28cc31df89b7e3d\`
- Recommendation (spotlight): \`22ede7aa59eebe9595c1592f6e0e734d74b5c532\`
- Recommendation (contextual): \`7c56e6dd7668d23315bfab10169c209cec544bdb\`
- Metric group: \`c4a57f63e0e8aa4a495482b88bd7c4ed750ac09c\`
- Card (filled): \`5594f2616c702b4afe82f7addfc11a6f4daab5da\`

---
### 6. Build a full content row (Section + LayoutGrid + content)
\`\`\`javascript
// 1. Import Section and a 2-column LayoutGrid
const sectionComp = await figma.importComponentByKeyAsync('ec55e1cf42855ce08a89e90ba302bb531dcda8d1');
const lgComp      = await figma.importComponentByKeyAsync('399160f011bf1cade3c078cf7b8df3abc1889176'); // 2-col

// 2. Create Section instance, add to page layout
const section = sectionComp.createInstance();
pageLayout.appendChild(section);
section.layoutAlign = 'STRETCH';
section.layoutSizingVertical = 'HUG';

// 3. Swap the LayoutGrid into the Section's content INSTANCE_SWAP slot
const sectionSwapKeys = getSwapSlots(section);
if (sectionSwapKeys.length > 0) {
  section.setProperties({ [sectionSwapKeys[0]]: lgComp.id });
}

// 4. Find the LayoutGrid instance inside Section and fill its slots
const lgInst = section.findAll(n => n.type === 'INSTANCE' && /LayoutGrid/i.test(n.name))[0];
if (lgInst) {
  const slots = getSwapSlots(lgInst);  // ['Item 1 content#...', 'Item 2 content#...']
  const metricComp = await figma.importComponentByKeyAsync('c4a57f63e0e8aa4a495482b88bd7c4ed750ac09c');
  const cardComp   = await figma.importComponentByKeyAsync('5594f2616c702b4afe82f7addfc11a6f4daab5da');
  if (slots[0]) lgInst.setProperties({ [slots[0]]: metricComp.id });
  if (slots[1]) lgInst.setProperties({ [slots[1]]: cardComp.id });
}
\`\`\`

---
### 7. Text overrides
⚠️ ALWAYS load fonts before setting .characters on ANY text node — even existing ones.
  Batch all loadFontAsync calls with Promise.all BEFORE any text edits:
\`\`\`javascript
// CORRECT: load all needed fonts first
const textNodes = frame.findAll(n => n.type === 'TEXT');
await Promise.all(textNodes.map(t =>
  figma.loadFontAsync(Array.isArray(t.fontName) ? t.fontName[0] : t.fontName).catch(()=>{})
));
// NOW safe to edit characters
textNodes.forEach(t => { if (t.name === 'Title') t.characters = 'New Title'; });

// Via component TEXT property (preferred — no loadFont needed)
inst.setProperties({ 'Title#abc': 'My Title', 'Description#xyz': 'Some text' });

// Via direct text node edit (must load font first)
const textNode = inst.findAll(n => n.type === 'TEXT' && n.name === 'Title')[0];
if (textNode) {
  await figma.loadFontAsync(Array.isArray(textNode.fontName) ? textNode.fontName[0] : textNode.fontName);
  textNode.characters = 'My Title';
}
\`\`\`

---
### 8. Scan for existing instances to swap
\`\`\`javascript
// Find all instances of a specific component on the current page
const instances = figma.currentPage.findAll(n =>
  n.type === 'INSTANCE' && n.mainComponent?.key === 'COMPONENT_KEY'
);

// Find instances by name pattern
const sections = figma.currentPage.findAll(n =>
  n.type === 'INSTANCE' && /Section/i.test(n.name)
);
\`\`\`

---
### 9. Hide / show layers
\`\`\`javascript
node.visible = false;   // hide
node.visible = true;    // show
node.opacity = 0.5;     // 50% opacity

// Hide all nodes whose name matches a pattern
figma.currentPage.findAll(n => /unused|extra/i.test(n.name))
  .forEach(n => { n.visible = false; });

// Hide specific nav items by their label text
figma.currentPage.findAll(n => n.type === 'TEXT')
  .filter(n => ['Reports', 'Settings', 'Help'].includes(n.characters))
  .forEach(n => {
    // Hide the parent nav item frame, not just the text node
    let p = n.parent;
    while (p && p.type !== 'INSTANCE' && p.parent?.type !== 'INSTANCE') p = p.parent;
    if (p) p.visible = false;
  });
\`\`\`

---
### 10. Edit ALL text in an existing node tree (applyTextOverrides pattern)
Use this to update text in nav items, section headers, card labels — anything already in the file:
\`\`\`javascript
async function applyTextOverrides(instance, overrides) {
  if (!overrides || !Object.keys(overrides).length) return;
  const keys = Object.keys(overrides);
  const applied = {};

  // Step 1: component TEXT properties (fastest path)
  try {
    const defs = instance.componentPropertyDefinitions || {};
    const propsToSet = {};
    for (const ok of keys) {
      const okl = ok.toLowerCase();
      for (const dk of Object.keys(defs)) {
        if (defs[dk].type !== 'TEXT') continue;
        const dkl = dk.split('#')[0].toLowerCase().trim();
        if (dkl === okl || dkl.includes(okl) || okl.includes(dkl)) {
          propsToSet[dk] = String(overrides[ok]);
          applied[ok] = true;
          break;
        }
      }
    }
    if (Object.keys(propsToSet).length) instance.setProperties(propsToSet);
  } catch(_) {}

  // Step 2: find TEXT nodes by layer name for anything not matched above
  const remaining = keys.filter(k => !applied[k]);
  if (!remaining.length) return;
  const textNodes = instance.findAll(n => n.type === 'TEXT');
  for (const rk of remaining) {
    const rkl = rk.toLowerCase();
    const tn = textNodes.find(n => n.name.toLowerCase().includes(rkl));
    if (tn) {
      try { await figma.loadFontAsync(tn.fontName); tn.characters = String(overrides[rk]); } catch(_) {}
    }
  }
}

// Usage — edit existing nav instance on the page:
const nav = figma.currentPage.findAll(n => n.type === 'INSTANCE' && /nav/i.test(n.name))[0];
await applyTextOverrides(nav, {
  'Dashboard': 'Threat Center',
  'Overview': 'Incidents',
  'Analytics': 'Threat Intel',
});
\`\`\`

---
### 11. Edit text found by current content (rename existing labels)
\`\`\`javascript
// Find text nodes by what they currently say and change them
const allText = figma.currentPage.findAll(n => n.type === 'TEXT');
const renames = {
  'Dashboard': 'Threat Center',
  'Overview':  'Active Incidents',
  'Reports':   'Threat Reports',
  'Users':     'Affected Assets',
};
for (const t of allText) {
  const newVal = renames[t.characters];
  if (newVal) {
    try { await figma.loadFontAsync(t.fontName); t.characters = newVal; } catch(_) {}
  }
}
\`\`\`

---
### 12. Practical workflow — "Make this a Threat Dashboard"
1. Call \`get_design_context\` ONCE to get node IDs and existing text
2. Use \`figma_execute\` to do ALL edits in one call:
   - Rename text nodes (nav labels, section titles, card headings)
   - Hide unused nav items / layers
   - Swap placeholder cards for threat-specific components
   - Update section titles & descriptions via \`setProperties\`
\`\`\`javascript
// All in ONE figma_execute call — batch everything
const page = figma.currentPage;

// 1. Rename all nav text
const renames = { 'Home': 'Threat Center', 'Analytics': 'Threat Intel', 'Users': 'Assets' };
for (const t of page.findAll(n => n.type === 'TEXT')) {
  if (renames[t.characters]) {
    try { await figma.loadFontAsync(t.fontName); t.characters = renames[t.characters]; } catch(_) {}
  }
}

// 2. Hide nav items not relevant to threat dashboard
const hideLabels = new Set(['Settings', 'Help', 'Billing', 'Integrations']);
for (const t of page.findAll(n => n.type === 'TEXT' && hideLabels.has(n.characters))) {
  let p = t.parent;
  while (p && p.type !== 'FRAME' && p.type !== 'INSTANCE') p = p.parent;
  if (p) p.visible = false;
}

// 3. Update section component properties by name
for (const n of page.findAll(n => n.type === 'INSTANCE')) {
  const defs = n.componentPropertyDefinitions || {};
  const titleKey = Object.keys(defs).find(k => /title/i.test(k) && defs[k].type === 'TEXT');
  if (titleKey && /section/i.test(n.name)) {
    try { n.setProperties({ [titleKey]: 'Active Threats' }); } catch(_) {}
    break;
  }
}

return 'Done';
\`\`\`

---
### Rules
- **ALWAYS call figma_execute when asked to build/modify/create** — never just describe what you'd do.
- Use get_design_context ONCE to read existing keys/IDs, then call figma_execute immediately.
- Do NOT call get_design_context or get_screenshot more than twice per task.
- Prefer swapComponent() for replacing a whole instance, setProperties() for slot swaps.
- importComponentByKeyAsync() returns the Component node; use .id for setProperties, .createInstance() to place.
- Always batch ALL edits (text, visibility, swaps) into a SINGLE figma_execute call when possible.
- Always \`return 'Done'\` or a summary at the end of figma_execute so you know it succeeded.
- After figma_execute returns, summarize what was built — do not call more tools unless needed.
`;

// ── Context summarization endpoint ───────────────────────────────────────────
app.post('/api/summarize', async (req, res) => {
  const { messages = [], model = 'claude-sonnet-4.6' } = req.body;
  if (!messages.length) return res.json({ summary: '' });
  try {
    const client = getCopilotClient();
    const prompt = [
      { role: 'system', content:
        'You are a concise task-state summarizer. ' +
        'Given a conversation, produce a compact summary (max 400 words) covering:\n' +
        '1. The original task/goal\n' +
        '2. What has already been completed (files created, commands run, results)\n' +
        '3. Current state and any pending steps\n' +
        '4. Key facts discovered (paths, errors, findings)\n' +
        'Write in past tense. Be specific — include file paths, command names, and exact results. ' +
        'Omit greetings, filler, and markdown formatting.'
      },
      ...messages.map(m => ({
        role: m.role,
        content: typeof m.content === 'string'
          ? m.content.slice(0, 3000)
          : (m.content || []).filter(c => c.type === 'text').map(c => c.text).join('\n').slice(0, 3000)
      })),
      { role: 'user', content: 'Summarize the conversation above as a compact task-state note.' }
    ];
    const sumParams = { model, messages: prompt, stream: false };
    if (/^(o[1-9]|gpt-5)/.test(model)) { sumParams.max_completion_tokens = 600; }
    else { sumParams.max_tokens = 600; }
    const resp = await client.chat.completions.create(sumParams);
    const summary = resp.choices[0]?.message?.content?.trim() || '';
    res.json({ summary });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});


app.post('/api/chat', async (req, res) => {
  _psAcquire();
  res.on('finish', _psRelease);
  res.on('close',  _psRelease);
  const { messages = [], model = 'claude-sonnet-4.6', systemPrompt = '', useFigmaMCP = false, contextSummary = '',
          thinkingBudget = 'high', maxContextTurns = 20, agentName = null } = req.body;

  res.writeHead(200, {
    'Content-Type':    'text/event-stream',
    'Cache-Control':   'no-cache',
    'Connection':      'keep-alive',
    'X-Accel-Buffering': 'no',
    'Access-Control-Allow-Origin': 'http://localhost:3737'
  });

  const send = (obj) => res.write(`data: ${JSON.stringify(obj)}\n\n`);

  try {
    const client = getCopilotClient();
    const allMessages = [];

    // Build system prompt — append context summary and browser context
    const fullSystem = [
      systemPrompt.trim(),
      BROWSER_BUILD_CONTEXT,
      contextSummary ? `\n## Task Context (auto-summarized from earlier conversation)\n${contextSummary}` : ''
    ].filter(Boolean).join('\n');
    if (fullSystem) allMessages.push({ role: 'system', content: fullSystem });

    // ── Context trimming ──────────────────────────────────────────────────
    // Target: ~60k chars of conversation history (well inside 128k context window)
    const MAX_HISTORY_CHARS = 200000;
    const MAX_MSG_CHARS     = 40000; // cap any single message (shell outputs can be huge)
    const TURN_LIMIT        = maxContextTurns >= 100 ? Infinity : maxContextTurns;

    // 1. Strip old image payloads and cap oversized messages
    const stripped = messages.map((m, i) => {
      let content = m.content;

      // Strip image bytes from non-latest vision messages
      if (Array.isArray(content) && i < messages.length - 1) {
        const textOnly = content.filter(c => c.type === 'text').map(c => c.text).join('\n');
        content = textOnly + '\n[screenshot attached earlier — not repeated]';
      }

      // Cap very long text messages (e.g. large shell outputs fed back as context)
      if (typeof content === 'string' && content.length > MAX_MSG_CHARS) {
        content = content.slice(0, MAX_MSG_CHARS) + `\n…[truncated — ${content.length - MAX_MSG_CHARS} chars omitted]`;
      }

      return { ...m, content };
    });

    // 2. Always keep first msg + as many recent msgs as fit within token budget
    const first = stripped[0];
    const rest  = stripped.slice(1);
    const recent = [];
    let charCount = (typeof first?.content === 'string' ? first.content.length : 500);
    for (let i = rest.length - 1; i >= 0; i--) {
      if (recent.length >= TURN_LIMIT) break;
      const len = typeof rest[i].content === 'string' ? rest[i].content.length : 500;
      if (charCount + len > MAX_HISTORY_CHARS) break;
      recent.unshift(rest[i]);
      charCount += len;
    }
    const trimmed = first ? [first, ...recent] : recent;
    allMessages.push(...trimmed);
    console.log(`[chat] context: ${trimmed.length}/${messages.length} msgs, ~${charCount} chars (sys: ${systemPrompt.length}ch)`);

    // Fetch Figma MCP tools and inject layout knowledge if requested
    let mcpTools;
    if (useFigmaMCP) {
      try { mcpTools = await figmaMCP.getTools(); } catch (_) {
        // Fallback: always expose figma_execute even when port-3845 is unavailable
        mcpTools = [FigmaMCPClient.FIGMA_EXECUTE_TOOL];
      }
      // Inject layout guide into system prompt
      allMessages[0] = allMessages[0]
        ? { ...allMessages[0], content: allMessages[0].content + '\n\n' + FIGMA_LAYOUT_CONTEXT }
        : { role: 'system', content: FIGMA_LAYOUT_CONTEXT };
    }

    // Load agent tools if an agent is active
    let agentToolHandlers = null; // Map<name, executeFn>
    if (agentName) {
      const safeAgentName = agentName.replace(/[^a-zA-Z0-9_-]/g, '');
      const agentDir = path.join(AGENTS_DIR, safeAgentName);
      const manifestPath = path.join(agentDir, 'agent.json');
      let manifest = null;

      // Try to load installed agent manifest
      if (fs.existsSync(manifestPath)) {
        try { manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8')); } catch (_) {}
      }

      // For built-in agents, use the permissions from the request body
      const permissions = manifest?.permissions || req.body.agentPermissions || {};
      const effectiveManifest = manifest || { name: safeAgentName, permissions };

      const { definitions: agentToolDefs, handlers } = getAgentTools(
        fs.existsSync(agentDir) ? agentDir : null,
        effectiveManifest,
        safeAgentName
      );
      agentToolHandlers = handlers;

      // Merge agent tools with MCP tools
      const allTools = [...(mcpTools || []), ...agentToolDefs];
      if (allTools.length) mcpTools = allTools;

      // Start any MCP servers the agent requires
      if (effectiveManifest.permissions?.mcp?.length) {
        try { await startAgentMCPServers(effectiveManifest, safeAgentName); } catch (_) {}
      }

      console.log(`[chat] Agent "${safeAgentName}" active — ${agentToolDefs.length} tools registered`);
    }

    // Agentic loop — re-runs if model calls tools (max 12 iterations)
    let continueLoop = true;
    let toolCallCount = 0;
    let continueCount = 0; // track auto-continue on length finish
    const MAX_TOOL_CALLS = 50;
    const MAX_CONTINUES = 4; // max auto-continue attempts for truncated output
    const MAX_RESULT_CHARS = 40000; // prevent context overflow from large tool responses
    const toolCallsSeen = new Map(); // deduplicate identical calls

    while (continueLoop) {
      if (res.writableEnded) break;

      // o-series and gpt-5+ models require max_completion_tokens instead of max_tokens
      const useCompletionTokens = /^(o[1-9]|gpt-5)/.test(model);
      const params = { model, messages: allMessages, stream: true };
      if (useCompletionTokens) { params.max_completion_tokens = 16384; }
      else { params.max_tokens = 16384; }

      // Thinking budget — Claude models use `thinking`, o-series use `reasoning_effort`
      if (thinkingBudget !== 'off') {
        const budgetTokens = { low: 1024, medium: 5000, high: 10000, max: 32000 }[thinkingBudget] || 10000;
        if (model.includes('claude')) {
          params.thinking = { type: 'enabled', budget_tokens: budgetTokens };
          const minTokens = budgetTokens + 4000;
          if (useCompletionTokens) { params.max_completion_tokens = Math.max(params.max_completion_tokens, minTokens); }
          else { params.max_tokens = Math.max(params.max_tokens, minTokens); }
        } else if (/^o[1-9]/.test(model)) {
          params.reasoning_effort = thinkingBudget === 'max' ? 'high' : thinkingBudget === 'low' ? 'low' : 'medium';
        }
      }

      if (mcpTools?.length) params.tools = mcpTools;
      params.stream_options = { include_usage: true };

      let stream;
      try {
        stream = await client.chat.completions.create(params);
      } catch (apiErr) {
        // Auto-recover: if max_tokens is unsupported, switch to max_completion_tokens
        if (apiErr.message?.includes('max_tokens') && params.max_tokens) {
          params.max_completion_tokens = params.max_tokens;
          delete params.max_tokens;
          stream = await client.chat.completions.create(params);
        } else {
          throw apiErr;
        }
      }

      const pendingCalls = [];
      let finishReason = null;
      let assistantText = '';
      let streamUsage = null;

      for await (const chunk of stream) {
        if (res.writableEnded) { continueLoop = false; break; }
        if (chunk.usage) streamUsage = chunk.usage;
        const delta = chunk.choices?.[0]?.delta;
        finishReason = chunk.choices?.[0]?.finish_reason || finishReason;
        if (!delta) continue;

        if (delta.content) { assistantText += delta.content; send({ type: 'content', content: delta.content }); }

        if (delta?.tool_calls) {
          for (const tc of delta.tool_calls) {
            const i = tc.index ?? 0;
            if (!pendingCalls[i]) pendingCalls[i] = { id: '', type: 'function', function: { name: '', arguments: '' } };
            if (tc.id) pendingCalls[i].id += tc.id;
            if (tc.function?.name) pendingCalls[i].function.name += tc.function.name;
            if (tc.function?.arguments) pendingCalls[i].function.arguments += tc.function.arguments;
          }
        }
      }

      if (finishReason === 'tool_calls' && pendingCalls.length > 0) {
        const calls = pendingCalls.filter(tc => tc && tc.function?.name);
        if (!calls.length) { send({ type: 'done', finish_reason: finishReason }); continueLoop = false; break; }
        allMessages.push({ role: 'assistant', tool_calls: calls });
        for (const tc of calls) {
          const toolName = tc.function.name;
          const callKey  = toolName + '|' + tc.function.arguments;
          toolCallCount++;

          // Hard stop: too many tool calls — let model finish with what it has
          if (toolCallCount > MAX_TOOL_CALLS) {
            allMessages.push({ role: 'tool', tool_call_id: tc.id, content: 'Tool call limit reached (' + MAX_TOOL_CALLS + '). Summarize what you have done so far and tell the user to continue the task in a follow-up message if needed.' });
            continue;
          }

          // Deduplicate: same tool + same args already called
          if (toolCallsSeen.has(callKey)) {
            allMessages.push({ role: 'tool', tool_call_id: tc.id, content: toolCallsSeen.get(callKey) });
            continue;
          }

          send({ type: 'tool_call', name: toolName });
          try {
            const args = JSON.parse(tc.function.arguments || '{}');
            let result;

            // Route to agent tool handler if available, otherwise Figma MCP
            if (agentToolHandlers?.has(toolName)) {
              console.log(`[chat] Agent tool: ${toolName}`);
              result = await agentToolHandlers.get(toolName)(args);
            } else {
              figmaLog('🔧 ' + toolName + (toolName === 'figma_execute' ? ': ' + (args.code || '').slice(0, 80).replace(/\n/g,' ') + '…' : ''), 'cmd');
              result = await figmaMCP.callTool(toolName, args);
              figmaLog('✓ ' + toolName + ' done', 'ok');
            }

            // Truncate oversized results (screenshots, large contexts)
            if (typeof result === 'string' && result.length > MAX_RESULT_CHARS) {
              result = result.slice(0, MAX_RESULT_CHARS) + `\n\n[Truncated — ${result.length} chars total]`;
            }
            toolCallsSeen.set(callKey, result);
            allMessages.push({ role: 'tool', tool_call_id: tc.id, content: typeof result === 'string' ? result : JSON.stringify(result) });
          } catch (e) {
            allMessages.push({ role: 'tool', tool_call_id: tc.id, content: `Error: ${e.message}` });
            figmaLog('✗ ' + toolName + ': ' + e.message, 'err');
          }
        }
        if (continueLoop) { /* loop continues to get next AI response */ }
        else { send({ type: 'done', finish_reason: 'tool_limit' }); }
      } else if (finishReason === 'length' && continueCount < MAX_CONTINUES) {
        // Model hit token limit mid-output — auto-continue so the response finishes seamlessly
        continueCount++;
        console.log('[chat] finish_reason=length — auto-continuing (' + assistantText.length + ' chars so far, attempt ' + continueCount + '/' + MAX_CONTINUES + ')');
        allMessages.push({ role: 'assistant', content: assistantText });
        allMessages.push({ role: 'user', content: 'Your previous response was cut off mid-output. Continue EXACTLY where you left off — do NOT repeat anything already written. Do NOT narrate or explain, just output the remaining content.' });
        // keep continueLoop = true
      } else {
        send({ type: 'done', finish_reason: finishReason, usage: streamUsage || null });
        continueLoop = false;
      }
    }
  } catch (err) {
    send({ type: 'error', error: err.message });
  }

  if (!res.writableEnded) res.end();
});

// ── Git Repo Discovery ────────────────────────────────────────────────────
// Find recently-used git repos on the system (for slash commands in a chat-first app)
app.get('/api/git/repos', (req, res) => {
  const home = os.homedir();
  // Search common dev directories for git repos (max depth 3, fast scan)
  const searchDirs = ['', '/Projects', '/Developer', '/repos', '/src', '/code', '/work', '/Documents', '/Desktop'].map(d => home + d);
  const repos = [];
  const seen = new Set();
  for (const base of searchDirs) {
    if (!fs.existsSync(base)) continue;
    try {
      // Depth 1: direct children with .git
      const entries = fs.readdirSync(base, { withFileTypes: true });
      for (const e of entries) {
        if (!e.isDirectory() || e.name.startsWith('.') || e.name === 'node_modules') continue;
        const full = path.join(base, e.name);
        if (seen.has(full)) continue;
        const gitDir = path.join(full, '.git');
        if (fs.existsSync(gitDir)) {
          seen.add(full);
          let branch = '';
          try { branch = fs.readFileSync(path.join(gitDir, 'HEAD'), 'utf8').trim().replace('ref: refs/heads/', ''); } catch (_) {}
          let mtime = 0;
          try { mtime = fs.statSync(gitDir).mtimeMs; } catch (_) {}
          repos.push({ path: full, name: e.name, branch, mtime });
        }
        // Depth 2: grandchildren
        try {
          const sub = fs.readdirSync(full, { withFileTypes: true });
          for (const s of sub) {
            if (!s.isDirectory() || s.name.startsWith('.') || s.name === 'node_modules') continue;
            const sfull = path.join(full, s.name);
            if (seen.has(sfull)) continue;
            if (fs.existsSync(path.join(sfull, '.git'))) {
              seen.add(sfull);
              let sbranch = '';
              try { sbranch = fs.readFileSync(path.join(sfull, '.git', 'HEAD'), 'utf8').trim().replace('ref: refs/heads/', ''); } catch (_) {}
              let smtime = 0;
              try { smtime = fs.statSync(path.join(sfull, '.git')).mtimeMs; } catch (_) {}
              repos.push({ path: sfull, name: s.name, branch: sbranch, mtime: smtime });
            }
          }
        } catch (_) {}
      }
    } catch (_) {}
  }
  // Sort by most recently modified .git dir
  repos.sort((a, b) => b.mtime - a.mtime);
  res.json({ repos: repos.slice(0, 30) });
});

// ── Git Smart Commit (Feature A) ──────────────────────────────────────────
// Detects repo convention, generates message from diff, commits.
app.post('/api/git/commit', async (req, res) => {
  const { cwd, amend = false, stageAll = false } = req.body;
  const workDir = cwd || os.homedir();
  const run = (cmd) => new Promise((resolve, reject) => {
    _exec(cmd, { cwd: workDir, env: { ...process.env, PATH: AUGMENTED_PATH }, timeout: 30000, maxBuffer: 5 * 1024 * 1024, shell: SHELL_BIN },
      (err, stdout, stderr) => resolve({ ok: !err, stdout: stdout || '', stderr: stderr || '', exitCode: err?.code ?? 0 }));
  });

  try {
    // 1. Check status
    const status = await run('git status --porcelain');
    if (!status.stdout.trim() && !amend) return res.json({ ok: false, error: 'Nothing to commit — working tree clean.' });

    // 2. Stage if needed
    const staged = await run('git diff --cached --name-only');
    if (!staged.stdout.trim()) {
      if (stageAll || !staged.stdout.trim()) await run('git add -A');
      const recheck = await run('git diff --cached --name-only');
      if (!recheck.stdout.trim()) return res.json({ ok: false, error: 'No changes to commit after staging.' });
    }

    // 3. Detect convention from recent commits
    const recentLog = await run('git log --oneline -20 2>/dev/null');
    const userLog = await run('git log --oneline --author="$(git config user.name)" -10 2>/dev/null');

    // 4. Get diff
    const diffStat = await run('git diff --cached --stat');
    const diff = await run('git diff --cached');
    const diffText = diff.stdout.slice(0, 8000); // cap for LLM context

    // 5. Generate commit message via LLM
    const client = getCopilotClient();
    const conventionHint = detectCommitConvention(recentLog.stdout);
    const genMessages = [
      { role: 'system', content: `You are an expert at writing concise, meaningful git commit messages. Analyse the diff and write a commit message following the repository's convention.\n\nConvention detected: ${conventionHint}\n\nRules:\n- Subject line ≤ 72 chars, follow the convention\n- Optional body explains WHY, not a file-by-file inventory\n- Reference issue/ticket numbers from branch names when visible\n- Output ONLY the commit message (subject + optional body separated by blank line). No markdown, no fencing, no explanation.` },
      { role: 'user', content: `Recent commits:\n${recentLog.stdout.slice(0, 1500)}\n\nUser commits:\n${userLog.stdout.slice(0, 1000)}\n\nDiff stat:\n${diffStat.stdout}\n\nDiff:\n${diffText}` }
    ];
    const completion = await client.chat.completions.create({ model: 'gpt-4.1-mini', messages: genMessages, max_tokens: 300, stream: false });
    let commitMsg = (completion.choices[0]?.message?.content || '').trim();
    if (!commitMsg) return res.json({ ok: false, error: 'LLM returned empty commit message.' });

    // Clean quotes if wrapped
    if (commitMsg.startsWith('"') && commitMsg.endsWith('"')) commitMsg = commitMsg.slice(1, -1);

    // 6. Commit
    const msgParts = commitMsg.split(/\n\n/);
    const subject = msgParts[0];
    const body = msgParts.slice(1).join('\n\n');
    let commitCmd = `git commit -m ${JSON.stringify(subject)}`;
    if (body) commitCmd += ` -m ${JSON.stringify(body)}`;
    if (amend) commitCmd += ' --amend';
    const commitResult = await run(commitCmd);

    // 7. Verify
    const verify = await run('git log --oneline -1');
    res.json({
      ok: commitResult.ok,
      message: commitMsg,
      commitHash: verify.stdout.trim().split(' ')[0],
      output: commitResult.stdout + commitResult.stderr,
      convention: conventionHint,
    });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

function detectCommitConvention(logOutput) {
  const lines = (logOutput || '').split('\n').filter(Boolean);
  const conventional = lines.filter(l => /^[a-f0-9]+ (feat|fix|chore|docs|style|refactor|test|perf|ci|build|revert)(\(.+\))?:/.test(l));
  if (conventional.length > lines.length * 0.4) return 'Conventional Commits (type(scope): subject)';
  const gitmoji = lines.filter(l => /^[a-f0-9]+ [\u{1F300}-\u{1FAD6}:]/u.test(l));
  if (gitmoji.length > lines.length * 0.3) return 'Gitmoji';
  const ticketed = lines.filter(l => /^[a-f0-9]+ \[?[A-Z]+-\d+\]?/.test(l));
  if (ticketed.length > lines.length * 0.3) return 'Ticket-prefixed (e.g. PROJ-123)';
  return 'Free-form (imperative mood, capitalize first word)';
}

// ── Git Branch Name Generation (Feature G) ────────────────────────────────
app.post('/api/git/branch-name', async (req, res) => {
  const { description, cwd } = req.body;
  if (!description) return res.status(400).json({ error: 'description required' });
  try {
    const client = getCopilotClient();
    const completion = await client.chat.completions.create({
      model: 'gpt-4.1-mini',
      messages: [
        { role: 'system', content: 'You are an expert in crafting pithy branch names for Git repos. Given a task description, reply with ONLY a brief branch name (8-50 chars, lowercase, alphanumeric + hyphens only). No quotes, no explanation.' },
        { role: 'user', content: description }
      ],
      max_tokens: 60,
      stream: false,
    });
    let name = (completion.choices[0]?.message?.content || '').trim().replace(/[^a-zA-Z0-9-]/g, '').toLowerCase();
    if (name.length < 4) name = 'feature-' + name;
    if (name.length > 50) name = name.slice(0, 50);

    // Optionally create the branch
    if (req.body.create && cwd) {
      const result = await new Promise((resolve) => {
        _exec(`git checkout -b ${name}`, { cwd, env: { ...process.env, PATH: AUGMENTED_PATH }, shell: SHELL_BIN },
          (err, stdout, stderr) => resolve({ ok: !err, stdout, stderr }));
      });
      return res.json({ ok: result.ok, name, created: result.ok, output: result.stdout + result.stderr });
    }

    res.json({ ok: true, name });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ── Workspace Discovery (Feature C) ──────────────────────────────────────
// Scans a directory and returns project context (build commands, architecture, etc.)
app.post('/api/workspace/discover', async (req, res) => {
  const { cwd } = req.body;
  const workDir = cwd || os.homedir();
  const run = (cmd) => new Promise((resolve) => {
    _exec(cmd, { cwd: workDir, env: { ...process.env, PATH: AUGMENTED_PATH }, timeout: 15000, maxBuffer: 2 * 1024 * 1024, shell: SHELL_BIN },
      (err, stdout) => resolve(stdout?.trim() || ''));
  });

  try {
    const context = {};

    // Detect project type
    const files = await run('ls -1A 2>/dev/null | head -100');
    const fileList = files.split('\n');

    // Package managers / build systems
    if (fileList.includes('package.json')) {
      try {
        const pkg = JSON.parse(await run('cat package.json'));
        context.type = 'node';
        context.name = pkg.name;
        context.scripts = pkg.scripts || {};
        context.dependencies = Object.keys(pkg.dependencies || {}).length;
        context.devDependencies = Object.keys(pkg.devDependencies || {}).length;
        context.packageManager = pkg.packageManager || (fileList.includes('yarn.lock') ? 'yarn' : fileList.includes('pnpm-lock.yaml') ? 'pnpm' : 'npm');
      } catch (_) {}
    }
    if (fileList.includes('Cargo.toml')) context.type = 'rust';
    if (fileList.includes('go.mod')) context.type = 'go';
    if (fileList.includes('pyproject.toml') || fileList.includes('setup.py') || fileList.includes('requirements.txt')) context.type = 'python';
    if (fileList.includes('Makefile')) context.hasMakefile = true;
    if (fileList.includes('Dockerfile') || fileList.includes('docker-compose.yml')) context.hasDocker = true;
    if (fileList.includes('.github')) context.hasGitHub = true;

    // Git info
    const branch = await run('git rev-parse --abbrev-ref HEAD 2>/dev/null');
    if (branch) {
      context.git = { branch };
      context.git.remote = await run('git remote get-url origin 2>/dev/null');
      context.git.status = await run('git status --short 2>/dev/null');
      const commitCount = await run('git rev-list --count HEAD 2>/dev/null');
      context.git.commits = parseInt(commitCount) || 0;
    }

    // Existing conventions files
    const conventionFiles = [];
    for (const f of ['.github/copilot-instructions.md', 'AGENTS.md', 'CLAUDE.md', '.cursorrules', 'CONTRIBUTING.md', 'ARCHITECTURE.md']) {
      const exists = await run(`test -f "${f}" && echo 1 || echo 0`);
      if (exists === '1') conventionFiles.push(f);
    }
    context.conventionFiles = conventionFiles;

    // README excerpt
    const readme = await run('head -50 README.md 2>/dev/null');
    if (readme) context.readme = readme.slice(0, 2000);

    // Directory structure (top level)
    const tree = await run('find . -maxdepth 2 -type d -not -path "*/node_modules/*" -not -path "*/.git/*" -not -path "*/dist/*" -not -path "*/__pycache__/*" -not -path "*/.next/*" 2>/dev/null | sort | head -60');
    context.structure = tree;

    // Test framework detection
    if (context.type === 'node' && context.scripts) {
      const testScript = context.scripts.test || '';
      if (testScript.includes('jest')) context.testFramework = 'jest';
      else if (testScript.includes('vitest')) context.testFramework = 'vitest';
      else if (testScript.includes('mocha')) context.testFramework = 'mocha';
      else if (testScript.includes('playwright')) context.testFramework = 'playwright';
    }

    // Generate summary prompt for system injection
    const summary = generateWorkspaceSummary(context);
    context.summary = summary;

    res.json({ ok: true, context });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

function generateWorkspaceSummary(ctx) {
  const parts = [];
  if (ctx.name) parts.push(`Project: ${ctx.name}`);
  if (ctx.type) parts.push(`Type: ${ctx.type}`);
  if (ctx.packageManager) parts.push(`Package manager: ${ctx.packageManager}`);
  if (ctx.git) {
    parts.push(`Git: branch=${ctx.git.branch}, ${ctx.git.commits} commits`);
    if (ctx.git.remote) parts.push(`Remote: ${ctx.git.remote}`);
    if (ctx.git.status) parts.push(`Uncommitted changes:\n${ctx.git.status}`);
  }
  if (ctx.scripts) {
    const important = ['dev', 'start', 'build', 'test', 'lint', 'format', 'deploy'];
    const found = important.filter(k => ctx.scripts[k]);
    if (found.length) parts.push(`Scripts: ${found.map(k => `${k}="${ctx.scripts[k]}"`).join(', ')}`);
  }
  if (ctx.testFramework) parts.push(`Test framework: ${ctx.testFramework}`);
  if (ctx.hasMakefile) parts.push('Has Makefile');
  if (ctx.hasDocker) parts.push('Has Docker config');
  if (ctx.conventionFiles.length) parts.push(`Convention files: ${ctx.conventionFiles.join(', ')}`);
  return parts.join('\n');
}

// ── File Filter / Indexing (Feature E) ────────────────────────────────────
// Returns whether a file should be indexed/read (excludes binaries, junk, etc.)
const EXCLUDED_EXTENSIONS = new Set([
  'jpg','jpeg','jpe','png','gif','bmp','tif','tiff','tga','ico','icns','xpm','webp','svg','eps',
  'heif','heic','raw','arw','cr2','cr3','nef','nrw','orf','raf','rw2','rwl','pef','srw','x3f',
  'erf','kdc','3fr','mef','mrw','iiq','gpr','dng',
  'mp4','m4v','mkv','webm','mov','avi','wmv','flv',
  'mp3','wav','m4a','flac','ogg','wma','weba','aac','pcm',
  '7z','bz2','gz','tgz','rar','tar','xz','zip','vsix','iso','img','pkg',
  'woff','woff2','otf','ttf','eot',
  'obj','fbx','stl','3ds','dae','blend','ply','glb','gltf','max','c4d','ma','mb','pcd',
  'pdf','ai','ps','indd','doc','docx','xls','xlsx','ppt','pptx','odt','ods','odp','rtf',
  'psd','pbix',
  'exe','db','db-wal','db-shm','sqlite','parquet','bin','dat','data','hex',
  'cache','sum','hash','wasm','pdb','idb','sym','coverage','testlog',
  'pack','lock','log','trace','tlog','snap','msi','deb',
  'vsidx','suo','xcuserstate','download','map','tsbuildinfo','jsbundle',
  'dll','dylib','so','a','o','lib','out','elf','nupkg','winmd',
  'pyc','pkl','pickle','pyd','rlib','rmeta','dill',
  'jar','class','ear','war','apk','dex','phar',
  'pfx','p12','pem','crt','cer','key','priv','jks','keystore','csr',
]);

const EXCLUDED_DIRS = new Set([
  'node_modules', 'bower_components', '.git', '.svn', '.hg', '.yarn',
  'dist', 'out', 'build', '.next', '.nuxt', '.turbo', '.parcel-cache',
  '__pycache__', 'venv', '.venv', '.mypy_cache', '.pytest_cache', '.ruff_cache', '.tox',
  'Pods', '.gradle', '.terraform', '.nyc_output',
  '.vscode-test', '.cache',
]);

const EXCLUDED_FILES = new Set([
  '.ds_store', 'thumbs.db', 'package-lock.json', 'yarn.lock', 'pnpm-lock.yaml',
]);

const MAX_INDEXABLE_SIZE = 1.5 * 1024 * 1024; // 1.5 MB

function shouldIndexFile(filePath, statSize) {
  const base = path.basename(filePath).toLowerCase();
  if (EXCLUDED_FILES.has(base)) return false;
  const ext = path.extname(filePath).replace('.', '').toLowerCase();
  if (EXCLUDED_EXTENSIONS.has(ext)) return false;
  const parts = filePath.toLowerCase().split(path.sep);
  if (parts.some(p => EXCLUDED_DIRS.has(p))) return false;
  if (statSize !== undefined && statSize > MAX_INDEXABLE_SIZE) return false;
  return true;
}

app.post('/api/file-filter', (req, res) => {
  const { files } = req.body;
  if (!Array.isArray(files)) return res.status(400).json({ error: 'files array required' });
  const results = files.map(f => ({
    path: f.path || f,
    indexable: shouldIndexFile(f.path || f, f.size),
  }));
  res.json({ results });
});

// ── URL content fetcher ───────────────────────────────────────────────────

// Block SSRF: reject private/loopback/link-local IPs and non-http(s) schemes
function validateExternalUrl(raw) {
  let parsed;
  try { parsed = new URL(raw); } catch (_) { throw new Error('Invalid URL'); }
  if (!/^https?:$/.test(parsed.protocol)) throw new Error('Only http/https URLs allowed');
  const host = parsed.hostname.toLowerCase();
  const blocked = ['localhost', '127.0.0.1', '[::1]', '0.0.0.0'];
  if (blocked.includes(host)) throw new Error('Access to localhost is blocked');
  // Block private/link-local ranges by first octet
  if (/^(10|172\.(1[6-9]|2\d|3[01])|192\.168|169\.254)\./.test(host)) throw new Error('Access to private networks is blocked');
  return parsed.href;
}

app.post('/api/fetch-url', async (req, res) => {
  const { url } = req.body;
  if (!url) return res.status(400).json({ error: 'URL required' });

  try {
    const safeUrl = validateExternalUrl(url);
    const response = await fetch(safeUrl, {
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; CopilotChat/1.0)' },
      signal:  AbortSignal.timeout(12000),
      redirect: 'follow',
    });

    const contentType = response.headers.get('content-type') || '';
    if (!response.ok) throw new Error(`HTTP ${response.status}`);

    let content, title = url;

    if (contentType.includes('application/json')) {
      const json = await response.json();
      content = JSON.stringify(json, null, 2);
      title   = `JSON from ${new URL(url).hostname}`;
    } else {
      const html = await response.text();
      // Extract title
      title   = (html.match(/<title[^>]*>([^<]+)<\/title>/i)?.[1] || url).trim().replace(/[<>"'`]/g, '');
      // Strip scripts, styles, nav, footer then HTML tags
      content = html
        .replace(/<script[\s\S]*?<\/script>/gi,   '')
        .replace(/<style[\s\S]*?<\/style>/gi,      '')
        .replace(/<nav[\s\S]*?<\/nav>/gi,          '')
        .replace(/<footer[\s\S]*?<\/footer>/gi,    '')
        .replace(/<header[\s\S]*?<\/header>/gi,    '')
        .replace(/<[^>]+>/g, ' ')
        .replace(/\s{2,}/g, ' ')
        .trim()
        .slice(0, 20000);
    }

    res.json({ url, title, content, chars: content.length });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// ── Browser (Playwright) — full JS-rendered page browsing ─────────────────
// Uses the installed Google Chrome to load pages with full JS execution,
// bypassing anti-bot measures that block simple fetch requests.
// Inspired by github.com/ntegrals/openbrowser (MIT).

const CHROME_PATH = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const EDGE_PATH   = '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge';
const BROWSER_PATH = fs.existsSync(EDGE_PATH) ? EDGE_PATH : CHROME_PATH;
const EDGE_UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/146.0.0.0 Safari/537.36 Edg/146.0.3856.62';
const CHROME_UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/146.0.7680.153 Safari/537.36';
const BROWSE_UA = fs.existsSync(EDGE_PATH) ? EDGE_UA : CHROME_UA;
let _browserInstance = null;
let _browsePage = null;          // persistent reusable page (keeps cookies/session)
let _playwrightAvailable = null; // null = unchecked, true/false after first attempt
const _shellProcs = new Map();   // killId → ChildProcess (for user-initiated cancel)

async function getBrowser() {
  // If we already know playwright isn't available, fail fast
  if (_playwrightAvailable === false) throw new Error('playwright-core not available in this environment');

  // Reset stale/crashed instances
  if (_browserInstance) {
    try {
      if (!_browserInstance.isConnected()) _browserInstance = null;
    } catch { _browserInstance = null; }
  }

  if (_browserInstance) return _browserInstance;

  // Try puppeteer-extra + stealth first (best bot-detection bypass)
  try {
    const puppeteerExtra = _require('puppeteer-extra');
    const StealthPlugin   = _require('puppeteer-extra-plugin-stealth');
    puppeteerExtra.use(StealthPlugin());
    // Use the real Edge user data dir so Akamai sees an established browser session with cookies/history
    const edgeUserDataDir = ISEDGE
      ? path.join(os.homedir(), 'Library', 'Application Support', 'Microsoft Edge')
      : null;
    const launchOpts = {
      executablePath: BROWSER_PATH,
      headless: false,
      args: [
        '--no-sandbox',
        '--disable-blink-features=AutomationControlled',
        '--disable-dev-shm-usage',
        '--disable-setuid-sandbox',
        '--window-size=1280,900',
        '--window-position=-2000,-2000',
        '--lang=en-US,en',
        '--profile-directory=Default',
      ],
    };
    if (edgeUserDataDir) launchOpts.userDataDir = edgeUserDataDir;
    _browserInstance = await puppeteerExtra.launch(launchOpts);
    _browserInstance._isPuppeteer = true;  // flag for browse endpoint
    _playwrightAvailable = true;
    return _browserInstance;
  } catch (pErr) {
    _browserInstance = null;
    // Fall through to playwright-core
  }

  try {
    const pw = await import('playwright-core');
    const chromium = pw.chromium || pw.default?.chromium;
    if (!chromium) throw new Error('playwright-core loaded but chromium not found — check module exports');
    _browserInstance = await chromium.launch({
      executablePath: BROWSER_PATH,
      headless: false,
      args: [
        '--no-sandbox',
        '--disable-blink-features=AutomationControlled',
        '--disable-dev-shm-usage',
        '--disable-setuid-sandbox',
        '--disable-infobars',
        '--window-size=1280,900',
        '--window-position=-2000,-2000',
        '--lang=en-US,en',
        '--disable-web-security',
      ],
    });
    _playwrightAvailable = true;
    return _browserInstance;
  } catch (err) {
    _browserInstance = null;
    if (err.message.includes('playwright-core') || err.message.includes('Cannot find module')) {
      _playwrightAvailable = false;
    }
    throw err;
  }
}

const ISEDGE = fs.existsSync(EDGE_PATH);
const SEC_CH_UA = ISEDGE
  ? '"Microsoft Edge";v="146", "Chromium";v="146", "Not/A)Brand";v="24"'
  : '"Google Chrome";v="146", "Chromium";v="146", "Not/A)Brand";v="24"';

// Returns a persistent page that reuses cookies/session across browse calls.
async function getBrowsePage() {
  // Check if existing page is still usable
  if (_browsePage) {
    try {
      await _browsePage.evaluate(() => true);
      return _browsePage;
    } catch {
      _browsePage = null;
    }
  }

  const browser = await getBrowser();
  const isPuppeteer = !!browser._isPuppeteer;

  let page;
  if (isPuppeteer) {
    page = await browser.newPage();
    await page.setUserAgent(BROWSE_UA);
    await page.setViewport({ width: 1280, height: 900 });
    await page.setExtraHTTPHeaders({
      'Accept-Language': 'en-US,en;q=0.9',
      'sec-ch-ua': SEC_CH_UA,
      'sec-ch-ua-mobile': '?0',
      'sec-ch-ua-platform': '"macOS"',
    });
  } else {
    const context = await browser.newContext({
      userAgent: BROWSE_UA,
      viewport: { width: 1280, height: 900 },
      locale: 'en-US',
      timezoneId: 'America/New_York',
      extraHTTPHeaders: {
        'Accept-Language': 'en-US,en;q=0.9',
        'sec-ch-ua': SEC_CH_UA,
        'sec-ch-ua-mobile': '?0',
        'sec-ch-ua-platform': '"macOS"',
      },
    });
    await context.addInitScript(() => {
      Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
    });
    page = await context.newPage();
  }

  _browsePage = page;
  return page;
}

const _warmedDomains = new Set(); // domains we've already visited the homepage for

async function navigateWithWarmup(page, url) {
  const origin = new URL(url).origin;
  const targetPath = new URL(url).pathname;
  const isHomepage = targetPath === '/' || targetPath === '';

  // If navigating to a deep page on a domain we haven't warmed up, visit homepage first
  if (!isHomepage && !_warmedDomains.has(origin)) {
    await page.goto(origin, { waitUntil: 'domcontentloaded', timeout: 20000 }).catch(() => {});
    // Brief pause to let Akamai set session cookies
    await new Promise(r => setTimeout(r, 1500));
    _warmedDomains.add(origin);
  }

  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
  if (!_warmedDomains.has(origin)) _warmedDomains.add(origin);
}

function htmlToMarkdown(html, baseUrl) {
  try {
    const TurndownService = _require('turndown');
    const td = new TurndownService({
      headingStyle: 'atx', bulletListMarker: '-', codeBlockStyle: 'fenced'
    });
    td.remove(['script', 'style', 'nav', 'footer', 'header', 'aside', 'noscript', 'svg', 'iframe']);
    // Make relative URLs absolute
    if (baseUrl) {
      html = html.replace(/href="([^"]+)"/g, (m, href) => {
        try { return `href="${new URL(href, baseUrl).href}"`; } catch { return m; }
      });
    }
    return td.turndown(html);
  } catch {
    // Fallback: strip tags
    return html.replace(/<[^>]+>/g, ' ').replace(/\s{2,}/g, ' ').trim();
  }
}

// Simple curl-based fallback when Playwright isn't available
async function fetchUrlFallback(url, maxChars = 12000) {
  return new Promise((resolve, reject) => {
    _execFile('curl', ['-sL', '--max-time', '15', '-A', BROWSE_UA, '--', url],
      { maxBuffer: 5 * 1024 * 1024 },
      (err, stdout) => {
        if (err) return reject(err);
        const html = stdout || '';
        const title = (html.match(/<title[^>]*>([^<]*)<\/title>/i) || [])[1] || '';
        const content = htmlToMarkdown(html, url);
        resolve({ url, title, content: content.slice(0, maxChars), chars: content.length, fallback: true });
      }
    );
  });
}

app.get('/api/browse-check', async (req, res) => {
  const chromePath = BROWSER_PATH;
  const chromeExists = fs.existsSync(chromePath);
  let playwrightOk = false;
  let playwrightError = null;
  try {
    const pw = await import('playwright-core');
    playwrightOk = !!(pw.chromium || pw.default?.chromium);
  } catch (e) {
    playwrightError = e.message;
  }
  res.json({ chromeExists, chromeExePath: chromePath, playwrightOk, playwrightError });
});

app.post('/api/browse', async (req, res) => {
  const { url, action = 'extract', selector, text, waitFor, maxChars = 12000 } = req.body;
  if (!url) return res.status(400).json({ error: 'url required' });

  let page;
  try {
    page = await getBrowsePage();

    // Navigate with homepage warm-up for domains that use referrer-based bot protection
    await navigateWithWarmup(page, url);

    // Detect challenge page (Akamai "Powered and protected", Cloudflare "Just a moment")
    const isChallenge = async () => {
      const title = await page.title().catch(() => '');
      const body  = await page.evaluate(() => document.body?.innerText?.slice(0, 200) || '').catch(() => '');
      return title === '' || /access denied|just a moment|checking your browser|powered and protected|enable javascript/i.test(title + ' ' + body);
    };

    // If we landed on a challenge, wait for real content to appear (poll title + handle reloads)
    if (await isChallenge()) {
      await page.waitForFunction(
        () => {
          const t = document.title;
          if (!t) return false;
          return !/access denied|just a moment|checking your browser|powered and protected/i.test(t);
        },
        { timeout: 25000 }
      ).catch(() => {});
    }
    try { await page.waitForLoadState('networkidle', { timeout: 8000 }); } catch {}

    if (waitFor) {
      try { await page.waitForSelector(waitFor, { timeout: 8000 }); } catch {}
    }

    let result = {};

    if (action === 'extract' || action === 'navigate') {
      const title   = await page.title();
      const pageUrl = page.url();
      const html    = await page.content();
      const md      = htmlToMarkdown(html, pageUrl);
      const stillBlocked = await isChallenge();
      result = { url: pageUrl, title, content: md.slice(0, maxChars), chars: md.length };
      if (stillBlocked) result.blocked = true;

    } else if (action === 'screenshot') {
      const buf = await page.screenshot({ type: 'jpeg', quality: 70 });
      result = { url: page.url(), screenshot: buf.toString('base64'), mime: 'image/jpeg' };

    } else if (action === 'click') {
      await page.click(selector || text, { timeout: 5000 });
      const html = await page.content();
      result = { url: page.url(), content: htmlToMarkdown(html, page.url()).slice(0, maxChars) };

    } else if (action === 'type') {
      await page.fill(selector, text);
      result = { ok: true };

    } else if (action === 'eval') {
      const evalResult = await page.evaluate(text);
      result = { result: JSON.stringify(evalResult) };
    }

    try { await page.close(); } catch {}
    res.json(result);
  } catch (err) {
    if (page) { try { await page.close(); } catch {} }
    // Playwright failed — try curl fallback for extract actions
    if ((action === 'extract' || action === 'navigate') && _playwrightAvailable !== false) {
      try {
        const fallback = await fetchUrlFallback(url, maxChars);
        return res.json(fallback);
      } catch { /* fall through to error */ }
    }
    res.status(500).json({ error: err.message });
  }
});

// ── Figma bridge ──────────────────────────────────────────────────────────
// Connects as a "controller" to the CopilotMCP WS relay at port 3335.
// When the Figma plugin (CopilotMCP/CopilotChat plugin in Figma desktop) is open,
// this bridge can execute arbitrary Figma Plugin API code and query design state.

import { spawn } from 'child_process';

const FIGMA_WS_URL     = 'ws://localhost:3335';
const FIGMA_RULES_FILE = path.join(CONFIG_DIR, 'figma-rules.json');
const DEFAULT_MCP_PATH = path.join(os.homedir(), 'FigmaExtensions', 'CopilotMCP', 'server', 'index.js');

// ── MCP server process management ────────────────────────────────────────

let mcpProcess    = null;
let mcpLogs       = [];       // last 200 stderr lines
let mcpAutoStart  = true;     // start with the app by default

function findNodeBinary() {
  const candidates = IS_WIN ? [
    'C:\\Program Files\\nodejs\\node.exe',
    path.join(os.homedir(), 'AppData', 'Roaming', 'nvm', 'current', 'node.exe'),
    path.join(os.homedir(), 'scoop', 'shims', 'node.exe'),
  ] : [
    '/opt/homebrew/bin/node',   // Apple Silicon Homebrew
    '/usr/local/bin/node',      // Intel Homebrew
    '/opt/homebrew/opt/node/bin/node',
    '/usr/bin/node',
    '/usr/local/bin/node',
  ];
  const binName = IS_WIN ? 'node.exe' : 'node';
  const pathDirs = (process.env.PATH || '').split(PATH_SEP);
  for (const dir of pathDirs) candidates.push(path.join(dir, binName));
  for (const p of candidates) {
    try { fs.accessSync(p, fs.constants.X_OK); return p; } catch (_) {}
  }
  return null;
}

function getMcpServerPath() {
  const cfg = readSavedConfig();
  const p = path.resolve(cfg.mcpServerPath || DEFAULT_MCP_PATH);
  // Only allow .js files under the user's home directory
  if (!p.endsWith('.js') || !p.startsWith(os.homedir())) {
    return DEFAULT_MCP_PATH;
  }
  return p;
}

function isMcpRunning() {
  return mcpProcess !== null && mcpProcess.exitCode === null;
}

function startMcpServer() {
  if (isMcpRunning()) return { ok: true, already: true };

  const serverPath = getMcpServerPath();
  if (!fs.existsSync(serverPath)) {
    return { ok: false, error: `MCP server not found at: ${serverPath}` };
  }

  const nodeBin = findNodeBinary();
  if (!nodeBin) return { ok: false, error: IS_WIN
    ? 'Node.js binary not found. Install Node.js from nodejs.org or via winget/scoop.'
    : 'Node.js binary not found. Install Node.js via Homebrew.' };

  mcpLogs = [];
  const serverDir = path.dirname(serverPath);

  const mcpEnvPATH = IS_WIN
    ? (process.env.PATH || '')
    : `/opt/homebrew/bin:/usr/local/bin:${process.env.PATH || '/usr/bin:/bin'}`;

  mcpProcess = spawn(nodeBin, [serverPath], {
    cwd: serverDir,
    stdio: ['ignore', 'ignore', 'pipe'],  // stdin/stdout ignored; capture stderr for logs
    env: { ...process.env, PATH: mcpEnvPATH }
  });

  mcpProcess.stderr.on('data', chunk => {
    const lines = chunk.toString().split('\n').filter(Boolean);
    for (const line of lines) {
      mcpLogs.push({ t: Date.now(), msg: line });
      if (mcpLogs.length > 200) mcpLogs.shift();
    }
  });

  mcpProcess.on('exit', (code, signal) => {
    const reason = signal ? `signal ${signal}` : `code ${code}`;
    mcpLogs.push({ t: Date.now(), msg: `[App] MCP server exited (${reason})` });
    mcpProcess = null;
    // Auto-reconnect WS after brief delay (process may restart)
    figmaState.connected = false;
    figmaState.fileInfo  = null;
  });

  mcpProcess.on('error', err => {
    mcpLogs.push({ t: Date.now(), msg: `[App] Failed to start: ${err.message}` });
    mcpProcess = null;
  });

  // Reconnect WS bridge after server has had time to start
  setTimeout(() => {
    if (figmaState.pendingReconnect) clearTimeout(figmaState.pendingReconnect);
    figmaConnect();
  }, 1200);

  return { ok: true };
}

function stopMcpServer() {
  if (!isMcpRunning()) return { ok: true, already: true };
  mcpProcess.kill('SIGTERM');
  // Force-kill after 3 s if it hasn't exited
  setTimeout(() => { if (isMcpRunning()) mcpProcess.kill('SIGKILL'); }, 3000);
  return { ok: true };
}

// ── MCP server endpoints ──────────────────────────────────────────────────

app.get('/api/figma/mcp-status', (req, res) => {
  res.json({
    running: isMcpRunning(),
    pid:     mcpProcess?.pid ?? null,
    path:    getMcpServerPath(),
    logs:    mcpLogs.slice(-50),
  });
});

app.post('/api/figma/mcp-start', (req, res) => {
  const result = startMcpServer();
  res.json(result);
});

app.post('/api/figma/mcp-stop', (req, res) => {
  const result = stopMcpServer();
  res.json(result);
});

app.get('/api/figma/mcp-logs', (req, res) => {
  const since = parseInt(req.query.since || '0', 10);
  res.json(mcpLogs.filter(l => l.t > since));
});

// ── WS bridge fields ──────────────────────────────────────────────────────

let figmaWs      = null;
let figmaState   = { connected: false, fileInfo: null, activeSystem: null, pendingReconnect: null };
const figmaPending = new Map(); // id → { resolve, reject, timer }

function readFigmaRules() {
  try { return JSON.parse(fs.readFileSync(FIGMA_RULES_FILE, 'utf8')); }
  catch (_) { return []; }
}
function writeFigmaRules(rules) {
  fs.mkdirSync(CONFIG_DIR, { recursive: true });
  fs.writeFileSync(FIGMA_RULES_FILE, JSON.stringify(rules, null, 2));
}

function figmaConnect() {
  if (figmaWs && figmaWs.readyState < 2) return; // already open or connecting
  try {
    const WS = _require('ws');
    figmaWs = new WS(FIGMA_WS_URL);

    figmaWs.on('open', () => {
      figmaState.connected = true;
      figmaState.pendingReconnect = null;
      figmaWs.send(JSON.stringify({ type: 'client-hello', clientName: 'Copilot Chat App' }));
      console.log('[Figma] Controller connected to relay');
    });

    figmaWs.on('message', raw => {
      let msg; try { msg = JSON.parse(raw.toString()); } catch (_) { return; }

      if (msg.type === 'FILE_INFO') {
        figmaState.fileInfo = { fileName: msg.fileName, fileKey: msg.fileKey, currentPage: msg.currentPage, currentPageId: msg.currentPageId };
      }
      if (msg.type === 'active-system') {
        figmaState.activeSystem = { id: msg.id, name: msg.name };
      }
      // Route execute-result back to waiting callers
      if (msg.id && figmaPending.has(msg.id)) {
        const { resolve, timer } = figmaPending.get(msg.id);
        clearTimeout(timer); figmaPending.delete(msg.id); resolve(msg);
      }
    });

    figmaWs.on('close', () => {
      figmaState.connected = false;
      figmaState.fileInfo  = null;
      // Immediately reject all in-flight requests so they don't hang for 30 s
      for (const [id, { reject, timer }] of figmaPending) {
        clearTimeout(timer);
        figmaPending.delete(id);
        reject(new Error('Figma relay disconnected — please reconnect the plugin'));
      }
      console.log('[Figma] Relay disconnected — retrying in 5 s');
      figmaState.pendingReconnect = setTimeout(figmaConnect, 5000);
    });

    figmaWs.on('error', () => {
      // Suppress — handled in close
    });

    // Heartbeat: ping every 20 s so dead TCP connections are detected quickly
    const pingInterval = setInterval(() => {
      if (!figmaWs || figmaWs.readyState !== 1) { clearInterval(pingInterval); return; }
      try { figmaWs.ping(); } catch (_) {}
    }, 20000);
    figmaWs.once('close', () => clearInterval(pingInterval));
  } catch (e) {
    console.log('[Figma] WS module not available:', e.message);
  }
}

// ── Figma progress logger ─────────────────────────────────────────────────
function figmaLog(message, level = 'info') {
  if (figmaWs && figmaWs.readyState === 1) {
    figmaWs.send(JSON.stringify({ type: 'progress-log', message, level }));
  }
}

// ── Figma Dev Mode MCP Client ─────────────────────────────────────────────
// Connects to Figma's built-in MCP server at http://127.0.0.1:3845/mcp
// Provides AI with design context, variables, screenshots, and more.

const FIGMA_MCP_URL = 'http://127.0.0.1:3845/mcp';

class FigmaMCPClient {
  constructor() { this.sessionId = null; this.toolsCache = null; }

  async _post(body) {
    const headers = { 'Content-Type': 'application/json', 'Accept': 'application/json, text/event-stream' };
    if (this.sessionId) headers['mcp-session-id'] = this.sessionId;
    const res = await fetch(FIGMA_MCP_URL, {
      method: 'POST', headers, body: JSON.stringify(body),
      signal: AbortSignal.timeout(30000)
    });
    if (!this.sessionId) this.sessionId = res.headers.get('mcp-session-id');
    const text = await res.text();
    // SSE: join all data: lines from the last event block
    // Multiple data: lines in one event are continuations (joined with \n)
    // Multiple events are separated by blank lines — we want the last one with JSON-RPC result
    let jsonStr = null;
    for (const block of text.split(/\n\n+/).filter(Boolean)) {
      const lines = block.split('\n').filter(l => l.startsWith('data: ')).map(l => l.slice(6));
      if (lines.length > 0) jsonStr = lines.join('\n');
    }
    if (!jsonStr) jsonStr = text;
    return JSON.parse(jsonStr);
  }

  async init() {
    const r = await this._post({ jsonrpc: '2.0', method: 'initialize',
      params: { protocolVersion: '2024-11-05', capabilities: {},
        clientInfo: { name: 'CopilotChat', version: '1.0.0' } }, id: 1 });
    return r.result;
  }

  // figma_execute is always available — independent of port-3845 (Figma Dev Mode MCP)
  static get FIGMA_EXECUTE_TOOL() {
    return {
      type: 'function',
      function: {
        name: 'figma_execute',
        description: 'Execute Figma Plugin API JavaScript code to CREATE, MODIFY, or DELETE nodes in the open Figma file. Use this instead of the REST API — no PAT required. The code runs inside the Figma plugin context and has full access to the figma object (figma.currentPage, figma.createFrame, figma.createText, etc). IMPORTANT: when accessing .componentProperties or .componentPropertyDefinitions on any node, always wrap in try/catch (e.g. `let props; try { props = node.componentProperties || {}; } catch(_) { props = {}; }`) to avoid "Component set for node has existing errors" on broken components.',
        parameters: {
          type: 'object',
          properties: {
            code: { type: 'string', description: 'Valid Figma Plugin API JavaScript to execute. Must be synchronous or use async/await. Return a value with `return` to get output.' }
          },
          required: ['code']
        }
      }
    };
  }

  async getTools() {
    // Always include figma_execute even if the Figma Dev Mode MCP (port 3845) is unreachable
    if (this.toolsCache) return this.toolsCache;
    try {
      if (!this.sessionId) await this.init();
      const r = await this._post({ jsonrpc: '2.0', method: 'tools/list', params: {}, id: 2 });
      this.toolsCache = (r.result?.tools || []).map(t => ({
        type: 'function',
        function: { name: t.name, description: t.description, parameters: t.inputSchema || { type: 'object', properties: {} } }
      }));
      // Remove any figma_execute the remote server may have to avoid duplicates
      this.toolsCache = this.toolsCache.filter(t => t.function.name !== 'figma_execute');
    } catch (_) {
      // Port-3845 unavailable — serve figma_execute on its own
      this.toolsCache = [];
    }
    this.toolsCache.push(FigmaMCPClient.FIGMA_EXECUTE_TOOL);
    return this.toolsCache;
  }

  async callTool(name, args) {
    // figma_execute is a local tool — route through the port-3335 plugin relay
    if (name === 'figma_execute') {
      let code = args.code;
      let result = await figmaSend({ type: 'execute-code', code });

      // Auto-recover from unloaded font errors: parse the fonts out of the error,
      // prepend loadFontAsync calls, and retry once.
      if (result.error && result.error.includes('unloaded font')) {
        const fontCalls = [];
        const re = /figma\.loadFontAsync\(\s*\{[^}]+\}\s*\)/g;
        let m;
        const seen = new Set();
        while ((m = re.exec(result.error)) !== null) {
          const call = 'await ' + m[0] + '.catch(()=>{});';
          if (!seen.has(call)) { seen.add(call); fontCalls.push(call); }
        }
        if (fontCalls.length) {
          const wrappedCode = '// auto-load missing fonts\n' + fontCalls.join('\n') + '\n\n' + code;
          result = await figmaSend({ type: 'execute-code', code: wrappedCode });
        }
      }

      if (result.error) throw new Error(result.error);
      return typeof result.result !== 'undefined' ? JSON.stringify(result.result) : 'Done';
    }
    if (!this.sessionId) await this.init();
    const r = await this._post({ jsonrpc: '2.0', method: 'tools/call',
      params: { name, arguments: args }, id: Date.now() });
    if (r.error) throw new Error(r.error.message);
    const content = r.result?.content || [];
    return content.map(c => c.text || JSON.stringify(c)).join('\n');
  }

  reset() { this.sessionId = null; this.toolsCache = null; }
}

const figmaMCP = new FigmaMCPClient();

app.get('/api/figma-mcp/status', async (req, res) => {
  try {
    const tools = await figmaMCP.getTools();
    res.json({ ok: true, connected: true, toolCount: tools.length, tools: tools.map(t => t.function.name) });
  } catch (e) {
    res.json({ ok: false, connected: false, error: e.message, tools: [] });
  }
});

app.post('/api/figma-mcp/call', async (req, res) => {
  const { name, arguments: args = {} } = req.body;
  if (!name) return res.status(400).json({ error: 'name required' });
  try {
    const result = await figmaMCP.callTool(name, args);
    res.json({ ok: true, result });
  } catch (e) {
    figmaMCP.reset();
    res.status(500).json({ ok: false, error: e.message });
  }
});

// Start trying to connect immediately when the server starts
// Also auto-start the MCP server if it's not already running
setTimeout(() => {
  if (mcpAutoStart) startMcpServer();
  else figmaConnect();
}, 500);  // slight delay so the main server is fully up first

function figmaSend(command, timeoutMs = 30000) {
  return new Promise((resolve, reject) => {
    if (!figmaWs || figmaWs.readyState !== 1) {
      return reject(new Error(
        figmaState.pendingReconnect
          ? 'Figma relay is reconnecting — please try again in a moment'
          : 'Not connected to Figma relay — ensure the CopilotMCP plugin is open in Figma'
      ));
    }
    const id    = `ctrl-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const timer = setTimeout(() => { figmaPending.delete(id); reject(new Error('Figma execution timed out — the operation may have been too large or the plugin became unresponsive')); }, timeoutMs);
    figmaPending.set(id, { resolve, reject, timer });
    figmaWs.send(JSON.stringify({ ...command, id }));
  });
}

app.post('/api/open-folder', async (req, res) => {
  const { folderPath } = req.body;
  if (!folderPath) return res.status(400).json({ error: 'folderPath required' });
  try {
    const { shell } = _require('electron');
    await shell.openPath(folderPath);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── Window controls (Windows custom title bar) ───────────────────────────
app.post('/api/window/:action', (req, res) => {
  try {
    const { BrowserWindow } = _require('electron');
    const win = BrowserWindow.getFocusedWindow() || BrowserWindow.getAllWindows()[0];
    if (!win) return res.status(404).json({ error: 'No window' });
    switch (req.params.action) {
      case 'minimize': win.minimize(); break;
      case 'maximize': win.isMaximized() ? win.unmaximize() : win.maximize(); break;
      case 'close':    win.close(); break;
      default: return res.status(400).json({ error: 'Unknown action' });
    }
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});



const PLUGIN_INSTALL_DIR = path.join(CONFIG_DIR, 'figma-plugin');

function getBundledPluginDir() {
  // In packaged Electron app, extraResources land at process.resourcesPath/figma-plugin
  // In dev (node server.js), fall back to the local assets folder
  const packed = path.join(process.resourcesPath || '', 'figma-plugin');
  if (fs.existsSync(packed)) return packed;
  return path.join(__dirname, 'assets', 'figma-plugin');
}

app.get('/api/figma/plugin-info', (req, res) => {
  const installed = fs.existsSync(path.join(PLUGIN_INSTALL_DIR, 'manifest.json'));
  res.json({
    installed,
    installDir:   installed ? PLUGIN_INSTALL_DIR : null,
    bundledDir:   getBundledPluginDir(),
  });
});

app.post('/api/figma/plugin-install', (req, res) => {
  try {
    const src = getBundledPluginDir();
    if (!fs.existsSync(src)) return res.status(404).json({ error: 'Bundled plugin not found' });

    fs.mkdirSync(PLUGIN_INSTALL_DIR, { recursive: true });
    for (const file of ['manifest.json', 'code.js', 'ui.html']) {
      fs.copyFileSync(path.join(src, file), path.join(PLUGIN_INSTALL_DIR, file));
    }
    res.json({ ok: true, installDir: PLUGIN_INSTALL_DIR });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/figma/plugin-download', (req, res) => {
  try {
    const src = getBundledPluginDir();
    if (!fs.existsSync(src)) return res.status(404).json({ error: 'Bundled plugin not found' });

    // Use osascript on macOS or PowerShell on Windows to open a folder picker
    let chosenDir;
    if (process.platform === 'darwin') {
      try {
        chosenDir = execSync(
          `osascript -e 'set f to choose folder with prompt "Choose where to save the Figma plugin"' -e 'POSIX path of f'`,
          { encoding: 'utf8', timeout: 60000 }
        ).trim();
      } catch (_) {
        return res.json({ ok: false, cancelled: true });
      }
    } else {
      // Windows fallback
      try {
        chosenDir = execSync(
          `powershell -Command "[System.Reflection.Assembly]::LoadWithPartialName('System.Windows.Forms') | Out-Null; $d = New-Object System.Windows.Forms.FolderBrowserDialog; $d.Description = 'Choose where to save the Figma plugin'; if ($d.ShowDialog() -eq 'OK') { $d.SelectedPath } else { throw 'cancelled' }"`,
          { encoding: 'utf8', timeout: 60000 }
        ).trim();
      } catch (_) {
        return res.json({ ok: false, cancelled: true });
      }
    }
    if (!chosenDir) return res.json({ ok: false, cancelled: true });

    const destDir = path.join(chosenDir, 'CopilotFigmaMCPPlugin');
    fs.mkdirSync(destDir, { recursive: true });
    for (const file of fs.readdirSync(src)) {
      fs.copyFileSync(path.join(src, file), path.join(destDir, file));
    }
    res.json({ ok: true, downloadDir: destDir });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── Figma API endpoints ───────────────────────────────────────────────────

app.get('/api/figma/status', (req, res) => {
  const figmaConnected = figmaState.connected && !!figmaState.fileInfo;
  res.json({
    relayConnected: figmaState.connected,
    figmaConnected,
    fileInfo:      figmaState.fileInfo,
    activeSystem:  figmaState.activeSystem,
    mcpRunning:    isMcpRunning(),
    mcpPid:        mcpProcess?.pid ?? null,
  });
});

app.post('/api/figma/connect', (req, res) => {
  if (figmaState.pendingReconnect) clearTimeout(figmaState.pendingReconnect);
  figmaConnect();
  res.json({ ok: true });
});

app.post('/api/figma/execute', async (req, res) => {
  const { code, timeout } = req.body;
  if (!code) return res.status(400).json({ error: 'code required' });
  try {
    const result = await figmaSend({ type: 'execute-code', code }, timeout || 15000);
    res.json({ ok: true, result: result.result, error: result.error });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ── Figma Rules endpoints ─────────────────────────────────────────────────

app.get('/api/figma/rules', (req, res) => {
  res.json(readFigmaRules());
});

app.post('/api/figma/rules', (req, res) => {
  const { text, enabled = true } = req.body;
  if (!text || !text.trim()) return res.status(400).json({ error: 'text required' });
  const rules = readFigmaRules();
  const rule  = { id: Date.now().toString(), text: text.trim(), enabled };
  rules.push(rule);
  writeFigmaRules(rules);
  res.json(rule);
});

app.put('/api/figma/rules/:id', (req, res) => {
  const rules  = readFigmaRules();
  const idx    = rules.findIndex(r => r.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: 'Rule not found' });
  rules[idx]   = { ...rules[idx], ...req.body, id: rules[idx].id };
  writeFigmaRules(rules);
  res.json(rules[idx]);
});

app.delete('/api/figma/rules/:id', (req, res) => {
  const rules = readFigmaRules();
  const next  = rules.filter(r => r.id !== req.params.id);
  writeFigmaRules(next);
  res.json({ ok: true });
});

// ── Shell execution ───────────────────────────────────────────────────────
// Runs arbitrary shell commands and returns stdout/stderr/exit code.
// On macOS/Linux, PATH is augmented with Homebrew and common locations.
// On Windows, PowerShell is used as the default shell.

const AUGMENTED_PATH = IS_WIN
  ? (process.env.PATH || '')
  : [
      '/opt/homebrew/bin', '/opt/homebrew/sbin',
      '/usr/local/bin', '/usr/local/sbin',
      '/usr/bin', '/usr/sbin', '/bin', '/sbin',
      process.env.PATH || ''
    ].join(':');

const SHELL_BIN = IS_WIN ? 'powershell.exe' : '/bin/zsh';

app.post('/api/shell-exec', (req, res) => {
  const { command, cwd, killId } = req.body;
  if (!command) return res.status(400).json({ error: 'command required' });

  const workDir = cwd || os.homedir();
  const env = {
    ...process.env,
    PATH: AUGMENTED_PATH,
    HOME: os.homedir(),
    USER: os.userInfo().username,
    ...(IS_WIN ? {} : { SHELL: '/bin/zsh', TERM: 'xterm-256color' }),
  };

  const child = _exec(command, { cwd: workDir, env, timeout: 300000, maxBuffer: 10 * 1024 * 1024, shell: SHELL_BIN },
    (err, stdout, stderr) => {
      if (killId) _shellProcs.delete(killId);
      if (err?.killed && !stdout && !stderr) {
        return res.json({ ok: false, exitCode: 130, stdout: '', stderr: 'Process killed by user', command, cwd: workDir, killed: true });
      }
      res.json({
        ok:       !err || err.killed === false && (err.code === 0 || stdout),
        exitCode: err?.code ?? 0,
        stdout:   stdout || '',
        stderr:   stderr || '',
        command,
        cwd: workDir,
      });
    }
  );
  if (killId) _shellProcs.set(killId, child);
});

app.post('/api/shell-kill', (req, res) => {
  const { killId } = req.body;
  if (!killId) return res.status(400).json({ error: 'killId required' });
  const child = _shellProcs.get(killId);
  if (child) {
    try { child.kill('SIGTERM'); } catch {}
    _shellProcs.delete(killId);
    res.json({ ok: true });
  } else {
    res.json({ ok: false, error: 'process not found or already done' });
  }
});

// ── Write file (no shell / no truncation) ─────────────────────────────────
// VS Code lesson: bypass shell entirely — put content in the HTTP body (20 MB limit).
// Use this instead of shell heredocs which truncate at ~16 KB.
// POST { path, content, encoding? }          → write content string to path
// POST { path, fromFile }                    → copy fromFile to path (avoids JSON quoting)
// Resolve a file path: absolute → as-is, ~/... → home expansion, relative → homedir join
function resolvePath(filePath, cwd) {
  let resolved;
  if (filePath.startsWith('/')) resolved = filePath;
  else if (filePath.startsWith('~/')) resolved = filePath.replace(/^~/, os.homedir());
  else if (cwd) resolved = path.join(cwd.replace(/^~/, os.homedir()), filePath);
  else resolved = path.join(os.homedir(), filePath);
  // Normalise to prevent directory traversal via embedded ../ segments
  resolved = path.resolve(resolved);
  const home = os.homedir();
  if (!resolved.startsWith(home) && !resolved.startsWith('/tmp')) {
    throw new Error('Path outside allowed directories');
  }
  return resolved;
}

// ── AutoRecovery — Word-style checkpoint before every destructive write ───
// Saves the current version to ~/.copilotchat-recovery/<mirrored-path>/<ts>.bak
// Keeps the 20 most-recent checkpoints per file; never throws (best-effort).
function checkpointFile(abs) {
  if (!fs.existsSync(abs)) return null;
  try {
    // Mirror the absolute path inside RECOVERY_DIR so each file has its own dir
    const rel       = abs.replace(/^[/\\]/, '').replace(/\\/g, '/');
    const mirrorDir = path.join(RECOVERY_DIR, rel);
    fs.mkdirSync(mirrorDir, { recursive: true });
    const ts   = new Date().toISOString().slice(0, 19).replace(/[:.]/g, '-');
    const dest = path.join(mirrorDir, ts + '.bak');
    fs.copyFileSync(abs, dest);
    // Prune: keep only the 20 most-recent checkpoints
    const all = fs.readdirSync(mirrorDir).filter(f => f.endsWith('.bak')).sort();
    if (all.length > 20) {
      for (const old of all.slice(0, all.length - 20)) {
        try { fs.unlinkSync(path.join(mirrorDir, old)); } catch (_) {}
      }
    }
    return dest;
  } catch (_) {
    return null; // checkpoint failure must never break the actual write
  }
}

app.post('/api/write-file', (req, res) => {
  const { path: filePath, content, fromFile, encoding, cwd } = req.body;
  if (!filePath) return res.status(400).json({ error: 'path required' });
  try {
    const abs = resolvePath(filePath, cwd);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    if (fromFile) {
      fs.copyFileSync(fromFile, abs);
      const bytes = fs.statSync(abs).size;
      res.json({ ok: true, path: abs, bytes });
    } else {
      if (content === undefined) return res.status(400).json({ error: 'content or fromFile required' });
      // Checkpoint the existing file before overwriting (AutoRecovery)
      checkpointFile(abs);
      // Atomic write: write to a temp file then rename so the original is never half-written
      const tmp = abs + '.~tmp' + process.pid;
      try {
        fs.writeFileSync(tmp, content, encoding || 'utf8');
        fs.renameSync(tmp, abs);
      } catch (e) {
        try { fs.unlinkSync(tmp); } catch (_) {}
        throw e;
      }
      res.json({ ok: true, path: abs, bytes: Buffer.byteLength(content, encoding || 'utf8') });
    }
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── Stream-write large files — bypasses the JSON body limit entirely ───────
// PUT /api/write-file-stream?path=<encoded>&cwd=<encoded>
// Body: raw file bytes (any content-type). Writes atomically via tmp+rename.
app.put('/api/write-file-stream', (req, res) => {
  const filePath = req.query.path;
  const cwd      = req.query.cwd;
  if (!filePath) return res.status(400).json({ error: 'path query param required' });
  try {
    const abs = resolvePath(filePath, cwd);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    const tmp = abs + '.~tmp' + process.pid;
    const out = fs.createWriteStream(tmp);
    req.pipe(out);
    out.on('finish', () => {
      try {
        fs.renameSync(tmp, abs);
        res.json({ ok: true, path: abs, bytes: fs.statSync(abs).size });
      } catch (e) {
        try { fs.unlinkSync(tmp); } catch (_) {}
        res.status(500).json({ error: e.message });
      }
    });
    out.on('error', e => { try { fs.unlinkSync(tmp); } catch (_) {} res.status(500).json({ error: e.message }); });
    req.on('error', e => { try { fs.unlinkSync(tmp); } catch (_) {} res.status(500).json({ error: e.message }); });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── Append to file ────────────────────────────────────────────────────────
// POST { path, content, encoding?, cwd? } → { ok, path, bytes }
app.post('/api/append-file', (req, res) => {
  const { path: filePath, content, encoding, cwd } = req.body;
  if (!filePath) return res.status(400).json({ error: 'path required' });
  if (content === undefined) return res.status(400).json({ error: 'content required' });
  try {
    const abs = resolvePath(filePath, cwd);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.appendFileSync(abs, content, encoding || 'utf8');
    const bytes = fs.statSync(abs).size;
    res.json({ ok: true, path: abs, bytes });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── Replace string in file ────────────────────────────────────────────────
// POST { path, old_string, new_string, cwd? } → { ok, path, bytes }
app.post('/api/replace-string', (req, res) => {
  const { path: filePath, old_string, new_string, cwd } = req.body;
  if (!filePath)        return res.status(400).json({ error: 'path required' });
  if (old_string == null) return res.status(400).json({ error: 'old_string required' });
  try {
    const abs      = resolvePath(filePath, cwd);
    if (!fs.existsSync(abs)) {
      return res.status(404).json({ error: 'File not found: ' + abs, path: abs });
    }
    const original = fs.readFileSync(abs, 'utf8');
    if (!original.includes(old_string)) {
      return res.status(422).json({ error: 'old_string not found in file', path: abs });
    }
    // Checkpoint before modifying (AutoRecovery)
    checkpointFile(abs);
    // Replace only the FIRST occurrence (like VS Code)
    const idx     = original.indexOf(old_string);
    const updated = original.slice(0, idx) + (new_string ?? '') + original.slice(idx + old_string.length);
    // Atomic write
    const tmp = abs + '.~tmp' + process.pid;
    try {
      fs.writeFileSync(tmp, updated, 'utf8');
      fs.renameSync(tmp, abs);
    } catch (e) {
      try { fs.unlinkSync(tmp); } catch (_) {}
      throw e;
    }
    res.json({ ok: true, path: abs, bytes: Buffer.byteLength(updated) });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── Apply patch (VS Code apply_patch format) ──────────────────────────────
// POST { patch, cwd? } → { ok, results: [{path, op, bytes?}] }
//
// Format:
//   *** Begin Patch
//   *** Add File: /path       → create new file (lines prefixed with +)
//   *** Update File: /path    → patch existing file
//   *** Move to: /newpath     → optional rename (follows Update File header)
//   @@ [optional context]    → hunk start
//    context line             → space prefix = unchanged context
//   -old line                 → dash prefix = remove
//   +new line                 → plus prefix = add
//   *** Delete File: /path    → remove file
//   *** End Patch
app.post('/api/apply-patch', (req, res) => {
  const { patch, cwd } = req.body;
  if (!patch) return res.status(400).json({ error: 'patch required' });
  try {
    const results = _applyPatch(patch, cwd);
    res.json({ ok: true, results });
  } catch (e) {
    res.status(422).json({ error: e.message });
  }
});

function _isFileOp(line) {
  return /^\*\*\* (Add File|Delete File|Update File|End Patch)/.test(line.trim());
}

function _applyHunk(fileContent, hunkLines) {
  const searchLines  = [];
  const replaceLines = [];

  for (const line of hunkLines) {
    if (line === '*** End of File') continue;
    if (line.length === 0) continue;
    const prefix = line[0];
    const text   = line.slice(1);
    if (prefix === ' ')      { searchLines.push(text);  replaceLines.push(text); }
    else if (prefix === '-') { searchLines.push(text); }
    else if (prefix === '+') { replaceLines.push(text); }
  }

  if (searchLines.length === 0 && replaceLines.length === 0) return fileContent;

  const searchStr  = searchLines.join('\n');
  const replaceStr = replaceLines.join('\n');

  if (fileContent.includes(searchStr)) {
    const idx = fileContent.indexOf(searchStr);
    return fileContent.slice(0, idx) + replaceStr + fileContent.slice(idx + searchStr.length);
  }
  // Try CRLF variant
  const searchCRLF = searchLines.join('\r\n');
  if (fileContent.includes(searchCRLF)) {
    const idx = fileContent.indexOf(searchCRLF);
    return fileContent.slice(0, idx) + replaceStr + fileContent.slice(idx + searchCRLF.length);
  }
  throw new Error('Hunk context not found in file:\n' + JSON.stringify(searchStr.slice(0, 200)));
}

function _applyPatch(patchText, cwd) {
  const lines   = patchText.split('\n');
  const results = [];
  let i = 0;

  while (i < lines.length && !lines[i].trim().startsWith('*** Begin Patch')) i++;
  if (i >= lines.length) throw new Error('"*** Begin Patch" not found');
  i++;

  while (i < lines.length) {
    const line = lines[i].trim();
    if (line.startsWith('*** End Patch')) break;

    if (line.startsWith('*** Add File: ')) {
      const filePath = resolvePath(line.slice('*** Add File: '.length).trim(), cwd);
      i++;
      const contentLines = [];
      while (i < lines.length && !_isFileOp(lines[i])) {
        const l = lines[i];
        if (l.startsWith('+'))      contentLines.push(l.slice(1));
        else if (l.startsWith(' ')) contentLines.push(l.slice(1));
        i++;
      }
      const body = contentLines.join('\n');
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      fs.writeFileSync(filePath, body, 'utf8');
      results.push({ path: filePath, op: 'add', bytes: Buffer.byteLength(body) });

    } else if (line.startsWith('*** Delete File: ')) {
      const filePath = resolvePath(line.slice('*** Delete File: '.length).trim(), cwd);
      checkpointFile(filePath); // preserve before deletion
      fs.unlinkSync(filePath);
      results.push({ path: filePath, op: 'delete' });
      i++;

    } else if (line.startsWith('*** Update File: ')) {
      const origPath = resolvePath(line.slice('*** Update File: '.length).trim(), cwd);
      i++;
      let newPath = null;
      if (i < lines.length && lines[i].trim().startsWith('*** Move to: ')) {
        newPath = resolvePath(lines[i].trim().slice('*** Move to: '.length).trim(), cwd);
        i++;
      }

      checkpointFile(origPath); // AutoRecovery before patch
      let fileContent = fs.readFileSync(origPath, 'utf8');

      while (i < lines.length && !_isFileOp(lines[i])) {
        if (lines[i].trim().startsWith('@@')) {
          i++;
          const hunkLines = [];
          while (i < lines.length && !lines[i].trim().startsWith('@@') && !_isFileOp(lines[i])) {
            hunkLines.push(lines[i]);
            i++;
          }
          fileContent = _applyHunk(fileContent, hunkLines);
        } else {
          i++;
        }
      }

      const dest = newPath || origPath;
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.writeFileSync(dest, fileContent, 'utf8');
      if (newPath) { try { fs.unlinkSync(origPath); } catch (_) {} }
      results.push({ path: dest, op: newPath ? 'move' : 'update', bytes: Buffer.byteLength(fileContent) });

    } else {
      i++;
    }
  }
  return results;
}

// ── AutoRecovery endpoints ───────────────────────────────────────────────
// GET  /api/checkpoints?path=...        → list checkpoints for a file
// POST /api/restore-checkpoint { checkpoint, target?, cwd? }  → restore one
// DELETE /api/checkpoints?path=...      → clear all checkpoints for a file

app.get('/api/checkpoints', (req, res) => {
  const filePath = req.query.path;
  const cwd      = req.query.cwd;
  if (!filePath) return res.status(400).json({ error: 'path required' });
  try {
    const abs       = resolvePath(filePath, cwd);
    const rel       = abs.replace(/^[/\\]/, '').replace(/\\/g, '/');
    const mirrorDir = path.join(RECOVERY_DIR, rel);
    if (!fs.existsSync(mirrorDir)) return res.json({ checkpoints: [], target: abs });
    const files = fs.readdirSync(mirrorDir)
      .filter(f => f.endsWith('.bak'))
      .sort().reverse()
      .map(f => {
        const cp = path.join(mirrorDir, f);
        let size = 0;
        try { size = fs.statSync(cp).size; } catch (_) {}
        // Convert filename back to ISO timestamp for display
        const ts = f.replace('.bak', '').replace(/^(\d{4})-(\d{2})-(\d{2})T(\d{2})-(\d{2})-(\d{2})$/, '$1-$2-$3T$4:$5:$6');
        return { name: f, path: cp, timestamp: ts, size };
      });
    res.json({ checkpoints: files, target: abs });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.delete('/api/checkpoints', (req, res) => {
  const filePath = req.query.path;
  const cwd      = req.query.cwd;
  if (!filePath) return res.status(400).json({ error: 'path required' });
  try {
    const abs       = resolvePath(filePath, cwd);
    const rel       = abs.replace(/^[/\\]/, '').replace(/\\/g, '/');
    const mirrorDir = path.join(RECOVERY_DIR, rel);
    let deleted = 0;
    if (fs.existsSync(mirrorDir)) {
      for (const f of fs.readdirSync(mirrorDir).filter(f => f.endsWith('.bak'))) {
        try { fs.unlinkSync(path.join(mirrorDir, f)); deleted++; } catch (_) {}
      }
    }
    res.json({ ok: true, deleted, target: abs });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/restore-checkpoint', (req, res) => {
  const { checkpoint, target, cwd } = req.body;
  if (!checkpoint) return res.status(400).json({ error: 'checkpoint path required' });
  try {
    let dest;
    if (target) {
      dest = resolvePath(target, cwd);
    } else {
      // Infer original path from mirror structure
      const rel = path.relative(RECOVERY_DIR, path.dirname(checkpoint));
      dest = IS_WIN ? rel : '/' + rel.replace(/\\/g, '/');
    }
    // Checkpoint the current version before overwriting (so restore itself is undoable)
    checkpointFile(dest);
    fs.copyFileSync(checkpoint, dest);
    res.json({ ok: true, restored: checkpoint, to: dest, size: fs.statSync(dest).size });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── Read file ──────────────────────────────────────────────────────────────
// POST { path, encoding? } → { ok, path, content, bytes }
app.post('/api/read-file', (req, res) => {
  const { path: filePath, encoding } = req.body;
  if (!filePath) return res.status(400).json({ error: 'path required' });
  try {
    const abs = path.isAbsolute(filePath) ? filePath : path.join(os.homedir(), filePath);
    const content = fs.readFileSync(abs, encoding || 'utf8');
    res.json({ ok: true, path: abs, content, bytes: Buffer.byteLength(content, encoding || 'utf8') });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── Read image as base64 (for vision/screenshot) ──────────────────────────
// Resizes to max 1280px wide JPEG (75% quality) to keep payload under API limits.
app.get('/api/read-image', (req, res) => {
  const filePath = req.query.path;
  const maxWidth = parseInt(req.query.maxWidth || '1280', 10);
  if (!filePath) return res.status(400).json({ error: 'path required' });

  const tmpPath = `/tmp/copilot_vision_${Date.now()}.jpg`;
  _exec(
    `sips -s format jpeg -s formatOptions 70 --resampleWidth ${maxWidth} ${JSON.stringify(filePath)} --out ${JSON.stringify(tmpPath)}`,
    (err) => {
      const srcPath = err ? filePath : tmpPath;
      const mime = err ? 'image/png' : 'image/jpeg';
      try {
        const data = fs.readFileSync(srcPath);
        if (!err) { try { fs.unlinkSync(tmpPath); } catch (_) {} }
        res.json({ base64: data.toString('base64'), mime, size: data.length });
      } catch (e) {
        res.status(404).json({ error: e.message });
      }
    }
  );
});

// ── Agent System ──────────────────────────────────────────────────────────

const AGENTS_DIR = path.join(CONFIG_DIR, 'agents');
fs.mkdirSync(AGENTS_DIR, { recursive: true });

// Project-local agents folder (version-controlled alongside the app source)
const LOCAL_AGENTS_DIR = path.join(path.dirname(new URL(import.meta.url).pathname), 'agents');

function* iterAgentDirs() {
  for (const dir of [AGENTS_DIR, LOCAL_AGENTS_DIR]) {
    if (!fs.existsSync(dir)) continue;
    for (const name of fs.readdirSync(dir)) {
      yield { name, agentDir: path.join(dir, name), source: dir === LOCAL_AGENTS_DIR ? 'local' : 'user' };
    }
  }
}

// List all installed agents
app.get('/api/agents', (req, res) => {
  try {
    const agents = [];
    const seen = new Set();
    for (const { name, agentDir, source } of iterAgentDirs()) {
      if (seen.has(name)) continue; // user dir takes precedence over local
      const manifestPath = path.join(agentDir, 'agent.json');
      if (!fs.statSync(agentDir).isDirectory()) continue;
      if (!fs.existsSync(manifestPath)) continue;
      try {
        const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
        // Skip sub-agents (they live inside a parent's agents/ folder)
        if (manifest._parentAgent) continue;
        seen.add(name);
        manifest._dir = agentDir;
        manifest._source = source;
        // Load system prompt if referenced
        if (manifest.systemPromptFile) {
          const promptPath = path.join(agentDir, manifest.systemPromptFile);
          if (fs.existsSync(promptPath)) {
            manifest.systemPrompt = fs.readFileSync(promptPath, 'utf8');
          }
        }
        // Load meta
        const metaPath = path.join(agentDir, '.meta.json');
        if (fs.existsSync(metaPath)) {
          try { manifest._meta = JSON.parse(fs.readFileSync(metaPath, 'utf8')); } catch (_) {}
        }
        // Load learnings journal (consolidated patterns only — not full log)
        const learningsPath = path.join(agentDir, 'learnings.md');
        if (fs.existsSync(learningsPath)) {
          const raw = fs.readFileSync(learningsPath, 'utf8');
          const pEnd = raw.indexOf('\n---\n');
          manifest._learnings = pEnd !== -1 ? raw.slice(0, pEnd).trim() : '';
        }
        // Load sub-agents if manifest declares them
        if (manifest.agents && Array.isArray(manifest.agents)) {
          manifest._subAgents = [];
          // Load optional shared.md to append to every sub-agent prompt
          const sharedPromptPath = path.join(agentDir, 'shared.md');
          const sharedPrompt = fs.existsSync(sharedPromptPath)
            ? '\n\n---\n## Shared Infrastructure\n\n' + fs.readFileSync(sharedPromptPath, 'utf8')
            : '';
          for (const subRef of manifest.agents) {
            const subDir = path.join(agentDir, subRef);
            const subManifestPath = path.join(subDir, 'agent.json');
            if (fs.existsSync(subManifestPath)) {
              try {
                const sub = JSON.parse(fs.readFileSync(subManifestPath, 'utf8'));
                sub._dir = subDir;
                // Load sub-agent system prompt and append shared infrastructure
                const subPromptPath = path.join(subDir, 'system-prompt.md');
                if (fs.existsSync(subPromptPath)) {
                  sub.systemPrompt = fs.readFileSync(subPromptPath, 'utf8') + sharedPrompt;
                }
                manifest._subAgents.push(sub);
              } catch (_) {}
            }
          }
        }
        agents.push(manifest);
      } catch (_) { /* skip invalid manifests */ }
    }
    res.json({ agents });
  } catch (e) {
    res.status(500).json({ error: 'Failed to list agents' });
  }
});

// Get a single agent's manifest
app.get('/api/agents/:name', (req, res) => {
  const name = req.params.name.replace(/[^a-zA-Z0-9_-]/g, '');
  const agentDir = path.join(AGENTS_DIR, name);
  const manifestPath = path.join(agentDir, 'agent.json');
  if (!fs.existsSync(manifestPath)) return res.status(404).json({ error: 'Agent not found' });
  try {
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    if (manifest.systemPromptFile) {
      const promptPath = path.join(agentDir, manifest.systemPromptFile);
      if (fs.existsSync(promptPath)) {
        manifest.systemPrompt = fs.readFileSync(promptPath, 'utf8');
      }
    }
    // Load learnings journal (consolidated patterns only)
    const learningsPath = path.join(agentDir, 'learnings.md');
    if (fs.existsSync(learningsPath)) {
      const raw = fs.readFileSync(learningsPath, 'utf8');
      const pEnd = raw.indexOf('\n---\n');
      manifest._learnings = pEnd !== -1 ? raw.slice(0, pEnd).trim() : '';
    }
    // Load sub-agents
    if (manifest.agents && Array.isArray(manifest.agents)) {
      manifest._subAgents = [];
      // Expose shared.md content for the builder editor
      const sharedPath = path.join(agentDir, 'shared.md');
      if (fs.existsSync(sharedPath)) manifest._shared = fs.readFileSync(sharedPath, 'utf8');
      for (const subRef of manifest.agents) {
        const subDir = path.join(agentDir, subRef);
        const subManifestPath = path.join(subDir, 'agent.json');
        if (fs.existsSync(subManifestPath)) {
          try {
            const sub = JSON.parse(fs.readFileSync(subManifestPath, 'utf8'));
            const subPromptPath = path.join(subDir, 'system-prompt.md');
            if (fs.existsSync(subPromptPath)) {
              sub.systemPrompt = fs.readFileSync(subPromptPath, 'utf8');
            }
            manifest._subAgents.push(sub);
          } catch (_) {}
        }
      }
    }
    res.json(manifest);
  } catch (e) {
    res.status(500).json({ error: 'Failed to read agent' });
  }
});

// Update an agent's system prompt (writes both system-prompt.md and agent.json atomically)
app.post('/api/agents/:name/update-prompt', (req, res) => {
  const name = req.params.name.replace(/[^a-zA-Z0-9_-]/g, '');
  const agentDir = path.join(AGENTS_DIR, name);
  const manifestPath = path.join(agentDir, 'agent.json');
  if (!fs.existsSync(manifestPath)) return res.status(404).json({ error: 'Agent not found' });
  const { systemPrompt } = req.body || {};
  if (!systemPrompt || typeof systemPrompt !== 'string') {
    return res.status(400).json({ error: 'systemPrompt string required' });
  }
  try {
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    manifest.systemPrompt = systemPrompt;
    fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
    fs.writeFileSync(path.join(agentDir, 'system-prompt.md'), systemPrompt);
    res.json({ ok: true, name, bytes: systemPrompt.length });
  } catch (e) {
    res.status(500).json({ error: 'Failed to update prompt: ' + e.message });
  }
});

// Agent learnings journal — append or read learnings.md
app.get('/api/agents/:name/learnings', (req, res) => {
  const name = req.params.name.replace(/[^a-zA-Z0-9_-]/g, '');
  const agentDir = path.join(AGENTS_DIR, name);
  if (!fs.existsSync(agentDir)) return res.status(404).json({ error: 'Agent not found' });
  const lPath = path.join(agentDir, 'learnings.md');
  const content = fs.existsSync(lPath) ? fs.readFileSync(lPath, 'utf8') : '';
  res.json({ name, learnings: content });
});

app.post('/api/agents/:name/learnings', (req, res) => {
  const name = req.params.name.replace(/[^a-zA-Z0-9_-]/g, '');
  const agentDir = path.join(AGENTS_DIR, name);
  if (!fs.existsSync(agentDir)) return res.status(404).json({ error: 'Agent not found' });
  const { entry, consolidatedPatterns } = req.body || {};
  if (!entry && !consolidatedPatterns) {
    return res.status(400).json({ error: 'Provide "entry" (append) and/or "consolidatedPatterns" (replace top section)' });
  }
  try {
    const lPath = path.join(agentDir, 'learnings.md');
    let content = fs.existsSync(lPath) ? fs.readFileSync(lPath, 'utf8') : '';

    // If consolidatedPatterns provided, replace/create the top patterns section
    if (consolidatedPatterns) {
      const patternsBlock = '## Consolidated Patterns\n\n' + consolidatedPatterns.trim() + '\n\n---\n\n';
      const marker = '## Consolidated Patterns';
      const divider = '---\n\n';
      const idx = content.indexOf(marker);
      if (idx !== -1) {
        // Replace existing patterns section (up to the first ---)
        const endIdx = content.indexOf(divider, idx);
        const cutEnd = endIdx !== -1 ? endIdx + divider.length : content.indexOf('\n## Session Log', idx);
        content = patternsBlock + (cutEnd !== -1 ? content.slice(cutEnd) : '');
      } else {
        content = patternsBlock + content;
      }
    }

    // Append new entry to the session log
    if (entry) {
      const timestamp = new Date().toISOString().slice(0, 16).replace('T', ' ');
      const logEntry = '\n### ' + timestamp + '\n' + entry.trim() + '\n';
      if (!content.includes('## Session Log')) {
        content += '## Session Log\n';
      }
      content += logEntry;
    }

    fs.writeFileSync(lPath, content);
    res.json({ ok: true, name, bytes: content.length });
  } catch (e) {
    res.status(500).json({ error: 'Failed to update learnings: ' + e.message });
  }
});

// Import agent from uploaded zip
app.post('/api/agents/import', express.raw({ type: 'application/zip', limit: '10mb' }), async (req, res) => {
  const tmp = path.join(os.tmpdir(), 'agent-import-' + Date.now());
  try {
    fs.mkdirSync(tmp, { recursive: true });
    const zipPath = path.join(tmp, 'agent.zip');
    fs.writeFileSync(zipPath, req.body);
    // Extract using unzip (available on macOS and most Linux)
    execSync(`unzip -o -q "${zipPath}" -d "${tmp}/extracted"`, { timeout: 30000 });
    const extracted = path.join(tmp, 'extracted');
    // Find agent.json (may be in root or one level deep)
    let agentRoot = extracted;
    if (!fs.existsSync(path.join(extracted, 'agent.json'))) {
      const dirs = fs.readdirSync(extracted).filter(d => fs.statSync(path.join(extracted, d)).isDirectory());
      for (const d of dirs) {
        if (fs.existsSync(path.join(extracted, d, 'agent.json'))) { agentRoot = path.join(extracted, d); break; }
      }
    }
    if (!fs.existsSync(path.join(agentRoot, 'agent.json'))) {
      return res.status(400).json({ error: 'No agent.json found in archive' });
    }
    const manifest = JSON.parse(fs.readFileSync(path.join(agentRoot, 'agent.json'), 'utf8'));
    const agentName = (manifest.name || '').replace(/[^a-zA-Z0-9_-]/g, '');
    if (!agentName) return res.status(400).json({ error: 'Agent name is required in agent.json' });

    // Check uniqueness
    if (BUILTIN_AGENT_NAMES.includes(agentName.toLowerCase())) {
      return res.status(409).json({ error: 'Cannot import an agent with a built-in name: ' + agentName });
    }
    const destDir = path.join(AGENTS_DIR, agentName);
    const force = req.query.force === '1';
    if (fs.existsSync(path.join(destDir, 'agent.json')) && !force) {
      return res.status(409).json({ error: 'An agent named "' + agentName + '" already exists. Delete it first or rename the import.' });
    }
    // Preserve .meta.json across forced re-imports
    let savedMeta = null;
    if (force && fs.existsSync(path.join(destDir, '.meta.json'))) {
      try { savedMeta = fs.readFileSync(path.join(destDir, '.meta.json')); } catch (_) {}
    }
    if (force && fs.existsSync(destDir)) {
      fs.rmSync(destDir, { recursive: true, force: true });
    }
    fs.mkdirSync(destDir, { recursive: true });
    const copyRecursive = (src, dst) => {
      for (const item of fs.readdirSync(src)) {
        const s = path.join(src, item);
        const d = path.join(dst, item);
        if (fs.statSync(s).isDirectory()) { fs.mkdirSync(d, { recursive: true }); copyRecursive(s, d); }
        else fs.copyFileSync(s, d);
      }
    };
    copyRecursive(agentRoot, destDir);
    // Restore preserved .meta.json
    if (savedMeta) {
      try { fs.writeFileSync(path.join(destDir, '.meta.json'), savedMeta); } catch (_) {}
    }
    res.json({ ok: true, name: agentName, displayName: manifest.displayName || agentName });
  } catch (e) {
    res.status(500).json({ error: 'Failed to import agent' });
  } finally {
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (_) {}
  }
});

// Delete an installed agent
app.delete('/api/agents/:name', (req, res) => {
  const name = req.params.name.replace(/[^a-zA-Z0-9_-]/g, '');
  const agentDir = path.join(AGENTS_DIR, name);
  if (!fs.existsSync(agentDir)) return res.status(404).json({ error: 'Agent not found' });
  try {
    fs.rmSync(agentDir, { recursive: true, force: true });
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: 'Failed to delete agent' });
  }
});

// ── Agent Meta (checksum, sandbox mode, install info) ─────────────────────

// ── Agent Custom Icon ─────────────────────────────────────────────────────

app.post('/api/agents/:name/icon', express.raw({ type: ['image/png', 'image/jpeg', 'image/gif', 'image/webp'], limit: '2mb' }), (req, res) => {
  const name = req.params.name.replace(/[^a-zA-Z0-9_-]/g, '');
  const agentDir = path.join(AGENTS_DIR, name);
  if (!fs.existsSync(agentDir)) return res.status(404).json({ error: 'Agent not found' });
  try {
    fs.writeFileSync(path.join(agentDir, 'icon.png'), req.body);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: 'Failed to save icon' });
  }
});

app.get('/api/agents/:name/icon', (req, res) => {
  const name = req.params.name.replace(/[^a-zA-Z0-9_-]/g, '');
  const iconPath = path.join(AGENTS_DIR, name, 'icon.png');
  if (!fs.existsSync(iconPath)) return res.status(404).send('No custom icon');
  res.set('Content-Type', 'image/png');
  res.set('Cache-Control', 'public, max-age=3600');
  res.send(fs.readFileSync(iconPath));
});

app.get('/api/agents/:name/meta', (req, res) => {
  const name = req.params.name.replace(/[^a-zA-Z0-9_-]/g, '');
  const metaPath = path.join(AGENTS_DIR, name, '.meta.json');
  if (!fs.existsSync(metaPath)) return res.json({});
  try {
    res.json(JSON.parse(fs.readFileSync(metaPath, 'utf8')));
  } catch (_) { res.json({}); }
});

app.post('/api/agents/:name/meta', (req, res) => {
  const name = req.params.name.replace(/[^a-zA-Z0-9_-]/g, '');
  const agentDir = path.join(AGENTS_DIR, name);
  if (!fs.existsSync(agentDir)) return res.status(404).json({ error: 'Agent not found' });
  const metaPath = path.join(agentDir, '.meta.json');
  try {
    let existing = {};
    if (fs.existsSync(metaPath)) {
      existing = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
    }
    const updated = Object.assign(existing, req.body);
    fs.writeFileSync(metaPath, JSON.stringify(updated, null, 2));
    res.json(updated);
  } catch (e) {
    res.status(500).json({ error: 'Failed to save meta' });
  }
});

// ── Agent Test Cases ──────────────────────────────────────────────────────

app.get('/api/agents/:name/tests', (req, res) => {
  const name = req.params.name.replace(/[^a-zA-Z0-9_-]/g, '');
  const testsPath = path.join(AGENTS_DIR, name, 'tests', 'test-cases.json');
  if (!fs.existsSync(testsPath)) return res.json({ testCases: [] });
  try {
    const cases = JSON.parse(fs.readFileSync(testsPath, 'utf8'));
    res.json({ testCases: Array.isArray(cases) ? cases : [] });
  } catch (_) { res.json({ testCases: [] }); }
});

// Generate a conversation summary for agent context handoff
app.post('/api/chat-summary', async (req, res) => {
  const { messages } = req.body;
  if (!messages) return res.status(400).json({ error: 'messages required' });
  try {
    const client = getCopilotClient();
    const response = await client.chat.completions.create({
      model: 'claude-sonnet-4.6',
      max_tokens: 500,
      messages: [
        { role: 'system', content: 'Summarise the following conversation in 3-5 concise sentences, capturing the key topics, decisions, and any pending questions. Be factual and brief.' },
        { role: 'user', content: typeof messages === 'string' ? messages : JSON.stringify(messages) }
      ]
    });
    const summary = response.choices?.[0]?.message?.content || '';
    res.json({ summary });
  } catch (e) {
    res.json({ summary: '' });
  }
});

// ── Multi-agent composition planner ────────────────────────────────────────
// Given a task and a list of agents, determine which agent handles which sub-task.
app.post('/api/composition/plan', async (req, res) => {
  const { task, agents, conversationContext } = req.body;
  if (!task || !agents || !agents.length) return res.status(400).json({ error: 'task and agents required' });

  const agentDescriptions = agents.map(a =>
    `- **${a.displayName}** (\`${a.name}\`): ${a.description || 'No description'}` +
    (a.systemPrompt ? `\n  Capabilities: ${a.systemPrompt.substring(0, 300)}` : '')
  ).join('\n');

  try {
    const client = getCopilotClient();
    const response = await client.chat.completions.create({
      model: 'claude-sonnet-4.6',
      max_tokens: 1500,
      messages: [
        { role: 'system', content: `You are a task planner for a multi-agent system. Given a user task and a list of available agents with their capabilities, create an execution plan that assigns specific sub-tasks to each agent based on their strengths.

Rules:
- Every agent in the list MUST be assigned a sub-task (they were all explicitly selected by the user)
- Sub-tasks should be complementary, not overlapping
- Each agent should focus on what they're best at
- If agents have sequential dependencies (e.g. design first, then documentation), specify the order
- Be specific about what each agent should do

Respond in this exact JSON format:
{
  "plan": [
    { "agent": "agent-name", "task": "specific instructions for this agent", "order": 1 },
    { "agent": "agent-name", "task": "specific instructions for this agent", "order": 2 }
  ],
  "reasoning": "brief explanation of why tasks were divided this way",
  "mode": "sequential"
}

The "order" field determines execution sequence. Agents with the same order number run in parallel.
The "mode" should be "sequential" when later agents depend on earlier agents' output, or "parallel" when they can work independently.` },
        { role: 'user', content: `## Task\n${task}\n\n## Available Agents\n${agentDescriptions}${conversationContext ? '\n\n## Conversation Context\n' + conversationContext : ''}` }
      ]
    });

    const raw = response.choices?.[0]?.message?.content || '{}';
    // Extract JSON from potential markdown code blocks
    const jsonMatch = raw.match(/```(?:json)?\s*([\s\S]*?)```/) || [null, raw];
    const plan = JSON.parse(jsonMatch[1].trim());
    res.json(plan);
  } catch (e) {
    // Fallback: simple sequential split
    const fallbackPlan = {
      plan: agents.map((a, i) => ({ agent: a.name, task: task, order: i + 1 })),
      reasoning: 'Fallback: running agents sequentially on the full task',
      mode: 'sequential'
    };
    res.json(fallbackPlan);
  }
});

// Execute a single agent tool (for testing / manual invocation)
app.post('/api/agents/:name/tool/:tool', async (req, res) => {
  const agentName = req.params.name.replace(/[^a-zA-Z0-9_-]/g, '');
  const toolName = req.params.tool;
  const args = req.body.args || {};

  const agentDir = path.join(AGENTS_DIR, agentName);
  const manifestPath = path.join(agentDir, 'agent.json');
  if (!fs.existsSync(manifestPath)) return res.status(404).json({ error: 'Agent not found' });

  try {
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    const { handlers } = getAgentTools(agentDir, manifest, agentName);

    if (!handlers.has(toolName)) {
      return res.status(404).json({ error: 'Tool "' + toolName + '" not found for agent "' + agentName + '"' });
    }

    const result = await handlers.get(toolName)(args);
    res.json({ ok: true, result });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// List tools available for an agent
app.get('/api/agents/:name/tools', (req, res) => {
  const agentName = req.params.name.replace(/[^a-zA-Z0-9_-]/g, '');
  const agentDir = path.join(AGENTS_DIR, agentName);
  const manifestPath = path.join(agentDir, 'agent.json');
  if (!fs.existsSync(manifestPath)) return res.status(404).json({ error: 'Agent not found' });

  try {
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    const { definitions } = getAgentTools(agentDir, manifest, agentName);
    res.json({ tools: definitions.map(d => ({ name: d.function.name, description: d.function.description, parameters: d.function.parameters })) });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Start/stop MCP servers for an agent
app.post('/api/agents/:name/mcp/start', async (req, res) => {
  const agentName = req.params.name.replace(/[^a-zA-Z0-9_-]/g, '');
  const manifestPath = path.join(AGENTS_DIR, agentName, 'agent.json');
  if (!fs.existsSync(manifestPath)) return res.status(404).json({ error: 'Agent not found' });

  try {
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    const result = await startAgentMCPServers(manifest, agentName);
    res.json({ ok: true, servers: result });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/agents/:name/mcp/stop', (req, res) => {
  const agentName = req.params.name.replace(/[^a-zA-Z0-9_-]/g, '');
  stopAgentMCPServers(agentName);
  res.json({ ok: true });
});

// Run vulnerability scan on an installed agent
app.post('/api/agents/:name/scan', (req, res) => {
  const agentName = req.params.name.replace(/[^a-zA-Z0-9_-]/g, '');
  const agentDir = path.join(AGENTS_DIR, agentName);
  if (!fs.existsSync(path.join(agentDir, 'agent.json'))) {
    return res.status(404).json({ error: 'Agent not found' });
  }
  try {
    const report = scanAgent(agentDir);
    // Cache the report
    const reportPath = path.join(agentDir, '.scan-report.json');
    fs.writeFileSync(reportPath, JSON.stringify(report, null, 2), 'utf8');
    res.json(report);
  } catch (e) {
    res.status(500).json({ error: 'Scan failed: ' + e.message });
  }
});

// Get cached scan report
app.get('/api/agents/:name/scan-report', (req, res) => {
  const agentName = req.params.name.replace(/[^a-zA-Z0-9_-]/g, '');
  const reportPath = path.join(AGENTS_DIR, agentName, '.scan-report.json');
  if (!fs.existsSync(reportPath)) {
    return res.status(404).json({ error: 'No scan report found. Run POST /api/agents/:name/scan first.' });
  }
  try {
    const report = JSON.parse(fs.readFileSync(reportPath, 'utf8'));
    res.json(report);
  } catch (e) {
    res.status(500).json({ error: 'Failed to read scan report' });
  }
});

// Get formatted scan report as markdown
app.get('/api/agents/:name/scan-report/markdown', (req, res) => {
  const agentName = req.params.name.replace(/[^a-zA-Z0-9_-]/g, '');
  const reportPath = path.join(AGENTS_DIR, agentName, '.scan-report.json');
  if (!fs.existsSync(reportPath)) {
    return res.status(404).json({ error: 'No scan report found' });
  }
  try {
    const report = JSON.parse(fs.readFileSync(reportPath, 'utf8'));
    const markdown = formatScanReport(report);
    res.type('text/markdown').send(markdown);
  } catch (e) {
    res.status(500).json({ error: 'Failed to format scan report' });
  }
});

// Scan a zip archive before import (pre-publish check)
app.post('/api/agents/scan-zip', express.raw({ type: 'application/zip', limit: '10mb' }), (req, res) => {
  const tmp = path.join(os.tmpdir(), 'agent-scan-' + Date.now());
  try {
    fs.mkdirSync(tmp, { recursive: true });
    const zipPath = path.join(tmp, 'agent.zip');
    fs.writeFileSync(zipPath, req.body);
    execSync(`unzip -o -q "${zipPath}" -d "${tmp}/extracted"`, { timeout: 30000 });
    const extracted = path.join(tmp, 'extracted');
    // Find agent root
    let agentRoot = extracted;
    if (!fs.existsSync(path.join(extracted, 'agent.json'))) {
      const dirs = fs.readdirSync(extracted).filter(d => fs.statSync(path.join(extracted, d)).isDirectory());
      for (const d of dirs) {
        if (fs.existsSync(path.join(extracted, d, 'agent.json'))) { agentRoot = path.join(extracted, d); break; }
      }
    }
    if (!fs.existsSync(path.join(agentRoot, 'agent.json'))) {
      return res.status(400).json({ error: 'No agent.json found in archive' });
    }
    const report = scanAgent(agentRoot);
    res.json(report);
  } catch (e) {
    res.status(500).json({ error: 'Scan failed: ' + e.message });
  } finally {
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (_) {}
  }
});

// ── Agent Builder Endpoints ──────────────────────────────────────────────

// AI-generate agent config from a natural language description
app.post('/api/agent-builder/generate', async (req, res) => {
  const { description, model: reqModel } = req.body;
  if (!description || !description.trim()) return res.status(400).json({ error: 'description required' });
  // Use the model the client is currently using, fall back to gpt-4.1 which is reliably available
  const model = reqModel || 'gpt-4.1';
  try {
    const client = getCopilotClient();
    const response = await client.chat.completions.create({
      model: model,
      max_tokens: 4000,
      messages: [
        { role: 'system', content: `You are an AI agent builder assistant. Given a user's description of what kind of agent they want, generate a complete agent configuration as a JSON object. Return ONLY valid JSON with no markdown fencing or extra text.

The JSON must have these fields:
- "displayName": string (human-friendly name, 2-4 words)
- "name": string (lowercase slug with hyphens, e.g. "code-reviewer")
- "description": string (1-2 sentence description)
- "category": one of "productivity","development","design","research","writing","data","other"
- "icon": one of "ti-robot","ti-code","ti-search","ti-pencil","ti-vector-triangle","ti-database","ti-chart-bar","ti-terminal-2","ti-world-www","ti-shield-check","ti-brain","ti-bolt","ti-bug","ti-git-merge","ti-palette","ti-mail","ti-file-analytics","ti-api","ti-cpu","ti-cloud","ti-package","ti-wand"
- "orchestrator": boolean — set true if the agent's purpose involves coordinating multiple specialized sub-agents (e.g. "generate a report using 3 agents", "multi-step pipeline", "spec writer with sections"). Set false for single-purpose agents.
- "systemPrompt": string (detailed system prompt). For orchestrators: 100-200 words, dispatch-only — must say "output ONLY [DELEGATE:agents/sub-agent-name] blocks", describe inputs to resolve, and list the sub-agents in a dispatch table. For regular agents: 200-800 words defining role, capabilities, workflow, output format.
- "shared": string — only for orchestrators (empty string otherwise). Shared infrastructure prompt appended to every sub-agent automatically. Put common facts, APIs, component keys, helpers, or conventions here so sub-agents don't repeat them.
- "subAgents": array — only for orchestrators (empty array otherwise). Each sub-agent has:
  - "name": string (lowercase slug, e.g. "section-overview")
  - "displayName": string (human-friendly, e.g. "Overview Section")
  - "description": string (one sentence)
  - "icon": string (ti-* icon from the list above)
  - "systemPrompt": string (focused prompt for this sub-agent's specific responsibility, 100-300 words. It receives shared context automatically — don't repeat shared infrastructure here.)
- "permissions": object with:
  - "shell": boolean
  - "browser": boolean
  - "figma": boolean
  - "fileRead": array of FOLDER paths the agent may read from (e.g. ["~/Documents"]). All files inside the folder are accessible. Use [] for no read access.
  - "fileWrite": array of FOLDER paths the agent may write to (e.g. ["~/Output"]). All files inside the folder can be created or overwritten. Use [] for no write access.
  - "network": { "allowedDomains": string[], "blockAll": boolean }
- "tools": array of custom tool objects (0-3 relevant tools; omit for orchestrators). Each tool has:
  - "name": string (snake_case)
  - "description": string
  - "parameters": JSON Schema object ({ "type": "object", "properties": { ... } })
  - "code": string (JavaScript module.exports async function. Receives (args, context). context has: context.fetch(url), context.readFile(path), context.writeFile(path, content), context.store)
- "testCases": array of 2-4 test cases. Each has:
  - "input": string (a user message to test)
  - "expectedOutput": string (a substring that should appear in the response)

ORCHESTRATOR EXAMPLE — if the user asks for a "report writer with a research agent and a writing agent":
{
  "orchestrator": true,
  "systemPrompt": "You coordinate report generation. Resolve the topic, then output ONLY [DELEGATE:] blocks.\\n\\n## Dispatch\\n[DELEGATE:agents/researcher] → gather facts\\n[DELEGATE:agents/writer] → write the report",
  "shared": "Output reports in Markdown. Use headers ##, bullet points, and concise language.",
  "subAgents": [
    { "name": "researcher", "displayName": "Researcher", "icon": "ti-search", "description": "Finds and summarizes facts on a topic.", "systemPrompt": "You research a given topic and return structured findings: key facts, sources, and a short summary." },
    { "name": "writer", "displayName": "Writer", "icon": "ti-pencil", "description": "Writes the final report from research.", "systemPrompt": "You receive research findings and write a polished report. Prior agent results are in your context." }
  ],
  "tools": [],
  "subAgents": [...]
}

Set permissions conservatively — only enable what the agent truly needs.` },
        { role: 'user', content: description.trim() }
      ]
    });
    const text = response.choices?.[0]?.message?.content || '';
    // Extract JSON from response (strip markdown fences if present)
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) return res.status(500).json({ error: 'Failed to generate valid agent config' });
    const config = JSON.parse(jsonMatch[0]);
    res.json(config);
  } catch (e) {
    res.status(500).json({ error: 'Generation failed: ' + e.message });
  }
});

// Test a system prompt by sending a test message through the model
app.post('/api/agent-builder/test-prompt', async (req, res) => {
  const { systemPrompt, testMessage } = req.body;
  if (!systemPrompt || !testMessage) return res.status(400).json({ error: 'systemPrompt and testMessage required' });
  try {
    const client = getCopilotClient();
    const response = await client.chat.completions.create({
      model: 'claude-sonnet-4.6',
      max_tokens: 500,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: testMessage }
      ]
    });
    const text = response.choices?.[0]?.message?.content || '';
    res.json({ response: text });
  } catch (e) {
    res.status(500).json({ error: 'Test failed: ' + e.message });
  }
});

// Test a custom tool in sandbox
app.post('/api/agent-builder/test-tool', async (req, res) => {
  const { tool, args } = req.body;
  if (!tool || !tool.code) return res.status(400).json({ error: 'tool with code required' });
  try {
    const vm = await import('vm');
    const sandbox = {
      module: { exports: null },
      exports: {},
      console: { log: () => {}, error: () => {}, warn: () => {} },
      setTimeout: () => {},
      clearTimeout: () => {},
    };
    const ctx = vm.default ? vm.default.createContext(sandbox) : vm.createContext(sandbox);
    const script = new (vm.default ? vm.default.Script : vm.Script)(tool.code, { timeout: 5000 });
    script.runInContext(ctx);
    const fn = sandbox.module.exports || sandbox.exports.default;
    if (typeof fn !== 'function') return res.status(400).json({ error: 'Tool code must export a function via module.exports' });

    // Create a minimal tool context
    const toolContext = {
      fetch: () => Promise.resolve({ ok: true, json: () => ({ mock: true }), text: () => 'mock response' }),
      readFile: () => Promise.resolve('(sandbox: file read disabled in test mode)'),
      writeFile: () => Promise.resolve(),
      store: {}
    };
    const result = await Promise.resolve(fn(args || {}, toolContext));
    res.json({ result });
  } catch (e) {
    res.status(500).json({ error: 'Tool test failed: ' + e.message });
  }
});

// Scan agent data from builder (not yet saved to disk)
app.post('/api/agent-builder/scan', (req, res) => {
  const data = req.body;
  if (!data || !data.name) return res.status(400).json({ error: 'Agent data required' });

  // Write to a temp directory, scan, then clean up
  const tmp = path.join(os.tmpdir(), 'agent-builder-scan-' + Date.now());
  try {
    fs.mkdirSync(tmp, { recursive: true });

    // Write agent.json
    const manifest = {
      name: data.name,
      displayName: data.displayName || data.name,
      description: data.description || '',
      version: '1.0',
      category: data.category || 'other',
      icon: data.icon || 'ti-robot',
      permissions: data.permissions || {}
    };
    fs.writeFileSync(path.join(tmp, 'agent.json'), JSON.stringify(manifest, null, 2));

    // Write system prompt
    if (data.systemPrompt) {
      fs.writeFileSync(path.join(tmp, 'system-prompt.md'), data.systemPrompt);
    }

    // Write tools
    if (data.tools && data.tools.length) {
      const toolsDir = path.join(tmp, 'tools');
      fs.mkdirSync(toolsDir, { recursive: true });
      for (const tool of data.tools) {
        const toolFile = path.join(toolsDir, (tool.name || 'tool') + '.js');
        fs.writeFileSync(toolFile, tool.code || '');
      }
    }

    // Write test cases for scan
    if (data.testCases && data.testCases.length) {
      const testsDir = path.join(tmp, 'tests');
      fs.mkdirSync(testsDir, { recursive: true });
      fs.writeFileSync(path.join(testsDir, 'test-cases.json'), JSON.stringify(data.testCases, null, 2));
    }

    // Write auto-generated README
    const readmeContent = '# ' + (data.displayName || data.name) + '\n\n' +
      (data.description || '') + '\n\n' +
      '## Permissions\n\n' +
      (data.permissions ? Object.entries(data.permissions).filter(([k,v]) => v && k !== 'network' && k !== 'fileRead' && k !== 'fileWrite').map(([k]) => '- ' + k).join('\n') : 'None') + '\n';
    fs.writeFileSync(path.join(tmp, 'README.md'), readmeContent);

    const report = scanAgent(tmp);
    res.json(report);
  } catch (e) {
    res.status(500).json({ error: 'Scan failed: ' + e.message });
  } finally {
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (_) {}
  }
});

// Save agent from builder
const BUILTIN_AGENT_NAMES = ['research', 'coder', 'writer', 'designer'];

app.post('/api/agent-builder/save', (req, res) => {
  const data = req.body;
  if (!data || !data.name) return res.status(400).json({ error: 'Agent name required' });
  const agentName = data.name.replace(/[^a-zA-Z0-9_-]/g, '');
  if (!agentName) return res.status(400).json({ error: 'Invalid agent name' });

  // Check uniqueness: reject built-in names, reject duplicate on new agents
  if (BUILTIN_AGENT_NAMES.includes(agentName.toLowerCase())) {
    return res.status(409).json({ error: 'Cannot use a built-in agent name: ' + agentName });
  }
  const isNew = !data._editing;
  const agentDir = path.join(AGENTS_DIR, agentName);
  if (isNew && fs.existsSync(path.join(agentDir, 'agent.json'))) {
    return res.status(409).json({ error: 'An agent named "' + agentName + '" already exists. Edit it instead or choose a different name.' });
  }
  try {
    fs.mkdirSync(agentDir, { recursive: true });

    // Auto-increment version on re-save (simple: 1.0 → 2.0 → 3.0)
    let version = '1.0';
    const existingManifestPath = path.join(agentDir, 'agent.json');
    if (!isNew && fs.existsSync(existingManifestPath)) {
      try {
        const existing = JSON.parse(fs.readFileSync(existingManifestPath, 'utf8'));
        if (existing.version) {
          const major = parseInt(existing.version) || 1;
          version = (major + 1) + '.0';
        }
      } catch (_) {}
    }

    // Write agent.json
    const manifest = {
      name: agentName,
      displayName: data.displayName || agentName,
      description: data.description || '',
      version: version,
      category: data.category || 'other',
      icon: data.icon || 'ti-robot',
      orchestrator: data.orchestrator || false,
      permissions: data.permissions || {},
      systemPrompt: data.systemPrompt || ''
    };
    // Include sub-agent references in manifest
    if (data.agents && Array.isArray(data.agents) && data.agents.length) {
      manifest.agents = data.agents; // e.g. ['agents/overview', 'agents/usage']
    }
    // Compute checksum of the manifest for version tracking
    const manifestJson = JSON.stringify(manifest, null, 2);
    const checksum = crypto.createHash('sha256').update(manifestJson).digest('hex').slice(0, 16);
    fs.writeFileSync(path.join(agentDir, 'agent.json'), manifestJson);

    // Write system prompt
    if (data.systemPrompt) {
      fs.writeFileSync(path.join(agentDir, 'system-prompt.md'), data.systemPrompt);
    }

    // Write shared sub-agent infrastructure
    if (data.shared && data.shared.trim()) {
      fs.writeFileSync(path.join(agentDir, 'shared.md'), data.shared);
    } else if (fs.existsSync(path.join(agentDir, 'shared.md')) && data.shared === '') {
      fs.unlinkSync(path.join(agentDir, 'shared.md'));
    }

    // Write sub-agents
    if (data.subAgents && Array.isArray(data.subAgents)) {
      const subAgentsDir = path.join(agentDir, 'agents');
      fs.mkdirSync(subAgentsDir, { recursive: true });
      for (const sub of data.subAgents) {
        const subName = (sub.name || '').replace(/[^a-zA-Z0-9_-]/g, '');
        if (!subName) continue;
        const subDir = path.join(subAgentsDir, subName);
        fs.mkdirSync(subDir, { recursive: true });
        const subManifest = {
          name: subName,
          displayName: sub.displayName || subName,
          description: sub.description || '',
          icon: sub.icon || 'ti-robot',
          category: sub.category || manifest.category,
          permissions: sub.permissions || {},
          systemPrompt: sub.systemPrompt || '',
          _parentAgent: agentName
        };
        fs.writeFileSync(path.join(subDir, 'agent.json'), JSON.stringify(subManifest, null, 2));
        if (sub.systemPrompt) {
          fs.writeFileSync(path.join(subDir, 'system-prompt.md'), sub.systemPrompt);
        }
        // Sub-agent tools
        if (sub.tools && sub.tools.length) {
          const subToolsDir = path.join(subDir, 'tools');
          fs.mkdirSync(subToolsDir, { recursive: true });
          for (const tool of sub.tools) {
            const safeTool = (tool.name || 'tool').replace(/[^a-zA-Z0-9_-]/g, '');
            fs.writeFileSync(path.join(subToolsDir, safeTool + '.json'), JSON.stringify({ name: tool.name, description: tool.description || '', parameters: tool.parameters || {} }, null, 2));
            fs.writeFileSync(path.join(subToolsDir, safeTool + '.js'), tool.code || '');
          }
        }
      }
    }

    // Write tools
    if (data.tools && data.tools.length) {
      const toolsDir = path.join(agentDir, 'tools');
      fs.mkdirSync(toolsDir, { recursive: true });
      for (const tool of data.tools) {
        const safeName = (tool.name || 'tool').replace(/[^a-zA-Z0-9_-]/g, '');
        const toolManifest = {
          name: tool.name,
          description: tool.description || '',
          parameters: tool.parameters || { type: 'object', properties: {} }
        };
        fs.writeFileSync(path.join(toolsDir, safeName + '.json'), JSON.stringify(toolManifest, null, 2));
        fs.writeFileSync(path.join(toolsDir, safeName + '.js'), tool.code || '');
      }
    }

    // Write test cases
    if (data.testCases && data.testCases.length) {
      const testsDir = path.join(agentDir, 'tests');
      fs.mkdirSync(testsDir, { recursive: true });
      fs.writeFileSync(path.join(testsDir, 'test-cases.json'), JSON.stringify(data.testCases, null, 2));
    }

    // Write auto-generated README
    const readmeLines = ['# ' + (manifest.displayName || agentName), '', manifest.description || '', ''];
    if (data.systemPrompt) readmeLines.push('## System Prompt', '', 'This agent has a custom system prompt defining its behavior.', '');
    if (data.tools && data.tools.length) readmeLines.push('## Tools', '', ...data.tools.map(t => '- **' + t.name + '**: ' + (t.description || 'No description')), '');
    fs.writeFileSync(path.join(agentDir, 'README.md'), readmeLines.join('\n'));

    res.json({ ok: true, name: agentName, displayName: manifest.displayName, version: version, checksum: checksum });
  } catch (e) {
    res.status(500).json({ error: 'Failed to save agent: ' + e.message });
  }
});

// Export agent as .zip
app.post('/api/agent-builder/export', async (req, res) => {
  const data = req.body;
  if (!data || !data.name) return res.status(400).json({ error: 'Agent name required' });
  const agentName = data.name.replace(/[^a-zA-Z0-9_-]/g, '');
  if (!agentName) return res.status(400).json({ error: 'Invalid agent name' });

  const tmp = path.join(os.tmpdir(), 'agent-export-' + Date.now());
  const agentTmp = path.join(tmp, agentName);
  try {
    fs.mkdirSync(agentTmp, { recursive: true });

    // Write manifest
    const manifest = {
      name: agentName,
      displayName: data.displayName || agentName,
      description: data.description || '',
      version: '1.0',
      category: data.category || 'other',
      icon: data.icon || 'ti-robot',
      orchestrator: data.orchestrator || false,
      permissions: data.permissions || {},
      systemPrompt: data.systemPrompt || ''
    };
    if (data.agents && Array.isArray(data.agents) && data.agents.length) {
      manifest.agents = data.agents;
    }
    fs.writeFileSync(path.join(agentTmp, 'agent.json'), JSON.stringify(manifest, null, 2));

    if (data.systemPrompt) {
      fs.writeFileSync(path.join(agentTmp, 'system-prompt.md'), data.systemPrompt);
    }

    // Bundle sub-agents from disk if they exist
    const subAgentsSrc = path.join(AGENTS_DIR, agentName, 'agents');
    if (fs.existsSync(subAgentsSrc) && fs.statSync(subAgentsSrc).isDirectory()) {
      const subAgentsTmp = path.join(agentTmp, 'agents');
      fs.mkdirSync(subAgentsTmp, { recursive: true });
      const copyRecursiveExport = (src, dst) => {
        for (const item of fs.readdirSync(src)) {
          const s = path.join(src, item);
          const d = path.join(dst, item);
          if (fs.statSync(s).isDirectory()) { fs.mkdirSync(d, { recursive: true }); copyRecursiveExport(s, d); }
          else fs.copyFileSync(s, d);
        }
      };
      copyRecursiveExport(subAgentsSrc, subAgentsTmp);
    }

    if (data.tools && data.tools.length) {
      const toolsDir = path.join(agentTmp, 'tools');
      fs.mkdirSync(toolsDir, { recursive: true });
      for (const tool of data.tools) {
        const safeName = (tool.name || 'tool').replace(/[^a-zA-Z0-9_-]/g, '');
        fs.writeFileSync(path.join(toolsDir, safeName + '.json'), JSON.stringify({ name: tool.name, description: tool.description || '', parameters: tool.parameters || {} }, null, 2));
        fs.writeFileSync(path.join(toolsDir, safeName + '.js'), tool.code || '');
      }
    }

    if (data.testCases && data.testCases.length) {
      const testsDir = path.join(agentTmp, 'tests');
      fs.mkdirSync(testsDir, { recursive: true });
      fs.writeFileSync(path.join(testsDir, 'test-cases.json'), JSON.stringify(data.testCases, null, 2));
    }

    // Create zip
    const zipPath = path.join(tmp, agentName + '.zip');
    execSync(`cd "${tmp}" && zip -r "${zipPath}" "${agentName}"`, { timeout: 30000 });

    const zipData = fs.readFileSync(zipPath);
    res.set({
      'Content-Type': 'application/zip',
      'Content-Disposition': `attachment; filename="${agentName}.zip"`
    });
    res.send(zipData);
  } catch (e) {
    res.status(500).json({ error: 'Export failed: ' + e.message });
  } finally {
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (_) {}
  }
});

// ── Agent Store Proxy Endpoints ───────────────────────────────────────────
// Proxy requests to the store backend. The backend URL is configurable.

const STORE_BACKEND_URL = process.env.AGENT_STORE_URL || 'https://agentstore.pointlabel.com/api';

async function storeProxy(req, res, method, backendPath, body) {
  const url = STORE_BACKEND_URL + backendPath;
  const headers = { 'Accept': 'application/json' };
  if (req.headers['authorization']) headers['Authorization'] = req.headers['authorization'];

  const opts = { method, headers };
  if (body instanceof Buffer || body instanceof Uint8Array) {
    // Multipart forwards
    headers['Content-Type'] = req.headers['content-type'];
    opts.body = body;
  } else if (body) {
    headers['Content-Type'] = 'application/json';
    opts.body = JSON.stringify(body);
  }

  try {
    const upstream = await fetch(url, opts);
    const ct = upstream.headers.get('content-type') || '';
    const status = upstream.status;
    if (status >= 400) {
      console.error('[storeProxy] %s %s → %d', method, backendPath, status);
    }
    if (ct.includes('json')) {
      const data = await upstream.json();
      return res.status(status).json(data);
    }
    // Binary (zip download)
    const buf = Buffer.from(await upstream.arrayBuffer());
    for (const h of ['content-type', 'content-disposition']) {
      const v = upstream.headers.get(h);
      if (v) res.set(h, v);
    }
    return res.status(status).send(buf);
  } catch (e) {
    res.status(502).json({ error: 'Store backend unavailable: ' + e.message });
  }
}

// Browse / search
app.get('/api/store/agents', (req, res) => {
  const qs = new URLSearchParams(req.query).toString();
  storeProxy(req, res, 'GET', '/agents' + (qs ? '?' + qs : ''));
});

// Proxy zip download (streams directly from backend) — must be before :slug catch-all
app.get('/api/store/agents/:slug/zip', async (req, res) => {
  const slug = req.params.slug.replace(/[^a-zA-Z0-9_-]/g, '');
  try {
    const token = req.headers.authorization || '';
    const zipRes = await fetch(STORE_BACKEND_URL + '/agents/' + slug + '/download', {
      method: 'POST',
      headers: {
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Content-Type': 'application/x-www-form-urlencoded',
        ...(token ? { 'Authorization': token } : {})
      },
      body: ''
    });
    if (!zipRes.ok) {
      const text = await zipRes.text();
      return res.status(zipRes.status).json({ error: 'Download failed: ' + text });
    }
    const buf = Buffer.from(await zipRes.arrayBuffer());
    res.set('Content-Type', 'application/zip');
    res.set('Content-Disposition', 'attachment; filename="' + slug + '.zip"');
    res.send(buf);
  } catch (e) {
    res.status(502).json({ error: 'Zip proxy failed: ' + e.message });
  }
});

// Install
app.post('/api/store/agents/:slug/install', (req, res) => {
  const slug = req.params.slug.replace(/[^a-zA-Z0-9_-]/g, '');
  storeProxy(req, res, 'POST', '/agents/' + slug + '/download');
});

// Agent detail — try local installed agent first, fall back to store proxy
app.get('/api/store/agents/:slug', async (req, res) => {
  const slug = req.params.slug.replace(/[^a-zA-Z0-9_-]/g, '');

  // Try to serve from locally-installed agent (avoids store round-trip)
  const localAgentDir = path.join(AGENTS_DIR, slug);
  const localManifest = path.join(localAgentDir, 'agent.json');
  if (fs.existsSync(localManifest)) {
    try {
      const manifest = JSON.parse(fs.readFileSync(localManifest, 'utf8'));
      let meta = {};
      try { meta = JSON.parse(fs.readFileSync(path.join(localAgentDir, '.meta.json'), 'utf8')); } catch (_) {}
      return res.json({
        slug: manifest.name || slug,
        name: manifest.name || slug,
        displayName: manifest.displayName || manifest.name || slug,
        description: manifest.description || '',
        category: manifest.category || 'general',
        icon: manifest.icon || 'ti-robot',
        version: manifest.version || meta.storeVersion || '1.0',
        scanScore: manifest.scanScore ?? 90,
        author: manifest.author || meta.installedBy || '',
        installedAt: meta.installedAt || null,
        permissions: manifest.permissions || {},
        _source: 'local',
      });
    } catch (_) {}
  }

  storeProxy(req, res, 'GET', '/agents/' + slug);
});

// Agent ownership check — skip store call if agent isn't installed from store
app.get('/api/store/agents/:slug/ownership', (req, res) => {
  const slug = req.params.slug.replace(/[^a-zA-Z0-9_-]/g, '');
  // If no store token, no point checking
  if (!req.headers.authorization) return res.json({ owned: false, isAdmin: false });
  storeProxy(req, res, 'GET', '/agents/' + slug + '/ownership');
});

// Update agent metadata (owner or admin only)
app.put('/api/store/agents/:slug', express.json(), (req, res) => {
  const slug = req.params.slug.replace(/[^a-zA-Z0-9_-]/g, '');
  storeProxy(req, res, 'PUT', '/agents/' + slug, req.body);
});

// Categories
app.get('/api/store/categories', (req, res) => {
  storeProxy(req, res, 'GET', '/categories');
});

// Publish (receive multipart, forward as base64 JSON to avoid WAF blocking)
app.post('/api/store/publish', (req, res) => {
  const chunks = [];
  req.on('data', c => chunks.push(c));
  req.on('end', async () => {
    try {
      const raw = Buffer.concat(chunks);
      const contentType = req.headers['content-type'] || '';

      // Parse multipart to extract the file and fields
      const boundary = contentType.split('boundary=')[1];
      if (!boundary) {
        return res.status(400).json({ error: 'Missing multipart boundary' });
      }

      const { fields, fileBuffer, fileName } = parseMultipart(raw, boundary);
      if (!fileBuffer) {
        return res.status(400).json({ error: 'No agent file found in upload' });
      }

      // Convert to base64 JSON payload
      const jsonBody = {
        agentData: fileBuffer.toString('base64'),
        fileName: fileName || 'agent.zip',
        scanScore: fields.scanScore ? parseInt(fields.scanScore, 10) : 0,
        changelog: fields.changelog || '',
      };

      console.log('[store-publish] forwarding %d bytes as base64 JSON, has-auth: %s',
        fileBuffer.length, !!req.headers['authorization']);
      storeProxy(req, res, 'POST', '/agents', jsonBody);
    } catch (e) {
      console.error('[store-publish] parse error:', e.message);
      res.status(500).json({ error: 'Failed to process upload: ' + e.message });
    }
  });
});

// Simple multipart parser — extracts first file and text fields
function parseMultipart(buffer, boundary) {
  const sep = Buffer.from('--' + boundary);
  const parts = [];
  let start = 0;
  while (true) {
    const idx = buffer.indexOf(sep, start);
    if (idx === -1) break;
    if (start > 0) parts.push(buffer.slice(start, idx));
    start = idx + sep.length;
    // Skip \r\n after boundary
    if (buffer[start] === 0x0d && buffer[start + 1] === 0x0a) start += 2;
  }

  const fields = {};
  let fileBuffer = null;
  let fileName = null;

  for (const part of parts) {
    const headerEnd = part.indexOf('\r\n\r\n');
    if (headerEnd === -1) continue;
    const headerStr = part.slice(0, headerEnd).toString('utf-8');
    const body = part.slice(headerEnd + 4);
    // Trim trailing \r\n
    const trimmed = (body.length >= 2 && body[body.length - 2] === 0x0d && body[body.length - 1] === 0x0a)
      ? body.slice(0, body.length - 2)
      : body;

    const nameMatch = headerStr.match(/name="([^"]+)"/);
    const fileMatch = headerStr.match(/filename="([^"]+)"/);
    if (!nameMatch) continue;

    if (fileMatch) {
      fileBuffer = trimmed;
      fileName = fileMatch[1];
    } else {
      fields[nameMatch[1]] = trimmed.toString('utf-8');
    }
  }

  return { fields, fileBuffer, fileName };
}

// Auth
app.post('/api/store/auth/login', express.json(), (req, res) => {
  storeProxy(req, res, 'POST', '/auth/login', req.body);
});
app.post('/api/store/auth/register', express.json(), (req, res) => {
  storeProxy(req, res, 'POST', '/auth/register', req.body);
});

// Developer dashboard — user's published agents
app.get('/api/store/dashboard/agents', (req, res) => {
  storeProxy(req, res, 'GET', '/dashboard/agents');
});

// ── Admin review routes (reviewer+) ──────────────────────────────────────
app.get('/api/store/admin/agents', (req, res) => {
  var qs = req.query.status ? '?status=' + encodeURIComponent(req.query.status) : '';
  storeProxy(req, res, 'GET', '/admin/agents' + qs);
});
app.get('/api/store/admin/agents/:id', (req, res) => {
  storeProxy(req, res, 'GET', '/admin/agents/' + req.params.id);
});
app.post('/api/store/admin/agents/:id/approve', express.json(), (req, res) => {
  storeProxy(req, res, 'POST', '/admin/agents/' + req.params.id + '/approve', req.body);
});
app.post('/api/store/admin/agents/:id/reject', express.json(), (req, res) => {
  storeProxy(req, res, 'POST', '/admin/agents/' + req.params.id + '/reject', req.body);
});
app.post('/api/store/admin/agents/:id/request-changes', express.json(), (req, res) => {
  storeProxy(req, res, 'POST', '/admin/agents/' + req.params.id + '/request-changes', req.body);
});
app.post('/api/store/admin/agents/:id/unpublish', express.json(), (req, res) => {
  storeProxy(req, res, 'POST', '/admin/agents/' + req.params.id + '/unpublish', req.body);
});
app.post('/api/store/admin/agents/:id/deprecate', express.json(), (req, res) => {
  storeProxy(req, res, 'POST', '/admin/agents/' + req.params.id + '/deprecate', req.body);
});
app.delete('/api/store/admin/agents/:id', express.json(), (req, res) => {
  storeProxy(req, res, 'DELETE', '/admin/agents/' + req.params.id, req.body);
});

// ── Notification routes ──────────────────────────────────────────────────
app.get('/api/store/notifications', (req, res) => {
  storeProxy(req, res, 'GET', '/notifications');
});
app.get('/api/store/notifications/unread-count', (req, res) => {
  storeProxy(req, res, 'GET', '/notifications/unread-count');
});
app.post('/api/store/notifications/:id/read', (req, res) => {
  storeProxy(req, res, 'POST', '/notifications/' + req.params.id + '/read');
});
app.post('/api/store/notifications/read-all', (req, res) => {
  storeProxy(req, res, 'POST', '/notifications/read-all');
});

// ── Agent Sandbox Endpoints ───────────────────────────────────────────────
// These endpoints proxy the standard shell-exec, write-file, and fetch-url
// through the sandbox layer, enforcing the active agent's permissions.

// Helper: look up an agent manifest by name
function getAgentManifest(name) {
  if (!name) return null;
  const agentDir = path.join(AGENTS_DIR, name.replace(/[^a-zA-Z0-9_-]/g, ''));
  const manifestPath = path.join(agentDir, 'agent.json');
  if (!fs.existsSync(manifestPath)) return null;
  try { return JSON.parse(fs.readFileSync(manifestPath, 'utf8')); } catch (_) { return null; }
}

// Sandboxed shell execution
app.post('/api/agent/shell-exec', (req, res) => {
  const { command, cwd, agentName } = req.body;
  if (!command) return res.status(400).json({ error: 'command required' });
  if (!agentName) return res.status(400).json({ error: 'agentName required' });

  // Look up permissions — check installed agents, fall back to built-in names
  const manifest = getAgentManifest(agentName);
  const permissions = manifest?.permissions || req.body.permissions || {};

  // Check shell permission
  const shellCheck = checkShellCommand(command, permissions, agentName);
  if (!shellCheck.allowed) {
    return res.status(403).json({ ok: false, error: shellCheck.reason, blocked: true });
  }

  // Run with sandboxed environment
  const workDir = cwd || os.homedir();
  const env = getSandboxedEnv(permissions);
  const limits = manifest ? getResourceLimits(manifest) : { timeout: 300000 };

  const child = _exec(command, {
    cwd: workDir, env, timeout: limits.timeout,
    maxBuffer: 10 * 1024 * 1024, shell: IS_WIN ? 'powershell.exe' : '/bin/zsh'
  }, (err, stdout, stderr) => {
    res.json({
      ok:       !err || (stdout && err?.code === 0),
      exitCode: err?.code ?? 0,
      stdout:   stdout || '',
      stderr:   stderr || '',
      command, cwd: workDir,
      sandboxed: true,
    });
  });
});

// Sandboxed file write
app.post('/api/agent/write-file', (req, res) => {
  const { filePath: fp, content, agentName } = req.body;
  if (!fp || content == null) return res.status(400).json({ error: 'filePath and content required' });
  if (!agentName) return res.status(400).json({ error: 'agentName required' });

  const manifest = getAgentManifest(agentName);
  const permissions = manifest?.permissions || req.body.permissions || {};

  let absPath;
  try { absPath = resolvePath(fp); } catch (e) {
    return res.status(403).json({ ok: false, error: e.message, blocked: true });
  }

  const writeCheck = checkFilePath(absPath, 'write', permissions, agentName);
  if (!writeCheck.allowed) {
    return res.status(403).json({ ok: false, error: writeCheck.reason, blocked: true });
  }

  try {
    fs.mkdirSync(path.dirname(absPath), { recursive: true });
    fs.writeFileSync(absPath, content, 'utf8');
    audit(agentName, 'file-write', absPath, true);
    res.json({ ok: true, path: absPath, sandboxed: true });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// Sandboxed file read
app.post('/api/agent/read-file', (req, res) => {
  const { filePath: fp, agentName } = req.body;
  if (!fp) return res.status(400).json({ error: 'filePath required' });
  if (!agentName) return res.status(400).json({ error: 'agentName required' });

  const manifest = getAgentManifest(agentName);
  const permissions = manifest?.permissions || req.body.permissions || {};

  let absPath;
  try { absPath = resolvePath(fp); } catch (e) {
    return res.status(403).json({ ok: false, error: e.message, blocked: true });
  }

  const readCheck = checkFilePath(absPath, 'read', permissions, agentName);
  if (!readCheck.allowed) {
    return res.status(403).json({ ok: false, error: readCheck.reason, blocked: true });
  }

  try {
    const content = fs.readFileSync(absPath, 'utf8');
    audit(agentName, 'file-read', absPath, true);
    res.json({ ok: true, content, path: absPath, sandboxed: true });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// Sandboxed URL fetch (proxy through domain allowlist)
app.post('/api/agent/fetch-url', async (req, res) => {
  const { url, agentName } = req.body;
  if (!url) return res.status(400).json({ error: 'URL required' });
  if (!agentName) return res.status(400).json({ error: 'agentName required' });

  const manifest = getAgentManifest(agentName);
  const permissions = manifest?.permissions || req.body.permissions || {};

  // Check network permission
  const netCheck = checkNetworkAccess(url, permissions, agentName);
  if (!netCheck.allowed) {
    return res.status(403).json({ ok: false, error: netCheck.reason, blocked: true });
  }

  // Also run the existing SSRF check
  try { validateExternalUrl(url); } catch (e) {
    return res.status(403).json({ ok: false, error: e.message, blocked: true });
  }

  try {
    const response = await fetch(url, {
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; CopilotChat/1.0)' },
      signal: AbortSignal.timeout(12000),
      redirect: 'follow',
    });
    const text = await response.text();
    res.json({ ok: true, content: text, status: response.status, sandboxed: true });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// Audit log viewer
app.get('/api/agent/audit-log', (req, res) => {
  const agent = req.query.agent || null;
  const limit = parseInt(req.query.limit) || 100;
  res.json({ log: getAuditLog(agent, limit) });
});

// ── Desktop organizer ─────────────────────────────────────────────────────
// Categorises files on ~/Desktop and moves them into named subfolders.
// dryRun=true returns the plan without touching the filesystem.

const ORGANIZE_RULES = [
  { folder: 'Screenshots',       test: n => /^Screenshot\s/.test(n) && /\.(png|jpg|jpeg)$/i.test(n) },
  { folder: 'Screen Recordings', test: n => /\.(mov|mp4|mkv|webm)$/i.test(n) },
  { folder: 'Images',            test: n => /\.(png|jpg|jpeg|gif|webp|heic|svg|tiff|bmp)$/i.test(n) },
  { folder: 'Documents',         test: n => /\.(pdf|doc|docx|txt|pages|xls|xlsx|csv|ppt|pptx|numbers|key|rtf|md)$/i.test(n) },
  { folder: 'Archives',          test: n => /\.(zip|tar|gz|bz2|dmg|pkg|rar|7z)$/i.test(n) },
  { folder: 'Code',              test: n => /\.(js|ts|py|rb|sh|zsh|bash|json|html|css|swift|go|rs|cpp|c|h|java)$/i.test(n) },
];

app.post('/api/organize-desktop', (req, res) => {
  const dryRun  = req.body?.dryRun !== false; // default dry-run for safety
  const desktop = path.join(os.homedir(), 'Desktop');

  let entries;
  try { entries = fs.readdirSync(desktop); }
  catch (e) { return res.json({ ok: false, error: e.message }); }

  const moves    = [];  // { file, from, to, folder }
  const skipped  = [];  // dirs or unmatched

  for (const name of entries) {
    const fullPath = path.join(desktop, name);
    let stat;
    try { stat = fs.statSync(fullPath); } catch (_) { continue; }
    if (stat.isDirectory()) { skipped.push(name); continue; }

    const rule = ORGANIZE_RULES.find(r => r.test(name));
    if (rule) {
      moves.push({ file: name, from: fullPath, to: path.join(desktop, rule.folder, name), folder: rule.folder });
    } else {
      skipped.push(name);
    }
  }

  if (!dryRun) {
    const created = new Set();
    const done = [], errors = [];
    for (const m of moves) {
      try {
        const dir = path.dirname(m.to);
        if (!created.has(dir)) { fs.mkdirSync(dir, { recursive: true }); created.add(dir); }
        // Avoid overwriting: rename if destination exists
        let dest = m.to;
        if (fs.existsSync(dest)) {
          const ext  = path.extname(m.file);
          const base = path.basename(m.file, ext);
          dest = path.join(path.dirname(dest), `${base}_${Date.now()}${ext}`);
        }
        fs.renameSync(m.from, dest);
        done.push({ ...m, to: dest });
      } catch (e) {
        errors.push({ file: m.file, error: e.message });
      }
    }
    return res.json({ ok: true, dryRun: false, moved: done.length, done, errors, skipped });
  }

  res.json({ ok: true, dryRun: true, moves, skipped,
    summary: Object.entries(moves.reduce((acc, m) => {
      acc[m.folder] = (acc[m.folder] || 0) + 1; return acc;
    }, {})).map(([f, c]) => `${f} (${c})`).join(', ')
  });
});

// ── System context ────────────────────────────────────────────────────────
// Returns enough system info for the AI to build an accurate context prompt.

app.get('/api/system-context', (req, res) => {
  const { auth, screenRecording, accessibility, fullDiskAccess, automation } = (() => {
    const r = {};
    try { getGhToken(); r.auth = 'granted'; } catch (_) { r.auth = 'denied'; }
    if (IS_WIN) {
      r.screenRecording = 'not-applicable';
      r.accessibility   = 'not-applicable';
      r.fullDiskAccess  = 'not-applicable';
      r.automation      = 'not-applicable';
    } else {
      r.screenRecording = systemPreferences?.getMediaAccessStatus?.('screen') ?? 'unknown';
      r.accessibility   = (systemPreferences?.isTrustedAccessibilityClient?.(false) === true) ? 'granted' : 'denied';
      r.fullDiskAccess  = checkFullDiskAccess();
      r.automation      = 'auto-prompted';
    }
    return r;
  })();

  // Collect installed agents (name + displayName only)
  const installedAgents = [];
  try {
    for (const entry of fs.readdirSync(AGENTS_DIR)) {
      const mp = path.join(AGENTS_DIR, entry, 'agent.json');
      if (fs.existsSync(mp)) {
        try {
          const m = JSON.parse(fs.readFileSync(mp, 'utf8'));
          if (!m._parentAgent) installedAgents.push({ name: m.name || entry, displayName: m.displayName || m.name || entry });
        } catch (_) {}
      }
    }
  } catch (_) {}

  res.json({
    os:       IS_WIN ? 'Windows' : 'macOS',
    release:  os.release(),
    hostname: os.hostname(),
    user:     os.userInfo().username,
    home:     os.homedir(),
    desktop:  path.join(os.homedir(), 'Desktop'),
    cwd:      process.cwd(),
    shell:    SHELL_BIN,
    permissions: { auth, screenRecording, accessibility, fullDiskAccess, automation },
    installedAgents,
  });
});

// ── macOS Permissions check ───────────────────────────────────────────────

function checkFullDiskAccess() {
  if (IS_WIN) return 'not-applicable';  // macOS-only permission concept
  // Probe files that are always protected by Full Disk Access on macOS 10.15+
  const probes = [
    path.join(os.homedir(), 'Library', 'Safari', 'History.db'),
    path.join(os.homedir(), 'Library', 'Messages', 'chat.db'),
    '/Library/Application Support/com.apple.TCC/TCC.db',
  ];
  for (const p of probes) {
    try {
      fs.accessSync(p, fs.constants.R_OK);
      return 'granted';
    } catch (e) {
      if (e.code === 'EPERM' || e.code === 'EACCES') return 'denied';
      // ENOENT = file doesn't exist but we had access — try next probe
    }
  }
  return 'not-determined';
}

app.get('/api/permissions', (req, res) => {
  const result = {};

  // GitHub auth
  try { getGhToken(); result.auth = 'granted'; }
  catch (_) { result.auth = 'denied'; }

  if (IS_WIN) {
    // macOS-only permissions do not exist on Windows — mark them so the UI hides them
    result.screenRecording = 'not-applicable';
    result.accessibility   = 'not-applicable';
    result.fullDiskAccess  = 'not-applicable';
    result.automation      = 'not-applicable';
  } else {
    // Screen Recording — Electron systemPreferences API
    result.screenRecording = systemPreferences?.getMediaAccessStatus?.('screen') ?? 'unknown';

    // Accessibility — Electron systemPreferences API
    result.accessibility = (systemPreferences?.isTrustedAccessibilityClient?.(false) === true)
      ? 'granted' : 'denied';

    // Full Disk Access — file system probe
    result.fullDiskAccess = checkFullDiskAccess();

    // Automation — marked as auto-prompted (can't check without potentially prompting)
    result.automation = 'auto-prompted';
  }

  res.json(result);
});

// Trigger Screen Recording permission prompt via desktopCapturer
app.post('/api/permissions/request-screen', async (req, res) => {
  try {
    if (!desktopCapturer) throw new Error('desktopCapturer not available');
    await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: { width: 1, height: 1 } });
    const status = systemPreferences?.getMediaAccessStatus?.('screen') ?? 'unknown';
    res.json({ status });
  } catch (e) {
    res.json({ status: systemPreferences?.getMediaAccessStatus?.('screen') ?? 'unknown', error: e.message });
  }
});

// ── Memory / Skill Categories ─────────────────────────────────────────────
// Structured as categories (tools) each containing skill groups.
// Shape: [ { id, name, icon, enabled, builtIn, groups: [{id, title, body, enabled}] } ]

const MEMORY_FILE = path.join(CONFIG_DIR, 'memory.json');

function defaultFigmaGroups() {
  return [];
}

// Original built-in Figma spec groups (kept for reference / manual restore via Reset Built-in)
function _builtInFigmaGroupsRef() {
  return [
    { id: 'workflow',           title: 'Workflow — When User Asks to Create a Spec', body: 'When the user asks to create a design/component spec:\n1. **Resolve component instance first**: Before generating any spec, determine if you have a component key or node ID for the target component. Check if the user provided one, or if you can find it via `get_design_context`/`get_metadata`. **If the component instance is NOT available**, prompt the user: _"Please select the component in Figma (or provide the component key/node ID) so I can include live instances in the anatomy, variants, and examples sections."_ Do NOT proceed until the component reference is resolved.\n2. **If Figma MCP is enabled**: Ask the user whether they want the spec created **in Figma** or **as a markdown artifact**.\n3. **If Figma MCP is not enabled**: Generate the spec as a markdown artifact using the markdown format below.\n4. **ALWAYS use the `figma_execute` MCP tool** for Figma output — never use `figma-exec` fenced blocks for spec creation.', enabled: true },
    { id: 'build-sequence',     title: 'Figma Build Sequence', body: '1. **Create page**: `figma.createPage()` → set name → `figma.currentPage = page`\n2. **Splash card** at x=-1300: import splash key, set properties (Guidance Checklist#12857:0=false, Contact list#357:0=false, Resource list#357:1=false, Custom#10144:1=true), override text nodes ("Component name", description, kind label)\n3. **6 sections** side-by-side: each at x = index * 1300 (1200px + 100px gap)\n   - Root frame: 1200px wide, VERTICAL, primaryAxisSizingMode=AUTO, counterAxisSizingMode=FIXED, itemSpacing=0, fills=[white], cornerRadius=32\n   - GuidanceHeader instance: layoutAlign=STRETCH, find TEXT nodes named "Title" → [0]=number, [1]=title\n   - Page frame: 1200px, VERTICAL, itemSpacing=32, padding 64/88/64/88, fills=[#FAFAFA], layoutAlign=STRETCH\n   - Content blocks inside Page frame\n4. **Zoom to fit**: `figma.viewport.scrollAndZoomIntoView(allFrames)`', enabled: true },
    { id: 'instance-placement', title: 'Component Instance Placement', body: '### Anatomy (Overview section)\n1. Import the target component via `figma.importComponentByKeyAsync(componentKey)` and create an instance.\n2. Place the instance inside the Overview page frame, below the anatomy text descriptions.\n3. Add numbered annotation markers (small circles with numbers) positioned over each anatomy part.\n4. Cap width to 1024px: `if (inst.width > 1024) inst.rescale(1024 / inst.width)`\n\n### Variants (Overview section)\n1. Retrieve all variant properties from the component set.\n2. For each meaningful variant combination, create an instance and set its variant properties via `inst.setProperties({...})`.\n3. Label each instance with a text node showing the variant/config name.\n4. Arrange instances in a grid or vertical stack inside the Overview page frame.\n5. If variant properties are not discoverable, prompt the user.\n\n### Examples section\n1. For each example entry, create a component instance configured to match the described state/scenario.\n2. Set variant properties to reflect the example\'s state.\n3. Place the instance adjacent to or below the example\'s text description.\n4. If the component key is unavailable, prompt the user before generating this section.\n\n### Fallback: Prompting the User\nIf the component key, node ID, or variant information is not available:\n- **Do NOT skip** the instance — pause and ask the user.\n- Resume spec generation only after the component reference is resolved.', enabled: true },
    { id: 'font-loading',       title: 'Font Loading Helper', body: 'REQUIRED before setting .characters — use this exact helper:\n```js\nasync function loadFont(textNode) {\n    const fn = textNode.fontName;\n    try { await figma.loadFontAsync(fn); return; } catch(_) {}\n    const parts = fn.style.split(\' \');\n    if (parts.length >= 2) {\n        const reversed = { family: fn.family, style: parts.reverse().join(\' \') };\n        try { await figma.loadFontAsync(reversed); textNode.fontName = reversed; return; } catch(_) {}\n    }\n    const synonyms = {Demibold:\'Semibold\', Semibold:\'Demibold\', Medium:\'Regular\', Heavy:\'Bold\', Black:\'Bold\', ExtraBold:\'Bold\'};\n    for (const [from, to] of Object.entries(synonyms)) {\n        if (fn.style.includes(from)) {\n            const alt = { family: fn.family, style: fn.style.replace(from, to) };\n            try { await figma.loadFontAsync(alt); textNode.fontName = alt; return; } catch(_) {}\n        }\n    }\n    const s = fn.style.toLowerCase();\n    const w = s.includes(\'bold\') ? \'Bold\' : s.includes(\'semi\') || s.includes(\'demi\') ? \'Semibold\' : \'Regular\';\n    const fb = { family: \'Segoe UI\', style: w };\n    await figma.loadFontAsync(fb); textNode.fontName = fb;\n}\n```', enabled: true },
    { id: 'text-overrides',     title: 'Text Block Overrides', body: 'CRITICAL: No placeholder text may remain.\n- After creating ANY component instance, MUST find ALL text nodes and override them:\n  `const texts = inst.findAll(n => n.type === \'TEXT\');`\n- texts[0] = title, texts[1] = body — ALWAYS call `loadFont(texts[N])` then set `.characters`\n- If no title needed: `texts[0].characters = \'\'` and `inst.setProperties({\'Show title#10151:2\': false})`\n- If no body needed: `texts[1].characters = \'\'` and `inst.setProperties({\'Show body#10151:8\': false})`\n- Default placeholders like "Section title L", "Body text M", "Heading XXL" WILL show if you skip this', enabled: true },
    { id: 'component-blocks',   title: 'Component Instance Blocks', body: '- Import via `figma.importComponentByKeyAsync(component_key)`, call `.createInstance()`\n- Set `layoutAlign = \'CENTER\'`, set name if provided\n- Toggle boolean properties: `inst.setProperties({ \'PropertyName#id\': true/false })`\n- Cap width: `if (inst.width > 1024) inst.rescale(1024 / inst.width)`', enabled: true },
    { id: 'data-model',         title: 'Spec Data Model (6 Sections)', body: '### 1. Overview\n- `component_name`: string\n- `description`: 1-3 sentence description\n- `anatomy_parts`: list of `{number, name, description}`\n- `anatomy_instance`: **REQUIRED** — annotated live instance with numbered annotation markers\n- `variants`: list of variant/state names\n- `variant_instances`: **REQUIRED** — live instances for EVERY variant and configuration\n- `live_preview`: optional component instance reference\n\n### 2. Content\n- `guidance`: `{date_format, punctuation, heading_text, capitalization, overflow_menu_suggestions[], footer_button_suggestions[]}`\n- `examples`: list of `{context, annotations[], guidelines[], live_preview?}`\n\n### 3. Usage\n- `when_to_use`: list of strings\n- `when_not_to_use`: list of strings\n- `dos`: list of `{label, description}`\n- `donts`: list of `{label, description}`\n- `placement`: string\n\n### 4. Accessibility\n- `guidelines`: prose string\n- `keyboard_interactions`: list of `{key, action}`\n- `tab_order`: ordered list of tab stop strings\n- `narration_entries`: list of `{number, key, state, narrator_string}`\n\n### 5. Examples\n- `examples`: list of `{title, description, state, live_preview?}`\n- `example_instances`: **REQUIRED** — live component instance per example\n\n### 6. RAI (Responsible AI)\n- `citations_and_references`: string\n- `ai_disclaimer`: string\n- `principles`: list of `{name, description}`', enabled: true },
    { id: 'component-keys',     title: 'Component Keys (KEYS dict)', body: '- `header`: `c92557049724bf0d8726c1a34563ef7a3b5b6e70` — UTIL-GuidanceHeader\n- `text_xxl`: `b7aef3e443b5804c628d08afb00dc43d9cb871f8` — UTIL-GuidanceTextBlock Style=XXL\n- `text_l`: `3e8e9cfe13596cd04f09d8dce37d0fbfc8a63644` — UTIL-GuidanceTextBlock Style=L\n- `text_m`: `196ec978c2bbad76accfce02b7da49e531779de5` — UTIL-GuidanceTextBlock Style=M\n- `text_s`: `7ebd43d5387e9597987dfa86ac4306e76d4b468d` — UTIL-GuidanceTextBlock Style=S\n- `buffer`: `e6adb6c3061e04f438d8aacd23252882b3bda616` — Blocks / Buffer (divider)\n- `best_do_header`: `ec326f63f5ea0c33b6cf941857ef16e368484327` — Do header\n- `best_dont_header`: `8a1b46b982d9f69f3b564c0b68160db5cbd157c4` — Don\'t header\n- `best_do_bullet`: `afee6ebe1fd335e8a4380aa58b1de282abb794bc` — Do bullet\n- `best_dont_bullet`: `fb2df191ed6cd41418d85550e1a22a90a47f5562` — Don\'t bullet\n- `splash`: `076bea735b162eaa152d9df6b37b75ec2bed315b` — UTIL-GuidanceComponentSplash (cover card)\n- `footer`: `324a9470b9d637ed69401111ab277e01346d606a` — UTIL-GuidanceFooter', enabled: true },
    { id: 'design-tokens',      title: 'Design Token Variable Keys', body: '### Backgrounds\n- `bg1`: `4a08218e9cddb87bafa9b83f73e6ee40f5e15e3e` — Neutral/Background/1/Rest (#fff)\n- `bg2`: `0fa4c8c8fc13d3e98f827a96f25168a46cf5adc9` — Neutral/Background/2/Rest\n- `bg3`: `16a0b41baa19d91b71f810dbce608a7b86bde49f` — Neutral/Background/3/Rest\n- `bg4`: `97aa51374458940b6d7b66c1a8e91186e386bf15` — Neutral/Background/4/Rest\n### Foregrounds\n- `fg1`: `fbc35e3f43dd8dad7a0c8b48e7c547058ecc651c` — Neutral/Foreground/1 (#242424)\n- `fg2`: `42e6c2df6cd2a75d6aa36c4e56b3b38ea0d3f4c0` — Neutral/Foreground/2 (#424242)\n- `fg3`: `af92c07f44a2bcab9ee3d6d87c1fffc9a3fb0c35` — Neutral/Foreground/3 (#616161)\n### Spacing\n- `spacing_s`: `2cfecff21b7f4aa80cac71e6f13a1f79e6e3d85a` — 8px\n- `spacing_m`: `a15a3dae66bae06f1c0f7d5f88c02d8cca3adac0` — 12px\n- `spacing_l`: `d80ff8c9f6ad5e92c18f0c1a1b9d2aef9b736ef6` — 16px\n- `spacing_xxl`: `f55b0ced58de9daba5d5e66e0e3b85dc6deab53a` — 24px\n### Corner Radius\n- `corner_section`: `1cc316818f4f64417e936f0d49cc6288620a347f` — 12px', enabled: true },
    { id: 'font-presets',       title: 'Font Presets (TYPO dict)', body: '- `heading_large`: Segoe UI, 32px, 40px, Bold\n- `heading_medium`: Segoe UI, 24px, 32px, Semibold\n- `heading_small`: Segoe UI, 20px, 28px, Semibold\n- `subtitle`: Segoe UI, 16px, 22px, Semibold\n- `body1`: Segoe UI, 14px, 20px, Regular\n- `body1_strong`: Segoe UI, 14px, 20px, Semibold\n- `caption1`: Segoe UI, 12px, 16px, Regular\n- `caption2_strong`: Segoe UI, 10px, 14px, Semibold', enabled: true },
    { id: 'rendering-format',   title: 'Rendering Format (Figma & Markdown)', body: '### Figma Rendering\n- Each section is a 1200px-wide vertical auto-layout frame with rounded corners (32px)\n- Sections placed side-by-side with 100px gaps\n- Cover card (UTIL-GuidanceComponentSplash) placed at x=-1300\n- Each section has: UTIL-GuidanceHeader (number + title) → "Page" content frame (88px padding, 32px item spacing, #FAFAFA bg)\n- Content blocks use these component types: text_xxl, text_l, text_m, text_s, buffer (divider), do_header, dont_header, do_bullet, dont_bullet, component_instance\n- Section order: Overview → Usage → Examples → Accessibility → Content → RAI\n- Font loading: use `figma.loadFontAsync(textNode.fontName)` with fallback to reversed style names, then Segoe UI Bold/Semibold/Regular\n\n### Markdown Rendering\n```\n# ComponentName\n> Description\n\n## Anatomy (table: #, Part, Description)\n## Anatomy Instance (annotated live component)\n## Variants (bullet list + live instances)\n---\n# Content\n## Additional guidance\n## Examples of content\n---\n# Usage\n## When to use / When not to use\n## Do / Don\'t\n## Placement\n---\n# Accessibility\n## Accessibility guidelines\n## Keyboarding\n### Tab order\n## Narration\n---\n# Examples (title, description, live instance)\n---\n# RAI\n## Citations and references\n## AI disclaimer\n## RAI Principles\n```', enabled: true },
  ];
}

function defaultMemoryCategories() {
  return [];
}

// Migration: if saved data is flat array of groups (old format), wrap into category
function migrateMemoryData(data) {
  if (!Array.isArray(data) || data.length === 0) return defaultMemoryCategories();
  // Old format: [{id, title, body, enabled}] — no "groups" key on first element
  if (data[0] && !data[0].groups && data[0].body !== undefined) {
    return [{ id: 'figma-spec-design', name: 'Figma Spec Design', icon: 'brand-figma', enabled: true, builtIn: true, groups: data }];
  }
  return data;
}

function loadMemoryCategories() {
  try {
    const raw = JSON.parse(fs.readFileSync(MEMORY_FILE, 'utf8'));
    return migrateMemoryData(raw);
  } catch (_) {}
  return defaultMemoryCategories();
}

function saveMemoryCategories(categories) {
  fs.mkdirSync(CONFIG_DIR, { recursive: true });
  fs.writeFileSync(MEMORY_FILE, JSON.stringify(categories, null, 2));
}

// GET — return all categories
app.get('/api/memory', (req, res) => {
  res.json(loadMemoryCategories());
});

// PUT — save all categories (full replace)
app.put('/api/memory', (req, res) => {
  const cats = req.body;
  if (!Array.isArray(cats)) return res.status(400).json({ error: 'Expected array of categories' });
  saveMemoryCategories(cats);
  res.json({ ok: true });
});

// POST — create a new category
app.post('/api/memory/category', (req, res) => {
  const { name, icon } = req.body;
  if (!name || !name.trim()) return res.status(400).json({ error: 'Category name required' });
  const cats = loadMemoryCategories();
  const id = 'cat-' + Date.now();
  const keywords = Array.isArray(req.body.keywords) ? req.body.keywords : [];
  const cat = { id, name: name.trim(), icon: icon || 'tools', enabled: true, builtIn: false, keywords, groups: [] };
  cats.push(cat);
  saveMemoryCategories(cats);
  res.json({ ok: true, category: cat });
});

// DELETE — delete a category by id
app.delete('/api/memory/category/:catId', (req, res) => {
  const cats = loadMemoryCategories();
  const idx = cats.findIndex(c => c.id === req.params.catId);
  if (idx === -1) return res.status(404).json({ error: 'Category not found' });
  cats.splice(idx, 1);
  saveMemoryCategories(cats);
  res.json({ ok: true });
});

// PATCH — update a category (name, icon, enabled) or a group within it
app.patch('/api/memory/category/:catId', (req, res) => {
  const cats = loadMemoryCategories();
  const cat = cats.find(c => c.id === req.params.catId);
  if (!cat) return res.status(404).json({ error: 'Category not found' });
  const { name, icon, enabled, keywords } = req.body;
  if (name !== undefined) cat.name = name;
  if (icon !== undefined) cat.icon = icon;
  if (enabled !== undefined) cat.enabled = enabled;
  if (keywords !== undefined) cat.keywords = Array.isArray(keywords) ? keywords : [];
  saveMemoryCategories(cats);
  res.json({ ok: true, category: cat });
});

// POST — add a skill group to a category
app.post('/api/memory/category/:catId/group', (req, res) => {
  const cats = loadMemoryCategories();
  const cat = cats.find(c => c.id === req.params.catId);
  if (!cat) return res.status(404).json({ error: 'Category not found' });
  const { title, body } = req.body;
  if (!title || !title.trim()) return res.status(400).json({ error: 'Group title required' });
  const group = { id: 'grp-' + Date.now(), title: title.trim(), body: body || '', enabled: true };
  cat.groups.push(group);
  saveMemoryCategories(cats);
  res.json({ ok: true, group });
});

// PATCH — update a group within a category
app.patch('/api/memory/category/:catId/group/:grpId', (req, res) => {
  const cats = loadMemoryCategories();
  const cat = cats.find(c => c.id === req.params.catId);
  if (!cat) return res.status(404).json({ error: 'Category not found' });
  const grp = cat.groups.find(g => g.id === req.params.grpId);
  if (!grp) return res.status(404).json({ error: 'Group not found' });
  Object.assign(grp, req.body);
  saveMemoryCategories(cats);
  res.json({ ok: true, group: grp });
});

// DELETE — remove a group from a category
app.delete('/api/memory/category/:catId/group/:grpId', (req, res) => {
  const cats = loadMemoryCategories();
  const cat = cats.find(c => c.id === req.params.catId);
  if (!cat) return res.status(404).json({ error: 'Category not found' });
  const idx = cat.groups.findIndex(g => g.id === req.params.grpId);
  if (idx === -1) return res.status(404).json({ error: 'Group not found' });
  cat.groups.splice(idx, 1);
  saveMemoryCategories(cats);
  res.json({ ok: true });
});

// POST — reset built-in categories to defaults (preserves user-created categories)
app.post('/api/memory/reset', (req, res) => {
  const cats = loadMemoryCategories();
  const defaults = defaultMemoryCategories();
  // Replace built-in categories with defaults, keep user-created ones
  const userCats = cats.filter(c => !c.builtIn);
  const result = [...defaults, ...userCats];
  saveMemoryCategories(result);
  res.json({ ok: true, categories: result, defaults });
});

// Trigger Accessibility permission prompt
app.post('/api/permissions/request-accessibility', (req, res) => {
  try {
    const trusted = systemPreferences?.isTrustedAccessibilityClient?.(true); // true = show prompt
    res.json({ status: trusted ? 'granted' : 'denied' });
  } catch (e) {
    res.json({ status: 'denied', error: e.message });
  }
});

// ── Start ─────────────────────────────────────────────────────────────────

export function startServer(port) {
  return new Promise((resolve, reject) => {
    const server = app.listen(port, '127.0.0.1', () => {
      console.log(`\n  ✦ Copilot Chat  →  http://127.0.0.1:${port}\n`);
      resolve(server);
    });
    server.on('error', reject);

    // Clean up MCP child process and Figma timers on exit
    function fullCleanup() {
      // Cancel the Figma reconnect loop so it can't keep the event loop alive
      if (figmaState.pendingReconnect) {
        clearTimeout(figmaState.pendingReconnect);
        figmaState.pendingReconnect = null;
      }
      // Close the WS connection
      if (figmaWs) {
        try { figmaWs.terminate(); } catch (_) {}
        figmaWs = null;
      }
      // Kill MCP child
      if (isMcpRunning()) mcpProcess.kill('SIGKILL');
    }
    process.on('exit',    () => fullCleanup());
    process.on('SIGTERM', () => { fullCleanup(); process.exit(0); });
    process.on('SIGINT',  () => { fullCleanup(); process.exit(0); });
  });
}

export { app };
