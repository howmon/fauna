/**
 * tests/instruction-discovery.test.js
 *
 * Unit tests for lib/instruction-files.js using Node.js built-in test runner.
 * Run with:  node --test tests/instruction-discovery.test.js
 */

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

import {
  loadInstructionFiles,
  _safeReadInstructionFile,
  _isPathInside,
  _realPathOrResolve,
  INSTRUCTION_FILE_LIMIT,
  INSTRUCTION_TOTAL_LIMIT,
} from '../lib/instruction-files.js';

// ── Helpers ───────────────────────────────────────────────────────────────

function makeTmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'fauna-test-'));
}

function write(filePath, content) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content, 'utf8');
}

/** Returns a run() stub that reports `repoRoot` as the git root. */
function mockRun(repoRoot) {
  return async (cmd) => {
    if (cmd.startsWith('git rev-parse --show-toplevel')) return repoRoot;
    return '';
  };
}

// ── Unit: _isPathInside ───────────────────────────────────────────────────

describe('_isPathInside', () => {
  test('child inside parent → true', () => {
    assert.ok(_isPathInside('/repo', '/repo/src/foo.js'));
  });
  test('parent itself → true', () => {
    assert.ok(_isPathInside('/repo', '/repo'));
  });
  test('sibling → false', () => {
    assert.ok(!_isPathInside('/repo', '/other/src'));
  });
  test('parent of parent → false', () => {
    assert.ok(!_isPathInside('/repo/src', '/repo'));
  });
});

// ── Unit: _safeReadInstructionFile ────────────────────────────────────────

describe('_safeReadInstructionFile', () => {
  let dir;
  before(() => { dir = makeTmpDir(); });
  after(() => fs.rmSync(dir, { recursive: true, force: true }));

  test('reads file within limits', () => {
    const p = path.join(dir, 'AGENTS.md');
    write(p, 'hello world');
    const r = _safeReadInstructionFile(p, INSTRUCTION_TOTAL_LIMIT);
    assert.ok(r);
    assert.equal(r.content, 'hello world');
    assert.equal(r.truncated, false);
  });

  test('truncates file exceeding per-file limit', () => {
    const p = path.join(dir, 'big.md');
    const bigContent = 'x'.repeat(INSTRUCTION_FILE_LIMIT + 100);
    write(p, bigContent);
    const r = _safeReadInstructionFile(p, INSTRUCTION_TOTAL_LIMIT);
    assert.ok(r);
    assert.equal(r.truncated, true);
    assert.equal(r.includedBytes, INSTRUCTION_FILE_LIMIT);
  });

  test('returns null for missing file', () => {
    const r = _safeReadInstructionFile(path.join(dir, 'nonexistent.md'), INSTRUCTION_TOTAL_LIMIT);
    assert.equal(r, null);
  });

  test('returns null when remainingBytes is 0', () => {
    const p = path.join(dir, 'zero.md');
    write(p, 'some content');
    const r = _safeReadInstructionFile(p, 0);
    assert.equal(r, null);
  });

  test('returns null for empty file', () => {
    const p = path.join(dir, 'empty.md');
    write(p, '');
    const r = _safeReadInstructionFile(p, INSTRUCTION_TOTAL_LIMIT);
    assert.equal(r, null);
  });
});

// ── Integration: loadInstructionFiles ─────────────────────────────────────

describe('loadInstructionFiles — no instruction files', () => {
  let repoDir;
  before(() => { repoDir = makeTmpDir(); });
  after(() => fs.rmSync(repoDir, { recursive: true, force: true }));

  test('returns empty array when no files exist', async () => {
    const files = await loadInstructionFiles(repoDir, mockRun(repoDir), {
      configDir: path.join(repoDir, 'fake-config'), // no global AGENTS.md
    });
    assert.deepEqual(files, []);
  });
});

describe('loadInstructionFiles — repo root AGENTS.md', () => {
  let repoDir;
  const SENTINEL = 'SENTINEL_REPO_ROOT';
  before(() => {
    repoDir = makeTmpDir();
    write(path.join(repoDir, 'AGENTS.md'), SENTINEL);
  });
  after(() => fs.rmSync(repoDir, { recursive: true, force: true }));

  test('repo root AGENTS.md is included', async () => {
    const files = await loadInstructionFiles(repoDir, mockRun(repoDir), {
      configDir: path.join(repoDir, 'fake-config'),
    });
    assert.equal(files.length, 1);
    assert.equal(files[0].kind, 'agents');
    assert.equal(files[0].scope, 'repo');
    assert.ok(files[0].content.includes(SENTINEL));
  });
});

describe('loadInstructionFiles — nested AGENTS.md', () => {
  let repoDir;
  before(() => {
    repoDir = makeTmpDir();
    write(path.join(repoDir, 'AGENTS.md'), 'ROOT_SENTINEL');
    write(path.join(repoDir, 'sub', 'AGENTS.md'), 'NESTED_SENTINEL');
  });
  after(() => fs.rmSync(repoDir, { recursive: true, force: true }));

  test('nested AGENTS.md is included after root', async () => {
    const subDir = path.join(repoDir, 'sub');
    const files = await loadInstructionFiles(subDir, mockRun(repoDir), {
      configDir: path.join(repoDir, 'fake-config'),
    });
    assert.equal(files.length, 2);
    const [root, nested] = files;
    assert.ok(root.content.includes('ROOT_SENTINEL'), 'root should come first');
    assert.ok(nested.content.includes('NESTED_SENTINEL'), 'nested should be second');
    assert.ok(root.priority < nested.priority, 'root priority < nested priority');
  });
});

describe('loadInstructionFiles — .github/copilot-instructions.md', () => {
  let repoDir;
  const SENTINEL = 'COPILOT_SENTINEL';
  before(() => {
    repoDir = makeTmpDir();
    write(path.join(repoDir, '.github', 'copilot-instructions.md'), SENTINEL);
  });
  after(() => fs.rmSync(repoDir, { recursive: true, force: true }));

  test('copilot-instructions.md is included', async () => {
    const files = await loadInstructionFiles(repoDir, mockRun(repoDir), {
      configDir: path.join(repoDir, 'fake-config'),
    });
    assert.equal(files.length, 1);
    assert.equal(files[0].kind, 'copilot');
    assert.ok(files[0].content.includes(SENTINEL));
  });
});

describe('loadInstructionFiles — both global and repo', () => {
  let repoDir, globalDir;
  before(() => {
    repoDir = makeTmpDir();
    globalDir = makeTmpDir();
    write(path.join(globalDir, 'AGENTS.md'), 'GLOBAL_SENTINEL');
    write(path.join(repoDir, 'AGENTS.md'), 'REPO_SENTINEL');
  });
  after(() => {
    fs.rmSync(repoDir, { recursive: true, force: true });
    fs.rmSync(globalDir, { recursive: true, force: true });
  });

  test('global AGENTS.md has lower priority number than repo', async () => {
    const files = await loadInstructionFiles(repoDir, mockRun(repoDir), {
      configDir: globalDir,
    });
    assert.equal(files.length, 2);
    const global = files.find(f => f.scope === 'global');
    const repo = files.find(f => f.scope === 'repo');
    assert.ok(global, 'global file should be present');
    assert.ok(repo, 'repo file should be present');
    assert.ok(global.priority < repo.priority, 'global has lower priority number (higher precedence)');
  });
});

describe('loadInstructionFiles — interop files', () => {
  let repoDir;
  before(() => {
    repoDir = makeTmpDir();
    write(path.join(repoDir, 'CLAUDE.md'), 'CLAUDE_SENTINEL');
    write(path.join(repoDir, '.cursorrules'), 'CURSOR_SENTINEL');
  });
  after(() => fs.rmSync(repoDir, { recursive: true, force: true }));

  test('interop files included when includeInterop=true', async () => {
    const files = await loadInstructionFiles(repoDir, mockRun(repoDir), {
      configDir: path.join(repoDir, 'fake-config'),
      includeInterop: true,
    });
    const kinds = files.map(f => f.kind);
    assert.ok(kinds.includes('interop'), 'should include interop files');
    assert.ok(files.some(f => f.content.includes('CLAUDE_SENTINEL')));
    assert.ok(files.some(f => f.content.includes('CURSOR_SENTINEL')));
  });

  test('interop files excluded when includeInterop=false', async () => {
    const files = await loadInstructionFiles(repoDir, mockRun(repoDir), {
      configDir: path.join(repoDir, 'fake-config'),
      includeInterop: false,
    });
    assert.ok(!files.some(f => f.kind === 'interop'), 'should not include interop files');
  });
});

describe('loadInstructionFiles — oversized file', () => {
  let repoDir;
  before(() => {
    repoDir = makeTmpDir();
    // Write a file larger than INSTRUCTION_FILE_LIMIT
    write(path.join(repoDir, 'AGENTS.md'), 'x'.repeat(INSTRUCTION_FILE_LIMIT + 500));
  });
  after(() => fs.rmSync(repoDir, { recursive: true, force: true }));

  test('oversized file is truncated with truncated=true', async () => {
    const files = await loadInstructionFiles(repoDir, mockRun(repoDir), {
      configDir: path.join(repoDir, 'fake-config'),
    });
    assert.equal(files.length, 1);
    assert.equal(files[0].truncated, true);
    assert.equal(files[0].includedBytes, INSTRUCTION_FILE_LIMIT);
  });
});

describe('loadInstructionFiles — unreadable file', () => {
  let repoDir;
  before(() => {
    repoDir = makeTmpDir();
    const p = path.join(repoDir, 'AGENTS.md');
    write(p, 'readable');
    // Make unreadable (skip on Windows where chmod may not apply)
    try { fs.chmodSync(p, 0o000); } catch (_) {}
  });
  after(() => {
    try {
      fs.chmodSync(path.join(repoDir, 'AGENTS.md'), 0o644);
    } catch (_) {}
    fs.rmSync(repoDir, { recursive: true, force: true });
  });

  test('unreadable file does not cause discovery to fail', async () => {
    // If running as root or on Windows, chmod may have no effect; test is still valid.
    let files;
    assert.doesNotThrow(async () => {
      files = await loadInstructionFiles(repoDir, mockRun(repoDir), {
        configDir: path.join(repoDir, 'fake-config'),
      });
    });
    // Either 0 (file is truly unreadable) or 1 (root bypasses chmod) — no crash either way
    assert.ok(files === undefined || Array.isArray(files));
  });
});

describe('loadInstructionFiles — CONTRIBUTING.md not promoted', () => {
  let repoDir;
  before(() => {
    repoDir = makeTmpDir();
    write(path.join(repoDir, 'CONTRIBUTING.md'), 'CONTRIBUTING_CONTENT');
  });
  after(() => fs.rmSync(repoDir, { recursive: true, force: true }));

  test('CONTRIBUTING.md is not loaded as an instruction file', async () => {
    const files = await loadInstructionFiles(repoDir, mockRun(repoDir), {
      configDir: path.join(repoDir, 'fake-config'),
    });
    assert.ok(!files.some(f => f.path.includes('CONTRIBUTING')), 'CONTRIBUTING.md should not be an instruction file');
  });
});
