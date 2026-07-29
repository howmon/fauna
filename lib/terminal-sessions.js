import { spawn } from 'child_process';
import os from 'os';
import path from 'path';
import crypto from 'crypto';
import { buildShellEnv } from '../server/lib/shell-env.js';

const sessions = new Map();
// Hard cap: keep the last MAX_SESSIONS sessions.  When full, evict the oldest
// exited session first; if none have exited, evict the oldest running one.
// This prevents open zsh -i pipes from accumulating across conversations and
// keeping the libuv event loop from going idle (→ server appears to hang).
const MAX_SESSIONS = 20;

function _id() { return 'term_' + crypto.randomBytes(5).toString('hex'); }

function _evictIfFull() {
  if (sessions.size < MAX_SESSIONS) return;
  // Prefer evicting exited sessions; fall back to oldest overall.
  let victim = null;
  for (const [id, entry] of sessions) {
    if (entry.exited) { victim = id; break; }
    if (!victim) victim = id; // oldest overall as fallback
  }
  if (victim) {
    const entry = sessions.get(victim);
    try { entry.child.kill('SIGTERM'); } catch (_) {}
    sessions.delete(victim);
  }
}

function _snapshot(entry, maxChars = 8000) {
  const output = entry.output.join('');
  return {
    id: entry.id,
    cwd: entry.cwd,
    command: entry.command,
    running: !entry.exited,
    exitCode: entry.exitCode,
    startedAt: entry.startedAt,
    output: output.slice(-maxChars),
  };
}

export function startTerminalSession(opts = {}) {
  const cwd = path.resolve(opts.cwd || os.homedir());
  const shell = opts.shell || process.env.SHELL || '/bin/zsh';
  const id = _id();
  // Electron's reduced PATH often lacks /usr/local/bin and /opt/homebrew/bin,
  // so interactive commands like `npm`/`node` fail even though they're
  // installed. Seed the session with the augmented shell PATH so tools resolve
  // regardless of the user's rc files.
  const { augmentedPath } = buildShellEnv(process.platform === 'win32');
  const child = spawn(shell, ['-i'], {
    cwd,
    env: { ...process.env, PATH: augmentedPath },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const entry = { id, cwd, command: shell + ' -i', child, output: [], startedAt: Date.now(), exited: false, exitCode: null };
  const push = (chunk) => {
    entry.output.push(String(chunk));
    if (entry.output.join('').length > 200000) entry.output = [entry.output.join('').slice(-100000)];
  };
  child.stdout.on('data', push);
  child.stderr.on('data', push);
  child.on('exit', code => { entry.exited = true; entry.exitCode = code; });
  _evictIfFull();
  sessions.set(id, entry);
  if (opts.command) setTimeout(() => { try { child.stdin.write(String(opts.command) + '\n'); } catch (_) {} }, 20);
  return _snapshot(entry);
}

export function sendTerminalInput(id, input = '') {
  const entry = sessions.get(id);
  if (!entry) return { ok: false, error: 'terminal not found: ' + id };
  if (entry.exited) return { ok: false, error: 'terminal has exited: ' + id };
  entry.child.stdin.write(String(input) + '\n');
  return { ok: true, id };
}

export function getTerminalOutput(id, maxChars) {
  const entry = sessions.get(id);
  if (!entry) return { ok: false, error: 'terminal not found: ' + id };
  return { ok: true, ..._snapshot(entry, maxChars) };
}

export function listTerminalSessions() {
  return Array.from(sessions.values()).map(entry => _snapshot(entry, 1000));
}

export function killTerminalSession(id) {
  const entry = sessions.get(id);
  if (!entry) return { ok: false, error: 'terminal not found: ' + id };
  try { entry.child.kill('SIGTERM'); } catch (_) {}
  sessions.delete(id);
  return { ok: true, id };
}