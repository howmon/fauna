// ── GitHub Routes — account management + per-source git operations ────────
//
// A project can have multiple git-capable "targets":
//   • Its own rootPath (if it's a git repo) — addressed as sourceId "__root".
//   • Any local source whose `path` itself contains a `.git` directory.
//
// Each target gets its own GitHub link (account + repo + defaultBranch), so a
// project that mixes repos from different owners or accounts can commit each
// one with the right credentials.
//
// Account endpoints (global, shared across projects):
//   GET    /api/github/accounts              — list metadata
//   POST   /api/github/accounts              — add (body: { token, label? })
//   POST   /api/github/accounts/:id/test     — re-validate token
//   DELETE /api/github/accounts/:id          — remove account + token
//
// Per-project endpoints:
//   GET    /api/projects/:id/github                      — list all git targets + link state + status
//   PUT    /api/projects/:id/github/:sourceId            — set link (body: { accountId, repo, defaultBranch })
//   DELETE /api/projects/:id/github/:sourceId            — unlink
//   POST   /api/projects/:id/github/:sourceId/commit     — stage + commit (body: { message })
//   POST   /api/projects/:id/github/:sourceId/pull       — git pull
//   POST   /api/projects/:id/github/:sourceId/push       — git push
//   POST   /api/projects/:id/github/:sourceId/sync       — git pull --rebase + push
//
// SECURITY: Tokens are NEVER written to .git/config. For push/pull we set the
// remote URL inline via the spawn argv so the credential lives only inside
// the spawned process for the duration of the call. We also set
// GIT_TERMINAL_PROMPT=0 to fail-fast instead of hanging on a hidden prompt.

import { spawn } from 'child_process';
import fs   from 'fs';
import path from 'path';

const GIT_OP_TIMEOUT_MS = 120000;

const ROOT_SOURCE_ID = '__root';

function _runGit(cwd, args, env = {}) {
  return new Promise((resolve) => {
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    const child = spawn('git', ['-C', cwd, ...args], {
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0', ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const timer = setTimeout(() => {
      timedOut = true;
      try { child.kill('SIGKILL'); } catch (_) {}
    }, GIT_OP_TIMEOUT_MS);
    child.stdout.on('data', (b) => { stdout += b.toString(); });
    child.stderr.on('data', (b) => { stderr += b.toString(); });
    child.on('error', (e) => {
      clearTimeout(timer);
      resolve({ ok: false, code: -1, stdout, stderr: stderr || String(e?.message || e) });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (timedOut) {
        resolve({ ok: false, code: -1, stdout, stderr: stderr + '\n[timed out after ' + (GIT_OP_TIMEOUT_MS / 1000) + 's]' });
      } else {
        resolve({ ok: code === 0, code, stdout: stdout.trim(), stderr: stderr.trim() });
      }
    });
  });
}

function _isGitRepo(cwd) {
  try {
    if (!cwd || !fs.existsSync(cwd)) return false;
    return fs.existsSync(path.join(cwd, '.git'));
  } catch (_) { return false; }
}

function _authenticatedUrl(repo, token) {
  const safeRepo = String(repo || '').replace(/^https?:\/\/github\.com\//i, '').replace(/\.git$/i, '');
  return 'https://x-access-token:' + encodeURIComponent(token) + '@github.com/' + safeRepo + '.git';
}

function _redact(s) {
  return String(s || '').replace(/x-access-token:[^@\s]+@/g, 'x-access-token:***@');
}

async function _gitStatus(cwd) {
  if (!_isGitRepo(cwd)) {
    return { isRepo: false, branch: null, ahead: 0, behind: 0, dirty: 0, lines: [] };
  }
  const [branchR, statusR] = await Promise.all([
    _runGit(cwd, ['branch', '--show-current']),
    _runGit(cwd, ['status', '--porcelain=v1', '--branch']),
  ]);
  const branch = branchR.ok ? branchR.stdout.trim() : null;
  let ahead = 0, behind = 0;
  let dirty = 0;
  const lines = [];
  if (statusR.ok) {
    for (const line of statusR.stdout.split('\n')) {
      if (line.startsWith('##')) {
        const m = line.match(/\[(?:ahead (\d+))?(?:, )?(?:behind (\d+))?\]/);
        if (m) {
          ahead  = parseInt(m[1] || '0', 10) || 0;
          behind = parseInt(m[2] || '0', 10) || 0;
        }
        continue;
      }
      if (line.trim()) { dirty++; if (lines.length < 20) lines.push(line); }
    }
  }
  return { isRepo: true, branch, ahead, behind, dirty, lines };
}

/**
 * Enumerate the git-capable targets for a project. The project's rootPath is
 * included as a virtual source with id "__root" so the per-source link map
 * can store its link there. Local sources whose own path is a git repo are
 * each listed separately (deduped against rootPath).
 */
function _enumerateTargets(proj) {
  const targets = [];
  const seen = new Set();
  const rootPath = (proj.rootPath || '').trim();
  if (rootPath && _isGitRepo(rootPath)) {
    targets.push({ sourceId: ROOT_SOURCE_ID, label: 'Project folder', cwd: rootPath, kind: 'root' });
    seen.add(rootPath);
  }
  for (const s of (proj.sources || [])) {
    if (s.type !== 'local' || !s.path) continue;
    if (seen.has(s.path)) continue;
    if (!_isGitRepo(s.path)) continue;
    targets.push({ sourceId: s.id, label: s.name || s.path, cwd: s.path, kind: 'source' });
    seen.add(s.path);
  }
  return targets;
}

export function registerGitHubRoutes(app, deps) {
  const {
    listGitHubAccounts,
    getGitHubAccountMeta,
    addGitHubAccount,
    testGitHubAccount,
    removeGitHubAccount,
    getGitHubAccountToken,
    getProject,
    updateProject,
  } = deps;

  // ── Accounts ────────────────────────────────────────────────────────────

  app.get('/api/github/accounts', (_req, res) => {
    try { res.json(listGitHubAccounts()); }
    catch (e) { res.status(500).json({ error: e.message }); }
  });

  app.post('/api/github/accounts', async (req, res) => {
    try {
      const acct = await addGitHubAccount(req.body || {});
      res.status(201).json(acct);
    } catch (e) { res.status(400).json({ error: e.message }); }
  });

  app.post('/api/github/accounts/:id/test', async (req, res) => {
    try {
      const acct = await testGitHubAccount(req.params.id);
      if (!acct) return res.status(404).json({ error: 'Account not found' });
      res.json(acct);
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  app.delete('/api/github/accounts/:id', (req, res) => {
    try {
      const ok = removeGitHubAccount(req.params.id);
      if (!ok) return res.status(404).json({ error: 'Account not found' });
      res.json({ ok: true });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // ── Per-project: list all git targets with their link + status ──────────

  app.get('/api/projects/:id/github', async (req, res) => {
    try {
      const proj = getProject(req.params.id);
      if (!proj) return res.status(404).json({ error: 'Project not found' });
      const links = proj.githubIntegrations || {};
      const targets = _enumerateTargets(proj);
      // Surface orphan links — entries that point to a source no longer
      // present — so the UI can offer to clean them up.
      const targetIds = new Set(targets.map(t => t.sourceId));
      const orphans = Object.keys(links).filter(k => !targetIds.has(k));
      const statuses = await Promise.all(targets.map(t => _gitStatus(t.cwd)));
      const enriched = targets.map((t, i) => {
        const link = links[t.sourceId] || null;
        const account = link?.accountId ? getGitHubAccountMeta(link.accountId) : null;
        return { ...t, link, account, status: statuses[i] };
      });
      res.json({
        rootPath: proj.rootPath || null,
        targets: enriched,
        orphans,
      });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // PUT link / unlink for a specific source. Body: { accountId, repo, defaultBranch }
  app.put('/api/projects/:id/github/:sourceId', (req, res) => {
    try {
      const proj = getProject(req.params.id);
      if (!proj) return res.status(404).json({ error: 'Project not found' });
      const sourceId = String(req.params.sourceId || '').trim();
      if (!sourceId) return res.status(400).json({ error: 'sourceId required' });
      const targets = _enumerateTargets(proj);
      if (!targets.find(t => t.sourceId === sourceId)) {
        return res.status(400).json({ error: 'Source is not a git repository (or has been removed).' });
      }
      const body = req.body || {};
      const accountId = body.accountId ? String(body.accountId).trim() : '';
      const links = { ...(proj.githubIntegrations || {}) };
      if (!accountId) {
        delete links[sourceId];
        const updated = updateProject(proj.id, { githubIntegrations: links });
        return res.json({ link: null, project: updated });
      }
      const account = getGitHubAccountMeta(accountId);
      if (!account) return res.status(400).json({ error: 'Unknown GitHub account: ' + accountId });
      const repo = String(body.repo || '').trim()
        .replace(/^https?:\/\/github\.com\//i, '')
        .replace(/\.git$/i, '');
      if (!repo || !/^[^\/\s]+\/[^\/\s]+$/.test(repo)) {
        return res.status(400).json({ error: 'Repo must be in the form "owner/name".' });
      }
      links[sourceId] = {
        accountId,
        repo,
        defaultBranch: String(body.defaultBranch || '').trim() || null,
        linkedAt: new Date().toISOString(),
      };
      const updated = updateProject(proj.id, { githubIntegrations: links });
      res.json({ link: links[sourceId], project: updated });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  app.delete('/api/projects/:id/github/:sourceId', (req, res) => {
    try {
      const proj = getProject(req.params.id);
      if (!proj) return res.status(404).json({ error: 'Project not found' });
      const sourceId = String(req.params.sourceId || '').trim();
      const links = { ...(proj.githubIntegrations || {}) };
      delete links[sourceId];
      const updated = updateProject(proj.id, { githubIntegrations: links });
      res.json({ ok: true, project: updated });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // Helper: resolve { proj, cwd, link, token, branch } for an op on
  // (:id, :sourceId), or send an error response. Returns null on error.
  async function _resolveOpContext(req, res) {
    const proj = getProject(req.params.id);
    if (!proj) { res.status(404).json({ error: 'Project not found' }); return null; }
    const sourceId = String(req.params.sourceId || '').trim();
    if (!sourceId) { res.status(400).json({ error: 'sourceId required' }); return null; }
    const targets = _enumerateTargets(proj);
    const target = targets.find(t => t.sourceId === sourceId);
    if (!target) { res.status(400).json({ error: 'Source is not a git repository (or has been removed).' }); return null; }
    const link = (proj.githubIntegrations || {})[sourceId];
    if (!link || !link.accountId) { res.status(400).json({ error: 'This source has no linked GitHub account.' }); return null; }
    const token = getGitHubAccountToken(link.accountId);
    if (!token) { res.status(400).json({ error: 'Stored token for the linked account is missing or unreadable.' }); return null; }
    const branchR = await _runGit(target.cwd, ['branch', '--show-current']);
    const branch = branchR.ok ? branchR.stdout.trim() : (link.defaultBranch || 'main');
    return { proj, target, cwd: target.cwd, link, token, branch };
  }

  app.post('/api/projects/:id/github/:sourceId/commit', async (req, res) => {
    const ctx = await _resolveOpContext(req, res);
    if (!ctx) return;
    const { cwd } = ctx;
    const message = String((req.body || {}).message || '').trim() || 'Update from Fauna';
    const addR = await _runGit(cwd, ['add', '-A']);
    if (!addR.ok) return res.status(500).json({ error: 'git add failed', stderr: _redact(addR.stderr) });
    const stagedR = await _runGit(cwd, ['diff', '--cached', '--name-only']);
    if (!stagedR.stdout.trim()) {
      return res.status(400).json({ error: 'Nothing to commit. Working tree is clean.' });
    }
    const commitR = await _runGit(cwd, ['commit', '-m', message]);
    if (!commitR.ok) return res.status(500).json({ error: 'git commit failed', stderr: _redact(commitR.stderr) });
    const status = await _gitStatus(cwd);
    res.json({ ok: true, message, commit: commitR.stdout, status });
  });

  app.post('/api/projects/:id/github/:sourceId/pull', async (req, res) => {
    const ctx = await _resolveOpContext(req, res);
    if (!ctx) return;
    const { cwd, link, token, branch } = ctx;
    const url = _authenticatedUrl(link.repo, token);
    const r = await _runGit(cwd, ['-c', 'credential.helper=', 'pull', url, branch, '--no-rebase']);
    const status = await _gitStatus(cwd);
    if (!r.ok) return res.status(500).json({ error: 'git pull failed', stderr: _redact(r.stderr), status });
    res.json({ ok: true, stdout: _redact(r.stdout), status });
  });

  app.post('/api/projects/:id/github/:sourceId/push', async (req, res) => {
    const ctx = await _resolveOpContext(req, res);
    if (!ctx) return;
    const { cwd, link, token, branch } = ctx;
    const url = _authenticatedUrl(link.repo, token);
    const r = await _runGit(cwd, ['-c', 'credential.helper=', 'push', url, 'HEAD:' + branch]);
    const status = await _gitStatus(cwd);
    if (!r.ok) return res.status(500).json({ error: 'git push failed', stderr: _redact(r.stderr), status });
    res.json({ ok: true, stdout: _redact(r.stdout) || _redact(r.stderr), status });
  });

  app.post('/api/projects/:id/github/:sourceId/sync', async (req, res) => {
    const ctx = await _resolveOpContext(req, res);
    if (!ctx) return;
    const { cwd, link, token, branch } = ctx;
    const url = _authenticatedUrl(link.repo, token);
    const pullR = await _runGit(cwd, ['-c', 'credential.helper=', 'pull', '--rebase', url, branch]);
    if (!pullR.ok) {
      const status = await _gitStatus(cwd);
      return res.status(500).json({ error: 'git pull --rebase failed', stderr: _redact(pullR.stderr), status });
    }
    const pushR = await _runGit(cwd, ['-c', 'credential.helper=', 'push', url, 'HEAD:' + branch]);
    const status = await _gitStatus(cwd);
    if (!pushR.ok) return res.status(500).json({ error: 'git push failed', stderr: _redact(pushR.stderr), status });
    res.json({
      ok: true,
      pullStdout: _redact(pullR.stdout),
      pushStdout: _redact(pushR.stdout) || _redact(pushR.stderr),
      status,
    });
  });
}
