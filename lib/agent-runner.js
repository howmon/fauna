// lib/agent-runner.js
//
// Extracted agentic loop — the provider-agnostic core of /api/chat.
//
// This module owns the "while (continueLoop)" logic:
//   1. Build params, call the LLM
//   2. Stream response, collect text + tool_calls
//   3. For each tool_call: evaluate policy → execute → push result
//   4. Decide whether to loop, stop, or continue (finish_reason=length)
//
// It is an async generator that yields typed event objects matching the
// existing /api/chat SSE wire format. The Express route in chat.js can
// migrate to this incrementally — existing callers keep working unchanged.
//
// Usage (new callers):
//
//   for await (const event of runAgentLoop(opts)) {
//     sendSse(res, event);
//   }
//
// ── Why async generator? ─────────────────────────────────────────────────
// The loop must both push events AND suspend waiting for async tool results.
// A generator naturally expresses this: each `yield` pushes an event to the
// consumer; each `await` inside the loop suspends without blocking the caller.
// The consumer drives backpressure by waiting for `next()` before continuing.
//
// ── Migration path ───────────────────────────────────────────────────────
// Phase 1 (this file): Define the interface and guard types. The generator
//   delegates to the chat.js loop implementation via runAgentLoopCompat().
// Phase 2: Move the stream-collection + tool-dispatch blocks here.
// Phase 3: chat.js's POST handler becomes a 10-line wrapper.
//
// ── Event schema (matches SSE events in chat.js) ──────────────────────────
// { type: 'content',         content: string }
// { type: 'reasoning' }
// { type: 'tool_call',       callId, name, label, command, activity }
// { type: 'tool_progress',   callId, name, message, elapsedSeconds, completed?, failed? }
// { type: 'tool_activity_result', callId, name, status, summary }
// { type: 'token_usage',     prompt, completion, total, iterations, window }
// { type: 'done',            finish_reason, usage? }
// { type: 'error',           error }

import { ChatTracer } from './run-ledger.js';
import path from 'path';
import os from 'os';
import crypto from 'crypto';

// ── Guard defaults ────────────────────────────────────────────────────────

export const LOOP_DEFAULTS = Object.freeze({
  maxContinues:      6,       // auto-continue on finish_reason=length
  maxHalfStopNudges: 2,       // re-prompt before letting model stop mid-task
  maxSilentBursts:   7,       // hard-stop on N consecutive silent tool-call rounds
  silentBurstNudge:  4,       // warning nudge threshold
  narrationRepeatHardStop: 4, // consecutive near-identical preambles → stop
  narrationRepeatNudge:    2, // first coaching nudge threshold
  templateRepeatHardStop:  3, // canned-template preambles → stop
  templateRepeatNudge:     2, // first template-nudge threshold
  maxWidgetClaimNudges: 1,
  maxInspectionOnlyNudges: 3,
  maxValidationRequiredNudges: 2,
  maxRuntimeVerificationNudges: 2,
  maxCircuitHandauthNudges: 1,
  maxResultChars: 40000,
  maxContextTurns: 20,
});

// ── Tool capability categories ────────────────────────────────────────────

/** Tools that can run concurrently without ordering hazards. */
export const PARALLEL_SAFE_TOOLS = new Set([
  'fauna_read_file',
  'fauna_file_search',
  'fauna_grep',
  'fauna_workspace_search',
  'fauna_list_directory',
  'agent_read_file',
  'agent_list_files',
  'agent_search_files',
]);

/** Tools whose execution mutates state (file writes, external side-effects). */
export const MUTATING_TOOLS = new Set([
  'fauna_write_file', 'fauna_write_files', 'fauna_apply_patch',
  'fauna_replace_string', 'fauna_write_offloaded',
  'agent_write_file', 'agent_write_files', 'agent_str_replace', 'agent_apply_patch',
  'fauna_create_agent', 'fauna_patch_agent', 'fauna_uninstall_agent',
  'fauna_emit_widget', 'fauna_save_instruction',
  'fauna_save_widget_to_playbook', 'fauna_load_widget_from_playbook',
  'figma_execute',
  'fauna_send_notification',
  'fauna_image_generate', 'fauna_image_edit', 'fauna_stock_image_download',
  'fauna_video_create', 'fauna_video_run_all', 'fauna_video_step', 'fauna_video_patch',
  'fauna_speak', 'fauna_podcast',
]);

// ── ToolPolicy (Gap 3 interface) ──────────────────────────────────────────
// Wraps the permission model for a single request. Centralises the
// allow/deny/require-approval decision that is currently scattered across
// chat.js, permission-guard.js, and tool-guard.js.
//
// `evaluate(toolName, args)` returns:
//   { allowed: true }
//   { allowed: false, reason: string }
//   { requiresApproval: true, label: string }

export class ToolPolicy {
  /**
   * @param {object} permissions  — shape from project.permissions
   *   { shell: boolean|{cwd:string}, fileRead: string[], fileWrite: string[], browser: boolean }
   * @param {object} [agentPermissions]  — merged agent manifest permissions
   */
  constructor(permissions = {}, agentPermissions = {}) {
    this.permissions = permissions;
    this.agentPermissions = agentPermissions;
  }

  evaluate(toolName, _args = {}) {
    // Shell tools
    if (toolName === 'fauna_shell_exec') {
      const shellPerm = this.permissions.shell ?? this.agentPermissions.shell;
      if (shellPerm === false) return { allowed: false, reason: 'Shell execution is disabled for this project.' };
    }
    // Browser tools
    if (/\bbrowser\b/i.test(toolName) || toolName.startsWith('browser_')) {
      const browserPerm = this.permissions.browser ?? this.agentPermissions.browser;
      if (browserPerm === false) return { allowed: false, reason: 'Browser access is disabled for this project.' };
    }
    // File-write tools
    if (MUTATING_TOOLS.has(toolName) && toolName.includes('write')) {
      const writePaths = this.permissions.fileWrite ?? this.agentPermissions.fileWrite ?? [];
      if (Array.isArray(writePaths) && writePaths.length === 0) {
        return { allowed: false, reason: 'File writes are not permitted — no write paths configured.' };
      }
    }
    return { allowed: true };
  }

  static allowAll() {
    return new ToolPolicy({ shell: true, fileRead: null, fileWrite: null, browser: true });
  }

  static denyAll(reason = 'Tool use is disabled for this session.') {
    return new DenyAllPolicy(reason);
  }
}

class DenyAllPolicy extends ToolPolicy {
  constructor(reason) {
    super({});
    this._reason = reason;
  }
  evaluate(_toolName, _args) {
    return { allowed: false, reason: this._reason };
  }
}

// ── RunResult ─────────────────────────────────────────────────────────────

/**
 * Returned (as the generator's return value) when runAgentLoop finishes.
 * Read via `const result = await gen.return()` or collect the final
 * `{ type: 'done' }` event — whichever is more convenient.
 */
export class RunResult {
  constructor({ status, totalTurns, totalTools, durationMs, finalStatus = null, error = null }) {
    this.status      = status;       // 'completed' | 'failed' | 'aborted' | 'max_turns'
    this.totalTurns  = totalTurns;
    this.totalTools  = totalTools;
    this.durationMs  = durationMs;
    this.finalStatus = finalStatus;  // autonomous DONE/BLOCKED/NEEDS-INPUT marker
    this.error       = error;
  }
}

// ── Primary API ───────────────────────────────────────────────────────────

/**
 * Run one agentic turn (or many, if tools are called) and yield events.
 *
 * @param {object} opts
 * @param {object}   opts.client           — OpenAI-compatible client
 * @param {string}   opts.model
 * @param {object[]} opts.messages         — mutable; runner appends turns in-place
 * @param {object[]} [opts.tools]          — OpenAI tool schemas
 * @param {Function} opts.toolHandler      — async (name, args) => string  result
 * @param {ToolPolicy} [opts.policy]       — defaults to ToolPolicy.allowAll()
 * @param {AbortSignal} [opts.signal]      — cancellation
 * @param {object}   [opts.limits]         — override LOOP_DEFAULTS keys
 * @param {Function} [opts.onTrace]        — (event) => void  for ChatTracer integration
 * @param {string}   [opts.projectId]      — for trace ledger path
 * @param {string}   [opts.agentName]
 * @param {boolean}  [opts.autonomousMode]
 * @yields {object} SSE-compatible event objects
 * @returns {RunResult}
 */
export async function* runAgentLoop(opts) {
  const {
    client,
    model,
    messages,
    tools,
    toolHandler,
    policy    = ToolPolicy.allowAll(),
    signal    = null,
    limits    = {},
    onTrace   = null,
    projectId = null,
    agentName = null,
    autonomousMode = false,
  } = opts;

  const cfg = { ...LOOP_DEFAULTS, ...limits };

  // ── Trace setup ──────────────────────────────────────────────────────
  const runId    = crypto.randomBytes(6).toString('hex');
  const ledgerFile = projectId
    ? path.join(os.homedir(), '.config', 'fauna', 'autonomous-runs', `${projectId}-${runId}.jsonl`)
    : null;
  const tracer = new ChatTracer(ledgerFile || '/dev/null');
  if (ledgerFile) tracer.start(runId, { model, projectId, agentName, autonomousMode });

  const emit = (event) => {
    if (onTrace) { try { onTrace(event); } catch (_) {} }
  };

  const startedAt    = Date.now();
  let continueLoop   = true;
  let toolCallCount  = 0;
  let continueCount  = 0;
  let turnIndex      = 0;
  let narrationRepeats = 0;
  let silentBursts   = 0;
  let prevPreamble   = '';

  try {
    while (continueLoop) {
      if (signal?.aborted) break;

      // ── Build request params ────────────────────────────────────────
      const params = {
        model,
        messages: messages.slice(),
        stream:   true,
        ...(tools?.length ? { tools, tool_choice: 'auto' } : {}),
      };

      // ── Call model ─────────────────────────────────────────────────
      if (ledgerFile) tracer.modelSend({ turnIndex, messageCount: messages.length, toolCount: tools?.length || 0 });
      emit({ type: 'model.send', turnIndex });

      let stream;
      try {
        stream = await client.chat.completions.create(params, signal ? { signal } : undefined);
      } catch (apiErr) {
        if (signal?.aborted) break;
        throw apiErr;
      }

      // ── Drain stream ───────────────────────────────────────────────
      let assistantText = '';
      let finishReason  = null;
      let streamUsage   = null;
      const pendingCalls = [];

      for await (const chunk of stream) {
        if (signal?.aborted) break;
        const delta = chunk.choices?.[0]?.delta;
        if (delta?.content) {
          assistantText += delta.content;
          yield { type: 'content', content: delta.content };
        }
        if (delta?.tool_calls) {
          for (const tc of delta.tool_calls) {
            const idx = tc.index ?? 0;
            if (!pendingCalls[idx]) pendingCalls[idx] = { id: tc.id, function: { name: '', arguments: '' } };
            if (tc.id) pendingCalls[idx].id = tc.id;
            if (tc.function?.name) pendingCalls[idx].function.name += tc.function.name;
            if (tc.function?.arguments) pendingCalls[idx].function.arguments += tc.function.arguments;
          }
        }
        finishReason = chunk.choices?.[0]?.finish_reason || finishReason;
        if (chunk.usage) streamUsage = chunk.usage;
      }

      if (ledgerFile) tracer.modelResponse({ turnIndex, finishReason, promptTokens: streamUsage?.prompt_tokens || 0, completionTokens: streamUsage?.completion_tokens || 0 });
      emit({ type: 'model.response', turnIndex, finishReason });
      turnIndex++;

      // ── Dispatch tool calls ────────────────────────────────────────
      const calls = pendingCalls.filter(tc => tc?.function?.name);
      if (finishReason === 'tool_calls' && calls.length > 0) {
        messages.push({ role: 'assistant', content: assistantText || null, tool_calls: calls });

        // Narration repetition guard
        const preamble = assistantText.trim();
        if (preamble.length >= 40 && _wordOverlap(preamble, prevPreamble) >= 0.75) {
          narrationRepeats++;
        } else {
          narrationRepeats = 0;
        }
        if (preamble.length === 0) silentBursts++; else silentBursts = 0;
        prevPreamble = preamble;

        for (const tc of calls) {
          if (signal?.aborted) break;
          const toolName = tc.function.name;
          toolCallCount++;

          let args = {};
          try { args = JSON.parse(tc.function.arguments || '{}'); } catch (_) {}

          // Policy check
          const decision = policy.evaluate(toolName, args);
          if (!decision.allowed) {
            if (ledgerFile) tracer.toolDenied({ toolName, reason: decision.reason });
            yield { type: 'tool_denied', name: toolName, reason: decision.reason };
            messages.push({ role: 'tool', tool_call_id: tc.id, content: decision.reason });
            continue;
          }

          // Execute
          const toolStart = Date.now();
          if (ledgerFile) tracer.toolStarted({ toolName, argsKeys: Object.keys(args) });
          yield { type: 'tool_call', callId: tc.id, name: toolName };

          let result = '';
          let toolOk = false;
          try {
            result = await toolHandler(toolName, args);
            toolOk = true;
          } catch (e) {
            result = `Error: ${e.message}`;
          }

          const toolDuration = Date.now() - toolStart;
          if (ledgerFile) tracer.toolCompleted({ toolName, resultSize: result.length, ok: toolOk, durationMs: toolDuration });
          yield { type: 'tool_result', callId: tc.id, name: toolName, ok: toolOk, durationMs: toolDuration };

          messages.push({ role: 'tool', tool_call_id: tc.id, content: String(result) });
        }

        // Loop guard: hard-stop on repetition spirals
        if (narrationRepeats >= cfg.narrationRepeatHardStop || silentBursts >= cfg.maxSilentBursts) {
          messages.push({ role: 'user', content: '[System: You have repeated the same explanation or tool calls without progress. Stop and give a final honest summary of what was attempted.]' });
          continueLoop = false;
        }
      } else if (finishReason === 'length' && continueCount < cfg.maxContinues) {
        // Auto-continue on truncated output
        continueCount++;
        messages.push({ role: 'assistant', content: assistantText });
        messages.push({ role: 'user', content: 'Your previous response was cut off. Continue exactly where you left off.' });
      } else {
        // Normal stop
        yield { type: 'done', finish_reason: finishReason || 'stop', usage: streamUsage || null };
        continueLoop = false;
      }
    }
  } catch (err) {
    if (ledgerFile) tracer.error({ message: err.message });
    yield { type: 'error', error: err.message };
    return new RunResult({ status: 'failed', totalTurns: turnIndex, totalTools: toolCallCount, durationMs: Date.now() - startedAt, error: err.message });
  }

  const durationMs = Date.now() - startedAt;
  if (ledgerFile) tracer.done({ totalTurns: turnIndex, totalTools: toolCallCount, durationMs });
  return new RunResult({
    status: signal?.aborted ? 'aborted' : 'completed',
    totalTurns: turnIndex,
    totalTools: toolCallCount,
    durationMs,
  });
}

// ── Helpers ───────────────────────────────────────────────────────────────

function _wordOverlap(a, b) {
  const words = (s) => new Set(s.toLowerCase().split(/\W+/).filter(w => w.length > 3));
  const wa = words(a);
  const wb = words(b);
  if (!wa.size || !wb.size) return 0;
  let inter = 0;
  for (const w of wa) if (wb.has(w)) inter++;
  return inter / Math.max(wa.size, wb.size);
}
