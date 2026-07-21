// server/lib/shell-runner.js
//
// Shared shell-command executor used by both the legacy /api/shell-exec route
// (markdown ```bash blocks) and the native fauna_shell_exec function tool.
// Streams stdout/stderr through an optional `onChunk` callback so callers can
// forward live output to SSE. Returns a promise that resolves with the final
// {ok, exitCode, stdout, stderr, killed} record.

import os from 'os';
import { spawn } from 'child_process';
import { isCommandSafe } from '../../permission-guard.js';

const DEFAULT_TIMEOUT_MS = 180000;
const SEARCH_TIMEOUT_MS = 30000;
const DEFAULT_MAX_OUTPUT_CHARS = 200000; // hard cap per stream

export function isUnboundedRecursiveSearch(command) {
  return /(?:^|[;&|]\s*)(?:grep\s+(?:-[^\s]*[rR][^\s]*\s+|--recursive\b)|find\s+\S+)/i.test(String(command || ''));
}

export function effectiveShellTimeout(command, requestedTimeoutMs) {
  const requested = Number.isFinite(requestedTimeoutMs) && requestedTimeoutMs > 0
    ? requestedTimeoutMs
    : DEFAULT_TIMEOUT_MS;
  return isUnboundedRecursiveSearch(command) ? Math.min(requested, SEARCH_TIMEOUT_MS) : requested;
}

export function runShell({
  command,
  cwd,
  shellBin,
  isWin,
  augmentedPath,
  env: extraEnv = {},
  timeoutMs = DEFAULT_TIMEOUT_MS,
  maxOutputChars = DEFAULT_MAX_OUTPUT_CHARS,
  onChunk = null,        // (kind: 'stdout'|'stderr', text: string) => void
  registerChild = null,  // (child) => void  — caller uses this to support kill/abort
  signal = null,         // AbortSignal — kills the child if aborted mid-run
} = {}) {
  if (!command) return Promise.reject(new Error('command required'));

  timeoutMs = effectiveShellTimeout(command, timeoutMs);

  const workDir = cwd || os.homedir();
  const env = {
    ...process.env,
    ...(augmentedPath ? { PATH: augmentedPath } : {}),
    HOME: os.homedir(),
    USER: os.userInfo().username,
    ...(isWin ? {} : { SHELL: '/bin/zsh', TERM: 'xterm-256color' }),
    ...extraEnv,
  };

  return new Promise((resolve) => {
    let stdout = '';
    let stderr = '';
    let stdoutTruncated = false;
    let stderrTruncated = false;
    let killed = false;
    let timedOut = false;

    const child = spawn(
      shellBin,
      isWin ? ['-Command', command] : ['-c', command],
      { cwd: workDir, env, stdio: ['pipe', 'pipe', 'pipe'] },
    );

    if (registerChild) {
      try { registerChild(child); } catch (_) {}
    }

    const onAbort = () => {
      killed = true;
      try { child.kill('SIGTERM'); } catch (_) {}
    };
    if (signal) {
      if (signal.aborted) onAbort();
      else signal.addEventListener('abort', onAbort, { once: true });
    }

    const timer = setTimeout(() => {
      timedOut = true;
      try { child.kill('SIGTERM'); } catch (_) {}
    }, timeoutMs);

    if (child.stdout) {
      child.stdout.setEncoding('utf8');
      child.stdout.on('data', (chunk) => {
        const text = String(chunk);
        if (stdout.length < maxOutputChars) {
          const room = maxOutputChars - stdout.length;
          stdout += text.length <= room ? text : text.slice(0, room);
          if (text.length > room) stdoutTruncated = true;
        } else {
          stdoutTruncated = true;
        }
        if (onChunk) {
          try { onChunk('stdout', text); } catch (_) {}
        }
      });
    }
    if (child.stderr) {
      child.stderr.setEncoding('utf8');
      child.stderr.on('data', (chunk) => {
        const text = String(chunk);
        if (stderr.length < maxOutputChars) {
          const room = maxOutputChars - stderr.length;
          stderr += text.length <= room ? text : text.slice(0, room);
          if (text.length > room) stderrTruncated = true;
        } else {
          stderrTruncated = true;
        }
        if (onChunk) {
          try { onChunk('stderr', text); } catch (_) {}
        }
      });
    }

    child.on('error', (err) => {
      clearTimeout(timer);
      if (signal) signal.removeEventListener?.('abort', onAbort);
      resolve({
        ok: false,
        exitCode: -1,
        stdout,
        stderr: stderr + (stderr ? '\n' : '') + 'spawn error: ' + err.message,
        command,
        cwd: workDir,
        killed,
        timedOut,
        stdoutTruncated,
        stderrTruncated,
      });
    });

    child.on('exit', (code, sig) => {
      clearTimeout(timer);
      if (signal) signal.removeEventListener?.('abort', onAbort);
      const exitCode = code != null ? code : (sig ? 130 : 0);
      resolve({
        ok: exitCode === 0 && !timedOut && !killed,
        exitCode,
        stdout,
        stderr,
        command,
        cwd: workDir,
        killed,
        timedOut,
        stdoutTruncated,
        stderrTruncated,
        signal: sig || null,
      });
    });
  });
}

// Convenience: format the runShell result as a compact string the LLM can
// consume from a role:tool message. Keeps the JSON parse-able for clients
// that want structured data, but trims to a reasonable length.
export function formatShellResultForLLM(result, { maxChars = 16000 } = {}) {
  const head =
    `exit=${result.exitCode}` +
    (result.killed ? ' killed' : '') +
    (result.timedOut ? ' timed_out' : '') +
    (result.stdoutTruncated ? ' stdout_truncated' : '') +
    (result.stderrTruncated ? ' stderr_truncated' : '');
  const parts = [head];
  if (result.stdout) parts.push('--- stdout ---\n' + result.stdout);
  if (result.stderr) parts.push('--- stderr ---\n' + result.stderr);
  let out = parts.join('\n');
  if (out.length > maxChars) {
    out = out.slice(0, maxChars) + `\n…[truncated — ${out.length - maxChars} chars omitted]`;
  }
  return out;
}

export { isCommandSafe };
