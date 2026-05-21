/**
 * Copilot Chat — backend server
 * Streams GitHub Copilot responses via SSE, serves the chat UI, fetches URLs.
 */

import express    from 'express';
import OpenAI     from 'openai';
import localtunnel from 'localtunnel';
import { execSync, exec as _exec, execFile as _execFile, spawn } from 'child_process';
import crypto     from 'crypto';
import path       from 'path';
import os         from 'os';
import fs         from 'fs';
import { performance } from 'perf_hooks';
import { createRequire } from 'module';
import { fileURLToPath } from 'url';
import { WebSocketServer } from 'ws';
import { checkFilePath, checkNetworkAccess, checkShellCommand, getSandboxedEnv, getResourceLimits, audit, getAuditLog } from './agent-sandbox.js';
import { getAgentTools, startAgentMCPServers, stopAgentMCPServers, executeBuiltInTool, executeCustomTool } from './agent-tools.js';
import { scanAgent } from './agent-scanner.js';
import { createTask, getTask, getAllTasks, updateTask, deleteTask, startScheduler, stopScheduler } from './task-manager.js';
import { runTask, pauseTask, stopTask, steerTask, isTaskRunning, subscribe } from './task-runner.js';
import {
  createProject, getProject, getAllProjects, updateProject, deleteProject,
  touchProject, linkConversation, linkTask,
  addSource, removeSource, syncSource, listFiles, readSourceFile, resolveSourceFilePath,
  addContext, updateContext, removeContext, contextFromArtifact,
  getProjectSystemContext, buildContextPayload,
} from './project-manager.js';
import { loadInstructionFiles, _safeReadInstructionFile, _isPathInside, _realPathOrResolve, INSTRUCTION_FILE_LIMIT, INSTRUCTION_TOTAL_LIMIT } from './lib/instruction-files.js';
import {
  remember as factsRemember, recall as factsRecall, forget as factsForget,
  listFacts, getFact, runDecay, formatForSystemPrompt as factsForSystemPrompt,
  exportFacts, importFacts, getStats as factsGetStats,
} from './memory-store.js';
import { SELF_TOOL_DEFS, executeSelfTool, isSelfTool } from './self-tools.js';
import {
  getSettings as hbGetSettings, updateSettings as hbUpdateSettings,
  getLog as hbGetLog, clearLog as hbClearLog,
  runHeartbeat, startHeartbeat, stopHeartbeat,
} from './heartbeat.js';
import {
  createWorkflow, getWorkflow, getAllWorkflows, updateWorkflow, deleteWorkflow,
  getHistory as wfGetHistory, runWorkflow, startWorkflowTimer, stopWorkflowTimer, parseSchedule,
} from './workflow-manager.js';
import {
  isCommandSafe, addAutoAllow, getAutoAllowList, removeAutoAllow, clearAutoAllow,
  checkCommandPermission, explainCommand,
} from './permission-guard.js';
import { ToolGuardContext, formatToolLabel, getToolCategory } from './tool-guard.js';
import {
  CONFIG_DIR, CONFIG_FILE, RECOVERY_DIR,
  findGhBinary, readTokenFromKeychain, readTokenFromConfig,
  readSavedConfig, writeSavedConfig, getGhToken, getCopilotClient,
} from './server/copilot/auth.js';
import { FALLBACK_MODELS, CHAT_COMPLETIONS_UNSUPPORTED_RE } from './server/copilot/models.js';
import { GEN_UI_CATALOG_PROMPT } from './server/prompts/gen-ui-catalog.js';
import { registerConversationRoutes } from './server/routes/conversations.js';
import { registerProjectRunRoutes } from './server/routes/project-runs.js';
import { registerProjectRoutes } from './server/routes/projects.js';
import { registerTaskRoutes } from './server/routes/tasks.js';
import { registerUtilityRoutes } from './server/routes/utilities.js';
import { registerProviderRoutes } from './server/routes/providers.js';
import { registerMobileRoutes } from './server/routes/mobile.js';
import { registerEnterpriseStubRoutes } from './server/routes/enterprise.js';
import { registerAuthRoutes } from './server/routes/auth.js';
import { createExtBridge } from './server/bridges/ext.js';
import { createCustomMcpBridge } from './server/bridges/custom-mcp.js';
import { createFigmaBridge } from './server/bridges/figma.js';
import { registerWorkspaceRoutes } from './server/routes/workspace.js';
import { registerStoreRoutes } from './server/routes/store.js';
import { registerChatMiscRoutes } from './server/routes/chat-misc.js';
import { registerChatRoute } from './server/routes/chat.js';
import { registerGitRoutes } from './server/routes/git.js';
import { registerBrowseRoutes } from './server/bridges/playwright-browse.js';
import { registerShellExecRoutes } from './server/routes/shell-exec.js';
import { registerAgentSandboxFileRoutes } from './server/routes/agent-sandbox-files.js';
import { registerAgentRoutes } from './server/routes/agents.js';
import { registerAgentBuilderRoutes } from './server/routes/agent-builder.js';
import { registerAgentSandboxRoutes } from './server/routes/agent-sandbox.js';
import { registerMemoryPrefsFactsRoutes } from './server/routes/memory-prefs-facts.js';
import { registerWhisperRoutes } from './server/routes/whisper.js';
import { registerPlaywrightMcpRoutes } from './server/routes/playwright-mcp.js';
import { createTeamsBundle } from './server/routes/teams.js';
import { registerDocsAndExtRoutes } from './server/routes/docs-and-ext.js';
import { registerSchedulingAndGuardRoutes } from './server/routes/scheduling-and-guard.js';
import { registerRegionAndStdinRoutes } from './server/routes/region-and-stdin.js';
import { registerPermissionsRoutes } from './server/routes/permissions.js';
import { registerSystemContextRoutes } from './server/routes/system-context.js';
import { registerDesktopOrganizerRoutes } from './server/routes/desktop-organizer.js';
import { registerMarkdownPdfAndYoutubeRoutes } from './server/routes/markdown-pdf-and-youtube.js';
import { createAgentDirIterator } from './server/lib/agents-iter.js';
import {
  resolvePath, atomicWriteFile, checkpointFile,
  setAgentManifestGetter as _setAgentManifestGetter,
} from './server/lib/write-helpers.js';
import {
  getTeamsSettings, updateTeamsSettings, startTeamsBridge, stopTeamsBridge, testConnection as teamsTestConnection,
} from './teams-bridge.js';
import {
  getBotConfig, updateBotConfig, getBotStatus, startBot, stopBot, initBotManager,
} from './teams-bot-manager.js';
import QRCode     from 'qrcode';

// Electron APIs — available when server runs inside the Electron main process.
// Gracefully degrade if run standalone (e.g. during testing).
const _require = createRequire(import.meta.url);
let systemPreferences, desktopCapturer, powerSaveBlocker, _ElectronBrowserWindow, _electronApp, _electronShell;
try {
  ({ systemPreferences, desktopCapturer, powerSaveBlocker,
     BrowserWindow: _ElectronBrowserWindow,
     app: _electronApp,
     shell: _electronShell } = _require('electron'));
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
const FAUNA_CONFIG_DIR = path.join(os.homedir(), '.config', 'fauna');

// Module-level AI caller — set during startServer(), used by permission guard etc.
let internalAICaller = async () => '';
// Track the model currently in use for conversations so features inherit it
let _activeModel = 'gpt-4.1';

// killId → ChildProcess (for user-initiated shell-exec cancel)
const _shellProcs = new Map();

app.use(express.json({ limit: '25mb' }));
app.use(express.urlencoded({ limit: '25mb', extended: false }));
app.use(express.static(path.join(__dirname, 'public')));

// ── Browser extension bridge moved → server/bridges/ext.js ──
const extBridge = createExtBridge({
  getFaunaMcpState: () => customMcp.getRelayState(),
});
extBridge.register(app);

// ── Custom MCP bridge moved → server/bridges/custom-mcp.js ──
// `findNodeBinary` is hoisted; figma getter resolves at request time.
const customMcp = createCustomMcpBridge({
  faunaConfigDir: FAUNA_CONFIG_DIR,
  extBridge,
  getFigmaConnected: () => figma.isConnected(),
  bundledBrowserServerPath: path.join(__dirname, 'faunaMCP-main', 'browser-server', 'index.js'),
  findNodeBinary,
});
customMcp.register(app);

// ── Figma bridge moved → server/bridges/figma.js ──
const figma = createFigmaBridge({
  configDir: CONFIG_DIR,
  bundledMcpServerPath: path.join(process.resourcesPath || '', 'mcp-server', 'server', 'index.js'),
  devMcpServerPath: path.join(__dirname, 'relay', 'server', 'index.js'),
  defaultMcpPath: path.join(os.homedir(), 'FigmaExtensions', 'CopilotMCP', 'server', 'index.js'),
  bundledPluginPath: path.join(process.resourcesPath || '', 'figma-plugin'),
  devPluginPath: path.join(__dirname, 'assets', 'figma-plugin'),
  readSavedConfig,
  findNodeBinary,
  isWin: IS_WIN,
});
figma.register(app);

app.get('/api/runs', (_req, res) => {
  res.json([]);
});

registerConversationRoutes(app, {
  fs,
  path,
  configDir: FAUNA_CONFIG_DIR,
  getCopilotClient,
});

registerTaskRoutes(app, {
  createTask,
  getTask,
  getAllTasks,
  updateTask,
  deleteTask,
  runTask,
  pauseTask,
  stopTask,
  steerTask,
  isTaskRunning,
  subscribe,
});

registerProjectRoutes(app, {
  fs,
  createProject,
  getProject,
  getAllProjects,
  updateProject,
  deleteProject,
  touchProject,
  linkConversation,
  linkTask,
  addSource,
  removeSource,
  syncSource,
  listFiles,
  readSourceFile,
  resolveSourceFilePath,
  addContext,
  updateContext,
  removeContext,
  contextFromArtifact,
});

registerProviderRoutes(app, { faunaConfigDir: FAUNA_CONFIG_DIR });
registerMobileRoutes(app, { faunaConfigDir: FAUNA_CONFIG_DIR, port: PORT });
registerEnterpriseStubRoutes(app);
registerAuthRoutes(app);

// ── Store routes moved → server/routes/store.js (registered after AGENTS_DIR is declared) ──

// ── Provider / mobile / enterprise / workiq routes moved → server/routes/{providers,mobile,enterprise}.js ──
// ── Fauna self-update ─────────────────────────────────────────────────────
let _faunaUpdateJob = null;

const FAUNA_REPO_OWNER = 'howmon';
const FAUNA_REPO_NAME  = 'fauna';
const FAUNA_APP_DIR    = __dirname;

function _faunaLog(msg) {
  if (!_faunaUpdateJob) return;
  _faunaUpdateJob.logs = _faunaUpdateJob.logs || [];
  _faunaUpdateJob.logs.push({ message: msg, ts: Date.now() });
  _faunaUpdateJob.message = msg;
}

function _faunaIsPackaged() {
  return !!(_electronApp && _electronApp.isPackaged);
}

function _faunaGitSha() {
  // 1. Try live git (works in dev / git-clone installs)
  try {
    return execSync('git rev-parse HEAD', { cwd: FAUNA_APP_DIR, encoding: 'utf8' }).trim();
  } catch (_) {}
  // 2. Fall back to build-time SHA embedded in build-info.json (packaged app)
  try {
    const info = JSON.parse(fs.readFileSync(path.join(FAUNA_APP_DIR, 'build-info.json'), 'utf8'));
    if (info && info.sha) return info.sha;
  } catch (_) {}
  return null;
}

async function _faunaFetchRemoteSha() {
  // Use GitHub API — no auth needed for public repos
  const https = await import('https');
  return new Promise((resolve, reject) => {
    const url = `https://api.github.com/repos/${FAUNA_REPO_OWNER}/${FAUNA_REPO_NAME}/commits/HEAD`;
    const opts = { headers: { 'User-Agent': 'Fauna-App/1.0', 'Accept': 'application/vnd.github.sha' } };
    https.get(url, opts, r => {
      let body = '';
      r.on('data', c => body += c);
      r.on('end', () => {
        if (r.statusCode === 200) resolve(body.trim());
        else reject(new Error(`GitHub API ${r.statusCode}: ${body.slice(0, 120)}`));
      });
    }).on('error', reject);
  });
}

app.get('/api/fauna/update-status', (_req, res) => {
  res.json({ job: _faunaUpdateJob || { phase: 'idle', updateAvailable: false } });
});

app.post('/api/fauna/check-update', async (_req, res) => {
  _faunaUpdateJob = { phase: 'checking', checking: true, running: false, logs: [] };
  _faunaLog('Reading local git SHA…');
  try {
    const currentSha = _faunaGitSha();
    if (!currentSha) throw new Error('Not a git repository — cannot check for updates');
    _faunaLog(`Local SHA: ${currentSha.slice(0, 12)}`);
    _faunaLog('Fetching latest SHA from GitHub…');
    const latestSha = await _faunaFetchRemoteSha();
    _faunaLog(`Remote SHA: ${latestSha.slice(0, 12)}`);
    const updateAvailable = latestSha !== currentSha;
    _faunaUpdateJob = {
      phase: updateAvailable ? 'available' : 'current',
      checking: false, running: false,
      updateAvailable,
      currentSha, latestSha,
      logs: _faunaUpdateJob.logs,
      message: updateAvailable ? `Update available (${latestSha.slice(0,7)})` : 'Already up to date',
    };
  } catch (err) {
    _faunaUpdateJob = {
      phase: 'error', checking: false, running: false, updateAvailable: false,
      error: err.message, logs: (_faunaUpdateJob && _faunaUpdateJob.logs) || [],
    };
    _faunaLog(`Error: ${err.message}`);
  }
  res.json({ job: _faunaUpdateJob });
});

app.post('/api/fauna/install-update', express.json(), async (req, res) => {
  if (_faunaUpdateJob && _faunaUpdateJob.running) {
    return res.status(409).json({ error: 'Update already in progress' });
  }

  console.log('[fauna-update] Install triggered. App dir:', FAUNA_APP_DIR);
  console.log('[fauna-update] Is packaged:', _faunaIsPackaged());
  
  // Check if we can do git-based updates (requires .git folder)
  const hasGitRepo = fs.existsSync(path.join(FAUNA_APP_DIR, '.git'));
  console.log('[fauna-update] .git exists in app dir:', hasGitRepo);
  
  // In a packaged app without git repo, open the releases page instead
  if (_faunaIsPackaged() && !hasGitRepo) {
    const releasesUrl = `https://github.com/${FAUNA_REPO_OWNER}/${FAUNA_REPO_NAME}/releases`;
    console.log('[fauna-update] Opening releases page:', releasesUrl);
    console.log('[fauna-update] _electronShell available:', !!_electronShell);
    
    if (_electronShell) {
      _electronShell.openExternal(releasesUrl);
      console.log('[fauna-update] openExternal called');
    } else {
      console.log('[fauna-update] WARNING: _electronShell not available, cannot open browser');
    }
    
    _faunaUpdateJob = {
      phase: 'complete', running: false, updateAvailable: false,
      message: 'Opened GitHub releases page in browser — download and install the new version.',
      logs: [{ message: `Opened ${releasesUrl}` }],
    };
    return res.json({ job: _faunaUpdateJob });
  }
  
  // If no git repo exists at all, we can't update
  if (!hasGitRepo) {
    console.log('[fauna-update] No git repo found, cannot update');
    return res.status(400).json({ 
      error: 'No git repository found. Please install from GitHub releases or clone the repository.'
    });
  }

  _faunaUpdateJob = { phase: 'starting', running: true, logs: [], updateAvailable: false };
  res.json({ job: _faunaUpdateJob });   // respond immediately; client polls /update-status

  const { promisify } = await import('util');
  const execP = promisify(_exec);

  async function phase(name, cmd) {
    _faunaUpdateJob.phase = name;
    _faunaLog(`[${name}] ${cmd}`);
    const { stdout, stderr } = await execP(cmd, { cwd: FAUNA_APP_DIR, env: { ...process.env } });
    if (stdout) stdout.trim().split('\n').forEach(l => _faunaLog(l));
    if (stderr) stderr.trim().split('\n').forEach(l => _faunaLog(l));
  }

  (async () => {
    try {
      await phase('download',      'git fetch origin');
      await phase('extract',       'git reset --hard origin/HEAD');
      await phase('dependencies',  'npm install --prefer-offline');
      _faunaUpdateJob.phase    = 'complete';
      _faunaUpdateJob.running  = false;
      _faunaUpdateJob.message  = 'Update complete — restart Fauna to apply changes';
      _faunaLog('Done. Restart the app to use the new version.');
    } catch (err) {
      _faunaUpdateJob.phase   = 'error';
      _faunaUpdateJob.running = false;
      _faunaUpdateJob.error   = err.message;
      _faunaLog(`Install failed: ${err.message}`);
    }
  })();
});

// ── Markdown→PDF + YouTube thumbnail routes moved → server/routes/markdown-pdf-and-youtube.js ──
registerMarkdownPdfAndYoutubeRoutes(app, { express, getElectronBrowserWindow: () => _ElectronBrowserWindow });
// ── Auth / token resolution + model list moved to server/copilot/{auth,models}.js ──
// Auth check ────────────────────────────────────────────────────────────────
// ── /api/auth + /api/token routes moved → server/routes/auth.js ──
// ── Model list ────────────────────────────────────────────────────────────
//
// Use GitHub Copilot's /models endpoint directly (instead of the OpenAI SDK's
// models.list()) because the SDK strips out `capabilities` and
// `model_picker_enabled`, which are the official signals for "this model is a
// chat-completions model that VS Code's picker would show". Without those, we
// were exposing embeddings/responses-only/disabled models in the dropdown and
// users hit "model X is not accessible via the /chat/completions endpoint".

app.get('/api/models', async (req, res) => {
  try {
    const cfg     = readSavedConfig();
    const hasPat  = !!(cfg.pat && cfg.pat.trim());
    const token   = getGhToken();
    const r = await fetch('https://api.githubcopilot.com/models', {
      headers: {
        Authorization:            `Bearer ${token}`,
        'Editor-Version':         'vscode/1.85.0',
        'Copilot-Integration-Id': 'vscode-chat',
        Accept:                   'application/json'
      }
    });
    if (!r.ok) throw new Error(`models endpoint ${r.status}`);
    const body = await r.json();
    const raw  = Array.isArray(body.data) ? body.data : [];

    // When the user explicitly supplied a PAT we trust them and keep every
    // chat model the API exposes (skip the picker-only filter). When auth
    // comes from the CLI/keychain/env, narrow to picker-enabled models —
    // anything else triggers "model not available for integrator copilot-4-cli".
    const apiModels = raw
      .filter(m => {
        if (m?.capabilities?.type !== 'chat') return false;
        if (!hasPat && m.model_picker_enabled === false) return false;
        if (m.policy && m.policy.state && m.policy.state !== 'enabled') return false;
        return true;
      })
      .map(m => {
        const family = m.capabilities?.family || m.id || '';
        const vendor = m.vendor
          || (/claude/i.test(family)  ? 'Anthropic'
            : /gemini/i.test(family)  ? 'Google'
            : /minimax/i.test(family) ? 'Minimax'
            : /grok/i.test(family)    ? 'xAI'
            : 'OpenAI');
        return {
          id:     m.id,
          name:   m.name || m.id,
          vendor,
          fast:   /mini|haiku|flash|small|nano/i.test(m.id),
          vision: !!m.capabilities?.supports?.vision,
          tools:  !!m.capabilities?.supports?.tool_calls,
        };
      });

    // Only models the live Copilot API actually exposes for this account.
    // FALLBACK_MODELS is reserved for the offline/error path below.
    const models = apiModels.sort((a, b) =>
      (a.vendor || '').localeCompare(b.vendor || '') ||
      (a.name   || '').localeCompare(b.name   || '')
    );

    res.json({ models: models.length ? models : FALLBACK_MODELS });
  } catch (e) {
    res.json({ models: FALLBACK_MODELS });
  }
});

// ── Figma layout knowledge ───────────────────────────────────────────────
// Injected into the system prompt when Figma MCP is enabled.

// ── Gen-UI catalog prompt moved → server/prompts/gen-ui-catalog.js ─

// ── Browser panel + app building context ────────────────────────────────
// Always injected so the AI knows how to use the built-in browser.
const BROWSER_BUILD_CONTEXT = `
## Built-in Browser Panel

You have a built-in browser panel that runs inside the app. You can control it using \`\`\`browser-action code blocks.

### Web routing order
Before using browser-action or Playwright-style automation, choose the lowest-risk path that can satisfy the request:
1. If a real browser tab is connected/shared through FaunaMCP or the browser extension, use \`browser-ext-action\` to list/extract that tab first.
2. For simple read-only URL/page/article tasks, use the fetch/headless HTTP tools instead of opening a browser.
3. Use \`browser-action\` for user-visible pages, forms, clicks, screenshots, JS-heavy pages, blocked fetches, or debugging web apps.
4. Use Playwright MCP only when the user enabled Playwright MCP or explicitly needs Playwright-style automation/testing.

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

For simple navigate/extract tasks, temporary browser-panel tabs may close after the result is fed back to the conversation. If the page must stay open for follow-up browsing, include \`"keepOpen":true\` or \`"autoClose":false\` on the navigate action.

### Dev Server + Browser Debugging Workflow
When building a web app for the user, follow this workflow:
1. **Install ALL dependencies in one complete command** — never truncate \`npm install\`. Write the full package.json first, then run \`npm install\`.
2. **Start dev server in background** — use \`&\` or run it as a background process, then wait a moment
3. **Open in browser** — navigate to \`http://localhost:PORT\` in a new tab. Console errors/warnings from localhost pages are **automatically included** in the page extract — check them!
4. **Fix and iterate** — if there are errors, fix the code, navigate again or use console-logs to recheck
5. **Only report success after verifying** — don't tell the user it works until you've seen the page load without errors

### Critical Rules:
- **ZERO NARRATION before actions.** NEVER write text before a browser-action, browser-ext-action, or shell command block. No "Let me...", "I'll...", "I need to...", "Let me search...", "Let me use...", "I'll try...". Just emit the action block with nothing before it. This is the #1 rule — violating it wastes the user's time.
- **NEVER truncate shell commands or code blocks**. Write them fully in one go. Never stop mid-line or say "let me continue".
- **Batch browser actions** when possible. If you need to do multiple actions (e.g. eval + extract), emit them all in one fenced block as JSONL (one JSON object per line) instead of separate blocks.
- **Be silent DURING browser action sequences**. When you receive auto-fed browser results and need to do more actions, respond ONLY with the next action block — no commentary. But when you're DONE (no more actions needed), give the user a brief summary of what you accomplished and any relevant findings.
- **ALWAYS write complete files**. When creating a file, write ALL of it in one code block. Never split a file across multiple blocks.
- **ALWAYS write complete package.json** before running npm install — don't rely on incremental installs.
- **Use console-logs to debug** — after loading a page, check for errors before telling the user it's done.
- **If your output was cut off**, you will be automatically asked to continue. Just pick up exactly where you left off.
- The browser keeps login sessions across pages (cookies persist). No need to re-authenticate.
- Each conversation has its own browser tabs — they don't interfere with other conversations.
`;

// Wire smaller chat routes (debug-prompt / chat-summary / composition planner).
registerChatMiscRoutes(app, { browserBuildContext: BROWSER_BUILD_CONTEXT });

// ── Browser Extension (Fauna Web Extension) context ─────────────────────────
// Injected dynamically when at least one browser extension is connected.
// Documents the browser-ext-action code block syntax so the AI knows how to
// control the user's real Chrome/Edge/Firefox browser via the extension.
function buildBrowserExtContext() {
  const connected = extBridge.statusList();
  if (!connected.length) return '';
  const browserNames = [...new Set(connected.map(b => b.browser).filter(Boolean))];
  const browserLabel = browserNames.length ? browserNames.join(' and ') : 'browser';
  return `
## Fauna Web Extension — Controlling the User's Real ${browserLabel}

The user has the Fauna browser extension connected in their **real ${browserLabel}** (${connected.length} connection${connected.length > 1 ? 's' : ''}). You can control that browser directly using \`\`\`browser-ext-action code blocks.

**Use \`browser-ext-action\` (extension) instead of \`browser-action\` (built-in panel) when the user:**
- Wants to interact with their existing open tabs and real browser session
- Is already logged into sites you need to access
- Wants to scrape, automate, or control pages in their real browser
- Asks you to "use the extension", "use my browser", or mentions tabs/windows they have open

### Available browser-ext-action commands:

#### Page interaction
- **navigate** — \`{"action":"navigate","url":"..."}\` — navigate to a URL (auto-extracts after)
- **extract** — \`{"action":"extract"}\` — extract page text + links from active tab
- **extract-forms** — \`{"action":"extract-forms"}\` — extract all form fields with selectors
- **fill** — \`{"action":"fill","fields":[{"selector":"...","value":"..."}]}\` — fill form fields
- **click** — \`{"action":"click","selector":"..."}\` — click an element (auto-extracts after)
- **type** — \`{"action":"type","selector":"...","value":"..."}\` — type into an input (auto-extracts after)
- **hover** — \`{"action":"hover","selector":"..."}\` — hover over an element
- **scroll** — \`{"action":"scroll","selector":"...","direction":"down","amount":300}\` — scroll the page
- **drag** — \`{"action":"drag","from":"selector","to":"selector"}\` — drag and drop
- **select** — \`{"action":"select","selector":"...","value":"..."}\` — select an option
- **keyboard** — \`{"action":"keyboard","key":"Enter"}\` — press a keyboard key
- **wait** — \`{"action":"wait","ms":1500}\` — wait N milliseconds
- **eval** — \`{"action":"eval","js":"document.title"}\` — run JS in the real page, result fed to AI

#### Screenshots
- **snapshot** — \`{"action":"snapshot"}\` — screenshot the visible area (image injected into AI)
- **snapshot-full** — \`{"action":"snapshot-full"}\` — full-page screenshot

#### Tab management
- **tab:list** — \`{"action":"tab:list"}\` — list all open tabs (id, title, url, active)
- **tab:new** — \`{"action":"tab:new","url":"..."}\` — open a new tab
- **tab:switch** — \`{"action":"tab:switch","tabId":123}\` — switch to a tab by id (use tab:list first)
- **tab:close** — \`{"action":"tab:close","tabId":123}\` — close a tab
- **tab:info** — \`{"action":"tab:info"}\` — get info (url, title) of the active tab

### Rules for browser-ext-action:
- **ZERO NARRATION before action blocks** — emit the block immediately with no preamble.
- **Results are auto-fed back** — after navigate, click, type, scroll etc. the page state is automatically extracted and sent back to you. Wait for it before acting further.
- **Batch sequential actions** as JSONL (one JSON per line in a single block).
- **To target a specific tab**: use \`tab:list\` first to get the tab id, then pass \`"tabId": <id>\` in subsequent actions.
- **selector tips**: use CSS selectors; for forms prefer \`extract-forms\` first to get exact selectors.
- **snapshot** is useful when text extraction misses visual layout — request one to see the page.
`.trim();
}

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


// ── /api/chat moved → server/routes/chat.js ──

// ── Git routes + detectCommitConvention moved → server/routes/git.js ──

// ── Workspace Discovery (Feature C) ──────────────────────────────────────
// Scans a directory and returns project context (build commands, architecture, etc.)
// Core instruction-file helpers live in lib/instruction-files.js (imported above).

// ── Workspace discovery route moved → server/routes/workspace.js ──

// ── /api/chat/debug-prompt moved → server/routes/chat-misc.js ──

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

// ── Browser (Playwright) routes moved → server/bridges/playwright-browse.js ──
registerBrowseRoutes(app, { require: _require });

// ── Figma bridge moved → server/bridges/figma.js ──
// ── Custom MCP routes/state moved → server/bridges/custom-mcp.js ──
// Start trying to connect immediately when the server starts
// Also auto-start the MCP server if it's not already running
setTimeout(() => {
  figma.start();
  // Start custom MCP auto-detection
  customMcp.startAutoDetect();
  // Pre-warm Playwright MCP if available so it shows READY immediately
  playwrightMcp.prewarm().then(() => {
    console.log('[playwright-mcp] pre-warmed on startup');
  }).catch(() => {});
}, 500);  // slight delay so the main server is fully up first
// ── Figma plugin/status/rules routes moved → server/bridges/figma.js ──

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

// ── Workspace discovery routes moved → server/routes/workspace.js ──
registerWorkspaceRoutes(app, {
  augmentedPath: AUGMENTED_PATH,
  shellBin: SHELL_BIN,
  loadInstructionFiles,
  configDir: CONFIG_DIR,
});

// ── Git routes moved → server/routes/git.js ──
registerGitRoutes(app, { augmentedPath: AUGMENTED_PATH, shellBin: SHELL_BIN });

// ── Shell execution routes moved → server/routes/shell-exec.js ──
registerShellExecRoutes(app, {
  shellProcs: _shellProcs,
  augmentedPath: AUGMENTED_PATH,
  shellBin: SHELL_BIN,
  isWin: IS_WIN,
  getInternalAICaller: () => internalAICaller,
});

// ── Shell-permission / shell-exec / shell-kill moved → server/routes/shell-exec.js ──

// ── resolvePath moved → server/lib/write-helpers.js ──

registerUtilityRoutes(app, {
  fs,
  path,
  os,
  execSync,
  exec: _exec,
  requireElectron: _require,
  isWin: IS_WIN,
  rootDir: __dirname,
  resolvePath,
});
// ── Mutation helpers moved → server/lib/write-helpers.js ──
// ── File-mutation routes + AutoRecovery + read-file/read-image moved → server/routes/agent-sandbox-files.js ──
registerAgentSandboxFileRoutes(app);

// ── Agent System ──────────────────────────────────────────────────────────

// Primary agents dir: ~/.config/fauna/agents (matches documented path in capabilities.js)
const AGENTS_DIR = path.join(FAUNA_CONFIG_DIR, 'agents');
fs.mkdirSync(AGENTS_DIR, { recursive: true });

// Wire /api/store/* routes (needs AGENTS_DIR)
registerStoreRoutes(app, {
  express,
  agentsDir: AGENTS_DIR,
  storeBackendUrl: process.env.AGENT_STORE_URL || 'https://agentstore.pointlabel.com/api',
  builtinAgentNames: ['research', 'coder', 'writer', 'designer'],
});

// Wire main /api/chat streaming handler.
// Late-bound deps (playwright client, _ElectronBrowserWindow) are passed via
// closures so they resolve at request time, after module init completes.
const playwrightMcp = registerPlaywrightMcpRoutes(app, {
  express,
  require: _require,
  findNodeBinary,
  isWin: IS_WIN,
});
registerChatRoute(app, {
  figma,
  agentsDir: AGENTS_DIR,
  browserBuildContext: BROWSER_BUILD_CONTEXT,
  buildBrowserExtContext: () => buildBrowserExtContext(),
  psAcquire: () => _psAcquire(),
  psRelease: () => _psRelease(),
  setActiveModel: (m) => { _activeModel = m; },
  getMainWindows: () => (_ElectronBrowserWindow?.getAllWindows?.() || []),
  sendNotification: (title, body) => {
    try {
      const { Notification: ElectronNotification } = _require('electron');
      new ElectronNotification({ title, body }).show();
    } catch (_) {
      console.log(`[notification] ${title}: ${body}`);
    }
  },
  callPlaywrightMcpTool: (tool, args) => playwrightMcp.callTool(tool, args),
  resetPlaywrightMcpClient: () => playwrightMcp.reset(),
});
// Legacy agents dir: ~/.config/copilot-chat/agents (kept for backward compatibility)
const LEGACY_AGENTS_DIR = path.join(CONFIG_DIR, 'agents');

// Project-local agents folder (version-controlled alongside the app source)
const LOCAL_AGENTS_DIR = path.join(path.dirname(new URL(import.meta.url).pathname), 'agents');

const iterAgentDirs = createAgentDirIterator({ agentsDir: AGENTS_DIR, legacyAgentsDir: LEGACY_AGENTS_DIR, localAgentsDir: LOCAL_AGENTS_DIR });

// ── Agent management routes moved → server/routes/agents.js ──
registerAgentRoutes(app, { express, agentsDir: AGENTS_DIR, iterAgentDirs, builtinAgentNames: ['research', 'coder', 'writer', 'designer'] });
// ── Agent Builder routes moved → server/routes/agent-builder.js ──
registerAgentBuilderRoutes(app, { agentsDir: AGENTS_DIR });

// ── Agent store routes (proxy + sync + admin + notifications) moved → server/routes/store.js ──

// ── Agent sandbox routes moved → server/routes/agent-sandbox.js ──
{
  const { getAgentManifest } = registerAgentSandboxRoutes(app, { agentsDir: AGENTS_DIR, validateExternalUrl });
  _setAgentManifestGetter(getAgentManifest);
}

// ── Desktop organizer route moved → server/routes/desktop-organizer.js ──
registerDesktopOrganizerRoutes(app);
// ── System context route moved → server/routes/system-context.js ──
registerSystemContextRoutes(app, { isWin: IS_WIN, shellBin: SHELL_BIN, agentsDir: AGENTS_DIR, getGhToken, getSystemPreferences: () => systemPreferences });
// ── macOS Permissions routes moved → server/routes/permissions.js ──
registerPermissionsRoutes(app, { isWin: IS_WIN, getGhToken, getSystemPreferences: () => systemPreferences, getDesktopCapturer: () => desktopCapturer });
// ── Memory / Preferences / Facts ──────────────────────────────────────────
const { loadPrefs } = registerMemoryPrefsFactsRoutes(app, { configDir: CONFIG_DIR });

const teamsBundle = createTeamsBundle({
  iterAgentDirs: () => iterAgentDirs(),
  loadPrefs,
  getInternalAICaller: () => internalAICaller,
  getDesktopCapturer: () => desktopCapturer,
  getActiveModel: () => _activeModel,
  teamsRelaySecret: process.env.FAUNA_TEAMS_SECRET || '',
});
// ── Heartbeat + Workflows + Permission Guard routes moved → server/routes/scheduling-and-guard.js ──
registerSchedulingAndGuardRoutes(app);

// ── Teams routes moved → server/routes/teams.js ──
teamsBundle.registerRoutes(app);

// Trigger Accessibility permission prompt
app.post('/api/permissions/request-accessibility', (req, res) => {
  try {
    const trusted = systemPreferences?.isTrustedAccessibilityClient?.(true); // true = show prompt
    res.json({ status: trusted ? 'granted' : 'denied' });
  } catch (e) {
    res.json({ status: 'denied', error: e.message });
  }
});

// ── Region capture + Shell stdin routes moved → server/routes/region-and-stdin.js ──
registerRegionAndStdinRoutes(app, { require: _require, appDir: __dirname, getElectronBrowserWindow: () => _ElectronBrowserWindow, getDesktopCapturer: () => desktopCapturer, shellProcs: _shellProcs });
// ── Whisper voice transcription moved → server/routes/whisper.js ──
registerWhisperRoutes(app, { express, faunaConfigDir: FAUNA_CONFIG_DIR, augmentedPath: AUGMENTED_PATH, appDir: __dirname });
// ── Document/attachment + browser-ext routes moved → server/routes/docs-and-ext.js ──
registerDocsAndExtRoutes(app, { faunaConfigDir: FAUNA_CONFIG_DIR, appDir: __dirname });
// ── Playwright MCP routes moved → server/routes/playwright-mcp.js ──
registerProjectRunRoutes(app, {
  express,
  fs,
  path,
  os,
  spawn,
  getProject,
  shellBin: SHELL_BIN,
  isWin: IS_WIN,
  augmentedPath: AUGMENTED_PATH,
});

// ── Teams Relay WebSocket moved → server/routes/teams.js ──

// ── Start ─────────────────────────────────────────────────────────────────

export function startServer(port) {
  return new Promise((resolve, reject) => {
    const server = app.listen(port, '0.0.0.0', () => {
      console.log(`\n  ✦ Copilot Chat  →  http://127.0.0.1:${port}\n`);
      resolve(server);
    });
    extBridge.attach(server);
    teamsBundle.attachRelay(server);
    startScheduler(task => {
      runTask(task.id, { trigger: 'scheduler' }).catch(e => console.error('[tasks] scheduled run failed:', e.message));
    });
    // Run fact memory decay on startup (prune facts not accessed in 60 days)
    try { runDecay(); } catch (_) {}

    // Internal AI caller for heartbeat and workflows — defaults to active conversation model
    internalAICaller = async (prompt, model) => {
      const useModel = model || _activeModel || 'gpt-4.1';
      const client = getCopilotClient();
      const callModel = async (m) => {
        const resp = await client.chat.completions.create({
          model: m,
          messages: [{ role: 'user', content: prompt }],
          max_tokens: 2000,
        });
        return resp.choices[0]?.message?.content?.trim() || '';
      };
      try {
        return await callModel(useModel);
      } catch (e) {
        // If model not supported, retry with fallback
        if (e.status === 400 && useModel !== _activeModel && _activeModel) {
          console.log(`[ai-caller] model "${useModel}" not supported, falling back to "${_activeModel}"`);
          return await callModel(_activeModel);
        }
        if (e.status === 400 && useModel !== 'gpt-4.1') {
          console.log(`[ai-caller] model "${useModel}" not supported, falling back to "gpt-4.1"`);
          return await callModel('gpt-4.1');
        }
        throw e;
      }
    };
    const internalNotifier = (title, body) => {
      try {
        const { Notification: ElectronNotification } = _require('electron');
        new ElectronNotification({ title, body }).show();
      } catch (_) {
        console.log(`[notification] ${title}: ${body}`);
      }
    };

    // Start heartbeat and workflow timers
    startHeartbeat(internalAICaller, internalNotifier);
    startWorkflowTimer(internalAICaller, internalNotifier);
    startTeamsBridge(internalAICaller, internalNotifier);
    initBotManager();
    server.on('error', reject);

    // Clean up MCP child process and Figma timers on exit
    function fullCleanup() {
      // Figma bridge: cancel reconnect, close WS, kill MCP child
      figma.cleanup();
      // Stop custom MCP auto-detection polling + kill processes
      customMcp.cleanup();
      // Kill MCP child
      stopScheduler();
    }
    process.on('exit',    () => fullCleanup());
    process.on('SIGTERM', () => { fullCleanup(); process.exit(0); });
    process.on('SIGINT',  () => { fullCleanup(); process.exit(0); });
  });
}

export { app };
