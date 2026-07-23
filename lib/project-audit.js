// ── Project Audit ────────────────────────────────────────────────────────
//
// Walks a project's rootPath (depth-limited), summarises its architecture
// into a compact description, prompts the model for up to N concrete
// feature/refactor proposals, and inserts them into the project backlog
// (column='backlog', source='reflection', assignee=null) for a human to
// triage.
//
// Trigger:
//   - On demand via the `fauna_project_audit` self-tool or /api/projects/:id/audit
//
// Dedup: backlog items with `source==='reflection'` whose title hash
// matches a previous proposal are skipped. The hash uses a normalised
// (lowercased + collapsed-whitespace) form so trivial wording changes
// still collide.
//
// No background scanning. We never walk the file tree unless an audit is
// explicitly requested. Heavy lifting (the LLM call) is gated on a
// caller-supplied `aiCaller` function — pass null to do a "dry run"
// summary-only audit.

import fs   from 'fs';
import path from 'path';
import crypto from 'crypto';
import {
  getProject, listBacklog, addBacklogItem,
} from '../project-manager.js';

// ── FS timeout ────────────────────────────────────────────────────────────
// DLP agents on macOS can deadlock while authorizing EndpointSecurity open
// events, pinning libuv thread-pool workers indefinitely.  Racing each FS
// call against a 5-second timeout lets callers bail out gracefully.
const FS_TIMEOUT_MS = 5_000;
function _fsWithTimeout(promise) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(
      () => reject(Object.assign(new Error('FS operation timed out (DLP stall)'), { code: 'FS_TIMEOUT' })),
      FS_TIMEOUT_MS,
    );
    promise.then(v => { clearTimeout(t); resolve(v); }, e => { clearTimeout(t); reject(e); });
  });
}

const MAX_FILES_LISTED       = 600;
const MAX_DEPTH              = 3;
const MAX_README_BYTES       = 8_000;
const MAX_PACKAGE_JSON_BYTES = 4_000;
const DEFAULT_MAX_PROPOSALS  = 5;

// Skip these no matter what — they bloat the summary with junk.
const SKIP_DIRS = new Set([
  'node_modules', '.git', '.next', '.cache', '.turbo', 'dist', 'build',
  'out', 'coverage', '.vscode', '.idea', '__pycache__', '.venv', 'venv',
  'target', '.gradle', '.DS_Store', 'tmp', 'temp',
]);

// Files of any of these names are read in full as architecture hints.
const HINT_FILES = [
  'package.json', 'pyproject.toml', 'Cargo.toml', 'go.mod', 'pom.xml',
  'composer.json', 'requirements.txt', 'Gemfile',
  'README.md', 'readme.md', 'README', 'AGENTS.md',
  'tsconfig.json', 'jsconfig.json', 'vite.config.js', 'next.config.js',
];

// ── File tree walk ───────────────────────────────────────────────────────
export async function walkProjectTree(root, opts = {}) {
  const maxFiles = Number(opts.maxFiles) || MAX_FILES_LISTED;
  const maxDepth = Number(opts.maxDepth) || MAX_DEPTH;
  const files = [];
  const dirs  = [];
  async function _walk(dir, depth) {
    if (depth > maxDepth) return;
    if (files.length >= maxFiles) return;
    let entries;
    try { entries = await _fsWithTimeout(fs.promises.readdir(dir, { withFileTypes: true })); }
    catch (_) { return; }
    for (const ent of entries) {
      if (SKIP_DIRS.has(ent.name)) continue;
      if (ent.name.startsWith('.') && ent.name !== '.env.example') continue;
      const full = path.join(dir, ent.name);
      const rel  = path.relative(root, full);
      if (ent.isDirectory()) {
        dirs.push(rel);
        await _walk(full, depth + 1);
      } else if (ent.isFile()) {
        files.push(rel);
        if (files.length >= maxFiles) return;
      }
    }
  }
  await _walk(root, 0);
  return { files, dirs };
}

// Read up to maxBytes of a file safely. Returns '' on any failure.
async function _readClipped(p, maxBytes) {
  try {
    const stat = await _fsWithTimeout(fs.promises.stat(p));
    if (!stat.isFile()) return '';
    const len = Math.min(stat.size, maxBytes);
    const buf = Buffer.alloc(len);
    const fd = await _fsWithTimeout(fs.promises.open(p, 'r'));
    try {
      await fd.read(buf, 0, len, 0);
      let txt = buf.toString('utf8');
      if (stat.size > maxBytes) txt += '\n…(truncated)';
      return txt;
    } finally { await fd.close(); }
  } catch (_) { return ''; }
}

// Group files by top-level folder + extension to form a coarse fingerprint.
function _fingerprint(files) {
  const byTopDir = Object.create(null);
  const byExt    = Object.create(null);
  for (const f of files) {
    const segs = f.split(path.sep);
    const top  = segs.length > 1 ? segs[0] : '(root)';
    byTopDir[top] = (byTopDir[top] || 0) + 1;
    const ext = path.extname(f).toLowerCase() || '(none)';
    byExt[ext] = (byExt[ext] || 0) + 1;
  }
  return { byTopDir, byExt };
}

// ── Architecture summary ─────────────────────────────────────────────────
export async function summariseProjectArchitecture(project) {
  if (!project || !project.rootPath) {
    return { ok: false, error: 'project has no rootPath' };
  }
  const root = project.rootPath;
  try {
    const rootStat = await _fsWithTimeout(fs.promises.stat(root));
    if (!rootStat.isDirectory()) throw new Error('not a dir');
  } catch (e) { return { ok: false, error: 'rootPath not accessible: ' + e.message }; }

  const { files, dirs } = await walkProjectTree(root);
  const fp = _fingerprint(files);

  // Pull hint files (package.json etc.) only when present at depths ≤ 2.
  const hintBlobs = {};
  for (const name of HINT_FILES) {
    for (const f of files) {
      if (path.basename(f) !== name) continue;
      if (f.split(path.sep).length > 3) continue;
      const max = name.toLowerCase().includes('readme') ? MAX_README_BYTES : MAX_PACKAGE_JSON_BYTES;
      const txt = await _readClipped(path.join(root, f), max);
      if (txt) hintBlobs[f] = txt;
      if (Object.keys(hintBlobs).length >= 8) break;
    }
    if (Object.keys(hintBlobs).length >= 8) break;
  }

  return {
    ok: true,
    rootPath: root,
    fileCount: files.length,
    dirCount: dirs.length,
    topDirs: Object.entries(fp.byTopDir).sort((a, b) => b[1] - a[1]).slice(0, 20),
    extensions: Object.entries(fp.byExt).sort((a, b) => b[1] - a[1]).slice(0, 15),
    hintBlobs,
    sampleFiles: files.slice(0, 80),
  };
}

// ── Prompt construction ──────────────────────────────────────────────────
export function buildAuditPrompt(project, summary, opts = {}) {
  const maxProposals = Number(opts.maxProposals) || DEFAULT_MAX_PROPOSALS;
  const existingTitles = (listBacklog(project.id, { limit: 200 }) || [])
    .map(it => it.title).filter(Boolean).slice(0, 60);

  const lines = [];
  lines.push('You are an experienced engineering reviewer auditing a codebase.');
  lines.push('Given the project summary below, propose ≤ ' + maxProposals + ' high-value, *concrete* and *actionable* work items.');
  lines.push('Each item should be:');
  lines.push('  • a new feature, a refactor that pays off soon, OR a missing safety net (tests, lint, CI, docs)');
  lines.push('  • specific enough that an engineer could start tomorrow');
  lines.push('  • NOT a duplicate of any title in the "Existing backlog" list');
  lines.push('');
  lines.push('## Project');
  lines.push('Name: ' + project.name);
  if (project.description) lines.push('Description: ' + project.description);
  lines.push('Root: ' + summary.rootPath);
  lines.push('Files: ' + summary.fileCount + ' across ' + summary.dirCount + ' folders');
  lines.push('');
  lines.push('## Top-level layout');
  for (const [d, n] of summary.topDirs) lines.push('  ' + d + '  (' + n + ' files)');
  lines.push('');
  lines.push('## File extensions');
  lines.push('  ' + summary.extensions.map(([e, n]) => e + ':' + n).join(', '));
  lines.push('');
  if (Object.keys(summary.hintBlobs).length) {
    lines.push('## Key files');
    for (const [name, txt] of Object.entries(summary.hintBlobs)) {
      lines.push('### ' + name);
      lines.push('```');
      lines.push(txt);
      lines.push('```');
    }
  }
  if (existingTitles.length) {
    lines.push('## Existing backlog (do not duplicate)');
    for (const t of existingTitles) lines.push('  - ' + t);
    lines.push('');
  }
  lines.push('## Output format');
  lines.push('Return ONLY a JSON array, no prose. Each entry has:');
  lines.push('  {');
  lines.push('    "title":      "<≤80 chars>",');
  lines.push('    "body":       "<2-6 sentences explaining the why and the rough approach>",');
  lines.push('    "acceptance": "<1-3 short bullet points of done-criteria, separated by \\n>",');
  lines.push('    "priority":   "p0"|"p1"|"p2"|"p3",');
  lines.push('    "tags":       ["feature"|"refactor"|"test"|"docs"|"ci", ...]');
  lines.push('  }');
  lines.push('Do not wrap the array in any markdown fence. Just the raw JSON.');
  return lines.join('\n');
}

// ── Output parsing ───────────────────────────────────────────────────────
export function parseAuditResponse(raw) {
  if (!raw || typeof raw !== 'string') return [];
  let txt = raw.trim();
  // Strip ```json fences if the model ignored instructions.
  txt = txt.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  // Find the first '[' and last ']' to tolerate leading/trailing prose.
  const i = txt.indexOf('[');
  const j = txt.lastIndexOf(']');
  if (i === -1 || j === -1 || j < i) return [];
  const slice = txt.slice(i, j + 1);
  let arr;
  try { arr = JSON.parse(slice); }
  catch (_) { return []; }
  if (!Array.isArray(arr)) return [];
  return arr.filter(x => x && typeof x === 'object' && typeof x.title === 'string')
    .map(x => ({
      title:      String(x.title).slice(0, 200),
      body:       String(x.body || '').slice(0, 4000),
      acceptance: String(x.acceptance || '').slice(0, 4000),
      priority:   ['p0', 'p1', 'p2', 'p3'].includes(x.priority) ? x.priority : 'p2',
      tags:       Array.isArray(x.tags) ? x.tags.slice(0, 6).map(String) : [],
    }));
}

// ── Title hash for dedup ─────────────────────────────────────────────────
function _titleHash(title) {
  return crypto.createHash('sha1')
    .update(String(title).toLowerCase().replace(/\s+/g, ' ').trim())
    .digest('hex')
    .slice(0, 12);
}

// Set of hashes for items already in the backlog marked as reflection.
function _existingReflectionHashes(projectId) {
  const items = listBacklog(projectId, { limit: 500 }) || [];
  const out = new Set();
  for (const it of items) {
    if (!it || !it.title) continue;
    out.add(_titleHash(it.title));
  }
  return out;
}

// ── Top-level: run audit for a single project ────────────────────────────
export async function auditProject(projectId, { aiCaller, maxProposals } = {}) {
  const project = getProject(projectId);
  if (!project) return { ok: false, error: 'project not found' };
  if (!project.rootPath) {
    return { ok: false, error: 'project has no rootPath — set one in Project Settings before running an audit' };
  }
  const summary = await summariseProjectArchitecture(project);
  if (!summary.ok) return summary;

  if (typeof aiCaller !== 'function') {
    return { ok: true, dryRun: true, summary, added: [] };
  }

  const prompt = buildAuditPrompt(project, summary, { maxProposals });
  let raw;
  try { raw = await aiCaller(prompt); }
  catch (e) { return { ok: false, error: 'LLM call failed: ' + (e?.message || e), summary }; }
  const proposals = parseAuditResponse(raw);
  if (!proposals.length) {
    return { ok: true, summary, added: [], rawResponse: String(raw || '').slice(0, 500),
      note: 'no usable proposals returned' };
  }

  const existing = _existingReflectionHashes(projectId);
  const added = [];
  const skipped = [];
  for (const prop of proposals) {
    const h = _titleHash(prop.title);
    if (existing.has(h)) { skipped.push(prop.title); continue; }
    const item = addBacklogItem(projectId, {
      title:      prop.title,
      body:       prop.body,
      acceptance: prop.acceptance,
      priority:   prop.priority,
      tags:       Array.from(new Set([...prop.tags, 'audit'])),
      source:     'reflection',
      column:     'backlog',     // human reviews before promoting to todo
      assignee:   null,
    });
    if (item) {
      added.push({ id: item.id, title: item.title, priority: item.priority });
      existing.add(h);
    }
  }
  return { ok: true, summary, added, skipped };
}

// ── Test hooks ───────────────────────────────────────────────────────────
export const __test = {
  fingerprint: _fingerprint,
  readClipped: _readClipped,
  titleHash: _titleHash,
};
