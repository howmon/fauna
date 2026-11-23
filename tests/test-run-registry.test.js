import { describe, it, expect, vi, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import { createTestRunRegistry, testRunRegistry, isTestCommand, processTreeMemory, TEST_OUTPUT_LIMIT } from '../server/lib/test-run-registry.js';
import { registerTestRunRoutes } from '../server/routes/test-runs.js';
import { runShell } from '../server/lib/shell-runner.js';

afterEach(() => vi.restoreAllMocks());

describe('test command monitor', () => {
  it('recognizes test runners through cwd, PATH and absolute executable prefixes without treating narration as execution', () => {
    for (const command of [
      'bun test', 'bun run test:unit', 'PATH="/tmp/bin:$PATH" bun test checks.ts',
      'cd /project && /Users/example/.bun/bin/bun test checks.ts',
      'npx vitest run', './node_modules/.bin/jest', 'python3 -m pytest',
      'node --test checks.cjs',
    ]) expect(isTestCommand(command), command).toBe(true);
    for (const command of ['echo "bun test"', 'npm run build', 'cat test.log', 'node server.js']) {
      expect(isTestCommand(command), command).toBe(false);
    }
  });

  it('keeps bounded, redacted output across chunk boundaries and retains only 20 completed commands', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(12345);
    const registry = createTestRunRegistry();
    const stop = vi.fn();
    const id = registry.start({ command: 'bun test', cwd: '/project', pid: 123, stop });
    const token = 'ghp_' + 'a'.repeat(36);
    registry.append(id, 'x'.repeat(TEST_OUTPUT_LIMIT * 3));
    registry.append(id, '\n' + token.slice(0, 12));
    registry.append(id, token.slice(12));
    const output = registry.get(id);
    expect(output.output.length).toBeLessThanOrEqual(TEST_OUTPUT_LIMIT);
    expect(output.output).not.toContain(token);
    expect(output.output).toContain('[REDACTED:GITHUB_PAT_CLASSIC]');
    expect(output.outputTruncated).toBe(true);
    expect((await registry.list()).items[0]).not.toHaveProperty('output');
    const completedIds = [];
    for (let i = 0; i < 30; i++) {
      const finished = registry.start({ command: 'npm test', cwd: '/project', stop });
      completedIds.push(finished);
      registry.finish(finished, { ok: true, exitCode: 0 });
    }
    expect((await registry.list()).items).toHaveLength(21);
    expect(registry.get(completedIds[0])).toBeNull();
    expect(registry.get(completedIds.at(-1)).status).toBe('passed');
    expect(registry.get(id).status).toBe('running');
    expect(registry.stop(id)).toEqual({ ok: true });
    expect(stop).toHaveBeenCalledTimes(1);
    registry.finish(id, { ok: false, killed: true, exitCode: 130 });
    expect(registry.stop(id)).toMatchObject({ ok: false, status: 409 });
  });

  it('sums descendant and reparented process-group RSS without counting unrelated processes', () => {
    const result = processTreeMemory([
      { pid: 10, ppid: 1, pgid: 10, rssBytes: 100 },
      { pid: 11, ppid: 10, pgid: 10, rssBytes: 200 },
      { pid: 12, ppid: 1, pgid: 10, rssBytes: 300 },
      { pid: 13, ppid: 11, pgid: 13, rssBytes: 400 },
      { pid: 99, ppid: 1, pgid: 99, rssBytes: 5000 },
    ], 10);
    expect(result).toMatchObject({ rssBytes: 1000, processCount: 4 });
  });

  it('samples memory only on demand, shares simultaneous samples, and surfaces failures rather than reporting zero', async () => {
    const sample = vi.fn(async () => { throw new Error('Process sampling denied'); });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const registry = createTestRunRegistry({ sampleMemory: sample });
    const id = registry.start({ command: 'bun test', cwd: '/project', pid: 10, stop() {} });
    await registry.list();
    expect(sample).not.toHaveBeenCalled();
    const [one, two] = await Promise.all([registry.list({ memory: true }), registry.list({ memory: true })]);
    expect(sample).toHaveBeenCalledTimes(1);
    expect(one.memoryError).toBe('Process sampling denied');
    expect(two.memoryError).toBe(one.memoryError);
    expect(registry.get(id).memory).toBeNull();
    expect(warn).toHaveBeenCalled();
  });

  it('reports success, failure, Stop and timeout separately', () => {
    const registry = createTestRunRegistry();
    for (const [result, status] of [
      [{ ok: true, exitCode: 0 }, 'passed'],
      [{ ok: false, exitCode: 1 }, 'failed'],
      [{ ok: false, killed: true, exitCode: 130 }, 'stopped'],
      [{ ok: false, timedOut: true, exitCode: 130 }, 'timed_out'],
    ]) {
      const id = registry.start({ command: 'bun test', cwd: '/project', stop() {} });
      registry.finish(id, result);
      expect(registry.get(id)).toMatchObject({ status, exitCode: result.exitCode, finishedAt: expect.any(Number) });
    }
  });
});

describe('test monitor routes', () => {
  it('rejects remote callers even with a matching nonce', () => {
    const routes = new Map();
    registerTestRunRoutes({
      get: (url, ...handlers) => routes.set(url, handlers),
      post: (url, ...handlers) => routes.set(url, handlers),
    }, { uiNonce: () => 'fixture-nonce' });
    const res = { status: vi.fn().mockReturnThis(), json: vi.fn() };
    const next = vi.fn();
    routes.get('/api/test-runs')[0]({ ip: '192.0.2.1', get: () => 'fixture-nonce' }, res, next);
    expect(res.status).toHaveBeenCalledWith(403);
    expect(next).not.toHaveBeenCalled();
  });

  it.skipIf(process.platform === 'win32')('shows and stops a real active Node test, denies unauthenticated reads and cannot stop an arbitrary PID', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fauna-test-monitor-'));
    fs.writeFileSync(path.join(dir, 'slow.test.cjs'),
      "require('node:test')('live test', async () => { console.log('test-started'); await new Promise(resolve => setTimeout(resolve, 10000)); });");
    const app = express();
    registerTestRunRoutes(app, { uiNonce: () => 'fixture-nonce' });
    const server = app.listen(0, '127.0.0.1');
    await new Promise(resolve => server.once('listening', resolve));
    const url = 'http://127.0.0.1:' + server.address().port;
    const headers = { 'x-fauna-ui': 'fixture-nonce' };
    const node = "'" + process.execPath.replace(/'/g, "'\\''") + "'";
    const command = node + ' --test slow.test.cjs';
    let ready;
    const started = new Promise(resolve => { ready = resolve; });
    const pending = runShell({
      command, cwd: dir, shellBin: '/bin/sh', isWin: false, timeoutMs: 5000,
      context: { conversationId: 'test-chat', source: 'chat' },
      onChunk: (_kind, text) => { if (text.includes('test-started')) ready(); },
    });
    let id;
    try {
      await Promise.race([started, pending.then(() => { throw new Error('Test command exited before emitting output'); })]);
      expect((await fetch(url + '/api/test-runs')).status).toBe(403);
      const list = await (await fetch(url + '/api/test-runs?memory=1', { headers })).json();
      const run = list.items.find(item => item.command === command);
      id = run.id;
      expect(run).toMatchObject({ status: 'running', kind: 'test', cwd: dir, conversationId: 'test-chat' });
      expect(run.memory.rssBytes).toBeGreaterThan(0);
      expect(run.memory.processCount).toBeGreaterThan(0);
      const detail = await (await fetch(url + '/api/test-runs/' + id, { headers })).json();
      expect(detail.output).toContain('test-started');
      expect((await fetch(url + '/api/test-runs/1/stop', { method: 'POST', headers })).status).toBe(404);
      expect((await fetch(url + '/api/test-runs/' + id + '/stop', { method: 'POST', headers })).status).toBe(200);
      expect(await pending).toMatchObject({ ok: false, killed: true });
      const completed = await (await fetch(url + '/api/test-runs/' + id, { headers })).json();
      expect(completed.status).toBe('stopped');
    } finally {
      if (id && testRunRegistry.get(id)?.status === 'running') testRunRegistry.stop(id);
      await pending;
      await new Promise(resolve => server.close(resolve));
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }, 10000);
});
