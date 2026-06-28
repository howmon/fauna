import { spawn } from 'node:child_process';

function _platformCommand(entry) {
  if (!entry || typeof entry !== 'object') return '';
  if (process.platform === 'win32' && entry.windows) return entry.windows;
  if (process.platform === 'darwin' && entry.osx) return entry.osx;
  if (process.platform === 'linux' && entry.linux) return entry.linux;
  return entry.command || '';
}

function _parseJsonObject(text) {
  const raw = String(text || '').trim();
  if (!raw) return {};
  try { return JSON.parse(raw); } catch (_) {}
  const first = raw.indexOf('{');
  const last = raw.lastIndexOf('}');
  if (first !== -1 && last > first) {
    try { return JSON.parse(raw.slice(first, last + 1)); } catch (_) {}
  }
  return {};
}

export function collectHookEntries(records, eventName) {
  const event = String(eventName || '').trim();
  if (!event) return [];
  const entries = [];
  for (const record of records || []) {
    const hooks = record && record.hooks;
    if (!hooks || typeof hooks !== 'object') continue;
    const list = hooks[event];
    if (!Array.isArray(list)) continue;
    for (const entry of list) {
      entries.push({ ...entry, _source: record.relativePath || record.path || record.name || 'hook' });
    }
  }
  return entries;
}

export function runHookEntry(entry, payload = {}, opts = {}) {
  const command = _platformCommand(entry);
  if (!command) {
    return Promise.resolve({ ok: false, code: null, stdout: '', stderr: '', output: {}, blocking: true, error: 'Hook command missing' });
  }

  const timeoutMs = Math.max(1, Number(entry.timeout || opts.timeoutMs || 15000));
  const cwd = entry.cwd || opts.cwd || process.cwd();
  const env = { ...process.env, ...(opts.env || {}), ...(entry.env || {}) };

  return new Promise((resolve) => {
    let stdout = '';
    let stderr = '';
    let finished = false;
    const child = spawn(command, {
      shell: true,
      cwd,
      env,
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    const timer = setTimeout(() => {
      if (finished) return;
      finished = true;
      try { child.kill('SIGTERM'); } catch (_) {}
      resolve({ ok: false, code: null, stdout, stderr, output: {}, blocking: true, error: 'Hook timed out' });
    }, timeoutMs);

    child.stdout.on('data', chunk => { stdout += chunk.toString(); });
    child.stderr.on('data', chunk => { stderr += chunk.toString(); });
    child.on('error', error => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      resolve({ ok: false, code: null, stdout, stderr, output: {}, blocking: true, error: error.message });
    });
    child.on('close', code => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      const output = _parseJsonObject(stdout);
      const blocking = code === 2 || output.continue === false || output.decision === 'block' || output.hookSpecificOutput?.permissionDecision === 'deny';
      resolve({
        ok: code === 0 && !blocking,
        code,
        stdout,
        stderr,
        output,
        blocking,
        stopReason: output.stopReason || (blocking ? stderr.trim() : ''),
        systemMessage: output.systemMessage || '',
      });
    });

    try { child.stdin.end(JSON.stringify(payload || {})); } catch (_) {}
  });
}

export async function runHooks(records, eventName, payload = {}, opts = {}) {
  const entries = collectHookEntries(records, eventName);
  const results = [];
  const systemMessages = [];
  let permissionDecision = null;
  let stopReason = '';
  let blocked = false;

  for (const entry of entries) {
    const result = await runHookEntry(entry, { ...payload, hookEventName: eventName }, opts);
    results.push({ source: entry._source, command: _platformCommand(entry), ...result });
    if (result.systemMessage) systemMessages.push(result.systemMessage);
    const decision = result.output?.hookSpecificOutput?.permissionDecision;
    if (decision === 'deny' || decision === 'ask' || decision === 'allow') permissionDecision = decision;
    if (result.blocking) {
      blocked = true;
      stopReason = result.stopReason || result.error || `Hook blocked ${eventName}`;
      break;
    }
  }

  return {
    ok: !blocked,
    event: eventName,
    count: entries.length,
    blocked,
    stopReason,
    systemMessages,
    permissionDecision,
    results,
  };
}
