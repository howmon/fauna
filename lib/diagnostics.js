const DIAG_RE = /^(.+?):(\d+):(\d+)(?:\s+-)?\s*(error|warning|warn)?\s*(.*)$/i;
const TS_RE = /^(.+?)\((\d+),(\d+)\):\s*(error|warning)\s+([^:]+):\s*(.*)$/i;

export function parseDiagnosticsOutput(output = '') {
  const text = String(output || '');
  const diagnostics = [];
  for (const rawLine of text.split('\n')) {
    const line = rawLine.trim();
    if (!line) continue;
    let m = line.match(TS_RE);
    if (m) {
      diagnostics.push({
        file: m[1], line: Number(m[2]), column: Number(m[3]),
        severity: m[4].toLowerCase(), source: m[5], message: m[6],
      });
      continue;
    }
    m = line.match(DIAG_RE);
    if (m && /\.[a-z0-9]+$/i.test(m[1])) {
      diagnostics.push({
        file: m[1], line: Number(m[2]), column: Number(m[3]),
        severity: /^warn/i.test(m[4] || '') ? 'warning' : (m[4] || 'error').toLowerCase(),
        source: 'diagnostic', message: m[5] || line,
      });
    }
  }
  return diagnostics;
}

export async function runWorkspaceDiagnostics(opts = {}) {
  const workspace = opts.workspace;
  const runShell = opts.runShell;
  const requestedCommand = opts.command || null;
  const selected = requestedCommand
    ? { source: 'explicit', command: requestedCommand }
    : (workspace && Array.isArray(workspace.validation) ? workspace.validation[0] : null);

  if (!workspace) return { ok: false, error: 'workspace required' };
  if (!selected || !selected.command) {
    return { ok: true, workspace, command: null, diagnostics: [], skipped: true, reason: 'No validation command discovered.' };
  }
  if (typeof runShell !== 'function') {
    return { ok: false, workspace, command: selected.command, diagnostics: [], error: 'runShell is not available in this context.' };
  }

  const output = await runShell({
    command: selected.command,
    cwd: opts.cwd || workspace.cwd,
    timeoutMs: opts.timeoutMs || 180000,
    reason: 'workspace diagnostics',
  });
  return {
    ok: true,
    workspace,
    command: selected.command,
    source: selected.source,
    diagnostics: parseDiagnosticsOutput(output),
    raw: String(output || '').slice(-12000),
  };
}