// Tests for lib/work-item-verifier.js (P7).
// Drives the real spawn — uses /bin/sh -c with `true`, `false`, `echo` so
// we don't depend on any project shape.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const _db = { projects: [], lastVerification: null, lastComment: null };

vi.mock('../project-manager.js', () => ({
  getProject: vi.fn(id => _db.projects.find(p => p.id === id) || null),
  setWorkItemVerification: vi.fn((pid, iid, v) => {
    _db.lastVerification = { pid, iid, v };
    const p = _db.projects.find(x => x.id === pid);
    if (!p) return null;
    const it = (p.backlog || []).find(x => x.id === iid);
    if (it) it.verified = v;
    return it;
  }),
  addWorkItemComment: vi.fn((pid, iid, c) => {
    _db.lastComment = { pid, iid, c };
    return { id: 'cmt-1', ...c, ts: Date.now() };
  }),
}));

const { runVerifyCommand, verifyWorkItem, resolveVerifyCommand, __test } =
  await import('../lib/work-item-verifier.js');
let projectRoot;

beforeEach(() => {
  projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'fauna-verifier-'));
  _db.projects = [];
  _db.lastVerification = null;
  _db.lastComment = null;
});
afterEach(() => fs.rmSync(projectRoot, { recursive: true, force: true }));

describe('resolveVerifyCommand', () => {
  it('prefers card.verifyCommand', () => {
    const r = resolveVerifyCommand({ qa: { command: 'pj' } }, { verifyCommand: 'card-cmd' });
    expect(r).toEqual({ command: 'card-cmd', source: 'card' });
  });
  it('falls back to project.qa.command', () => {
    const r = resolveVerifyCommand({ qa: { command: 'pj' } }, { verifyCommand: null });
    expect(r).toEqual({ command: 'pj', source: 'project' });
  });
  it('returns null when neither set', () => {
    expect(resolveVerifyCommand({}, {})).toBeNull();
    expect(resolveVerifyCommand({}, { verifyCommand: '  ' })).toBeNull();
  });
  it('detects package-manager tests and runs Vitest outside watch mode', () => {
    fs.writeFileSync(path.join(projectRoot, 'package.json'), JSON.stringify({
      packageManager: 'pnpm@10', scripts: { test: 'vitest' },
    }));
    expect(resolveVerifyCommand({ rootPath: projectRoot }, {})).toEqual({
      command: 'pnpm run test --run', source: 'auto',
    });
  });
  it('uses declared Vitest when there is no test script, without downloading a runner', () => {
    fs.writeFileSync(path.join(projectRoot, 'package.json'), JSON.stringify({
      devDependencies: { vitest: '*' },
    }));
    expect(resolveVerifyCommand({ rootPath: projectRoot }, {})).toEqual({
      command: './node_modules/.bin/vitest run', source: 'auto',
    });
  });
  it('skips placeholder/watch scripts and prefers a CI script', () => {
    fs.writeFileSync(path.join(projectRoot, 'package.json'), JSON.stringify({
      scripts: { test: 'vitest --watch', 'test:ci': 'vitest run' },
    }));
    expect(resolveVerifyCommand({ rootPath: projectRoot }, {}).command).toBe('npm run test:ci');
    fs.writeFileSync(path.join(projectRoot, 'package.json'), JSON.stringify({
      scripts: { test: 'echo "Error: no test specified" && exit 1' },
    }));
    expect(resolveVerifyCommand({ rootPath: projectRoot }, {})).toBeNull();
  });
  it('detects Python tests even when there is no package.json', () => {
    fs.mkdirSync(path.join(projectRoot, 'tests'));
    fs.writeFileSync(path.join(projectRoot, 'pyproject.toml'), '[tool.pytest.ini_options]\n');
    expect(resolveVerifyCommand({ rootPath: projectRoot }, {})).toEqual({
      command: 'pytest -q', source: 'auto',
    });
  });
});

describe('runVerifyCommand', () => {
  it('builds a developer PATH for packaged app shells', () => {
    const env = __test.buildVerifyEnv({ PATH: '/custom/bin' });
    expect(env.PATH.split(':')).toContain('/custom/bin');
    expect(env.PATH.split(':')).toContain('/usr/local/bin');
    expect(env.PATH.split(':')).toContain('/opt/homebrew/bin');
  });

  it('passes for exit-code 0', async () => {
    const r = await runVerifyCommand('true');
    expect(r.ok).toBe(true);
    expect(r.exitCode).toBe(0);
  });

  it('fails for exit-code !=0', async () => {
    const r = await runVerifyCommand('false');
    expect(r.ok).toBe(false);
    expect(r.exitCode).not.toBe(0);
  });

  it('marks command-not-found as infrastructure failure', async () => {
    const r = await runVerifyCommand('definitely-not-a-real-fauna-command-xyz');
    expect(r.ok).toBe(false);
    expect(r.exitCode).toBe(127);
    expect(r.infrastructureFailure).toBe(true);
  });

  it('captures stdout and stderr', async () => {
    const r = await runVerifyCommand('echo hi-out; echo hi-err 1>&2');
    expect(r.ok).toBe(true);
    expect(r.output).toContain('hi-out');
    expect(r.output).toContain('hi-err');
  });

  it('clips very long output', async () => {
    // Produce ~20 KB of x's
    const r = await runVerifyCommand('yes x | head -c 20000');
    expect(r.ok).toBe(true);
    expect(r.output.length).toBeLessThanOrEqual(8_500); // 8 KB cap + framing
  });

  it('respects timeout', async () => {
    const r = await runVerifyCommand('sleep 10', { timeoutMs: 5_000 /* min */ });
    expect(r.ok).toBe(false);
    expect(r.killed).toBe(true);
  }, 8_000);
});

describe('verifyWorkItem', () => {
  it('executes detected tests and persists the real result on a card', async () => {
    fs.writeFileSync(path.join(projectRoot, 'package.json'), JSON.stringify({
      scripts: { test: 'node --test checks.test.cjs' },
    }));
    fs.writeFileSync(path.join(projectRoot, 'checks.test.cjs'),
      "require('node:test')('CI check', () => require('node:assert/strict').equal(process.env.CI, '1'));\n");
    _db.projects.push({ id: 'p1', rootPath: projectRoot, backlog: [{ id: 'c1' }] });
    const result = await verifyWorkItem('p1', 'c1', { runId: 't1' });
    expect(result).toMatchObject({ ok: true, exitCode: 0, source: 'auto', command: 'npm run test' });
    expect(result.output).toContain('CI check');
    expect(_db.lastVerification.v).toMatchObject({ ok: true, exitCode: 0, runId: 't1' });
  });
  it('errors on missing project', async () => {
    const r = await verifyWorkItem('nope', 'c1');
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/project not found/);
  });

  it('errors on missing item', async () => {
    _db.projects.push({ id: 'p1', backlog: [] });
    const r = await verifyWorkItem('p1', 'c1');
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/item not found/);
  });

  it('records an unverified result when no verifier is configured', async () => {
    _db.projects.push({ id: 'p1', backlog: [{ id: 'c1', verifyCommand: null }] });
    const r = await verifyWorkItem('p1', 'c1', { postComment: false });
    expect(r.ok).toBe(false);
    expect(r.skipped).toBe(true);
    expect(_db.lastVerification.v.ok).toBe(false);
    expect(_db.lastVerification.v.exitCode).toBe(null);
  });

  it('runs card.verifyCommand and records pass', async () => {
    _db.projects.push({ id: 'p1', rootPath: process.cwd(),
      backlog: [{ id: 'c1', verifyCommand: 'true' }] });
    const r = await verifyWorkItem('p1', 'c1', { runId: 't1' });
    expect(r.ok).toBe(true);
    expect(r.command).toBe('true');
    expect(_db.lastVerification.v.ok).toBe(true);
    expect(_db.lastVerification.v.runId).toBe('t1');
    expect(_db.lastComment.c.body).toMatch(/Verification passed/);
  });

  it('falls back to project.qa.command', async () => {
    _db.projects.push({ id: 'p1', rootPath: process.cwd(),
      qa: { command: 'true' },
      backlog: [{ id: 'c1', verifyCommand: null }] });
    const r = await verifyWorkItem('p1', 'c1');
    expect(r.ok).toBe(true);
    expect(r.source).toBe('project');
  });

  it('records failure on non-zero exit and posts a fail comment', async () => {
    _db.projects.push({ id: 'p1', rootPath: process.cwd(),
      backlog: [{ id: 'c1', verifyCommand: 'false' }] });
    const r = await verifyWorkItem('p1', 'c1');
    expect(r.ok).toBe(false);
    expect(_db.lastVerification.v.ok).toBe(false);
    expect(_db.lastComment.c.body).toMatch(/Verification failed/);
  });

  it('can suppress comments', async () => {
    _db.projects.push({ id: 'p1', rootPath: process.cwd(),
      backlog: [{ id: 'c1', verifyCommand: 'true' }] });
    await verifyWorkItem('p1', 'c1', { postComment: false });
    expect(_db.lastComment).toBeNull();
  });
});
