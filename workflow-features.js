import fs from 'fs';
import os from 'os';
import path from 'path';
import { exec as _exec } from 'child_process';
import { spawn } from 'child_process';

const DEFAULT_FEATURES = {
  githubWorkbench: { stage: 'experimental', enabled: true, description: 'GitHub repo, issue, PR, and branch metadata endpoints' },
  reviewMode: { stage: 'beta', enabled: true, description: 'Dedicated local diff, commit, base branch, and PR review endpoints' },
  taskQueue: { stage: 'experimental', enabled: true, description: 'Local-first task queue for detached coding work' },
  mcpRegistry: { stage: 'experimental', enabled: true, description: 'General MCP server registry and auth management' },
  pluginMarketplace: { stage: 'experimental', enabled: true, description: 'Installable plugin marketplaces for agents, MCP servers, and prompt packs' },
  sessionForking: { stage: 'experimental', enabled: true, description: 'Resume and fork sessions with repo/task metadata' },
  promptDebugger: { stage: 'beta', enabled: true, description: 'Prompt and tool registry inspection endpoints' },
};

function parseJsonObject(text) {
  const raw = (text || '').trim().replace(/^```(?:json)?\s*/i, '').replace(/```$/i, '').trim();
  try { return JSON.parse(raw); } catch (_) {}
  const start = raw.indexOf('{');
  const end = raw.lastIndexOf('}');
  if (start !== -1 && end > start) return JSON.parse(raw.slice(start, end + 1));
  throw new Error('Model did not return valid JSON.');
}



function normalizeReviewResult(result) {
  const findings = Array.isArray(result.findings) ? result.findings : [];
  return {
    summary: String(result.summary || 'Review completed.'),
    findings: findings.map(f => ({
      severity: ['critical', 'high', 'medium', 'low'].includes(String(f.severity || '').toLowerCase()) ? String(f.severity).toLowerCase() : 'medium',
      file: String(f.file || ''),
      line: Number.isFinite(Number(f.line)) ? Number(f.line) : 0,
      title: String(f.title || 'Finding'),
      details: String(f.details || ''),
      suggestedPatch: f.suggestedPatch ? String(f.suggestedPatch) : undefined,
    })),
    testGaps: Array.isArray(result.testGaps) ? result.testGaps.map(String) : [],
    residualRisk: String(result.residualRisk || ''),
  };
}


function parseGitHubRemote(remote) {
  const value = (remote || '').trim();
  if (!value) return null;
  let match = value.match(/^git@github\.com:([^/]+)\/([^/]+?)(?:\.git)?$/i);
  if (!match) match = value.match(/^ssh:\/\/git@github\.com\/([^/]+)\/([^/]+?)(?:\.git)?$/i);
  if (!match) match = value.match(/^https?:\/\/github\.com\/([^/]+)\/([^/]+?)(?:\.git)?(?:\/)?$/i);
  if (!match) return null;
  return { owner: match[1], repo: match[2].replace(/\.git$/i, ''), remote: value };
}

function isSafeGitRef(value) {
  return /^[A-Za-z0-9._/-]{1,120}$/.test(value || '') && !value.startsWith('-') && !value.includes('..') && !value.includes('//');
}

function parsePositiveInteger(value, label) {
  const number = Number.parseInt(value, 10);
  if (!Number.isInteger(number) || number <= 0) {
    const err = new Error(label + ' must be a positive integer.');
    err.statusCode = 400;
    throw err;
  }
  return number;
}

function requiredString(value, label, maxLength = 65536) {
  const text = String(value || '').trim();
  if (!text) {
    const err = new Error(label + ' is required.');
    err.statusCode = 400;
    throw err;
  }
  if (text.length > maxLength) {
    const err = new Error(label + ' is too long.');
    err.statusCode = 400;
    throw err;
  }
  return text;
}

function safeKey(value, label = 'Name') {
  const text = requiredString(value, label, 120);
  if (!/^[A-Za-z0-9._-]+$/.test(text)) {
    const err = new Error(label + ' may contain only letters, numbers, dot, underscore, and dash.');
    err.statusCode = 400;
    throw err;
  }
  return text;
}

function newId(prefix) {
  return prefix + '-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8);
}

function nowIso() {
  return new Date().toISOString();
}

function redactValue(value) {
  if (typeof value !== 'string') return value;
  if (/token|secret|password|key/i.test(value)) return '[redacted]';
  if (value.length > 12 && /^(ghp_|github_pat_|sk-|Bearer\s+)/i.test(value)) return value.slice(0, 4) + '...' + value.slice(-4);
  return value;
}

export function registerWorkflowFeatureRoutes(options) {
  const {
    app,
    configDir,
    getGhToken,
    getCopilotClient,
    readSavedConfig,
    loadInstructionFiles,
    augmentedPath,
    shellBin,
  } = options;

  const featuresFile = path.join(configDir, 'features.json');
  const tasksFile = path.join(configDir, 'tasks.json');
  const mcpServersFile = path.join(configDir, 'mcp-servers.json');
  const pluginsFile = path.join(configDir, 'plugins.json');
  const sessionsFile = path.join(configDir, 'sessions.json');
  const mcpProcesses = new Map();

  function readStore(file, fallback) {
    try {
      const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
      return parsed && typeof parsed === 'object' ? { ...fallback, ...parsed } : fallback;
    } catch (_) {
      return structuredClone(fallback);
    }
  }

  function writeStore(file, data) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = file + '.' + process.pid + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
    fs.renameSync(tmp, file);
  }

  function taskStore() { return readStore(tasksFile, { tasks: [] }); }
  function writeTaskStore(data) { writeStore(tasksFile, data); }
  function mcpStore() { return readStore(mcpServersFile, { servers: [] }); }
  function writeMcpStore(data) { writeStore(mcpServersFile, data); }
  function pluginStore() { return readStore(pluginsFile, { marketplaces: [], installed: [] }); }
  function writePluginStore(data) { writeStore(pluginsFile, data); }
  function sessionStore() { return readStore(sessionsFile, { sessions: [] }); }
  function writeSessionStore(data) { writeStore(sessionsFile, data); }

  function findRecord(records, id, label) {
    const record = records.find(item => item.id === id || item.name === id);
    if (!record) {
      const err = new Error(label + ' not found.');
      err.statusCode = 404;
      throw err;
    }
    return record;
  }

  function readFeatureConfig() {
    let saved = {};
    try { saved = JSON.parse(fs.readFileSync(featuresFile, 'utf8')).features || {}; }
    catch (_) {}
    const features = {};
    for (const [name, defaults] of Object.entries(DEFAULT_FEATURES)) {
      features[name] = { ...defaults, ...(saved[name] || {}) };
    }
    for (const [name, value] of Object.entries(saved)) {
      if (!features[name]) features[name] = value;
    }
    return { features };
  }

  function writeFeatureConfig(data) {
    fs.mkdirSync(configDir, { recursive: true });
    fs.writeFileSync(featuresFile, JSON.stringify(data, null, 2));
  }

  function requireFeature(name, res) {
    const feature = readFeatureConfig().features[name];
    if (feature && feature.enabled === false) {
      res.status(404).json({ ok: false, error: 'Feature disabled: ' + name, feature });
      return false;
    }
    return true;
  }

  function runGit(cwd, cmd, opts = {}) {
    const workDir = cwd || os.homedir();
    return new Promise((resolve) => {
      _exec(cmd, {
        cwd: workDir,
        env: { ...process.env, PATH: augmentedPath },
        timeout: opts.timeout || 30000,
        maxBuffer: opts.maxBuffer || 5 * 1024 * 1024,
        shell: shellBin,
      }, (err, stdout, stderr) => resolve({ ok: !err, stdout: stdout || '', stderr: stderr || '', exitCode: err?.code ?? 0 }));
    });
  }

  async function resolveGitHubRepo(cwd) {
    const remote = await runGit(cwd, 'git remote get-url origin 2>/dev/null');
    const parsed = parseGitHubRemote(remote.stdout);
    if (!parsed) {
      const err = new Error('No GitHub origin remote found for this repository.');
      err.statusCode = 404;
      throw err;
    }
    const branch = await runGit(cwd, 'git rev-parse --abbrev-ref HEAD 2>/dev/null');
    const root = await runGit(cwd, 'git rev-parse --show-toplevel 2>/dev/null');
    return { ...parsed, branch: branch.stdout.trim(), root: root.stdout.trim() };
  }

  async function githubJson(apiPath, requestOptions = {}) {
    const token = getGhToken();
    const url = apiPath.startsWith('http') ? apiPath : 'https://api.github.com' + apiPath;
    const response = await fetch(url, {
      method: requestOptions.method || 'GET',
      headers: {
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        Authorization: 'Bearer ' + token,
        ...(requestOptions.headers || {}),
      },
      body: requestOptions.body ? JSON.stringify(requestOptions.body) : undefined,
    });
    const text = await response.text();
    let data = null;
    try { data = text ? JSON.parse(text) : null; } catch (_) { data = text; }
    if (!response.ok) {
      const err = new Error((data && data.message) || ('GitHub request failed: HTTP ' + response.status));
      err.statusCode = response.status;
      err.github = data;
      throw err;
    }
    return data;
  }

  function sendApiError(res, e) {
    res.status(e.statusCode || 500).json({ ok: false, error: e.message });
  }

  async function currentBranch(cwd) {
    const branch = await runGit(cwd, 'git rev-parse --abbrev-ref HEAD 2>/dev/null');
    if (!branch.ok || !branch.stdout.trim()) {
      const err = new Error('Unable to resolve the current git branch.');
      err.statusCode = 400;
      throw err;
    }
    return branch.stdout.trim();
  }

  async function collectReviewContext(cwd) {
    const runText = async (cmd) => (await runGit(cwd, cmd, { maxBuffer: 8 * 1024 * 1024 })).stdout.trim();
    const instructions = await loadInstructionFiles(cwd || os.homedir(), runText).catch(() => []);
    const repo = await resolveGitHubRepo(cwd || os.homedir()).catch(() => null);
    return { instructions, repo };
  }

  async function runStructuredReview(input, opts = {}) {
    const client = getCopilotClient();
    const instructionText = (input.instructions || []).map(f => `### ${f.path}\n${(f.content || '').slice(0, 3000)}`).join('\n\n');
    const messages = [
      { role: 'system', content: `You are a senior code reviewer. Return ONLY valid JSON with this shape: {"summary":"string","findings":[{"severity":"critical|high|medium|low","file":"string","line":0,"title":"string","details":"string","suggestedPatch":"optional apply_patch text"}],"testGaps":["string"],"residualRisk":"string"}. Prioritize correctness bugs, regressions, security issues, data loss, broken edge cases, and missing tests. Do not invent line numbers; use 0 when unknown. Suggested patches must use the app's *** Begin Patch format and must be minimal.` },
      { role: 'user', content: `Review target: ${input.target}\nRepository: ${input.repo ? input.repo.owner + '/' + input.repo.repo : 'unknown'}\n\nRepository instructions:\n${instructionText || '(none loaded)'}\n\nChanged files:\n${input.files || '(unknown)'}\n\nDiff stat:\n${input.stat || '(none)'}\n\nDiff/content:\n${(input.diff || '').slice(0, opts.maxDiffChars || 60000)}` },
    ];
    const completion = await client.chat.completions.create({
      model: opts.model || 'gpt-4.1-mini',
      messages,
      max_tokens: opts.maxTokens || 1800,
      temperature: 0.1,
      stream: false,
    });
    const text = completion.choices[0]?.message?.content || '';
    return normalizeReviewResult(parseJsonObject(text));
  }

  async function reviewLocalDiff(req, res, target, commands) {
    if (!requireFeature('reviewMode', res)) return;
    const cwd = req.body.cwd || os.homedir();
    try {
      const [stat, diff, files, context] = await Promise.all([
        runGit(cwd, commands.stat, { maxBuffer: 2 * 1024 * 1024 }),
        runGit(cwd, commands.diff, { maxBuffer: 12 * 1024 * 1024 }),
        runGit(cwd, commands.files, { maxBuffer: 2 * 1024 * 1024 }),
        collectReviewContext(cwd),
      ]);
      if (!diff.stdout.trim()) return res.json({ ok: false, error: 'No diff found for ' + target + '.' });
      const review = await runStructuredReview({
        target,
        stat: stat.stdout,
        diff: diff.stdout,
        files: files.stdout,
        instructions: context.instructions,
        repo: context.repo,
      }, { model: req.body.model });
      res.json({ ok: true, target, cwd, review });
    } catch (e) { sendApiError(res, e); }
  }

  app.get('/api/features', (req, res) => {
    res.json({ ok: true, ...readFeatureConfig() });
  });

  app.post('/api/features/:name/enable', (req, res) => {
    const config = readFeatureConfig();
    const current = config.features[req.params.name] || { stage: 'custom', description: '' };
    config.features[req.params.name] = { ...current, enabled: true };
    writeFeatureConfig(config);
    res.json({ ok: true, feature: config.features[req.params.name] });
  });

  app.post('/api/features/:name/disable', (req, res) => {
    const config = readFeatureConfig();
    const current = config.features[req.params.name] || { stage: 'custom', description: '' };
    config.features[req.params.name] = { ...current, enabled: false };
    writeFeatureConfig(config);
    res.json({ ok: true, feature: config.features[req.params.name] });
  });

  app.get('/api/github/auth/status', (req, res) => {
    if (!requireFeature('githubWorkbench', res)) return;
    try {
      const token = getGhToken();
      const cfg = readSavedConfig();
      const source = cfg.pat ? 'pat' : (process.env.GH_TOKEN || process.env.GITHUB_TOKEN) ? 'env' : 'keychain-or-gh';
      res.json({ ok: true, authenticated: true, preview: token.slice(0, 4) + '...' + token.slice(-4), source });
    } catch (e) {
      res.json({ ok: true, authenticated: false, error: e.message });
    }
  });

  app.get('/api/github/repo', async (req, res) => {
    if (!requireFeature('githubWorkbench', res)) return;
    try {
      const repo = await resolveGitHubRepo(req.query.cwd || os.homedir());
      let meta = null;
      try { meta = await githubJson(`/repos/${encodeURIComponent(repo.owner)}/${encodeURIComponent(repo.repo)}`); }
      catch (_) {}
      res.json({ ok: true, repo: { ...repo, defaultBranch: meta?.default_branch, private: meta?.private, htmlUrl: meta?.html_url } });
    } catch (e) { sendApiError(res, e); }
  });

  app.get('/api/github/repos/:owner/:repo', async (req, res) => {
    if (!requireFeature('githubWorkbench', res)) return;
    try {
      const data = await githubJson(`/repos/${encodeURIComponent(req.params.owner)}/${encodeURIComponent(req.params.repo)}`);
      res.json({ ok: true, repo: data });
    } catch (e) { sendApiError(res, e); }
  });

  app.get('/api/github/repos/:owner/:repo/default-branch', async (req, res) => {
    if (!requireFeature('githubWorkbench', res)) return;
    try {
      const data = await githubJson(`/repos/${encodeURIComponent(req.params.owner)}/${encodeURIComponent(req.params.repo)}`);
      res.json({ ok: true, defaultBranch: data.default_branch });
    } catch (e) { sendApiError(res, e); }
  });

  app.get('/api/github/repos/:owner/:repo/branches', async (req, res) => {
    if (!requireFeature('githubWorkbench', res)) return;
    try {
      const data = await githubJson(`/repos/${encodeURIComponent(req.params.owner)}/${encodeURIComponent(req.params.repo)}/branches?per_page=100`);
      res.json({ ok: true, branches: data });
    } catch (e) { sendApiError(res, e); }
  });

  app.get('/api/github/repos/:owner/:repo/issues', async (req, res) => {
    if (!requireFeature('githubWorkbench', res)) return;
    try {
      const params = new URLSearchParams({ state: req.query.state || 'open', per_page: String(Math.min(parseInt(req.query.per_page) || 30, 100)) });
      if (req.query.assignee) params.set('assignee', req.query.assignee);
      if (req.query.labels) params.set('labels', req.query.labels);
      const data = await githubJson(`/repos/${encodeURIComponent(req.params.owner)}/${encodeURIComponent(req.params.repo)}/issues?${params}`);
      res.json({ ok: true, issues: data.filter(item => !item.pull_request) });
    } catch (e) { sendApiError(res, e); }
  });

  app.get('/api/github/repos/:owner/:repo/pulls', async (req, res) => {
    if (!requireFeature('githubWorkbench', res)) return;
    try {
      const params = new URLSearchParams({ state: req.query.state || 'open', per_page: String(Math.min(parseInt(req.query.per_page) || 30, 100)) });
      const data = await githubJson(`/repos/${encodeURIComponent(req.params.owner)}/${encodeURIComponent(req.params.repo)}/pulls?${params}`);
      res.json({ ok: true, pulls: data });
    } catch (e) { sendApiError(res, e); }
  });

  app.get('/api/github/repos/:owner/:repo/pulls/:number', async (req, res) => {
    if (!requireFeature('githubWorkbench', res)) return;
    try {
      const owner = encodeURIComponent(req.params.owner);
      const repo = encodeURIComponent(req.params.repo);
      const number = encodeURIComponent(req.params.number);
      const [pull, files] = await Promise.all([
        githubJson(`/repos/${owner}/${repo}/pulls/${number}`),
        githubJson(`/repos/${owner}/${repo}/pulls/${number}/files?per_page=100`),
      ]);
      res.json({ ok: true, pull, files });
    } catch (e) { sendApiError(res, e); }
  });

  app.post('/api/github/repos/:owner/:repo/pulls', async (req, res) => {
    if (!requireFeature('githubWorkbench', res)) return;
    try {
      const title = requiredString(req.body.title, 'PR title', 256);
      const head = requiredString(req.body.head, 'PR head branch', 256);
      const base = requiredString(req.body.base, 'PR base branch', 256);
      const body = req.body.body == null ? '' : String(req.body.body).slice(0, 65536);
      const payload = {
        title,
        head,
        base,
        body,
        draft: Boolean(req.body.draft),
        maintainer_can_modify: req.body.maintainer_can_modify !== false,
      };
      const data = await githubJson(`/repos/${encodeURIComponent(req.params.owner)}/${encodeURIComponent(req.params.repo)}/pulls`, {
        method: 'POST',
        body: payload,
      });
      res.json({ ok: true, pull: data });
    } catch (e) { sendApiError(res, e); }
  });

  app.post('/api/github/repos/:owner/:repo/issues/:number/comments', async (req, res) => {
    if (!requireFeature('githubWorkbench', res)) return;
    try {
      const number = parsePositiveInteger(req.params.number, 'Issue or PR number');
      const body = requiredString(req.body.body, 'Comment body');
      const data = await githubJson(`/repos/${encodeURIComponent(req.params.owner)}/${encodeURIComponent(req.params.repo)}/issues/${number}/comments`, {
        method: 'POST',
        body: { body },
      });
      res.json({ ok: true, comment: data });
    } catch (e) { sendApiError(res, e); }
  });

  app.post('/api/github/repos/:owner/:repo/pulls/:number/reviews', async (req, res) => {
    if (!requireFeature('githubWorkbench', res)) return;
    try {
      const number = parsePositiveInteger(req.params.number, 'PR number');
      const event = String(req.body.event || 'COMMENT').toUpperCase();
      if (!['COMMENT', 'APPROVE', 'REQUEST_CHANGES'].includes(event)) {
        return res.status(400).json({ ok: false, error: 'Review event must be COMMENT, APPROVE, or REQUEST_CHANGES.' });
      }
      const payload = {
        event,
        body: req.body.body == null ? '' : String(req.body.body).slice(0, 65536),
      };
      if (Array.isArray(req.body.comments) && req.body.comments.length) {
        payload.comments = req.body.comments.slice(0, 100).map(comment => ({
          path: requiredString(comment.path, 'Review comment path', 1024),
          position: parsePositiveInteger(comment.position, 'Review comment position'),
          body: requiredString(comment.body, 'Review comment body'),
        }));
      }
      if (req.body.commit_id) payload.commit_id = String(req.body.commit_id).trim();
      const data = await githubJson(`/repos/${encodeURIComponent(req.params.owner)}/${encodeURIComponent(req.params.repo)}/pulls/${number}/reviews`, {
        method: 'POST',
        body: payload,
      });
      res.json({ ok: true, review: data });
    } catch (e) { sendApiError(res, e); }
  });

  app.post('/api/git/checkout-pr', async (req, res) => {
    if (!requireFeature('githubWorkbench', res)) return;
    try {
      const cwd = req.body.cwd || os.homedir();
      const number = parsePositiveInteger(req.body.number, 'PR number');
      const remote = req.body.remote ? String(req.body.remote).trim() : 'origin';
      const branch = req.body.branch ? String(req.body.branch).trim() : 'pr-' + number;
      if (!isSafeGitRef(remote)) return res.status(400).json({ ok: false, error: 'Unsafe remote name.' });
      if (!isSafeGitRef(branch)) return res.status(400).json({ ok: false, error: 'Unsafe branch name.' });
      const result = await runGit(cwd, `git fetch ${remote} pull/${number}/head:${branch} && git checkout ${branch}`, { timeout: 120000 });
      res.status(result.ok ? 200 : 500).json({ ok: result.ok, cwd, branch, stdout: result.stdout, stderr: result.stderr, exitCode: result.exitCode });
    } catch (e) { sendApiError(res, e); }
  });

  app.post('/api/git/push-branch', async (req, res) => {
    if (!requireFeature('githubWorkbench', res)) return;
    try {
      const cwd = req.body.cwd || os.homedir();
      const remote = req.body.remote ? String(req.body.remote).trim() : 'origin';
      const branch = req.body.branch ? String(req.body.branch).trim() : await currentBranch(cwd);
      if (!isSafeGitRef(remote)) return res.status(400).json({ ok: false, error: 'Unsafe remote name.' });
      if (!isSafeGitRef(branch)) return res.status(400).json({ ok: false, error: 'Unsafe branch name.' });
      const upstream = req.body.setUpstream === false ? '' : '-u ';
      const result = await runGit(cwd, `git push ${upstream}${remote} ${branch}`, { timeout: 120000 });
      res.status(result.ok ? 200 : 500).json({ ok: result.ok, cwd, branch, remote, stdout: result.stdout, stderr: result.stderr, exitCode: result.exitCode });
    } catch (e) { sendApiError(res, e); }
  });

  app.post('/api/workflow/tasks', async (req, res) => {
    if (!requireFeature('taskQueue', res)) return;
    try {
      const prompt = requiredString(req.body.prompt, 'Task prompt');
      const repo = req.body.repo ? path.resolve(String(req.body.repo)) : '';
      const createdAt = nowIso();
      let repoInfo = null;
      if (repo) repoInfo = await resolveGitHubRepo(repo).catch(() => null);
      const task = {
        id: newId('task'),
        repo,
        ownerRepo: repoInfo ? repoInfo.owner + '/' + repoInfo.repo : String(req.body.ownerRepo || ''),
        branch: String(req.body.branch || repoInfo?.branch || ''),
        baseBranch: String(req.body.baseBranch || req.body.base || 'main'),
        prompt,
        mode: String(req.body.mode || 'local'),
        status: 'queued',
        attempts: [{ id: newId('attempt'), status: 'queued', logs: ['Task queued locally.'], createdAt, updatedAt: createdAt }],
        createdAt,
        updatedAt: createdAt,
      };
      const store = taskStore();
      store.tasks.unshift(task);
      writeTaskStore(store);
      res.json({ ok: true, task });
    } catch (e) { sendApiError(res, e); }
  });

  app.get('/api/workflow/tasks', (req, res) => {
    if (!requireFeature('taskQueue', res)) return;
    const store = taskStore();
    const repo = req.query.repo ? path.resolve(String(req.query.repo)) : '';
    const tasks = repo ? store.tasks.filter(task => task.repo === repo) : store.tasks;
    res.json({ ok: true, tasks });
  });

  app.get('/api/workflow/tasks/:id', (req, res) => {
    if (!requireFeature('taskQueue', res)) return;
    try { res.json({ ok: true, task: findRecord(taskStore().tasks, req.params.id, 'Task') }); }
    catch (e) { sendApiError(res, e); }
  });

  app.post('/api/workflow/tasks/:id/cancel', (req, res) => {
    if (!requireFeature('taskQueue', res)) return;
    try {
      const store = taskStore();
      const task = findRecord(store.tasks, req.params.id, 'Task');
      if (!['succeeded', 'failed', 'applied', 'rejected'].includes(task.status)) task.status = 'cancelled';
      task.updatedAt = nowIso();
      writeTaskStore(store);
      res.json({ ok: true, task });
    } catch (e) { sendApiError(res, e); }
  });

  app.post('/api/workflow/tasks/:id/retry', (req, res) => {
    if (!requireFeature('taskQueue', res)) return;
    try {
      const store = taskStore();
      const task = findRecord(store.tasks, req.params.id, 'Task');
      const ts = nowIso();
      task.status = 'queued';
      task.attempts = task.attempts || [];
      task.attempts.push({ id: newId('attempt'), status: 'queued', logs: ['Task retry queued locally.'], createdAt: ts, updatedAt: ts });
      task.updatedAt = ts;
      writeTaskStore(store);
      res.json({ ok: true, task });
    } catch (e) { sendApiError(res, e); }
  });

  app.get('/api/workflow/tasks/:id/diff', async (req, res) => {
    if (!requireFeature('taskQueue', res)) return;
    try {
      const task = findRecord(taskStore().tasks, req.params.id, 'Task');
      if (!task.repo) return res.json({ ok: true, diff: '', stat: '', files: '' });
      const [stat, diff, files] = await Promise.all([
        runGit(task.repo, 'git diff --stat', { maxBuffer: 2 * 1024 * 1024 }),
        runGit(task.repo, 'git diff --no-ext-diff --find-renames', { maxBuffer: 12 * 1024 * 1024 }),
        runGit(task.repo, 'git diff --name-status', { maxBuffer: 2 * 1024 * 1024 }),
      ]);
      res.json({ ok: true, taskId: task.id, stat: stat.stdout, diff: diff.stdout, files: files.stdout });
    } catch (e) { sendApiError(res, e); }
  });

  app.post('/api/workflow/tasks/:id/apply', (req, res) => {
    if (!requireFeature('taskQueue', res)) return;
    try {
      const store = taskStore();
      const task = findRecord(store.tasks, req.params.id, 'Task');
      task.status = 'applied';
      task.updatedAt = nowIso();
      writeTaskStore(store);
      res.json({ ok: true, task });
    } catch (e) { sendApiError(res, e); }
  });

  app.post('/api/workflow/tasks/:id/reject', (req, res) => {
    if (!requireFeature('taskQueue', res)) return;
    try {
      const store = taskStore();
      const task = findRecord(store.tasks, req.params.id, 'Task');
      task.status = 'rejected';
      task.rejectReason = req.body.reason ? String(req.body.reason).slice(0, 2000) : '';
      task.updatedAt = nowIso();
      writeTaskStore(store);
      res.json({ ok: true, task });
    } catch (e) { sendApiError(res, e); }
  });

  function normalizeMcpServer(input, existing = {}) {
    const name = safeKey(input.name || existing.name, 'MCP server name');
    const type = String(input.type || existing.type || (input.url ? 'http' : 'stdio')).toLowerCase();
    if (!['stdio', 'http'].includes(type)) {
      const err = new Error('MCP server type must be stdio or http.');
      err.statusCode = 400;
      throw err;
    }
    const server = {
      ...existing,
      name,
      type,
      command: input.command == null ? existing.command || '' : String(input.command),
      args: Array.isArray(input.args) ? input.args.map(String) : existing.args || [],
      url: input.url == null ? existing.url || '' : String(input.url),
      env: input.env && typeof input.env === 'object' ? input.env : existing.env || {},
      bearerTokenEnvVar: input.bearerTokenEnvVar == null ? existing.bearerTokenEnvVar || '' : String(input.bearerTokenEnvVar),
      oauth: input.oauth && typeof input.oauth === 'object' ? input.oauth : existing.oauth || { enabled: false, scopes: [] },
      enabled: input.enabled == null ? existing.enabled !== false : Boolean(input.enabled),
      updatedAt: nowIso(),
    };
    if (type === 'stdio' && !server.command) throw Object.assign(new Error('stdio MCP servers require a command.'), { statusCode: 400 });
    if (type === 'http' && !/^https?:\/\//i.test(server.url)) throw Object.assign(new Error('http MCP servers require an http(s) URL.'), { statusCode: 400 });
    return server;
  }

  app.get('/api/mcp/servers', (req, res) => {
    if (!requireFeature('mcpRegistry', res)) return;
    const servers = mcpStore().servers.map(server => ({ ...server, running: mcpProcesses.has(server.name) }));
    res.json({ ok: true, servers });
  });

  app.post('/api/mcp/servers', (req, res) => {
    if (!requireFeature('mcpRegistry', res)) return;
    try {
      const store = mcpStore();
      const server = { ...normalizeMcpServer(req.body), createdAt: nowIso() };
      if (store.servers.some(item => item.name === server.name)) return res.status(409).json({ ok: false, error: 'MCP server already exists.' });
      store.servers.push(server);
      writeMcpStore(store);
      res.json({ ok: true, server });
    } catch (e) { sendApiError(res, e); }
  });

  app.get('/api/mcp/servers/:name', (req, res) => {
    if (!requireFeature('mcpRegistry', res)) return;
    try {
      const server = findRecord(mcpStore().servers, req.params.name, 'MCP server');
      res.json({ ok: true, server: { ...server, running: mcpProcesses.has(server.name) } });
    } catch (e) { sendApiError(res, e); }
  });

  app.put('/api/mcp/servers/:name', (req, res) => {
    if (!requireFeature('mcpRegistry', res)) return;
    try {
      const store = mcpStore();
      const idx = store.servers.findIndex(item => item.name === req.params.name);
      if (idx === -1) throw Object.assign(new Error('MCP server not found.'), { statusCode: 404 });
      store.servers[idx] = normalizeMcpServer({ ...req.body, name: req.params.name }, store.servers[idx]);
      writeMcpStore(store);
      res.json({ ok: true, server: store.servers[idx] });
    } catch (e) { sendApiError(res, e); }
  });

  app.delete('/api/mcp/servers/:name', (req, res) => {
    if (!requireFeature('mcpRegistry', res)) return;
    try {
      if (mcpProcesses.has(req.params.name)) mcpProcesses.get(req.params.name).kill('SIGTERM');
      const store = mcpStore();
      store.servers = store.servers.filter(item => item.name !== req.params.name);
      writeMcpStore(store);
      res.json({ ok: true });
    } catch (e) { sendApiError(res, e); }
  });

  app.post('/api/mcp/servers/:name/start', (req, res) => {
    if (!requireFeature('mcpRegistry', res)) return;
    try {
      const server = findRecord(mcpStore().servers, req.params.name, 'MCP server');
      if (server.type === 'http') return res.json({ ok: true, server: { ...server, running: true, mode: 'http' } });
      if (mcpProcesses.has(server.name)) return res.json({ ok: true, already: true, server: { ...server, running: true } });
      const child = spawn(server.command, server.args || [], {
        cwd: req.body.cwd || os.homedir(),
        env: { ...process.env, ...server.env, PATH: augmentedPath },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      const logs = [];
      const remember = chunk => {
        String(chunk || '').split(/\r?\n/).filter(Boolean).forEach(line => {
          logs.push({ t: Date.now(), msg: line });
          if (logs.length > 200) logs.shift();
        });
      };
      child.stdout.on('data', remember);
      child.stderr.on('data', remember);
      child.on('exit', (code, signal) => {
        remember('[App] MCP server exited: ' + (signal || code));
        mcpProcesses.delete(server.name);
      });
      mcpProcesses.set(server.name, child);
      child._faunaLogs = logs;
      res.json({ ok: true, server: { ...server, running: true, pid: child.pid } });
    } catch (e) { sendApiError(res, e); }
  });

  app.post('/api/mcp/servers/:name/stop', (req, res) => {
    if (!requireFeature('mcpRegistry', res)) return;
    const child = mcpProcesses.get(req.params.name);
    if (child) child.kill('SIGTERM');
    mcpProcesses.delete(req.params.name);
    res.json({ ok: true });
  });

  app.get('/api/mcp/servers/:name/tools', (req, res) => {
    if (!requireFeature('mcpRegistry', res)) return;
    try {
      const server = findRecord(mcpStore().servers, req.params.name, 'MCP server');
      const child = mcpProcesses.get(server.name);
      res.json({ ok: true, server: server.name, tools: server.tools || [], running: Boolean(child) || server.type === 'http', logs: child?._faunaLogs || [] });
    } catch (e) { sendApiError(res, e); }
  });

  app.post('/api/mcp/servers/:name/login', (req, res) => {
    if (!requireFeature('mcpRegistry', res)) return;
    try {
      const store = mcpStore();
      const server = findRecord(store.servers, req.params.name, 'MCP server');
      server.oauth = { ...(server.oauth || {}), enabled: true, status: 'login-required', scopes: Array.isArray(req.body.scopes) ? req.body.scopes.map(String) : server.oauth?.scopes || [] };
      server.updatedAt = nowIso();
      writeMcpStore(store);
      res.json({ ok: true, server, message: 'OAuth browser flow is not embedded yet; server is marked login-required.' });
    } catch (e) { sendApiError(res, e); }
  });

  app.post('/api/mcp/servers/:name/logout', (req, res) => {
    if (!requireFeature('mcpRegistry', res)) return;
    try {
      const store = mcpStore();
      const server = findRecord(store.servers, req.params.name, 'MCP server');
      server.oauth = { ...(server.oauth || {}), status: 'logged-out' };
      server.updatedAt = nowIso();
      writeMcpStore(store);
      res.json({ ok: true, server });
    } catch (e) { sendApiError(res, e); }
  });

  function normalizeMarketplace(input, existing = {}) {
    const id = safeKey(input.id || existing.id || newId('market'), 'Marketplace id');
    return {
      ...existing,
      id,
      name: requiredString(input.name || existing.name || id, 'Marketplace name', 200),
      url: input.url == null ? existing.url || '' : String(input.url),
      enabled: input.enabled == null ? existing.enabled !== false : Boolean(input.enabled),
      updatedAt: nowIso(),
    };
  }

  function normalizePluginManifest(input) {
    const manifest = input.manifest && typeof input.manifest === 'object' ? input.manifest : input;
    const name = safeKey(manifest.name, 'Plugin name');
    const type = String(manifest.type || 'bundle');
    if (!['agent', 'mcp', 'prompt-pack', 'ui-extension', 'bundle'].includes(type)) throw Object.assign(new Error('Invalid plugin type.'), { statusCode: 400 });
    return {
      id: safeKey(manifest.id || name, 'Plugin id'),
      name,
      version: String(manifest.version || '0.0.0'),
      type,
      description: String(manifest.description || ''),
      author: String(manifest.author || ''),
      permissions: manifest.permissions && typeof manifest.permissions === 'object' ? manifest.permissions : {},
      entrypoints: manifest.entrypoints && typeof manifest.entrypoints === 'object' ? manifest.entrypoints : {},
      install: manifest.install && typeof manifest.install === 'object' ? manifest.install : {},
      signature: manifest.signature ? String(manifest.signature) : '',
    };
  }

  app.get('/api/plugins/marketplaces', (req, res) => {
    if (!requireFeature('pluginMarketplace', res)) return;
    res.json({ ok: true, marketplaces: pluginStore().marketplaces });
  });

  app.post('/api/plugins/marketplaces', (req, res) => {
    if (!requireFeature('pluginMarketplace', res)) return;
    try {
      const store = pluginStore();
      const marketplace = { ...normalizeMarketplace(req.body), createdAt: nowIso() };
      if (store.marketplaces.some(item => item.id === marketplace.id)) return res.status(409).json({ ok: false, error: 'Marketplace already exists.' });
      store.marketplaces.push(marketplace);
      writePluginStore(store);
      res.json({ ok: true, marketplace });
    } catch (e) { sendApiError(res, e); }
  });

  app.post('/api/plugins/marketplaces/:id/upgrade', (req, res) => {
    if (!requireFeature('pluginMarketplace', res)) return;
    try {
      const store = pluginStore();
      const marketplace = findRecord(store.marketplaces, req.params.id, 'Marketplace');
      marketplace.lastSyncedAt = nowIso();
      marketplace.syncStatus = 'manual-sync-recorded';
      writePluginStore(store);
      res.json({ ok: true, marketplace });
    } catch (e) { sendApiError(res, e); }
  });

  app.delete('/api/plugins/marketplaces/:id', (req, res) => {
    if (!requireFeature('pluginMarketplace', res)) return;
    const store = pluginStore();
    store.marketplaces = store.marketplaces.filter(item => item.id !== req.params.id);
    writePluginStore(store);
    res.json({ ok: true });
  });

  app.get('/api/plugins/search', (req, res) => {
    if (!requireFeature('pluginMarketplace', res)) return;
    const q = String(req.query.q || '').toLowerCase();
    const installed = pluginStore().installed;
    const results = q ? installed.filter(plugin => [plugin.name, plugin.description, plugin.type].join(' ').toLowerCase().includes(q)) : installed;
    res.json({ ok: true, results });
  });

  app.post('/api/plugins/install', (req, res) => {
    if (!requireFeature('pluginMarketplace', res)) return;
    try {
      const manifest = normalizePluginManifest(req.body);
      const store = pluginStore();
      const installed = { ...manifest, enabled: req.body.enabled === true, installedAt: nowIso(), updatedAt: nowIso(), trusted: Boolean(req.body.trusted) };
      const idx = store.installed.findIndex(plugin => plugin.id === installed.id);
      if (idx === -1) store.installed.push(installed);
      else store.installed[idx] = { ...store.installed[idx], ...installed };
      writePluginStore(store);
      res.json({ ok: true, plugin: installed });
    } catch (e) { sendApiError(res, e); }
  });

  app.post('/api/plugins/:id/disable', (req, res) => {
    if (!requireFeature('pluginMarketplace', res)) return;
    try {
      const store = pluginStore();
      const plugin = findRecord(store.installed, req.params.id, 'Plugin');
      plugin.enabled = false;
      plugin.updatedAt = nowIso();
      writePluginStore(store);
      res.json({ ok: true, plugin });
    } catch (e) { sendApiError(res, e); }
  });

  app.post('/api/plugins/:id/enable', (req, res) => {
    if (!requireFeature('pluginMarketplace', res)) return;
    try {
      const store = pluginStore();
      const plugin = findRecord(store.installed, req.params.id, 'Plugin');
      plugin.enabled = true;
      plugin.updatedAt = nowIso();
      writePluginStore(store);
      res.json({ ok: true, plugin });
    } catch (e) { sendApiError(res, e); }
  });

  app.delete('/api/plugins/:id', (req, res) => {
    if (!requireFeature('pluginMarketplace', res)) return;
    const store = pluginStore();
    store.installed = store.installed.filter(plugin => plugin.id !== req.params.id);
    writePluginStore(store);
    res.json({ ok: true });
  });

  app.get('/api/sessions', (req, res) => {
    if (!requireFeature('sessionForking', res)) return;
    const repo = req.query.repo ? path.resolve(String(req.query.repo)) : '';
    const sessions = sessionStore().sessions.filter(session => !repo || session.cwd === repo || session.repo === repo);
    res.json({ ok: true, sessions });
  });

  app.post('/api/sessions', async (req, res) => {
    if (!requireFeature('sessionForking', res)) return;
    try {
      const cwd = req.body.cwd ? path.resolve(String(req.body.cwd)) : '';
      const repoInfo = cwd ? await resolveGitHubRepo(cwd).catch(() => null) : null;
      const ts = nowIso();
      const session = {
        id: req.body.id ? safeKey(req.body.id, 'Session id') : newId('session'),
        title: String(req.body.title || 'Workflow session'),
        cwd,
        repo: repoInfo ? repoInfo.owner + '/' + repoInfo.repo : String(req.body.repo || ''),
        branch: String(req.body.branch || repoInfo?.branch || ''),
        activeAgent: String(req.body.activeAgent || ''),
        instructionFiles: Array.isArray(req.body.instructionFiles) ? req.body.instructionFiles : [],
        taskIds: Array.isArray(req.body.taskIds) ? req.body.taskIds.map(String) : [],
        timeline: Array.isArray(req.body.timeline) ? req.body.timeline : [{ t: ts, type: 'created' }],
        createdAt: ts,
        updatedAt: ts,
      };
      const store = sessionStore();
      store.sessions.unshift(session);
      writeSessionStore(store);
      res.json({ ok: true, session });
    } catch (e) { sendApiError(res, e); }
  });

  app.get('/api/sessions/:id', (req, res) => {
    if (!requireFeature('sessionForking', res)) return;
    try { res.json({ ok: true, session: findRecord(sessionStore().sessions, req.params.id, 'Session') }); }
    catch (e) { sendApiError(res, e); }
  });

  app.post('/api/sessions/:id/resume', (req, res) => {
    if (!requireFeature('sessionForking', res)) return;
    try {
      const store = sessionStore();
      const session = findRecord(store.sessions, req.params.id, 'Session');
      session.lastResumedAt = nowIso();
      session.resumePrompt = req.body.prompt ? String(req.body.prompt).slice(0, 20000) : '';
      writeSessionStore(store);
      res.json({ ok: true, session });
    } catch (e) { sendApiError(res, e); }
  });

  app.post('/api/sessions/:id/fork', (req, res) => {
    if (!requireFeature('sessionForking', res)) return;
    try {
      const store = sessionStore();
      const base = findRecord(store.sessions, req.params.id, 'Session');
      const ts = nowIso();
      const fork = { ...base, id: newId('session'), parentId: base.id, title: String(req.body.title || base.title || 'Forked session'), timeline: [...(base.timeline || []), { t: ts, type: 'forked', from: base.id }], createdAt: ts, updatedAt: ts };
      store.sessions.unshift(fork);
      writeSessionStore(store);
      res.json({ ok: true, session: fork });
    } catch (e) { sendApiError(res, e); }
  });

  app.get('/api/sessions/:id/timeline', (req, res) => {
    if (!requireFeature('sessionForking', res)) return;
    try {
      const session = findRecord(sessionStore().sessions, req.params.id, 'Session');
      res.json({ ok: true, timeline: session.timeline || [] });
    } catch (e) { sendApiError(res, e); }
  });

  app.post('/api/sessions/:id/timeline', (req, res) => {
    if (!requireFeature('sessionForking', res)) return;
    try {
      const store = sessionStore();
      const session = findRecord(store.sessions, req.params.id, 'Session');
      const event = { t: nowIso(), type: String(req.body.type || 'event'), data: req.body.data || null };
      session.timeline = session.timeline || [];
      session.timeline.push(event);
      session.updatedAt = event.t;
      writeSessionStore(store);
      res.json({ ok: true, event, timeline: session.timeline });
    } catch (e) { sendApiError(res, e); }
  });

  app.post('/api/debug/prompt-input', async (req, res) => {
    if (!requireFeature('promptDebugger', res)) return;
    try {
      const cwd = req.body.cwd || os.homedir();
      const userPrompt = req.body.prompt ? String(req.body.prompt) : '';
      const instructions = await loadInstructionFiles(cwd, async cmd => (await runGit(cwd, cmd, { maxBuffer: 8 * 1024 * 1024 })).stdout.trim()).catch(() => []);
      const blocks = [
        { name: 'system', content: String(req.body.systemPrompt || '') },
        { name: 'workspace', content: String(req.body.workspaceContext || '') },
        ...instructions.map(file => ({ name: 'instruction:' + file.path, content: file.content || '', metadata: { path: file.path, priority: file.priority, scope: file.scope } })),
        { name: 'user', content: userPrompt },
      ].filter(block => block.content || block.name === 'user');
      const redacted = blocks.map(block => ({ ...block, content: block.content.replace(/(ghp_|github_pat_|sk-)[A-Za-z0-9_\-]+/g, '[redacted-token]') }));
      res.json({ ok: true, cwd, blocks: redacted, estimatedTokens: Math.ceil(redacted.map(block => block.content).join('\n').length / 4) });
    } catch (e) { sendApiError(res, e); }
  });

  app.get('/api/debug/features', (req, res) => {
    if (!requireFeature('promptDebugger', res)) return;
    res.json({ ok: true, ...readFeatureConfig() });
  });

  app.post('/api/debug/app-message', (req, res) => {
    if (!requireFeature('promptDebugger', res)) return;
    const message = {
      id: newId('debug-msg'),
      type: String(req.body.type || 'message'),
      payload: req.body.payload && typeof req.body.payload === 'object' ? JSON.parse(JSON.stringify(req.body.payload, (k, v) => /token|secret|password|key/i.test(k) ? '[redacted]' : redactValue(v))) : redactValue(String(req.body.payload || '')),
      createdAt: nowIso(),
    };
    const debugFile = path.join(configDir, 'debug-messages.json');
    const store = readStore(debugFile, { messages: [] });
    store.messages.unshift(message);
    store.messages = store.messages.slice(0, 200);
    writeStore(debugFile, store);
    res.json({ ok: true, message });
  });

  app.get('/api/debug/tool-registry', (req, res) => {
    if (!requireFeature('promptDebugger', res)) return;
    const workflowTools = [
      '/api/features', '/api/github/repo', '/api/review/uncommitted', '/api/review/pr',
      '/api/workflow/tasks', '/api/mcp/servers', '/api/plugins/search', '/api/sessions', '/api/debug/prompt-input'
    ];
    res.json({ ok: true, features: readFeatureConfig().features, workflowTools, mcpServers: mcpStore().servers.map(server => ({ name: server.name, type: server.type, enabled: server.enabled, running: mcpProcesses.has(server.name) })) });
  });

  app.post('/api/review/uncommitted', async (req, res) => {
    await reviewLocalDiff(req, res, 'uncommitted changes', {
      stat: 'git diff --stat && git ls-files --others --exclude-standard | sed "s/^/? /"',
      diff: 'git diff --no-ext-diff --find-renames',
      files: 'git diff --name-status && git ls-files --others --exclude-standard | sed "s/^/?\t/"',
    });
  });

  app.post('/api/review/staged', async (req, res) => {
    await reviewLocalDiff(req, res, 'staged changes', {
      stat: 'git diff --cached --stat',
      diff: 'git diff --cached --no-ext-diff --find-renames',
      files: 'git diff --cached --name-status',
    });
  });

  app.post('/api/review/base', async (req, res) => {
    const base = (req.body.base || 'main').replace(/[^a-zA-Z0-9_./-]/g, '');
    await reviewLocalDiff(req, res, 'changes against ' + base, {
      stat: `git diff --stat ${base}...HEAD`,
      diff: `git diff --no-ext-diff --find-renames ${base}...HEAD`,
      files: `git diff --name-status ${base}...HEAD`,
    });
  });

  app.post('/api/review/commit', async (req, res) => {
    const sha = String(req.body.commit || '').trim();
    if (!/^[a-f0-9]{7,40}$/i.test(sha)) return res.status(400).json({ ok: false, error: 'Valid commit SHA required.' });
    await reviewLocalDiff(req, res, 'commit ' + sha, {
      stat: `git show --stat --format=medium ${sha}`,
      diff: `git show --format=fuller --no-ext-diff --find-renames ${sha}`,
      files: `git diff-tree --no-commit-id --name-status -r ${sha}`,
    });
  });

  app.post('/api/review/pr', async (req, res) => {
    if (!requireFeature('reviewMode', res)) return;
    const number = parseInt(req.body.number, 10);
    if (!number) return res.status(400).json({ ok: false, error: 'PR number required.' });
    try {
      const cwd = req.body.cwd || os.homedir();
      const repo = req.body.owner && req.body.repo ? { owner: req.body.owner, repo: req.body.repo } : await resolveGitHubRepo(cwd);
      const owner = encodeURIComponent(repo.owner);
      const repoName = encodeURIComponent(repo.repo);
      const [pull, files, context] = await Promise.all([
        githubJson(`/repos/${owner}/${repoName}/pulls/${number}`),
        githubJson(`/repos/${owner}/${repoName}/pulls/${number}/files?per_page=100`),
        collectReviewContext(cwd),
      ]);
      const diff = files.map(f => `diff --git a/${f.filename} b/${f.filename}\n${f.patch || '(binary or patch unavailable)'}`).join('\n\n');
      const stat = files.map(f => `${f.status}\t${f.filename}\t+${f.additions}/-${f.deletions}`).join('\n');
      const review = await runStructuredReview({
        target: `PR #${number}: ${pull.title}`,
        stat,
        diff,
        files: files.map(f => f.filename).join('\n'),
        instructions: context.instructions,
        repo,
      }, { model: req.body.model });
      res.json({ ok: true, target: 'PR #' + number, pull: { title: pull.title, htmlUrl: pull.html_url, state: pull.state, user: pull.user?.login }, review });
    } catch (e) { sendApiError(res, e); }
  });
}