// Failure → fix learning (headroom `headroom learn` idea, online + heuristic).
//
// headroom's standout feature is "success correlation": instead of cataloging
// failures ("Read failed 5 times"), it finds what the agent did NEXT that
// worked and records the specific delta — e.g. "FirstClassEntity is at
// src/scala/, not src/java/". That single correction prevents the same wasted
// retries forever.
//
// This module reconstructs the tool-call timeline from a finished
// conversation, pairs each FAILED tool call with the next SUCCESSFUL call of
// the same family, and emits a concrete correction. It is PURE and
// LLM-free (pattern-based), so it is cheap to run at end-of-loop and trivial
// to unit-test. The caller persists the corrections (e.g. via the facts
// memory) so they surface in future turns.

const PATH_TOOLS = new Set([
  'fauna_read_file', 'fauna_write_file', 'fauna_replace_string', 'fauna_apply_patch',
]);

const FAILURE_RE = /\b(enoent|eacces|eperm|no such file|not found|cannot find|couldn'?t find|command not found|is not recognized|permission denied|fatal error|traceback \(most recent|does not exist|nonexistent)\b/i;

const STOPWORDS = new Set(['the', 'and', 'for', 'with', 'this', 'that', 'from', 'into', 'run', 'cd', 'sudo']);

/**
 * Extract concrete corrections from a conversation's message list.
 * @param {Array} messages  allMessages (assistant tool_calls + role:'tool' results)
 * @returns {Array<{category:'correction', kind:'static', text:string}>}
 */
export function extractCorrections(messages) {
  const seq = buildInvocations(messages);
  const corrections = [];
  const seen = new Set();

  for (let i = 0; i < seq.length; i++) {
    const ev = seq[i];
    if (ev.ok) continue;

    // 1. Path corrections — wrong path read/edited, then the right one worked.
    if (PATH_TOOLS.has(ev.name) && typeof ev.args?.path === 'string') {
      const failPath = ev.args.path;
      const base = basename(failPath);
      for (let j = i + 1; j < seq.length; j++) {
        const s = seq[j];
        if (s.ok && PATH_TOOLS.has(s.name) && typeof s.args?.path === 'string'
          && s.args.path !== failPath && basename(s.args.path) === base) {
          pushUnique(corrections, seen, `\`${base}\` is at \`${s.args.path}\`, not \`${failPath}\` (an earlier access of the wrong path failed).`);
          break;
        }
      }
    }

    // 2. Command corrections — a shell command failed (missing binary/path),
    //    then a related command succeeded.
    if (ev.name === 'fauna_shell_exec' && typeof ev.args?.command === 'string'
      && FAILURE_RE.test(ev.content)) {
      const failCmd = ev.args.command.trim();
      for (let j = i + 1; j < seq.length; j++) {
        const s = seq[j];
        if (s.ok && s.name === 'fauna_shell_exec' && typeof s.args?.command === 'string') {
          const okCmd = s.args.command.trim();
          if (okCmd !== failCmd && shareSubject(failCmd, okCmd)) {
            pushUnique(corrections, seen, `Prefer \`${okCmd}\` over \`${failCmd}\` (the latter failed: ${firstLine(ev.content)}).`);
            break;
          }
        }
      }
    }
  }

  return corrections.slice(0, 10).map((text) => ({ category: 'correction', kind: 'static', text }));
}

// ── internals ────────────────────────────────────────────────────────────────

function buildInvocations(messages) {
  if (!Array.isArray(messages)) return [];
  const byId = new Map();
  for (const m of messages) {
    if (m && m.role === 'assistant' && Array.isArray(m.tool_calls)) {
      for (const tc of m.tool_calls) {
        let args = {};
        try {
          const raw = tc.function?.arguments;
          args = typeof raw === 'string' ? JSON.parse(raw) : (raw || {});
        } catch (_) { args = {}; }
        if (tc.id) byId.set(tc.id, { name: tc.function?.name, args });
      }
    }
  }
  const seq = [];
  for (const m of messages) {
    if (m && m.role === 'tool' && m.tool_call_id && byId.has(m.tool_call_id)) {
      const meta = byId.get(m.tool_call_id);
      const content = typeof m.content === 'string' ? m.content : safeStringify(m.content);
      seq.push({ name: meta.name, args: meta.args, content, ok: !isFailure(content) });
    }
  }
  return seq;
}

function isFailure(content) {
  if (!content) return false;
  const obj = tryParse(content);
  if (obj && typeof obj === 'object') {
    if (obj.ok === false) return true;
    if (typeof obj.exitCode === 'number' && obj.exitCode !== 0) return true;
  }
  return FAILURE_RE.test(content);
}

function shareSubject(a, b) {
  const ta = tokens(a), tb = new Set(tokens(b));
  for (const t of ta) if (tb.has(t)) return true;
  return false;
}

function tokens(s) {
  return (String(s).toLowerCase().match(/[a-z0-9_./-]{3,}/g) || [])
    .filter((t) => !STOPWORDS.has(t));
}

function basename(p) {
  const parts = String(p).split(/[\\/]/);
  return parts[parts.length - 1] || p;
}

function firstLine(s) {
  const line = String(s).split('\n').find((l) => l.trim()) || String(s);
  return line.trim().slice(0, 120);
}

function pushUnique(arr, seen, text) {
  const key = text.toLowerCase();
  if (seen.has(key)) return;
  seen.add(key);
  arr.push(text);
}

function tryParse(s) {
  const t = String(s).trim();
  if (!t || (t[0] !== '{' && t[0] !== '[')) return undefined;
  try { return JSON.parse(t); } catch (_) { return undefined; }
}

function safeStringify(v) {
  try { return JSON.stringify(v); } catch (_) { return String(v); }
}
