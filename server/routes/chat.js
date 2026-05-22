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
import { FALLBACK_MODELS, CHAT_COMPLETIONS_UNSUPPORTED_RE } from '../copilot/models.js';
import { GEN_UI_CATALOG_PROMPT } from '../prompts/gen-ui-catalog.js';
import { SELF_TOOL_DEFS, DYNAMIC_WIDGET_TOOL_DEFS, executeSelfTool, isSelfTool } from '../../self-tools.js';
import { runShell, formatShellResultForLLM, isCommandSafe } from '../lib/shell-runner.js';
import { applyPatchText } from './agent-sandbox-files.js';
import {
  extractWidgetRegistrations, buildEphemeralToolDefs,
  isWidgetTool, parseWidgetToolName,
} from '../../lib/dynamic-widgets.js';
import { ToolGuardContext, formatToolLabel } from '../../tool-guard.js';
import { getAgentTools, startAgentMCPServers } from '../../agent-tools.js';
import { formatForSystemPrompt as factsForSystemPrompt, getStats as factsGetStats } from '../../memory-store.js';
import { getProjectSystemContext, buildContextPayload } from '../../project-manager.js';
import { estimateTokens, computeBudget } from '../lib/token-budget.js';
import { summarizeHistory } from '../lib/summarize-history.js';

export function registerChatRoute(app, {
  figma,
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
      return res.status(404).json({ ok: false, error: 'Unknown or expired callId' });
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
      return res.status(404).json({ ok: false, error: 'Unknown or expired callId' });
    }
    widgetPendingCalls.delete(callId);
    clearTimeout(pending.timer);
    if (error) pending.reject(new Error(String(error)));
    else pending.resolve(result);
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
    const cancelUpstream = () => {
      if (res.writableEnded) return; // normal completion, not a real client abort
      try { upstreamAbort.abort(); } catch (_) {}
    };
    res.on('close', cancelUpstream);
    const { messages = [], model = 'claude-sonnet-4.6', systemPrompt = '', useFigmaMCP = false, contextSummary = '',
            thinkingBudget = 'high', maxContextTurns = 20, agentName = null,
            projectId = null, projectContextIds = null, isDelegation = false,
            clientContext = 'app', noTools = false,
            enableDynamicWidgets = false } = req.body;
    const isCLI = clientContext === 'cli';

    // Track the active conversation model so heartbeat/workflows/teams use the same one
    setActiveModel(model);

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

      // Build project context from active project (name, root, sources, pinned/enabled contexts)
      let projectCtx = '';
      if (projectId) {
        projectCtx = projectContextIds && projectContextIds.length
          ? buildContextPayload(projectId, projectContextIds)
          : getProjectSystemContext(projectId);
      }

      // Build system prompt — append project context, facts memory, context summary and browser context.
      // For delegation (sub-agent) calls, skip heavy shared context to reduce token cost.
      const factsCtx = isDelegation ? '' : factsForSystemPrompt(20);
      // Inject connected Figma file info so AI can target the right document
      let figmaFilesCtx = '';
      const _figmaFilesList = figma.listFiles();
      if (useFigmaMCP && _figmaFilesList.length > 0) {
        const entries = _figmaFilesList.map(f => `- "${f.fileName}" (fileKey: ${f.fileKey}, page: ${f.currentPage})`).join('\n');
        figmaFilesCtx = `\n## Connected Figma Documents\nThe following Figma documents are currently open with the plugin running:\n${entries}\nWhen using figma_execute, pass the fileKey parameter to target a specific document. If omitted, the most recently active document is used.\nIMPORTANT: Dev Mode MCP tools (get_screenshot, get_design_context, get_metadata, etc.) always operate on whichever file is currently focused in Figma — they do NOT accept a fileKey parameter. If you need to read from or screenshot a specific file, use figma_execute with the fileKey parameter instead.`;
      }
      const cliHint = isCLI ? `\n\n## Output Format\nYou are running in a terminal CLI. Respond in plain, readable text. Do NOT use markdown headers (###), horizontal rules (---), or emojis. Use plain bullet points (- or *) only when a list genuinely helps. Be concise and direct. Never emit browser-action or browser-ext-action code blocks — those do not work in the terminal.` : '';
      const fullSystem = [
        systemPrompt.trim() + cliHint,
        isDelegation ? '' : projectCtx,
        factsCtx,
        (isDelegation || isCLI || noTools) ? '' : browserBuildContext,
        (isDelegation || isCLI || noTools) ? '' : buildBrowserExtContext(),
        (isDelegation || isCLI || noTools) ? '' : GEN_UI_CATALOG_PROMPT,
        contextSummary ? `\n## Task Context (auto-summarized from earlier conversation)\n${contextSummary}` : '',
        figmaFilesCtx
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
            console.warn('[chat] auto-compaction failed, continuing with plain trim:', e?.message || e);
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
      allMessages.push(...trimmed);

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
        const CIRCUIT_RE = /\b(schematic|circuit|wiring diagram|netlist|breadboard|rc (low|high)[- ]?pass|low[- ]?pass filter|high[- ]?pass filter|band[- ]?pass|op[- ]?amp|555 timer|transistor amp(?:lifier)?|voltage divider|h[- ]?bridge|rectifier|flip[- ]?flop|d[- ]?type latch|kicad|spice)\b/i;
        if (lastText && CIRCUIT_RE.test(lastText) && !isCLI && !noTools) {
          allMessages.push({
            role: 'system',
            content:
              '[Circuit/schematic request detected] You MUST render this using the circuit tools before writing any prose summary. Required sequence for THIS turn:\n' +
              '1. (Optional) fauna_list_circuit_symbols — only if you are unsure of pin names.\n' +
              '2. fauna_render_circuit({ doc }) — returns { svg, width, height }.\n' +
              '3. fauna_validate_circuit({ doc }) — surface any errors/warnings.\n' +
              '4. (Optional) fauna_simulate_circuit({ doc, analysis }) — for behaviour questions; if ngspice is missing, surface the install hint and continue with the analytical answer.\n' +
              '5. Emit ONE gen-ui block whose root contains an SVG element: { "type":"SVG", "props":{ "markup":"<svg …>…</svg>" } } using the markup returned by fauna_render_circuit verbatim.\n' +
              '6. After the gen-ui block, write the prose summary (component values, expected behaviour, key formulas).\n' +
              'Forbidden: pasting the raw <svg> into a plaintext/html/markdown code fence; describing the schematic without calling fauna_render_circuit; computing analytically only.'
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
      let mcpTools;
      if (useFigmaMCP) {
        try { mcpTools = await figma.getMcpTools(); } catch (_) {
          // Fallback: always expose figma_execute even when port-3845 is unavailable
          mcpTools = [figma.executeToolDef];
        }
      }

      // Load agent tools if an agent is active
      let agentToolHandlers = null; // Map<name, executeFn>
      if (agentName) {
        const safeAgentName = agentName.replace(/[^a-zA-Z0-9_-]/g, '');
        const agentDir = path.join(agentsDir, safeAgentName);
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
        runShell: async ({ command, cwd, timeoutMs, reason } = {}) => {
          if (!shellBin) {
            return JSON.stringify({ ok: false, error: 'shell exec not configured in this server' });
          }
          if (!command || typeof command !== 'string') {
            return JSON.stringify({ ok: false, error: 'command (string) required' });
          }
          if (!isCommandSafe(command)) {
            return JSON.stringify({
              ok: false,
              refused: true,
              error: 'This command requires explicit user approval. Re-emit it as a ```bash markdown block so the user can review and Run it. Do not retry fauna_shell_exec with the same command.',
              command,
            });
          }
          send({ type: 'tool_call', name: 'fauna_shell_exec', label: 'Running: ' + command.slice(0, 80) + (command.length > 80 ? '…' : '') });
          const result = await runShell({
            command,
            cwd,
            shellBin,
            isWin,
            augmentedPath,
            timeoutMs: typeof timeoutMs === 'number' ? Math.min(timeoutMs, 600000) : undefined,
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
            } : null,
          });
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
      };
      if (!isCLI && !noTools) {
        mcpTools = [...(mcpTools || []), ...SELF_TOOL_DEFS];
        if (enableDynamicWidgets) mcpTools = [...mcpTools, ...DYNAMIC_WIDGET_TOOL_DEFS];
      }

      // Agentic loop — re-runs if model calls tools (max 12 iterations)
      let continueLoop = true;
      let toolCallCount = 0;
      let continueCount = 0; // track auto-continue on length finish
      let halfStopNudgeCount = 0; // Codex-style: re-prompt model if it asks the user to continue mid-task
      const MAX_TOOL_CALLS = 50;
      const MAX_CONTINUES = 6; // max auto-continue attempts for truncated output
      const MAX_HALF_STOP_NUDGES = 2; // re-prompt at most twice before letting the model stop
      const MAX_RESULT_CHARS = 40000; // prevent context overflow from large tool responses
      const toolCallsSeen = new Map(); // deduplicate identical calls

      // Half-stop detector: model finishes mid-task by asking the user whether to proceed.
      // Matches the explicit phrases blacklisted in the system prompt's persistence section.
      const HALF_STOP_RE = /\b(want me to (continue|proceed|go ahead|keep going|do that|move on)|shall i (continue|proceed|go ahead|keep going)|should i (continue|proceed|go ahead|keep going)|do you want me to|let me know (if|when) you (want|'?d like) (me )?to|ready for the next (step|one|part)|ready to (continue|proceed)|on your (go|signal|word)|just (say|let me know) (the word|when)|happy to (continue|proceed|keep going) if)/i;

      // ── Tool guard — pre-call checks, category limits, browser discipline ──
      const toolGuard = new ToolGuardContext({
        send,
        onPermissionRequest: async (toolName, args, info) => {
          // For now, send SSE event and auto-allow (Phase 2 will add interactive prompt)
          send({ type: 'tool_permission_request', name: toolName, args, label: info.label, category: info.category });
          return 'allow';
        },
      });

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

        // Inject ephemeral widget tools — re-scanned each turn so widgets
        // emitted earlier in this same request become callable on the next
        // iteration of the agentic loop.
        if (enableDynamicWidgets) {
          const ephemeral = buildEphemeralToolDefs(extractWidgetRegistrations(allMessages));
          if (ephemeral.length) {
            params.tools = [...(params.tools || []), ...ephemeral];
          }
        }
        params.stream_options = { include_usage: true };

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

        for await (const chunk of stream) {
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
                send({ type: 'content', content: block.text });
              }
            }
          }

          // ── Standard text delta ────────────────────────────────────────────
          if (typeof delta.content === 'string' && delta.content) {
            assistantText += delta.content;
            send({ type: 'content', content: delta.content });
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

            // Hard stop: too many tool calls (legacy global limit as safety net)
            if (toolCallCount > MAX_TOOL_CALLS) {
              allMessages.push({ role: 'tool', tool_call_id: tc.id, content: 'Tool call limit reached (' + MAX_TOOL_CALLS + ' calls). If the user\'s task is genuinely complete and verified, give the final summary now. If concrete work remains, state the exact next step that must be taken and why it could not be inferred — do NOT ask the user whether to proceed.' });
              continue;
            }

            // Deduplicate: same tool + same args already called
            if (toolCallsSeen.has(callKey)) {
              allMessages.push({ role: 'tool', tool_call_id: tc.id, content: toolCallsSeen.get(callKey) });
              continue;
            }

            // ── Pre-tool-call guard ─────────────────────────────────────────
            const args = JSON.parse(tc.function.arguments || '{}');
            const guardResult = await toolGuard.check(toolName, args);

            if (guardResult.action === 'deny') {
              allMessages.push({ role: 'tool', tool_call_id: tc.id, content: guardResult.reason });
              continue;
            }

            // inject_snapshot: force a browser snapshot before the blind action
            if (guardResult.action === 'inject_snapshot') {
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
                // Snapshot failed — allow the original action to proceed
                console.log('[tool-guard] auto-snapshot failed:', snapErr.message);
              }
            }

            // Send human-readable tool status to the client
            const toolLabel = formatToolLabel(toolName, args);
            send({ type: 'tool_call', name: toolName, label: toolLabel });

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
                    send({ type: 'widget_tool_pending', callId, widgetId: reg.widgetId, name: parsed.toolName, args });
                  }).catch(err => ({ ok: false, error: err.message }));
                  result = typeof rpcResult === 'string' ? rpcResult : JSON.stringify(rpcResult);
                }
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
                figma.log('🔧 ' + toolName + (toolName === 'figma_execute' ? ': ' + (args.code || '').slice(0, 80).replace(/\n/g,' ') + '…' : ''), 'cmd');
                result = await figma.callMcpTool(toolName, args);
                figma.log('✓ ' + toolName + ' done', 'ok');
              }

              // Truncate oversized results (screenshots, large contexts)
              if (typeof result === 'string' && result.length > MAX_RESULT_CHARS) {
                result = result.slice(0, MAX_RESULT_CHARS) + `\n\n[Truncated — ${result.length} chars total]`;
              }
              toolCallsSeen.set(callKey, result);
              allMessages.push({ role: 'tool', tool_call_id: tc.id, content: typeof result === 'string' ? result : JSON.stringify(result) });
            } catch (e) {
              allMessages.push({ role: 'tool', tool_call_id: tc.id, content: `Error: ${e.message}` });
              figma.log('✗ ' + toolName + ': ' + e.message, 'err');
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
          // If tools were called but no text was produced, prompt a summary so the user sees something
          if (toolCallCount > 0 && !assistantText.trim() && continueCount < MAX_CONTINUES) {
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
          } else {
            send({ type: 'done', finish_reason: finishReason, usage: streamUsage || null,
              reasoning: sawReasoning ? { durationSeconds: reasoningStart ? Math.round((Date.now() - reasoningStart) / 1000) : null } : null
            });
            continueLoop = false;
          }
        }
      }
    } catch (err) {
      // Suppress noise from intentional aborts (Stop button / client disconnect).
      // Only treat as abort if we actually aborted the controller — checking the
      // error message text alone is too loose and swallows real upstream errors
      // whose messages happen to mention "abort".
      if (upstreamAbort.signal.aborted) {
        console.log('[chat] upstream aborted by client');
      } else {
        try { send({ type: 'error', error: err.message }); } catch (_) {}
      }
    } finally {
      try { res.off('close', cancelUpstream); } catch (_) {}
    }

    if (!res.writableEnded) res.end();
  });
}
