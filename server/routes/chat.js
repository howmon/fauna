// server/routes/chat.js
//
// Main /api/chat SSE streaming handler.
// Owns: prompt assembly (system prompt + project + facts + browser/UI/figma
// context), conversation trimming, Figma/agent/self tool wiring, the agentic
// tool-call loop, deduping, length-recovery auto-continue, and the tool guard.
//
// Factory: registerChatRoute(app, deps)
//
// Deps (server.js owns top-level state, this module is stateless):
//   - figma                   : figma bridge (listFiles/getMcpTools/executeToolDef/callMcpTool/log)
//   - customMcp               : custom MCP bridge (getStatus/getTools/callTool)
//   - agentsDir               : ~/.config/fauna/agents
//   - browserBuildContext     : BROWSER_BUILD_CONTEXT system-prompt block
//   - buildBrowserExtContext  : () => string  (extension context, dynamic)
//   - psAcquire, psRelease    : power-save lock helpers
//   - setActiveModel          : (model) => void  (lets heartbeat/workflows reuse the active model)
//   - getMainWindows          : () => BrowserWindow[]  (for selfToolContext.sendToRenderer)
//   - sendNotification        : (title, body) => void  (Electron desktop notification)
//   - callPlaywrightMcpTool   : (tool, args) => Promise<result>
//   - resetPlaywrightMcpClient: () => void  (used by auto-snapshot reconnect)

import fs from 'fs';
import path from 'path';

import { getCopilotClient } from '../copilot/auth.js';
import { getLLMClient } from '../llm/registry.js';
import { applyModelRequestCompatibility, resolveModelCapabilities } from '../llm/model-capabilities.js';
import { FALLBACK_MODELS, CHAT_COMPLETIONS_UNSUPPORTED_RE } from '../copilot/models.js';
import { GEN_UI_CATALOG_PROMPT, GEN_UI_SHORT_HINT } from '../prompts/gen-ui-catalog.js';
import { FAUNA_CORE_GUIDELINES, FAUNA_FRONTEND_QUALITY } from '../prompts/core-guidelines.js';
import { computeContextFlags, computeToolFlags, filterToolSchemas } from '../prompts/context-gating.js';
import { SELF_TOOL_DEFS, DYNAMIC_WIDGET_TOOL_DEFS, executeSelfTool, isSelfTool, getActivePlanForConv } from '../../self-tools.js';
import { compressToolOutput } from '../lib/compress-tool-output.js';
import { stashOutput } from '../lib/tool-output-cache.js';
import { runShell, formatShellResultForLLM } from '../lib/shell-runner.js';
import { runHooks } from '../lib/hooks-runtime.js';
import { maybeRegister as registerDevServer, isDevServerCommand } from '../lib/dev-server-registry.js';
import { spawn as _spawnDetached } from 'child_process';
import os from 'os';
import { applyPatchText } from './agent-sandbox-files.js';
import {
  extractWidgetRegistrations, buildEphemeralToolDefs,
  isWidgetTool, parseWidgetToolName,
} from '../../lib/dynamic-widgets.js';
import { ToolGuardContext, formatToolLabel } from '../../tool-guard.js';
import { getAgentTools, startAgentMCPServers } from '../../agent-tools.js';
import { formatForSystemPrompt as factsForSystemPrompt, getStats as factsGetStats, remember as factsRemember, projectContainerTag } from '../../memory-store.js';
import { buildProjectProfile, formatProfileForPrompt } from '../lib/profile.js';
import { extractFacts as extractMemoryFacts } from '../lib/memory-extractor.js';
import { extractCorrections } from '../lib/failure-learning.js';
import { buildAgentPolicy, discoverCustomizations, filterToolsByPolicy, resolveToolPolicy } from '../../lib/customization-registry.js';
import { getProjectSystemContext, buildContextPayload, getProject, appendAutonomousRunLog, resolveProjectSourceRoot } from '../../project-manager.js';
import { estimateTokens, computeBudget } from '../lib/token-budget.js';
import { summarizeHistory } from '../lib/summarize-history.js';
import { withTimeout } from '../lib/async-utils.js';
import { loadAgentManifest } from '../lib/agent-manifest.js';

// ── Created-file artifact detection ──────────────────────────────────────
// Files created via the fauna_write_file / fauna_write_files / fauna_shell_exec
// function tools bypass the client-side ```write-file / ```shell-exec render
// path, so no entity card gets injected and the model just prints a raw path.
// We detect the created path server-side and stream an `artifact_created`
// event so the client can inject an entity card that opens the artifact pane.
const _ARTIFACT_EXT_TYPE = {
  md: 'markdown', markdown: 'markdown', json: 'json', csv: 'csv',
  html: 'html', htm: 'html', svg: 'svg', pdf: 'pdf',
  doc: 'docx', docx: 'docx', rtf: 'docx', odt: 'docx', pages: 'docx',
  ppt: 'deck', pptx: 'deck', key: 'deck', odp: 'deck',
  xls: 'xlsx', xlsx: 'xlsx', ods: 'xlsx', numbers: 'xlsx',
  png: 'image', jpg: 'image', jpeg: 'image', gif: 'image', webp: 'image',
};
const _ARTIFACT_CODE_EXT = new Set([
  'js', 'mjs', 'cjs', 'ts', 'tsx', 'jsx', 'py', 'rb', 'go', 'rs', 'java',
  'cs', 'php', 'sh', 'zsh', 'bash', 'css', 'xml', 'yaml', 'yml', 'txt',
]);
export function artifactTypeForPath(p) {
  const ext = (String(p || '').split('.').pop() || '').toLowerCase();
  if (_ARTIFACT_EXT_TYPE[ext]) return _ARTIFACT_EXT_TYPE[ext];
  if (_ARTIFACT_CODE_EXT.has(ext)) return 'code';
  return 'text';
}
// Extensions worth surfacing as a card from a shell command. Kept tight so
// intermediate .log / .tmp redirects don't spam the conversation with cards.
const _SHELL_PRESENTABLE_EXT = /\.(pptx|ppt|key|odp|docx|doc|rtf|odt|pages|xlsx|xls|ods|numbers|pdf|html|htm|csv|md|markdown|json|svg|png|jpe?g|gif|webp)$/i;
function _resolveArtifactPath(p, cwd) {
  let raw = String(p || '').trim().replace(/^['"]|['"]$/g, '');
  if (!raw) return '';
  if (raw.startsWith('~/')) raw = path.join(os.homedir(), raw.slice(2));
  else if (!path.isAbsolute(raw)) raw = path.resolve(cwd || os.homedir(), raw);
  return raw;
}
// Scan a shell command for presentable output files it created (python-pptx
// prs.save("deck.pptx"), openpyxl wb.save('report.xlsx'), redirects, -o flags).
// Only returns paths that actually exist on disk as regular files.
export function detectShellArtifacts(command, cwd) {
  const out = [];
  const seen = new Set();
  const push = (p) => {
    if (!p || /[*?$`]/.test(p) || /^-/.test(p)) return;
    const resolved = _resolveArtifactPath(p, cwd);
    if (!resolved || seen.has(resolved) || !_SHELL_PRESENTABLE_EXT.test(resolved)) return;
    try { if (!fs.existsSync(resolved) || !fs.statSync(resolved).isFile()) return; } catch (_) { return; }
    seen.add(resolved);
    out.push({ path: resolved, type: artifactTypeForPath(resolved) });
  };
  const cmd = String(command || '');
  // Explicit save/write calls. Do not treat every quoted existing path as an
  // output: commands often quote input evidence such as package.json.
  cmd.replace(/\b(?:save|writeFileSync|writeFile|toFile|export)\s*\(\s*["']([^"'\n]{1,300}?\.[A-Za-z0-9]{1,6})["']/g, (m, p) => { push(p); return m; });
  // Python-style open(path, 'w'|'a'|'x') output handles.
  cmd.replace(/\bopen\s*\(\s*["']([^"'\n]{1,300}?\.[A-Za-z0-9]{1,6})["']\s*,\s*["'][wax][^"']*["']/g, (m, p) => { push(p); return m; });
  // Redirects and tee targets.
  cmd.replace(/(?:>>?|\btee\b)\s+([^\s;|&]+)/g, (m, p) => { push(p); return m; });
  // -o / --output / --out targets.
  cmd.replace(/(?:-o|--output|--out)[=\s]+([^\s;|&]+)/g, (m, p) => { push(p); return m; });
  return out;
}

function buildCustomMcpContext(status) {
  const servers = Array.isArray(status?.servers) ? status.servers : [];
  if (!servers.length) return '';

  const lines = servers.slice(0, 20).map((server) => {
    const flags = [];
    flags.push(server.enabled ? 'enabled' : 'disabled');
    flags.push(server.running ? 'running' : 'stopped');
    if (server.auth?.requiresAuth) flags.push(server.auth.authorized ? 'auth ok' : 'auth required');
    const toolNames = Array.isArray(server.tools) && server.tools.length
      ? `; tools: ${server.tools.slice(0, 12).join(', ')}${server.tools.length > 12 ? ', ...' : ''}`
      : '';
    const error = server.lifecycle?.lastError ? `; last error: ${String(server.lifecycle.lastError).slice(0, 180)}` : '';
    const url = server.url ? `; url: ${server.url}` : '';
    return `- ${server.name || server.id} (${server.transport || 'unknown'}, ${flags.join(', ')}${url}${toolNames}${error})`;
  }).join('\n');

  return '\n## Enabled MCP Servers\n' +
    'Fauna custom MCP servers are part of this chat context. Enabled HTTP MCP servers are auto-connected for chat when possible; running servers expose their tools as callable function tools. Stdio custom MCP servers are listed for awareness, but only HTTP custom MCP tools are currently callable from chat.\n' +
    lines;
}

export function registerChatRoute(app, {
  figma,
  customMcp = null,
  agentsDir,
  browserBuildContext = '',
  buildBrowserExtContext = () => '',
  psAcquire = () => {},
  psRelease = () => {},
  setActiveModel = () => {},
  getMainWindows = () => [],
  sendNotification = (title, body) => { console.log(`[notification] ${title}: ${body}`); },
  callPlaywrightMcpTool,
  resetPlaywrightMcpClient = () => {},
  workspaceRoot = process.cwd(),
  userConfigDir = null,
  userHome = null,
  // Shell exec deps for the fauna_shell_exec native tool. If absent, the tool
  // will return a runtime error and the model will fall back to ```bash blocks.
  shellBin = null,
  isWin = false,
  augmentedPath = null,
  shellProcs = null,
}) {
  // ── Dynamic Widget RPC bridge ────────────────────────────────────────
  // When the model calls a widget tool, chat.js opens a pending call here
  // and emits SSE to the frontend. The frontend forwards to the iframe and
  // POSTs the result back to /api/widget-tool-result, which resolves the
  // awaiting promise so the model loop continues.
  /** @type {Map<string,{resolve:(v:any)=>void,reject:(e:Error)=>void,timer:NodeJS.Timeout}>} */
  const widgetPendingCalls = new Map();
  const WIDGET_TOOL_TIMEOUT_MS = 15000;

  // ── Client-tool RPC bridge ── same pattern as widgets, but for built-in
  // renderer-only capabilities (browser actions, screenshots, etc.) that the
  // model needs to invoke via native function tools. The server sends a
  // client_tool_pending SSE event; the client executes and POSTs the result
  // back to /api/client-tool-result.
  /** @type {Map<string,{resolve:(v:any)=>void,reject:(e:Error)=>void,timer:NodeJS.Timeout}>} */
  const clientToolPendingCalls = new Map();
  const CLIENT_TOOL_TIMEOUT_MS = 60000;

  app.post('/api/client-tool-result', (req, res) => {
    const { callId, result, error } = req.body || {};
    const pending = clientToolPendingCalls.get(callId);
    if (!pending) {
      // Orphaned result — the pending call already timed out (e.g. the machine
      // slept mid-call). Ack with 200 so the renderer doesn't log a network
      // error; there's simply nothing left to resolve.
      return res.json({ ok: false, reason: 'expired' });
    }
    clientToolPendingCalls.delete(callId);
    clearTimeout(pending.timer);
    if (error) pending.reject(new Error(String(error)));
    else pending.resolve(result);
    res.json({ ok: true });
  });

  app.post('/api/widget-tool-result', (req, res) => {
    const { callId, result, error } = req.body || {};
    const pending = widgetPendingCalls.get(callId);
    if (!pending) {
      // Orphaned result (see /api/client-tool-result) — ack with 200 instead
      // of 404 so a stale post after wake doesn't spam the console.
      return res.json({ ok: false, reason: 'expired' });
    }
    widgetPendingCalls.delete(callId);
    clearTimeout(pending.timer);
    if (error) pending.reject(new Error(String(error)));
    else pending.resolve(result);
    res.json({ ok: true });
  });

  // ── Permission-request RPC ── opt-in via FAUNA_PROMPT_PERMISSION=1.
  // When enabled, the chat loop sends `tool_permission_request` with a
  // callId and awaits a POST here with { callId, decision: 'allow'|'deny' }.
  // Falls back to deny on timeout so an absent UI cannot silently approve.
  /** @type {Map<string,{resolve:(v:string)=>void,timer:NodeJS.Timeout}>} */
  const permissionPendingCalls = new Map();
  const PERMISSION_TIMEOUT_MS = 30000;

  app.post('/api/tool-permission-result', (req, res) => {
    const { callId, decision } = req.body || {};
    const pending = permissionPendingCalls.get(callId);
    if (!pending) {
      return res.status(404).json({ ok: false, error: 'Unknown or expired callId' });
    }
    permissionPendingCalls.delete(callId);
    clearTimeout(pending.timer);
    pending.resolve(decision === 'allow' ? 'allow' : 'deny');
    res.json({ ok: true });
  });

  app.post('/api/chat', async (req, res) => {
    psAcquire();
    res.on('finish', psRelease);
    res.on('close',  psRelease);

    // Phase 7: cancel upstream model stream when the client disconnects (Stop button).
    // IMPORTANT: do NOT listen on `req.on('close')` — that event fires as soon as the
    // request body stream finishes (after body-parser drains the POST body), which is
    // BEFORE the upstream OpenAI call starts. That would abort the upstream immediately
    // and produce an empty 34ms response. The canonical pattern is `res.on('close')`
    // guarded by `!res.writableEnded` — only true when the client genuinely disconnected
    // before we finished writing the SSE stream.
    const upstreamAbort = new AbortController();
    // Set true when the idle watchdog aborts a genuinely-stalled upstream
    // stream (no chunks at all for STREAM_IDLE_MS). Distinguishes a stall from
    // a user-initiated Stop so the catch can surface a recoverable error.
    let streamStalled = false;
    // Set true when the first-content watchdog aborts a turn that spent too
    // long in pure thinking (chunks arriving, but no visible text/tool call)
    // — the idle watchdog above can't catch this because thinking deltas keep
    // resetting its timer.
    let thinkingDeadlineHit = false;
    // Track callIds opened by THIS request so a client disconnect rejects
    // only its own pending widget / client-tool round-trips (the Maps are
    // shared across all concurrent /api/chat requests).
    const ownedWidgetCallIds = new Set();
    const ownedClientToolCallIds = new Set();
    const ownedPermissionCallIds = new Set();
    const cancelUpstream = () => {
      if (res.writableEnded) return; // normal completion, not a real client abort
      try { upstreamAbort.abort(); } catch (_) {}
      for (const callId of ownedWidgetCallIds) {
        const pending = widgetPendingCalls.get(callId);
        if (!pending) continue;
        try { clearTimeout(pending.timer); } catch (_) {}
        try { pending.reject(new Error('Client disconnected')); } catch (_) {}
        widgetPendingCalls.delete(callId);
      }
      ownedWidgetCallIds.clear();
      for (const callId of ownedClientToolCallIds) {
        const pending = clientToolPendingCalls.get(callId);
        if (!pending) continue;
        try { clearTimeout(pending.timer); } catch (_) {}
        try { pending.reject(new Error('Client disconnected')); } catch (_) {}
        clientToolPendingCalls.delete(callId);
      }
      ownedClientToolCallIds.clear();
      for (const callId of ownedPermissionCallIds) {
        const pending = permissionPendingCalls.get(callId);
        if (!pending) continue;
        try { clearTimeout(pending.timer); } catch (_) {}
        try { pending.resolve('deny'); } catch (_) {}
        permissionPendingCalls.delete(callId);
      }
      ownedPermissionCallIds.clear();
    };
    res.on('close', cancelUpstream);
    const { messages = [], model = 'claude-sonnet-4.6', systemPrompt = '', useFigmaMCP = false, contextSummary = '',
        thinkingBudget = 'high', maxContextTurns = 20, agentName = null,
        projectId = null, projectContextIds = null, isDelegation = false,
        sourceId = null, projectSearchApply = false,
        clientContext = 'app', noTools = false,
        isolatedContext = false,
        enableDynamicWidgets = false,
        autonomousMode: bodyAutonomousMode = null,
        acceptanceCriteria: bodyAcceptance = null,
        qa: bodyQa = null,
        deploy: bodyDeploy = null,
        deployApproved: bodyDeployApproved = false,
        headlessTask: bodyHeadlessTask = false,
        toolLimits: bodyToolLimits = null,
        toolPolicy: bodyToolPolicy = null,
        selectedFigmaFileKeys = [] } = req.body;
    const isCLI = clientContext === 'cli';
    const isolateContext = isolatedContext === true || clientContext === 'automation-generator';
    const isProjectSearch = clientContext === 'project-search';

    // Effective autonomous-mode flag — explicit body value wins, then project
    // default. Per-conversation `config.autonomousMode` is forwarded by the
    // client as `autonomousMode` on the request body, so it takes precedence
    // over the project setting here. Off by default.
    let _projectAutonomous = false;
    let _projectRecord = null;
    if (projectId) {
      try { _projectRecord = getProject(projectId) || null; } catch (_) {}
      _projectAutonomous = !!_projectRecord?.autonomousMode;
    }
    let projectSearchScope = null;
    if (isProjectSearch) {
      const rejectProjectSearch = (error) => {
        res.writeHead(200, {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache',
          'Connection': 'keep-alive',
        });
        res.write(`data: ${JSON.stringify({ type: 'error', error })}\n\n`);
        res.write(`data: ${JSON.stringify({ type: 'done', finish_reason: 'project_search_rejected' })}\n\n`);
        res.end();
      };
      if (!projectId || !sourceId) {
        rejectProjectSearch('Project Search requires projectId and sourceId');
        return;
      }
      try {
        projectSearchScope = resolveProjectSourceRoot(projectId, sourceId, { localOnly: true });
      } catch (error) {
        rejectProjectSearch(error?.message || String(error));
        return;
      }
      if (projectSearchApply && !projectSearchScope.project.allowFileEditing) {
        rejectProjectSearch('File editing is disabled for this project');
        return;
      }
    }
    const autonomousMode = (bodyAutonomousMode === true || bodyAutonomousMode === false)
      ? bodyAutonomousMode
      : _projectAutonomous;

    // Acceptance criteria + QA gate (only meaningful when autonomousMode).
    // Per-conversation override wins; otherwise fall back to project record.
    const effectiveAcceptance = (typeof bodyAcceptance === 'string' && bodyAcceptance.trim())
      ? bodyAcceptance.trim()
      : (_projectRecord?.acceptanceCriteria || '').trim();
    const effectiveQa = (bodyQa && typeof bodyQa === 'object')
      ? bodyQa
      : (_projectRecord?.qa || null);
    const qaCommand = autonomousMode && effectiveQa && typeof effectiveQa.command === 'string'
      ? effectiveQa.command.trim()
      : '';

    // Deploy gate (Codex-style publish hook). Runs ONLY when autonomous,
    // a command is configured, AND the client passed deployApproved:true on
    // this request. confirm:'always' (default) requires per-run approval;
    // confirm:'never' disables the gate entirely; confirm:'once' is reserved
    // for future per-session approval and currently behaves like 'always'.
    const effectiveDeploy = (bodyDeploy && typeof bodyDeploy === 'object')
      ? bodyDeploy
      : (_projectRecord?.deploy || null);
    const deployConfirmMode = (effectiveDeploy?.confirm || 'always').toLowerCase();
    const deployCommand = autonomousMode
      && effectiveDeploy
      && typeof effectiveDeploy.command === 'string'
      && effectiveDeploy.command.trim()
      && deployConfirmMode !== 'never'
      && !!bodyDeployApproved
      ? effectiveDeploy.command.trim()
      : '';

    // Track the active conversation model so heartbeat/workflows/teams use the same one
    setActiveModel(model);

    let customizationRecords = [];
    try {
      customizationRecords = discoverCustomizations({ workspaceRoot, userConfigDir, userHome });
    } catch (_) {
      customizationRecords = [];
    }

    let activeCustomizationAgentPolicy = null;
    let effectiveToolPolicy = bodyToolPolicy;
    if (agentName) {
      try {
        activeCustomizationAgentPolicy = buildAgentPolicy(customizationRecords, { name: agentName });
        if (!effectiveToolPolicy && !activeCustomizationAgentPolicy.unrestrictedTools) {
          effectiveToolPolicy = resolveToolPolicy({ agentTools: activeCustomizationAgentPolicy.tools });
        }
      } catch (_) {
        activeCustomizationAgentPolicy = null;
      }
    }

    res.writeHead(200, {
      'Content-Type':    'text/event-stream',
      'Cache-Control':   'no-cache',
      'Connection':      'keep-alive',
      'X-Accel-Buffering': 'no',
      'Access-Control-Allow-Origin': 'http://localhost:3737'
    });

    const send = (obj) => res.write(`data: ${JSON.stringify(obj)}\n\n`);
    const latestUserText = () => {
      const lastUser = [...messages].reverse().find(m => m && m.role === 'user');
      if (typeof lastUser?.content === 'string') return lastUser.content;
      if (Array.isArray(lastUser?.content)) {
        return lastUser.content.filter(c => c && c.type === 'text').map(c => c.text || '').join('\n');
      }
      return '';
    };
    let subagentStarted = false;
    let subagentStopPayload = null;

    // SSE keep-alive: when a long tool call (or upstream silence) leaves the
    // socket without data for several seconds, Electron Chromium kills the
    // streaming fetch with `TypeError: network error`. A periodic comment
    // line keeps the chunked transfer alive without polluting the event
    // stream (clients ignore lines that don't start with `data:` / `event:`).
    const _sseHeartbeat = setInterval(() => {
      if (res.writableEnded) return;
      try { res.write(': ping\n\n'); } catch (_) {}
    }, 4000);
    res.on('close', () => clearInterval(_sseHeartbeat));

    try {
      // Resolve provider — req.body.llm picks an explicit provider/baseURL/
      // apiKey (sent by the UI when a Local model is selected). Falls back to
      // saved local-llm.json, then to Copilot. `llmSupports` is the merged
      // capability map (provider defaults + per-config overrides) and gates
      // tools/vision/usage_events later in the loop.
      const _llm = getLLMClient(req.body && req.body.llm);
      const client = _llm.client;
      const llmSupports = _llm.supports || { tools: true, vision: true, streaming: true, usageEvents: true };
      const llmProviderId = _llm.providerId;
      const llmCapabilities = resolveModelCapabilities({ providerId: llmProviderId, model, supports: llmSupports });
      const allMessages = [];

      const baseHookPayload = {
        agentName: agentName || null,
        conversationId: req.body?.conversationId || null,
        projectId: projectId || null,
        model,
        isDelegation: !!isDelegation,
        clientContext,
        prompt: latestUserText(),
      };
      const isLikelySessionStart = Array.isArray(messages) && messages.filter(m => m && m.role === 'user').length <= 1;
      if (!isolateContext && isLikelySessionStart && !isDelegation) {
        const sessionHooks = await runHooks(customizationRecords, 'SessionStart', baseHookPayload, { cwd: workspaceRoot });
        if (sessionHooks.systemMessages?.length) {
          for (const message of sessionHooks.systemMessages) allMessages.push({ role: 'system', content: String(message) });
        }
        if (sessionHooks.blocked) {
          send({ type: 'error', error: sessionHooks.stopReason || 'SessionStart hook blocked this chat turn.' });
          send({ type: 'done', finish_reason: 'hook_blocked', hook: 'SessionStart' });
          return;
        }
      }
      if (!isolateContext) {
        const submitHooks = await runHooks(customizationRecords, 'UserPromptSubmit', baseHookPayload, { cwd: workspaceRoot });
        if (submitHooks.systemMessages?.length) {
          for (const message of submitHooks.systemMessages) allMessages.push({ role: 'system', content: String(message) });
        }
        if (submitHooks.blocked) {
          send({ type: 'error', error: submitHooks.stopReason || 'UserPromptSubmit hook blocked this chat turn.' });
          send({ type: 'done', finish_reason: 'hook_blocked', hook: 'UserPromptSubmit' });
          return;
        }
      }
      if (!isolateContext && isDelegation) {
        const startHooks = await runHooks(customizationRecords, 'SubagentStart', baseHookPayload, { cwd: workspaceRoot });
        if (startHooks.systemMessages?.length) {
          for (const message of startHooks.systemMessages) allMessages.push({ role: 'system', content: String(message) });
        }
        if (startHooks.blocked) {
          send({ type: 'error', error: startHooks.stopReason || 'SubagentStart hook blocked this delegation.' });
          send({ type: 'done', finish_reason: 'hook_blocked', hook: 'SubagentStart' });
          return;
        }
        subagentStarted = true;
        subagentStopPayload = { ...baseHookPayload, startHookCount: startHooks.count };
      }

      // Build project context from active project (name, root, sources, pinned/enabled contexts)
      let projectCtx = '';
      if (!isolateContext && projectId) {
        projectCtx = projectContextIds && projectContextIds.length
          ? buildContextPayload(projectId, projectContextIds)
          : getProjectSystemContext(projectId);
      }

      // Build system prompt — append project context, facts memory, context summary and browser context.
      // Facts are scoped to the active project (with global facts always included);
      // this prevents project A's preferences from leaking into project B.
      // Sub-agent (delegation) calls still get the top-N GLOBAL facts so the
      // agent remembers user-level preferences across the call boundary; we
      // just skip project-scoped facts there to keep the delegated prompt small.
      // When the project opts into embeddings, swap in the richer profile (static + dynamic + context passages).
      let factsCtx = '';
      if (!isolateContext && !isDelegation) {
        const _memCfg = _projectRecord?.memoryConfig || {};
        if (projectId && _memCfg.embeddingsEnabled) {
          try {
            const lastUser = [...messages].reverse().find(m => m && m.role === 'user');
            const qText = typeof lastUser?.content === 'string'
              ? lastUser.content
              : Array.isArray(lastUser?.content)
                ? lastUser.content.filter(p => p?.type === 'text').map(p => p.text).join(' ')
                : '';
            const profile = await buildProjectProfile(projectId, { q: qText });
            factsCtx = formatProfileForPrompt(profile);
          } catch (_) {
            // Fall back to flat facts on any profile error.
            factsCtx = factsForSystemPrompt({
              limit: 30,
              containerTag: projectContainerTag(projectId),
              includeGlobal: true,
            });
          }
        } else {
          factsCtx = factsForSystemPrompt({
            limit: 30,
            containerTag: projectId ? projectContainerTag(projectId) : null,
            includeGlobal: true,
          });
        }
      } else {
        // Delegation path: 10 globals only, no project scoping.
        try {
          factsCtx = factsForSystemPrompt({ limit: 10, containerTag: null, includeGlobal: true });
        } catch (_) { factsCtx = ''; }
      }
      // Inject connected Figma file info so AI can target the right document
      let figmaFilesCtx = '';
      const _figmaFilesList = figma.listFiles();
      if (!isolateContext && useFigmaMCP && _figmaFilesList.length > 0) {
        const entries = _figmaFilesList.map(f => `- "${f.fileName}" (fileKey: ${f.fileKey}, page: ${f.currentPage})`).join('\n');
        figmaFilesCtx = `\n## Connected Figma Documents\nThe following Figma documents are currently open with the plugin running:\n${entries}\nWhen using figma_execute, pass the fileKey parameter to target a specific document. If omitted, the most recently active document is used.\nIMPORTANT: Dev Mode MCP tools (get_screenshot, get_design_context, get_metadata, etc.) always operate on whichever file is currently focused in Figma — they do NOT accept a fileKey parameter. If you need to read from or screenshot a specific file, use figma_execute with the fileKey parameter instead.`;
        const selected = Array.isArray(selectedFigmaFileKeys)
          ? selectedFigmaFileKeys.filter(k => typeof k === 'string' && _figmaFilesList.some(f => f.fileKey === k))
          : [];
        if (selected.length) {
          const selectedEntries = selected
            .map(k => _figmaFilesList.find(f => f.fileKey === k))
            .filter(Boolean)
            .map(f => `- "${f.fileName}" (fileKey: ${f.fileKey}, page: ${f.currentPage})`)
            .join('\n');
          figmaFilesCtx += `\n\n## User-selected Figma Targets\nPrefer these files for write actions in this turn:\n${selectedEntries}\nWhen calling figma_execute without fileKey:\n- If exactly one selected file exists, use it.\n- If multiple selected files exist, prefer the most recently active selected file.`;
        }
      }
      let mcpTools;
      const customMcpToolNames = new Set();
      let customMcpCtx = '';
      if (!isolateContext && !isCLI && !noTools && customMcp?.getTools) {
        try {
          const customTools = await customMcp.getTools({ autoStartEnabled: true });
          if (Array.isArray(customTools) && customTools.length) {
            mcpTools = [...(mcpTools || []), ...customTools];
            for (const tool of customTools) {
              const name = tool?.function?.name || tool?.name;
              if (name) customMcpToolNames.add(name);
            }
          }
        } catch (e) {
          console.warn('[chat] custom MCP tool discovery failed:', e?.message || e);
        }
        try {
          if (customMcp?.getStatus) customMcpCtx = buildCustomMcpContext(await customMcp.getStatus({ includeTools: true }));
        } catch (e) {
          console.warn('[chat] custom MCP status failed:', e?.message || e);
        }
      }
      const cliHint = isCLI ? `\n\n## Output Format\nYou are running in a terminal CLI. Respond in plain, readable text. Do NOT use markdown headers (###), horizontal rules (---), or emojis. Use plain bullet points (- or *) only when a list genuinely helps. Be concise and direct. Never emit browser-action or browser-ext-action code blocks — those do not work in the terminal.` : '';
      // Sub-agents (isDelegation=true) need to know about the same browser /
      // browser-ext / gen-UI tooling the orchestrator has, otherwise they
      // refuse tasks that depend on those tools ("I only have fauna_browser,
      // not browser-ext-action"). The token cost is small; skipping it
      // breaks orchestrator pipelines that hand off browsing work.
      // Codex-parity: re-inject the active plan (from fauna_plan / update_plan)
      // into every turn's system prompt. Cheap (<200 tokens for typical plans)
      // and keeps the model honest about what's done vs. pending without
      // forcing it to re-derive that from the transcript.
      let activePlanCtx = '';
      try {
        const _planConvId = isolateContext ? null : (req.body?.conversationId || null);
        const _activePlan = _planConvId ? getActivePlanForConv(_planConvId) : null;
        if (_activePlan && Array.isArray(_activePlan.items) && _activePlan.items.length) {
          const _statusGlyph = (s) => s === 'completed' ? '[x]'
                                : s === 'in_progress' ? '[~]'
                                : s === 'cancelled' ? '[-]'
                                : '[ ]';
          const lines = _activePlan.items.slice(0, 30).map(it =>
            `${_statusGlyph(it.status)} ${String(it.title || '').slice(0, 180)}`
          ).join('\n');
          activePlanCtx =
            '\n## Active Plan (from fauna_plan — DO NOT restate, just keep advancing it)\n' +
            (_activePlan.explanation ? _activePlan.explanation + '\n' : '') +
            lines +
            '\n\nRules: exactly one item may be `in_progress` at a time. Flip a step to `completed` BEFORE starting the next. Do not jump pending → completed. If scope changes, call `fauna_plan` again with the same items + status updates (or appended new items) — never replace the list with a disjoint one.';
        }
      } catch (_) { /* non-fatal */ }

      // ── Shell-exec reminder (one-shot, only when the previous turn went wrong) ──
      // If the last assistant message contains an empty ```bash``` / ```shell-exec```
      // fence, OR a "paste the output" / "run this and let me know" prose pattern
      // — i.e. the model wasted the user's turn by asking instead of acting — inject
      // a sharp reminder so it doesn't repeat the mistake. Skipped when there is no
      // prior assistant message yet.
      let shellExecReminder = '';
      try {
        const _lastAssistant = (() => {
          for (let i = messages.length - 1; i >= 0; i--) {
            const m = messages[i];
            if (m && m.role === 'assistant') return m;
          }
          return null;
        })();
        const _lastTxt = (() => {
          const c = _lastAssistant?.content;
          if (typeof c === 'string') return c;
          if (Array.isArray(c)) {
            return c.map(p => (p && p.type === 'text') ? (p.text || '') : '').join('\n');
          }
          return '';
        })();
        if (!isolateContext && _lastTxt) {
          const _emptyBashRe   = /```(?:bash|shell-exec|shell_exec|sh|zsh)[ \t]*\r?\n[\s\r\n]*```/i;
          const _askToRunRe    = /\b(paste the output|let me know (?:what|when|if).{0,40}(?:output|see|happens)|run (?:this|the (?:above|following|build|typecheck|test|command)).{0,80}(?:and (?:paste|share|tell|let)|then (?:paste|share|tell|let))|run.{0,40}from the repo root.{0,40}(?:and|so I))/i;
          const _hadEmpty = _emptyBashRe.test(_lastTxt);
          const _hadAsk   = _askToRunRe.test(_lastTxt);
          if (_hadEmpty || _hadAsk) {
            shellExecReminder =
              '\n## ⚠️ SHELL-EXEC REMINDER (your previous turn violated the rule)\n' +
              'Your last assistant message ' +
              (_hadEmpty ? 'contained an EMPTY ```bash``` block (no command inside). ' : '') +
              (_hadAsk   ? 'asked the user to "run X and paste the output". ' : '') +
              'You have the `fauna_shell_exec` tool — CALL IT yourself. ' +
              'Do not emit prose asking the user to do shell work for you. ' +
              'Do not emit empty fenced blocks. Do not say "I do not have the output" — that is your fault, not theirs. ' +
              'For THIS turn: call `fauna_shell_exec` with the real command, wait for the output, then continue.';
          }
        }
      } catch (_) { /* non-fatal */ }

      // Compute gating flags once so the array below can read them without
      // calling computeContextFlags multiple times.
      const _ctxFlags = (function () {
        try {
          return computeContextFlags({ messages, systemPrompt, isDelegation, isCLI, noTools });
        } catch (_) {
          return { genui: true, browser: true, frontend: true };
        }
      })();

      // When the user has explicitly enabled Dynamic Widgets in Settings,
      // they want fauna_emit_widget available across the whole conversation
      // — not gated on keyword matches in the latest user turn. Force the
      // genui catalog on so the model sees the bundle.html / Three.js rules
      // and knows it CAN call fauna_emit_widget; otherwise the short-hint
      // path actively forbids `gen-ui` blocks and the model degrades to
      // plain text. Skip for delegation / CLI surfaces (no rendering target).
      if (enableDynamicWidgets && !isDelegation && !isCLI && !noTools) {
        _ctxFlags.genui = true;
      }

      // Cache-stable layout (headroom CacheAligner idea): the provider's
      // prompt cache only hits while the PREFIX stays byte-identical across
      // turns. So we group blocks into three zones, most-stable first:
      //   1. STABLE PREFIX  — constant for the whole conversation/session.
      //   2. MONOTONIC DOCS — gated capability docs that flip on once and
      //      then stay (sticky), so they extend the cacheable region.
      //   3. VOLATILE SUFFIX — project state, facts, summaries, plan: these
      //      change turn-to-turn, so they go last where a cache miss is cheap.
      const fullSystem = [
        systemPrompt,
        // ── 1. STABLE PREFIX ───────────────────────────────────────────────
        // Core guidelines: persistence, formatting, frontend quality, search defaults.
        // Baked into every conversation (skipped for delegation sub-agents to save tokens —
        // the orchestrator already enforces these and re-stating them in delegates wastes context).
        (isolateContext || isDelegation) ? '' : FAUNA_CORE_GUIDELINES,
        // When running against a local model that doesn't support OpenAI tool
        // calling, tell it explicitly — otherwise it will hallucinate tool
        // invocations in prose. Constant per session, so it lives in the prefix.
        (!isolateContext && !llmSupports.tools && llmProviderId !== 'copilot')
          ? '\n## Tool Availability\nYou are running on a local model that does not support tool calls in this session. Do NOT pretend to call shell, browser, file, or MCP tools — there is no execution environment. Answer the user directly in plain text or markdown. If the user asks for an action requiring tools, tell them to switch to a Copilot model.'
          : '',
        // Autonomous mode adds the DONE/BLOCKED/NEEDS-INPUT marker contract,
        // acceptance criteria, and QA gate. Constant for the whole run, so it
        // belongs in the stable prefix (acceptance criteria are fixed up-front).
        (!isolateContext && autonomousMode)
          ? '\n## Autonomous Completion Contract\nThis conversation is running until done. Your FINAL message MUST start with exactly one of these markers on its own line: `DONE:` (work verified complete), `BLOCKED:` (cannot proceed without external action), or `NEEDS-INPUT:` (require user info). After the marker, list which acceptance criteria you verified and how.'
            + (effectiveAcceptance ? `\n\n## Acceptance Criteria\n${effectiveAcceptance}\n\nDo not emit DONE: until every criterion above is verifiably satisfied. Cite the verification (tool output, test run, file path) for each one in your final message.` : '')
            + (qaCommand ? `\n\n## QA Gate\nBefore you emit DONE:, fauna will automatically run \`${qaCommand}\` and feed the result back as a tool message. If it fails, you must address the failure and continue — do NOT emit DONE: on a failing QA run.` : '')
            + (deployCommand ? `\n\n## Deploy Gate\nThe user has APPROVED deploying this run. After QA passes (or after DONE: when no QA is configured), fauna will automatically run \`${deployCommand}\`. Treat the deploy output as part of the verification — if it fails, do NOT emit DONE: until the deploy succeeds or you escalate with BLOCKED:.` : '')
          : '',
        // ── 2. MONOTONIC capability docs ───────────────────────────────────
        // Codex-parity: heavy capability docs (gen-ui catalog ~5k, browser
        // ~1.5k, frontend quality ~400) are injected only when the current
        // turn or conversation actually needs them (see _ctxFlags above).
        // Saves ~6k tokens on a typical "explain this code" turn. The sticky
        // flags make these monotonic (once on, stay on) so they sit right
        // after the stable prefix and rarely break the cache once present.
        (isolateContext || isCLI || noTools) ? '' : (_ctxFlags.browser ? browserBuildContext : ''),
        (isolateContext || isCLI || noTools) ? '' : (_ctxFlags.browser ? buildBrowserExtContext() : ''),
        (isolateContext || isDelegation || isCLI || noTools) ? '' : (_ctxFlags.genui ? GEN_UI_CATALOG_PROMPT : GEN_UI_SHORT_HINT),
        (isolateContext || isDelegation || !_ctxFlags.frontend) ? '' : FAUNA_FRONTEND_QUALITY,
        // ── 3. VOLATILE SUFFIX ─────────────────────────────────────────────
        // These change turn-to-turn (project edits, fact access/scoring,
        // growing summary, plan updates), so a cache miss here is unavoidable
        // and cheap — keep them last to protect the cacheable prefix above.
        (isolateContext || isDelegation) ? '' : projectCtx,
        factsCtx,
        (!isolateContext && contextSummary) ? `\n## Task Context (auto-summarized from earlier conversation)\n${contextSummary}` : '',
        activePlanCtx,
        shellExecReminder,
        figmaFilesCtx,
        customMcpCtx,
      ].filter(Boolean).join('\n');
      if (fullSystem) allMessages.push({ role: 'system', content: fullSystem });

      // ── Context trimming (token-aware, scoped) ───────────────────────────
      // Budget is computed per-model: window − systemTokens − reservedOutput,
      // then scaled by the model's compactAt threshold.  Body messages must
      // fit inside `bodyTokenLimit`; the system prompt is NOT charged.
      const systemTokens   = estimateTokens(fullSystem);
      const budget         = computeBudget({ model, systemTokens });
      const MAX_MSG_TOKENS = 8_000; // cap any single message (~30KB of text)
      const TURN_LIMIT     = maxContextTurns >= 100 ? Infinity : maxContextTurns;

      // 1. Strip old image payloads and cap oversized messages (token-based)
      const stripped = messages.map((m, i) => {
        let content = m.content;

        // Strip image bytes from non-latest vision messages
        if (Array.isArray(content) && i < messages.length - 1) {
          const textOnly = content.filter(c => c.type === 'text').map(c => c.text).join('\n');
          content = textOnly + '\n[screenshot attached earlier — not repeated]';
        }

        // Cap any single message at MAX_MSG_TOKENS (shell outputs can be huge).
        // We cap by characters using the same heuristic the estimator uses so
        // the post-cap message reliably fits under the token limit.
        if (typeof content === 'string') {
          const tokens = estimateTokens(content);
          if (tokens > MAX_MSG_TOKENS) {
            const charCap = MAX_MSG_TOKENS * 4; // headroom over CHARS_PER_TOKEN
            content = content.slice(0, charCap) +
              `\n…[truncated — ${tokens - MAX_MSG_TOKENS} tokens omitted]`;
          }
        }

        return { ...m, content };
      });

      // 2. Always keep first msg + as many recent msgs as fit within token budget
      const first = stripped[0];
      const rest  = stripped.slice(1);

      // 2a. Auto-compaction (Phase 3). When the total body would blow the
      // budget, summarize the middle slice into a single synthetic system
      // message before the keep-recent loop runs.  Safeguards:
      //   - default ON; opt out via FAUNA_AUTO_COMPACT=0 or autoCompact:false
      //   - never summarizes the last `KEEP_TAIL` messages (current turn)
      //   - never re-summarizes a slice that already contains a context_summary
      //   - on summarizer failure, falls back silently to plain trimming
      const autoCompactEnabled = (
        process.env.FAUNA_AUTO_COMPACT !== '0' &&
        req.body?.autoCompact !== false
      );
      const KEEP_TAIL = 4;
      const totalBodyTokens = stripped.reduce((acc, m) => acc + estimateTokens(m), 0);
      let compactedInfo = null;
      const compactHookSystemMessages = [];
      const _overBudget = totalBodyTokens > budget.bodyTokenLimit;
      if (autoCompactEnabled && _overBudget && rest.length > KEEP_TAIL + 4) {
        const middle = rest.slice(0, -KEEP_TAIL);
        const alreadyHasSummary = middle.some(m => m && m.name === 'context_summary');
        console.log(`[chat] auto-compact: bodyTokens=${totalBodyTokens} > limit=${budget.bodyTokenLimit}, summarizing ${middle.length} msgs (skip=${alreadyHasSummary})`);
        if (!alreadyHasSummary) {
          // Bound the summarizer call so it can't stall the main turn.
          const _compactTimeout = setTimeout(() => {
            try { upstreamAbort.abort(); } catch (_) {}
          }, 30_000);
          const _compactAbort = new AbortController();
          const _onMainAbort = () => { try { _compactAbort.abort(); } catch (_) {} };
          upstreamAbort.signal.addEventListener('abort', _onMainAbort, { once: true });
          try {
            const compactHooks = await runHooks(customizationRecords, 'PreCompact', {
              ...baseHookPayload,
              messageCount: middle.length,
              totalBodyTokens,
              bodyTokenLimit: budget.bodyTokenLimit,
            }, { cwd: workspaceRoot });
            if (compactHooks.systemMessages?.length) {
              for (const message of compactHooks.systemMessages) compactHookSystemMessages.push(String(message));
            }
            if (compactHooks.blocked) {
              console.log('[chat] PreCompact hook blocked auto-compaction:', compactHooks.stopReason || 'blocked');
              throw new Error('__FAUNA_PRECOMPACT_BLOCKED__');
            }
            send({ type: 'context_compacting', count: middle.length });
            const summary = await Promise.race([
              summarizeHistory(middle, {
                client,
                model: 'gpt-4o-mini',
                signal: _compactAbort.signal,
              }),
              new Promise(resolve => setTimeout(() => resolve(''), 25_000)),
            ]);
            if (summary && summary.length > 50) {
              const synthetic = {
                role: 'system',
                name: 'context_summary',
                content:
                  `## Conversation Summary (compacted ${middle.length} earlier messages)\n` +
                  summary +
                  '\n\n---\n' +
                  'IMPORTANT: This summary is a compressed view of earlier turns. ' +
                  'Do NOT assume any task is complete based on this summary alone. ' +
                  'If items appear under "OPEN / UNVERIFIED", treat them as still pending. ' +
                  'Before reporting success, re-verify by reading current file state or running the relevant commands again.',
              };
              stripped.splice(1, middle.length, synthetic);
              rest.length = 0;
              for (let i = 1; i < stripped.length; i++) rest.push(stripped[i]);
              compactedInfo = {
                before: middle.length,
                after: 1,
                summaryTokens: estimateTokens(synthetic),
                summary,
              };
              console.log(`[chat] auto-compacted ${middle.length} msgs → 1 summary (${compactedInfo.summaryTokens}t)`);
            } else {
              console.log('[chat] auto-compact produced empty summary; falling back to plain trim');
            }
          } catch (e) {
            if (e?.message !== '__FAUNA_PRECOMPACT_BLOCKED__') {
              console.warn('[chat] auto-compaction failed, continuing with plain trim:', e?.message || e);
            }
          } finally {
            clearTimeout(_compactTimeout);
            upstreamAbort.signal.removeEventListener('abort', _onMainAbort);
          }
        }
      }

      const recent = [];
      let bodyTokens = first ? estimateTokens(first) : 0;
      for (let i = rest.length - 1; i >= 0; i--) {
        if (recent.length >= TURN_LIMIT) break;
        const t = estimateTokens(rest[i]);
        if (bodyTokens + t > budget.bodyTokenLimit) break;
        recent.unshift(rest[i]);
        bodyTokens += t;
      }
      const trimmed = first ? [first, ...recent] : recent;
      for (const message of compactHookSystemMessages) allMessages.push({ role: 'system', content: message });
      allMessages.push(...trimmed);

      // Set true when the latest user message reads as a circuit/schematic
      // request — consumed by the post-stream hand-authored-SVG verifier.
      let circuitRequested = false;
      // New-project scaffolding guard: when the user asks to create/scaffold a
      // new project but no project is active, force a fresh cwd so commands
      // do not bleed into unrelated existing repos.
      let scaffoldIntentActive = false;
      let scaffoldIntentCwd = null;

      // ── Per-turn tool nudge: circuits / schematics ────────────────────────
      // The model frequently tries to answer schematic requests analytically and
      // skips the render tool. When the latest user message clearly asks for a
      // schematic, force a system reminder so the next assistant step calls the
      // tools instead of dumping prose or raw SVG.
      try {
        const lastUser = [...messages].reverse().find(m => m && m.role === 'user');
        const lastText = typeof lastUser?.content === 'string'
          ? lastUser.content
          : Array.isArray(lastUser?.content)
            ? lastUser.content.filter(c => c.type === 'text').map(c => c.text).join('\n')
            : '';
        const CIRCUIT_RE = /\b(schematic|circuit|wiring diagram|netlist|breadboard|rc (low|high)[- ]?pass|low[- ]?pass filter|high[- ]?pass filter|band[- ]?pass|op[- ]?amp|555 timer|transistor amp(?:lifier)?|amplifier|voltage divider|voltage regulator|power supply|\bpsu\b|inverter|oscillator|multivibrator|astable|h[- ]?bridge|full[- ]?bridge|half[- ]?bridge|push[- ]?pull|darlington|schmitt trigger|comparator|led driver|relay driver|buck converter|boost converter|buck[- ]?boost|rectifier|flip[- ]?flop|d[- ]?type latch|wheatstone bridge|common[- ]?(emitter|collector)|kicad|spice)\b/i;
        const PCB_RE = /\b(pcb|printed circuit board|board layout|copper (trace|pour|layer)|etch(?:ing|ed)?|solder(?:ing)?|trace routing|autoroute|footprint|land pattern|gerber|silkscreen|bill of materials|\bbom\b|build guide|assembly (guide|instructions))\b/i;
        const NEW_PROJECT_RE = /\b(create|scaffold|start|spin up|initialize|init|bootstrap|set up)\b[\s\S]{0,60}\b(new|fresh)\b[\s\S]{0,40}\b(project|app|workspace|repo|repository)\b|\bnew\s+(project|app|workspace|repo|repository)\b/i;
        if (lastText && NEW_PROJECT_RE.test(lastText) && !projectId && !isCLI && !noTools) {
          scaffoldIntentActive = true;
          try {
            const base = path.join(os.homedir(), 'Documents', 'Fauna');
            fs.mkdirSync(base, { recursive: true });
            const dir = path.join(base, 'Scaffold-' + Date.now().toString(36));
            fs.mkdirSync(dir, { recursive: true });
            scaffoldIntentCwd = dir;
          } catch (_) {
            scaffoldIntentCwd = path.join(os.homedir(), 'Documents', 'Fauna');
          }
          allMessages.push({
            role: 'system',
            content:
              '[New-project scaffold request detected] The user asked for a fresh project. Do NOT edit or run commands inside pre-existing repositories unless the user explicitly names that path. ' +
              'Default working directory for this turn is: ' + scaffoldIntentCwd + '. ' +
              'First step must be scaffolding the new project in this directory (or a child directory), then continue implementation there.'
          });
        }
        if (lastText && PCB_RE.test(lastText) && !isCLI && !noTools) {
          allMessages.push({
            role: 'system',
            content:
              '[PCB / board / soldering / build-guide request detected] Use the board tools. Required sequence for THIS turn:\n' +
              '1. (Optional) fauna_list_circuit_symbols / fauna_list_footprints — only if unsure of pins or available parts.\n' +
              '2. fauna_layout_pcb({ doc }) — places footprints and auto-routes copper traces (etchings); returns the board model. Reuse the SAME `doc` you would pass to fauna_render_circuit.\n' +
              '3. fauna_check_board({ board }) — run DRC; surface any clearance/unrouted violations.\n' +
              '4. (Optional) fauna_build_guide({ doc }) — for BOM / assembly order / soldering steps / sim-backed test readings; render its `markdown` in your answer.\n' +
              '5. Write the prose answer FIRST (board summary, layer notes, any DRC findings, BOM/steps if a guide was requested).\n' +
              '6. Then call fauna_render_pcb({ board }) and emit ONE gen-ui block at the END whose root contains the returned SVG: { "type":"SVG", "props":{ "markup":"<svg …>…</svg>" } }.\n' +
              'Forbidden: pasting raw <svg> into a code fence; inventing copper/footprints without the tools; placing the board SVG above the analysis.'
          });
        }
        if (lastText && CIRCUIT_RE.test(lastText) && !isCLI && !noTools) {
          circuitRequested = true;
          allMessages.push({
            role: 'system',
            content:
              '[Circuit/schematic request detected] You MUST render this using the circuit tools. Required sequence for THIS turn:\n' +
              '1. (Optional) fauna_list_circuit_symbols — only if you are unsure of pin names.\n' +
              '2. fauna_render_circuit({ doc }) — returns { svg, width, height }.\n' +
              '3. fauna_validate_circuit({ doc }) — surface any errors/warnings.\n' +
              '4. (Optional) fauna_simulate_circuit({ doc, analysis }) — for behaviour questions; if ngspice is missing, surface the install hint and continue with the analytical answer.\n' +
              '5. Write the prose answer FIRST (component values, expected behaviour, key formulas, SPICE netlist if relevant).\n' +
              '6. Then, at the END of the message, emit ONE gen-ui block whose root contains an SVG element: { "type":"SVG", "props":{ "markup":"<svg …>…</svg>" } } using the markup returned by fauna_render_circuit verbatim. The schematic should be the LAST thing in the message, not the first.\n' +
              'Forbidden: hand-authoring or hand-positioning your own <svg> markup instead of using fauna_render_circuit\'s output (this is slow and renders warped); pasting the raw <svg> into a plaintext/html/markdown code fence; describing the schematic without calling fauna_render_circuit; computing analytically only; placing the gen-ui SVG block above the analysis.'
          });
        }

        // ── Bare-continuation nudge ────────────────────────────────────────
        // When the user replies with just "continue" / "go" / "keep going" /
        // "next" etc., it's prima facie evidence the previous turn under-
        // delivered (made a forward promise, asked a question, or stopped
        // mid-task). Inject a strong directive so the model proceeds with
        // tools immediately instead of producing yet another status report.
        // The user-side message stays untouched in the transcript — this is
        // an additional system message the model sees BEFORE its reply.
        // Repro: case-study transcript where the user typed "continue" twice
        // and got two more "I've now confirmed …" preambles in response.
        const BARE_CONTINUE_RE = /^\s*(?:(?:please|pls|just|ok(?:ay)?|yes|yep|y|sure|cool)[ ,.!]*)?(?:continue|go(?:\s+on)?|keep\s+going|keep\s+at\s+it|proceed|next|carry\s+on|do\s+it|go\s+ahead|finish|complete)[ .!?]*$/i;
        if (lastText && BARE_CONTINUE_RE.test(lastText) && !isCLI && !noTools) {
          allMessages.push({
            role: 'system',
            content:
              '[Bare-continuation reply detected] The user typed only "' + lastText.trim().slice(0, 40) + '" — they are forced to ask because the previous turn did not deliver. Do NOT write a status update, a plan recap, or an "I have confirmed / hypothesis / next action" preamble. Take the next concrete tool action toward the ORIGINAL request right now and only respond with prose once you have something to show (a created file, a finished artifact, a verified result). If the original task requires writing files, write them this turn.'
          });
        }
      } catch (_) { /* non-fatal */ }
      console.log(
        `[chat] context: ${trimmed.length}/${messages.length} msgs, ` +
        `~${bodyTokens}/${budget.bodyTokenLimit} body tokens ` +
        `(sys: ${systemTokens}t, model: ${budget.matched}, window: ${budget.window})`
      );
      if (compactedInfo) {
        send({
          type: 'context_compacted',
          before: compactedInfo.before,
          after: compactedInfo.after,
          summaryTokens: compactedInfo.summaryTokens,
          summary: compactedInfo.summary,
          bodyTokens,
          limit: budget.bodyTokenLimit,
        });
      }

      // Fetch Figma MCP tools and inject layout knowledge if requested
      if (useFigmaMCP) {
        let figmaMcpTools;
        try { figmaMcpTools = await figma.getMcpTools(); } catch (_) {
          // Fallback: always expose figma_execute even when port-3845 is unavailable
          figmaMcpTools = [];
        }
        // figma_execute (plugin bridge) is independent of the Dev Mode MCP
        // server on port 3845 — it talks to the Figma plugin directly via the
        // local relay. Always expose it whenever Figma is enabled, otherwise
        // the model receives Dev Mode tools (which need the file focused in
        // Figma desktop) but cannot script the plugin, leading to the
        // "I don't have a figma_execute tool" failure mode.
        if (!Array.isArray(figmaMcpTools)) figmaMcpTools = [];
        if (!figmaMcpTools.some(t => t && t.function && t.function.name === 'figma_execute')) {
          figmaMcpTools.push(figma.executeToolDef);
        }
        for (const tool of figmaMcpTools) {
          const name = tool?.function?.name || tool?.name;
          if (name) customMcpToolNames.delete(name);
        }
        mcpTools = [...figmaMcpTools, ...(mcpTools || [])];
      }

      // Load agent tools if an agent is active
      let agentToolHandlers = null; // Map<name, executeFn>
      let isOrchestratorTurn = false; // hoisted so the post-stream recovery loop can see it
      let orchestratorSubAgentNames = []; // hoisted for the [DELEGATE:] validation nudge
      if (agentName) {
        const safeAgentName = agentName.replace(/[^a-zA-Z0-9_-]/g, '');
        const agentDir = path.join(agentsDir, safeAgentName);
        const manifestPath = path.join(agentDir, 'agent.json');
        let manifest = null;

        // Try to load installed agent manifest
        if (fs.existsSync(manifestPath)) {
          try { manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8')); } catch (_) {}
        }

        // For built-in agents, use the permissions from the request body.
        // For delegated sub-agents, the orchestrator's permissions are merged
        // into req.body.agentPermissions client-side — those represent what
        // the user actually approved, so they win over the sub-agent's
        // (often empty) stored manifest.
        const permissions = isProjectSearch
          ? {
              fileRead: [projectSearchScope.root],
              fileWrite: projectSearchApply ? [projectSearchScope.root] : [],
              shell: false,
              browser: false,
              figma: false,
              network: { blockAll: true },
            }
          : isDelegation
          ? (req.body.agentPermissions || manifest?.permissions || {})
          : (manifest?.permissions || req.body.agentPermissions || {});
        if (!manifest && activeCustomizationAgentPolicy) {
          manifest = {
            name: activeCustomizationAgentPolicy.name,
            displayName: activeCustomizationAgentPolicy.name,
            description: activeCustomizationAgentPolicy.description,
            systemPrompt: activeCustomizationAgentPolicy.systemPrompt,
            permissions: {},
            _customizationAgent: true,
          };
        }

        const effectiveManifest = manifest
          ? Object.assign({}, manifest, { permissions })
          : { name: safeAgentName, permissions };

        const { definitions: agentToolDefs, handlers } = getAgentTools(
          fs.existsSync(agentDir) ? agentDir : null,
          effectiveManifest,
          safeAgentName,
          { builtInsOnly: isProjectSearch }
        );
        agentToolHandlers = handlers;

        // Orchestrators are dispatch-only: they MUST emit [DELEGATE:...] blocks
        // and never call tools themselves. If we leave the built-in tool defs
        // (agent_shell_exec / agent_fetch_url / file ops) in the catalog, the
        // model treats them as the available toolset and drifts into "I only
        // have shell and fetch, I can't do figma" instead of delegating. This
        // mirrors the client-side `noTools=true` intent — strip them on the
        // server side too. Sub-agents invoked via runOne() are NOT orchestrators
        // themselves and still get their full toolset.
        const isOrchestratorTurnLocal = !!(effectiveManifest.orchestrator) && !isDelegation;
        isOrchestratorTurn = isOrchestratorTurnLocal;
        const filteredAgentToolDefs = isOrchestratorTurnLocal ? [] : agentToolDefs;
        if (isOrchestratorTurnLocal && agentToolDefs.length) {
          console.log(`[chat] orchestrator "${safeAgentName}" — stripping ${agentToolDefs.length} built-in agent tools (dispatch-only)`);
        }

        // Enumerate the orchestrator's bundled sub-agent names so the post-stream
        // validator can detect when the model emits [DELEGATE:agents/<bogus>] for
        // an agent that does not exist (the client-side parseDelegations silently
        // drops such blocks, leaving the user with an apparently stalled response).
        if (isOrchestratorTurnLocal) {
          try {
            let subRefs = Array.isArray(effectiveManifest.agents) ? effectiveManifest.agents.slice() : null;
            if (!subRefs) {
              const agentsSubDir = path.join(agentDir, 'agents');
              if (fs.existsSync(agentsSubDir) && fs.statSync(agentsSubDir).isDirectory()) {
                subRefs = fs.readdirSync(agentsSubDir).filter(d => {
                  try { return fs.existsSync(path.join(agentsSubDir, d, 'agent.json')); } catch (_) { return false; }
                }).map(d => 'agents/' + d);
              }
            }
            if (subRefs && subRefs.length) {
              for (const subRef of subRefs) {
                const subManifestPath = path.join(agentDir, subRef, 'agent.json');
                if (fs.existsSync(subManifestPath)) {
                  try {
                    const sub = JSON.parse(fs.readFileSync(subManifestPath, 'utf8'));
                    if (sub && sub.name) orchestratorSubAgentNames.push(sub.name);
                  } catch (_) {}
                }
              }
            }
          } catch (_) {}
        }

        // Merge agent tools with MCP tools
        const allTools = [...(isProjectSearch ? [] : (mcpTools || [])), ...filteredAgentToolDefs];
        if (allTools.length) mcpTools = allTools;

        // Start any MCP servers the agent requires
        if (effectiveManifest.permissions?.mcp?.length) {
          try { await startAgentMCPServers(effectiveManifest, safeAgentName); } catch (_) {}
        }

        console.log(`[chat] Agent "${safeAgentName}" active — ${agentToolDefs.length} tools registered`);
      }

      // ── Self-tools — LLM-callable tools (memory, models, settings, etc.) ──
      // Live widget registry — persists across the chat turn so save-to-playbook
      // and ephemeral tool dispatch can look up the widget bundle.
      const liveWidgets = new Map(); // widgetId → { widgetId, tools, bundle }
      // Pre-seed from message history so saved widgets survive multi-turn conversations.
      for (const reg of extractWidgetRegistrations(allMessages)) {
        liveWidgets.set(reg.widgetId, reg);
      }

      const selfToolContext = {
        getModels: () => FALLBACK_MODELS,
        activeProjectId: projectId || null,
        convId: req.body?.conversationId || null,
        activeAgentName: agentName || null,
        agentsDir,
        getSettings: () => ({
          model,
          thinkingBudget,
          maxContextTurns,
          figmaMCPEnabled: useFigmaMCP,
          enableDynamicWidgets,
          factsCount: factsGetStats().total,
        }),
        sendToRenderer: (channel, data) => {
          try {
            const wins = getMainWindows() || [];
            for (const w of wins) w.webContents?.send?.(channel, data);
          } catch (_) {}
        },
        sendNotification: (title, body) => {
          try { sendNotification(title, body); }
          catch (_) { console.log(`[notification] ${title}: ${body}`); }
        },
        sendSse: (obj) => send(obj),
        registerLiveWidget: (id, reg) => liveWidgets.set(id, reg),
        getLiveWidget: (id) => liveWidgets.get(id) || null,

        // fauna_shell_exec adapter — runs server-side, refuses unsafe commands
        // so the user keeps the markdown ```bash review path for risky ops.
        runShell: async ({ command, cwd, timeoutMs, maxOutputBytes, reason } = {}) => {
          if (!shellBin) {
            return JSON.stringify({ ok: false, error: 'shell exec not configured in this server' });
          }
          if (!command || typeof command !== 'string') {
            return JSON.stringify({ ok: false, error: 'command (string) required' });
          }
          // When the model doesn't pin a cwd, default to the ACTIVE PROJECT's
          // root rather than $HOME. Otherwise commands run from the home dir,
          // the model has to guess paths, and it can stray into a different
          // project's directory (cross-project context bleed). An explicit
          // cwd from the model always wins.
          let effectiveCwd = cwd;
          if (!effectiveCwd && scaffoldIntentCwd) {
            effectiveCwd = scaffoldIntentCwd;
          }
          if (!effectiveCwd && _projectRecord?.rootPath) {
            try {
              if (fs.existsSync(_projectRecord.rootPath)) effectiveCwd = _projectRecord.rootPath;
            } catch (_) { /* ignore — fall back below */ }
          }
          // (No safe-list gate. The agent runs whatever command the model asks for.)
          // Dev/preview servers (npm run dev, vite, next dev, php -S, …)
          // would block the AI turn forever waiting for stdout to close.
          // Detach them, register with the global Dev Servers registry, and
          // return immediately so the AI can move on. The user manages the
          // process from Settings → Dev Servers.
          if (isDevServerCommand(command)) {
            const workDir = effectiveCwd || os.homedir();
            const env = {
              ...process.env,
              ...(augmentedPath ? { PATH: augmentedPath } : {}),
              HOME: os.homedir(),
              USER: os.userInfo().username,
              ...(isWin ? {} : { SHELL: '/bin/zsh', TERM: 'xterm-256color' }),
            };
            const child = _spawnDetached(
              shellBin,
              isWin ? ['-Command', command] : ['-c', command],
              { cwd: workDir, env, stdio: ['pipe', 'pipe', 'pipe'] },
            );
            try { registerDevServer(child, { command, cwd: workDir }); } catch (_) {}
            // Surface a tool_call note in the UI without waiting.
            try { send({ type: 'tool_output', output: 'Dev server started in background — manage from Settings → Dev Servers.\n', stream: 'stdout' }); } catch (_) {}
            return JSON.stringify({
              ok: true,
              backgrounded: true,
              command,
              cwd: workDir,
              note: 'Dev server started in the background and tracked in the Dev Servers registry. The user can stop/restart it from Settings → Dev Servers. Do NOT wait for it to exit; continue with the next plan step.',
            });
          }
          // (No tool_call SSE emit here — the outer dispatcher in chat.js
          // already sends one event per call. Emitting again here caused a
          // visible duplicate in the client status panel.)
          const result = await runShell({
            command,
            cwd: effectiveCwd,
            shellBin,
            isWin,
            augmentedPath,
            timeoutMs: typeof timeoutMs === 'number' ? Math.min(timeoutMs, 600000) : undefined,
            maxOutputChars: typeof maxOutputBytes === 'number' && maxOutputBytes > 0
              ? Math.min(maxOutputBytes, 500_000)
              : undefined,
            signal: upstreamAbort.signal,
            onChunk: (kind, text) => {
              // Forward live stdout/stderr to the client via the existing
              // tool_output SSE channel — it renders into a ```shell-output
              // collapsible block inside the assistant message.
              try { send({ type: 'tool_output', output: text, stream: kind }); } catch (_) {}
            },
            registerChild: shellProcs ? (child) => {
              const id = 'tool_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 6);
              shellProcs.set(id, child);
              child.on('exit', () => shellProcs.delete(id));
              try { registerDevServer(child, { command, cwd: effectiveCwd, killId: id }); } catch (_) {}
            } : (child) => {
              try { registerDevServer(child, { command, cwd: effectiveCwd }); } catch (_) {}
            },
          });
          // Surface any presentable files this command created as entity cards.
          // Only on a clean exit so we don't card partial/failed output.
          if (result && result.exitCode === 0 && !result.killed && !result.timedOut) {
            try {
              for (const art of detectShellArtifacts(command, result.cwd || effectiveCwd)) {
                send({ type: 'artifact_created', path: art.path, artType: art.type });
              }
            } catch (_) { /* non-fatal */ }
          }
          return formatShellResultForLLM(result);
        },

        // fauna_apply_patch adapter — synchronous, throws on failure
        applyPatch: ({ patch, cwd } = {}) => {
          if (!patch) throw new Error('patch (string) required');
          return applyPatchText(patch, cwd, null);
        },

        // Generic client-tool RPC — lets self-tools delegate to the renderer.
        // Used by fauna_browser to run webview-driven actions inside the same
        // assistant turn (no markdown round-trip).
        callClientTool: (name, args, { timeoutMs = CLIENT_TOOL_TIMEOUT_MS } = {}) => {
          return new Promise((resolve, reject) => {
            const callId = 'ct_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 8);
            const timer = setTimeout(() => {
              clientToolPendingCalls.delete(callId);
              reject(new Error('Client tool "' + name + '" timed out after ' + timeoutMs + 'ms'));
            }, timeoutMs);
            clientToolPendingCalls.set(callId, { resolve, reject, timer });
            ownedClientToolCallIds.add(callId);
            // Cancel pending client tool calls if the upstream stream is aborted
            const onAbort = () => {
              if (!clientToolPendingCalls.has(callId)) return;
              clientToolPendingCalls.delete(callId);
              clearTimeout(timer);
              reject(new Error('Cancelled by user'));
            };
            if (upstreamAbort.signal.aborted) { onAbort(); return; }
            upstreamAbort.signal.addEventListener('abort', onAbort, { once: true });
            send({ type: 'client_tool_pending', callId, name, args });
          });
        },

        // Non-streaming LLM call for self-tools (e.g. fauna_consult_debate).
        // Reuses the same client/model as the active turn. No tools, no stream.
        callLLM: async ({ system, user, model: m, maxTokens = 1024, temperature = 0.4 } = {}) => {
          try {
            const messages = [];
            if (system) messages.push({ role: 'system', content: String(system) });
            messages.push({ role: 'user', content: String(user || '') });
            const resp = await client.chat.completions.create({
              model: m || model,
              messages,
              max_tokens: maxTokens,
              temperature,
              stream: false,
            }, { signal: upstreamAbort.signal });
            return resp?.choices?.[0]?.message?.content || '';
          } catch (e) {
            return '[debate-error] ' + (e?.message || String(e));
          }
        },
      };
      if (!isCLI && !noTools && !isProjectSearch) {
        mcpTools = [...(mcpTools || []), ...SELF_TOOL_DEFS];
        if (enableDynamicWidgets) mcpTools = [...mcpTools, ...DYNAMIC_WIDGET_TOOL_DEFS];
        // When no agent is active, strip `fauna_get_agent_instructions` — its
        // tool description carries a hard "MUST call this once at the start
        // of every turn" directive, which the model otherwise obeys even
        // though there are no agent instructions to fetch (it returns an
        // empty body). Skill tools stay: they also expose global skills.
        if (!agentName) {
          mcpTools = mcpTools.filter(t => (t?.function?.name || t?.name) !== 'fauna_get_agent_instructions');
        }
      }

      // Detect tool-name collisions across the merged set (figma + agent +
      // self-tools + widgets). Duplicates cause silent shadowing in the
      // routing block below — the first match wins, but the model sees only
      // one definition and may guess wrong args. Drop later duplicates and
      // log so the conflict surfaces in build logs.
      if (Array.isArray(mcpTools) && mcpTools.length) {
        const seenToolNames = new Set();
        const deduped = [];
        for (const t of mcpTools) {
          const tname = t?.function?.name || t?.name;
          if (!tname) { deduped.push(t); continue; }
          if (seenToolNames.has(tname)) {
            console.warn(`[chat] dropping duplicate tool definition: "${tname}" — first registration wins`);
            continue;
          }
          seenToolNames.add(tname);
          deduped.push(t);
        }
        mcpTools = deduped;
      }

      // ── Tool-schema gating ────────────────────────────────────────────
      // Filter fauna_* tools down to clusters the current turn actually
      // needs. Saves ~6-10k tokens on typical turns (the full 56-tool set
      // is ~12k tokens). Foreign tools (figma MCP, installed agent tools,
      // widget runtime tools) are always kept.
      if (Array.isArray(mcpTools) && mcpTools.length && !noTools) {
        try {
          const _beforeCount = mcpTools.length;
          const _beforeBytes = JSON.stringify(mcpTools).length;
          const _toolFlags = computeToolFlags({ messages, systemPrompt, isDelegation, isCLI, noTools });
          // When the user explicitly enabled Dynamic Widgets in Settings,
          // keep the widget cluster (fauna_emit_widget + companions) live
          // for the whole conversation regardless of per-turn keyword
          // matches — otherwise we add the tools at line 956 only to strip
          // them right back out here, leaving the model with no way to
          // render the widget the user just turned the feature on for.
          if (enableDynamicWidgets) _toolFlags.widget = true;
          mcpTools = filterToolSchemas(mcpTools, _toolFlags);
          const _afterBytes = JSON.stringify(mcpTools).length;
          if (_afterBytes < _beforeBytes) {
            console.log(`[chat] tool-schema gated: ${_beforeCount}→${mcpTools.length} tools, ${_beforeBytes}→${_afterBytes} chars (saved ~${Math.round((_beforeBytes - _afterBytes) / 4)} tokens) flags=${Object.keys(_toolFlags).filter(k => _toolFlags[k]).join(',')}`);
          }
        } catch (e) {
          console.warn('[chat] tool-schema gating failed, sending full set:', e?.message || e);
        }
      }

      if (Array.isArray(mcpTools) && mcpTools.length && !noTools && effectiveToolPolicy && effectiveToolPolicy.source && effectiveToolPolicy.source !== 'default') {
        const _beforePolicyCount = mcpTools.length;
        mcpTools = filterToolsByPolicy(mcpTools, effectiveToolPolicy);
        if (mcpTools.length !== _beforePolicyCount) {
          console.log(`[chat] tool-policy applied (${effectiveToolPolicy.source}): ${_beforePolicyCount}→${mcpTools.length} tools`);
        }
      }

      // Agentic loop — re-runs if model calls tools.
      // No numeric tool-call cap: the narration-repetition guard (L~1707),
      // tool-call dedup (toolCallsSeen), and the user's abort button are the
      // real loop guards. A numeric cap punishes legitimate deep work (a
      // cross-file refactor reads 30+ files) without catching the actual
      // failure mode (model that varies args slightly while looping).
      let continueLoop = true;
      let toolCallCount = 0; // kept for telemetry / debug logs only
      let continueCount = 0; // track auto-continue on length finish
      let halfStopNudgeCount = 0; // Codex-style: re-prompt model if it asks the user to continue mid-task
      let prevPreamble = '';       // narration emitted on the previous tool-call iteration
      let needsContentBoundary = false; // separate narrated tool rounds in the persisted assistant turn
      let narrationRepeats = 0;    // consecutive iterations with near-identical preamble
      let narrationNudgeFired = false; // only inject the coaching nudge once per request
      let toolsLockedForFinalResponse = false;
      // Template-signature repeat detector — runs alongside narrationRepeats and
      // catches the failure mode where preambles share an obvious canned shape
      // (e.g. "I've now confirmed … The hypothesis I'm testing … The specific
      // next action is …") even though the cited file names rotate. Word-overlap
      // alone misses these because each preamble swaps in different proper nouns.
      // Repro: transcript fauna-Fauna-Memory-and-Context-Architecture-2026-06-17.
      let templateRepeats = 0;
      let templateNudgeFired = false;
      // Bag of canned-narration phrases. Any preamble that hits >=2 of these is
      // "templated"; two templated preambles in a row = repeat. Keep this list
      // small and high-signal — these are phrases the silent-burst coaching
      // nudge below literally trained the model on, so the model latches and
      // re-emits them every turn.
      const TEMPLATE_PHRASES = [
        /\bi(?:'ve|\s+have)\s+(?:now\s+)?confirmed\b/i,
        /\bthe\s+hypothesis\s+i(?:'m|\s+am)\s+testing\b/i,
        /\bthe\s+specific\s+next\s+action\b/i,
        /\bthe\s+next\s+(?:concrete\s+)?action\s+is\s+to\b/i,
        /^\s*so\s+far,?\b/i,
      ];
      const _templateHits = (s) => {
        let n = 0;
        for (const re of TEMPLATE_PHRASES) { if (re.test(s)) n++; }
        return n;
      };
      // Silent-burst guard: count consecutive tool_calls iterations where the
      // model emitted ZERO prose. The narration-repetition guard only fires
      // when there IS narration to compare; a death-spiral that emits no text
      // at all (claude-opus-4.6 firing 27 sequential read_file calls over
      // 9 minutes with finishReason='tool_calls' on every round) slips past
      // every other guard and the user sees a frozen pill until they abort.
      // Repro: transcript fauna-TypeError-Undefined-Map-in-React-2026-06-16.
      let silentBursts = 0;            // iterations in a row with empty assistantText + tool_calls
      let silentBurstNudgeFired = false; // only inject the coaching nudge once per request
      let orchestratorNudgeCount = 0; // orchestrator emitted no [DELEGATE:] — re-prompt
      // Widget-claim verifier state. We track whether `fauna_emit_widget`
      // was successfully called this turn; if the assistant's final text
      // claims to have rendered/attached/rebuilt a widget without one,
      // we re-prompt once with tool_choice pinned to `fauna_emit_widget`
      // so the model cannot get away with describing it in prose.
      let widgetEmittedThisTurn = false;
      let widgetClaimNudges = 0;
      const MAX_WIDGET_CLAIM_NUDGES = 1;
      let forceEmitWidgetNext = false; // set when re-prompting; consumed by params builder
      let noOutputStreamRetries = 0;
      let mutatingToolUsed = false;
      let validationToolUsed = false;
      let inspectionOnlyNudges = 0;
      const MAX_INSPECTION_ONLY_NUDGES = autonomousMode ? 3 : 1;
      let validationRequiredNudges = 0;
      const MAX_VALIDATION_REQUIRED_NUDGES = autonomousMode ? 2 : 1;
      // Hand-authored-circuit verifier state. If the model emits an <svg> for a
      // circuit request that lacks the engine provenance marker (data-fauna-*),
      // the SVG was invented rather than produced by fauna_render_circuit — we
      // re-prompt once to force a real render.
      let circuitHandauthNudges = 0;
      const MAX_CIRCUIT_HANDAUTH_NUDGES = 1;
      // Codex-parity: token usage across every model iteration in this turn.
      // `prompt` tracks the PEAK prompt size (true context-window fullness —
      // each iteration resends the conversation, so summing would massively
      // double-count). `completion` is cumulative (new tokens generated).
      // `billedPrompt` / `billedTotal` track the actual API-billed totals
      // for cost tracking (kept separate from window-fullness display).
      let turnUsage = {
        prompt: 0, completion: 0, total: 0, iterations: 0,
        billedPrompt: 0, billedTotal: 0,
      };
      const emitTokenUsage = () => {
        try {
          send({
            type: 'token_usage',
            prompt: turnUsage.prompt,
            completion: turnUsage.completion,
            total: turnUsage.total,
            billedPrompt: turnUsage.billedPrompt,
            billedTotal: turnUsage.billedTotal,
            iterations: turnUsage.iterations,
            window: budget.window,
            bodyTokenLimit: budget.bodyTokenLimit,
            model: budget.matched,
          });
        } catch (_) { /* SSE may be closed */ }
      };
      // Autonomous mode: per-run state for the DONE/BLOCKED marker gate, the
      // QA gate, and the start-time used in the run-log JSONL entry.
      let markerNudgeFired = false;
      let verificationNudgeFired = false;
      let qaRan = false;
      let qaResultSummary = null;
      let deployRan = false;
      let deployResultSummary = null;
      let stopHooksRan = false;
      let stopHookResultSummary = null;
      const autonomousStartedAt = Date.now();
      // Autonomous mode raises the safety caps so the loop runs until the
      // task is genuinely done. The narration-repeat + per-tool timeouts
      // remain in place — autonomous does NOT mean unbounded.
      // MAX_TOOL_CALLS removed: a numeric cap punishes legitimate deep work
      // (cross-file refactors easily read 30+ files) without catching real
      // loops. Loop detection is handled by narration-repetition + dedup.
      const MAX_CONTINUES = autonomousMode ? 12 : 6; // max auto-continue attempts for truncated output
      const MAX_HALF_STOP_NUDGES = autonomousMode ? 8 : 2; // re-prompt at most twice before letting the model stop
      const MAX_RESULT_CHARS = 40000; // prevent context overflow from large tool responses
      // Per-tool tighter caps for tools whose results are typically large JSON
      // dumps (figma node trees, etc.). Write-confirm responses are small so
      // unaffected; only introspection blobs hit the cap.
      const PER_TOOL_MAX_CHARS = {
        // figma_execute introspection blobs are typically large JSON arrays
        // (node trees, text extracts, layer audits). The earlier 20 KB cap
        // was too tight: any non-trivial design file ran straight past it,
        // forcing the model into batching/retrieval loops that wasted >30 min
        // on a 30-second job (see the "Track B/C CSV" transcript). 80 KB
        // fits a ~500-node text extract in a single call; stale-shrink will
        // elide older figma_execute results anyway so the context-window
        // cost is bounded.
        figma_execute: 80000,
      };
      // Latest user message text — feeds the relevance scorer in
      // compressToolOutput so query-relevant rows survive compression.
      const _lastUserQuery = (() => {
        for (let i = messages.length - 1; i >= 0; i--) {
          const m = messages[i];
          if (!m || m.role !== 'user') continue;
          if (typeof m.content === 'string') return m.content;
          if (Array.isArray(m.content)) return m.content.filter((p) => p && typeof p.text === 'string').map((p) => p.text).join(' ');
        }
        return '';
      })();
      const _writeIntentTurn = /\b(?:fix|fixes|fixed|implement|resolve|repair|patch|update|change|modify|edit|write|create|add|replace|refactor|migrate|install|build\s+out|make\s+(?:all|the|this)|proceed)\b/i.test(_lastUserQuery || '');
      const MUTATING_TOOLS = new Set([
        'fauna_write_file', 'fauna_write_files', 'fauna_apply_patch',
        'fauna_replace_string', 'fauna_write_offloaded',
        'agent_write_file', 'agent_write_files', 'agent_str_replace', 'agent_apply_patch',
        'fauna_create_agent', 'fauna_patch_agent', 'fauna_uninstall_agent',
        'fauna_emit_widget', 'fauna_save_instruction',
      ]);
      const VALIDATION_TOOLS = new Set([
        'fauna_doctor', 'fauna_verify_build', 'fauna_project_audit',
      ]);
      const _isReadOnlyShellCommand = (command) => {
        const text = String(command || '').trim();
        if (!text) return true;
        if (/\b(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?(?:test|lint|typecheck|check|build)\b/i.test(text)) return true;
        if (/\b(?:tsc|eslint|vitest|jest|pytest|cargo\s+test|go\s+test|mvn\s+test|gradle\s+test)\b/i.test(text)) return true;
        if (/\b(?:npm|pnpm|yarn|bun)\s+(?:install|add|remove|update|upgrade|ci)\b/i.test(text)) return false;
        if (/\b(?:touch|mkdir|rm|rmdir|mv|cp|install|tee|sed\s+-i|perl\s+-pi|python\d*\s+-c|node\s+-e|prisma\s+(?:migrate|db\s+push|generate|db\s+seed))\b/i.test(text)) return false;
        if (/(?:^|\s)(?:>|>>|1>|2>|&>)\s*[^\s]+/.test(text)) return false;
        return true;
      };
      const _isValidationShellCommand = (command) => /\b(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?(?:test|lint|typecheck|check|build)\b|\b(?:tsc|eslint|vitest|jest|pytest|cargo\s+test|go\s+test|mvn\s+test|gradle\s+test)\b/i.test(String(command || ''));
      // Tools whose results must never be stale-shrunk — typically tools that
      // inject persistent instructions/rules that the model needs to keep
      // referring to throughout the turn.
      const STALE_SHRINK_EXEMPT = new Set([
        'fauna_get_agent_instructions',
        'fauna_get_skill',
        'fauna_list_skills',
      ]);
      // Tools that are safe to run concurrently within a single model turn.
      // Restricted to pure reads / searches / introspection — anything that
      // mutates state (write_file, shell, browser nav/click, figma_execute,
      // notifications, widget emission, image/video generation) MUST run
      // sequentially so happens-before semantics are preserved. When the
      // model emits N parallel-safe calls in one response they go through
      // Promise.all instead of a serial for-loop, turning a 5×500ms read
      // batch into a single ~500ms wall-clock window.
      const PARALLEL_SAFE_TOOLS = new Set([
        'fauna_read_file', 'fauna_recall', 'fauna_context_search',
        'fauna_get_settings', 'fauna_get_agent_instructions',
        'fauna_list_skills', 'fauna_get_skill', 'fauna_list_models',
        'fauna_list_projects', 'fauna_list_windows', 'fauna_screen_context',
        'fauna_ui_tree', 'fauna_stock_image_search', 'fauna_stock_image_get',
        'fauna_list_playbook', 'fauna_load_widget_from_playbook',
        'fauna_backlog_list', 'fauna_retrieve_output', 'fauna_doctor',
        'fauna_list_voices', 'fauna_video_list', 'fauna_lesson_list',
        'fauna_grep', 'fauna_file_search', 'fauna_semantic_search',
        // Figma read-only introspection (no DOM mutation)
        'figma_status', 'figma_list_connected_files', 'figma_list_pages',
        'figma_list_design_systems', 'figma_get_console_logs',
        'figma_get_selection', 'figma_get_component_map',
        'figma_get_unmapped_components', 'figma_search_components',
        'figma_search_tokens', 'figma_docs', 'figma_rules',
      ]);
      // Stale-tool-result shrinking: when the same tool is called many times
      // in a turn, prior results from that tool become dead weight in context.
      // After pushing a new tool result, we walk back through allMessages and
      // replace older tool messages from the same tool name with a short stub,
      // keeping only the last STALE_KEEP_PER_TOOL results verbatim per tool.
      const STALE_SHRINK_ENABLED = process.env.FAUNA_STALE_TOOL_SHRINK !== '0';
      const STALE_KEEP_PER_TOOL = 2;
      const toolNameByCallId = new Map(); // call_id -> tool name (for stale shrink)
      const toolCallsSeen = new Map(); // deduplicate identical calls
      if (autonomousMode) {
        console.log('[chat] autonomousMode=on (projectId=' + (projectId || 'none') + ') caps: tools=unlimited continues=' + MAX_CONTINUES + ' halfStop=' + MAX_HALF_STOP_NUDGES);
      }

      // Half-stop detector: model finishes mid-task by asking the user whether to proceed.
      // Matches the explicit phrases blacklisted in the system prompt's persistence section.
      // Includes interrogative ("want me to continue?"), imperative-handoff
      // ("send one more message and I'll continue"), AND fabricated cap excuses
      // ("hit the tool-call cap"). The cap-excuse arm only fires for self-imposed
      // claims — the real "Tool call limit reached" tool message is appended by
      // this loop, not generated by the model, so we won't match on legit cases.
      const HALF_STOP_RE = /\b(want me to (continue|proceed|go ahead|keep going|do that|move on)|shall i (continue|proceed|go ahead|keep going)|should i (continue|proceed|go ahead|keep going)|do you want me to|let me know (if|when) you (want|'?d like) (me )?to|ready for the next (step|one|part)|ready to (continue|proceed)|on your (go|signal|word)|just (say|let me know) (the word|when)|happy to (continue|proceed|keep going) if|send (one |another |1 )?more message and i('?ll| will)|reply ['"]?(go|continue|yes|next)['"]? and i('?ll| will)|if you('?d like| want),? (send|reply|say|tell|ping|let me know) (one |another |1 )?(more )?(message|word)|hit (the )?tool[- ]?call cap|ran out of tool (budget|calls|cap)|tool[- ]?call (budget|cap|limit) before i|(i('?m| am)|i('?ve| have been)|i('?ll| will)) (blocked|prevented|stopped|unable) (from|to)( making| doing| performing| running| executing| applying)? (the |any |further |more )?(file )?(edit|edits|change|changes|tool|tool calls?|patch|patches|writes?|actions?)( in this turn)?|(tool|tool[- ]?call) (system|loop|runtime) returned (an? )?(explicit |hard )?(tool[- ]?)?(limit|cap|stop|halt)|when i continue,? i('?ll| will)|(in this turn|this turn) i (cannot|can'?t|won'?t be able to)( make| do| perform| finish| complete))/i;

      // Forward-promise detector: model ends its turn with "I'll do X" / "Let me try Y"
      // but never calls the tool. This shows up after a failed/partial action where the
      // model narrates the next attempt and then halts. Only flagged when the FINAL
      // sentence is forward-looking — guards against false positives in long summaries
      // that legitimately mention "I'll" earlier on.
      const FORWARD_PROMISE_RE = /^\s*(i('?ll| will| am going to| ?'m going to)|let me|now i('?ll| will)|next,?\s*i('?ll| will)|i need to|i should|i'?m about to|going to)\b/i;
      // Third-person variants the model uses to defer work without saying "I'll …".
      // Triggered the same coaching nudge as FORWARD_PROMISE_RE — see the
      // memory-context case-study transcript where the model said "The specific
      // next action is to read …" five turns in a row and the original regex
      // missed every one because it only matched first-person phrasings.
      const FORWARD_PROMISE_DEFER_RE = /\b(the\s+(?:specific\s+)?next\s+(?:action|step|move)\s+is\s+to|the\s+next\s+concrete\s+(?:action|step)\s+(?:is|would\s+be)|next\s+up\s+(?:is|will\s+be)\s+to|my\s+next\s+(?:action|step)\s+(?:is|will\s+be)\s+to|then\s+i(?:'ll| will)\s+(?:read|create|run|call|invoke|write|edit|build|test|verify|fetch|search))\b/i;
      const endsWithForwardPromise = (text) => {
        const trimmed = String(text || '').trim();
        if (!trimmed) return false;
        // Last non-empty sentence.
        const parts = trimmed.split(/(?<=[.!?\n])\s+/).map(s => s.trim()).filter(Boolean);
        const last = parts[parts.length - 1] || trimmed;
        if (FORWARD_PROMISE_RE.test(last)) return true;
        // Deferred-action phrasings can appear anywhere in the last 2 sentences —
        // the model often writes a long summary and tacks "the next action is …"
        // at the end without the explicit first-person verb.
        const tail = parts.slice(-2).join(' ');
        return FORWARD_PROMISE_DEFER_RE.test(tail);
      };

      // Autonomous-mode terminal marker: model MUST begin its final message
      // with one of DONE: / BLOCKED: / NEEDS-INPUT: so we can route reflection.
      const MARKER_RE = /^\s*(DONE|BLOCKED|NEEDS-INPUT)\s*:/i;
      const finalStatusFromText = (text) => {
        const m = String(text || '').match(MARKER_RE);
        return m ? m[1].toUpperCase() : null;
      };
      const hasDoneEvidence = (text) => {
        if (qaRan || deployRan || toolCallCount > 0) return true;
        return /\b(verified|validated|ran|passed|checked|tested|built|linted|typechecked|compiled|opened|inspected)\b/i.test(String(text || ''))
          && /\b(test|build|lint|typecheck|compile|command|tool|output|file|diff|screenshot|log|diagnostic|error)\b/i.test(String(text || ''));
      };

      // ── Tool guard — pre-call checks, category limits, browser discipline ──
      const PROMPT_PERMISSION = process.env.FAUNA_PROMPT_PERMISSION === '1';
      const toolGuard = new ToolGuardContext({
        // Headless / autonomous task runs (kanban autopilot, cron) get
        // relaxed caps so a build → test → review pass can actually finish
        // a single turn. Interactive chat keeps the conservative caps.
        autonomous: !!bodyHeadlessTask,
        limits: bodyToolLimits && typeof bodyToolLimits === 'object' ? bodyToolLimits : null,
        send,
        onPermissionRequest: async (toolName, args, info) => {
          // Headless tasks have no UI to approve — the task-level shell
          // permission IS the grant, so auto-allow without prompting.
          if (bodyHeadlessTask) return 'allow';
          // Default (legacy): emit the SSE event and auto-allow. Set
          // FAUNA_PROMPT_PERMISSION=1 to require an explicit decision via
          // /api/tool-permission-result; on timeout the call is denied.
          if (!PROMPT_PERMISSION) {
            send({ type: 'tool_permission_request', name: toolName, args, label: info.label, category: info.category });
            return 'allow';
          }
          return await new Promise((resolve) => {
            const callId = 'tp_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 8);
            const timer = setTimeout(() => {
              permissionPendingCalls.delete(callId);
              ownedPermissionCallIds.delete(callId);
              resolve('deny');
            }, PERMISSION_TIMEOUT_MS);
            permissionPendingCalls.set(callId, { resolve, timer });
            ownedPermissionCallIds.add(callId);
            send({ type: 'tool_permission_request', callId, name: toolName, args, label: info.label, category: info.category });
          });
        },
      });

      // ── Inject agent instructions as an AUTHORITATIVE second system message.
      // The client sends only the active-agent identity and a short execution
      // directive. Pushing the full manifest.systemPrompt as a second
      // system-role message loads the workflow automatically and ensures the
      // rules are followed verbatim without a redundant first tool call.
      // Guarded so duplicate injection across iterations cannot happen
      // (the marker line is unique and idempotent-checked).
      if (agentName) {
        try {
          const SEED_MARKER = '### AGENT INSTRUCTIONS (AUTHORITATIVE) ###';
          const alreadyInjected = allMessages.some(m =>
            m && m.role === 'system' && typeof m.content === 'string' &&
            m.content.includes(SEED_MARKER)
          );
          if (!alreadyInjected) {
            const safeAgentName = agentName.replace(/[^a-zA-Z0-9_-]/g, '');
            // loadAgentManifest resolves a real agent.json OR synthesizes a
            // manifest for a dropped AGENT.md / system-prompt.md folder, so
            // instructions flow into context even without an agent.json.
            const manifest = loadAgentManifest(agentsDir, safeAgentName) || (activeCustomizationAgentPolicy ? {
              name: activeCustomizationAgentPolicy.name,
              displayName: activeCustomizationAgentPolicy.name,
              systemPrompt: activeCustomizationAgentPolicy.systemPrompt,
              orchestrator: false,
            } : null);
            if (manifest) {
              const isOrchestrator = !!(manifest && manifest.orchestrator);
              if (!isOrchestrator && manifest.systemPrompt) {
                const body = [
                  SEED_MARKER,
                  `Active agent: ${manifest.displayName || manifest.name || safeAgentName}`,
                  '',
                  'The following are the authoritative operating instructions for this agent.',
                  'They OVERRIDE any conflicting guidance about output format, tool choice, or workflow in earlier system messages.',
                  'Follow every section, every checklist item, and every formatting rule below exactly. Do not summarize, paraphrase, or skip steps.',
                  '',
                  '--- BEGIN AGENT INSTRUCTIONS ---',
                  manifest.systemPrompt,
                  '--- END AGENT INSTRUCTIONS ---',
                ].join('\n');
                allMessages.push({ role: 'system', content: body });
                console.log(`[chat] injected agent instructions as system message for "${safeAgentName}" (${manifest.systemPrompt.length} chars)`);
              }
            }
          }
        } catch (e) {
          console.log('[chat] agent-instruction injection failed:', e.message);
        }
      }

      // ── Adaptive thinking budget ──────────────────────────────────────────
      // When the budget is left on "auto" (the default), scale the reasoning
      // allocation to the turn instead of always sending the maximum. A simple
      // single-shot question wastes minutes of latency on a 10K-token thinking
      // pass it never needed; agentic / multi-step turns genuinely benefit.
      // The resolved level only ever LOWERS latency vs. a fixed "high" default;
      // an explicit user choice (off/low/medium/high/max) is always respected.
      const classifyThinkingBudget = ({ text, hasTools, agentName, isDelegation, autonomousMode }) => {
        // Agentic contexts plan, branch, and self-correct — always worth high.
        if (agentName || isDelegation || autonomousMode) return 'high';
        const t = (text || '').trim();
        const words = t ? t.split(/\s+/).length : 0;
        // Deep-reasoning signals: design/debug/analysis verbs, embedded code or
        // stack traces, explicit multi-step phrasing.
        const COMPLEX_RE = /\b(refactor|debug|implement|architect|design|optimi[sz]e|prove|derive|analy[sz]e|trade-?offs?|step[- ]by[- ]step|migrat(e|ion)|algorithm|complexity|concurren\w*|race condition|deadlock|security|vulnerab\w*|why does|how would|compare|reason through)\b/i;
        const CODE_RE = /```|\bstack trace\b|\bexception\b|\btraceback\b|=>|\bfunction\b|\bclass\b|^\s*(?:Error|TypeError|ReferenceError):/im;
        const MULTI_RE = /\b(and then|after that|finally|first[, ].*then|step \d|1\.\s|2\.\s)\b/i;
        if (COMPLEX_RE.test(t) || CODE_RE.test(t) || MULTI_RE.test(t)) return 'high';
        if (words > 120) return 'high';
        if (words > 40) return 'medium';
        // Short tool-enabled turns (e.g. "check my mail") get a little headroom
        // for the agentic loop; short plain Q&A gets the minimum.
        if (hasTools && words > 6) return 'medium';
        return 'low';
      };
      let effectiveThinkingBudget = thinkingBudget;
      if (thinkingBudget === 'auto') {
        const _lastUser = [...messages].reverse().find(m => m && m.role === 'user');
        const _lastUserText = typeof _lastUser?.content === 'string'
          ? _lastUser.content
          : Array.isArray(_lastUser?.content)
            ? _lastUser.content.filter(c => c && c.type === 'text').map(c => c.text).join('\n')
            : '';
        effectiveThinkingBudget = classifyThinkingBudget({
          text: _lastUserText,
          hasTools: Array.isArray(mcpTools) && mcpTools.length > 0 && !noTools,
          agentName, isDelegation, autonomousMode,
        });
        console.log(`[chat] auto thinking budget → "${effectiveThinkingBudget}" (words=${(_lastUserText || '').trim().split(/\s+/).filter(Boolean).length}, tools=${Array.isArray(mcpTools) ? mcpTools.length : 0})`);
      }

      while (continueLoop) {
        if (res.writableEnded) break;

        // o-series and gpt-5+ models require max_completion_tokens instead of max_tokens
        const useCompletionTokens = /^(o[1-9]|gpt-5)/.test(model);
        const params = { model, messages: allMessages, stream: true };
        // Claude models support much larger outputs — use 32K to avoid truncating artifacts
        const defaultMaxTokens = model.includes('claude') ? 32768 : 16384;
        if (useCompletionTokens) { params.max_completion_tokens = defaultMaxTokens; }
        else { params.max_tokens = defaultMaxTokens; }

        // Thinking budget — Claude models use `thinking`, o-series use `reasoning_effort`
        let thinkingEnabledThisCall = false;
        if (effectiveThinkingBudget !== 'off') {
          const budgetTokens = { low: 1024, medium: 5000, high: 10000, max: 32000 }[effectiveThinkingBudget] || 10000;
          if (model.includes('claude')) {
            params.thinking = { type: 'enabled', budget_tokens: budgetTokens };
            thinkingEnabledThisCall = true;
            const minTokens = budgetTokens + 4000;
            if (useCompletionTokens) { params.max_completion_tokens = Math.max(params.max_completion_tokens, minTokens); }
            else { params.max_tokens = Math.max(params.max_tokens, minTokens); }
          } else if (/^o[1-9]/.test(model)) {
            params.reasoning_effort = effectiveThinkingBudget === 'max' ? 'high' : effectiveThinkingBudget === 'low' ? 'low' : 'medium';
          }
        }

        if (mcpTools?.length) params.tools = mcpTools;

        // Inject ephemeral widget tools — re-scanned each turn so widgets
        // emitted earlier in this same request become callable on the next
        // iteration of the agentic loop.
        if (enableDynamicWidgets) {
          const ephemeral = buildEphemeralToolDefs(extractWidgetRegistrations(allMessages));
          if (ephemeral.length) {
            params.tools = [...(params.tools || []), ...ephemeral];
          }
        }
        if (toolsLockedForFinalResponse) {
          delete params.tools;
          delete params.tool_choice;
        }
        // Widget-claim verifier: if a prior iteration detected the model
        // promising a widget without calling `fauna_emit_widget`, force the
        // next response to invoke that tool. Consumed once.
        if (forceEmitWidgetNext && Array.isArray(params.tools) && params.tools.some(t => t?.function?.name === 'fauna_emit_widget')) {
          params.tool_choice = { type: 'function', function: { name: 'fauna_emit_widget' } };
          forceEmitWidgetNext = false;
        }
        // Capability gating for non-Copilot providers. Most local
        // OpenAI-compatible endpoints either reject `tools` outright or
        // silently ignore them — strip them when supports.tools=false. The
        // agentic loop still works because shell/browser/etc. are also
        // exposed through markdown-fence widgets in the system prompt.
        if (!llmSupports.tools) {
          delete params.tools;
          delete params.tool_choice;
        }
        // `stream_options.include_usage` is OpenAI-specific. Ollama/llama.cpp
        // tolerate it but vLLM and some others 400 on unknown fields.
        if (llmSupports.usageEvents) {
          params.stream_options = { include_usage: true };
        }
        // Vision gating: when the active provider/model doesn't support image
        // input, replace each image_url content part with a short text note so
        // the model at least knows the user attached something but no longer
        // crashes on the unsupported content type.
        if (!llmSupports.vision) {
          params.messages = params.messages.map(function(m) {
            if (!m || !Array.isArray(m.content)) return m;
            var stripped = m.content.map(function(part) {
              if (part && (part.type === 'image_url' || part.type === 'image' || part.image_url)) {
                return { type: 'text', text: '[image attached — vision not supported by current model]' };
              }
              return part;
            });
            return Object.assign({}, m, { content: stripped });
          });
        }
        applyModelRequestCompatibility(params, llmCapabilities);

        let stream;
        try {
          stream = await client.chat.completions.create(params, { signal: upstreamAbort.signal });
        } catch (apiErr) {
          if (upstreamAbort.signal.aborted) { continueLoop = false; break; }
          // Auto-recover: if max_tokens is unsupported, switch to max_completion_tokens
          if (apiErr.message?.includes('max_tokens') && params.max_tokens) {
            params.max_completion_tokens = params.max_tokens;
            delete params.max_tokens;
            stream = await client.chat.completions.create(params, { signal: upstreamAbort.signal });
          } else if (CHAT_COMPLETIONS_UNSUPPORTED_RE.test(params.model) || apiErr.message?.includes('/chat/completions endpoint')) {
            const fallbackModel = /^gpt-5/i.test(params.model) ? 'gpt-5.4' : 'gpt-4.1';
            console.log(`[chat] model "${params.model}" not supported via chat.completions, falling back to "${fallbackModel}"`);
            params.model = fallbackModel;
            stream = await client.chat.completions.create(params, { signal: upstreamAbort.signal });
          } else {
            throw apiErr;
          }
        }

        const pendingCalls = [];
        let finishReason = null;
        let assistantText = '';
        let streamUsage = null;

        let sawReasoning = false;
        let reasoningStart = null;
        let emittedTextThisIteration = false;
        const sendContent = (text) => {
          if (!text) return;
          if (!emittedTextThisIteration && needsContentBoundary) {
            send({ type: 'content', content: '\n\n' });
            needsContentBoundary = false;
          }
          emittedTextThisIteration = true;
          send({ type: 'content', content: text });
        };

        // Surface "Thinking…" the instant the stream opens — don't wait for the
        // first thinking delta. With a large budget Claude can spend minutes in
        // reasoning before emitting any thinking/text chunk, during which the UI
        // would otherwise sit on a generic spinner and look frozen. Emitting the
        // reasoning signal now starts the client's live "Thinking… Ns" counter.
        if (thinkingEnabledThisCall && !res.writableEnded) {
          reasoningStart = Date.now();
          sawReasoning = true;
          send({ type: 'reasoning' });
        }

        // Idle watchdog. Claude streams thinking + text + tool-argument deltas
        // continuously, so a *total* absence of chunks for STREAM_IDLE_MS means
        // the upstream genuinely stalled (not merely "thinking"). The SSE
        // keep-alive above only protects the client socket; it does nothing for
        // an upstream that goes silent mid-generation, which otherwise hangs the
        // `for await` forever. Aborting converts that into a recoverable error.
        //
        // First-content deadline. The idle watchdog can't catch a turn that
        // streams thinking deltas steadily but never produces visible text or a
        // tool call (every delta resets `lastChunkAt`). We separately track
        // whether any *visible output* has appeared; if not, warn the user at
        // FIRST_CONTENT_WARN_MS and hard-abort at FIRST_CONTENT_ABORT_MS so a
        // runaway thinking pass can't hang the turn indefinitely.
        let lastChunkAt = Date.now();
        const streamStartAt = Date.now();
        let sawVisibleOutput = false;
        let firstContentWarned = false;
        const STREAM_IDLE_MS = 120000;
        const FIRST_CONTENT_WARN_MS = 90000;
        const FIRST_CONTENT_ABORT_MS = effectiveThinkingBudget === 'max' ? 360000 : 180000;
        const _idleWatch = setInterval(() => {
          if (res.writableEnded) return;
          if (Date.now() - lastChunkAt > STREAM_IDLE_MS) {
            streamStalled = true;
            try { upstreamAbort.abort(); } catch (_) {}
            return;
          }
          if (!sawVisibleOutput) {
            const thinkingFor = Date.now() - streamStartAt;
            if (!firstContentWarned && thinkingFor > FIRST_CONTENT_WARN_MS) {
              firstContentWarned = true;
              try {
                const _budgetHint = thinkingBudget === 'auto'
                  ? 'Auto picked a large thinking budget for this request; set Settings → Thinking Budget to Low to speed up simple questions.'
                  : 'The model is using a large thinking budget; set Settings → Thinking Budget to Auto or a lower level to speed up simple questions.';
                send({
                  type: 'notice',
                  level: 'info',
                  message: 'Still thinking — no output yet after ' + Math.round(thinkingFor / 1000) + 's. ' + _budgetHint
                });
              } catch (_) {}
            }
            if (thinkingFor > FIRST_CONTENT_ABORT_MS) {
              thinkingDeadlineHit = true;
              try { upstreamAbort.abort(); } catch (_) {}
            }
          }
        }, 5000);

        try {
        for await (const chunk of stream) {
          lastChunkAt = Date.now();
          if (res.writableEnded) { continueLoop = false; break; }
          if (chunk.usage) streamUsage = chunk.usage;
          const delta = chunk.choices?.[0]?.delta;
          finishReason = chunk.choices?.[0]?.finish_reason || finishReason;
          if (!delta) continue;

          // ── Claude extended thinking blocks ────────────────────────────────
          if (Array.isArray(delta.content)) {
            for (const block of delta.content) {
              if (block.type === 'thinking' && block.thinking) {
                if (reasoningStart === null) reasoningStart = Date.now();
                if (!sawReasoning) {
                  sawReasoning = true;
                  send({ type: 'reasoning' });
                }
              } else if (block.type === 'text' && block.text) {
                assistantText += block.text;
                sawVisibleOutput = true;
                sendContent(block.text);
              }
            }
          }

          // ── Standard text delta ────────────────────────────────────────────
          if (typeof delta.content === 'string' && delta.content) {
            assistantText += delta.content;
            sawVisibleOutput = true;
            sendContent(delta.content);
          }

          // ── o-series reasoning summary delta ──────────────────────────────
          if (delta.reasoning_content) {
            if (reasoningStart === null) reasoningStart = Date.now();
            if (!sawReasoning) {
              sawReasoning = true;
              send({ type: 'reasoning' });
            }
          }

          // ── Tool call accumulation ─────────────────────────────────────────
          if (delta?.tool_calls) {
            sawVisibleOutput = true;
            for (const tc of delta.tool_calls) {
              const i = tc.index ?? 0;
              if (!pendingCalls[i]) pendingCalls[i] = { id: '', type: 'function', function: { name: '', arguments: '' } };
              if (tc.id) pendingCalls[i].id += tc.id;
              if (tc.function?.name) pendingCalls[i].function.name += tc.function.name;
              if (tc.function?.arguments) pendingCalls[i].function.arguments += tc.function.arguments;
            }
          }
        }
        } finally {
          clearInterval(_idleWatch);
        }

        // Codex-parity: accumulate + broadcast token usage after each model
        // iteration so the UI can render a live context-window indicator.
        // `prompt` = peak (latest iteration's prompt size — true context
        // fullness, since each call resends the same conversation).
        // `completion` / `total` = cumulative across iterations (new output).
        // `billedPrompt` / `billedTotal` = sum of all per-call prompts for
        // cost accounting only.
        if (streamUsage) {
          const ip = streamUsage.prompt_tokens     || 0;
          const ic = streamUsage.completion_tokens || 0;
          const it = streamUsage.total_tokens      || (ip + ic);
          if (ip > turnUsage.prompt) turnUsage.prompt = ip; // peak
          turnUsage.completion += ic;
          turnUsage.total       = turnUsage.prompt + turnUsage.completion;
          turnUsage.billedPrompt += ip;
          turnUsage.billedTotal  += it;
          turnUsage.iterations  += 1;
          emitTokenUsage();
        }

        if (finishReason === 'tool_calls' && pendingCalls.length > 0) {
          const calls = pendingCalls.filter(tc => tc && tc.function?.name);
          if (!calls.length) { send({ type: 'done', finish_reason: finishReason }); continueLoop = false; break; }
          // Include the streamed preamble in the assistant turn so the model can
          // see its own previous narration next iteration. Without this, the
          // model is blind to what it just said and tends to re-narrate the
          // same explanation ("the built-in browser is getting blocked, let me
          // try X instead") every loop without making progress.
          const preambleForCtx = (typeof assistantText === 'string' ? assistantText : '').trim();
          if (preambleForCtx) needsContentBoundary = true;
          allMessages.push({ role: 'assistant', content: preambleForCtx || null, tool_calls: calls });

          // Narration-repetition guard: if the preamble is very similar to the
          // previous iteration's preamble, count it. After two repeats, inject
          // a coaching nudge so the model breaks the loop with a different
          // action or a final summary. After four, hard-stop.
          const _preambleSim = (a, b) => {
            const A = (a || '').toLowerCase().replace(/\s+/g, ' ').trim();
            const B = (b || '').toLowerCase().replace(/\s+/g, ' ').trim();
            if (!A || !B) return 0;
            if (A === B) return 1;
            const short = A.length < B.length ? A : B;
            const long  = A.length < B.length ? B : A;
            if (long.includes(short) && short.length >= 40) return 0.95;
            // Word-set overlap as a cheap similarity proxy
            const wa = new Set(A.split(/\W+/).filter(w => w.length > 3));
            const wb = new Set(B.split(/\W+/).filter(w => w.length > 3));
            if (!wa.size || !wb.size) return 0;
            let inter = 0; for (const w of wa) if (wb.has(w)) inter++;
            return inter / Math.max(wa.size, wb.size);
          };
          if (preambleForCtx.length >= 40 && _preambleSim(preambleForCtx, prevPreamble) >= 0.75) {
            narrationRepeats++;
          } else {
            narrationRepeats = 0;
          }
          // Template-signature detector — orthogonal to word-overlap similarity.
          // Catches preambles that share canned phrases even when the specific
          // file/symbol names rotate (which defeats Jaccard overlap).
          if (preambleForCtx.length >= 40 && _templateHits(preambleForCtx) >= 2) {
            templateRepeats++;
          } else {
            templateRepeats = 0;
          }
          prevPreamble = preambleForCtx;

          // Parallel-safe (read-only) calls go into a queue and run via
          // Promise.all; sequential calls (writes, shell, browser, figma
          // execute, etc.) flush the queue first so happens-before semantics
          // are preserved. This turns a 5-read batch from 5×latency into
          // 1×latency wall-clock — the single biggest perceived-speed win.
          const _parallelQueue = [];
          const _flushParallel = async () => {
            if (_parallelQueue.length === 0) return;
            const pending = _parallelQueue.splice(0);
            await Promise.all(pending);
          };

          // Per-call execution body, extracted so it can run either inside
          // Promise.all (parallel) or after `await _flushParallel()` (serial).
          // All shared state mutation (allMessages, toolCallsSeen, etc.)
          // happens synchronously after the awaited work resolves, which JS's
          // single-threaded event loop serializes for us.
          const _executeOneCall = async (tc, args, toolName, callKey) => {
            if (upstreamAbort.signal.aborted) throw new Error('Cancelled by user');
            // Send human-readable tool status to the client
            const toolLabel = formatToolLabel(toolName, args);
            send({ type: 'tool_call', name: toolName, label: toolLabel });
            if (MUTATING_TOOLS.has(toolName)) mutatingToolUsed = true;
            if (VALIDATION_TOOLS.has(toolName)) validationToolUsed = true;
            if (toolName === 'fauna_shell_exec') {
              if (!_isReadOnlyShellCommand(args?.command)) mutatingToolUsed = true;
              if (_isValidationShellCommand(args?.command)) validationToolUsed = true;
            }

            try {
              let result;

              // Route to widget RPC bridge first (ephemeral, per-conversation tools).
              if (isWidgetTool(toolName)) {
                const parsed = parseWidgetToolName(toolName);
                const reg = parsed && Array.from(liveWidgets.values()).find(r =>
                  r.widgetId.replace(/[^a-z0-9]/gi, '').slice(0, 24) === parsed.widgetIdSlug
                );
                if (!reg) {
                  result = JSON.stringify({ ok: false, error: `Widget for "${toolName}" is no longer live in this conversation.` });
                } else {
                  const callId = 'wc_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 8);
                  const rpcResult = await new Promise((resolve, reject) => {
                    const timer = setTimeout(() => {
                      widgetPendingCalls.delete(callId);
                      reject(new Error(`Widget tool "${parsed.toolName}" timed out after ${WIDGET_TOOL_TIMEOUT_MS}ms`));
                    }, WIDGET_TOOL_TIMEOUT_MS);
                    widgetPendingCalls.set(callId, { resolve, reject, timer });
                    ownedWidgetCallIds.add(callId);
                    send({ type: 'widget_tool_pending', callId, widgetId: reg.widgetId, name: parsed.toolName, args });
                  }).catch(err => ({ ok: false, error: err.message }));
                  result = typeof rpcResult === 'string' ? rpcResult : JSON.stringify(rpcResult);
                }
              }
              // Route to custom MCP servers discovered from Settings -> Custom Servers.
              else if (customMcpToolNames.has(toolName) && customMcp?.callTool) {
                result = await withTimeout(
                  customMcp.callTool(toolName, args),
                  30000,
                  'custom MCP tool "' + toolName + '"'
                );
              }
              // Route to self-tools (memory, models, settings, etc.)
              else if (isSelfTool(toolName)) {
                result = await executeSelfTool(toolName, args, selfToolContext);
              }
              // Route to agent tool handler if available, otherwise Figma MCP
              else if (agentToolHandlers?.has(toolName)) {
                console.log(`[chat] Agent tool: ${toolName}`);
                result = await agentToolHandlers.get(toolName)(args);
              } else {
                if (toolName === 'figma_execute' && args && !args.fileKey) {
                  const connectedByKey = new Map((figma.listFiles() || []).map(f => [f.fileKey, f]));
                  const selectedConnected = (Array.isArray(selectedFigmaFileKeys) ? selectedFigmaFileKeys : [])
                    .map(k => connectedByKey.get(k))
                    .filter(Boolean)
                    .sort((a, b) => (Number(b.timestamp) || 0) - (Number(a.timestamp) || 0));
                  if (selectedConnected.length) args.fileKey = selectedConnected[0].fileKey;
                }
                figma.log('🔧 ' + toolName + (toolName === 'figma_execute' ? ': ' + (args.code || '').slice(0, 80).replace(/\n/g,' ') + '…' : ''), 'cmd');
                // Bound MCP calls so a hung Figma plugin / server doesn't
                // freeze the agentic loop for the rest of the turn.
                result = await withTimeout(
                  figma.callMcpTool(toolName, args),
                  30000,
                  'figma tool "' + toolName + '"'
                );
                figma.log('✓ ' + toolName + ' done', 'ok');
              }

              const postHooks = await runHooks(customizationRecords, 'PostToolUse', {
                toolName,
                args,
                result: typeof result === 'string' ? result.slice(0, 20000) : result,
                agentName: agentName || null,
                conversationId: req.body?.conversationId || null,
              }, { cwd: workspaceRoot });
              for (const message of postHooks.systemMessages || []) {
                if (message) allMessages.push({ role: 'system', content: String(message) });
              }
              if (postHooks.blocked) {
                result = JSON.stringify({ ok: false, error: postHooks.stopReason || 'PostToolUse hook blocked this tool result.' });
              }

              // Truncate oversized results (screenshots, large contexts).
              // Keep head + tail so errors/stack traces at the end of long
              // tool output (e.g. shell, build logs) survive the truncation
              // window — losing the failing tail is what confuses the model.
              const resultCap = PER_TOOL_MAX_CHARS[toolName] || MAX_RESULT_CHARS;
              if (typeof result === 'string' && result.length > resultCap) {
                // Structure-aware compression: keep first/last items, error
                // rows, query-relevant rows + a sample (JSON) or head/tail +
                // error lines (logs) — instead of a blind char slice that can
                // drop the failing row/line out of the middle.
                const compressed = compressToolOutput(result, { cap: resultCap, query: _lastUserQuery });
                if (compressed.modified) {
                  // Reversible offload: stash the full original so the model can
                  // retrieve the dropped content on demand instead of re-running
                  // the tool. Append the retrieval pointer when the stash sticks.
                  const hash = stashOutput(compressed.original);
                  if (hash) {
                    // Imperative marker. The previous wording ("retrieve with
                    // fauna_retrieve_output(...)") was treated as flavor text
                    // by the model — see the Track B/C CSV transcript where
                    // the assistant tried 8 batching workarounds instead of
                    // calling retrieve once. Make the marker prescriptive and
                    // surface the cheaper write-direct path explicitly.
                    const fullLen = result.length;
                    const marker =
                      '\n\n[fauna] ⚠️ OUTPUT TRUNCATED. The visible content above is a compressed sample; ' +
                      `the full ${fullLen.toLocaleString()}-char original is offloaded as hash "${hash}".\n` +
                      'DO NOT write a CSV / log / dump derived from only the visible rows — that will silently drop data.\n' +
                      'To act on the FULL content, choose ONE of:\n' +
                      `  • Write to disk directly: fauna_write_offloaded({"hash":"${hash}","path":"<absolute file path>"})  ← preferred, never re-marshals the bytes through your context\n` +
                      `  • Append to an existing file: fauna_write_offloaded({"hash":"${hash}","path":"<path>","append":true})\n` +
                      `  • Load back into your context (only if you must reason over it): fauna_retrieve_output({"hash":"${hash}"})`;
                    result = compressed.text + marker;
                  } else {
                    result = compressed.text;
                  }
                }
              }
              toolCallsSeen.set(callKey, result);
              // Safe serialize — non-string results may contain circular refs
              // or unserializable values; never let that crash the SSE stream.
              let toolContent;
              if (typeof result === 'string') {
                toolContent = result;
              } else {
                try {
                  toolContent = JSON.stringify(result);
                } catch (serErr) {
                  toolContent = JSON.stringify({ ok: false, error: 'tool result not serializable: ' + serErr.message });
                }
              }
              allMessages.push({ role: 'tool', tool_call_id: tc.id, content: toolContent });
              toolNameByCallId.set(tc.id, toolName);
              // Entity-card artifacts for files created via the write tools —
              // the client-side ```write-file render path never runs for a
              // function-tool write, so emit the card signal directly.
              if (toolName === 'fauna_write_file' || toolName === 'fauna_write_files') {
                try {
                  const parsedWrite = JSON.parse(toolContent);
                  if (parsedWrite && parsedWrite.ok !== false) {
                    const createdRecords = [];
                    if (parsedWrite.result && parsedWrite.result.path) createdRecords.push(parsedWrite.result);
                    if (Array.isArray(parsedWrite.results)) createdRecords.push(...parsedWrite.results);
                    for (const rec of createdRecords) {
                      if (!rec || !rec.path || rec.op === 'skip' || rec.op === 'delete') continue;
                      send({ type: 'artifact_created', path: rec.path, artType: artifactTypeForPath(rec.path) });
                    }
                  }
                } catch (_) { /* non-fatal */ }
              }
              // Verifier bookkeeping: record that the model actually emitted
              // a widget this turn so the post-stream check doesn't false-flag
              // a legitimate "Here is the widget" message.
              if (toolName === 'fauna_emit_widget') {
                try {
                  const parsed = typeof toolContent === 'string' ? JSON.parse(toolContent) : toolContent;
                  if (parsed && parsed.ok !== false) widgetEmittedThisTurn = true;
                } catch (_) { /* assume ok if not JSON */ widgetEmittedThisTurn = true; }
              }

              // Stale-tool-result shrink: keep only the last STALE_KEEP_PER_TOOL
              // results from this tool verbatim; replace older ones with a stub.
              // Massive savings for agents that call e.g. figma_execute 10+ times
              // in a single turn — earlier introspection blobs almost never need
              // to be re-read once the model has acted on them.
              if (STALE_SHRINK_ENABLED && !STALE_SHRINK_EXEMPT.has(toolName)) {
                let keepRemaining = STALE_KEEP_PER_TOOL;
                let _shrunkCount = 0;
                let _shrunkChars = 0;
                for (let i = allMessages.length - 1; i >= 0; i--) {
                  const m = allMessages[i];
                  if (!m || m.role !== 'tool' || !m.tool_call_id) continue;
                  if (toolNameByCallId.get(m.tool_call_id) !== toolName) continue;
                  if (keepRemaining > 0) { keepRemaining--; continue; }
                  // Already shrunk? skip.
                  if (typeof m.content === 'string' && m.content.startsWith('[stale: ')) continue;
                  const origLen = typeof m.content === 'string' ? m.content.length : 0;
                  if (origLen < 200) continue; // not worth shrinking tiny results
                  m.content = `[stale: ${toolName} result elided — ${origLen} chars superseded by later ${toolName} call(s) in this turn]`;
                  _shrunkCount++;
                  _shrunkChars += origLen;
                }
                if (_shrunkCount > 0) {
                  console.log(`[chat] stale-shrink: ${toolName} elided ${_shrunkCount} prior result(s), saved ${_shrunkChars} chars`);
                }
              }
            } catch (e) {
              allMessages.push({ role: 'tool', tool_call_id: tc.id, content: `Error: ${e.message}` });
              figma.log('✗ ' + toolName + ': ' + e.message, 'err');
            }
          }; // end _executeOneCall

          // Dispatcher: classify each call, run parallel-safe ones via the
          // queue and sequential ones inline (flushing the queue first).
          for (const tc of calls) {
            if (upstreamAbort.signal.aborted) break;
            const toolName = tc.function.name;
            const callKey  = toolName + '|' + tc.function.arguments;
            toolCallCount++;

            // No numeric tool-call cap. Runaway loops are caught by the
            // narration-repetition guard below + the dedup map; the user can
            // always abort. A hard ceiling here just punishes legitimate
            // multi-file refactors without catching the actual failure mode.

            // Deduplicate: same tool + same args already called
            if (toolCallsSeen.has(callKey)) {
              allMessages.push({ role: 'tool', tool_call_id: tc.id, content: toolCallsSeen.get(callKey) });
              continue;
            }

            // ── Pre-tool-call guard ─────────────────────────────────────────
            const args = JSON.parse(tc.function.arguments || '{}');
            const preHooks = await runHooks(customizationRecords, 'PreToolUse', {
              toolName,
              args,
              agentName: agentName || null,
              conversationId: req.body?.conversationId || null,
            }, { cwd: workspaceRoot });
            if (upstreamAbort.signal.aborted) break;
            for (const message of preHooks.systemMessages || []) {
              if (message) allMessages.push({ role: 'system', content: String(message) });
            }
            if (preHooks.blocked || preHooks.permissionDecision === 'deny') {
              allMessages.push({ role: 'tool', tool_call_id: tc.id, content: preHooks.stopReason || `PreToolUse hook denied ${toolName}` });
              continue;
            }
            const guardResult = await toolGuard.check(toolName, args);

            if (guardResult.action === 'deny') {
              allMessages.push({ role: 'tool', tool_call_id: tc.id, content: guardResult.reason });
              continue;
            }

            // inject_snapshot: force a browser snapshot before the blind action.
            // Browser tools are never parallel-safe so this branch is naturally
            // sequential, but we still flush any pending reads first.
            if (guardResult.action === 'inject_snapshot') {
              await _flushParallel();
              send({ type: 'tool_call', name: 'browser_snapshot', label: 'Taking browser snapshot (auto)' });
              try {
                let snapResult;
                try {
                  snapResult = await callPlaywrightMcpTool('browser_snapshot', {});
                } catch (connErr) {
                  // Auto-reconnect once if the subprocess died
                  if (/closed|disconnect|EPIPE|EOF/i.test(connErr.message)) {
                    resetPlaywrightMcpClient();
                    snapResult = await callPlaywrightMcpTool('browser_snapshot', {});
                  } else { throw connErr; }
                }
                const snapContent = Array.isArray(snapResult?.content)
                  ? snapResult.content.map(c => c.text || '').join('\n')
                  : JSON.stringify(snapResult);
                // Insert snapshot as a separate tool message so the model sees it
                allMessages.push({ role: 'tool', tool_call_id: tc.id, content: '[Auto-snapshot before ' + toolName + ']\n' + snapContent.slice(0, MAX_RESULT_CHARS) });
                toolGuard.resetBrowserRate();
                // The original tool call is consumed — model will re-decide after seeing the snapshot
                continue;
              } catch (snapErr) {
                // Snapshot failed — fall through and execute the original action
                console.log('[tool-guard] auto-snapshot failed:', snapErr.message);
              }
            }

            if (PARALLEL_SAFE_TOOLS.has(toolName)) {
              _parallelQueue.push(_executeOneCall(tc, args, toolName, callKey));
            } else {
              await _flushParallel();
              await _executeOneCall(tc, args, toolName, callKey);
            }
          }
          // Drain any remaining parallel-safe calls before moving on.
          await _flushParallel();
          // Silent-burst tally: this iteration ended in tool_calls. If the
          // model emitted no prose at all, count it. Reset the counter on
          // any non-empty preamble so an occasional silent round doesn't
          // accumulate. Threshold rationale: 4 = ~30s of silent reads at
          // typical opus-4.6 cadence (enough to be a real spiral, not a
          // legitimate multi-file scan); 7 = hard-stop ceiling.
          if (preambleForCtx.length === 0) {
            silentBursts++;
          } else {
            silentBursts = 0;
          }
          if (continueLoop && silentBursts >= 7) {
            console.log('[chat] silent-burst guard tripped at ' + silentBursts + ' silent iterations — stopping loop');
            allMessages.push({ role: 'user', content: '[System: You have run ' + (silentBursts + 1) + ' tool-call rounds in a row without producing any visible response. Stop calling tools NOW. Give the user a brief honest prose summary of what you investigated, what you found, what (if anything) you fixed, and the next concrete step. If the gen-ui catalog is loaded, finish with one compact completion card reflecting the same verified status. Do not make more tool calls.]' });
            toolsLockedForFinalResponse = true;
          } else if (continueLoop && !silentBurstNudgeFired && silentBursts >= 4) {
            silentBurstNudgeFired = true;
            console.log('[chat] silent-burst guard — injecting status-update nudge at ' + silentBursts + ' silent iterations');
            // IMPORTANT: do NOT teach the model a fixed template here (e.g.
            // "summarize (a) findings (b) hypothesis (c) next action") — past
            // versions did that and the model latched onto the template and
            // re-emitted the same three-sentence shape every turn. Keep the
            // instruction action-oriented and template-free.
            allMessages.push({ role: 'user', content: '[System: You have run ' + silentBursts + ' tool-call rounds in a row without producing visible text. Briefly tell the user — in your own words, NOT a fixed template — what you have actually found (cite file paths or output) and then take the next tool action. Do not write a status report on every turn; just one sentence + the next action.]' });
          }
          // After tools have run, decide whether the model is stuck repeating
          // itself. Inject a coaching message once, then hard-stop if it keeps
          // happening — better to surface what was attempted than to spam the
          // user with eight identical preambles.
          if (continueLoop && narrationRepeats >= 4) {
            console.log('[chat] narration-repetition guard tripped — stopping loop');
            allMessages.push({ role: 'user', content: '[System: You have repeated the same explanation ' + (narrationRepeats + 1) + ' times without making progress. Stop calling tools. Give the user a brief honest summary of what you tried, what failed, and one concrete alternative they could try (e.g., a manual step, a different site, or supplying credentials).]' });
            toolsLockedForFinalResponse = true;
            // Let the next iteration produce a final answer, but no more tools.
            // We do that by appending and continuing — the model will see the
            // directive and (typically) emit text only.
          } else if (continueLoop && !narrationNudgeFired && narrationRepeats >= 2) {
            narrationNudgeFired = true;
            console.log('[chat] narration-repetition guard — injecting coaching nudge');
            allMessages.push({ role: 'user', content: '[System: You are repeating the same explanation each turn without making progress. Do NOT narrate the same plan again. Either (a) take a materially different action — different tool, different site, different approach — or (b) stop and give the user a final summary of what was tried and what they can do next.]' });
          } else if (continueLoop && templateRepeats >= 3) {
            // Hard stop on the canned-template loop — at 3 consecutive
            // templated preambles we know the user is about to get spammed.
            console.log('[chat] template-repetition guard tripped at ' + templateRepeats + ' templated preambles — stopping loop');
            allMessages.push({ role: 'user', content: '[System: You have produced the same canned three-part status update on ' + (templateRepeats + 1) + ' consecutive turns without delivering an artifact. Stop. Skip the "I have confirmed / hypothesis / next action" prose entirely and either (a) call the tool that produces the actual deliverable the user asked for, or (b) emit the final answer/file/summary in this turn. No more status updates.]' });
            toolsLockedForFinalResponse = true;
          } else if (continueLoop && !templateNudgeFired && templateRepeats >= 2) {
            templateNudgeFired = true;
            console.log('[chat] template-repetition guard — injecting break-template nudge at ' + templateRepeats + ' templated preambles');
            allMessages.push({ role: 'user', content: '[System: Your last two preambles share the same template ("I have confirmed … / hypothesis / next action"). The user does not want a status report on every turn. Drop the template. Either call the next tool with NO preamble at all, or produce the actual deliverable now. If the original task requires creating files, create them this turn.]' });
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
          if (!assistantText.trim() && pendingCalls.length === 0 && !streamUsage && !finishReason) {
            if (noOutputStreamRetries < 1) {
              noOutputStreamRetries++;
              effectiveThinkingBudget = 'off';
              console.log('[chat] empty no-finish stream — retrying once with thinking disabled');
              allMessages.push({ role: 'user', content: '[System: The previous model stream ended with no text, no tool call, no finish reason, and no usage. Retry this turn now with no extended thinking. If the user just confirmed a previously offered action, perform that action with the appropriate tool call instead of thinking silently.]' });
              // keep continueLoop = true
            } else {
              console.log('[chat] empty no-finish stream repeated — surfacing error');
              send({
                type: 'error',
                error: 'The model returned an empty response without a finish reason, so Fauna could not act. Please try again or lower the thinking budget.'
              });
              send({ type: 'done', finish_reason: 'empty_response', usage: null,
                reasoning: sawReasoning ? { durationSeconds: reasoningStart ? Math.round((Date.now() - reasoningStart) / 1000) : null } : null
              });
              continueLoop = false;
            }
          // If this was an implementation request, read/search/audit tools are
          // not enough to terminate the turn. VS Code's agent loop keeps the
          // host in control until an edit/command mutation lands or the model
          // gives a real blocker; do the same here instead of accepting an
          // investigation-only final answer.
          } else if (_writeIntentTurn && toolCallCount > 0 && !mutatingToolUsed && inspectionOnlyNudges < MAX_INSPECTION_ONLY_NUDGES) {
            inspectionOnlyNudges++;
            console.log('[chat] write-intent inspection-only stop detected — forcing first concrete edit (' + inspectionOnlyNudges + '/' + MAX_INSPECTION_ONLY_NUDGES + ')');
            allMessages.push({ role: 'assistant', content: assistantText || '' });
            allMessages.push({ role: 'user', content: '[System: The user asked for implementation/fixes, but this turn only inspected/read/audited files and made no concrete mutation. Do NOT summarize or ask to continue. Make the smallest safe edit NOW using `fauna_apply_patch`, `fauna_replace_string`, `fauna_write_file`, or another real mutation tool. After the first edit, run a focused validation. If no edit is possible, respond with BLOCKED: and the exact blocker.]' });
            // keep continueLoop = true
          } else if (_writeIntentTurn && mutatingToolUsed && !validationToolUsed && validationRequiredNudges < MAX_VALIDATION_REQUIRED_NUDGES && !/^\s*(?:BLOCKED|NEEDS-INPUT)\s*:/i.test(assistantText || '')) {
            validationRequiredNudges++;
            console.log('[chat] write-intent mutation without validation detected — forcing focused validation (' + validationRequiredNudges + '/' + MAX_VALIDATION_REQUIRED_NUDGES + ')');
            allMessages.push({ role: 'assistant', content: assistantText || '' });
            allMessages.push({ role: 'user', content: '[System: You made a concrete change, but you have not validated it. Run the cheapest relevant validation NOW (for example `npm run build`, a focused test, lint/typecheck, or another project-specific check). Do not give the final summary until validation has run. If validation cannot run, respond with BLOCKED: and the exact reason.]' });
            // keep continueLoop = true
          // If tools were called but no text was produced, prompt a summary so the user sees something
          } else if (toolCallCount > 0 && !assistantText.trim() && continueCount < MAX_CONTINUES) {
            continueCount++;
            console.log('[chat] tool calls completed but no text output — prompting summary');
            allMessages.push({ role: 'assistant', content: '' });
            allMessages.push({ role: 'user', content: '[System: Your tool calls completed but you produced no visible response. Briefly summarize what you did for the user.]' });
            // keep continueLoop = true
          } else if (toolCallCount > 0 && assistantText.trim() && halfStopNudgeCount < MAX_HALF_STOP_NUDGES && HALF_STOP_RE.test(assistantText)) {
            // Codex-style persistence: the model used tools and then ended its turn by
            // asking the user whether to continue. Inject a synthetic nudge and re-loop
            // so the model finishes the task without bouncing back to the user.
            halfStopNudgeCount++;
            console.log('[chat] half-stop detected — injecting persistence nudge (' + halfStopNudgeCount + '/' + MAX_HALF_STOP_NUDGES + ')');
            allMessages.push({ role: 'assistant', content: assistantText });
            allMessages.push({ role: 'user', content: '[System: Do not ask whether to continue. Proceed with the next concrete step toward completing the original request, using tools as needed. Only stop when the task is fully resolved and verified — at which point give a final summary without any "want me to continue?" question.]' });
            // keep continueLoop = true
          } else if (toolCallCount > 0 && assistantText.trim() && halfStopNudgeCount < MAX_HALF_STOP_NUDGES && endsWithForwardPromise(assistantText)) {
            // Forward-promise stop: model said "I'll do X" / "Let me try Y" but never
            // actually called the tool. Nudge it to execute that promised step now.
            halfStopNudgeCount++;
            console.log('[chat] forward-promise stop detected — injecting execute nudge (' + halfStopNudgeCount + '/' + MAX_HALF_STOP_NUDGES + ')');
            allMessages.push({ role: 'assistant', content: assistantText });
            allMessages.push({ role: 'user', content: '[System: You just stated an intended next action ("I\'ll …" / "Let me …") but did not execute it. Do that step NOW with the appropriate tool call. Do not narrate intent without acting on it.]' });
            // keep continueLoop = true
          } else if (
            enableDynamicWidgets &&
            !widgetEmittedThisTurn &&
            widgetClaimNudges < MAX_WIDGET_CLAIM_NUDGES &&
            assistantText.trim() &&
            /\b(?:i\s+(?:rebuilt|made|created|attached|built|added|wired up|put together)\s+(?:it|the|a|an|this|that)?[^.\n]{0,60}(?:widget|viewer|3d|interactive|rotatable|scene|model|dashboard|playground|simulator)|here(?:'s|\s+is)\s+(?:the|your|a|an)?[^.\n]{0,40}(?:widget|3d\b|viewer|interactive|rotatable|scene)|i(?:'ve| have)\s+(?:rebuilt|attached|emitted|rendered|added|created)\s+(?:it|the|a|an)?[^.\n]{0,40}(?:widget|viewer|3d|scene|interactive))/i.test(assistantText)
          ) {
            // Widget-claim verifier: assistant text says it produced/rebuilt
            // a widget but no `fauna_emit_widget` tool call landed this turn.
            // Force a re-prompt with tool_choice pinned to the emit tool so
            // the model has to back its claim with an actual artifact.
            widgetClaimNudges++;
            console.log('[chat] widget-claim without emit detected — forcing re-emit (' + widgetClaimNudges + '/' + MAX_WIDGET_CLAIM_NUDGES + ')');
            allMessages.push({ role: 'assistant', content: assistantText });
            allMessages.push({ role: 'user', content: '[System: Your previous reply claimed you rendered/attached/rebuilt a widget, but you never called `fauna_emit_widget` in this turn. Words alone render nothing. Call `fauna_emit_widget` NOW with the full bundle (html + js, plus any tools). Do not narrate the change — emit it.]' });
            forceEmitWidgetNext = true;
            // keep continueLoop = true
          } else if (
            toolCallCount === 0 &&
            assistantText.trim() &&
            /```\s*(?:shell-output|write-file|shell-exec)\b/i.test(assistantText) &&
            !/(save|write|persist|create)\s+(?:it|this|the|spec|file|to|in)/i.test(allMessages.filter(m => m.role === 'user').pop()?.content || '')
          ) {
            // Fake-execution guard: assistant emitted markdown fenced content
            // (shell-output, write-file, shell-exec) WITHOUT any corresponding tool calls,
            // AND there's no "save/write/persist" in the user's recent request.
            // This is usually harmless (showing example code). Skip this guard if the user
            // explicitly asked for a save/write operation — those get the stronger guard below.
            // keep continueLoop = false — just emit as-is; this is informational content
          } else if (
            toolCallCount === 0 &&
            assistantText.trim() &&
            /```\s*(?:shell-output)\b/i.test(assistantText) &&
            (/(save|write|persist|create|store|put|export|generate|output|commit|deploy|build)\s+(?:it|this|the|spec|file|to|in|docs|folder|project|directory)/i.test(allMessages.filter(m => m.role === 'user').pop()?.content || '') || /(save|write|store|persist|put|export|generate|output).{0,30}(?:docs|folder|file|directory)/i.test(allMessages.filter(m => m.role === 'user').pop()?.content || ''))
          ) {
            // CRITICAL: fake-execution claim for a SAVE/CREATE operation. User asked to
            // save/write/export/generate to a folder/file, but assistant emitted a fake shell-output
            // block WITHOUT calling fauna_write_file or fauna_apply_patch. This is the
            // Fauna hallucination bug — assistant pretends success but nothing happened.
            // Force the model to use the actual tool with pinned tool_choice.
            console.log('[chat] fake-save-execution detected (shell-output without tool call) — forcing fauna_write_file with tool_choice constraint');
            allMessages.push({ role: 'assistant', content: assistantText });
            allMessages.push({ role: 'user', content: '[System: CRITICAL: Your previous response emitted a ```shell-output``` block but did NOT call any actual file-write tool (fauna_write_file, fauna_apply_patch, etc.). Markdown fences DO NOT execute — nothing was saved. You MUST use fauna_write_file or fauna_apply_patch to actually write files to disk. Re-emit your response NOW using the correct tool call with the exact file path and content. Do not emit markdown fences and claim success — only tool calls execute.]' });
            forceToolChoice = 'fauna_write_file';
            // keep continueLoop = true
          } else if (
            circuitRequested &&
            circuitHandauthNudges < MAX_CIRCUIT_HANDAUTH_NUDGES &&
            assistantText.trim() &&
            /<svg\b/i.test(assistantText) &&
            !/data-fauna-(?:circuit|pcb)/.test(assistantText)
          ) {
            // Hand-authored-circuit verifier: the model put an <svg> schematic
            // in its reply for a circuit request, but it lacks the engine's
            // provenance marker — so it was hand-drawn, not produced by
            // fauna_render_circuit. Re-prompt once to force a real render.
            circuitHandauthNudges++;
            console.log('[chat] hand-authored circuit SVG detected (no engine provenance marker) — forcing real render (' + circuitHandauthNudges + '/' + MAX_CIRCUIT_HANDAUTH_NUDGES + ')');
            allMessages.push({ role: 'assistant', content: assistantText });
            allMessages.push({ role: 'user', content: '[System: The schematic in your reply is hand-authored SVG, not output from fauna_render_circuit — it lacks the engine provenance marker. Hand-drawn schematics are forbidden: they render warped and are unverified. Call fauna_render_circuit({ doc }) NOW, then emit ONE gen-ui SVG block using its returned `svg` markup VERBATIM (do not redraw, reposition, or edit it). Keep the schematic as the LAST thing in the message.]' });
            // keep continueLoop = true
          } else if (
            toolCallCount === 0 &&
            assistantText.trim() &&
            /(?:now\s+(?:replacing|fixing|updating|adding|creating|generating|writing)|let\s+me\s+(?:replace|fix|update|add|create|generate|write)|going\s+to\s+(?:replace|fix|update|add|create|generate|write))\s+[^.!?\n]*(?:file|code|emoji|component|page|section|batch)/i.test(assistantText) &&
            assistantText.split('\n').length <= 3 &&
            (/(replace|fix|update|add|create|generate|write|build)\s+(?:all|the|every)\s+/i.test(allMessages.filter(m => m.role === 'user').pop()?.content || '') || /(replace|fix|update|build)\s+(?:emoji|icon|component|all)/i.test(allMessages.filter(m => m.role === 'user').pop()?.content || ''))
          ) {
            // Forward-operation incomplete: assistant claimed to start a batch operation
            // ("Now replacing...", "Let me fix...") but the response is too short (<=3 lines)
            // and no tool calls were made. This indicates mid-sentence termination or
            // hallucination of an upcoming operation without executing it.
            // Force completion with actual tool calls.
            console.log('[chat] incomplete-batch-operation detected (forward claim + no tools + short response) — forcing multi-tool retry');
            allMessages.push({ role: 'assistant', content: assistantText });
            allMessages.push({ role: 'user', content: '[System: Your previous response started describing a batch operation ("Now replacing...", "Let me...") but stopped before completing it and made no tool calls. Batch operations must be executed via actual tool invocations (e.g., multi_replace_string_in_file, fauna_write_file, fauna_apply_patch), not narrated as future intent. Complete the operation NOW by calling the appropriate tool(s) with all required parameters. Do not narrate intent — only execute.]' });
            forceToolChoice = 'fauna_write_file';
            // keep continueLoop = true
          } else if (
            toolCallCount === 0 &&
            assistantText.trim() &&
            /(?:successfully|completed|added|created|saved|written|generated|replaced|updated|deployed)\s+(?:to|at|in)?\s+(?:docs|folder|file|project|repository)/i.test(assistantText) &&
            !/\b(?:would|could|should|may|might|will)\b/i.test(assistantText)
          ) {
            // Meta-claim hallucination: assistant claims successful execution
            // ("Successfully saved to...", "Added to project", "Written to file")
            // but never called any tool. This is a direct false claim.
            console.log('[chat] meta-execution-claim detected (claimed success without tool call) — forcing actual tool call');
            allMessages.push({ role: 'assistant', content: assistantText });
            allMessages.push({ role: 'user', content: '[System: Your response claims a file/operation was successfully completed ("Saved", "Added", "Created", "Written"), but you did not call any file-write tool in this turn. Markdown text claims are not execution. Call the appropriate tool NOW (fauna_write_file, fauna_apply_patch, etc.) with the exact file path and content to back up your claim. Claims without tools = hallucination.]' });
            forceToolChoice = 'fauna_write_file';
            // keep continueLoop = true
          } else if (isOrchestratorTurn && assistantText.trim() && orchestratorNudgeCount < 2 && (() => {
            // Detect three orchestrator failure modes:
            //   (1) no [DELEGATE:...] block at all
            //   (2) [DELEGATE:] blocks present but every target is an
            //       unknown sub-agent (model invented a name) — the client
            //       silently drops these so the user sees a stalled reply
            //   (3) hallucinated function-calling JSON ({"name":"x",...})
            //       leaked into the visible text, even alongside a valid block
            const delegRe = /\[DELEGATE:(?:agents\/)?([\w-]+)\]/gi;
            const names = []; let m;
            while ((m = delegRe.exec(assistantText)) !== null) names.push(m[1]);
            const knownSet = new Set(orchestratorSubAgentNames);
            const validNames = orchestratorSubAgentNames.length
              ? names.filter(n => knownSet.has(n))
              : names; // no manifest sub-agents → can't validate, trust the model
            const invalidNames = orchestratorSubAgentNames.length
              ? names.filter(n => !knownSet.has(n))
              : [];
            const hasHallucinatedToolJson = /\{\s*"name"\s*:\s*"[\w-]+"\s*,\s*"(?:arguments|parameters)"\s*:/i.test(assistantText);
            const noValid = validNames.length === 0;
            return noValid || hasHallucinatedToolJson || invalidNames.length > 0;
          })()) {
            // Orchestrator emitted prose / hallucinated tool-call JSON / unknown
            // sub-agent names instead of a real, executable [DELEGATE:...] block.
            // Coach it and re-loop. JSON like `{"name":"x","arguments":{}}` is
            // NOT a tool call; it does nothing.
            orchestratorNudgeCount++;
            const delegRe2 = /\[DELEGATE:(?:agents\/)?([\w-]+)\]/gi;
            const namesEmitted = []; let mm;
            while ((mm = delegRe2.exec(assistantText)) !== null) namesEmitted.push(mm[1]);
            const invalid = orchestratorSubAgentNames.length
              ? namesEmitted.filter(n => !orchestratorSubAgentNames.includes(n))
              : [];
            console.log(`[chat] orchestrator delegation invalid — nudging (${orchestratorNudgeCount}/2). emitted=${JSON.stringify(namesEmitted)} valid=${JSON.stringify(orchestratorSubAgentNames)}`);
            const validList = orchestratorSubAgentNames.length
              ? '\n\nYour ONLY valid sub-agents are: ' + orchestratorSubAgentNames.map(n => '`agents/' + n + '`').join(', ') + '. Use these names EXACTLY — any other name will be silently dropped.'
              : '';
            const invalidNote = invalid.length
              ? '\n\nYou tried to delegate to ' + invalid.map(n => '`' + n + '`').join(', ') + ' which do not exist.'
              : '';
            allMessages.push({ role: 'assistant', content: assistantText });
            allMessages.push({ role: 'user', content: '[System: Your previous reply did not produce an executable delegation. You are an orchestrator with NO callable tools. JSON like `{"name":"x","arguments":{}}` or `{"name":"x","parameters":{}}` is NOT a tool call; it does nothing.' + invalidNote + validList + '\n\nRe-emit your response NOW as one or more `[DELEGATE:agents/<exact-sub-agent-name>]concise task[/DELEGATE]` blocks. No prose before or after, no JSON, no markdown — just the delegation block(s).]' });
            // keep continueLoop = true
          } else {
            // ── Autonomous-mode terminal gates ──────────────────────────
            // 1. DONE/BLOCKED/NEEDS-INPUT marker check (one retry only).
            // 2. QA gate: when marker is DONE: and a qa.command is set,
            //    run it once and re-loop if it fails.
            // Only engage when the model produced terminal text and we have
            // not been re-prompting for half-stops or narration.
            const finalMarker = autonomousMode ? finalStatusFromText(assistantText) : null;

            // Helper: run the deploy gate (if configured + approved + not yet
            // run) before emitting 'done'. Returns true when the deploy
            // failed and the loop should continue, false when we should
            // finalize the stream.
            const tryDeployGate = async () => {
              if (!autonomousMode || finalMarker !== 'DONE' || !deployCommand || deployRan) {
                return false;
              }
              deployRan = true;
              console.log('[chat] autonomous deploy gate: running `' + deployCommand + '`');
              try {
                send({ type: 'tool_call', name: 'autonomous_deploy_gate', args: { command: deployCommand } });
                const deployResultJson = await selfToolContext.runShell({
                  command: deployCommand,
                  cwd: _projectRecord?.rootPath || undefined,
                  reason: 'autonomous deploy gate',
                });
                let parsed = null;
                try { parsed = JSON.parse(deployResultJson); } catch (_) {}
                const deployOk = parsed && (parsed.ok === true || parsed.exitCode === 0);
                deployResultSummary = {
                  ok: !!deployOk,
                  exitCode: parsed?.exitCode ?? null,
                  command: deployCommand,
                };
                send({ type: 'tool_result', name: 'autonomous_deploy_gate', result: deployResultJson });
                if (deployOk) return false;
                allMessages.push({ role: 'assistant', content: assistantText });
                allMessages.push({ role: 'user', content: '[System: The deploy gate `' + deployCommand + '` FAILED. Output:\n\n' + (deployResultJson || '(no output)').slice(0, 4000) + '\n\nDo NOT emit DONE: until the deploy succeeds or you escalate with BLOCKED: and a precise reason.]' });
                return true;
              } catch (deployErr) {
                console.warn('[chat] autonomous deploy gate threw:', deployErr?.message || deployErr);
                deployResultSummary = { ok: false, error: deployErr?.message || String(deployErr), command: deployCommand };
                return false; // hard failure — let the stream finalize, surface in run log
              }
            };

            const tryStopHookGate = async () => {
              if (!autonomousMode || finalMarker !== 'DONE' || stopHooksRan) {
                return false;
              }
              stopHooksRan = true;
              const stopHooks = await runHooks(customizationRecords, 'Stop', {
                finalStatus: finalMarker,
                finalMessage: assistantText,
                agentName: agentName || null,
                conversationId: req.body?.conversationId || null,
                toolCallCount,
                qaResult: qaResultSummary,
                deployResult: deployResultSummary,
              }, { cwd: workspaceRoot });
              stopHookResultSummary = {
                ok: !!stopHooks.ok,
                count: stopHooks.count,
                blocked: !!stopHooks.blocked,
                stopReason: stopHooks.stopReason || '',
              };
              if (stopHooks.systemMessages?.length) {
                for (const message of stopHooks.systemMessages) {
                  if (message) allMessages.push({ role: 'system', content: String(message) });
                }
              }
              if (!stopHooks.blocked) return false;
              allMessages.push({ role: 'assistant', content: assistantText });
              allMessages.push({ role: 'user', content: '[System: A Stop hook blocked DONE:. Reason:\n\n' + (stopHooks.stopReason || 'Stop hook blocked completion.').slice(0, 4000) + '\n\nAddress this, then re-run verification. Do NOT emit DONE: until the Stop hook passes, or use BLOCKED: with a precise reason if it cannot be satisfied.]' });
              return true;
            };

            if (autonomousMode && assistantText.trim() && !finalMarker && !markerNudgeFired) {
              markerNudgeFired = true;
              console.log('[chat] autonomous: missing terminal marker — nudging once');
              allMessages.push({ role: 'assistant', content: assistantText });
              allMessages.push({ role: 'user', content: '[System: Autonomous mode requires your FINAL message to begin with one of `DONE:`, `BLOCKED:`, or `NEEDS-INPUT:` on its own line. Re-emit your final summary with the correct marker. If the work is verifiably complete (including any acceptance criteria), use DONE:.]' });
              // keep continueLoop = true
            } else if (autonomousMode && finalMarker === 'DONE' && !verificationNudgeFired && !hasDoneEvidence(assistantText)) {
              verificationNudgeFired = true;
              console.log('[chat] autonomous: DONE without verification evidence — nudging once');
              allMessages.push({ role: 'assistant', content: assistantText });
              allMessages.push({ role: 'user', content: '[System: You emitted DONE: without citing verification evidence from a command, file, diagnostic, tool output, screenshot, or log. Do not mark autonomous work complete from assertion alone. Perform or cite concrete verification, then re-emit DONE: with the evidence. If verification is impossible, use BLOCKED: with the precise reason.]' });
            } else if (autonomousMode && finalMarker === 'DONE' && qaCommand && !qaRan) {
              qaRan = true;
              console.log('[chat] autonomous QA gate: running `' + qaCommand + '`');
              try {
                send({ type: 'tool_call', name: 'autonomous_qa_gate', args: { command: qaCommand } });
                const qaResultJson = await selfToolContext.runShell({
                  command: qaCommand,
                  cwd: _projectRecord?.rootPath || undefined,
                  reason: 'autonomous qa gate',
                });
                let parsed = null;
                try { parsed = JSON.parse(qaResultJson); } catch (_) {}
                const qaOk = parsed && (parsed.ok === true || parsed.exitCode === 0);
                qaResultSummary = {
                  ok: !!qaOk,
                  exitCode: parsed?.exitCode ?? null,
                  command: qaCommand,
                };
                send({ type: 'tool_result', name: 'autonomous_qa_gate', result: qaResultJson });

                if (qaOk) {
                  // QA passed — try deploy gate, then finalize.
                  const deployFailed = await tryDeployGate();
                  if (deployFailed) {
                    // keep continueLoop = true
                  } else if (await tryStopHookGate()) {
                    // keep continueLoop = true
                  } else {
                    send({ type: 'done', finish_reason: finishReason, usage: streamUsage || null,
                      reasoning: sawReasoning ? { durationSeconds: reasoningStart ? Math.round((Date.now() - reasoningStart) / 1000) : null } : null
                    });
                    continueLoop = false;
                  }
                } else {
                  // Fail — feed the result back and keep looping.
                  allMessages.push({ role: 'assistant', content: assistantText });
                  allMessages.push({ role: 'user', content: '[System: The QA gate `' + qaCommand + '` FAILED. Output:\n\n' + (qaResultJson || '(no output)').slice(0, 4000) + '\n\nDo NOT emit DONE: until QA passes. Diagnose the failure, fix it, and re-run the work. If the failure is environmental and out of scope, use BLOCKED: with a precise reason.]' });
                  // keep continueLoop = true
                }
              } catch (qaErr) {
                console.warn('[chat] autonomous QA gate threw:', qaErr?.message || qaErr);
                qaResultSummary = { ok: false, error: qaErr?.message || String(qaErr), command: qaCommand };
                send({ type: 'done', finish_reason: finishReason, usage: streamUsage || null,
                  reasoning: sawReasoning ? { durationSeconds: reasoningStart ? Math.round((Date.now() - reasoningStart) / 1000) : null } : null
                });
                continueLoop = false;
              }
            } else if (autonomousMode && finalMarker === 'DONE' && deployCommand && !deployRan) {
              // DONE: with no QA configured but a deploy gate exists.
              const deployFailed = await tryDeployGate();
              if (deployFailed) {
                // keep continueLoop = true
              } else if (await tryStopHookGate()) {
                // keep continueLoop = true
              } else {
                send({ type: 'done', finish_reason: finishReason, usage: streamUsage || null,
                  reasoning: sawReasoning ? { durationSeconds: reasoningStart ? Math.round((Date.now() - reasoningStart) / 1000) : null } : null
                });
                continueLoop = false;
              }
            } else if (autonomousMode && finalMarker === 'DONE' && await tryStopHookGate()) {
              // keep continueLoop = true
            } else {
              send({ type: 'done', finish_reason: finishReason, usage: streamUsage || null,
                reasoning: sawReasoning ? { durationSeconds: reasoningStart ? Math.round((Date.now() - reasoningStart) / 1000) : null } : null
              });
              continueLoop = false;
            }

            // Once-per-run: when autonomous mode terminates, write a JSONL log
            // entry and fire a cheap no-tools reflection turn that extracts
            // 0-3 short lessons into long-term memory. Failures here must not
            // affect the user-visible response.
            if (autonomousMode && !continueLoop) {
              const finalStatus = finalMarker || 'UNMARKED';
              try {
                appendAutonomousRunLog(projectId, {
                  convId: req.body?.conversationId || null,
                  model,
                  toolCallCount,
                  finalStatus,
                  qaResult: qaResultSummary,
                  deployResult: deployResultSummary,
                  stopHookResult: stopHookResultSummary,
                  durationMs: Date.now() - autonomousStartedAt,
                  startedAt: autonomousStartedAt,
                });
              } catch (e) { console.warn('[chat] autonomous run log failed:', e?.message || e); }

              // Fire reflection in the background — do not await; it must not
              // block the SSE 'done' that already fired above.
              (async () => {
                try {
                  const transcriptForReflection = allMessages
                    .filter(m => m.role !== 'system')
                    .slice(-12)
                    .map(m => `[${m.role}] ${typeof m.content === 'string' ? m.content : JSON.stringify(m.content)}`)
                    .join('\n').slice(0, 8000);
                  const reflection = await selfToolContext.callLLM({
                    system: 'You extract durable lessons from agent transcripts. Output STRICT JSON of the form {"facts":[{"text":"...","category":"preference|fact|decision|context"}]} with 0 to 3 short, specific lessons. No prose, no markdown, JSON only.',
                    user: 'Final status: ' + finalStatus + '\n\nRecent transcript:\n' + transcriptForReflection,
                    maxTokens: 400,
                    temperature: 0.2,
                  });
                  const jsonMatch = String(reflection || '').match(/\{[\s\S]*\}/);
                  if (!jsonMatch) return;
                  const parsed = JSON.parse(jsonMatch[0]);
                  const facts = Array.isArray(parsed?.facts) ? parsed.facts.slice(0, 3) : [];
                  for (const f of facts) {
                    if (f && typeof f.text === 'string' && f.text.trim()) {
                      try { factsRemember(f.text.trim(), f.category || 'fact'); } catch (_) {}
                    }
                  }
                  if (facts.length) console.log('[chat] autonomous reflection saved ' + facts.length + ' fact(s)');
                } catch (e) { console.warn('[chat] reflection failed:', e?.message || e); }
              })();
            }

            // Failure→fix learning (headroom `learn`): pair each failed tool
            // call with the next successful one and persist the concrete
            // correction (wrong path → right path, failed cmd → working cmd)
            // as a fact, so future turns avoid the same wasted retries. Pure +
            // LLM-free, so it's safe to run synchronously at end-of-loop.
            if (!continueLoop && !isDelegation && !isCLI && projectId && Array.isArray(allMessages)) {
              try {
                const corrections = extractCorrections(allMessages);
                let savedCorrections = 0;
                for (const c of corrections) {
                  try { const r = factsRemember(c.text, c.category); if (r && r.ok) savedCorrections++; } catch (_) {}
                }
                if (savedCorrections) console.log(`[chat] failure-learning saved ${savedCorrections} correction(s)`);
              } catch (e) { console.warn('[chat] failure-learning failed:', e?.message || e); }
            }

            // Phase 1: generic auto-extraction. Runs at end-of-loop for any
            // project whose memoryConfig.autoExtract is 'every-turn'. Cheap,
            // fire-and-forget, gated to avoid duplicate work in sub-agent and
            // CLI calls.
            if (!continueLoop && !isDelegation && !isCLI && projectId && _projectRecord) {
              const _mcfg = _projectRecord.memoryConfig || {};
              if (_mcfg.autoExtract === 'every-turn' && Array.isArray(allMessages) && allMessages.length >= 2) {
                (async () => {
                  try {
                    const aiCaller = (prompt) => selfToolContext.callLLM({
                      user: prompt, maxTokens: 800, temperature: 0.2,
                    });
                    const r = await extractMemoryFacts({
                      messages: allMessages,
                      projectId,
                      conversationId: req.body?.conversationId || null,
                      aiCaller,
                      autoApprove: _mcfg.requireApproval !== true,
                    });
                    if (r.applied || r.proposals.length) {
                      try { send({ type: 'memory_proposal', applied: r.applied, pending: r.proposals.filter(p => p.status === 'pending').length }); } catch (_) {}
                      console.log(`[chat] memory-extractor: applied=${r.applied} skipped=${r.skipped} pending=${r.proposals.filter(p => p.status === 'pending').length}`);
                    }
                  } catch (e) { console.warn('[chat] memory-extractor failed:', e?.message || e); }
                })();
              }
            }
          }
        }
      }
    } catch (err) {
      // Suppress noise from intentional aborts (Stop button / client disconnect).
      // Only treat as abort if we actually aborted the controller — checking the
      // error message text alone is too loose and swallows real upstream errors
      // whose messages happen to mention "abort".
      if (streamStalled) {
        console.log('[chat] upstream stream stalled (no chunks for >120s) — aborting turn');
        try {
          send({
            type: 'error',
            error: 'The model stopped responding (no data for over 2 minutes). This can happen on very large generations. Please try again — and if it recurs, lower the thinking budget or simplify the request.'
          });
        } catch (_) {}
      } else if (thinkingDeadlineHit) {
        console.log('[chat] first-content deadline hit — model never produced output, aborting turn');
        try {
          send({
            type: 'error',
            error: thinkingBudget === 'auto'
              ? 'The model spent too long thinking without producing any answer. Auto picked too high a thinking budget for this request — set Settings → Thinking Budget to Low and try again.'
              : 'The model spent too long thinking without producing any answer. This usually means the thinking budget is too high for the request — set Settings → Thinking Budget to Auto (or a lower level) and try again.'
          });
        } catch (_) {}
      } else if (upstreamAbort.signal.aborted) {
        console.log('[chat] upstream aborted by client');
      } else {
        try { send({ type: 'error', error: err.message }); } catch (_) {}
      }
    } finally {
      if (subagentStarted && subagentStopPayload) {
        try {
          const stopHooks = await runHooks(customizationRecords, 'SubagentStop', {
            ...subagentStopPayload,
            streamStalled,
            thinkingDeadlineHit,
            aborted: !!upstreamAbort.signal.aborted,
          }, { cwd: workspaceRoot });
          if (stopHooks.blocked && !res.writableEnded) {
            send({ type: 'error', error: stopHooks.stopReason || 'SubagentStop hook blocked this delegation result.' });
          }
        } catch (hookErr) {
          console.warn('[chat] SubagentStop hook failed:', hookErr?.message || hookErr);
        }
      }
      try { res.off('close', cancelUpstream); } catch (_) {}
      clearInterval(_sseHeartbeat);
    }

    if (!res.writableEnded) res.end();
  });
}
