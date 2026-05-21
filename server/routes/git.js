// server/routes/git.js
//
// Git-related routes:
//   GET  /api/git/repos        — discover recently-used git repos under $HOME
//   POST /api/git/commit       — LLM-generated commit message + commit
//   POST /api/git/branch-name  — LLM-generated branch name (optionally created)
//
// Factory: registerGitRoutes(app, { augmentedPath, shellBin })

import fs from 'fs';
import os from 'os';
import path from 'path';
import { exec as _exec } from 'child_process';

import { getCopilotClient } from '../copilot/auth.js';

function detectCommitConvention(logOutput) {
  const lines = (logOutput || '').split('\n').filter(Boolean);
  const conventional = lines.filter(l => /^[a-f0-9]+ (feat|fix|chore|docs|style|refactor|test|perf|ci|build|revert)(\(.+\))?:/.test(l));
  if (conventional.length > lines.length * 0.4) return 'Conventional Commits (type(scope): subject)';
  const gitmoji = lines.filter(l => /^[a-f0-9]+ [\u{1F300}-\u{1FAD6}:]/u.test(l));
  if (gitmoji.length > lines.length * 0.3) return 'Gitmoji';
  const ticketed = lines.filter(l => /^[a-f0-9]+ \[?[A-Z]+-\d+\]?/.test(l));
  if (ticketed.length > lines.length * 0.3) return 'Ticket-prefixed (e.g. PROJ-123)';
  return 'Free-form (imperative mood, capitalize first word)';
}

export function registerGitRoutes(app, { augmentedPath, shellBin } = {}) {
  // ── /api/git/repos ──────────────────────────────────────────────────────
  // Find recently-used git repos on the system (for slash commands).
  app.get('/api/git/repos', (req, res) => {
    const home = os.homedir();
    const searchDirs = ['', '/Projects', '/Developer', '/repos', '/src', '/code', '/work', '/Documents', '/Desktop'].map(d => home + d);
    const repos = [];
    const seen = new Set();
    for (const base of searchDirs) {
      if (!fs.existsSync(base)) continue;
      try {
        // Depth 1: direct children with .git
        const entries = fs.readdirSync(base, { withFileTypes: true });
        for (const e of entries) {
          if (!e.isDirectory() || e.name.startsWith('.') || e.name === 'node_modules') continue;
          const full = path.join(base, e.name);
          if (seen.has(full)) continue;
          const gitDir = path.join(full, '.git');
          if (fs.existsSync(gitDir)) {
            seen.add(full);
            let branch = '';
            try { branch = fs.readFileSync(path.join(gitDir, 'HEAD'), 'utf8').trim().replace('ref: refs/heads/', ''); } catch (_) {}
            let mtime = 0;
            try { mtime = fs.statSync(gitDir).mtimeMs; } catch (_) {}
            repos.push({ path: full, name: e.name, branch, mtime });
          }
          // Depth 2: grandchildren
          try {
            const sub = fs.readdirSync(full, { withFileTypes: true });
            for (const s of sub) {
              if (!s.isDirectory() || s.name.startsWith('.') || s.name === 'node_modules') continue;
              const sfull = path.join(full, s.name);
              if (seen.has(sfull)) continue;
              if (fs.existsSync(path.join(sfull, '.git'))) {
                seen.add(sfull);
                let sbranch = '';
                try { sbranch = fs.readFileSync(path.join(sfull, '.git', 'HEAD'), 'utf8').trim().replace('ref: refs/heads/', ''); } catch (_) {}
                let smtime = 0;
                try { smtime = fs.statSync(path.join(sfull, '.git')).mtimeMs; } catch (_) {}
                repos.push({ path: sfull, name: s.name, branch: sbranch, mtime: smtime });
              }
            }
          } catch (_) {}
        }
      } catch (_) {}
    }
    repos.sort((a, b) => b.mtime - a.mtime);
    res.json({ repos: repos.slice(0, 30) });
  });

  // ── /api/git/commit ─────────────────────────────────────────────────────
  // Detect repo convention, generate message from diff via LLM, commit.
  app.post('/api/git/commit', async (req, res) => {
    const { cwd, amend = false, stageAll = false } = req.body;
    const workDir = cwd || os.homedir();
    const run = (cmd) => new Promise((resolve) => {
      _exec(cmd, { cwd: workDir, env: { ...process.env, PATH: augmentedPath }, timeout: 30000, maxBuffer: 5 * 1024 * 1024, shell: shellBin },
        (err, stdout, stderr) => resolve({ ok: !err, stdout: stdout || '', stderr: stderr || '', exitCode: err?.code ?? 0 }));
    });

    try {
      // 1. Check status
      const status = await run('git status --porcelain');
      if (!status.stdout.trim() && !amend) return res.json({ ok: false, error: 'Nothing to commit — working tree clean.' });

      // 2. Stage if needed
      const staged = await run('git diff --cached --name-only');
      if (!staged.stdout.trim()) {
        if (stageAll || !staged.stdout.trim()) await run('git add -A');
        const recheck = await run('git diff --cached --name-only');
        if (!recheck.stdout.trim()) return res.json({ ok: false, error: 'No changes to commit after staging.' });
      }

      // 3. Detect convention from recent commits
      const recentLog = await run('git log --oneline -20 2>/dev/null');
      const userLog = await run('git log --oneline --author="$(git config user.name)" -10 2>/dev/null');

      // 4. Get diff
      const diffStat = await run('git diff --cached --stat');
      const diff = await run('git diff --cached');
      const diffText = diff.stdout.slice(0, 8000); // cap for LLM context

      // 5. Generate commit message via LLM
      const client = getCopilotClient();
      const conventionHint = detectCommitConvention(recentLog.stdout);
      const genMessages = [
        { role: 'system', content: `You are an expert at writing concise, meaningful git commit messages. Analyse the diff and write a commit message following the repository's convention.\n\nConvention detected: ${conventionHint}\n\nRules:\n- Subject line ≤ 72 chars, follow the convention\n- Optional body explains WHY, not a file-by-file inventory\n- Reference issue/ticket numbers from branch names when visible\n- Output ONLY the commit message (subject + optional body separated by blank line). No markdown, no fencing, no explanation.` },
        { role: 'user', content: `Recent commits:\n${recentLog.stdout.slice(0, 1500)}\n\nUser commits:\n${userLog.stdout.slice(0, 1000)}\n\nDiff stat:\n${diffStat.stdout}\n\nDiff:\n${diffText}` }
      ];
      const completion = await client.chat.completions.create({ model: 'gpt-4.1-mini', messages: genMessages, max_tokens: 300, stream: false });
      let commitMsg = (completion.choices[0]?.message?.content || '').trim();
      if (!commitMsg) return res.json({ ok: false, error: 'LLM returned empty commit message.' });

      // Clean quotes if wrapped
      if (commitMsg.startsWith('"') && commitMsg.endsWith('"')) commitMsg = commitMsg.slice(1, -1);

      // 6. Commit
      const msgParts = commitMsg.split(/\n\n/);
      const subject = msgParts[0];
      const body = msgParts.slice(1).join('\n\n');
      let commitCmd = `git commit -m ${JSON.stringify(subject)}`;
      if (body) commitCmd += ` -m ${JSON.stringify(body)}`;
      if (amend) commitCmd += ' --amend';
      const commitResult = await run(commitCmd);

      // 7. Verify
      const verify = await run('git log --oneline -1');
      res.json({
        ok: commitResult.ok,
        message: commitMsg,
        commitHash: verify.stdout.trim().split(' ')[0],
        output: commitResult.stdout + commitResult.stderr,
        convention: conventionHint,
      });
    } catch (e) {
      res.status(500).json({ ok: false, error: e.message });
    }
  });

  // ── /api/git/branch-name ────────────────────────────────────────────────
  app.post('/api/git/branch-name', async (req, res) => {
    const { description, cwd } = req.body;
    if (!description) return res.status(400).json({ error: 'description required' });
    try {
      const client = getCopilotClient();
      const completion = await client.chat.completions.create({
        model: 'gpt-4.1-mini',
        messages: [
          { role: 'system', content: 'You are an expert in crafting pithy branch names for Git repos. Given a task description, reply with ONLY a brief branch name (8-50 chars, lowercase, alphanumeric + hyphens only). No quotes, no explanation.' },
          { role: 'user', content: description }
        ],
        max_tokens: 60,
        stream: false,
      });
      let name = (completion.choices[0]?.message?.content || '').trim().replace(/[^a-zA-Z0-9-]/g, '').toLowerCase();
      if (name.length < 4) name = 'feature-' + name;
      if (name.length > 50) name = name.slice(0, 50);

      // Optionally create the branch
      if (req.body.create && cwd) {
        const result = await new Promise((resolve) => {
          _exec(`git checkout -b ${name}`, { cwd, env: { ...process.env, PATH: augmentedPath }, shell: shellBin },
            (err, stdout, stderr) => resolve({ ok: !err, stdout, stderr }));
        });
        return res.json({ ok: result.ok, name, created: result.ok, output: result.stdout + result.stderr });
      }

      res.json({ ok: true, name });
    } catch (e) {
      res.status(500).json({ ok: false, error: e.message });
    }
  });
}
