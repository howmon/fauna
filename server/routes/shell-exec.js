// server/routes/shell-exec.js
//
// Shell execution routes:
//   POST /api/shell-permission — record an auto-allow decision from the UI
//   POST /api/shell-exec       — run a shell command (JSON or SSE streaming),
//                                gated by the permission guard
//   POST /api/shell-kill       — kill a running shell-exec child by killId
//
// Factory: registerShellExecRoutes(app, deps)
//
// deps:
//   shellProcs        Map<killId, ChildProcess>           — shared with chat tools
//   augmentedPath     string                              — PATH with brew etc.
//   shellBin          string                              — '/bin/zsh' or 'powershell.exe'
//   isWin             boolean
//   getInternalAICaller () => async (prompt, model) => string

import os from 'os';
import { exec as _exec, spawn } from 'child_process';

import { isCommandSafe, addAutoAllow, explainCommand } from '../../permission-guard.js';
import { maybeRegister as registerDevServer, isDevServerCommand } from '../lib/dev-server-registry.js';

export function registerShellExecRoutes(app, {
  shellProcs,
  augmentedPath,
  shellBin,
  isWin,
  getInternalAICaller = () => async () => '',
} = {}) {
  // ── Permission decision endpoint (from inline chat prompt) ──────────────
  app.post('/api/shell-permission', async (req, res) => {
    const { command, decision } = req.body;
    if (!command || !decision) return res.status(400).json({ error: 'command and decision required' });
    if (decision === 'auto-allow') {
      const firstWord = command.trim().split(/\s/)[0];
      addAutoAllow(firstWord);
    }
    res.json({ ok: true });
  });

  app.post('/api/shell-exec', async (req, res) => {
    const { command, cwd, killId, stream, bypassPermissions } = req.body;
    if (!command) return res.status(400).json({ error: 'command required' });

    // Permission guard — check if command is safe or requires approval
    if (!bypassPermissions && !isCommandSafe(command)) {
      // Get explanation and return it to the frontend for inline prompting
      let explanation = '';
      const aiCaller = getInternalAICaller();
      if (aiCaller) {
        try { explanation = await explainCommand(command, aiCaller); } catch (_) {}
      }
      return res.json({ permissionRequired: true, command, explanation });
    }

    const workDir = cwd || os.homedir();
    const env = {
      ...process.env,
      PATH: augmentedPath,
      HOME: os.homedir(),
      USER: os.userInfo().username,
      ...(isWin ? {} : { SHELL: '/bin/zsh', TERM: 'xterm-256color' }),
    };

    // Streaming mode - send SSE events as output arrives
    if (stream) {
      res.setHeader('Content-Type', 'text/event-stream');
      res.setHeader('Cache-Control', 'no-cache');
      res.setHeader('Connection', 'keep-alive');
      res.flushHeaders();

      // Dev servers (npm run dev, vite, next dev, …) should run indefinitely
      // so they show up in the Dev Servers settings page. Killing them at
      // 5min defeats the whole point of the registry.
      const isDev = isDevServerCommand(command);
      const child = spawn(shellBin, isWin ? ['-Command', command] : ['-c', command], {
        cwd: workDir,
        env,
        // 0 = no timeout. For non-dev commands keep the 5min safety net.
        timeout: isDev ? 0 : 300000,
        maxBuffer: 10 * 1024 * 1024,
        stdio: ['pipe', 'pipe', 'pipe']
      });

      // If this looks like a dev server (npm run dev, vite, next dev, …)
      // register it in the global dev-server registry so the user can list /
      // stop / restart it from the UI.
      try { registerDevServer(child, { command, cwd: workDir, killId }); } catch (_) {}

      if (child.stdout) {
        child.stdout.on('data', (chunk) => {
          const text = chunk.toString();
          res.write(`data: ${JSON.stringify({ type: 'stdout', text })}\n\n`);
        });
      }

      if (child.stderr) {
        child.stderr.on('data', (chunk) => {
          const text = chunk.toString();
          res.write(`data: ${JSON.stringify({ type: 'stderr', text })}\n\n`);
        });
      }

      child.on('exit', (code) => {
        if (killId) shellProcs.delete(killId);
        res.write(`data: ${JSON.stringify({ type: 'exit', exitCode: code || 0 })}\n\n`);
        res.end();
      });

      child.on('error', (err) => {
        res.write(`data: ${JSON.stringify({ type: 'error', error: err.message })}\n\n`);
        res.end();
      });

      if (killId) shellProcs.set(killId, child);
      return;
    }

    // Non-streaming mode - wait for completion and return JSON
    const child = _exec(command, { cwd: workDir, env, timeout: 300000, maxBuffer: 10 * 1024 * 1024, shell: shellBin },
      (err, stdout, stderr) => {
        if (killId) shellProcs.delete(killId);
        if (err?.killed && !stdout && !stderr) {
          return res.json({ ok: false, exitCode: 130, stdout: '', stderr: 'Process killed by user', command, cwd: workDir, killed: true });
        }
        res.json({
          ok:       !err || err.killed === false && (err.code === 0 || stdout),
          exitCode: err?.code ?? 0,
          stdout:   stdout || '',
          stderr:   stderr || '',
          command,
          cwd: workDir,
        });
      }
    );
    if (killId) shellProcs.set(killId, child);
    try { registerDevServer(child, { command, cwd: workDir, killId }); } catch (_) {}
  });

  app.post('/api/shell-kill', (req, res) => {
    const { killId } = req.body;
    if (!killId) return res.status(400).json({ error: 'killId required' });
    const child = shellProcs.get(killId);
    if (child) {
      try { child.kill('SIGTERM'); } catch {}
      shellProcs.delete(killId);
      res.json({ ok: true });
    } else {
      res.json({ ok: false, error: 'process not found or already done' });
    }
  });
}
