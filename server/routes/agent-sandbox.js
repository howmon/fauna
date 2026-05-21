// Agent sandbox routes: shell-exec / write-file / read-file / fetch-url / audit-log
// proxied through the sandbox layer to enforce per-agent permissions.
// Extracted from server.js.

import fs from 'fs';
import os from 'os';
import path from 'path';
import { exec as _exec } from 'child_process';

import {
  checkFilePath, checkNetworkAccess, checkShellCommand,
  getSandboxedEnv, getResourceLimits, audit, getAuditLog,
} from '../../agent-sandbox.js';
import { resolvePath, atomicWriteFile, checkpointFile } from '../lib/write-helpers.js';

const IS_WIN = process.platform === 'win32';

export function registerAgentSandboxRoutes(app, { agentsDir, validateExternalUrl }) {
  // Helper: look up an agent manifest by name
  function getAgentManifest(name) {
    if (!name) return null;
    const agentDir = path.join(agentsDir, name.replace(/[^a-zA-Z0-9_-]/g, ''));
    const manifestPath = path.join(agentDir, 'agent.json');
    if (!fs.existsSync(manifestPath)) return null;
    try { return JSON.parse(fs.readFileSync(manifestPath, 'utf8')); } catch (_) { return null; }
  }

  // Sandboxed shell execution
  app.post('/api/agent/shell-exec', (req, res) => {
    const { command, cwd, agentName } = req.body;
    if (!command) return res.status(400).json({ error: 'command required' });
    if (!agentName) return res.status(400).json({ error: 'agentName required' });

    // Look up permissions — check installed agents, fall back to built-in names
    const manifest = getAgentManifest(agentName);
    const permissions = manifest?.permissions || req.body.permissions || {};

    // Check shell permission
    const shellCheck = checkShellCommand(command, permissions, agentName);
    if (!shellCheck.allowed) {
      return res.status(403).json({ ok: false, error: shellCheck.reason, blocked: true });
    }

    // Run with sandboxed environment
    const workDir = cwd || os.homedir();
    const env = getSandboxedEnv(permissions);
    const limits = manifest ? getResourceLimits(manifest) : { timeout: 300000 };

    _exec(command, {
      cwd: workDir, env, timeout: limits.timeout,
      maxBuffer: 10 * 1024 * 1024, shell: IS_WIN ? 'powershell.exe' : '/bin/zsh'
    }, (err, stdout, stderr) => {
      res.json({
        ok:       !err || (stdout && err?.code === 0),
        exitCode: err?.code ?? 0,
        stdout:   stdout || '',
        stderr:   stderr || '',
        command, cwd: workDir,
        sandboxed: true,
      });
    });
  });

  // Sandboxed file write
  app.post('/api/agent/write-file', (req, res) => {
    const { filePath: fp, content, agentName, cwd } = req.body;
    if (!fp || content == null) return res.status(400).json({ error: 'filePath and content required' });
    if (!agentName) return res.status(400).json({ error: 'agentName required' });

    const manifest = getAgentManifest(agentName);
    const permissions = manifest?.permissions || req.body.permissions || {};

    let absPath;
    try { absPath = resolvePath(fp, cwd); } catch (e) {
      return res.status(403).json({ ok: false, error: e.message, blocked: true });
    }

    const writeCheck = checkFilePath(absPath, 'write', permissions, agentName);
    if (!writeCheck.allowed) {
      return res.status(403).json({ ok: false, error: writeCheck.reason, blocked: true });
    }

    try {
      checkpointFile(absPath);
      atomicWriteFile(absPath, content, 'utf8');
      audit(agentName, 'file-write', absPath, true);
      res.json({ ok: true, path: absPath, sandboxed: true });
    } catch (e) {
      res.status(500).json({ ok: false, error: e.message });
    }
  });

  // Sandboxed file read
  app.post('/api/agent/read-file', (req, res) => {
    const { filePath: fp, agentName } = req.body;
    if (!fp) return res.status(400).json({ error: 'filePath required' });
    if (!agentName) return res.status(400).json({ error: 'agentName required' });

    const manifest = getAgentManifest(agentName);
    const permissions = manifest?.permissions || req.body.permissions || {};

    let absPath;
    try { absPath = resolvePath(fp); } catch (e) {
      return res.status(403).json({ ok: false, error: e.message, blocked: true });
    }

    const readCheck = checkFilePath(absPath, 'read', permissions, agentName);
    if (!readCheck.allowed) {
      return res.status(403).json({ ok: false, error: readCheck.reason, blocked: true });
    }

    try {
      const content = fs.readFileSync(absPath, 'utf8');
      audit(agentName, 'file-read', absPath, true);
      res.json({ ok: true, content, path: absPath, sandboxed: true });
    } catch (e) {
      res.status(500).json({ ok: false, error: e.message });
    }
  });

  // Sandboxed URL fetch (proxy through domain allowlist)
  app.post('/api/agent/fetch-url', async (req, res) => {
    const { url, agentName } = req.body;
    if (!url) return res.status(400).json({ error: 'URL required' });
    if (!agentName) return res.status(400).json({ error: 'agentName required' });

    const manifest = getAgentManifest(agentName);
    const permissions = manifest?.permissions || req.body.permissions || {};

    // Check network permission
    const netCheck = checkNetworkAccess(url, permissions, agentName);
    if (!netCheck.allowed) {
      return res.status(403).json({ ok: false, error: netCheck.reason, blocked: true });
    }

    // Also run the existing SSRF check
    try { validateExternalUrl(url); } catch (e) {
      return res.status(403).json({ ok: false, error: e.message, blocked: true });
    }

    try {
      const response = await fetch(url, {
        headers: { 'User-Agent': 'Mozilla/5.0 (compatible; CopilotChat/1.0)' },
        signal: AbortSignal.timeout(12000),
        redirect: 'follow',
      });
      const text = await response.text();
      res.json({ ok: true, content: text, status: response.status, sandboxed: true });
    } catch (e) {
      res.status(500).json({ ok: false, error: e.message });
    }
  });

  // Audit log viewer
  app.get('/api/agent/audit-log', (req, res) => {
    const agent = req.query.agent || null;
    const limit = parseInt(req.query.limit) || 100;
    res.json({ log: getAuditLog(agent, limit) });
  });

  return { getAgentManifest };
}
