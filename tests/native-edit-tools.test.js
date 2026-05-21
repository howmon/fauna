import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import path from 'path';
import { executeSelfTool } from '../self-tools.js';

// Mocks required by the broader self-tools module surface
vi.mock('../memory-store.js', () => ({
  remember: vi.fn(() => ({ ok: true })),
  recall: vi.fn(() => []),
  forget: vi.fn(() => ({ ok: true })),
}));
vi.mock('../project-manager.js', () => ({
  createProject: vi.fn(() => ({})),
  getProjectList: vi.fn(() => []),
}));

const mockContext = {
  getModels: () => [],
  getSettings: () => ({}),
  sendToRenderer: vi.fn(),
  sendNotification: vi.fn(),
};

describe('native edit tools — fs round-trip', () => {
  /** @type {string} */
  let tmpFile;

  beforeEach(() => {
    // Use literal /tmp so _resolveFaunaWritePath's allow-list accepts it
    // (os.tmpdir() on macOS returns /var/folders/... which is rejected).
    tmpFile = path.join('/tmp', `fauna-edit-test-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.txt`);
  });

  afterEach(() => {
    try { fs.unlinkSync(tmpFile); } catch (_) {}
  });

  describe('fauna_read_file', () => {
    it('reads full file content with metadata', () => {
      fs.writeFileSync(tmpFile, 'line one\nline two\nline three\n');
      const r = JSON.parse(executeSelfTool('fauna_read_file', { path: tmpFile }, mockContext));
      expect(r.ok).toBe(true);
      expect(r.path).toBe(tmpFile);
      expect(r.content).toContain('line two');
      expect(r.totalLines).toBe(4); // trailing newline → 4 split
      expect(r.bytes).toBeGreaterThan(0);
      expect(r.truncated).toBe(false);
    });

    it('slices by startLine/endLine', () => {
      fs.writeFileSync(tmpFile, 'a\nb\nc\nd\ne\n');
      const r = JSON.parse(executeSelfTool('fauna_read_file', { path: tmpFile, startLine: 2, endLine: 4 }, mockContext));
      expect(r.ok).toBe(true);
      expect(r.content).toBe('b\nc\nd');
    });

    it('truncates at maxBytes', () => {
      fs.writeFileSync(tmpFile, 'x'.repeat(5000));
      const r = JSON.parse(executeSelfTool('fauna_read_file', { path: tmpFile, maxBytes: 100 }, mockContext));
      expect(r.ok).toBe(true);
      expect(r.truncated).toBe(true);
      expect(r.content.length).toBe(100);
    });

    it('returns error when file is missing', () => {
      const r = JSON.parse(executeSelfTool('fauna_read_file', { path: tmpFile + '.nope' }, mockContext));
      expect(r.ok).toBe(false);
      expect(r.error).toMatch(/not found/i);
    });

    it('rejects paths outside HOME or /tmp', () => {
      const r = JSON.parse(executeSelfTool('fauna_read_file', { path: '/etc/passwd' }, mockContext));
      expect(r.ok).toBe(false);
      expect(r.error).toMatch(/outside allowed/i);
    });
  });

  describe('fauna_replace_string', () => {
    it('replaces a unique occurrence atomically', () => {
      fs.writeFileSync(tmpFile, 'hello world\nfoo bar\n');
      const r = JSON.parse(executeSelfTool('fauna_replace_string', { path: tmpFile, old_string: 'foo bar', new_string: 'FOO BAZ' }, mockContext));
      expect(r.ok).toBe(true);
      expect(fs.readFileSync(tmpFile, 'utf8')).toBe('hello world\nFOO BAZ\n');
    });

    it('refuses ambiguous (multi-match) old_string with OLD_STRING_AMBIGUOUS', () => {
      fs.writeFileSync(tmpFile, 'dup\ndup\n');
      const r = JSON.parse(executeSelfTool('fauna_replace_string', { path: tmpFile, old_string: 'dup', new_string: 'x' }, mockContext));
      expect(r.ok).toBe(false);
      expect(r.code).toBe('OLD_STRING_AMBIGUOUS');
      expect(r.occurrences).toBe(2);
      // file unchanged
      expect(fs.readFileSync(tmpFile, 'utf8')).toBe('dup\ndup\n');
    });

    it('returns OLD_STRING_NOT_FOUND when missing', () => {
      fs.writeFileSync(tmpFile, 'abc\n');
      const r = JSON.parse(executeSelfTool('fauna_replace_string', { path: tmpFile, old_string: 'zzz', new_string: 'x' }, mockContext));
      expect(r.ok).toBe(false);
      expect(r.code).toBe('OLD_STRING_NOT_FOUND');
    });

    it('rejects empty old_string', () => {
      fs.writeFileSync(tmpFile, 'abc\n');
      const r = JSON.parse(executeSelfTool('fauna_replace_string', { path: tmpFile, old_string: '', new_string: 'x' }, mockContext));
      expect(r.ok).toBe(false);
      expect(r.error).toMatch(/must not be empty/i);
    });
  });

  describe('read → replace → read round-trip', () => {
    it('verifies edits via the same toolset (Codex "Verify Before Done" pattern)', () => {
      fs.writeFileSync(tmpFile, 'const VERSION = "1.0.0";\nexport default VERSION;\n');

      // read
      const r1 = JSON.parse(executeSelfTool('fauna_read_file', { path: tmpFile }, mockContext));
      expect(r1.content).toContain('1.0.0');

      // replace
      const r2 = JSON.parse(executeSelfTool('fauna_replace_string', {
        path: tmpFile,
        old_string: 'const VERSION = "1.0.0";',
        new_string: 'const VERSION = "1.0.1";',
      }, mockContext));
      expect(r2.ok).toBe(true);

      // verify
      const r3 = JSON.parse(executeSelfTool('fauna_read_file', { path: tmpFile }, mockContext));
      expect(r3.content).toContain('1.0.1');
      expect(r3.content).not.toContain('1.0.0');
    });
  });
});
