// ── Work-item verifier ──────────────────────────────────────────────────
//
// Runs the verify command for a Kanban card and records the result. Used by
// both the kanban-worker (auto-verify on task completion) and the
// `fauna_workitem_verify` self-tool (AI calls it before claiming done).
//
// Resolution order for the command:
//   1. card.verifyCommand            (per-card override; preferred)
//   2. project.qa.command            (project-wide gate)
//   3. null                          → returns {ok:true, skipped:true}
//      so projects without any gate keep the old trust-based behaviour.
//
// We run with a hard wall-clock timeout (default 5 min) and clip captured
// output to 8 KB so a card with chatty test output doesn't bloat the JSON
// store. Exit-code 0 = pass.
//
// The runner uses /bin/sh -c (mac/linux) — Windows is unsupported; the
// worker still runs on macOS/Linux. cwd defaults to project.rootPath when
// present, falling back to process cwd.

import { spawn } from 'child_process';
import path from 'path';
import fs from 'node:fs';
import { getProject, setWorkItemVerification, addWorkItemComment } from '../project-manager.js';

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

// Inspect a project root for a runnable test command. Mirrors the convention
// used by addyosmani/agent-skills' "Verification" sections \u2014 if the repo
// has a test script, "npm test" (or equivalent) is the floor verifier. Only
// runs when the project hasn't set an explicit qa.command and the card has
// no verifyCommand override, so existing behaviour is preserved.
function _detectAutoVerifyCommand(rootPath) {
  if (!rootPath) return null;
  const pkgPath = path.join(rootPath, 'package.json');
  try {
    if (!fs.existsSync(pkgPath)) return null;
    const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
    const scripts = (pkg && pkg.scripts) || {};
    if (typeof scripts.test === 'string' && scripts.test.trim() && !/no test specified/i.test(scripts.test)) {
      return 'npm test --silent';
    }
  } catch (_) { /* ignore */ }
  // Python: pytest if tests/ exists.
  try {
    if (fs.existsSync(path.join(rootPath, 'tests')) && fs.existsSync(path.join(rootPath, 'pyproject.toml'))) {
      return 'pytest -q';
    }
  } catch (_) {}
  return null;
}

export function resolveVerifyCommand(project, card) {
  if (!card) return null;
  if (card.verifyCommand && String(card.verifyCommand).trim()) {
    return { command: String(card.verifyCommand).trim(), source: 'card' };
  }
  const qa = project && project.qa && project.qa.command;
  if (qa && String(qa).trim()) {
    return { command: String(qa).trim(), source: 'project' };
  }
  // Auto-detect floor verifier from package.json / pyproject.toml.
  const auto = _detectAutoVerifyCommand(project && project.rootPath);
  if (auto) return { command: auto, source: 'auto' };
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
  add(DEFAULT_PATH_PARTS.join(path.delimiter));
  env.PATH = parts.join(path.delimiter);
  return env;
}

function _isCommandNotFound(exitCode, output) {
  return exitCode === 127 || /command not found|not found/i.test(String(output || ''));
}

/** Run the verify command; never throws. */
export function runVerifyCommand(command, { cwd, timeoutMs } = {}) {
  return new Promise((resolve) => {
    const to = Math.max(5_000, Number(timeoutMs) || DEFAULT_TIMEOUT_MS);
    const child = spawn('/bin/sh', ['-c', command], {
      cwd: cwd && cwd.trim() ? cwd : process.cwd(),
      env: _buildVerifyEnv(),
    });
    const out = [];
    const err = [];
    let totalBytes = 0;
    let killed = false;
    const onData = (sink) => (chunk) => {
      // Don't accumulate beyond the cap — we only keep the head.
      if (totalBytes < MAX_OUTPUT_BYTES) {
        sink.push(chunk);
        totalBytes += chunk.length;
      }
    };
    child.stdout.on('data', onData(out));
    child.stderr.on('data', onData(err));
    const timer = setTimeout(() => {
      killed = true;
      try { child.kill('SIGKILL'); } catch (_) {}
    }, to);
    child.on('error', (e) => {
      clearTimeout(timer);
      resolve({ ok: false, exitCode: null, output: 'spawn error: ' + e.message, killed });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      const stdoutStr = _clip(Buffer.concat(out));
      const stderrStr = _clip(Buffer.concat(err));
      const combined = [
        stdoutStr ? '── stdout ──\n' + stdoutStr : '',
        stderrStr ? '── stderr ──\n' + stderrStr : '',
        killed     ? '── killed by timeout after ' + to + 'ms ──' : '',
      ].filter(Boolean).join('\n').slice(0, MAX_OUTPUT_BYTES);
      resolve({
        ok: !killed && code === 0,
        exitCode: killed ? null : code,
        output: combined || '(no output)',
        killed,
        infrastructureFailure: !killed && _isCommandNotFound(code, combined),
      });
    });
  });
}

/**
 * High-level: look up the card + project, resolve a command, run it,
 * persist the result, and (optionally) post a comment.
 *
 * @param projectId
 * @param itemId
 * @param opts { runId?:string, postComment?:bool, timeoutMs?:number }
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

  const resolved = resolveVerifyCommand(project, card);
  if (!resolved) {
    // No gate configured — record an explicit "skipped" so the user can
    // see the card wasn't verified, and return ok so callers don't bail.
    setWorkItemVerification(projectId, itemId, {
      ok: true, exitCode: 0, output: '(no verify command configured)',
      runId: opts.runId || null, command: '', source: 'shell',
    });
    return { ok: true, skipped: true, command: null };
  }

  const cwd = project.rootPath || process.cwd();
  const r = await runVerifyCommand(resolved.command, {
    cwd, timeoutMs: opts.timeoutMs,
  });

  setWorkItemVerification(projectId, itemId, {
    ok: r.ok,
    exitCode: r.exitCode,
    output: r.output,
    runId: opts.runId || null,
    command: resolved.command,
    source: 'shell',
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
  };
}

export const __test = { runVerifyCommand, resolveVerifyCommand, buildVerifyEnv: _buildVerifyEnv, isCommandNotFound: _isCommandNotFound };
