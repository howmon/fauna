// server/routes/agent-sandbox-files.js
//
// Filesystem-mutation routes for the agent sandbox + AutoRecovery checkpoints
// + simple read helpers. All write paths gate through the permission guard
// and AutoRecovery via shared helpers in server/lib/write-helpers.js.
//
// Routes:
//   POST   /api/write-file           — overwrite a file (JSON body)
//   PUT    /api/write-file-stream    — overwrite a file (streamed body)
//   POST   /api/write-files/check    — preflight a bulk write plan
//   POST   /api/write-files          — commit a bulk write plan (with rollback)
//   POST   /api/append-file          — append content to a file
//   POST   /api/replace-string       — replace first occurrence of a string
//   POST   /api/apply-patch          — apply a VS Code apply_patch text
//   POST   /api/apply-patch/check    — preflight an apply_patch text
//   GET    /api/checkpoints          — list AutoRecovery checkpoints for a file
//   DELETE /api/checkpoints          — clear AutoRecovery checkpoints
//   POST   /api/restore-checkpoint   — restore a file from a checkpoint
//   POST   /api/read-file            — read a file's contents
//   GET    /api/read-image           — read an image, resize+JPEG to base64
//
// Factory: registerAgentSandboxFileRoutes(app)

import fs from 'fs';
import os from 'os';
import path from 'path';
import crypto from 'crypto';
import { performance } from 'perf_hooks';
import { exec as _exec } from 'child_process';

import { RECOVERY_DIR } from '../copilot/auth.js';
import {
  resolvePath, atomicWriteFile, checkpointFile,
  getMutationContext, assertWriteAllowed, sendMutationError,
} from '../lib/write-helpers.js';

const IS_WIN = process.platform === 'win32';

// ── Bulk write plan helpers ────────────────────────────────────────────────
function _sha256(buffer) {
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

function _summarizeWritePlan(plan) {
  return plan.map(op => ({
    path: op.path,
    op: op.op,
    bytes: op.bytes,
    lines: op.lines,
    sha256: op.sha256,
    existed: op.existed,
  }));
}

function _buildWriteFilesPlan(body = {}, context) {
  const { cwd, files } = body;
  if (!Array.isArray(files) || files.length === 0) throw new Error('files array required');
  const expectedCount = body.expected_file_count ?? body.expectedFileCount;
  if (expectedCount != null && Number(expectedCount) !== files.length) {
    throw new Error('Expected ' + expectedCount + ' files, received ' + files.length);
  }
  const seen = new Set();
  const plan = [];
  for (const item of files) {
    if (!item || !item.path) throw new Error('Each file entry requires path');
    if (item.content === undefined) throw new Error('Missing content for ' + item.path);
    const abs = resolvePath(String(item.path), cwd);
    assertWriteAllowed(abs, context);
    if (seen.has(abs)) throw new Error('Duplicate write target in plan: ' + abs);
    seen.add(abs);

    const existed = fs.existsSync(abs);
    if (item.ignoreIfExists && existed) {
      plan.push({ path: abs, op: 'skip', bytes: 0, lines: 0, sha256: null, existed });
      continue;
    }
    if (item.overwrite === false && existed && !item.append) {
      throw new Error('Refusing to overwrite existing file: ' + abs);
    }

    const encoding = item.encoding || 'utf8';
    let finalContent = String(item.content ?? '');
    if (item.append && existed) finalContent = fs.readFileSync(abs, encoding) + finalContent;

    const finalBuffer = Buffer.from(finalContent, encoding);
    const sha256 = _sha256(finalBuffer);
    const bytes = finalBuffer.length;
    const lines = finalContent.length ? finalContent.split('\n').length : 0;
    if (item.sha256 && item.sha256 !== sha256) {
      throw new Error('sha256 mismatch for ' + abs + ': expected ' + item.sha256 + ', got ' + sha256);
    }
    if (item.minBytes != null && bytes < Number(item.minBytes)) {
      throw new Error('Content for ' + abs + ' is too short: ' + bytes + ' bytes < ' + item.minBytes);
    }
    if (item.minLines != null && lines < Number(item.minLines)) {
      throw new Error('Content for ' + abs + ' is too short: ' + lines + ' lines < ' + item.minLines);
    }
    if (body.reject_empty !== false && bytes === 0) throw new Error('Refusing to write empty file: ' + abs);

    plan.push({ path: abs, op: item.append ? 'append' : 'write', buffer: finalBuffer, bytes, lines, sha256, existed });
  }
  return plan;
}

function _commitWriteFilesPlan(plan) {
  const tx = crypto.randomBytes(6).toString('hex');
  const staged = [];
  const backups = [];
  try {
    for (const op of plan) {
      if (op.op === 'skip') continue;
      fs.mkdirSync(path.dirname(op.path), { recursive: true });
      if (op.existed) {
        checkpointFile(op.path);
        const backup = op.path + '.~fauna-bak-' + process.pid + '-' + tx;
        fs.copyFileSync(op.path, backup);
        backups.push({ path: op.path, backup, existed: true });
      } else {
        backups.push({ path: op.path, backup: null, existed: false });
      }
      const tmp = op.path + '.~fauna-plan-' + process.pid + '-' + tx;
      fs.writeFileSync(tmp, op.buffer);
      const stagedHash = _sha256(fs.readFileSync(tmp));
      if (stagedHash !== op.sha256) throw new Error('Staged checksum mismatch for ' + op.path);
      staged.push({ path: op.path, tmp });
    }

    for (const item of staged) {
      fs.renameSync(item.tmp, item.path);
    }

    for (const b of backups) {
      if (b.backup) { try { fs.unlinkSync(b.backup); } catch (_) {} }
    }
    return _summarizeWritePlan(plan);
  } catch (e) {
    for (const item of staged) {
      try { if (fs.existsSync(item.tmp)) fs.unlinkSync(item.tmp); } catch (_) {}
    }
    for (const b of backups.reverse()) {
      try {
        if (b.existed && b.backup && fs.existsSync(b.backup)) fs.copyFileSync(b.backup, b.path);
        else if (!b.existed && fs.existsSync(b.path)) fs.unlinkSync(b.path);
      } catch (_) {}
      try { if (b.backup) fs.unlinkSync(b.backup); } catch (_) {}
    }
    e.message = 'Write plan failed and rollback was attempted: ' + e.message;
    throw e;
  }
}

// ── apply_patch helpers ────────────────────────────────────────────────────
function _isFileOp(line) {
  return /^\*\*\* (Add File|Delete File|Update File|End Patch)/.test(line.trim());
}

function _applyHunk(fileContent, hunkLines) {
  const searchLines  = [];
  const replaceLines = [];

  for (const line of hunkLines) {
    if (line === '*** End of File') continue;
    if (line.length === 0) continue;
    const prefix = line[0];
    const text   = line.slice(1);
    if (prefix === ' ')      { searchLines.push(text);  replaceLines.push(text); }
    else if (prefix === '-') { searchLines.push(text); }
    else if (prefix === '+') { replaceLines.push(text); }
  }

  if (searchLines.length === 0 && replaceLines.length === 0) return fileContent;

  const searchStr  = searchLines.join('\n');
  const replaceStr = replaceLines.join('\n');

  if (fileContent.includes(searchStr)) {
    const idx = fileContent.indexOf(searchStr);
    return fileContent.slice(0, idx) + replaceStr + fileContent.slice(idx + searchStr.length);
  }
  const searchCRLF = searchLines.join('\r\n');
  if (fileContent.includes(searchCRLF)) {
    const idx = fileContent.indexOf(searchCRLF);
    return fileContent.slice(0, idx) + replaceStr + fileContent.slice(idx + searchCRLF.length);
  }
  throw new Error('Hunk context not found in file:\n' + JSON.stringify(searchStr.slice(0, 200)));
}

function _summarizePatchPlan(plan) {
  return plan.map(op => ({ path: op.path, from: op.from, op: op.op, bytes: op.bytes }));
}

function _buildPatchPlan(patchText, cwd, context) {
  const lines   = patchText.split('\n');
  const plan = [];
  const touchedPaths = new Set();
  let i = 0;

  function assertUniquePatchTarget(targetPath) {
    if (touchedPaths.has(targetPath)) {
      throw new Error('Duplicate patch target: ' + targetPath + ' — combine all hunks for a file under one Update File/Add File/Delete File section');
    }
    touchedPaths.add(targetPath);
  }

  while (i < lines.length && !lines[i].trim().startsWith('*** Begin Patch')) i++;
  if (i >= lines.length) throw new Error('"*** Begin Patch" not found');
  i++;

  while (i < lines.length) {
    const line = lines[i].trim();
    if (line.startsWith('*** End Patch')) break;

    if (line.startsWith('*** Add File: ')) {
      const filePath = resolvePath(line.slice('*** Add File: '.length).trim(), cwd);
      assertWriteAllowed(filePath, context);
      assertUniquePatchTarget(filePath);
      if (fs.existsSync(filePath)) throw new Error('Add File target already exists: ' + filePath);
      i++;
      const contentLines = [];
      while (i < lines.length && !_isFileOp(lines[i])) {
        const l = lines[i];
        if (l.startsWith('+'))      contentLines.push(l.slice(1));
        else if (l.startsWith(' ')) contentLines.push(l.slice(1));
        i++;
      }
      const body = contentLines.join('\n');
      plan.push({ path: filePath, op: 'add', content: body, bytes: Buffer.byteLength(body) });

    } else if (line.startsWith('*** Delete File: ')) {
      const filePath = resolvePath(line.slice('*** Delete File: '.length).trim(), cwd);
      assertWriteAllowed(filePath, context);
      assertUniquePatchTarget(filePath);
      if (!fs.existsSync(filePath)) throw new Error('File not found: ' + filePath);
      plan.push({ path: filePath, op: 'delete' });
      i++;

    } else if (line.startsWith('*** Update File: ')) {
      const origPath = resolvePath(line.slice('*** Update File: '.length).trim(), cwd);
      assertWriteAllowed(origPath, context);
      i++;
      let newPath = null;
      if (i < lines.length && lines[i].trim().startsWith('*** Move to: ')) {
        newPath = resolvePath(lines[i].trim().slice('*** Move to: '.length).trim(), cwd);
        assertWriteAllowed(newPath, context);
        i++;
      }

      assertUniquePatchTarget(origPath);
      if (newPath && newPath !== origPath) assertUniquePatchTarget(newPath);

      let fileContent = fs.readFileSync(origPath, 'utf8');

      while (i < lines.length && !_isFileOp(lines[i])) {
        if (lines[i].trim().startsWith('@@')) {
          i++;
          const hunkLines = [];
          while (i < lines.length && !lines[i].trim().startsWith('@@') && !_isFileOp(lines[i])) {
            hunkLines.push(lines[i]);
            i++;
          }
          fileContent = _applyHunk(fileContent, hunkLines);
        } else {
          i++;
        }
      }

      const dest = newPath || origPath;
      plan.push({ path: dest, from: newPath ? origPath : undefined, op: newPath ? 'move' : 'update', content: fileContent, bytes: Buffer.byteLength(fileContent) });

    } else {
      i++;
    }
  }
  return plan;
}

function _commitPatchPlan(plan) {
  const checkpoints = new Set();
  for (const op of plan) {
    if (op.from && !checkpoints.has(op.from)) { checkpointFile(op.from); checkpoints.add(op.from); }
    if (op.op !== 'add' && !checkpoints.has(op.path)) { checkpointFile(op.path); checkpoints.add(op.path); }

    if (op.op === 'delete') {
      fs.unlinkSync(op.path);
    } else {
      atomicWriteFile(op.path, op.content, 'utf8');
      if (op.from) { try { fs.unlinkSync(op.from); } catch (_) {} }
    }
  }
  return _summarizePatchPlan(plan);
}

function _applyPatch(patchText, cwd, context) {
  return _commitPatchPlan(_buildPatchPlan(patchText, cwd, context));
}

// Exported for use by native function tools (self-tools.js / fauna_apply_patch).
// Returns the same per-file results array as the /api/apply-patch HTTP route.
export function applyPatchText(patchText, cwd, context) {
  return _applyPatch(patchText, cwd, context);
}

export function registerAgentSandboxFileRoutes(app) {
  // ── /api/write-file ─────────────────────────────────────────────────────
  app.post('/api/write-file', (req, res) => {
    const { path: filePath, content, fromFile, encoding, cwd } = req.body;
    if (!filePath) return res.status(400).json({ error: 'path required' });
    const startedAt = performance.now();
    try {
      const context = getMutationContext(req.body);
      const abs = resolvePath(filePath, cwd);
      assertWriteAllowed(abs, context);
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      if (fromFile) {
        fs.copyFileSync(fromFile, abs);
        const bytes = fs.statSync(abs).size;
        console.log(`[write-file] copy ${fromFile} -> ${abs} bytes=${bytes} ms=${(performance.now() - startedAt).toFixed(1)} sandboxed=${!!context}`);
        res.json({ ok: true, path: abs, bytes, sandboxed: !!context });
      } else {
        if (content === undefined) return res.status(400).json({ error: 'content or fromFile required' });
        const checkpointStartedAt = performance.now();
        checkpointFile(abs);
        const checkpointMs = performance.now() - checkpointStartedAt;
        const writeStartedAt = performance.now();
        atomicWriteFile(abs, content, encoding || 'utf8');
        const bytes = Buffer.byteLength(content, encoding || 'utf8');
        console.log(`[write-file] json path=${abs} chars=${String(content).length} bytes=${bytes} checkpointMs=${checkpointMs.toFixed(1)} writeMs=${(performance.now() - writeStartedAt).toFixed(1)} totalMs=${(performance.now() - startedAt).toFixed(1)} sandboxed=${!!context}`);
        res.json({ ok: true, path: abs, bytes, sandboxed: !!context });
      }
    } catch (e) {
      console.log(`[write-file] error path=${filePath} ms=${(performance.now() - startedAt).toFixed(1)} error=${e.message}`);
      sendMutationError(res, e);
    }
  });

  // ── PUT /api/write-file-stream ──────────────────────────────────────────
  app.put('/api/write-file-stream', (req, res) => {
    const filePath = req.query.path;
    const cwd      = req.query.cwd;
    if (!filePath) return res.status(400).json({ error: 'path query param required' });
    const startedAt = performance.now();
    try {
      const context = getMutationContext(req.query);
      const abs = resolvePath(filePath, cwd);
      assertWriteAllowed(abs, context);
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      const tmp = abs + '.~tmp' + process.pid;
      const out = fs.createWriteStream(tmp);
      let receivedBytes = 0;
      req.on('data', chunk => { receivedBytes += chunk.length; });
      req.pipe(out);
      out.on('finish', () => {
        try {
          const checkpointStartedAt = performance.now();
          checkpointFile(abs);
          const checkpointMs = performance.now() - checkpointStartedAt;
          const renameStartedAt = performance.now();
          fs.renameSync(tmp, abs);
          const bytes = fs.statSync(abs).size;
          console.log(`[write-file-stream] path=${abs} received=${receivedBytes} bytes=${bytes} checkpointMs=${checkpointMs.toFixed(1)} renameMs=${(performance.now() - renameStartedAt).toFixed(1)} totalMs=${(performance.now() - startedAt).toFixed(1)} sandboxed=${!!context}`);
          res.json({ ok: true, path: abs, bytes, sandboxed: !!context });
        } catch (e) {
          try { fs.unlinkSync(tmp); } catch (_) {}
          console.log(`[write-file-stream] finish error path=${abs} received=${receivedBytes} ms=${(performance.now() - startedAt).toFixed(1)} error=${e.message}`);
          res.status(500).json({ error: e.message });
        }
      });
      out.on('error', e => { try { fs.unlinkSync(tmp); } catch (_) {} console.log(`[write-file-stream] output error path=${abs} received=${receivedBytes} ms=${(performance.now() - startedAt).toFixed(1)} error=${e.message}`); res.status(500).json({ error: e.message }); });
      req.on('error', e => { try { fs.unlinkSync(tmp); } catch (_) {} console.log(`[write-file-stream] request error path=${abs} received=${receivedBytes} ms=${(performance.now() - startedAt).toFixed(1)} error=${e.message}`); res.status(500).json({ error: e.message }); });
    } catch (e) {
      console.log(`[write-file-stream] setup error path=${filePath} ms=${(performance.now() - startedAt).toFixed(1)} error=${e.message}`);
      sendMutationError(res, e);
    }
  });

  // ── /api/write-files/check ──────────────────────────────────────────────
  app.post('/api/write-files/check', (req, res) => {
    try {
      const context = getMutationContext(req.body || {});
      const plan = _buildWriteFilesPlan(req.body || {}, context);
      res.json({ ok: true, results: _summarizeWritePlan(plan), sandboxed: !!context });
    } catch (e) {
      sendMutationError(res, e);
    }
  });

  // ── /api/write-files ────────────────────────────────────────────────────
  app.post('/api/write-files', (req, res) => {
    const startedAt = performance.now();
    try {
      const context = getMutationContext(req.body || {});
      const planStartedAt = performance.now();
      const plan = _buildWriteFilesPlan(req.body || {}, context);
      const planMs = performance.now() - planStartedAt;
      const commitStartedAt = performance.now();
      const results = _commitWriteFilesPlan(plan);
      const commitMs = performance.now() - commitStartedAt;
      console.log(`[write-files] files=${plan.length} bytes=${plan.reduce((sum, op) => sum + (op.bytes || 0), 0)} planMs=${planMs.toFixed(1)} commitMs=${commitMs.toFixed(1)} totalMs=${(performance.now() - startedAt).toFixed(1)} sandboxed=${!!context}`);
      res.json({ ok: true, results, sandboxed: !!context });
    } catch (e) {
      console.log(`[write-files] error ms=${(performance.now() - startedAt).toFixed(1)} error=${e.message}`);
      sendMutationError(res, e);
    }
  });

  // ── /api/append-file ────────────────────────────────────────────────────
  app.post('/api/append-file', (req, res) => {
    const { path: filePath, content, encoding, cwd } = req.body;
    if (!filePath) return res.status(400).json({ error: 'path required' });
    if (content === undefined) return res.status(400).json({ error: 'content required' });
    try {
      const context = getMutationContext(req.body);
      const abs = resolvePath(filePath, cwd);
      assertWriteAllowed(abs, context);
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      fs.appendFileSync(abs, content, encoding || 'utf8');
      const bytes = fs.statSync(abs).size;
      res.json({ ok: true, path: abs, bytes, sandboxed: !!context });
    } catch (e) {
      sendMutationError(res, e);
    }
  });

  // ── /api/replace-string ─────────────────────────────────────────────────
  app.post('/api/replace-string', (req, res) => {
    const { path: filePath, old_string, new_string, cwd } = req.body;
    if (!filePath)        return res.status(400).json({ error: 'path required' });
    if (old_string == null) return res.status(400).json({ error: 'old_string required' });
    try {
      const context = getMutationContext(req.body);
      const abs      = resolvePath(filePath, cwd);
      assertWriteAllowed(abs, context);
      if (!fs.existsSync(abs)) {
        return res.status(404).json({ error: 'File not found: ' + abs, path: abs });
      }
      const original = fs.readFileSync(abs, 'utf8');
      if (!original.includes(old_string)) {
        return res.json({ ok: false, error: 'old_string not found in file', path: abs, code: 'OLD_STRING_NOT_FOUND' });
      }
      checkpointFile(abs);
      const idx     = original.indexOf(old_string);
      const updated = original.slice(0, idx) + (new_string ?? '') + original.slice(idx + old_string.length);
      atomicWriteFile(abs, updated, 'utf8');
      res.json({ ok: true, path: abs, bytes: Buffer.byteLength(updated), sandboxed: !!context });
    } catch (e) {
      sendMutationError(res, e);
    }
  });

  // ── /api/apply-patch ────────────────────────────────────────────────────
  app.post('/api/apply-patch', (req, res) => {
    const { patch, cwd } = req.body;
    if (!patch) return res.status(400).json({ error: 'patch required' });
    try {
      const context = getMutationContext(req.body);
      const results = _applyPatch(patch, cwd, context);
      res.json({ ok: true, results, sandboxed: !!context });
    } catch (e) {
      res.status(e.statusCode || 422).json({ ok: false, error: e.message, blocked: !!e.blocked });
    }
  });

  app.post('/api/apply-patch/check', (req, res) => {
    const { patch, cwd } = req.body;
    if (!patch) return res.status(400).json({ error: 'patch required' });
    try {
      const context = getMutationContext(req.body);
      const plan = _buildPatchPlan(patch, cwd, context);
      res.json({ ok: true, results: _summarizePatchPlan(plan), sandboxed: !!context });
    } catch (e) {
      res.status(e.statusCode || 422).json({ ok: false, error: e.message, blocked: !!e.blocked });
    }
  });

  // ── /api/checkpoints (GET / DELETE) + /api/restore-checkpoint ───────────
  app.get('/api/checkpoints', (req, res) => {
    const filePath = req.query.path;
    const cwd      = req.query.cwd;
    if (!filePath) return res.status(400).json({ error: 'path required' });
    try {
      const abs       = resolvePath(filePath, cwd);
      const rel       = abs.replace(/^[/\\]/, '').replace(/\\/g, '/');
      const mirrorDir = path.join(RECOVERY_DIR, rel);
      if (!fs.existsSync(mirrorDir)) return res.json({ checkpoints: [], target: abs });
      const files = fs.readdirSync(mirrorDir)
        .filter(f => f.endsWith('.bak'))
        .sort().reverse()
        .map(f => {
          const cp = path.join(mirrorDir, f);
          let size = 0;
          try { size = fs.statSync(cp).size; } catch (_) {}
          const ts = f.replace('.bak', '').replace(/^(\d{4})-(\d{2})-(\d{2})T(\d{2})-(\d{2})-(\d{2})$/, '$1-$2-$3T$4:$5:$6');
          return { name: f, path: cp, timestamp: ts, size };
        });
      res.json({ checkpoints: files, target: abs });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  app.delete('/api/checkpoints', (req, res) => {
    const filePath = req.query.path;
    const cwd      = req.query.cwd;
    if (!filePath) return res.status(400).json({ error: 'path required' });
    try {
      const abs       = resolvePath(filePath, cwd);
      const rel       = abs.replace(/^[/\\]/, '').replace(/\\/g, '/');
      const mirrorDir = path.join(RECOVERY_DIR, rel);
      let deleted = 0;
      if (fs.existsSync(mirrorDir)) {
        for (const f of fs.readdirSync(mirrorDir).filter(f => f.endsWith('.bak'))) {
          try { fs.unlinkSync(path.join(mirrorDir, f)); deleted++; } catch (_) {}
        }
      }
      res.json({ ok: true, deleted, target: abs });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  app.post('/api/restore-checkpoint', (req, res) => {
    const { checkpoint, target, cwd } = req.body;
    if (!checkpoint) return res.status(400).json({ error: 'checkpoint path required' });
    try {
      let dest;
      if (target) {
        dest = resolvePath(target, cwd);
      } else {
        const rel = path.relative(RECOVERY_DIR, path.dirname(checkpoint));
        dest = IS_WIN ? rel : '/' + rel.replace(/\\/g, '/');
      }
      checkpointFile(dest);
      fs.copyFileSync(checkpoint, dest);
      res.json({ ok: true, restored: checkpoint, to: dest, size: fs.statSync(dest).size });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  // ── /api/read-file ──────────────────────────────────────────────────────
  app.post('/api/read-file', (req, res) => {
    const { path: filePath, encoding } = req.body;
    if (!filePath) return res.status(400).json({ error: 'path required' });
    try {
      const abs = path.isAbsolute(filePath) ? filePath : path.join(os.homedir(), filePath);
      const content = fs.readFileSync(abs, encoding || 'utf8');
      res.json({ ok: true, path: abs, content, bytes: Buffer.byteLength(content, encoding || 'utf8') });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  // ── /api/read-image (resize to JPEG, base64) ────────────────────────────
  app.get('/api/read-image', (req, res) => {
    const filePath = req.query.path;
    const maxWidth = parseInt(req.query.maxWidth || '1280', 10);
    if (!filePath) return res.status(400).json({ error: 'path required' });

    const tmpPath = `/tmp/copilot_vision_${Date.now()}.jpg`;
    _exec(
      `sips -s format jpeg -s formatOptions 70 --resampleWidth ${maxWidth} ${JSON.stringify(filePath)} --out ${JSON.stringify(tmpPath)}`,
      (err) => {
        const srcPath = err ? filePath : tmpPath;
        const mime = err ? 'image/png' : 'image/jpeg';
        try {
          const data = fs.readFileSync(srcPath);
          if (!err) { try { fs.unlinkSync(tmpPath); } catch (_) {} }
          res.json({ base64: data.toString('base64'), mime, size: data.length });
        } catch (e) {
          res.status(404).json({ error: e.message });
        }
      }
    );
  });
}
