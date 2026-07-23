/**
 * lib/instruction-files.js
 *
 * Helpers for discovering, loading, and ordering repository coding
 * instruction files (AGENTS.md, .github/copilot-instructions.md, etc.)
 * so they can be injected into the model-visible prompt.
 *
 * Extracted from server.js to be independently testable.
 */

import fs from 'fs';
import path from 'path';
import os from 'os';

// ── Limits ────────────────────────────────────────────────────────────────
export const INSTRUCTION_FILE_LIMIT = 24 * 1024;   // 24 KB per file
export const INSTRUCTION_TOTAL_LIMIT = 64 * 1024;  // 64 KB total

// ── FS timeout ────────────────────────────────────────────────────────────
// DLP (Data Loss Prevention) agents on macOS can deadlock while authorizing
// EndpointSecurity `open` events.  When that happens every fs.promises call
// blocks a libuv thread-pool worker indefinitely.  Racing each operation
// against a hard timeout lets the JS caller bail out while the OS thread
// eventually unblocks on its own.
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

// ── Internal helpers ──────────────────────────────────────────────────────

export async function _safeReadInstructionFile(absPath, remainingBytes) {
  try {
    const stat = await _fsWithTimeout(fs.promises.stat(absPath));
    if (!stat.isFile()) return null;
    if (stat.size === 0) return null;
    const maxBytes = Math.max(0, Math.min(INSTRUCTION_FILE_LIMIT, remainingBytes));
    if (maxBytes <= 0) return null;
    const bufLen = Math.min(stat.size, maxBytes);
    const buffer = Buffer.alloc(bufLen);
    const fd = await _fsWithTimeout(fs.promises.open(absPath, 'r'));
    try { await fd.read(buffer, 0, bufLen, 0); }
    finally { await fd.close(); }
    return {
      content: buffer.toString('utf8'),
      bytes: stat.size,
      includedBytes: buffer.length,
      truncated: stat.size > buffer.length,
    };
  } catch (_) {
    return null;
  }
}

export function _isPathInside(parent, child) {
  const rel = path.relative(parent, child);
  return rel === '' || (!!rel && !rel.startsWith('..') && !path.isAbsolute(rel));
}

export function _realPathOrResolve(p) {
  try { return fs.realpathSync.native ? fs.realpathSync.native(p) : fs.realpathSync(p); }
  catch (_) { return path.resolve(p); }
}

// ── Main API ──────────────────────────────────────────────────────────────

/**
 * Discover and load instruction files for a workspace.
 *
 * @param {string} workDir  Absolute path to the working directory.
 * @param {function} run    Async (cmd: string) => string shell runner.
 * @param {object}  opts
 * @param {boolean} [opts.includeInterop=true]  Include CLAUDE.md / .cursorrules.
 * @param {string}  [opts.configDir]            Override config dir (default ~/.config/fauna).
 * @param {string}  [opts.altConfigDir]         Optional second global config dir (e.g. ~/.config/copilot-chat).
 *
 * @returns {Promise<Array<{
 *   path: string, absPath: string, kind: string, scope: string,
 *   priority: number, content: string, bytes: number,
 *   includedBytes: number, truncated: boolean
 * }>>}
 */
export async function loadInstructionFiles(workDir, run, { includeInterop = true, configDir, altConfigDir } = {}) {
  const records = [];
  const seen = new Set();
  let totalIncluded = 0;

  const absWorkDir = _realPathOrResolve(workDir);
  const gitRootRaw = await run('git rev-parse --show-toplevel 2>/dev/null');
  const repoRoot = gitRootRaw ? _realPathOrResolve(gitRootRaw) : absWorkDir;
  const cwdForInstructions = _isPathInside(repoRoot, absWorkDir) ? absWorkDir : repoRoot;

  const addFile = async (absPath, relPath, kind, scope, priority) => {
    absPath = path.resolve(absPath);
    const key = absPath.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    const read = await _safeReadInstructionFile(absPath, INSTRUCTION_TOTAL_LIMIT - totalIncluded);
    if (!read) return;
    totalIncluded += read.includedBytes;
    records.push({
      path: relPath,
      absPath,
      kind,
      scope,
      priority,
      content: read.content,
      bytes: read.bytes,
      includedBytes: read.includedBytes,
      truncated: read.truncated,
    });
  };

  const faunaConfigDir = configDir || path.join(os.homedir(), '.config', 'fauna');
  await addFile(path.join(faunaConfigDir, 'AGENTS.md'),
    path.join('~', '.config', 'fauna', 'AGENTS.md'), 'agents', 'global', 190);

  // Optional second global config dir (e.g. ~/.config/copilot-chat), added only
  // when it differs from the primary fauna config dir.
  if (altConfigDir && path.resolve(altConfigDir) !== path.resolve(faunaConfigDir)) {
    await addFile(path.join(altConfigDir, 'AGENTS.md'),
      path.join('~', '.config', path.basename(altConfigDir), 'AGENTS.md'),
      'agents', 'global', 200);
  }

  await addFile(path.join(repoRoot, 'AGENTS.md'),
    path.relative(repoRoot, path.join(repoRoot, 'AGENTS.md')) || 'AGENTS.md',
    'agents', 'repo', 300);

  if (_isPathInside(repoRoot, cwdForInstructions)) {
    let cursor = repoRoot;
    const relParts = path.relative(repoRoot, cwdForInstructions).split(path.sep).filter(Boolean);
    for (const part of relParts) {
      cursor = path.join(cursor, part);
      await addFile(path.join(cursor, 'AGENTS.md'),
        path.relative(repoRoot, path.join(cursor, 'AGENTS.md')),
        'agents', 'nested', 320);
    }
  }

  await addFile(path.join(repoRoot, '.github', 'copilot-instructions.md'),
    '.github/copilot-instructions.md', 'copilot', 'repo', 340);

  if (includeInterop) {
    await addFile(path.join(repoRoot, 'CLAUDE.md'), 'CLAUDE.md', 'interop', 'repo', 360);
    await addFile(path.join(repoRoot, '.cursorrules'), '.cursorrules', 'interop', 'repo', 370);
  }

  return records.sort((a, b) => a.priority - b.priority || a.path.localeCompare(b.path));
}
