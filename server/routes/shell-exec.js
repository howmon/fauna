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

import { addAutoAllow } from '../../permission-guard.js';
import {
  maybeRegister as registerDevServer,
  isDevServerCommand,
  waitForStartup,
} from '../lib/dev-server-registry.js';
import { normalizeInteractiveAuthCommand } from '../lib/interactive-auth.js';

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
    const { command: requestedCommand, cwd, killId, stream } = req.body;
    const command = normalizeInteractiveAuthCommand('fauna_shell_exec', { command: requestedCommand }).command;
    if (!command) return res.status(400).json({ error: 'command required' });

    // (No permission gate. The user explicitly chose autonomy — anything the
    // model emits via /api/shell-exec runs immediately.)

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
      let _regId = null;
      try {
        _regId = registerDevServer(child, { command, cwd: workDir, killId });
      } catch (_) {}

      // For dev servers: detach immediately. Otherwise the SSE stream stays
      // open forever, the input bar pill stays orange, and the user can't
      // send another message in the same conversation. The child keeps
      // running inside the registry; the user manages it from Settings →
      // Dev Servers. Pipe a tiny note back so the widget records a result.
      if (isDev) {
        if (killId) shellProcs.delete(killId);
        const startup = _regId
          ? await waitForStartup(_regId, { timeoutMs: 8000 })
          : { status: 'missing', exitCode: null, port: null, tail: [] };
        const verified = startup.status === 'running';
        const failed = startup.status === 'exited' || startup.status === 'stopped' || startup.status === 'missing';
        const message = verified
          ? `Dev server is running${startup.port ? ` on port ${startup.port}` : ''}. Manage it from the Running dev servers indicator.`
          : failed
            ? `Dev server failed during startup${startup.tail.length ? `: ${startup.tail.at(-1)}` : '.'}`
            : 'Dev server launched in the background, but readiness is not yet verified. Check Settings → Dev Servers.';
        // IMPORTANT: do NOT call removeAllListeners('data') on stdout/stderr
        // here — the registry already attached its own listeners to sniff the
        // port and stream tail buffer. Stripping them would (a) blind the
        // registry and (b) cause the child to eventually exit because its
        // stdout buffer fills with no reader, dropping the entry from list().
        res.write(`data: ${JSON.stringify({
          type: 'dev_server_detached',
          id: _regId,
          command,
          cwd: workDir,
          status: startup.status,
          verified,
          port: startup.port,
          message,
        })}\n\n`);
        res.write(`data: ${JSON.stringify({
          type: 'exit',
          exitCode: verified ? 0 : failed ? (startup.exitCode ?? 1) : null,
          detached: true,
        })}\n\n`);
        res.end();
        return;
      }

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
