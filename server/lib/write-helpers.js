// server/lib/write-helpers.js
//
// Shared helpers for file-mutation routes and agent tools.
//
// `getAgentManifest` is late-bound through a setter because it's declared
// deeper in server.js and consumed by `getMutationContext` here.

import fs from 'fs';
import os from 'os';
import path from 'path';

import { checkFilePath } from '../../agent-sandbox.js';
import { RECOVERY_DIR } from '../copilot/auth.js';

let _getAgentManifest = () => null;
export function setAgentManifestGetter(fn) {
  if (typeof fn === 'function') _getAgentManifest = fn;
}

// Resolve a file path: absolute → as-is, ~/... → home expansion,
// relative → cwd (or homedir) join. Restricts to $HOME or /tmp.
export function resolvePath(filePath, cwd) {
  let resolved;
  if (filePath.startsWith('/')) resolved = filePath;
  else if (filePath.startsWith('~/')) resolved = filePath.replace(/^~/, os.homedir());
  else if (cwd) resolved = path.join(cwd.replace(/^~/, os.homedir()), filePath);
  else resolved = path.join(os.homedir(), filePath);
  resolved = path.resolve(resolved);
  const home = os.homedir();
  if (!resolved.startsWith(home) && !resolved.startsWith('/tmp')) {
    throw new Error('Path outside allowed directories');
  }
  return resolved;
}

export function getMutationContext(body = {}) {
  const agentName = body.agentName;
  if (!agentName) return null;
  const manifest = _getAgentManifest(agentName);
  return {
    agentName,
    permissions: manifest?.permissions || body.permissions || {},
  };
}

export function assertWriteAllowed(absPath, context) {
  if (!context) return;
  const writeCheck = checkFilePath(absPath, 'write', context.permissions, context.agentName);
  if (!writeCheck.allowed) {
    const err = new Error(writeCheck.reason);
    err.statusCode = 403;
    err.blocked = true;
    throw err;
  }
}

export function atomicWriteFile(absPath, content, encoding = 'utf8') {
  fs.mkdirSync(path.dirname(absPath), { recursive: true });
  const tmp = absPath + '.~tmp' + process.pid;
  try {
    fs.writeFileSync(tmp, content, encoding);
    fs.renameSync(tmp, absPath);
  } catch (e) {
    try { fs.unlinkSync(tmp); } catch (_) {}
    throw e;
  }
}

export function sendMutationError(res, e) {
  const status = e.statusCode || (e.blocked ? 403 : 500);
  res.status(status).json({ ok: false, error: e.message, blocked: !!e.blocked });
}

// AutoRecovery — saves the current file to ~/.copilotchat-recovery/...
// Keeps the 20 most-recent checkpoints per file; never throws.
export function checkpointFile(abs) {
  if (!fs.existsSync(abs)) return null;
  try {
    const rel       = abs.replace(/^[/\\]/, '').replace(/\\/g, '/');
    const mirrorDir = path.join(RECOVERY_DIR, rel);
    fs.mkdirSync(mirrorDir, { recursive: true });
    const ts   = new Date().toISOString().slice(0, 19).replace(/[:.]/g, '-');
    const dest = path.join(mirrorDir, ts + '.bak');
    fs.copyFileSync(abs, dest);
    const all = fs.readdirSync(mirrorDir).filter(f => f.endsWith('.bak')).sort();
    if (all.length > 20) {
      for (const old of all.slice(0, all.length - 20)) {
        try { fs.unlinkSync(path.join(mirrorDir, old)); } catch (_) {}
      }
    }
    return dest;
  } catch (_) {
    return null;
  }
}
