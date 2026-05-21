// server/routes/workspace.js
//
// POST /api/workspace/discover — inspects a working directory and returns a
// structured context object (project type, package manager, git status, README
// excerpt, convention/instruction files, top-level structure, test framework).
// Used by the chat client to inject "what kind of project am I in?" context
// into the system prompt.

import os from 'os';
import { exec as _exec } from 'child_process';

export function registerWorkspaceRoutes(app, {
  augmentedPath,
  shellBin,
  loadInstructionFiles,
  configDir,
}) {
  function generateWorkspaceSummary(ctx) {
    const parts = [];
    if (ctx.name) parts.push(`Project: ${ctx.name}`);
    if (ctx.type) parts.push(`Type: ${ctx.type}`);
    if (ctx.packageManager) parts.push(`Package manager: ${ctx.packageManager}`);
    if (ctx.git) {
      parts.push(`Git: branch=${ctx.git.branch}, ${ctx.git.commits} commits`);
      if (ctx.git.remote) parts.push(`Remote: ${ctx.git.remote}`);
      if (ctx.git.status) parts.push(`Uncommitted changes:\n${ctx.git.status}`);
    }
    if (ctx.scripts) {
      const important = ['dev', 'start', 'build', 'test', 'lint', 'format', 'deploy'];
      const found = important.filter(k => ctx.scripts[k]);
      if (found.length) parts.push(`Scripts: ${found.map(k => `${k}="${ctx.scripts[k]}"`).join(', ')}`);
    }
    if (ctx.testFramework) parts.push(`Test framework: ${ctx.testFramework}`);
    if (ctx.hasMakefile) parts.push('Has Makefile');
    if (ctx.hasDocker) parts.push('Has Docker config');
    if (ctx.conventionFiles.length) parts.push(`Convention files: ${ctx.conventionFiles.join(', ')}`);
    if (ctx.instructionFiles?.length) {
      parts.push(`Instruction files loaded: ${ctx.instructionFiles.map(f => f.path + (f.truncated ? ' (truncated)' : '')).join(', ')}`);
    }
    return parts.join('\n');
  }

  app.post('/api/workspace/discover', async (req, res) => {
    const { cwd, includeInterop = true } = req.body;
    const workDir = cwd || os.homedir();
    const run = (cmd) => new Promise((resolve) => {
      _exec(cmd, { cwd: workDir, env: { ...process.env, PATH: augmentedPath }, timeout: 15000, maxBuffer: 2 * 1024 * 1024, shell: shellBin },
        (err, stdout) => resolve(stdout?.trim() || ''));
    });

    try {
      const context = {};

      // Detect project type
      const files = await run('ls -1A 2>/dev/null | head -100');
      const fileList = files.split('\n');

      // Package managers / build systems
      if (fileList.includes('package.json')) {
        try {
          const pkg = JSON.parse(await run('cat package.json'));
          context.type = 'node';
          context.name = pkg.name;
          context.scripts = pkg.scripts || {};
          context.dependencies = Object.keys(pkg.dependencies || {}).length;
          context.devDependencies = Object.keys(pkg.devDependencies || {}).length;
          context.packageManager = pkg.packageManager || (fileList.includes('yarn.lock') ? 'yarn' : fileList.includes('pnpm-lock.yaml') ? 'pnpm' : 'npm');
        } catch (_) {}
      }
      if (fileList.includes('Cargo.toml')) context.type = 'rust';
      if (fileList.includes('go.mod')) context.type = 'go';
      if (fileList.includes('pyproject.toml') || fileList.includes('setup.py') || fileList.includes('requirements.txt')) context.type = 'python';
      if (fileList.includes('Makefile')) context.hasMakefile = true;
      if (fileList.includes('Dockerfile') || fileList.includes('docker-compose.yml')) context.hasDocker = true;
      if (fileList.includes('.github')) context.hasGitHub = true;

      // Git info
      const branch = await run('git rev-parse --abbrev-ref HEAD 2>/dev/null');
      if (branch) {
        context.git = { branch };
        context.git.remote = await run('git remote get-url origin 2>/dev/null');
        context.git.status = await run('git status --short 2>/dev/null');
        const commitCount = await run('git rev-list --count HEAD 2>/dev/null');
        context.git.commits = parseInt(commitCount) || 0;
      }

      // Existing conventions files
      const conventionFiles = [];
      for (const f of ['.github/copilot-instructions.md', 'AGENTS.md', 'CLAUDE.md', '.cursorrules', 'CONTRIBUTING.md', 'ARCHITECTURE.md']) {
        const exists = await run(`test -f "${f}" && echo 1 || echo 0`);
        if (exists === '1') conventionFiles.push(f);
      }
      context.conventionFiles = conventionFiles;
      context.instructionFiles = await loadInstructionFiles(workDir, run, { includeInterop, altConfigDir: configDir });

      // README excerpt
      const readme = await run('head -50 README.md 2>/dev/null');
      if (readme) context.readme = readme.slice(0, 2000);

      // Directory structure (top level)
      const tree = await run('find . -maxdepth 2 -type d -not -path "*/node_modules/*" -not -path "*/.git/*" -not -path "*/dist/*" -not -path "*/__pycache__/*" -not -path "*/.next/*" 2>/dev/null | sort | head -60');
      context.structure = tree;

      // Test framework detection
      if (context.type === 'node' && context.scripts) {
        const testScript = context.scripts.test || '';
        if (testScript.includes('jest')) context.testFramework = 'jest';
        else if (testScript.includes('vitest')) context.testFramework = 'vitest';
        else if (testScript.includes('mocha')) context.testFramework = 'mocha';
        else if (testScript.includes('playwright')) context.testFramework = 'playwright';
      }

      // Generate summary prompt for system injection
      const summary = generateWorkspaceSummary(context);
      context.summary = summary;

      res.json({ ok: true, context });
    } catch (e) {
      res.status(500).json({ ok: false, error: e.message });
    }
  });
}
