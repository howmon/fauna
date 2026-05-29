// server/lib/dev-server-registry.js
//
// Global registry of long-running dev/preview servers spawned by Fauna shell
// commands (npm run dev, vite, next dev, node server.js, php -S, …). Lets the
// UI list / stop / restart them so the user doesn't end up with a dozen
// orphaned ports squatting on localhost.
//
// Lifecycle:
//   • shell-runner / shell-exec route calls `maybeRegister(child, info)` for
//     every spawned child. The helper inspects the command and silently
//     returns if it isn't a recognised dev-server invocation.
//   • Otherwise an entry is created with status='starting'. The child's
//     stdout/stderr is tee'd through a port-sniffer (localhost:PORT,
//     http://…:PORT, "Local:", "Listening on", "running at"). First hit
//     flips status to 'running' and stores the port.
//   • On child exit the entry is marked 'exited' and pruned after a short
//     grace period (so the UI can flash the final status).
//
// Detached from any specific Express app — server.js wires the routes.

import { spawn } from 'child_process';
import os from 'os';

const _entries = new Map(); // id -> entry
let _seq = 0;
const _listeners = new Set();

const DEV_CMD_PATTERNS = [
  /\bnpm\s+(?:run\s+)?(?:dev|start|serve|preview|watch)\b/i,
  /\bpnpm\s+(?:run\s+)?(?:dev|start|serve|preview|watch)\b/i,
  /\byarn\s+(?:run\s+)?(?:dev|start|serve|preview|watch)\b/i,
  /\bbun\s+(?:run\s+)?(?:dev|start|serve)\b/i,
  /\bnpx\s+(?:vite|next|astro|remix|nuxt|expo|webpack-dev-server|http-server|serve)\b/i,
  /\bvite\b(?!\s+build)/i,
  /\bnext\s+(?:dev|start)\b/i,
  /\bnuxt\s+(?:dev|start)\b/i,
  /\bremix\s+dev\b/i,
  /\bastro\s+dev\b/i,
  /\bexpo\s+start\b/i,
  /\bnodemon\b/i,
  /\btsx\s+watch\b/i,
  /\btsx\s+.*\bserver\b/i,
  /\bts-node\s+.*\bserver\b/i,
  /\bnode\s+.*\b(?:server|index|app)\.(?:m?[jt]s)\b/i,
  /\bnode\s+--watch\b/i,
  /\bdeno\s+(?:run|task)\b/i,
  /\bphp\s+-S\s+/i,
  /\bpython\s+-m\s+http\.server\b/i,
  /\bpython\s+-m\s+SimpleHTTPServer\b/i,
  /\bpython\s+-m\s+flask\b/i,
  /\bflask\s+run\b/i,
  /\buvicorn\b/i,
  /\bgunicorn\b/i,
  /\bhypercorn\b/i,
  /\bdjango-admin\s+runserver\b/i,
  /\b(?:python|python3)\s+manage\.py\s+runserver\b/i,
  /\brails\s+(?:s|server)\b/i,
  /\bbundle\s+exec\s+rails\b/i,
  /\bhono\s+dev\b/i,
  /\bwrangler\s+dev\b/i,
  /\bfirebase\s+serve\b/i,
  /\bsupabase\s+start\b/i,
  /\bdocker\s+compose\s+up\b/i,
  /\bdocker-compose\s+up\b/i,
];

export function isDevServerCommand(command) {
  if (!command || typeof command !== 'string') return false;
  const trimmed = command.trim();
  if (!trimmed) return false;
  return DEV_CMD_PATTERNS.some((re) => re.test(trimmed));
}

// Try to extract a port from a chunk of stdout/stderr text.
const PORT_PATTERNS = [
  /https?:\/\/(?:localhost|127\.0\.0\.1|\[::1?\]|0\.0\.0\.0):(\d{2,5})\b/i,
  /\blocalhost:(\d{2,5})\b/i,
  /\blocal:\s+https?:\/\/[^\s]*?:(\d{2,5})\b/i,
  /\blistening (?:on|at)[^\d]*?(\d{2,5})\b/i,
  /\brunning (?:on|at)[^\d]*?(\d{2,5})\b/i,
  /\bport\s+(\d{2,5})\b/i,
];

function sniffPort(text) {
  if (!text) return null;
  for (const re of PORT_PATTERNS) {
    const m = text.match(re);
    if (m) {
      const p = parseInt(m[1], 10);
      if (p > 0 && p < 65536) return p;
    }
  }
  return null;
}

function _emit() {
  for (const fn of _listeners) {
    try { fn(list()); } catch (_) {}
  }
}

function _shortLabel(cmd) {
  const s = String(cmd || '').trim();
  if (!s) return '';
  // Strip leading `cd … && ` clutter — keep the actual command.
  const cleaned = s.replace(/^cd\s+[^&;]+(?:&&|;)\s*/i, '');
  return cleaned.length > 80 ? cleaned.slice(0, 77) + '…' : cleaned;
}

function _shortCwd(cwd) {
  if (!cwd) return '';
  const home = os.homedir();
  return cwd.startsWith(home) ? '~' + cwd.slice(home.length) : cwd;
}

export function list() {
  return Array.from(_entries.values()).map((e) => ({
    id: e.id,
    pid: e.pid,
    command: e.command,
    label: e.label,
    cwd: e.cwd,
    cwdShort: _shortCwd(e.cwd),
    port: e.port,
    status: e.status,
    startedAt: e.startedAt,
    exitedAt: e.exitedAt || null,
    exitCode: e.exitCode == null ? null : e.exitCode,
  }));
}

export function get(id) {
  return _entries.get(String(id)) || null;
}

export function subscribe(fn) {
  if (typeof fn !== 'function') return () => {};
  _listeners.add(fn);
  return () => _listeners.delete(fn);
}

// Register an already-spawned child. Returns the entry id, or null if the
// command isn't recognised as a dev server. Safe to call on every spawn.
export function maybeRegister(child, { command, cwd, killId } = {}) {
  if (!child || !command) return null;
  if (!isDevServerCommand(command)) return null;
  return _registerChild(child, { command, cwd, killId });
}

function _registerChild(child, { command, cwd, killId } = {}) {
  const id = 'dev_' + Date.now().toString(36) + '_' + (++_seq).toString(36);
  const entry = {
    id,
    pid: child.pid || null,
    command,
    label: _shortLabel(command),
    cwd: cwd || null,
    killId: killId || null,
    port: null,
    status: 'starting',
    startedAt: Date.now(),
    exitedAt: null,
    exitCode: null,
    child,
    // Keep last few lines of stdout/stderr so the UI can show a hint.
    tail: [],
  };
  _entries.set(id, entry);

  const captureChunk = (text) => {
    if (!text) return;
    // Maintain a small ring buffer of recent lines for diagnostics.
    const lines = String(text).split(/\r?\n/).filter(Boolean);
    if (lines.length) {
      entry.tail.push(...lines);
      if (entry.tail.length > 20) entry.tail.splice(0, entry.tail.length - 20);
    }
    if (!entry.port) {
      const p = sniffPort(text);
      if (p) {
        entry.port = p;
        entry.status = 'running';
        _emit();
      }
    }
  };

  if (child.stdout && typeof child.stdout.on === 'function') {
    child.stdout.on('data', (chunk) => captureChunk(String(chunk)));
  }
  if (child.stderr && typeof child.stderr.on === 'function') {
    child.stderr.on('data', (chunk) => captureChunk(String(chunk)));
  }

  const onDone = (code, signal) => {
    if (!_entries.has(id)) return;
    entry.status = signal === 'SIGTERM' || signal === 'SIGKILL' ? 'stopped' : 'exited';
    entry.exitCode = code == null ? null : code;
    entry.exitedAt = Date.now();
    entry.child = null;
    _emit();
    // Prune after a short grace period so UI sees the final status.
    setTimeout(() => {
      _entries.delete(id);
      _emit();
    }, 8000);
  };
  child.once('exit', onDone);
  child.once('close', onDone);

  _emit();
  return id;
}

export function kill(id) {
  const entry = _entries.get(String(id));
  if (!entry) return { ok: false, error: 'not found' };
  if (!entry.child) return { ok: false, error: 'process already exited' };
  try {
    entry.child.kill('SIGTERM');
    // Hard-kill after 3s if still alive.
    setTimeout(() => {
      if (entry.child) {
        try { entry.child.kill('SIGKILL'); } catch (_) {}
      }
    }, 3000);
    entry.status = 'stopping';
    _emit();
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

// Restart by killing the current child and re-spawning the same command in
// the same cwd. Requires shellBin/augmentedPath to be plumbed in from the
// caller (server.js) because dev-server-registry has no view of those.
export function restart(id, { shellBin, isWin, augmentedPath } = {}) {
  const entry = _entries.get(String(id));
  if (!entry) return { ok: false, error: 'not found' };
  if (!shellBin) return { ok: false, error: 'shell not configured' };

  const command = entry.command;
  const cwd = entry.cwd || os.homedir();

  // Stop existing child if it's still alive.
  if (entry.child) {
    try { entry.child.kill('SIGTERM'); } catch (_) {}
  }

  const env = {
    ...process.env,
    ...(augmentedPath ? { PATH: augmentedPath } : {}),
    HOME: os.homedir(),
    USER: os.userInfo().username,
    ...(isWin ? {} : { SHELL: '/bin/zsh', TERM: 'xterm-256color' }),
  };
  const newChild = spawn(
    shellBin,
    isWin ? ['-Command', command] : ['-c', command],
    { cwd, env, stdio: ['pipe', 'pipe', 'pipe'] },
  );

  // Drop the old entry (don't wait for the grace timeout — the restart UX
  // should feel atomic) and register the fresh child.
  _entries.delete(String(id));
  const newId = _registerChild(newChild, { command, cwd });
  return { ok: true, id: newId };
}

// Stop & forget every tracked entry. Called when the Electron main process
// is shutting down so dev servers don't outlive Fauna.
export function killAll() {
  for (const entry of _entries.values()) {
    if (entry.child) {
      try { entry.child.kill('SIGTERM'); } catch (_) {}
    }
  }
}
