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
import { testRunRegistry } from './test-run-registry.js';

const DEFAULT_TIMEOUT_MS = 180000;
const SEARCH_TIMEOUT_MS = 30000;
const DEFAULT_MAX_OUTPUT_CHARS = 200000; // hard cap per stream
const shellTerminators = new WeakMap();

export function stopShellProcess(child) {
  const terminate = shellTerminators.get(child);
  if (terminate) return terminate();
  try { child.kill('SIGTERM'); }
  catch (error) { console.warn('[shell] unable to stop process:', error.message); }
}

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
  context = {},
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
    let stopping = false;
    let settled = false;
    let exitCode = null;
    let exitSignal = null;
    let monitorId = null;

    const child = spawn(
      shellBin,
      isWin ? ['-Command', command] : ['-c', command],
      { cwd: workDir, env, detached: !isWin, stdio: ['pipe', 'pipe', 'pipe'] },
    );

    const signalTree = (signalName) => {
      if (!child.pid) return;
      if (isWin) {
        const killer = spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
        killer.on('error', error => console.warn('[shell] unable to stop process tree:', error.message));
        killer.on('exit', code => {
          if (code) console.warn('[shell] taskkill failed for PID', child.pid, 'with exit', code);
        });
      } else {
        try { process.kill(-child.pid, signalName); }
        catch (error) {
          if (error.code !== 'ESRCH') console.warn('[shell] unable to stop process group:', error.message);
        }
      }
    };
    const terminate = () => {
      if (!timedOut) killed = true;
      if (stopping) return;
      stopping = true;
      testRunRegistry.stopping(monitorId);
      signalTree('SIGTERM');
      // Keep this escalation even if the shell exits: grandchildren may
      // ignore SIGTERM or have redirected their output pipes.
      setTimeout(() => {
        signalTree('SIGKILL');
        child.stdin?.destroy();
        child.stdout?.destroy();
        child.stderr?.destroy();
        finish(exitCode ?? 130, exitSignal || 'SIGKILL');
      }, 1000);
    };
    shellTerminators.set(child, terminate);
    monitorId = testRunRegistry.start({ command, cwd: workDir, pid: child.pid, context, stop: terminate });

    if (registerChild) {
      try { registerChild(child); } catch (_) {}
    }

    const onAbort = () => {
      terminate();
    };
    if (signal) {
      if (signal.aborted) onAbort();
      else signal.addEventListener('abort', onAbort, { once: true });
    }

    const timer = setTimeout(() => {
      timedOut = true;
      terminate();
    }, timeoutMs);

    if (child.stdout) {
      child.stdout.setEncoding('utf8');
      child.stdout.on('data', (chunk) => {
        const text = String(chunk);
        testRunRegistry.append(monitorId, text);
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
        testRunRegistry.append(monitorId, text);
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
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (signal) signal.removeEventListener?.('abort', onAbort);
      testRunRegistry.append(monitorId, 'spawn error: ' + err.message);
      testRunRegistry.finish(monitorId, { ok: false, exitCode: -1, killed, timedOut });
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

    const finish = (code, sig) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (signal) signal.removeEventListener?.('abort', onAbort);
      const resultExitCode = code != null ? code : (sig ? 130 : 0);
      testRunRegistry.finish(monitorId, {
        ok: resultExitCode === 0 && !timedOut && !killed,
        exitCode: resultExitCode, killed, timedOut,
      });
      resolve({
        ok: resultExitCode === 0 && !timedOut && !killed,
        exitCode: resultExitCode,
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
    };
    child.on('exit', (code, sig) => {
      exitCode = code;
      exitSignal = sig;
      if (!isWin && !stopping && child.pid) {
        try {
          process.kill(-child.pid, 0);
          const warning = '\nShell exited with child processes still running; Fauna is stopping the remaining process tree. Use managed dev servers for persistent services.\n';
          stderr += warning;
          testRunRegistry.append(monitorId, warning);
          terminate();
        } catch (error) {
          if (error.code !== 'ESRCH') {
            console.warn('[shell] unable to check remaining process group:', error.message);
            terminate();
          }
        }
      }
    });
    child.on('close', (code, sig) => {
      shellTerminators.delete(child);
      finish(code, sig);
    });
  });
}

// ── NPM registry-block detection ────────────────────────────────────────
// When a command is npm/pnpm/yarn and the output shows a registry connection
// failure (corporate network block, Defender for Endpoint, firewall), append
// a concise hint so the LLM can surface it to the user instead of just
// reporting a mysterious ECONNREFUSED.

const _NPM_CMD_RE = /\b(npm|pnpm|yarn|bun)\b/;
const _REGISTRY_BLOCK_RE =
  /ECONNREFUSED|ETIMEDOUT|ERR_NETWORK|unable to connect|getaddrinfo ENOTFOUND|tunneling socket|ERR_BLOCKED|registry\.npmjs\.org|registry\.yarnpkg\.com|registry\.npmmirror\.com/i;
const _NPM_PROXY_HINT =
  '\n\n[Fauna hint] Direct NPM registry access may be blocked by a network policy.' +
  '\nConfigure your npm registry to use your organisation\'s package feed:' +
  '\n  npm config set registry <YOUR_FEED_URL>' +
  '\nor set it in ~/.config/fauna/config.json: { "npmRegistry": "<YOUR_FEED_URL>" }' +
  '\n(e.g. https://packagefeedproxy.microsoft.io/npm/ for Microsoft-managed devices)';

export function annotateRegistryBlock(result, command) {
  if (!_NPM_CMD_RE.test(command || '')) return result;
  const combined = (result.stdout || '') + (result.stderr || '');
  if (!result.ok && _REGISTRY_BLOCK_RE.test(combined)) {
    return { ...result, stderr: (result.stderr || '') + _NPM_PROXY_HINT, _registryBlock: true };
  }
  return result;
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
