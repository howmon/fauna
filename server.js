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
import { createTask, getTask, getAllTasks, updateTask, deleteTask, startScheduler, stopScheduler, enableWebhook, disableWebhook, rotateWebhookToken, getTaskByWebhookToken, markWebhookFired } from './task-manager.js';
import { runTask, pauseTask, stopTask, steerTask, isTaskRunning, subscribe, setOsNotifier as setTaskRunnerOsNotifier, setAlertSink as setTaskRunnerAlertSink, getRunningTaskInfo } from './task-runner.js';
import { createProject, getProject, getAllProjects, updateProject, deleteProject,
  touchProject, linkConversation, linkTask,
  addSource, removeSource, syncSource, listFiles, readSourceFile, resolveSourceFilePath,
  searchSourceFiles, replaceSourceMatches,
  createSourceEntry, writeSourceFileBytes,
  deleteSourceEntry, renameSourceEntry, getSourceEntryAbsolutePath,
  addContext, updateContext, removeContext, contextFromArtifact,
  addBacklogItem, updateBacklogItem, moveWorkItem, addWorkItemComment,
  setWorkItemLock, listAllWorkItems, getProjectBoard, prioritizeBacklog,
  deleteWorkItem, emptyArchivedWorkItems,
  _adoptProject,
} from './project-manager.js';
import { loadInstructionFiles } from './lib/instruction-files.js';
import { runDecay } from './memory-store.js';
import { setHeartbeatPowerSave, setHeartbeatAlertSink } from './heartbeat.js';
import * as alertHub from './server/lib/alert-hub.js';
import { startWorkflowTimer, setWorkflowPowerSave } from './workflow-manager.js';
import { createWorkflow, getAllWorkflows } from './workflow-manager.js';
import { seedDefaults } from './server/lib/seed-defaults.js';
import { migrateHeartbeatToPipeline } from './server/lib/migrate-heartbeat.js';
import {
  CONFIG_DIR, readSavedConfig, getGhToken, getCopilotClient,
} from './server/copilot/auth.js';
import { BROWSER_BUILD_CONTEXT, buildBrowserExtContext } from './server/prompts/browser-context.js';
import { registerFetchUrlRoutes } from './server/routes/fetch-url.js';
import { registerSummarizeRoutes } from './server/routes/summarize.js';
import { registerComposeSuggestRoutes } from './server/routes/compose-suggest.js';
import { registerModelsRoutes } from './server/routes/models.js';
import { registerModelsDebugRoute } from './server/routes/models-debug.js';
import { registerFileFilterRoutes } from './server/routes/file-filter.js';
import { registerConversationRoutes } from './server/routes/conversations.js';
import { registerProjectRunRoutes } from './server/routes/project-runs.js';
import { registerProjectRoutes } from './server/routes/projects.js';
import { registerGenUiShareRoutes } from './server/routes/genui-share.js';
import { registerSyncRoutes } from './server/routes/sync.js';
import { registerServerlessSyncRoutes } from './server/routes/serverless-sync.js';
import { createConversationStore, cleanupOrphanedTempFiles } from './server/lib/conversation-store.js';
import { registerGitHubRoutes } from './server/routes/github.js';
import {
  listGitHubAccounts,
  getGitHubAccountMeta,
  addGitHubAccount,
  testGitHubAccount,
  removeGitHubAccount,
  getGitHubAccountToken,
} from './github-accounts.js';
import { buildProjectProfile } from './server/lib/profile.js';
import { registerTaskRoutes } from './server/routes/tasks.js';
import { registerWebhookRoutes } from './server/routes/webhooks.js';
import { registerUtilityRoutes } from './server/routes/utilities.js';
import { registerProviderRoutes } from './server/routes/providers.js';
import { registerLLMRoutes } from './server/routes/llm.js';
import { registerMobileRoutes } from './server/routes/mobile.js';
import { registerEnterpriseStubRoutes } from './server/routes/enterprise.js';
import { registerAuthRoutes } from './server/routes/auth.js';
import { createExtBridge } from './server/bridges/ext.js';
import { createCustomMcpBridge } from './server/bridges/custom-mcp.js';
import { createFigmaBridge } from './server/bridges/figma.js';
import { registerWorkspaceRoutes } from './server/routes/workspace.js';
import { registerStoreRoutes } from './server/routes/store.js';
import { registerChatMiscRoutes } from './server/routes/chat-misc.js';
import { registerGenUiExploreRoutes } from './server/routes/genui-explore.js';
import { registerChatRoute } from './server/routes/chat.js';
import { primeTokenizer } from './server/lib/token-budget.js';
import { registerGitRoutes } from './server/routes/git.js';
import { registerBrowseRoutes } from './server/bridges/playwright-browse.js';
import { registerShellExecRoutes } from './server/routes/shell-exec.js';
import { registerDevServerRoutes } from './server/routes/dev-servers.js';
import * as _devServerRegistry from './server/lib/dev-server-registry.js';
import { registerAgentSandboxFileRoutes } from './server/routes/agent-sandbox-files.js';
import { registerAgentRoutes } from './server/routes/agents.js';
import { registerAgentBuilderRoutes } from './server/routes/agent-builder.js';
import { registerAgentSandboxRoutes } from './server/routes/agent-sandbox.js';
import { registerSkillRoutes } from './server/routes/skills.js';
import { registerCustomizationRoutes } from './server/routes/customizations.js';
import { registerMemoryPrefsFactsRoutes } from './server/routes/memory-prefs-facts.js';
import { registerConnectorRoutes } from './server/routes/connectors.js';
import { registerCredentialRoutes } from './server/routes/credentials.js';
import { registerActionNodeRoutes } from './server/routes/action-nodes.js';
import { registerMcpRoutes } from './server/routes/mcp.js';
import { registerVoiceSettingsRoutes } from './server/routes/voice-settings.js';
import { registerRecordingsRoutes } from './server/routes/recordings.js';
import { registerKokoroTtsRoutes } from './server/routes/kokoro-tts.js';
import { registerLessonRoutes } from './server/routes/lesson.js';
import { registerParakeetRoutes } from './server/routes/parakeet.js';
import { registerVideoRoutes } from './server/routes/video.js';
import { registerPlaywrightMcpRoutes } from './server/routes/playwright-mcp.js';
import { createTeamsBundle } from './server/routes/teams.js';
import { registerDocsAndExtRoutes } from './server/routes/docs-and-ext.js';
import { registerSheetRoutes } from './server/routes/sheets.js';
import { startFaunaTmpJanitor } from './server/lib/fauna-tmp.js';
import { registerSchedulingAndGuardRoutes } from './server/routes/scheduling-and-guard.js';
import { registerRegionAndStdinRoutes } from './server/routes/region-and-stdin.js';
import { registerPermissionsRoutes } from './server/routes/permissions.js';
import { registerSecurityDashboardRoutes } from './server/routes/security-dashboard.js';
import { registerSystemContextRoutes } from './server/routes/system-context.js';
import { registerDesktopOrganizerRoutes } from './server/routes/desktop-organizer.js';
import { registerWindowContextRoutes } from './server/routes/window-context.js';
import { registerMarkdownPdfAndYoutubeRoutes } from './server/routes/markdown-pdf-and-youtube.js';
import { registerFaunaUpdateRoutes } from './server/routes/fauna-update.js';
import { createAgentDirIterator } from './server/lib/agents-iter.js';
import { buildShellEnv } from './server/lib/shell-env.js';
import { createInternalAICaller } from './server/lib/ai-caller.js';
import { createPowerSaveGuard, attachTaskPowerSaveBlocker } from './server/lib/power-save.js';
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
const _powerSave = createPowerSaveGuard(powerSaveBlocker);
// Wire the background-task singleton (used by kanban-worker autopilot) to
// the same Electron API so in-flight AI cards prevent system sleep.
attachTaskPowerSaveBlocker(powerSaveBlocker);

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app    = express();
const PORT   = 3737;
const IS_WIN = process.platform === 'win32';
const SERVER_ONLY_MODE = process.argv.includes('--server') || process.argv.includes('-s');
const EAGER_MCP_STARTUP = process.env.FAUNA_EAGER_MCP_STARTUP === '1'
  || (!SERVER_ONLY_MODE && process.env.FAUNA_EAGER_MCP_STARTUP !== '0');
const MEMORY_WARN_RSS_MB = Number(process.env.FAUNA_MEMORY_WARN_MB || (SERVER_ONLY_MODE ? 1024 : 2048));
const MEMORY_MONITOR_MS = Number(process.env.FAUNA_MEMORY_MONITOR_MS || 60000);
const PATH_SEP = IS_WIN ? ';' : ':';
const FAUNA_CONFIG_DIR = path.join(os.homedir(), '.config', 'fauna');

// Single conversation store instance shared between the conversation routes
// and the sync adapter — two stores would mean two independent per-id
// mutexes and a race on simultaneous local-edit + remote-pull writes.
const _sharedConversationStore = createConversationStore({ configDir: FAUNA_CONFIG_DIR });

// Clean up any orphaned .tmp files left by prior crashes (best-effort, async).
cleanupOrphanedTempFiles(FAUNA_CONFIG_DIR).catch(() => {});

// Module-level AI caller — set during startServer(), used by permission guard etc.
let internalAICaller = async () => '';
// Track the model currently in use for conversations so features inherit it
let _activeModel = 'gpt-4.1';
let _memoryHighWater = { rss: 0, heapUsed: 0, external: 0, at: new Date().toISOString() };
let _memoryMonitorTimer = null;
let _memoryLastLogRssMb = 0;

function _mb(bytes) {
  return Math.round((Number(bytes || 0) / 1024 / 1024) * 10) / 10;
}

function getProcessDiagnostics() {
  const usage = process.memoryUsage();
  if (usage.rss > _memoryHighWater.rss) {
    _memoryHighWater = {
      rss: usage.rss,
      heapUsed: usage.heapUsed,
      external: usage.external,
      at: new Date().toISOString(),
    };
  }
  const rssMb = _mb(usage.rss);
  return {
    pid: process.pid,
    uptimeSec: Math.round(process.uptime()),
    serverOnly: SERVER_ONLY_MODE,
    eagerMcpStartup: EAGER_MCP_STARTUP,
    warnThresholdMb: MEMORY_WARN_RSS_MB,
    overThreshold: Number.isFinite(MEMORY_WARN_RSS_MB) && MEMORY_WARN_RSS_MB > 0 && rssMb >= MEMORY_WARN_RSS_MB,
    memory: {
      rssMb,
      heapUsedMb: _mb(usage.heapUsed),
      heapTotalMb: _mb(usage.heapTotal),
      externalMb: _mb(usage.external),
      arrayBuffersMb: _mb(usage.arrayBuffers),
    },
    highWater: {
      rssMb: _mb(_memoryHighWater.rss),
      heapUsedMb: _mb(_memoryHighWater.heapUsed),
      externalMb: _mb(_memoryHighWater.external),
      at: _memoryHighWater.at,
    },
  };
}

function startMemoryMonitor() {
  if (_memoryMonitorTimer || !Number.isFinite(MEMORY_MONITOR_MS) || MEMORY_MONITOR_MS <= 0) return;
  _memoryMonitorTimer = setInterval(() => {
    const diag = getProcessDiagnostics();
    const rssMb = diag.memory.rssMb;
    const shouldLog = diag.overThreshold || rssMb >= _memoryLastLogRssMb + 128;
    if (shouldLog) {
      _memoryLastLogRssMb = rssMb;
      const level = diag.overThreshold ? 'warn' : 'log';
      console[level](`[memory] rss=${rssMb}MB heap=${diag.memory.heapUsedMb}/${diag.memory.heapTotalMb}MB external=${diag.memory.externalMb}MB threshold=${diag.warnThresholdMb}MB`);
    }
  }, MEMORY_MONITOR_MS);
  _memoryMonitorTimer.unref?.();
}

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
// figma getter resolves at request time.
const customMcp = createCustomMcpBridge({
  faunaConfigDir: FAUNA_CONFIG_DIR,
  extBridge,
  getFigmaConnected: () => figma.isConnected(),
  bundledBrowserServerPath: path.join(__dirname, 'faunaMCP-main', 'browser-server', 'index.js'),
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
  isWin: IS_WIN,
});
figma.register(app);

app.get('/api/runs', (_req, res) => {
  // Surface the global dev-server registry so the existing Ports dashboard
  // (public/js/projects.js#openPortsDashboard) can list / stop / restart
  // dev servers spawned via shell-exec. Shaped to match what the dashboard
  // already expects: { runId, projectId, name, srcName, cmd, port, status }.
  const runs = _devServerRegistry.list().map((e) => ({
    runId: e.id,
    projectId: null,
    name: e.label || e.command,
    srcName: e.cwdShort || '',
    cmd: e.command,
    port: e.port,
    status: e.status === 'starting' ? 'starting'
          : e.status === 'running'  ? 'running'
          : e.status === 'stopping' ? 'running'
          : 'stopped',
    startedAt: e.startedAt,
  }));
  res.json(runs);
});

// Stop / restart a tracked dev-server entry from the Ports dashboard.
app.delete('/api/runs/:runId', (req, res) => {
  const result = _devServerRegistry.kill(req.params.runId);
  res.json(result);
});
app.post('/api/runs/:runId/restart', (req, res) => {
  const result = _devServerRegistry.restart(req.params.runId, {
    shellBin: SHELL_BIN,
    isWin: IS_WIN,
    augmentedPath: AUGMENTED_PATH,
  });
  res.json(result);
});

registerConversationRoutes(app, {
  fs,
  path,
  configDir: FAUNA_CONFIG_DIR,
  getCopilotClient,
  conversationStore: _sharedConversationStore,
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
  enableWebhook,
  disableWebhook,
  rotateWebhookToken,
  getRunningTaskInfo,
});

registerWebhookRoutes(app, {
  getTaskByWebhookToken,
  markWebhookFired,
  runTask,
  isTaskRunning,
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
  searchSourceFiles,
  replaceSourceMatches,
  resolveSourceFilePath,
  createSourceEntry,
  writeSourceFileBytes,
  deleteSourceEntry,
  renameSourceEntry,
  getSourceEntryAbsolutePath,
  requireElectron: _require,
  addContext,
  updateContext,
  removeContext,
  contextFromArtifact,
  buildProjectProfile,
  // Kanban
  addBacklogItem,
  updateBacklogItem,
  moveWorkItem,
  addWorkItemComment,
  setWorkItemLock,
  listAllWorkItems,
  getProjectBoard,
  prioritizeBacklog,
  deleteWorkItem,
  emptyArchivedWorkItems,
  conversationStore: _sharedConversationStore,
  // Project audit
  getInternalAICaller: () => internalAICaller,
});

registerGitHubRoutes(app, {
  listGitHubAccounts,
  getGitHubAccountMeta,
  addGitHubAccount,
  testGitHubAccount,
  removeGitHubAccount,
  getGitHubAccountToken,
  getProject,
  updateProject,
});

registerProviderRoutes(app, { faunaConfigDir: FAUNA_CONFIG_DIR });
registerMobileRoutes(app, { faunaConfigDir: FAUNA_CONFIG_DIR, port: PORT });
registerGenUiShareRoutes(app, { faunaConfigDir: FAUNA_CONFIG_DIR, port: PORT, appDir: __dirname });
registerEnterpriseStubRoutes(app);
registerAuthRoutes(app);

// Cross-device sync (Fauna Cloud). Registers /api/sync/* and auto-starts
// the engine if a bearer is already on disk from a prior session.
registerSyncRoutes(app, {
  conversationStore: _sharedConversationStore,
  projectManager: {
    getProject, getAllProjects, createProject, updateProject, deleteProject, _adoptProject,
  },
});
registerServerlessSyncRoutes(app, {
  conversationStore: _sharedConversationStore,
  projectManager: { getProject, getAllProjects, updateProject, deleteProject, _adoptProject, writeSourceFileBytes, deleteSourceEntry },
  port: PORT,
});

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
registerModelsDebugRoute(app, { readSavedConfig, getGhToken });
registerLLMRoutes(app);

// ── Figma layout knowledge ───────────────────────────────────────────────
// Injected into the system prompt when Figma MCP is enabled.

// ── Gen-UI catalog prompt moved → server/prompts/gen-ui-catalog.js ─

// ── Browser panel context moved → server/prompts/browser-context.js ──

// Wire smaller chat routes (debug-prompt / chat-summary / composition planner).
registerChatMiscRoutes(app, { browserBuildContext: BROWSER_BUILD_CONTEXT });

// ── Browser Extension context moved → server/prompts/browser-context.js ──

// ── /api/summarize moved → server/routes/summarize.js ──
registerSummarizeRoutes(app, { getCopilotClient });

// ── /api/compose/suggest — inline composer autocomplete (ghost text) ──
registerComposeSuggestRoutes(app, { getCopilotClient });

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
registerVoiceSettingsRoutes(app);
registerRecordingsRoutes(app, { getSystemPreferences: () => systemPreferences });
registerKokoroTtsRoutes(app);
registerLessonRoutes(app, { getElectronBrowserWindow: () => _ElectronBrowserWindow });

// ── Browser (Playwright) routes moved → server/bridges/playwright-browse.js ──
const browseRoutes = registerBrowseRoutes(app, { require: _require });

// Wire the Explore page's gen-ui generator (POST /api/genui-explore). Passes the
// Playwright browse manager so Explore can ground views in live web data.
registerGenUiExploreRoutes(app, { getBrowseManager: () => browseRoutes?.manager });

// ── Figma bridge moved → server/bridges/figma.js ──
// ── Custom MCP routes/state moved → server/bridges/custom-mcp.js ──
// Start trying to connect immediately when the server starts
// Also auto-start the MCP server if it's not already running
setTimeout(() => {
  figma.start();
  // Start custom MCP auto-detection
  customMcp.startAutoDetect({ spawnFallback: EAGER_MCP_STARTUP });
  if (EAGER_MCP_STARTUP) {
    // Pre-warm Playwright MCP if available so it shows READY immediately.
    playwrightMcp.prewarm().then(() => {
      console.log('[playwright-mcp] pre-warmed on startup');
    }).catch(() => {});
  } else {
    console.log('[playwright-mcp] startup prewarm skipped in server-only mode (lazy start via /api/playwright-mcp/start)');
  }
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

// ── Dev-server registry routes ─────────────────────────────────────────
// Tracks long-running dev/preview servers (npm run dev, vite, next dev, …)
// spawned via shell-exec so the user can list / stop / restart them from
// the UI instead of accumulating orphaned ports.
registerDevServerRoutes(app, {
  shellBin: SHELL_BIN,
  isWin: IS_WIN,
  augmentedPath: AUGMENTED_PATH,
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
  isWin: IS_WIN,
});
registerChatRoute(app, {
  figma,
  customMcp,
  agentsDir: AGENTS_DIR,
  workspaceRoot: __dirname,
  userConfigDir: FAUNA_CONFIG_DIR,
  browserBuildContext: BROWSER_BUILD_CONTEXT,
  buildBrowserExtContext: () => buildBrowserExtContext(extBridge),
  psAcquire: () => _powerSave.acquire(),
  psRelease: () => _powerSave.release(),
  setActiveModel: (m) => { _activeModel = m; },
  getMainWindows: () => (_ElectronBrowserWindow?.getAllWindows?.() || []),
  sendNotification: (title, body) => {
    try {
      const { Notification: ElectronNotification } = _require('electron');
      new ElectronNotification({ title, body }).show();
    } catch (_) {
      console.log(`[notification] ${title}: ${body}`);
    }
    // Mirror chat completion notifications into the widget alert panel
    // so users can pick them up while the main window is minimised.
    try {
      alertHub.publish({
        id: 'chat-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8),
        timestamp: Date.now(),
        source: 'chat',
        summary: title || 'Fauna',
        action: body || '',
      });
    } catch (_) {}
  },
  callPlaywrightMcpTool: (tool, args) => playwrightMcp.callTool(tool, args),
  resetPlaywrightMcpClient: () => playwrightMcp.reset(),
  // Shell exec deps for the native fauna_shell_exec tool
  shellBin: SHELL_BIN,
  isWin: IS_WIN,
  augmentedPath: AUGMENTED_PATH,
  shellProcs: _shellProcs,
});
// Legacy agents dir: ~/.config/copilot-chat/agents (kept for backward compatibility)
const LEGACY_AGENTS_DIR = path.join(CONFIG_DIR, 'agents');

// Project-local agents folder (version-controlled alongside the app source)
const LOCAL_AGENTS_DIR = path.join(path.dirname(new URL(import.meta.url).pathname), 'agents');

const iterAgentDirs = createAgentDirIterator({ agentsDir: AGENTS_DIR, legacyAgentsDir: LEGACY_AGENTS_DIR, localAgentsDir: LOCAL_AGENTS_DIR });

// ── Agent management routes moved → server/routes/agents.js ──
registerAgentRoutes(app, { express, agentsDir: AGENTS_DIR, iterAgentDirs, builtinAgentNames: ['research', 'coder', 'writer', 'designer'] });
// ── Skill catalog & import routes → server/routes/skills.js ──
registerSkillRoutes(app, { express });
registerCustomizationRoutes(app, { workspaceRoot: __dirname, userConfigDir: FAUNA_CONFIG_DIR });
// ── Agent Builder routes moved → server/routes/agent-builder.js ──
// Privileged authoring surface — only the in-app Electron renderer may hit
// it. Requires both loopback origin AND the per-process UI nonce minted by
// main.js, exposed to the renderer via main-preload.js and auto-attached
// as the `x-fauna-ui` header by the fetch shim in public/index.html.
app.use('/api/agent-builder', (req, res, next) => {
  const ip = (req.ip || req.connection?.remoteAddress || '').replace(/^::ffff:/, '');
  if (ip !== '127.0.0.1' && ip !== '::1') {
    return res.status(403).json({ error: 'agent-builder restricted to local UI' });
  }
  const expected = process.env.FAUNA_UI_NONCE;
  if (!expected || req.get('x-fauna-ui') !== expected) {
    return res.status(403).json({ error: 'agent-builder restricted to local UI' });
  }
  next();
});
registerAgentBuilderRoutes(app, { agentsDir: AGENTS_DIR });

// ── Agent store routes (proxy + sync + admin + notifications) moved → server/routes/store.js ──

// ── Agent sandbox routes moved → server/routes/agent-sandbox.js ──
{
  const { getAgentManifest } = registerAgentSandboxRoutes(app, { agentsDir: AGENTS_DIR });
  _setAgentManifestGetter(getAgentManifest);
}

// ── Desktop organizer route moved → server/routes/desktop-organizer.js ──
registerDesktopOrganizerRoutes(app);
// ── Window context (running apps + arrange) ──
registerWindowContextRoutes(app);
// ── System context route moved → server/routes/system-context.js ──
registerSystemContextRoutes(app, { isWin: IS_WIN, shellBin: SHELL_BIN, agentsDir: AGENTS_DIR, getGhToken, getSystemPreferences: () => systemPreferences });
// ── macOS Permissions routes moved → server/routes/permissions.js ──
registerPermissionsRoutes(app, { isWin: IS_WIN, getGhToken, getSystemPreferences: () => systemPreferences, getDesktopCapturer: () => desktopCapturer });
registerSecurityDashboardRoutes(app, {
  appDir: __dirname,
  isWin: IS_WIN,
  getGhToken,
  getSystemPreferences: () => systemPreferences,
  getBrowseStatus: () => browseRoutes?.getStatus?.(),
  getBrowseDiagnostics: () => browseRoutes?.manager?.getDiagnostics?.(),
  getFigmaStatus: () => ({ connected: figma.isConnected?.() === true }),
  getCustomMcpStatus: () => customMcp.getRelayState?.(),
  getCustomMcpDiagnostics: () => customMcp.getDiagnostics?.(),
  getPlaywrightMcpStatus: () => playwrightMcp.status?.(),
  getProcessDiagnostics,
});
// ── Memory / Preferences / Facts ──────────────────────────────────────────
const { loadPrefs } = registerMemoryPrefsFactsRoutes(app, { configDir: CONFIG_DIR });
registerConnectorRoutes(app);
registerCredentialRoutes(app);
registerActionNodeRoutes(app);
registerMcpRoutes(app, { faunaConfigDir: FAUNA_CONFIG_DIR });

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

// ── Internal AI caller telemetry (PR4.7) ───────────────────────────────────
app.get('/api/internal-ai/telemetry', (req, res) => {
  try {
    const tel = (typeof internalAICaller?.getTelemetry === 'function')
      ? internalAICaller.getTelemetry()
      : null;
    if (!tel) return res.json({ enabled: false });
    res.json({ enabled: true, ...tel });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

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
// ── Voice STT (Parakeet/sherpa-onnx) + transcription routes → server/routes/parakeet.js ──
registerParakeetRoutes(app, { express, appDir: __dirname, augmentedPath: AUGMENTED_PATH });
// ── Video Studio pipeline routes ──
registerVideoRoutes(app, { getCopilotClient });
// ── Document/attachment + browser-ext routes moved → server/routes/docs-and-ext.js ──
registerDocsAndExtRoutes(app, { faunaConfigDir: FAUNA_CONFIG_DIR, appDir: __dirname });
// ── Spreadsheet data bridge for the in-panel Univer editor ──
registerSheetRoutes(app);
// Sweep ~/Documents/Fauna/tmp on boot and once per day, removing anything
// older than 30 days. Whisper audio, pandoc input, and base64 attachments
// stage their work there so a failed operation leaves a recoverable copy.
startFaunaTmpJanitor(30);
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
    // Loopback-only bind. Remote access (mobile app) goes through the
    // localtunnel client in mobile.js, which proxies back to 127.0.0.1.
    // Set FAUNA_BIND_HOST=0.0.0.0 to opt back into LAN exposure.
    const host = process.env.FAUNA_BIND_HOST || '127.0.0.1';
    const server = app.listen(port, host, () => {
      console.log(`\n  ✦ Copilot Chat  →  http://127.0.0.1:${port}  (bind=${host})\n`);
      resolve(server);
    });
    // Prime tiktoken once — gives exact token counts for cl100k_base models
    // (OpenAI). Falls back silently to char/3.8 heuristic if unavailable.
    primeTokenizer().then(loaded => {
      if (loaded) console.log('[tokens] tiktoken (cl100k_base) primed for exact counts');
    }).catch(() => {});
    startMemoryMonitor();
    extBridge.attach(server);
    teamsBundle.attachRelay(server);
    startScheduler(task => {
      runTask(task.id, { trigger: 'scheduler' }).catch(e => console.error('[tasks] scheduled run failed:', e.message));
    });
    // Kick off the Kanban autopilot worker. It only acts on projects with
    // kanban.autopilot=true (off by default), so it's safe to always start.
    import('./kanban-worker.js')
      .then(mod => mod.startKanbanWorker())
      .catch(e => console.warn('[kanban-worker] failed to start:', e?.message || e));
    // Run fact memory decay on startup (prune facts not accessed in 60 days)
    try { runDecay(); } catch (_) {}

    // Internal AI caller for heartbeat and workflows — defaults to active conversation model
    internalAICaller = createInternalAICaller({
      getCopilotClient,
      getActiveModel: () => _activeModel,
    });
    const internalNotifier = (title, body) => {
      try {
        const { Notification: ElectronNotification } = _require('electron');
        new ElectronNotification({ title, body }).show();
      } catch (_) {
        console.log(`[notification] ${title}: ${body}`);
      }
    };
    // Workflow notifier also feeds the widget panel; heartbeat keeps its
    // direct sink wiring below so urgencies carry the parsed action field.
    const workflowNotifier = (title, body) => {
      internalNotifier(title, body);
      try {
        alertHub.publish({
          id: 'wf-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8),
          timestamp: Date.now(),
          source: 'workflow',
          summary: title || 'Workflow',
          action: body || '',
        });
      } catch (_) {}
    };

    // Start heartbeat and workflow timers
    setHeartbeatPowerSave(_powerSave);
    setWorkflowPowerSave(_powerSave);
    // Push urgent heartbeat alerts to the widget panel via the alert hub.
    try { setHeartbeatAlertSink(alertHub.publish); }
    catch (e) { console.warn('[server] alert-hub wire failed:', e?.message || e); }
    // Same hooks for the pipeline runtime — the os-notify node uses these
    // to fire native notifications and push to the widget alert hub
    // without importing electron/alert-hub itself.
    try {
      setTaskRunnerOsNotifier(internalNotifier);
      setTaskRunnerAlertSink(alertHub.publish);
    } catch (e) { console.warn('[server] task-runner notifier wire failed:', e?.message || e); }
    // Same hooks for the kanban autopilot worker — fires native + widget
    // alerts on card complete / fail / out-of-retries / needs-review.
    // Dynamic import keeps this resilient if the module fails to load
    // (the worker's startKanbanWorker import above uses the same pattern).
    import('./kanban-worker.js').then(mod => {
      try { mod.setOsNotifier && mod.setOsNotifier(internalNotifier); } catch (_) {}
      try { mod.setAlertSink && mod.setAlertSink(alertHub.publish); } catch (_) {}
    }).catch(e => console.warn('[server] kanban-worker notifier wire failed:', e?.message || e));
    // Retire the standalone heartbeat module. On first boot after upgrade
    // this ports any enabled heartbeat settings into a pipeline task; on
    // subsequent boots it's a no-op (gated by the marker file). The legacy
    // module is no longer started — the pipeline task carries the schedule
    // and the os-notify node carries the alerts.
    try { migrateHeartbeatToPipeline({ createTask }); }
    catch (e) { console.warn('[server] heartbeat migration failed:', e?.message || e); }
    startWorkflowTimer(internalAICaller, workflowNotifier);
    startTeamsBridge(internalAICaller, workflowNotifier);
    // First-launch seed of sample automations. No-op once the marker file
    // exists or the user already has tasks/workflows configured.
    try {
      seedDefaults({
        readTasks: getAllTasks,
        createTask,
        getAllWorkflows,
        createWorkflow,
      });
    } catch (e) { console.warn('[server] seedDefaults failed:', e?.message || e); }
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
      if (_memoryMonitorTimer) {
        clearInterval(_memoryMonitorTimer);
        _memoryMonitorTimer = null;
      }
    }
    process.on('exit',    () => fullCleanup());
    process.on('SIGTERM', () => { fullCleanup(); process.exit(0); });
    process.on('SIGINT',  () => { fullCleanup(); process.exit(0); });
  });
}

export { app };
