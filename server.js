/**
 * Copilot Chat — backend server
 * Streams GitHub Copilot responses via SSE, serves the chat UI, fetches URLs.
 */

import express    from 'express';
import OpenAI     from 'openai';
import localtunnel from 'localtunnel';
import { execSync, exec as _exec, spawn } from 'child_process';
import crypto     from 'crypto';
import path       from 'path';
import os         from 'os';
import fs         from 'fs';
import { createRequire } from 'module';
import { fileURLToPath } from 'url';
import { createTask, getTask, getAllTasks, updateTask, deleteTask, startScheduler, stopScheduler } from './task-manager.js';
import { runTask, pauseTask, stopTask, steerTask, isTaskRunning, subscribe } from './task-runner.js';
import {
  createProject, getProject, getAllProjects, updateProject, deleteProject,
  touchProject, linkConversation, linkTask,
  addSource, removeSource, syncSource, listFiles, readSourceFile, resolveSourceFilePath,
  addContext, updateContext, removeContext, contextFromArtifact,
} from './project-manager.js';
import { loadInstructionFiles } from './lib/instruction-files.js';
import { runDecay } from './memory-store.js';
import { startHeartbeat } from './heartbeat.js';
import { startWorkflowTimer } from './workflow-manager.js';
import {
  CONFIG_DIR, readSavedConfig, getGhToken, getCopilotClient,
} from './server/copilot/auth.js';
import { BROWSER_BUILD_CONTEXT, buildBrowserExtContext } from './server/prompts/browser-context.js';
import { registerFetchUrlRoutes } from './server/routes/fetch-url.js';
import { registerSummarizeRoutes } from './server/routes/summarize.js';
import { registerModelsRoutes } from './server/routes/models.js';
import { registerFileFilterRoutes } from './server/routes/file-filter.js';
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
import { registerFaunaUpdateRoutes } from './server/routes/fauna-update.js';
import { createAgentDirIterator } from './server/lib/agents-iter.js';
import { buildShellEnv } from './server/lib/shell-env.js';
import {
  resolvePath,
  setAgentManifestGetter as _setAgentManifestGetter,
} from './server/lib/write-helpers.js';
import { startTeamsBridge } from './teams-bridge.js';
import { initBotManager } from './teams-bot-manager.js';
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
// ── Fauna self-update routes moved → server/routes/fauna-update.js ──
registerFaunaUpdateRoutes(app, { express, appDir: __dirname, getElectronApp: () => _electronApp, getElectronShell: () => _electronShell });
// ── Markdown→PDF + YouTube thumbnail routes moved → server/routes/markdown-pdf-and-youtube.js ──
registerMarkdownPdfAndYoutubeRoutes(app, { express, getElectronBrowserWindow: () => _ElectronBrowserWindow });
// ── Auth / token resolution + model list moved to server/copilot/{auth,models}.js ──
// Auth check ────────────────────────────────────────────────────────────────
// ── /api/auth + /api/token routes moved → server/routes/auth.js ──
// ── /api/models moved → server/routes/models.js ──
registerModelsRoutes(app, { readSavedConfig, getGhToken });

// ── Figma layout knowledge ───────────────────────────────────────────────
// Injected into the system prompt when Figma MCP is enabled.

// ── Gen-UI catalog prompt moved → server/prompts/gen-ui-catalog.js ─

// ── Browser panel context moved → server/prompts/browser-context.js ──

// Wire smaller chat routes (debug-prompt / chat-summary / composition planner).
registerChatMiscRoutes(app, { browserBuildContext: BROWSER_BUILD_CONTEXT });

// ── Browser Extension context moved → server/prompts/browser-context.js ──

// ── /api/summarize moved → server/routes/summarize.js ──
registerSummarizeRoutes(app, { getCopilotClient });

// ── /api/chat moved → server/routes/chat.js ──

// ── Git routes + detectCommitConvention moved → server/routes/git.js ──

// ── Workspace Discovery (Feature C) ──────────────────────────────────────
// Scans a directory and returns project context (build commands, architecture, etc.)
// Core instruction-file helpers live in lib/instruction-files.js (imported above).

// ── Workspace discovery route moved → server/routes/workspace.js ──

// ── /api/chat/debug-prompt moved → server/routes/chat-misc.js ──

// ── /api/file-filter moved → server/routes/file-filter.js ──
registerFileFilterRoutes(app);

// ── /api/fetch-url moved → server/routes/fetch-url.js ──
registerFetchUrlRoutes(app);

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

// ── Shell execution environment moved → server/lib/shell-env.js ──
const { augmentedPath: AUGMENTED_PATH, shellBin: SHELL_BIN } = buildShellEnv(IS_WIN);

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
  buildBrowserExtContext: () => buildBrowserExtContext(extBridge),
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
