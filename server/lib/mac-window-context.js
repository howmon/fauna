// mac-window-context — enumerate visible apps/windows and arrange them
// on macOS using AppleScript / System Events. Pure Node, no native build.
//
// Mirrors the data shape Codex's `sky.node` exposes (running apps with
// frontmost flag, window titles, bounds, on-screen state) but without
// shipping a compiled Swift addon. Requires Accessibility permission
// (System Settings → Privacy & Security → Accessibility) for the host
// process — same prompt Fauna already triggers.

import { execFile } from 'child_process';
import os from 'os';

const IS_MAC = process.platform === 'darwin';

function runOsa(script, { timeoutMs = 4000 } = {}) {
  return new Promise((resolve, reject) => {
    execFile('/usr/bin/osascript', ['-ss', '-e', script], { timeout: timeoutMs, maxBuffer: 4 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) return reject(Object.assign(err, { stderr: String(stderr || '') }));
      resolve(String(stdout || ''));
    });
  });
}

// AppleScript record output looks like:
//   {{name:"Safari", pid:1234, frontmost:true, windows:{{title:"…", x:0, y:0, w:1280, h:800, visible:true}}}, …}
// We parse it with a small tolerant scanner — JSON.parse won't work because
// AppleScript records use `key:value` (no quotes on keys) and unquoted bools.
function parseAppleScriptValue(src) {
  let i = 0;
  const eof = () => i >= src.length;
  const skip = () => { while (!eof() && /\s/.test(src[i])) i++; };

  function readValue() {
    skip();
    const ch = src[i];
    if (ch === '"') return readString();
    if (ch === '{') return readListOrRecord();
    if (ch === '-' || /[0-9]/.test(ch)) return readNumber();
    return readBareWord();
  }
  function readString() {
    let out = ''; i++; // skip opening "
    while (!eof()) {
      const c = src[i++];
      if (c === '\\') { out += src[i++] || ''; continue; }
      if (c === '"') return out;
      out += c;
    }
    return out;
  }
  function readNumber() {
    let s = '';
    while (!eof() && /[-0-9.eE+]/.test(src[i])) s += src[i++];
    const n = Number(s);
    return Number.isFinite(n) ? n : s;
  }
  function readBareWord() {
    let s = '';
    while (!eof() && /[A-Za-z0-9_]/.test(src[i])) s += src[i++];
    if (s === 'true') return true;
    if (s === 'false') return false;
    if (s === 'missing value' || s === 'missing') return null;
    return s;
  }
  function readKey() {
    skip();
    let s = '';
    while (!eof() && /[A-Za-z0-9_]/.test(src[i])) s += src[i++];
    return s;
  }
  function readListOrRecord() {
    i++; // skip {
    skip();
    if (src[i] === '}') { i++; return []; }
    // Look ahead: record entries start with key:
    const savedI = i;
    const maybeKey = readKey();
    skip();
    if (src[i] === ':') {
      // record
      i = savedI;
      const obj = {};
      while (!eof()) {
        skip();
        const key = readKey();
        skip();
        if (src[i] !== ':') break;
        i++; // skip :
        obj[key] = readValue();
        skip();
        if (src[i] === ',') { i++; continue; }
        if (src[i] === '}') { i++; return obj; }
      }
      return obj;
    }
    // list
    i = savedI;
    const arr = [];
    while (!eof()) {
      arr.push(readValue());
      skip();
      if (src[i] === ',') { i++; continue; }
      if (src[i] === '}') { i++; return arr; }
    }
    return arr;
  }

  try { return readValue(); } catch (_) { return null; }
}

const LIST_WINDOWS_SCRIPT = `
set output to {}
tell application "System Events"
  set procs to (every process whose background only is false)
  repeat with p in procs
    try
      set procName to name of p
      set procPid to unix id of p
      set procFront to frontmost of p
      set winList to {}
      try
        repeat with w in (windows of p)
          try
            set wTitle to name of w
          on error
            set wTitle to ""
          end try
          set wPos to {0, 0}
          set wSize to {0, 0}
          try
            set wPos to position of w
          end try
          try
            set wSize to size of w
          end try
          set end of winList to {title:wTitle, x:(item 1 of wPos), y:(item 2 of wPos), w:(item 1 of wSize), h:(item 2 of wSize)}
        end repeat
      end try
      set end of output to {name:procName, pid:procPid, frontmost:procFront, windows:winList}
    end try
  end repeat
end tell
return output
`;

export async function listVisibleWindows({ timeoutMs = 6000 } = {}) {
  if (!IS_MAC) return { ok: false, error: 'macOS only', apps: [] };
  let raw;
  try { raw = await runOsa(LIST_WINDOWS_SCRIPT, { timeoutMs }); }
  catch (e) {
    const msg = e.stderr || e.message || String(e);
    const needsPerm = /not allowed assistive access|-1719|-1743/i.test(msg);
    return { ok: false, error: msg.trim(), needsAccessibility: needsPerm, apps: [] };
  }
  const parsed = parseAppleScriptValue(raw.trim());
  const apps = Array.isArray(parsed) ? parsed : [];
  // Normalize
  for (const a of apps) {
    a.windows = Array.isArray(a.windows) ? a.windows : [];
    for (const w of a.windows) {
      w.title = w.title || '';
      w.x = Number(w.x) || 0; w.y = Number(w.y) || 0;
      w.w = Number(w.w) || 0; w.h = Number(w.h) || 0;
    }
  }
  return { ok: true, apps };
}

// Apply a list of moves: [{app, windowIndex?, windowTitle?, x, y, w, h}]
// windowIndex is 1-based to match AppleScript; defaults to 1 (frontmost
// window of the app). windowTitle, when given, wins over windowIndex.
export async function arrangeWindows(moves, { timeoutMs = 8000 } = {}) {
  if (!IS_MAC) return { ok: false, error: 'macOS only', results: [] };
  if (!Array.isArray(moves) || !moves.length) return { ok: true, results: [] };

  const results = [];
  for (const m of moves) {
    if (!m || typeof m.app !== 'string') { results.push({ ok: false, error: 'missing app' }); continue; }
    const idx = Number.isInteger(m.windowIndex) && m.windowIndex > 0 ? m.windowIndex : 1;
    const x = Number(m.x), y = Number(m.y), w = Number(m.w), h = Number(m.h);
    const wantsMove = Number.isFinite(x) && Number.isFinite(y);
    const wantsSize = Number.isFinite(w) && Number.isFinite(h) && w > 0 && h > 0;
    const targetWindow = m.windowTitle
      ? `(first window whose name is ${quote(m.windowTitle)})`
      : `window ${idx}`;
    const ops = [];
    if (wantsMove) ops.push(`set position of ${targetWindow} to {${x}, ${y}}`);
    if (wantsSize) ops.push(`set size of ${targetWindow} to {${w}, ${h}}`);
    if (!ops.length) { results.push({ app: m.app, ok: false, error: 'no x/y/w/h provided' }); continue; }
    const script = `
tell application "System Events"
  tell process ${quote(m.app)}
    set frontmost to true
    ${ops.join('\n    ')}
  end tell
end tell
`;
    try {
      await runOsa(script, { timeoutMs });
      results.push({ app: m.app, ok: true, x, y, w, h });
    } catch (e) {
      const msg = e.stderr || e.message || String(e);
      results.push({ app: m.app, ok: false, error: msg.trim() });
    }
  }
  return { ok: results.every(r => r.ok), results };
}

// Return main display size — useful for the AI to compute tile coords.
export async function getScreenBounds({ timeoutMs = 3000 } = {}) {
  if (!IS_MAC) return { ok: false, error: 'macOS only' };
  const script = `tell application "Finder" to get bounds of window of desktop`;
  try {
    const raw = await runOsa(script, { timeoutMs });
    const m = raw.match(/-?\d+/g);
    if (!m || m.length < 4) return { ok: false, error: 'parse failed' };
    const [x1, y1, x2, y2] = m.map(Number);
    return { ok: true, x: x1, y: y1, width: x2 - x1, height: y2 - y1 };
  } catch (e) {
    return { ok: false, error: (e.stderr || e.message || String(e)).trim() };
  }
}

function quote(s) {
  return '"' + String(s).replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"';
}

export const _internal = { parseAppleScriptValue };
