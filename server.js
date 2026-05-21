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
import { marked }  from 'marked';

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

// ── Markdown → PDF ───────────────────────────────────────────────────────
function _markdownToPdfHtml(markdown) {
  // Pre-process mermaid blocks so marked doesn't swallow them or truncate the document.
  // marked treats unclosed/unknown fences as raw code, causing everything after to not render.
  let mdClean = markdown;
  const mermaidSections = [];
  mdClean = mdClean.replace(/```mermaid\n([\s\S]*?)```/g, (_m, code) => {
    const i = mermaidSections.length;
    mermaidSections.push(code.trim());
    return `\`\`\`\nmermaid diagram (section ${i + 1})\n\`\`\``;
  });
  mdClean = mdClean.replace(/```mermaid\n([\s\S]*)$/, (_m, code) => {
    const i = mermaidSections.length;
    mermaidSections.push(code.trim());
    return `\`\`\`\nmermaid diagram (section ${i + 1})\n\`\`\``;
  });

  const htmlBody = marked(mdClean);
  return `<!DOCTYPE html><html><head><meta charset="utf-8">
<style>
body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;font-size:13px;line-height:1.6;color:#1a1a1a;max-width:800px;margin:40px auto;padding:0 40px}
h1,h2,h3,h4{margin-top:1.4em;margin-bottom:.4em}h1{font-size:2em;border-bottom:2px solid #e0e0e0;padding-bottom:.3em}h2{font-size:1.5em;border-bottom:1px solid #e8e8e8;padding-bottom:.2em}
code{background:#f5f5f5;padding:2px 5px;border-radius:3px;font-size:.9em}
pre{background:#f5f5f5;padding:14px;border-radius:6px;overflow:auto}pre code{background:none;padding:0}
table{border-collapse:collapse;width:100%}th,td{border:1px solid #ddd;padding:8px 12px;text-align:left}th{background:#f0f0f0}
blockquote{border-left:4px solid #ccc;margin:0;padding:0 1em;color:#666}
</style></head><body>${htmlBody}</body></html>`;
}

async function _writePdfWithElectron(fullHtml, absPath, pageSize, landscape) {
  if (!_ElectronBrowserWindow) throw new Error('Electron BrowserWindow is not available');
  let win;
  try {
    win = new _ElectronBrowserWindow({ show: false, webPreferences: { offscreen: true } });
    await win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(fullHtml));
    await new Promise(r => setTimeout(r, 200));
    const pdfBuffer = await win.webContents.printToPDF({
      pageSize,
      landscape,
      printBackground: true,
      margins: { marginType: 'custom', top: 0.4, bottom: 0.4, left: 0.5, right: 0.5 },
    });
    fs.mkdirSync(path.dirname(absPath), { recursive: true });
    fs.writeFileSync(absPath, pdfBuffer);
    return pdfBuffer.length;
  } finally {
    try { win && win.destroy(); } catch (_) {}
  }
}

async function _writePdfWithPlaywright(fullHtml, absPath, pageSize, landscape) {
  const pw = await import('playwright-core');
  const chromium = pw.chromium || pw.default?.chromium;
  if (!chromium) throw new Error('playwright-core loaded but chromium not found');
  const _EDGE_PATH   = '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge';
  const _CHROME_PATH = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
  const BROWSER_PATH = fs.existsSync(_EDGE_PATH) ? _EDGE_PATH : _CHROME_PATH;
  if (!fs.existsSync(BROWSER_PATH)) throw new Error('No supported Chrome/Edge executable found for PDF generation');
  const browser = await chromium.launch({
    executablePath: BROWSER_PATH,
    headless: true,
    args: ['--no-sandbox', '--disable-dev-shm-usage'],
  });
  try {
    const page = await browser.newPage();
    await page.setContent(fullHtml, { waitUntil: 'load' });
    await page.pdf({
      path: absPath,
      format: pageSize,
      landscape,
      printBackground: true,
      margin: { top: '0.4in', bottom: '0.4in', left: '0.5in', right: '0.5in' },
    });
    const stat = fs.statSync(absPath);
    return stat.size;
  } finally {
    await browser.close().catch(() => {});
  }
}

app.post('/api/markdown-to-pdf', express.json({ limit: '10mb' }), async (req, res) => {
  let { markdown, markdownPath, outputPath, pageSize = 'A4', landscape = false } = req.body || {};
  if (!markdown && markdownPath) {
    const absMarkdownPath = path.resolve(markdownPath);
    try { markdown = fs.readFileSync(absMarkdownPath, 'utf8'); }
    catch (err) { return res.status(400).json({ ok: false, error: 'failed to read markdownPath: ' + err.message }); }
  }
  if (!markdown) return res.status(400).json({ error: 'markdown is required' });
  if (!outputPath) return res.status(400).json({ error: 'outputPath is required' });
  const absPath = path.resolve(outputPath);
  const fullHtml = _markdownToPdfHtml(markdown);
  try {
    fs.mkdirSync(path.dirname(absPath), { recursive: true });
    const bytes = _ElectronBrowserWindow
      ? await _writePdfWithElectron(fullHtml, absPath, pageSize, landscape)
      : await _writePdfWithPlaywright(fullHtml, absPath, pageSize, landscape);
    if (!fs.existsSync(absPath) || fs.statSync(absPath).size <= 0) throw new Error('PDF file was not created');
    res.json({ ok: true, path: absPath, bytes });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

const YOUTUBE_THUMB_FALLBACK_SVG = Buffer.from(`
<svg xmlns="http://www.w3.org/2000/svg" width="480" height="360" viewBox="0 0 480 360">
  <rect width="480" height="360" rx="28" fill="#f4f4f5"/>
  <rect x="176" y="130" width="128" height="100" rx="22" fill="#d4d4d8"/>
  <path d="M226 156l54 24-54 24z" fill="#71717a"/>
</svg>
`.trim());
const youtubeThumbnailCache = new Map();

function _isPlaceholderYouTubeId(id) {
  const raw = String(id || '').trim().toLowerCase();
  return !raw || /(^|[\/_=-])(placeholder|sample|example|dummy|todo|tbd)([\/?&#._-]|$)/.test(raw) ||
         /^0{6,}$/.test(raw) || raw === 'aaaaaaaaaaa' || raw === '-----------' || raw === '___________';
}

function _isValidYouTubeId(id) {
  return /^[A-Za-z0-9_-]{11}$/.test(String(id || '')) && !_isPlaceholderYouTubeId(id);
}

function _sendYoutubeFallbackThumbnail(res) {
  res.setHeader('Content-Type', 'image/svg+xml; charset=utf-8');
  res.setHeader('Cache-Control', 'public, max-age=3600');
  res.status(200).send(YOUTUBE_THUMB_FALLBACK_SVG);
}

app.get('/api/youtube-thumbnail', async (req, res) => {
  const id = String(req.query.id || '').trim();
  if (!_isValidYouTubeId(id)) return _sendYoutubeFallbackThumbnail(res);

  const cached = youtubeThumbnailCache.get(id);
  if (cached) {
    res.setHeader('Content-Type', cached.contentType);
    res.setHeader('Cache-Control', 'public, max-age=86400');
    return res.status(200).send(cached.body);
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 6000);
  try {
    const upstream = await fetch(`https://i.ytimg.com/vi/${encodeURIComponent(id)}/hqdefault.jpg`, {
      signal: controller.signal,
      redirect: 'follow',
      headers: { 'User-Agent': 'Fauna/1.0 thumbnail-proxy' },
    });
    const contentType = upstream.headers.get('content-type') || 'image/jpeg';
    if (!upstream.ok || !/^image\//i.test(contentType)) return _sendYoutubeFallbackThumbnail(res);
    const body = Buffer.from(await upstream.arrayBuffer());
    if (body.length < 2048) return _sendYoutubeFallbackThumbnail(res);
    youtubeThumbnailCache.set(id, { contentType, body });
    res.setHeader('Content-Type', contentType);
    res.setHeader('Cache-Control', 'public, max-age=86400');
    return res.status(200).send(body);
  } catch (_) {
    return _sendYoutubeFallbackThumbnail(res);
  } finally {
    clearTimeout(timer);
  }
});

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
  (async () => {
    try {
      await import('@playwright/mcp');
      _playwrightMcpInstalled = true;
      await _getPlaywrightMcpClient();
      console.log('[playwright-mcp] pre-warmed on startup');
    } catch (_) {}
  })();
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
  callPlaywrightMcpTool: (tool, args) => _callPlaywrightMcpTool(tool, args),
  resetPlaywrightMcpClient: () => { _playwrightMcpClient = null; _playwrightMcpClientPromise = null; },
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
const PREFS_FILE  = path.join(CONFIG_DIR, 'preferences.json');

function loadPrefs() {
  try { return JSON.parse(fs.readFileSync(PREFS_FILE, 'utf8')); }
  catch (_) { return { playbook: [], agentRules: [], systemPrompt: '' }; }
}
function savePrefs(patch) {
  const current = loadPrefs();
  fs.writeFileSync(PREFS_FILE, JSON.stringify({ ...current, ...patch }, null, 2));
}

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

// ── Preferences (playbook + agent rules + system prompt) ──────────────────
app.get('/api/preferences', (req, res) => {
  res.json(loadPrefs());
});

app.put('/api/preferences', (req, res) => {
  const patch = req.body;
  if (!patch || typeof patch !== 'object' || Array.isArray(patch))
    return res.status(400).json({ error: 'Expected object' });
  savePrefs(patch);
  res.json({ ok: true });
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

// ── Structured Facts Memory ───────────────────────────────────────────────
// Individual facts the AI learns about the user, with decay and recall scoring.

app.get('/api/facts', (req, res) => {
  const category = req.query.category || null;
  res.json(listFacts(category));
});

app.get('/api/facts/stats', (req, res) => {
  res.json(factsGetStats());
});

app.post('/api/facts', (req, res) => {
  const { text, category } = req.body || {};
  const result = factsRemember(text, category);
  if (!result.ok) return res.status(400).json(result);
  res.json(result);
});

app.post('/api/facts/recall', (req, res) => {
  const { keywords } = req.body || {};
  const results = factsRecall(keywords);
  res.json(results);
});

app.delete('/api/facts/:id', (req, res) => {
  const result = factsForget(req.params.id);
  if (!result.ok) return res.status(404).json(result);
  res.json(result);
});

app.post('/api/facts/decay', (req, res) => {
  const maxAgeDays = req.body?.maxAgeDays || undefined;
  const result = runDecay(maxAgeDays);
  res.json(result);
});

app.get('/api/facts/export', (req, res) => {
  res.json(exportFacts());
});

app.post('/api/facts/import', (req, res) => {
  const facts = req.body;
  if (!Array.isArray(facts)) return res.status(400).json({ error: 'Expected array of facts' });
  const result = importFacts(facts);
  if (!result.ok) return res.status(400).json(result);
  res.json(result);
});

// ── Heartbeat Monitoring ──────────────────────────────────────────────────

app.get('/api/heartbeat/settings', (req, res) => {
  res.json(hbGetSettings());
});

app.put('/api/heartbeat/settings', (req, res) => {
  const settings = hbUpdateSettings(req.body);
  res.json(settings);
});

app.get('/api/heartbeat/log', (req, res) => {
  res.json(hbGetLog());
});

app.post('/api/heartbeat/clear-log', (req, res) => {
  hbClearLog();
  res.json({ ok: true });
});

app.post('/api/heartbeat/run-now', async (req, res) => {
  try {
    const result = await runHeartbeat(true);
    res.json(result);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── Scheduled Workflows ───────────────────────────────────────────────────

app.get('/api/workflows', (req, res) => {
  res.json(getAllWorkflows());
});

app.post('/api/workflows', (req, res) => {
  const wf = createWorkflow(req.body);
  res.json(wf);
});

app.get('/api/workflows/:id', (req, res) => {
  const wf = getWorkflow(req.params.id);
  if (!wf) return res.status(404).json({ error: 'Workflow not found' });
  res.json(wf);
});

app.put('/api/workflows/:id', (req, res) => {
  const wf = updateWorkflow(req.params.id, req.body);
  if (!wf) return res.status(404).json({ error: 'Workflow not found' });
  res.json(wf);
});

app.delete('/api/workflows/:id', (req, res) => {
  const ok = deleteWorkflow(req.params.id);
  if (!ok) return res.status(404).json({ error: 'Workflow not found' });
  res.json({ ok: true });
});

app.post('/api/workflows/:id/run-now', async (req, res) => {
  try {
    const result = await runWorkflow(req.params.id);
    res.json(result);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/workflows/:id/history', (req, res) => {
  res.json(wfGetHistory(req.params.id));
});

app.post('/api/workflows/parse-schedule', (req, res) => {
  const { text } = req.body || {};
  res.json(parseSchedule(text));
});

// ── Permission Guard ──────────────────────────────────────────────────────

app.get('/api/permissions/auto-allow', (req, res) => {
  res.json(getAutoAllowList());
});

app.post('/api/permissions/auto-allow', (req, res) => {
  const { command } = req.body || {};
  if (!command) return res.status(400).json({ error: 'command required' });
  addAutoAllow(command);
  res.json({ ok: true });
});

app.delete('/api/permissions/auto-allow', (req, res) => {
  const { command } = req.body || {};
  if (command) removeAutoAllow(command);
  else clearAutoAllow();
  res.json({ ok: true });
});

app.post('/api/permissions/check', (req, res) => {
  const { command } = req.body || {};
  res.json({ safe: isCommandSafe(command) });
});

// ── Teams Self-Chat Bridge ────────────────────────────────────────────────

app.get('/api/teams/settings', (req, res) => {
  res.json(getTeamsSettings());
});

app.put('/api/teams/settings', (req, res) => {
  const settings = updateTeamsSettings(req.body);
  res.json(settings);
});

app.post('/api/teams/test', async (req, res) => {
  try {
    const result = await teamsTestConnection();
    res.json(result);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── Teams Bot Server management ──────────────────────────────────────────
app.get('/api/teams-bot/config', (req, res) => res.json(getBotConfig()));

app.put('/api/teams-bot/config', (req, res) => res.json(updateBotConfig(req.body)));

app.get('/api/teams-bot/status', (req, res) => res.json(getBotStatus()));

app.post('/api/teams-bot/start', (req, res) => {
  if (req.body && Object.keys(req.body).length) updateBotConfig(req.body);
  res.json(startBot());
});

app.post('/api/teams-bot/stop', (req, res) => res.json(stopBot()));

// Trigger Accessibility permission prompt
app.post('/api/permissions/request-accessibility', (req, res) => {
  try {
    const trusted = systemPreferences?.isTrustedAccessibilityClient?.(true); // true = show prompt
    res.json({ status: trusted ? 'granted' : 'denied' });
  } catch (e) {
    res.json({ status: 'denied', error: e.message });
  }
});

// ── Region capture ────────────────────────────────────────────────────────
app.post('/api/capture-region', async (req, res) => {
  try {
    if (!_ElectronBrowserWindow || !desktopCapturer) {
      return res.status(503).json({ error: 'Capture requires Electron' });
    }
    const { screen, ipcMain } = _require('electron');
    const primaryDisplay = screen.getPrimaryDisplay();
    const { width, height } = primaryDisplay.size;
    const scaleFactor = primaryDisplay.scaleFactor;

    // Hide main window briefly
    const wins = _ElectronBrowserWindow.getAllWindows();
    const mainWin = wins.find(w => !w.isDestroyed() && w.getTitle() !== 'Region Capture');
    const wasVisible = mainWin?.isVisible();
    if (wasVisible) mainWin.hide();
    await new Promise(r => setTimeout(r, 200));

    // Full-screen capture
    const sources = await desktopCapturer.getSources({
      types: ['screen'],
      thumbnailSize: { width: width * scaleFactor, height: height * scaleFactor },
    });
    if (!sources.length) {
      if (wasVisible) mainWin.show();
      return res.json({ cancelled: true, error: 'No screen source found' });
    }
    const fullScreenshot = sources[0].thumbnail;

    // Overlay for region selection
    const overlay = new _ElectronBrowserWindow({
      x: 0, y: 0, width, height,
      frame: false, transparent: true, alwaysOnTop: true,
      fullscreen: true, skipTaskbar: true, resizable: false, hasShadow: false,
      title: 'Region Capture',
      webPreferences: { nodeIntegration: true, contextIsolation: false },
    });
    const overlayPath = path.join(__dirname, 'public', 'capture-overlay.html');
    await overlay.loadFile(overlayPath);
    overlay.webContents.send('set-screenshot', fullScreenshot.toDataURL());

    const captureResult = await new Promise((resolve) => {
      ipcMain.once('capture-region-result', (_event, rect) => {
        overlay.close();
        if (wasVisible) mainWin.show();
        if (!rect) return resolve({ cancelled: true });
        const cropRect = {
          x: Math.round(rect.x * scaleFactor),
          y: Math.round(rect.y * scaleFactor),
          width: Math.round(rect.width * scaleFactor),
          height: Math.round(rect.height * scaleFactor),
        };
        const cropped = fullScreenshot.crop(cropRect);
        const base64 = cropped.toDataURL().replace(/^data:image\/png;base64,/, '');
        resolve({ base64, width: rect.width, height: rect.height });
      });
      overlay.webContents.on('before-input-event', (_event, input) => {
        if (input.key === 'Escape') ipcMain.emit('capture-region-result', null, null);
      });
    });
    res.json(captureResult);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── Shell stdin ───────────────────────────────────────────────────────────
// POST { killId, input } → writes input to a running streaming shell process
app.post('/api/shell-stdin', (req, res) => {
  const { killId, input } = req.body || {};
  if (!killId) return res.status(400).json({ error: 'killId required' });
  const child = _shellProcs.get(killId);
  if (!child) return res.status(404).json({ error: 'process not found' });
  try {
    if (child.stdin && !child.stdin.destroyed) {
      child.stdin.write((input || '') + '\n');
      res.json({ ok: true });
    } else {
      res.status(409).json({ error: 'stdin not available for this process' });
    }
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── Whisper voice transcription ───────────────────────────────────────────
// Model lives at ~/.config/fauna/whisper/ggml-base.en.bin (downloaded on first use)
const WHISPER_MODEL_DIR  = path.join(FAUNA_CONFIG_DIR, 'whisper');
const WHISPER_MODEL_FILE = path.join(WHISPER_MODEL_DIR, 'ggml-base.en.bin');
const WHISPER_MODEL_URL  = 'https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-base.en.bin';

app.get('/api/whisper-model-status', (_req, res) => {
  const ready = fs.existsSync(WHISPER_MODEL_FILE);
  const size  = ready ? (() => { try { return fs.statSync(WHISPER_MODEL_FILE).size; } catch (_) { return 0; } })() : 0;
  res.json({ ready, modelPath: WHISPER_MODEL_FILE, size });
});

// SSE endpoint — download model and stream progress
app.get('/api/whisper-model-download', (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders?.();

  function send(obj) { res.write(`data: ${JSON.stringify(obj)}\n\n`); }

  if (fs.existsSync(WHISPER_MODEL_FILE)) {
    send({ pct: 100, ready: true });
    return res.end();
  }

  fs.mkdirSync(WHISPER_MODEL_DIR, { recursive: true });
  const tmpFile = WHISPER_MODEL_FILE + '.tmp';

  // Use curl for download — reliable progress on macOS
  const dl = spawn('curl', ['-L', '--progress-bar', '-o', tmpFile, WHISPER_MODEL_URL], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  let lastPct = 0;
  dl.stderr.on('data', chunk => {
    const str = chunk.toString();
    const m = str.match(/(\d+(?:\.\d+)?)%/);
    if (m) {
      const pct = Math.round(parseFloat(m[1]));
      if (pct !== lastPct) { lastPct = pct; send({ pct }); }
    }
  });

  dl.on('close', code => {
    if (code === 0 && fs.existsSync(tmpFile)) {
      fs.renameSync(tmpFile, WHISPER_MODEL_FILE);
      send({ pct: 100, ready: true });
    } else {
      try { fs.unlinkSync(tmpFile); } catch (_) {}
      send({ error: 'Download failed (exit ' + code + ')' });
    }
    res.end();
  });

  req.on('close', () => { try { dl.kill(); } catch (_) {} });
});

// POST /api/transcribe — audio blob body → { ok, text }
// Uses nodejs-whisper (ships whisper.cpp binary in node_modules)
app.post('/api/transcribe', express.raw({ type: ['audio/*', 'application/octet-stream'], limit: '25mb' }), async (req, res) => {
  if (!fs.existsSync(WHISPER_MODEL_FILE)) {
    return res.status(503).json({ ok: false, error: 'Whisper model not downloaded yet' });
  }
  if (!req.body || req.body.length === 0) {
    return res.status(400).json({ ok: false, error: 'Empty audio body' });
  }
  const ts     = Date.now();
  const ctHeader = req.headers['content-type'] || '';
  const ext = ctHeader.includes('ogg') ? 'ogg' : ctHeader.includes('mp4') ? 'mp4' : 'webm';
  const tmpIn  = path.join(os.tmpdir(), `fauna_voice_${ts}.${ext}`);
  const tmpWav = path.join(os.tmpdir(), `fauna_voice_${ts}.wav`);
  try {
    fs.writeFileSync(tmpIn, req.body);
    console.log('[transcribe] wrote', req.body.length, 'bytes to', tmpIn, '(content-type:', ctHeader, ')');
    // Verify webm magic bytes (first 4 bytes should be 0x1A45DFA3 for EBML)
    if (ext === 'webm' && req.body.length >= 4) {
      const magic = req.body.readUInt32BE(0);
      if (magic !== 0x1A45DFA3) {
        console.warn('[transcribe] WARNING: webm magic mismatch, got 0x' + magic.toString(16) + ' — may not be valid webm');
      }
    }
    // Prefer the bundled static ffmpeg (no system lib deps); fall back to PATH
    let ffmpegBin;
    {
      let staticPath = null;
      // Strategy 1: process.resourcesPath (most reliable in packed Electron)
      if (!staticPath && process.resourcesPath) {
        const p = path.join(process.resourcesPath, 'app.asar.unpacked', 'node_modules', 'ffmpeg-static', 'ffmpeg');
        if (fs.existsSync(p)) staticPath = p;
      }
      // Strategy 2: require('ffmpeg-static') with asar path fix
      if (!staticPath) {
        try {
          const pkg = require('ffmpeg-static');
          if (pkg) {
            const fixed = pkg.replace(/app\.asar(?!\.unpacked)/, 'app.asar.unpacked');
            if (fs.existsSync(fixed)) staticPath = fixed;
          }
        } catch (_) {}
      }
      // Strategy 3: relative to __dirname (dev mode)
      if (!staticPath) {
        const p = path.join(__dirname, 'node_modules', 'ffmpeg-static', 'ffmpeg');
        if (fs.existsSync(p)) staticPath = p;
      }
      ffmpegBin = staticPath || 'ffmpeg';
      if (!staticPath) console.error('[transcribe] WARNING: ffmpeg-static not found, falling back to system ffmpeg');
      else console.log('[transcribe] using ffmpeg:', staticPath);
    }
    // Determine input format from Content-Type header
    const ct = req.headers['content-type'] || '';
    const inputFmt = ct.includes('ogg') ? 'ogg' : ct.includes('mp4') ? 'mp4' : 'webm';

    // Try ffmpeg conversion with multiple strategies
    const tryFfmpeg = (args, useStdin) => new Promise((resolve, reject) => {
      let rejected = false;
      const fail = (err) => { if (!rejected) { rejected = true; reject(err); } };
      let ffStderr = '';
      const ff = spawn(ffmpegBin, args, {
        stdio: [useStdin ? 'pipe' : 'ignore', 'pipe', 'pipe'],
        env: { ...process.env, PATH: AUGMENTED_PATH },
      });
      if (useStdin) {
        ff.stdin.on('error', () => {}); // suppress EPIPE if ffmpeg closes stdin early
        ff.stdin.write(req.body);
        ff.stdin.end();
      }
      ff.stdout.on('data', () => {}); // drain stdout
      ff.stderr.on('data', chunk => { ffStderr += chunk.toString(); });
      ff.on('close', (code, signal) => {
        if (code === 0) return resolve();
        const detail = ffStderr.trim().split('\n').pop() || '';
        fail(new Error(`ffmpeg exit ${code ?? ('signal:' + signal)}: ${detail}`));
      });
      ff.on('error', err => fail(new Error('ffmpeg spawn error: ' + err.message)));
    });

    let ffOk = false;
    // Strategy 1: explicit input format from file
    try {
      await tryFfmpeg(['-y', '-loglevel', 'error', '-f', inputFmt, '-i', tmpIn, '-ar', '16000', '-ac', '1', '-f', 'wav', tmpWav], false);
      ffOk = true;
    } catch (e1) {
      console.warn('[transcribe] ffmpeg strategy 1 failed:', e1.message);
      // Strategy 2: let ffmpeg probe the file (no -f)
      try {
        await tryFfmpeg(['-y', '-loglevel', 'error', '-i', tmpIn, '-ar', '16000', '-ac', '1', '-f', 'wav', tmpWav], false);
        ffOk = true;
      } catch (e2) {
        console.warn('[transcribe] ffmpeg strategy 2 failed:', e2.message);
        // Strategy 3: pipe via stdin with explicit format
        try {
          await tryFfmpeg(['-y', '-loglevel', 'error', '-f', inputFmt, '-i', 'pipe:0', '-ar', '16000', '-ac', '1', '-f', 'wav', tmpWav], true);
          ffOk = true;
        } catch (e3) {
          console.error('[transcribe] all ffmpeg strategies failed:', e3.message);
          throw new Error(`ffmpeg failed (exit 1). ${e3.message}`);
        }
      }
    }
    // Run whisper-cli directly (bypasses nodejs-whisper JS wrapper which breaks inside asar)
    let whisperBin = null;
    {
      const relBin = path.join('node_modules', 'nodejs-whisper', 'cpp', 'whisper.cpp', 'build', 'bin', 'whisper-cli');
      // Strategy 1: unpacked in Electron resources
      if (process.resourcesPath) {
        const p = path.join(process.resourcesPath, 'app.asar.unpacked', relBin);
        if (fs.existsSync(p)) whisperBin = p;
      }
      // Strategy 2: dev mode (__dirname)
      if (!whisperBin) {
        const p = path.join(__dirname, relBin);
        if (fs.existsSync(p)) whisperBin = p;
      }
      if (!whisperBin) throw new Error('whisper-cli binary not found');
    }
    const text = await new Promise((resolve, reject) => {
      let stdout = '';
      let stderr = '';
      const wp = spawn(whisperBin, [
        '-m', WHISPER_MODEL_FILE,
        '-f', tmpWav,
        '-l', 'en',
        '-otxt',
        '--no-prints',
      ], { stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, PATH: AUGMENTED_PATH } });
      wp.stdout.on('data', d => { stdout += d.toString(); });
      wp.stderr.on('data', d => { stderr += d.toString(); });
      wp.on('close', code => {
        if (code !== 0) return reject(new Error(`whisper-cli exited ${code}: ${stderr.trim()}`));
        // whisper-cli with -otxt writes to <input>.txt
        const txtFile = tmpWav + '.txt';
        if (fs.existsSync(txtFile)) {
          const t = fs.readFileSync(txtFile, 'utf8').trim();
          try { fs.unlinkSync(txtFile); } catch (_) {}
          resolve(t);
        } else {
          resolve(stdout.trim());
        }
      });
      wp.on('error', err => reject(new Error('whisper-cli spawn error: ' + err.message)));
    });
    res.json({ ok: true, text });
  } catch (e) {
    const body = { ok: false, error: e.message };
    if (e.code) body.code = e.code;
    res.status(500).json(body);
  } finally {
    try { fs.unlinkSync(tmpIn); } catch (_) {}
    try { fs.unlinkSync(tmpWav); } catch (_) {}
  }
});

// SSE: repair broken system ffmpeg via brew reinstall
// GET /api/repair-ffmpeg → streams { line } then { done } or { error }
app.get('/api/repair-ffmpeg', (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders?.();
  const send = (obj) => res.write(`data: ${JSON.stringify(obj)}\n\n`);
  // Locate brew
  const brewBin = ['/opt/homebrew/bin/brew', '/usr/local/bin/brew'].find(p => fs.existsSync(p)) || 'brew';
  const proc = spawn(brewBin, ['reinstall', 'ffmpeg'], {
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, PATH: AUGMENTED_PATH, HOMEBREW_NO_AUTO_UPDATE: '1' },
  });
  proc.stdout.on('data', chunk => chunk.toString().split('\n').filter(Boolean).forEach(l => send({ line: l })));
  proc.stderr.on('data', chunk => chunk.toString().split('\n').filter(Boolean).forEach(l => send({ line: l })));
  proc.on('close', code => {
    if (code === 0) send({ done: true });
    else send({ error: `brew reinstall ffmpeg exited ${code}` });
    res.end();
  });
  proc.on('error', err => { send({ error: err.message }); res.end(); });
  req.on('close', () => { try { proc.kill(); } catch (_) {} });
});

// ── Document extraction / write ────────────────────────────────────────────
// POST { path } → extract text from a docx/doc/rtf/odt file
app.post('/api/extract-document', async (req, res) => {
  const { path: docPath } = req.body || {};
  if (!docPath) return res.status(400).json({ error: 'path required' });
  const abs = path.isAbsolute(docPath) ? docPath : path.join(os.homedir(), docPath);
  if (!fs.existsSync(abs)) return res.status(404).json({ error: 'File not found' });
  const ext = path.extname(abs).toLowerCase().slice(1);
  try {
    let content = '';
    // Try pandoc first (most accurate for docx/odt)
    const pandocOut = path.join(os.tmpdir(), `fauna_doc_${Date.now()}.txt`);
    try {
      execSync(`pandoc -f ${ext === 'doc' ? 'doc' : 'docx'} -t plain -o ${JSON.stringify(pandocOut)} ${JSON.stringify(abs)} 2>/dev/null`, { timeout: 15000 });
      content = fs.readFileSync(pandocOut, 'utf8');
      try { fs.unlinkSync(pandocOut); } catch (_) {}
    } catch (_) {
      // Fallback: textutil (macOS only, supports doc/docx/rtf)
      try {
        const txtOut = abs.replace(/\.[^.]+$/, '') + '.txt';
        execSync(`textutil -convert txt -output ${JSON.stringify(txtOut)} ${JSON.stringify(abs)} 2>/dev/null`, { timeout: 15000 });
        if (fs.existsSync(txtOut)) { content = fs.readFileSync(txtOut, 'utf8'); try { fs.unlinkSync(txtOut); } catch (_) {} }
      } catch (_2) {
        // Last resort: strings
        try { content = execSync(`strings ${JSON.stringify(abs)} 2>/dev/null`, { encoding: 'utf8', timeout: 10000 }); } catch (_3) {}
      }
    }
    res.json({ ok: true, content, path: abs, editable: ['docx','odt'].includes(ext) });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// POST { path, content } → write text content back to a document
app.post('/api/write-document-text', async (req, res) => {
  const { path: docPath, content } = req.body || {};
  if (!docPath || content === undefined) return res.status(400).json({ error: 'path and content required' });
  const abs = path.isAbsolute(docPath) ? docPath : path.join(os.homedir(), docPath);
  try {
    // Try pandoc to convert plain text back to docx format
    const tmpTxt = path.join(os.tmpdir(), `fauna_doc_in_${Date.now()}.txt`);
    fs.writeFileSync(tmpTxt, content, 'utf8');
    const ext = path.extname(abs).toLowerCase().slice(1);
    try {
      execSync(`pandoc -f plain -t ${ext === 'odt' ? 'odt' : 'docx'} -o ${JSON.stringify(abs)} ${JSON.stringify(tmpTxt)} 2>/dev/null`, { timeout: 15000 });
    } catch (_) {
      // Fallback: just write as .txt alongside (the path stays the same)
      fs.writeFileSync(abs, content, 'utf8');
    }
    try { fs.unlinkSync(tmpTxt); } catch (_) {}
    res.json({ ok: true, path: abs });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// POST { name, mime, base64 } → extract text from a base64-encoded attachment
app.post('/api/extract-attachment', async (req, res) => {
  const { name = 'file', mime = 'application/octet-stream', base64 } = req.body || {};
  if (!base64) return res.status(400).json({ error: 'base64 required' });
  const ext  = (name.split('.').pop() || '').toLowerCase();
  const buf  = Buffer.from(base64, 'base64');
  const tmp  = path.join(os.tmpdir(), `fauna_attach_${Date.now()}.${ext || 'bin'}`);
  try {
    fs.writeFileSync(tmp, buf);
    let text = '';
    if (['pdf'].includes(ext)) {
      text = execSync(`pdftotext ${JSON.stringify(tmp)} - 2>/dev/null`, { encoding: 'utf8', timeout: 15000 }).trim();
    } else if (['doc','docx','odt','rtf','pages'].includes(ext)) {
      try {
        text = execSync(`pandoc -t plain ${JSON.stringify(tmp)} 2>/dev/null`, { encoding: 'utf8', timeout: 15000 }).trim();
      } catch (_) {
        try { text = execSync(`textutil -convert txt -stdout ${JSON.stringify(tmp)} 2>/dev/null`, { encoding: 'utf8', timeout: 10000 }).trim(); } catch (_2) {}
      }
    } else if (['xls','xlsx','csv'].includes(ext)) {
      text = execSync(`strings ${JSON.stringify(tmp)} 2>/dev/null | head -200`, { encoding: 'utf8', timeout: 10000 }).trim();
    } else {
      // Generic: try as text
      text = buf.slice(0, 200000).toString('utf8');
    }
    res.json({ ok: true, text, name, mime });
  } catch (e) {
    res.status(500).json({ error: e.message });
  } finally {
    try { fs.unlinkSync(tmp); } catch (_) {}
  }
});

// ── Browser extension install / download ──────────────────────────────────
const BROWSER_EXT_INSTALL_DIR = path.join(FAUNA_CONFIG_DIR, 'browser-extension');
const BROWSER_EXT_SRC_DIR     = path.join(__dirname, 'browser-extension');

function getBrowserExtSrcDir() {
  const packed = path.join(process.resourcesPath || '', 'browser-extension');
  if (fs.existsSync(packed)) return packed;
  return BROWSER_EXT_SRC_DIR;
}

app.get('/api/browser-ext/info', (req, res) => {
  const installed = fs.existsSync(path.join(BROWSER_EXT_INSTALL_DIR, 'manifest.json'));
  res.json({
    installed,
    installDir:  installed ? BROWSER_EXT_INSTALL_DIR : null,
    bundledDir:  getBrowserExtSrcDir(),
  });
});

app.post('/api/browser-ext/install', (req, res) => {
  try {
    const src = getBrowserExtSrcDir();
    if (!fs.existsSync(src)) return res.status(404).json({ error: 'Bundled extension not found' });
    fs.mkdirSync(BROWSER_EXT_INSTALL_DIR, { recursive: true });
    // Copy all files (shallow — no subdirectory icons handled separately)
    for (const file of fs.readdirSync(src)) {
      const s = path.join(src, file);
      const d = path.join(BROWSER_EXT_INSTALL_DIR, file);
      if (fs.statSync(s).isDirectory()) {
        fs.mkdirSync(d, { recursive: true });
        for (const sub of fs.readdirSync(s)) {
          fs.copyFileSync(path.join(s, sub), path.join(d, sub));
        }
      } else {
        fs.copyFileSync(s, d);
      }
    }
    res.json({ ok: true, installDir: BROWSER_EXT_INSTALL_DIR });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/browser-ext/download', async (req, res) => {
  try {
    const { dialog, BrowserWindow } = _require('electron');
    const win = BrowserWindow.getFocusedWindow() || BrowserWindow.getAllWindows()[0];
    const result = await dialog.showOpenDialog(win || undefined, {
      title: 'Choose folder to save browser extension',
      properties: ['openDirectory', 'createDirectory'],
    });
    if (result.cancelled || !result.filePaths || !result.filePaths.length) {
      return res.json({ ok: false, cancelled: true });
    }
    const dest = path.join(result.filePaths[0], 'fauna-browser-extension');
    const src  = getBrowserExtSrcDir();
    if (!fs.existsSync(src)) return res.status(404).json({ error: 'Bundled extension not found' });
    fs.mkdirSync(dest, { recursive: true });
    for (const file of fs.readdirSync(src)) {
      const s = path.join(src, file);
      const d = path.join(dest, file);
      if (fs.statSync(s).isDirectory()) {
        fs.mkdirSync(d, { recursive: true });
        for (const sub of fs.readdirSync(s)) fs.copyFileSync(path.join(s, sub), path.join(d, sub));
      } else {
        fs.copyFileSync(s, d);
      }
    }
    res.json({ ok: true, downloadDir: dest });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── Playwright MCP status / call ──────────────────────────────────────────
let _playwrightMcpClient = null;
let _playwrightMcpClientPromise = null;
let _playwrightMcpInstalled = null;
let _playwrightMcpCallQueue = Promise.resolve();
let _playwrightMcpLastLaunch = null;
let _playwrightMcpLastStderr = '';

async function _getPlaywrightMcpClient() {
  if (_playwrightMcpClient) return _playwrightMcpClient;
  if (_playwrightMcpClientPromise) return _playwrightMcpClientPromise;

  _playwrightMcpClientPromise = (async () => {
  // Spawn @playwright/mcp as a subprocess and connect via MCP SDK stdio transport
  const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
  const { StdioClientTransport } = await import('@modelcontextprotocol/sdk/client/stdio.js');
  let cliPath = path.join(path.dirname(_require.resolve('@playwright/mcp')), 'cli.js');
  if (cliPath.includes('app.asar')) {
    const unpackedCliPath = cliPath.replace('app.asar', 'app.asar.unpacked');
    if (fs.existsSync(unpackedCliPath)) cliPath = unpackedCliPath;
  }
  const nodeBin = findNodeBinary() || process.execPath;
  const spawnEnv = { ...process.env };
  spawnEnv.PATH = IS_WIN
    ? (spawnEnv.PATH || '')
    : `/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin:${spawnEnv.PATH || ''}`;
  if (process.versions?.electron && nodeBin === process.execPath) {
    spawnEnv.ELECTRON_RUN_AS_NODE = '1';
  }
  _playwrightMcpLastStderr = '';
  _playwrightMcpLastLaunch = { nodeBin, cliPath, cwd: path.dirname(cliPath) };
  const transport = new StdioClientTransport({
    command: nodeBin,
    args: [cliPath],
    env: spawnEnv,
    cwd: path.dirname(cliPath),
    stderr: 'pipe',
  });
  transport.stderr?.on('data', chunk => {
    _playwrightMcpLastStderr = (_playwrightMcpLastStderr + chunk.toString()).slice(-4000);
  });
  const client = new Client({ name: 'fauna-playwright', version: '1.0.0' });
  await client.connect(transport);
  _playwrightMcpClient = client;
  // Clean up on close
  client.onclose = () => { _playwrightMcpClient = null; _playwrightMcpClientPromise = null; };
  return client;
  })();

  try {
    return await _playwrightMcpClientPromise;
  } catch (e) {
    _playwrightMcpClient = null;
    _playwrightMcpClientPromise = null;
    throw e;
  }
}

function _formatPlaywrightMcpError(e) {
  const parts = [e.message || String(e)];
  if (_playwrightMcpLastStderr) parts.push('stderr: ' + _playwrightMcpLastStderr.trim());
  if (_playwrightMcpLastLaunch) parts.push('launch: ' + JSON.stringify(_playwrightMcpLastLaunch));
  return parts.join('\n');
}

async function _callPlaywrightMcpTool(tool, args = {}) {
  const run = async () => {
    const client = await _getPlaywrightMcpClient();
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 90000);
    try {
      return await client.callTool({ name: tool, arguments: args }, undefined, { signal: controller.signal });
    } finally {
      clearTimeout(timeout);
    }
  };

  const queued = _playwrightMcpCallQueue.catch(() => {}).then(run);
  _playwrightMcpCallQueue = queued.then(() => {}, () => {});
  return queued;
}

app.get('/api/playwright-mcp/status', async (req, res) => {
  if (_playwrightMcpInstalled === null) {
    try { await import('@playwright/mcp'); _playwrightMcpInstalled = true; } catch (_) { _playwrightMcpInstalled = false; }
  }
  res.json({
    installed: _playwrightMcpInstalled,
    running:   !!_playwrightMcpClient,
    endpoint: {
      transport:  'stdio',
      extensionWs: 'ws://localhost:3340',
      faunaExtWs:  'ws://localhost:3737/ext',
      extensionPort: 3340,
    },
  });
});

// Pre-warm the Playwright MCP client (no-op if already running)
app.post('/api/playwright-mcp/start', async (req, res) => {
  if (_playwrightMcpInstalled === null) {
    try { await import('@playwright/mcp'); _playwrightMcpInstalled = true; } catch (_) { _playwrightMcpInstalled = false; }
  }
  if (!_playwrightMcpInstalled) return res.json({ ok: false, error: 'not-installed' });
  try {
    await _getPlaywrightMcpClient();
    res.json({ ok: true, running: true });
  } catch (e) {
    res.json({ ok: false, error: e.message });
  }
});

app.post('/api/playwright-mcp/call', express.json({ limit: '4mb' }), async (req, res) => {
  const { tool, args = {} } = req.body || {};
  if (!tool) return res.status(400).json({ error: 'tool required' });

  // Try up to 2 attempts — auto-reconnect if first attempt fails with connection error
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const result = await _callPlaywrightMcpTool(tool, args);
      const content = Array.isArray(result?.content) ? result.content : [{ type: 'text', text: JSON.stringify(result) }];
      return res.json({ ok: true, content });
    } catch (e) {
      // Reset stale client so next attempt spawns a fresh subprocess
      _playwrightMcpClient = null;
      _playwrightMcpClientPromise = null;
      if (attempt === 0 && /closed|disconnect|EPIPE|EOF/i.test(e.message)) {
        console.log('[playwright-mcp] connection lost, retrying…');
        continue;
      }
      return res.status(500).json({ ok: false, error: _formatPlaywrightMcpError(e) });
    }
  }
});

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

// ── Teams Relay WebSocket endpoint ────────────────────────────────────────
// The fauna-bot server connects here to forward Teams messages to Fauna AI
// and relay AI responses back. Authentication uses a shared secret passed
// as the `secret` query param.

const TEAMS_RELAY_SECRET = process.env.FAUNA_TEAMS_SECRET || '';
let _teamsRelayWss = null;

function _loadAgentsSummary() {
  const agents = [];
  try {
    for (const { name, agentDir } of iterAgentDirs()) {
      const manifestPath = path.join(agentDir, 'agent.json');
      if (!fs.existsSync(manifestPath)) continue;
      const m = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
      if (m._parentAgent) continue;
      agents.push({ id: name, name: m.name || name, description: m.description || '' });
    }
  } catch (_) {}
  return agents;
}

function attachTeamsRelay(server) {
  if (_teamsRelayWss) return;
  _teamsRelayWss = new WebSocketServer({ noServer: true });

  server.on('upgrade', (req, socket, head) => {
    let pathname = '';
    try { pathname = new URL(req.url, 'http://localhost').pathname; } catch (_) {}
    if (pathname !== '/api/teams-relay') return; // let other handlers deal with it

    // Authenticate via ?secret= query param
    if (TEAMS_RELAY_SECRET) {
      let secret = '';
      try { secret = new URL(req.url, 'http://localhost').searchParams.get('secret') || ''; } catch (_) {}
      if (secret !== TEAMS_RELAY_SECRET) {
        socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
        socket.destroy();
        return;
      }
    }

    _teamsRelayWss.handleUpgrade(req, socket, head, ws => _teamsRelayWss.emit('connection', ws, req));
  });

  _teamsRelayWss.on('connection', (ws) => {
    console.log('[teams-relay] Bot server connected');

    ws.on('message', async (raw) => {
      let msg;
      try { msg = JSON.parse(raw); } catch { return; }
      const { reqId, type } = msg;

      const respond = (data) => {
        if (ws.readyState === ws.OPEN) ws.send(JSON.stringify({ type: 'response', reqId, ...data }));
      };

      try {
        switch (type) {
          case 'ping': {
            respond({ version: '1.0', activeModel: _activeModel || 'unknown' });
            break;
          }

          case 'chat': {
            const text = await internalAICaller(msg.message || '', msg.model || '');
            respond({ text });
            break;
          }

          case 'shell': {
            const { exec } = await import('child_process');
            const output = await new Promise((res, rej) => {
              exec(msg.command, { timeout: 60000, maxBuffer: 1024 * 1024 * 5 }, (err, stdout, stderr) => {
                res({ output: stdout + stderr, exitCode: err ? (err.code || 1) : 0 });
              });
            });
            respond(output);
            break;
          }

          case 'browse': {
            // Simple fetch for text extraction (full browser is more complex)
            const r = await fetch(msg.url, { headers: { 'User-Agent': 'Mozilla/5.0' }, signal: AbortSignal.timeout(20000) });
            const html = await r.text();
            const content = html.replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
                                .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
                                .replace(/<[^>]+>/g, ' ')
                                .replace(/\s{2,}/g, ' ')
                                .trim()
                                .slice(0, 4000);
            respond({ content });
            break;
          }

          case 'screenshot': {
            if (!desktopCapturer) { respond({ error: 'desktopCapturer not available (not running in Electron)' }); break; }
            const sources = await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: { width: 1280, height: 720 } });
            const dataUrl = sources[0]?.thumbnail?.toDataURL() || null;
            respond({ dataUrl });
            break;
          }

          case 'agents/list': {
            respond({ agents: _loadAgentsSummary() });
            break;
          }

          case 'task/create': {
            const task = createTask({ title: msg.title || msg.description, description: msg.description });
            respond({ task: { id: task.id, title: task.title, description: task.description, status: task.status } });
            break;
          }

          case 'models/list': {
            // Return the current provider models list (from the settings cache)
            try {
              const client = getCopilotClient();
              const list = await client.models.list();
              const models = (list.data || []).map(m => ({ id: m.id, name: m.id, provider: 'github-copilot' }));
              respond({ models });
            } catch {
              respond({ models: [{ id: _activeModel || 'gpt-4.1', name: _activeModel || 'gpt-4.1' }] });
            }
            break;
          }

          case 'playbook/get': {
            const prefs = loadPrefs();
            const instructions = (prefs.playbook || [])
              .filter(p => p.enabled !== false)
              .map(p => p.body || p.content || '')
              .join('\n\n');
            respond({ instructions });
            break;
          }

          default:
            respond({ error: `Unknown request type: ${type}` });
        }
      } catch (err) {
        console.error('[teams-relay] handler error:', err.message);
        const errObj = { error: err.message };
        if (ws.readyState === ws.OPEN) ws.send(JSON.stringify({ type: 'response', reqId, ...errObj }));
      }
    });

    ws.on('close', () => console.log('[teams-relay] Bot server disconnected'));
    ws.on('error', (e) => console.error('[teams-relay] WS error:', e.message));
  });
}

// ── Start ─────────────────────────────────────────────────────────────────

export function startServer(port) {
  return new Promise((resolve, reject) => {
    const server = app.listen(port, '0.0.0.0', () => {
      console.log(`\n  ✦ Copilot Chat  →  http://127.0.0.1:${port}\n`);
      resolve(server);
    });
    extBridge.attach(server);
    attachTeamsRelay(server);
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
