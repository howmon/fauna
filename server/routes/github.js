// ── GitHub Routes — account management + per-project git operations ───────
//
// Account endpoints (global, shared across projects):
//   GET    /api/github/accounts              — list metadata
//   POST   /api/github/accounts              — add (body: { token, label? })
//   POST   /api/github/accounts/:id/test     — re-validate token
//   DELETE /api/github/accounts/:id          — remove account + token
//
// Per-project endpoints (require a linked account on the project):
//   GET    /api/projects/:id/github          — link state + git status
//   PUT    /api/projects/:id/github          — set link (body: { accountId, repo, defaultBranch })
//   DELETE /api/projects/:id/github          — unlink
//   POST   /api/projects/:id/github/commit   — stage + commit (body: { message })
//   POST   /api/projects/:id/github/pull     — git pull
//   POST   /api/projects/:id/github/push     — git push
//   POST   /api/projects/:id/github/sync     — git pull --rebase + push
//
// SECURITY: Tokens are NEVER written to .git/config. For push/pull we set the
// remote URL inline via `git -c remote.<name>.pushurl=<authenticated-url>` so
// the credential lives only inside the spawned process's argv for the
// duration of the call. We also set GIT_TERMINAL_PROMPT=0 to fail-fast
// instead of hanging on a hidden credential prompt.

import { spawn } from 'child_process';
import fs   from 'fs';
import path from 'path';

const GIT_OP_TIMEOUT_MS = 120000;

/**
 * Run `git -C <cwd> <args>` with the given env additions. Returns
 * { ok, code, stdout, stderr }. Never throws — callers inspect the result.
 */
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

/**
 * Build an HTTPS clone URL that embeds a PAT for one-shot use. The
 * `x-access-token` username is the canonical form GitHub accepts for PATs.
 */
function _authenticatedUrl(repo, token) {
  const safeRepo = String(repo || '').replace(/^https?:\/\/github\.com\//i, '').replace(/\.git$/i, '');
  return 'https://x-access-token:' + encodeURIComponent(token) + '@github.com/' + safeRepo + '.git';
}

/**
 * Redact any embedded `x-access-token:<token>@` from log lines before they
 * reach the renderer.
 */
function _redact(s) {
  return String(s || '').replace(/x-access-token:[^@\s]+@/g, 'x-access-token:***@');
}

/**
 * Collect current git status for a project's rootPath: branch, ahead/behind,
 * dirty file count. Always returns a result — never throws.
 */
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

export function registerGitHubRoutes(app, deps) {
  const {
    // GitHub account store
    listGitHubAccounts,
    getGitHubAccountMeta,
    addGitHubAccount,
    testGitHubAccount,
    removeGitHubAccount,
    getGitHubAccountToken,
    // Project store
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
    } catch (e) {
      res.status(400).json({ error: e.message });
    }
  });

  app.post('/api/github/accounts/:id/test', async (req, res) => {
    try {
      const acct = await testGitHubAccount(req.params.id);
      if (!acct) return res.status(404).json({ error: 'Account not found' });
      res.json(acct);
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  app.delete('/api/github/accounts/:id', (req, res) => {
    try {
      const ok = removeGitHubAccount(req.params.id);
      if (!ok) return res.status(404).json({ error: 'Account not found' });
      res.json({ ok: true });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // ── Per-project link + git ops ──────────────────────────────────────────

  // GET link state + git status (no token resolution required).
  app.get('/api/projects/:id/github', async (req, res) => {
    try {
      const proj = getProject(req.params.id);
      if (!proj) return res.status(404).json({ error: 'Project not found' });
      const link = proj.githubIntegration || null;
      const account = link?.accountId ? getGitHubAccountMeta(link.accountId) : null;
      const status = await _gitStatus(proj.rootPath || '');
      res.json({
        link,
        account,
        status,
        rootPath: proj.rootPath || null,
      });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // PUT link / unlink. Body: { accountId, repo, defaultBranch }
  app.put('/api/projects/:id/github', (req, res) => {
    try {
      const proj = getProject(req.params.id);
      if (!proj) return res.status(404).json({ error: 'Project not found' });
      const body = req.body || {};
      const accountId = body.accountId ? String(body.accountId).trim() : '';
      if (!accountId) {
        const updated = updateProject(proj.id, { githubIntegration: null });
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
      const link = {
        accountId,
        repo,
        defaultBranch: String(body.defaultBranch || '').trim() || null,
        linkedAt: new Date().toISOString(),
      };
      const updated = updateProject(proj.id, { githubIntegration: link });
      res.json({ link, project: updated });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  app.delete('/api/projects/:id/github', (req, res) => {
    try {
      const proj = getProject(req.params.id);
      if (!proj) return res.status(404).json({ error: 'Project not found' });
      const updated = updateProject(proj.id, { githubIntegration: null });
      res.json({ ok: true, project: updated });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // Helper: resolve { proj, cwd, link, token, branch } for a git op or send
  // an error response. Returns null when an error has already been sent.
  async function _resolveOpContext(req, res) {
    const proj = getProject(req.params.id);
    if (!proj) { res.status(404).json({ error: 'Project not found' }); return null; }
    const link = proj.githubIntegration;
    if (!link || !link.accountId) { res.status(400).json({ error: 'Project has no linked GitHub account.' }); return null; }
    const cwd = proj.rootPath;
    if (!cwd || !_isGitRepo(cwd)) {
      res.status(400).json({ error: 'Project rootPath is not a git repository. Run `git init` inside it first.' });
      return null;
    }
    const token = getGitHubAccountToken(link.accountId);
    if (!token) { res.status(400).json({ error: 'Stored token for the linked account is missing or unreadable.' }); return null; }
    const branchR = await _runGit(cwd, ['branch', '--show-current']);
    const branch = branchR.ok ? branchR.stdout.trim() : (link.defaultBranch || 'main');
    return { proj, cwd, link, token, branch };
  }

  app.post('/api/projects/:id/github/commit', async (req, res) => {
    const ctx = await _resolveOpContext(req, res);
    if (!ctx) return;
    const { cwd } = ctx;
    const message = String((req.body || {}).message || '').trim() || 'Update from Fauna';
    const addR = await _runGit(cwd, ['add', '-A']);
    if (!addR.ok) return res.status(500).json({ error: 'git add failed', stderr: _redact(addR.stderr) });
    // Allow empty? No — fail with a clear message so the UI can tell the user.
    const stagedR = await _runGit(cwd, ['diff', '--cached', '--name-only']);
    if (!stagedR.stdout.trim()) {
      return res.status(400).json({ error: 'Nothing to commit. Working tree is clean.' });
    }
    const commitR = await _runGit(cwd, ['commit', '-m', message]);
    if (!commitR.ok) return res.status(500).json({ error: 'git commit failed', stderr: _redact(commitR.stderr) });
    const status = await _gitStatus(cwd);
    res.json({ ok: true, message, commit: commitR.stdout, status });
  });

  app.post('/api/projects/:id/github/pull', async (req, res) => {
    const ctx = await _resolveOpContext(req, res);
    if (!ctx) return;
    const { cwd, link, token, branch } = ctx;
    const url = _authenticatedUrl(link.repo, token);
    // Use a one-shot inline remote so the token never lands in .git/config.
    const r = await _runGit(cwd, ['-c', 'credential.helper=', 'pull', url, branch, '--no-rebase']);
    const status = await _gitStatus(cwd);
    if (!r.ok) return res.status(500).json({ error: 'git pull failed', stderr: _redact(r.stderr), status });
    res.json({ ok: true, stdout: _redact(r.stdout), status });
  });

  app.post('/api/projects/:id/github/push', async (req, res) => {
    const ctx = await _resolveOpContext(req, res);
    if (!ctx) return;
    const { cwd, link, token, branch } = ctx;
    const url = _authenticatedUrl(link.repo, token);
    const r = await _runGit(cwd, ['-c', 'credential.helper=', 'push', url, 'HEAD:' + branch]);
    const status = await _gitStatus(cwd);
    if (!r.ok) return res.status(500).json({ error: 'git push failed', stderr: _redact(r.stderr), status });
    res.json({ ok: true, stdout: _redact(r.stdout) || _redact(r.stderr), status });
  });

  app.post('/api/projects/:id/github/sync', async (req, res) => {
    const ctx = await _resolveOpContext(req, res);
    if (!ctx) return;
    const { cwd, link, token, branch } = ctx;
    const url = _authenticatedUrl(link.repo, token);
    // Pull --rebase first, then push.
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
