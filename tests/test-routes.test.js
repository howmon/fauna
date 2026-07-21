import { describe, expect, it, vi } from 'vitest';
import { createTestRunManager } from '../server/routes/tests.js';

describe('test run manager', () => {
  it('publishes streamed lifecycle events and a normalized result', async () => {
    const runCommand = vi.fn(async opts => {
      opts.onChunk('stdout', 'running\n');
      return {
        ok: true, exitCode: 0, stderr: '', killed: false,
        stdout: JSON.stringify({ testResults: [{ assertionResults: [{ fullName: 'suite works', status: 'passed', duration: 3 }] }] }),
      };
    });
    const manager = createTestRunManager({ runCommand });
    const events = [];
    manager.subscribe(event => events.push(event));
    const started = await manager.start({ root: '/tmp/project', framework: 'vitest', file: 'a.test.js', fullName: 'suite > works' });
    await vi.waitFor(() => expect(manager.get(started.id).status).toBe('passed'));
    expect(events.map(event => event.type)).toEqual(['started', 'output', 'finished']);
    expect(manager.get(started.id).result).toMatchObject({ counts: { passed: 1, failed: 0, skipped: 0 }, output: 'PASS  suite works (3ms)' });
  });

  it('aborts an active run', async () => {
    let resolveRun;
    const runCommand = vi.fn(opts => new Promise(resolve => {
      resolveRun = resolve;
      opts.signal.addEventListener('abort', () => resolve({ ok: false, exitCode: 130, stdout: '', stderr: '', killed: true }));
    }));
    const manager = createTestRunManager({ runCommand });
    const run = await manager.start({ root: '/tmp/project', framework: 'node' });
    expect(manager.stop(run.id)).toBe(true);
    await vi.waitFor(() => expect(manager.get(run.id).status).toBe('cancelled'));
    resolveRun?.({ ok: false, exitCode: 130, stdout: '', stderr: '', killed: true });
  });
});