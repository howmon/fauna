// Tests for lib/project-audit.js (P6).
//
// We exercise the pure helpers (parseAuditResponse, buildAuditPrompt,
// summariseProjectArchitecture, _fingerprint, _titleHash) against a
// scratch temp directory, then drive auditProject() end-to-end with
// project-manager mocked so we can inspect what got added to the backlog.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs   from 'node:fs';
import os   from 'node:os';
import path from 'node:path';

const _store = { projects: [] };

vi.mock('../project-manager.js', () => ({
  getProject: vi.fn(id => _store.projects.find(p => p.id === id) || null),
  listBacklog: vi.fn((id) => {
    const p = _store.projects.find(x => x.id === id);
    return p ? (p.backlog || []).slice() : [];
  }),
  addBacklogItem: vi.fn((id, item) => {
    const p = _store.projects.find(x => x.id === id);
    if (!p) return null;
    p.backlog = p.backlog || [];
    const it = { id: 'bk-' + (p.backlog.length + 1), ...item, createdAt: new Date().toISOString() };
    p.backlog.unshift(it);
    return it;
  }),
}));

const {
  walkProjectTree, summariseProjectArchitecture, buildAuditPrompt,
  parseAuditResponse, auditProject, __test,
} = await import('../lib/project-audit.js');

// ── Scratch dir helpers ──────────────────────────────────────────────────
let _tmp;
function _seedScratch(layout) {
  _tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'fauna-audit-'));
  for (const [rel, body] of Object.entries(layout)) {
    const full = path.join(_tmp, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, body);
  }
  return _tmp;
}
afterEach(() => {
  if (_tmp) { try { fs.rmSync(_tmp, { recursive: true, force: true }); } catch (_) {} }
  _tmp = null;
  _store.projects = [];
});

// ── walkProjectTree ──────────────────────────────────────────────────────
describe('walkProjectTree', () => {
  it('walks files and dirs, skipping junk', () => {
    const root = _seedScratch({
      'src/index.js': 'export default 1',
      'src/util.js': 'export function f(){}',
      'package.json': '{"name":"x"}',
      'node_modules/foo/index.js': 'noise',
      '.git/HEAD': 'ref',
      'dist/bundle.js': 'noise',
      'README.md': '# hi',
    });
    const r = walkProjectTree(root);
    const all = r.files.join('|');
    expect(r.files.length).toBeGreaterThanOrEqual(3);
    expect(all).toContain('src/index.js');
    expect(all).toContain('package.json');
    expect(all).toContain('README.md');
    expect(all).not.toContain('node_modules');
    expect(all).not.toContain('.git');
    expect(all).not.toContain('dist');
  });

  it('respects maxDepth', () => {
    const root = _seedScratch({
      'a.js': '1',
      'b/c.js': '2',
      'b/c/d/deep.js': '3',
    });
    const r = walkProjectTree(root, { maxDepth: 1 });
    const all = r.files.join('|');
    expect(all).toContain('a.js');
    // path.sep aware
    expect(all).toContain('c.js');
    expect(all).not.toContain('deep.js');
  });

  it('respects maxFiles', () => {
    const layout = {};
    for (let i = 0; i < 50; i++) layout['f' + i + '.js'] = String(i);
    const root = _seedScratch(layout);
    const r = walkProjectTree(root, { maxFiles: 10 });
    expect(r.files.length).toBe(10);
  });
});

// ── summariseProjectArchitecture ─────────────────────────────────────────
describe('summariseProjectArchitecture', () => {
  it('errors when project has no rootPath', () => {
    const r = summariseProjectArchitecture({ id: 'p1', name: 'P' });
    expect(r.ok).toBe(false);
  });
  it('returns a summary with hint files', () => {
    const root = _seedScratch({
      'package.json': '{"name":"my-pkg","scripts":{"test":"vitest"}}',
      'README.md': '# Project\n\nThis project does things.',
      'src/index.js': 'export default 1',
      'src/lib/util.js': 'export const x = 1;',
      'src/lib/api.js': 'export const y = 2;',
    });
    const r = summariseProjectArchitecture({ id: 'p1', name: 'P', rootPath: root });
    expect(r.ok).toBe(true);
    expect(r.fileCount).toBeGreaterThan(0);
    expect(Object.keys(r.hintBlobs)).toEqual(expect.arrayContaining(['package.json', 'README.md']));
    expect(r.hintBlobs['package.json']).toContain('my-pkg');
    expect(r.topDirs.find(([d]) => d === 'src')).toBeTruthy();
    expect(r.extensions.find(([e]) => e === '.js')).toBeTruthy();
  });
});

// ── buildAuditPrompt ────────────────────────────────────────────────────
describe('buildAuditPrompt', () => {
  it('includes layout, files, hints and existing-backlog dedup block', () => {
    _store.projects.push({
      id: 'p1', name: 'Proj', description: 'A test project',
      backlog: [{ id: 'b1', title: 'Already-tracked thing', column: 'todo' }],
    });
    const summary = {
      rootPath: '/x', fileCount: 5, dirCount: 1,
      topDirs: [['src', 3], ['tests', 2]],
      extensions: [['.js', 4], ['.json', 1]],
      hintBlobs: { 'package.json': '{"name":"q"}' },
      sampleFiles: [],
    };
    const prompt = buildAuditPrompt(_store.projects[0], summary, { maxProposals: 4 });
    expect(prompt).toContain('Proj');
    expect(prompt).toContain('≤ 4');
    expect(prompt).toContain('src');
    expect(prompt).toContain('Already-tracked thing');
    expect(prompt).toContain('package.json');
    expect(prompt).toContain('JSON array');
  });
});

// ── parseAuditResponse ──────────────────────────────────────────────────
describe('parseAuditResponse', () => {
  it('parses a plain JSON array', () => {
    const r = parseAuditResponse(JSON.stringify([
      { title: 'Add CI', body: 'why', acceptance: 'a', priority: 'p1', tags: ['ci'] },
    ]));
    expect(r).toHaveLength(1);
    expect(r[0].title).toBe('Add CI');
    expect(r[0].priority).toBe('p1');
  });
  it('strips ```json fences', () => {
    const raw = '```json\n[{"title":"X"}]\n```';
    const r = parseAuditResponse(raw);
    expect(r).toHaveLength(1);
    expect(r[0].title).toBe('X');
    expect(r[0].priority).toBe('p2'); // default
  });
  it('tolerates leading/trailing prose', () => {
    const raw = 'Sure, here you go:\n[{"title":"Y"}]\nLet me know if you need more.';
    const r = parseAuditResponse(raw);
    expect(r).toHaveLength(1);
    expect(r[0].title).toBe('Y');
  });
  it('returns [] on garbage', () => {
    expect(parseAuditResponse('not even close')).toEqual([]);
    expect(parseAuditResponse('')).toEqual([]);
    expect(parseAuditResponse(null)).toEqual([]);
  });
  it('rejects bad priority and defaults', () => {
    const r = parseAuditResponse('[{"title":"Z","priority":"banana"}]');
    expect(r[0].priority).toBe('p2');
  });
});

// ── _titleHash ──────────────────────────────────────────────────────────
describe('_titleHash', () => {
  it('normalises whitespace and case', () => {
    expect(__test.titleHash('Hello World')).toBe(__test.titleHash('  hello   world '));
    expect(__test.titleHash('Hello World')).not.toBe(__test.titleHash('Hello Universe'));
  });
});

// ── auditProject end-to-end ─────────────────────────────────────────────
describe('auditProject', () => {
  beforeEach(() => { _store.projects = []; });

  it('returns dryRun when no aiCaller passed', async () => {
    const root = _seedScratch({ 'package.json': '{"name":"a"}' });
    _store.projects.push({ id: 'p1', name: 'P', rootPath: root, backlog: [] });
    const r = await auditProject('p1');
    expect(r.ok).toBe(true);
    expect(r.dryRun).toBe(true);
    expect(r.added).toEqual([]);
  });

  it('errors when project has no rootPath', async () => {
    _store.projects.push({ id: 'p1', name: 'P', backlog: [] });
    const r = await auditProject('p1', { aiCaller: async () => '[]' });
    expect(r.ok).toBe(false);
  });

  it('errors when project not found', async () => {
    const r = await auditProject('nope', { aiCaller: async () => '[]' });
    expect(r.ok).toBe(false);
  });

  it('adds proposals to the backlog', async () => {
    const root = _seedScratch({ 'package.json': '{"name":"a"}', 'src/x.js': '1' });
    _store.projects.push({ id: 'p1', name: 'P', rootPath: root, backlog: [] });
    const aiCaller = vi.fn(async () => JSON.stringify([
      { title: 'Add tests',     body: 'no tests yet', priority: 'p1', tags: ['test'] },
      { title: 'Add CI',        body: 'no CI yet',    priority: 'p2', tags: ['ci'] },
    ]));
    const r = await auditProject('p1', { aiCaller });
    expect(r.ok).toBe(true);
    expect(r.added).toHaveLength(2);
    expect(_store.projects[0].backlog).toHaveLength(2);
    expect(_store.projects[0].backlog[0].source).toBe('reflection');
    expect(_store.projects[0].backlog[0].column).toBe('backlog');
    expect(_store.projects[0].backlog[0].tags).toContain('audit');
  });

  it('dedups by title hash against existing backlog', async () => {
    const root = _seedScratch({ 'package.json': '{"name":"a"}' });
    _store.projects.push({ id: 'p1', name: 'P', rootPath: root, backlog: [
      { id: 'b1', title: 'Add Tests' },         // case-insensitive match
    ] });
    const aiCaller = vi.fn(async () => JSON.stringify([
      { title: 'add tests', body: 'dup' },
      { title: 'Fresh idea', body: 'new' },
    ]));
    const r = await auditProject('p1', { aiCaller });
    expect(r.ok).toBe(true);
    expect(r.added.map(a => a.title)).toEqual(['Fresh idea']);
    expect(r.skipped).toContain('add tests');
  });

  it('returns ok with note when model output is unparseable', async () => {
    const root = _seedScratch({ 'package.json': '{"name":"a"}' });
    _store.projects.push({ id: 'p1', name: 'P', rootPath: root, backlog: [] });
    const aiCaller = vi.fn(async () => 'lol I forgot what you asked');
    const r = await auditProject('p1', { aiCaller });
    expect(r.ok).toBe(true);
    expect(r.added).toEqual([]);
    expect(r.note).toMatch(/no usable proposals/);
  });

  it('reports failure on aiCaller exception', async () => {
    const root = _seedScratch({ 'package.json': '{"name":"a"}' });
    _store.projects.push({ id: 'p1', name: 'P', rootPath: root, backlog: [] });
    const aiCaller = vi.fn(async () => { throw new Error('upstream timeout'); });
    const r = await auditProject('p1', { aiCaller });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/upstream timeout/);
  });
});
