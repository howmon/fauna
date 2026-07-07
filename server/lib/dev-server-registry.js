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

// One-shot / read-only utilities that are NEVER long-running dev servers, even
// when their arguments happen to mention "dev", "serve", "vite", etc. (e.g.
// `grep "npm run dev"`, `curl http://localhost:5173`, `find . -name server.ts`).
// Matching the whole command string against the dev patterns used to flag all
// of these as dev servers and detach them, so the tool returned immediately
// with no output. Guarding on the leading command token fixes that.
const ONE_SHOT_COMMANDS = new Set([
  'grep', 'egrep', 'fgrep', 'rg', 'ag', 'ack', 'ripgrep',
  'find', 'fd', 'fdfind', 'locate', 'which', 'whereis', 'type',
  'ls', 'll', 'la', 'tree', 'stat', 'file', 'du', 'df', 'wc',
  'cat', 'bat', 'head', 'tail', 'less', 'more', 'nl', 'tac',
  'echo', 'printf', 'print', 'date', 'whoami', 'hostname', 'uname', 'pwd',
  'curl', 'wget', 'http', 'https', 'ping', 'dig', 'nslookup', 'host',
  'cp', 'mv', 'rm', 'mkdir', 'rmdir', 'touch', 'ln', 'chmod', 'chown',
  'git', 'gh', 'diff', 'patch', 'sort', 'uniq', 'cut', 'tr', 'sed', 'awk',
  'jq', 'yq', 'xargs', 'tee', 'test', 'true', 'false', 'sleep', 'kill',
  'pkill', 'killall', 'ps', 'lsof', 'env', 'export', 'source', 'open',
  'tar', 'zip', 'unzip', 'gzip', 'gunzip', 'cksum', 'md5', 'md5sum',
  'shasum', 'sha256sum', 'basename', 'dirname', 'realpath', 'readlink',
]);

// A build / test / lint / typecheck / install invocation is one-shot even when
// it runs through a dev-tool binary — `vite build`, `next build`,
// `npx vite build`, `tsc`, `npm run build`, `npm test`, `npm ci`, `eslint …`.
const ONE_SHOT_SUBCOMMAND_RE = /\b(?:build|test|tsc|typecheck|type-check|lint|eslint|prettier|format|check|install|ci|prune|audit|version|--version|-v|--help)\b/i;
const DEV_KEYWORD_RE = /\b(?:dev|serve|preview|watch|start|runserver|http\.server)\b/i;

export function isDevServerCommand(command) {
  if (!command || typeof command !== 'string') return false;
  const trimmed = command.trim();
  if (!trimmed) return false;

  // Never inspect quoted argument text — a search pattern like
  // `grep "npm run dev" .` must not be read as launching a dev server.
  const unquoted = trimmed
    .replace(/"(?:[^"\\]|\\.)*"/g, '""')
    .replace(/'[^']*'/g, "''");

  // Test each pipeline/chain segment on its own so a one-shot reader spliced
  // into the mix (`… | grep foo`, `curl … | head`, `pkill vite; npm run dev`)
  // is judged by the actual command it invokes, not its neighbours.
  const segments = unquoted
    .split(/\s*(?:\|\||&&|;|\||&)\s*/)
    .map((s) => s.trim())
    .filter(Boolean);

  return segments.some((seg) => _segmentIsDevServer(seg));
}

function _segmentIsDevServer(seg) {
  // Strip leading boilerplate the model chains ahead of the real command:
  // env assignments, `cd <path>`, `sleep N`, `pkill …`, `clear`.
  let s = seg
    .replace(/^(?:[A-Za-z_][A-Za-z0-9_]*=(?:""|''|\S+)\s+)+/, '')
    .replace(/^\s*pkill\s+[^;&|]*/i, '')
    .replace(/^\s*killall\s+[^;&|]*/i, '')
    .replace(/^\s*sleep\s+[\d.]+\s*/i, '')
    .replace(/^\s*clear\s*/i, '')
    .replace(/^\s*(?:cd|pushd)\s+(?:""|''|\S+)\s*/i, '')
    .trim();
  if (!s) return false;

  const first = (s.split(/\s+/)[0] || '').replace(/.*\//, '');
  if (ONE_SHOT_COMMANDS.has(first)) return false;

  // Build/test/lint/install → one-shot, unless it also names a dev subcommand.
  if (ONE_SHOT_SUBCOMMAND_RE.test(s) && !DEV_KEYWORD_RE.test(s)) return false;

  return DEV_CMD_PATTERNS.some((re) => re.test(s));
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
  // Strip leading `pkill … ; sleep N ; cd <path> &&` boilerplate the AI often
  // chains in front of `npm run dev`. Keep only the actual server command.
  let cleaned = s
    .replace(/^\s*pkill\s+[^;&]+[;&]\s*/i, '')
    .replace(/^\s*sleep\s+\d+\s*[;&]+\s*/i, '')
    .replace(/^\s*cd\s+[^&;]+(?:&&|;)\s*/i, '')
    .replace(/\s+2>\s*\/dev\/null/g, '')
    .replace(/\s+>\s*\/dev\/null/g, '')
    .trim();
  // Pick the most informative noun-phrase for the column. e.g.
  //   "npm run dev -- --port 5173 --host"  →  "npm run dev"
  //   "vite --host"                        →  "vite"
  //   "next dev -p 3000"                   →  "next dev"
  //   "php -S 127.0.0.1:8000 -t public"    →  "php -S"
  const NICE = [
    /^(npm|pnpm|yarn|bun)\s+(?:run\s+)?[\w:-]+/i,
    /^(vite|next|nuxt|astro|remix|svelte-kit|sveltekit|rspack|webpack|parcel|esbuild)(?:\s+\w+)?/i,
    /^(nodemon|tsx|ts-node-dev|ts-node)\b/i,
    /^(php\s+-S|uvicorn|gunicorn|flask|fastapi|rails\s+s(?:erver)?|hanami\s+s|mix\s+phx\.server)/i,
    /^(deno\s+(?:run|task)|bun\s+run|bun\s+\w+)/i,
    /^(go\s+run|cargo\s+run|dotnet\s+run|gradle\s+\w+)/i,
    /^(serve|http-server|live-server|browser-sync)\b/i,
  ];
  for (const re of NICE) {
    const m = cleaned.match(re);
    if (m) return m[0];
  }
  // Fallback: first two whitespace-separated tokens, then ellipsize.
  const head = cleaned.split(/\s+/).slice(0, 3).join(' ');
  return head.length > 32 ? head.slice(0, 30) + '…' : head;
}

function _shortCwd(cwd, command) {
  // Prefer the explicit `cd <path>` baked into the command — that's the
  // folder the dev server actually runs from. The spawn-level cwd is often
  // the user's home because they invoked the chain from there.
  if (command) {
    const m = String(command).match(/\bcd\s+("([^"]+)"|'([^']+)'|(\S+))/i);
    if (m) {
      const raw = (m[2] || m[3] || m[4] || '').trim();
      if (raw) return _formatHome(raw);
    }
  }
  if (!cwd) return '';
  return _formatHome(cwd);
}

function _formatHome(p) {
  const home = os.homedir();
  let out = p.startsWith(home) ? '~' + p.slice(home.length) : p;
  // Display only the trailing two segments for narrow columns.
  const parts = out.split('/');
  if (parts.length > 3) out = '…/' + parts.slice(-2).join('/');
  return out;
}

export function list() {
  return Array.from(_entries.values()).map((e) => ({
    id: e.id,
    pid: e.pid,
    command: e.command,
    label: e.label,
    cwd: e.cwd,
    cwdShort: _shortCwd(e.cwd, e.command),
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
