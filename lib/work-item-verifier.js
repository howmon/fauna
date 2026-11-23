// ── Work-item verifier ──────────────────────────────────────────────────
//
// Runs the verify command for a Kanban card and records the result. Used by
// both the kanban-worker (auto-verify on task completion) and the
// `fauna_workitem_verify` self-tool (AI calls it before claiming done).
//
// Resolution order for the command:
//   1. card.verifyCommand            (per-card override; preferred)
//   2. project.qa.command            (project-wide gate)
//   3. detected existing project tests
//   4. null                          → returns {ok:false, skipped:true}
//      so autonomous completion cannot mistake missing evidence for a pass.
//
// We run with a hard wall-clock timeout (default 5 min) and clip captured
// output to 8 KB so a card with chatty test output doesn't bloat the JSON
// store. Exit-code 0 = pass.
//
// The runner uses /bin/sh -c (mac/linux) — Windows is unsupported; the
// worker still runs on macOS/Linux. Detected/card checks use the changed
// package; explicit project QA runs at project.rootPath.

import path from 'path';
import os from 'node:os';
import { getProject, setWorkItemVerification, addWorkItemComment } from '../project-manager.js';
import { detectAutoVerifyCommand, resolveVerificationRoot } from './verification-command.js';
import { runShell } from '../server/lib/shell-runner.js';

const DEFAULT_TIMEOUT_MS = 5 * 60_000;
const MAX_OUTPUT_BYTES   = 8_000;
const DEFAULT_PATH_PARTS = [
  '/opt/homebrew/bin',
  '/opt/homebrew/sbin',
  '/usr/local/bin',
  '/usr/local/sbin',
  '/usr/bin',
  '/bin',
  '/usr/sbin',
  '/sbin',
];

export function resolveVerifyCommand(project, card, opts = {}) {
  if (!card) return null;
  const root = project?.rootPath || process.cwd();
  const files = opts.files?.length ? opts.files
    : card.verified?.cwd ? [card.verified.cwd] : card.fileScope || [];
  const scopedRoot = resolveVerificationRoot(root, files);
  const scope = scopedRoot !== path.resolve(root) ? { cwd: scopedRoot } : {};
  if (card.verifyCommand && String(card.verifyCommand).trim()) {
    return { command: String(card.verifyCommand).trim(), source: 'card', ...scope };
  }
  const qa = project && project.qa && project.qa.command;
  if (qa && String(qa).trim()) {
    return { command: String(qa).trim(), source: 'project' };
  }
  // Auto-detect floor verifier from package.json / pyproject.toml.
  const auto = detectAutoVerifyCommand(project?.rootPath ? scopedRoot : null);
  if (auto) return { command: auto, source: 'auto', ...scope };
  return null;
}

function _clip(buf) {
  if (!buf) return '';
  let s = buf.toString('utf8');
  if (s.length > MAX_OUTPUT_BYTES) s = s.slice(0, MAX_OUTPUT_BYTES) + '\n…(truncated)';
  return s;
}

function _buildVerifyEnv(baseEnv = process.env) {
  const env = { ...(baseEnv || {}) };
  const parts = [];
  const add = (value) => {
    if (!value) return;
    for (const part of String(value).split(path.delimiter)) {
      if (part && !parts.includes(part)) parts.push(part);
    }
  };
  add(path.dirname(process.execPath || ''));
  add(env.PATH || env.Path || env.path || '');
  add(path.join(os.homedir(), '.bun', 'bin'));
  add(DEFAULT_PATH_PARTS.join(path.delimiter));
  env.PATH = parts.join(path.delimiter);
  return env;
}

function _isCommandNotFound(exitCode, output) {
  return exitCode === 127 || /command not found|not found/i.test(String(output || ''));
}

/** Run the verify command; never throws. */
export async function runVerifyCommand(command, { cwd, timeoutMs, context } = {}) {
  const to = Math.max(5_000, Number(timeoutMs) || DEFAULT_TIMEOUT_MS);
  const result = await runShell({
    command,
    shellBin: '/bin/sh',
    isWin: false,
    cwd: cwd && cwd.trim() ? cwd : process.cwd(),
    env: { ..._buildVerifyEnv(), CI: '1' },
    timeoutMs: to,
    maxOutputChars: MAX_OUTPUT_BYTES,
    context: { ...context, source: 'kanban' },
  });
  const stdoutStr = _clip(Buffer.from(result.stdout));
  const stderrStr = _clip(Buffer.from(result.stderr));
  const combined = [
    stdoutStr ? '── stdout ──\n' + stdoutStr : '',
    stderrStr ? '── stderr ──\n' + stderrStr : '',
    result.timedOut ? '── killed by timeout after ' + to + 'ms ──' : '',
  ].filter(Boolean).join('\n').slice(0, MAX_OUTPUT_BYTES);
  return {
    ok: result.ok,
    exitCode: result.timedOut || result.exitCode === -1 ? null : result.exitCode,
    output: combined || '(no output)',
    killed: result.killed || result.timedOut,
    timedOut: result.timedOut,
    infrastructureFailure: !result.timedOut && _isCommandNotFound(result.exitCode, combined),
  };
}

/**
 * High-level: look up the card + project, resolve a command, run it,
 * persist the result, and (optionally) post a comment.
 *
 * @param projectId
 * @param itemId
 * @param opts { runId?:string, postComment?:bool, timeoutMs?:number, files?:Array, runShell?:Function }
 * @returns { ok, skipped?:bool, exitCode?, output?, command?, error? }
 */
export async function verifyWorkItem(projectId, itemId, opts = {}) {
  const project = getProject(projectId);
  if (!project) return { ok: false, error: 'project not found' };
  // Read the card via the project record (avoid pulling getProjectBoard
  // which migrates the whole array).
  const card = Array.isArray(project.backlog)
    ? project.backlog.find(x => x.id === itemId) : null;
  if (!card) return { ok: false, error: 'item not found' };

  const resolved = resolveVerifyCommand(project, card, opts);
  if (!resolved) {
    // No gate configured is an explicit unverified result, never a pass.
    setWorkItemVerification(projectId, itemId, {
      ok: false, exitCode: null, output: '(no verify command configured)',
      runId: opts.runId || null, command: '', source: 'shell',
    });
    return { ok: false, skipped: true, command: null, output: '(no verify command configured)' };
  }

  const cwd = resolved.cwd || project.rootPath || process.cwd();
  if (opts.runId && card.verified?.runId === opts.runId && card.verified.ok
    && card.verified.exitCode === 0 && card.verified.command === resolved.command && card.verified.cwd === cwd) {
    return {
      ok: true, exitCode: 0, reused: true, source: resolved.source,
      command: resolved.command, cwd, output: card.verified.output,
    };
  }
  if (opts.runId && card.verified?.runId === opts.runId && card.verified.timedOut
    && card.verified.command === resolved.command && card.verified.cwd === cwd) {
    return {
      ok: false, timedOut: true, code: 'VALIDATION_TIMEOUT_RETRY_BLOCKED',
      command: resolved.command, cwd,
      output: 'This verifier already timed out in this run. Change the code or narrow the verifier before retrying.',
    };
  }
  let r;
  if (opts.runShell) {
    const result = JSON.parse(await opts.runShell({
      command: resolved.command, cwd, timeoutMs: opts.timeoutMs || DEFAULT_TIMEOUT_MS,
      reason: 'task completion verification', structured: true,
    }));
    r = {
      ...result,
      output: [result.stdout, result.stderr, result.error].filter(Boolean).join('\n').slice(0, MAX_OUTPUT_BYTES) || '(no output)',
    };
  } else {
    r = await runVerifyCommand(resolved.command, { cwd, timeoutMs: opts.timeoutMs,
      context: { projectId, runId: opts.runId } });
  }

  setWorkItemVerification(projectId, itemId, {
    ok: r.ok,
    exitCode: r.exitCode,
    output: r.output,
    runId: opts.runId || null,
    command: resolved.command,
    source: 'shell',
    cwd,
    timedOut: r.timedOut === true,
  });

  if (opts.postComment !== false) {
    const head = r.ok ? '✅ Verification passed' : '❌ Verification failed';
    const exit = r.exitCode === null ? '(no exit code)' : 'exit ' + r.exitCode;
    const cmd  = '`' + resolved.command + '`';
    const tail = r.output.length > 1200 ? r.output.slice(0, 1200) + '\n…(truncated)' : r.output;
    addWorkItemComment(projectId, itemId, {
      author: 'ai',
      body: head + ' ' + exit + ' — ' + cmd + '\n\n```\n' + tail + '\n```',
    });
  }

  return {
    ok: r.ok,
    skipped: false,
    exitCode: r.exitCode,
    output: r.output,
    infrastructureFailure: r.infrastructureFailure === true,
    command: resolved.command,
    source: resolved.source,
    cwd,
    timedOut: r.timedOut === true,
  };
}

export const __test = { runVerifyCommand, resolveVerifyCommand, buildVerifyEnv: _buildVerifyEnv, isCommandNotFound: _isCommandNotFound };
