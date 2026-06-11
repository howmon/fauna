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
    return { isRepo: false, branch: null, ahead: 0, behind: 0, dirty: 0, files: [], rebasing: false };
  }
  const [branchR, statusR] = await Promise.all([
    _runGit(cwd, ['branch', '--show-current']),
    // -z + NUL terminators make rename parsing unambiguous.
    _runGit(cwd, ['status', '--porcelain=v1', '--branch', '-z']),
  ]);
  const branch = branchR.ok ? branchR.stdout.trim() : null;
  let ahead = 0, behind = 0;
  const files = [];
  if (statusR.ok) {
    // -z output: entries are NUL-separated. Renames split across two NULs
    // (XY old\0new). Walk the array with an index.
    const parts = statusR.stdout.split('\0').filter(Boolean);
    let i = 0;
    while (i < parts.length) {
      const entry = parts[i++];
      if (entry.startsWith('## ')) {
        const m = entry.match(/\[(?:ahead (\d+))?(?:, )?(?:behind (\d+))?\]/);
        if (m) {
          ahead  = parseInt(m[1] || '0', 10) || 0;
          behind = parseInt(m[2] || '0', 10) || 0;
        }
        continue;
      }
      if (entry.length < 3) continue;
      const X = entry[0];
      const Y = entry[1];
      let pathPart = entry.slice(3);
      let oldPath = null;
      if (X === 'R' || X === 'C' || Y === 'R' || Y === 'C') {
        // The "from" name appears in the next NUL-segment for renames/copies.
        oldPath = parts[i++] || null;
      }
      files.push({
        path:        pathPart,
        oldPath,
        indexStatus: X,           // staged side (' ' = unstaged)
        workStatus:  Y,           // worktree side (' ' = unmodified)
        staged:      X !== ' ' && X !== '?',
        unstaged:    Y !== ' ',
        untracked:   X === '?' && Y === '?',
        conflicted:  X === 'U' || Y === 'U' || (X === 'A' && Y === 'A') || (X === 'D' && Y === 'D'),
      });
    }
  }
  // Detect an in-progress rebase so the UI can surface a Continue/Abort bar.
  let rebasing = false;
  try {
    rebasing = fs.existsSync(path.join(cwd, '.git', 'rebase-merge'))
            || fs.existsSync(path.join(cwd, '.git', 'rebase-apply'));
  } catch (_) {}
  return { isRepo: true, branch, ahead, behind, dirty: files.length, files, rebasing };
}

/**
 * Enumerate ALL local folders the project knows about (rootPath + every
 * local source), tagged with whether they're git repos. Returning non-git
 * folders too lets the UI offer "Initialize git" instead of silently hiding
 * the source. Sources that are not local (e.g. cloned remotes) are skipped.
 */
function _enumerateTargets(proj) {
  const targets = [];
  const seen = new Set();
  const rootPath = (proj.rootPath || '').trim();
  if (rootPath) {
    targets.push({
      sourceId:  ROOT_SOURCE_ID,
      label:     'Project folder',
      cwd:       rootPath,
      kind:      'root',
      isGitRepo: _isGitRepo(rootPath),
    });
    seen.add(rootPath);
  }
  for (const s of (proj.sources || [])) {
    if (s.type !== 'local' || !s.path) continue;
    if (seen.has(s.path)) continue;
    targets.push({
      sourceId:  s.id,
      label:     s.name || s.path,
      cwd:       s.path,
      kind:      'source',
      isGitRepo: _isGitRepo(s.path),
    });
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

  // ── Owner discovery + repo creation (uses the GitHub REST API) ─────────

  // List the orgs an account can publish into. The account's own user is
  // implicitly an owner (returned as { login, type:'User' }) and is always
  // appended first so the picker has a sensible default.
  app.get('/api/github/accounts/:id/owners', async (req, res) => {
    const acct = getGitHubAccountMeta(req.params.id);
    if (!acct) return res.status(404).json({ error: 'Account not found' });
    const token = getGitHubAccountToken(req.params.id);
    if (!token) return res.status(400).json({ error: 'Token unavailable' });
    const owners = [{ login: acct.login, type: 'User', avatarUrl: acct.avatarUrl }];
    try {
      const r = await fetch('https://api.github.com/user/orgs?per_page=100', {
        headers: {
          'Authorization': 'Bearer ' + token,
          'Accept': 'application/vnd.github+json',
          'X-GitHub-Api-Version': '2022-11-28',
          'User-Agent': 'fauna-app',
        },
      });
      if (r.ok) {
        const orgs = await r.json();
        for (const o of (Array.isArray(orgs) ? orgs : [])) {
          owners.push({ login: o.login, type: 'Organization', avatarUrl: o.avatar_url || null });
        }
      }
      // 401/403 just means no org scope — fall through with the user only.
    } catch (e) {
      return res.status(500).json({ error: 'GitHub unreachable: ' + e.message });
    }
    res.json({ owners });
  });

  // Create a new GitHub repo under the given owner (user or org). Body:
  //   { owner?, name, description?, private?:true, autoInit?:false }
  // If `owner` is omitted or equals the account's login, the repo is created
  // under the user via POST /user/repos. Otherwise it's POST /orgs/:org/repos.
  app.post('/api/github/accounts/:id/repos', async (req, res) => {
    const acct = getGitHubAccountMeta(req.params.id);
    if (!acct) return res.status(404).json({ error: 'Account not found' });
    const token = getGitHubAccountToken(req.params.id);
    if (!token) return res.status(400).json({ error: 'Token unavailable' });
    const body = req.body || {};
    const name = String(body.name || '').trim();
    if (!name) return res.status(400).json({ error: 'Repo name is required' });
    // GitHub allows letters, digits, hyphens, underscores, periods. Reject
    // anything else up front rather than relying on the API error.
    if (!/^[A-Za-z0-9._-]+$/.test(name)) {
      return res.status(400).json({ error: 'Repo name may only contain letters, digits, "-", "_", "."' });
    }
    const owner = String(body.owner || '').trim() || acct.login;
    const isUser = owner.toLowerCase() === String(acct.login).toLowerCase();
    const url = isUser ? 'https://api.github.com/user/repos' : 'https://api.github.com/orgs/' + encodeURIComponent(owner) + '/repos';
    const payload = {
      name,
      description: String(body.description || '').slice(0, 350),
      private:     body.private !== false,                  // default to PRIVATE — safer for app-created repos
      auto_init:   body.autoInit === true,                  // off by default so we don't clobber a local repo on first push
      has_issues:  body.hasIssues !== false,
      has_wiki:    body.hasWiki !== false,
    };
    let r, data;
    try {
      r = await fetch(url, {
        method: 'POST',
        headers: {
          'Authorization': 'Bearer ' + token,
          'Accept': 'application/vnd.github+json',
          'X-GitHub-Api-Version': '2022-11-28',
          'User-Agent': 'fauna-app',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(payload),
      });
      data = await r.json().catch(() => ({}));
    } catch (e) {
      return res.status(500).json({ error: 'GitHub unreachable: ' + e.message });
    }
    if (!r.ok) {
      const msg = (data && (data.message || data.errors?.[0]?.message)) || ('HTTP ' + r.status);
      return res.status(r.status === 422 ? 409 : (r.status >= 400 && r.status < 500 ? r.status : 502))
                .json({ error: msg });
    }
    res.status(201).json({
      ok: true,
      repo:          data.full_name,           // "owner/name"
      htmlUrl:       data.html_url,
      cloneUrl:      data.clone_url,
      defaultBranch: data.default_branch || null,
      private:       !!data.private,
    });
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
      const target = targets.find(t => t.sourceId === sourceId);
      if (!target) {
        return res.status(400).json({ error: 'Source not found (it may have been removed).' });
      }
      if (!target.isGitRepo) {
        return res.status(400).json({ error: 'Source is not a git repository — initialize it first.' });
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

  // Initialize a plain folder as a git repo. Body: { initialBranch?:'main' }.
  // Idempotent: returns 200 with { alreadyInitialized:true } if the folder is
  // already a repo so the UI can just re-render.
  app.post('/api/projects/:id/github/:sourceId/init', async (req, res) => {
    try {
      const proj = getProject(req.params.id);
      if (!proj) return res.status(404).json({ error: 'Project not found' });
      const sourceId = String(req.params.sourceId || '').trim();
      if (!sourceId) return res.status(400).json({ error: 'sourceId required' });
      const targets = _enumerateTargets(proj);
      const target = targets.find(t => t.sourceId === sourceId);
      if (!target) return res.status(400).json({ error: 'Source not found.' });
      if (target.isGitRepo) return res.json({ ok: true, alreadyInitialized: true });
      const branch = String(req.body?.initialBranch || 'main').trim();
      if (!/^[A-Za-z0-9._\/-]+$/.test(branch)) return res.status(400).json({ error: 'Invalid branch name.' });
      const r = await _runGit(target.cwd, ['init', '-b', branch]);
      if (!r.ok) return res.status(500).json({ error: 'git init failed: ' + _redact(r.stderr || r.stdout) });
      res.json({ ok: true, alreadyInitialized: false, branch });
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

  // Helper: resolve { proj, target, cwd } for a LOCAL-only op (branches,
  // stage, discard, log, diff) — does not require a linked account. The
  // target must already be a git repo; non-git folders should call /init
  // first.
  function _resolveLocalContext(req, res) {
    const proj = getProject(req.params.id);
    if (!proj) { res.status(404).json({ error: 'Project not found' }); return null; }
    const sourceId = String(req.params.sourceId || '').trim();
    if (!sourceId) { res.status(400).json({ error: 'sourceId required' }); return null; }
    const targets = _enumerateTargets(proj);
    const target = targets.find(t => t.sourceId === sourceId);
    if (!target) { res.status(400).json({ error: 'Source not found (it may have been removed).' }); return null; }
    if (!target.isGitRepo) { res.status(400).json({ error: 'Source is not a git repository — initialize it first.' }); return null; }
    return { proj, target, cwd: target.cwd };
  }

  // Reject paths that try to escape the repo cwd via .. / absolute paths /
  // shell metacharacters. The CLI also forbids paths starting with -.
  function _validatePathArg(p, cwd) {
    if (typeof p !== 'string' || !p) throw new Error('Invalid path');
    if (p.startsWith('-')) throw new Error('Invalid path');
    if (/[\u0000\n]/.test(p)) throw new Error('Invalid path');
    if (path.isAbsolute(p)) throw new Error('Path must be repo-relative');
    const resolved = path.resolve(cwd, p);
    const root = path.resolve(cwd) + path.sep;
    if (resolved !== path.resolve(cwd) && !resolved.startsWith(root)) {
      throw new Error('Path escapes repo: ' + p);
    }
    return p;
  }

  // Sanitize a single ref name (branch / remote / tag). Forbids the
  // characters git itself rejects plus shell-y ones.
  function _validateRef(ref) {
    if (typeof ref !== 'string' || !ref) throw new Error('Invalid ref');
    if (ref.startsWith('-')) throw new Error('Invalid ref');
    if (/[\s\u0000~^:?*\[\\]/.test(ref)) throw new Error('Invalid ref');
    return ref;
  }

  // ── File-level: status detail, stage, unstage, discard, diff ────────────

  app.get('/api/projects/:id/github/:sourceId/status', async (req, res) => {
    const ctx = _resolveLocalContext(req, res);
    if (!ctx) return;
    const status = await _gitStatus(ctx.cwd);
    res.json({ status });
  });

  app.post('/api/projects/:id/github/:sourceId/stage', async (req, res) => {
    const ctx = _resolveLocalContext(req, res);
    if (!ctx) return;
    const { cwd } = ctx;
    const body = req.body || {};
    let paths = Array.isArray(body.files) ? body.files : [];
    try { paths = paths.map(p => _validatePathArg(String(p), cwd)); }
    catch (e) { return res.status(400).json({ error: e.message }); }
    if (!paths.length) return res.status(400).json({ error: 'files[] required' });
    const r = await _runGit(cwd, ['add', '--', ...paths]);
    if (!r.ok) return res.status(500).json({ error: 'git add failed', stderr: _redact(r.stderr) });
    res.json({ ok: true, status: await _gitStatus(cwd) });
  });

  app.post('/api/projects/:id/github/:sourceId/unstage', async (req, res) => {
    const ctx = _resolveLocalContext(req, res);
    if (!ctx) return;
    const { cwd } = ctx;
    const body = req.body || {};
    let paths = Array.isArray(body.files) ? body.files : [];
    try { paths = paths.map(p => _validatePathArg(String(p), cwd)); }
    catch (e) { return res.status(400).json({ error: e.message }); }
    if (!paths.length) return res.status(400).json({ error: 'files[] required' });
    // `git restore --staged` is the modern equivalent of `git reset HEAD --`.
    const r = await _runGit(cwd, ['restore', '--staged', '--', ...paths]);
    if (!r.ok) return res.status(500).json({ error: 'git restore --staged failed', stderr: _redact(r.stderr) });
    res.json({ ok: true, status: await _gitStatus(cwd) });
  });

  // Discard unstaged changes / delete untracked files. Body: { files:[…] }
  app.post('/api/projects/:id/github/:sourceId/discard', async (req, res) => {
    const ctx = _resolveLocalContext(req, res);
    if (!ctx) return;
    const { cwd } = ctx;
    const body = req.body || {};
    let paths = Array.isArray(body.files) ? body.files : [];
    try { paths = paths.map(p => _validatePathArg(String(p), cwd)); }
    catch (e) { return res.status(400).json({ error: e.message }); }
    if (!paths.length) return res.status(400).json({ error: 'files[] required' });
    // Two-pass discard so we handle tracked + untracked uniformly: first try
    // to restore each path; for any path git rejects as "not tracked", fall
    // back to `git clean -f` so the untracked file is removed.
    const restoreR = await _runGit(cwd, ['restore', '--worktree', '--source=HEAD', '--', ...paths]);
    const cleanR   = await _runGit(cwd, ['clean', '-f', '--', ...paths]);
    if (!restoreR.ok && !cleanR.ok) {
      return res.status(500).json({ error: 'discard failed', stderr: _redact(restoreR.stderr + '\n' + cleanR.stderr) });
    }
    res.json({ ok: true, status: await _gitStatus(cwd) });
  });

  // Diff of a single file. Query: ?path=…&staged=1
  app.get('/api/projects/:id/github/:sourceId/diff', async (req, res) => {
    const ctx = _resolveLocalContext(req, res);
    if (!ctx) return;
    const { cwd } = ctx;
    const p = String(req.query.path || '').trim();
    if (!p) return res.status(400).json({ error: 'path required' });
    let safe;
    try { safe = _validatePathArg(p, cwd); }
    catch (e) { return res.status(400).json({ error: e.message }); }
    const args = ['diff', '--no-color'];
    if (req.query.staged === '1' || req.query.staged === 'true') args.push('--cached');
    args.push('--', safe);
    const r = await _runGit(cwd, args);
    if (!r.ok) return res.status(500).json({ error: 'git diff failed', stderr: _redact(r.stderr) });
    res.json({ ok: true, diff: r.stdout });
  });

  // Recent commit log. Query: ?limit=20
  app.get('/api/projects/:id/github/:sourceId/log', async (req, res) => {
    const ctx = _resolveLocalContext(req, res);
    if (!ctx) return;
    const limit = Math.min(parseInt(req.query.limit, 10) || 20, 200);
    const fmt = '%H%x09%h%x09%an%x09%ae%x09%ad%x09%s';
    const r = await _runGit(ctx.cwd, ['log', '-n', String(limit), '--pretty=format:' + fmt, '--date=iso']);
    if (!r.ok) return res.status(500).json({ error: 'git log failed', stderr: _redact(r.stderr) });
    const commits = r.stdout.split('\n').filter(Boolean).map(line => {
      const [sha, short, author, email, date, ...rest] = line.split('\t');
      return { sha, short, author, email, date, subject: rest.join('\t') };
    });
    res.json({ ok: true, commits });
  });

  // ── Branches ────────────────────────────────────────────────────────────

  app.get('/api/projects/:id/github/:sourceId/branches', async (req, res) => {
    const ctx = _resolveLocalContext(req, res);
    if (!ctx) return;
    const { cwd } = ctx;
    // refs/heads/* (local) + refs/remotes/* (remote-tracking) with HEAD marker.
    const r = await _runGit(cwd, ['for-each-ref',
      '--format=%(HEAD)%09%(refname:short)%09%(refname)%09%(objectname:short)%09%(upstream:short)',
      'refs/heads', 'refs/remotes']);
    if (!r.ok) return res.status(500).json({ error: 'git for-each-ref failed', stderr: _redact(r.stderr) });
    const local = [];
    const remote = [];
    for (const line of r.stdout.split('\n').filter(Boolean)) {
      const [head, shortName, fullRef, sha, upstream] = line.split('\t');
      const entry = { name: shortName, ref: fullRef, sha, upstream: upstream || null, current: head === '*' };
      if (fullRef.startsWith('refs/heads/')) local.push(entry);
      else if (fullRef.startsWith('refs/remotes/')) {
        // Skip the symbolic origin/HEAD pointer; we already have the local tip.
        if (/\/HEAD$/.test(fullRef)) continue;
        remote.push(entry);
      }
    }
    res.json({ ok: true, local, remote });
  });

  // Create a new branch. Body: { name, from? (defaults to HEAD), checkout?:true }
  app.post('/api/projects/:id/github/:sourceId/branches', async (req, res) => {
    const ctx = _resolveLocalContext(req, res);
    if (!ctx) return;
    const { cwd } = ctx;
    const body = req.body || {};
    let name, from;
    try {
      name = _validateRef(String(body.name || '').trim());
      from = body.from ? _validateRef(String(body.from).trim()) : null;
    } catch (e) { return res.status(400).json({ error: e.message }); }
    const args = body.checkout === false ? ['branch', name] : ['checkout', '-b', name];
    if (from) args.push(from);
    const r = await _runGit(cwd, args);
    if (!r.ok) return res.status(500).json({ error: 'create branch failed', stderr: _redact(r.stderr) });
    res.json({ ok: true, branch: name, status: await _gitStatus(cwd) });
  });

  // Checkout / switch to an existing branch. Body: { name }
  app.post('/api/projects/:id/github/:sourceId/checkout', async (req, res) => {
    const ctx = _resolveLocalContext(req, res);
    if (!ctx) return;
    const { cwd } = ctx;
    let name;
    try { name = _validateRef(String((req.body || {}).name || '').trim()); }
    catch (e) { return res.status(400).json({ error: e.message }); }
    const r = await _runGit(cwd, ['checkout', name]);
    if (!r.ok) return res.status(500).json({ error: 'checkout failed', stderr: _redact(r.stderr) });
    res.json({ ok: true, branch: name, status: await _gitStatus(cwd) });
  });

  // Delete a local branch. Body: { name, force?:true }
  app.post('/api/projects/:id/github/:sourceId/branches/delete', async (req, res) => {
    const ctx = _resolveLocalContext(req, res);
    if (!ctx) return;
    const { cwd } = ctx;
    let name;
    try { name = _validateRef(String((req.body || {}).name || '').trim()); }
    catch (e) { return res.status(400).json({ error: e.message }); }
    const flag = (req.body || {}).force ? '-D' : '-d';
    const r = await _runGit(cwd, ['branch', flag, name]);
    if (!r.ok) return res.status(500).json({ error: 'delete branch failed', stderr: _redact(r.stderr) });
    res.json({ ok: true, status: await _gitStatus(cwd) });
  });

  // ── Rebase ──────────────────────────────────────────────────────────────

  // Rebase onto a ref. Body: { onto } — defaults to '<linkedAccount.defaultBranch>' or upstream.
  app.post('/api/projects/:id/github/:sourceId/rebase', async (req, res) => {
    const ctx = _resolveLocalContext(req, res);
    if (!ctx) return;
    const { cwd } = ctx;
    const body = req.body || {};
    let onto;
    try {
      const raw = String(body.onto || '').trim();
      if (!raw) return res.status(400).json({ error: 'onto required (e.g. "origin/main")' });
      onto = _validateRef(raw);
    } catch (e) { return res.status(400).json({ error: e.message }); }
    const r = await _runGit(cwd, ['rebase', onto]);
    const status = await _gitStatus(cwd);
    if (!r.ok) return res.status(500).json({ error: 'git rebase failed', stderr: _redact(r.stderr), status });
    res.json({ ok: true, stdout: _redact(r.stdout), status });
  });

  app.post('/api/projects/:id/github/:sourceId/rebase/continue', async (req, res) => {
    const ctx = _resolveLocalContext(req, res);
    if (!ctx) return;
    const r = await _runGit(ctx.cwd, ['rebase', '--continue'], { GIT_EDITOR: ':' });
    const status = await _gitStatus(ctx.cwd);
    if (!r.ok) return res.status(500).json({ error: 'rebase --continue failed', stderr: _redact(r.stderr), status });
    res.json({ ok: true, stdout: _redact(r.stdout), status });
  });

  app.post('/api/projects/:id/github/:sourceId/rebase/abort', async (req, res) => {
    const ctx = _resolveLocalContext(req, res);
    if (!ctx) return;
    const r = await _runGit(ctx.cwd, ['rebase', '--abort']);
    const status = await _gitStatus(ctx.cwd);
    if (!r.ok) return res.status(500).json({ error: 'rebase --abort failed', stderr: _redact(r.stderr), status });
    res.json({ ok: true, status });
  });

  // ── Stash ───────────────────────────────────────────────────────────────

  app.get('/api/projects/:id/github/:sourceId/stash', async (req, res) => {
    const ctx = _resolveLocalContext(req, res);
    if (!ctx) return;
    const r = await _runGit(ctx.cwd, ['stash', 'list', '--pretty=format:%gd%x09%gs']);
    if (!r.ok) return res.status(500).json({ error: 'git stash list failed', stderr: _redact(r.stderr) });
    const entries = r.stdout.split('\n').filter(Boolean).map(line => {
      const [ref, subject] = line.split('\t');
      return { ref, subject };
    });
    res.json({ ok: true, entries });
  });

  app.post('/api/projects/:id/github/:sourceId/stash', async (req, res) => {
    const ctx = _resolveLocalContext(req, res);
    if (!ctx) return;
    const msg = String((req.body || {}).message || '').trim();
    const args = ['stash', 'push', '--include-untracked'];
    if (msg) args.push('-m', msg);
    const r = await _runGit(ctx.cwd, args);
    const status = await _gitStatus(ctx.cwd);
    if (!r.ok) return res.status(500).json({ error: 'git stash push failed', stderr: _redact(r.stderr), status });
    res.json({ ok: true, stdout: r.stdout, status });
  });

  app.post('/api/projects/:id/github/:sourceId/stash/pop', async (req, res) => {
    const ctx = _resolveLocalContext(req, res);
    if (!ctx) return;
    const ref = (req.body || {}).ref;
    const args = ['stash', 'pop'];
    if (ref) {
      // ref looks like "stash@{0}" — git refs containing {/} are normally
      // forbidden by _validateRef, so use a narrow whitelist here instead.
      if (!/^stash@\{\d+\}$/.test(String(ref))) return res.status(400).json({ error: 'invalid stash ref' });
      args.push(String(ref));
    }
    const r = await _runGit(ctx.cwd, args);
    const status = await _gitStatus(ctx.cwd);
    if (!r.ok) return res.status(500).json({ error: 'git stash pop failed', stderr: _redact(r.stderr), status });
    res.json({ ok: true, stdout: r.stdout, status });
  });

  // ── Network ops requiring a linked account: fetch / pull / push / sync ──

  // Fetch all remotes (or upstream of current branch) using the linked token.
  app.post('/api/projects/:id/github/:sourceId/fetch', async (req, res) => {
    const ctx = await _resolveOpContext(req, res);
    if (!ctx) return;
    const { cwd, link, token } = ctx;
    const url = _authenticatedUrl(link.repo, token);
    // Fetch the linked repo, pruning stale remote refs. Store under the
    // 'origin' refspec so subsequent rebase/branch lookups work as expected.
    const r = await _runGit(cwd, ['-c', 'credential.helper=', 'fetch', '--prune', url,
      '+refs/heads/*:refs/remotes/origin/*']);
    const status = await _gitStatus(cwd);
    if (!r.ok) return res.status(500).json({ error: 'git fetch failed', stderr: _redact(r.stderr), status });
    res.json({ ok: true, stdout: _redact(r.stdout) || _redact(r.stderr), status });
  });

  app.post('/api/projects/:id/github/:sourceId/commit', async (req, res) => {
    const ctx = _resolveLocalContext(req, res);
    if (!ctx) return;
    const { cwd, proj } = ctx;
    const body = req.body || {};
    const message = String(body.message || '').trim() || 'Update from Fauna';
    // Mode 1: caller provided an explicit file selection → stage exactly
    // those files. Mode 2: no selection → stage everything (legacy behaviour).
    if (Array.isArray(body.files) && body.files.length) {
      let paths;
      try { paths = body.files.map(p => _validatePathArg(String(p), cwd)); }
      catch (e) { return res.status(400).json({ error: e.message }); }
      const addR = await _runGit(cwd, ['add', '--', ...paths]);
      if (!addR.ok) return res.status(500).json({ error: 'git add failed: ' + (_redact(addR.stderr) || 'unknown'), stderr: _redact(addR.stderr) });
    } else if (body.stageAll !== false) {
      const addR = await _runGit(cwd, ['add', '-A']);
      if (!addR.ok) return res.status(500).json({ error: 'git add failed: ' + (_redact(addR.stderr) || 'unknown'), stderr: _redact(addR.stderr) });
    }
    const stagedR = await _runGit(cwd, ['diff', '--cached', '--name-only']);
    if (!stagedR.stdout.trim()) {
      return res.status(400).json({ error: 'Nothing to commit. Stage at least one file first.' });
    }
    let commitR = await _runGit(cwd, ['commit', '-m', message]);
    // Identity not configured? Try to repair from the linked GitHub account
    // (or a sensible default), then retry once. This is the #1 cause of 500s
    // on a fresh checkout / fresh machine and the user shouldn't have to drop
    // to a terminal to fix it.
    if (!commitR.ok && /Please tell me who you are|empty ident name|user\.(name|email)/i.test(commitR.stderr || '')) {
      const link = (proj.githubIntegrations || {})[String(req.params.sourceId || '')];
      const acct = link?.accountId ? getGitHubAccountMeta(link.accountId) : null;
      const fallbackName  = acct?.name  || acct?.login || 'Fauna User';
      const fallbackEmail = acct?.email || (acct?.login ? acct.login + '@users.noreply.github.com' : 'fauna@local');
      const setNameR  = await _runGit(cwd, ['config', 'user.name',  fallbackName]);
      const setMailR  = await _runGit(cwd, ['config', 'user.email', fallbackEmail]);
      if (setNameR.ok && setMailR.ok) {
        commitR = await _runGit(cwd, ['commit', '-m', message]);
      }
    }
    if (!commitR.ok) {
      const stderr = _redact(commitR.stderr) || 'unknown error';
      return res.status(500).json({ error: 'git commit failed: ' + stderr, stderr });
    }
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
