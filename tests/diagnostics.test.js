import { describe, it, expect, vi } from 'vitest';

import { parseDiagnosticsOutput, runWorkspaceDiagnostics } from '../lib/diagnostics.js';

describe('diagnostics', () => {
  it('parses TypeScript-style diagnostics', () => {
    const out = 'src/app.ts(4,12): error TS2322: Type string is not assignable to number.\n';
    expect(parseDiagnosticsOutput(out)).toEqual([{
      file: 'src/app.ts', line: 4, column: 12,
      severity: 'error', source: 'TS2322', message: 'Type string is not assignable to number.',
    }]);
  });

  it('runs the discovered workspace validation command', async () => {
    const runShell = vi.fn(async () => 'src/app.js:3:5 warning no-console');
    const result = await runWorkspaceDiagnostics({
      workspace: { cwd: '/tmp/project', validation: [{ source: 'package.json', command: 'npm run lint' }] },
      runShell,
    });

    expect(runShell).toHaveBeenCalledWith(expect.objectContaining({ command: 'npm run lint', cwd: '/tmp/project' }));
    expect(result.ok).toBe(true);
    expect(result.diagnostics[0]).toMatchObject({ file: 'src/app.js', line: 3, column: 5, severity: 'warning' });
  });

  it('reports skipped when no validation command exists', async () => {
    const result = await runWorkspaceDiagnostics({ workspace: { cwd: '/tmp/project', validation: [] } });
    expect(result).toMatchObject({ ok: true, skipped: true, diagnostics: [] });
  });
});
