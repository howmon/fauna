export function parseTestResults(output = '') {
  const text = String(output || '');
  const failures = [];
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    let m = line.match(/^\s*(?:×|FAIL|✕)\s+(.+?)\s*(?:\d+ms)?\s*$/);
    if (m) {
      failures.push({ name: m[1].trim(), message: (lines[i + 1] || '').trim(), source: 'js-test' });
      continue;
    }
    m = line.match(/^FAILED\s+(.+?)\s+-\s+(.+)$/);
    if (m) failures.push({ name: m[1].trim(), message: m[2].trim(), source: 'pytest' });
    m = line.match(/^--- FAIL:\s+(.+?)\s+\((.*?)\)$/);
    if (m) failures.push({ name: m[1].trim(), duration: m[2], source: 'go-test' });
  }
  const summary = {
    failed: failures.length,
    passed: /\b(?:Tests|test).*?passed\b/i.test(text) || /\bpassed\b/.test(text),
  };
  return { failures, summary };
}

export async function runTestResults(opts = {}) {
  if (typeof opts.runShell !== 'function') return { ok: false, error: 'runShell is not available in this context.' };
  const command = opts.command || 'npm test';
  const output = await opts.runShell({
    command,
    cwd: opts.cwd,
    timeoutMs: opts.timeoutMs || 180000,
    reason: 'structured test results',
  });
  const parsed = parseTestResults(output);
  return { ok: true, command, raw: String(output || '').slice(-12000), ...parsed };
}