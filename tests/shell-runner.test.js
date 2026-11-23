import { describe, it, expect, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runShell, stopShellProcess, formatShellResultForLLM, isCommandSafe, effectiveShellTimeout, isUnboundedRecursiveSearch } from '../server/lib/shell-runner.js';
import { registerShellExecRoutes } from '../server/routes/shell-exec.js';

const SHELL_BIN = process.platform === 'win32' ? 'powershell.exe' : '/bin/zsh';
const IS_WIN = process.platform === 'win32';

describe('shell-runner', () => {
  describe('effectiveShellTimeout()', () => {
    it('caps recursive discovery commands at 30 seconds', () => {
      expect(effectiveShellTimeout('grep -r "rail" .', 300000)).toBe(30000);
      expect(effectiveShellTimeout('find . -name "*.tsx"', undefined)).toBe(30000);
    });

    it('preserves longer timeouts for builds and focused commands', () => {
      expect(effectiveShellTimeout('npm run build', 300000)).toBe(300000);
      expect(effectiveShellTimeout('rg "rail" src', undefined)).toBe(180000);
    });
  });

  describe('isUnboundedRecursiveSearch()', () => {
    it('detects broad grep and find discovery without blocking focused tools', () => {
      expect(isUnboundedRecursiveSearch('grep -r "rail" src')).toBe(true);
      expect(isUnboundedRecursiveSearch('find src -name "*.tsx"')).toBe(true);
      expect(isUnboundedRecursiveSearch('rg "rail" src')).toBe(false);
      expect(isUnboundedRecursiveSearch('git grep "rail"')).toBe(false);
    });
  });

  describe('runShell()', () => {
    it('captures stdout from a simple command', async () => {
      const result = await runShell({
        command: 'echo hello-world',
        shellBin: SHELL_BIN,
        isWin: IS_WIN,
      });
      expect(result.ok).toBe(true);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('hello-world');
      expect(result.killed).toBe(false);
      expect(result.timedOut).toBe(false);
    });

    it('captures stderr and non-zero exit', async () => {
      const result = await runShell({
        command: 'echo oops 1>&2; exit 7',
        shellBin: SHELL_BIN,
        isWin: IS_WIN,
      });
      expect(result.ok).toBe(false);
      expect(result.exitCode).toBe(7);
      expect(result.stderr).toContain('oops');
    });

    it('streams chunks via onChunk callback', async () => {
      const chunks = [];
      await runShell({
        command: 'echo first; echo second',
        shellBin: SHELL_BIN,
        isWin: IS_WIN,
        onChunk: (kind, text) => chunks.push({ kind, text }),
      });
      const stdoutText = chunks.filter((c) => c.kind === 'stdout').map((c) => c.text).join('');
      expect(stdoutText).toContain('first');
      expect(stdoutText).toContain('second');
    });

    it('honors AbortSignal — kills child and reports killed=true', async () => {
      const controller = new AbortController();
      const pending = runShell({
        command: 'sleep 30',
        shellBin: SHELL_BIN,
        isWin: IS_WIN,
        signal: controller.signal,
      });
      setTimeout(() => controller.abort(), 50);
      const result = await pending;
      expect(result.killed).toBe(true);
      expect(result.ok).toBe(false);
    });

    it('enforces timeoutMs', async () => {
      const result = await runShell({
        command: 'sleep 30',
        shellBin: SHELL_BIN,
        isWin: IS_WIN,
        timeoutMs: 100,
      });
      expect(result.timedOut).toBe(true);
      expect(result.ok).toBe(false);
    });

    it.skipIf(IS_WIN).each(['timeout', 'abort', 'stop', 'shell-exit'])(
      'terminates SIGTERM-resistant descendants after %s', async mode => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fauna-process-tree-'));
        const pidFile = path.join(dir, 'worker.pid');
        let workerPid;
        try {
          fs.writeFileSync(path.join(dir, 'worker.cjs'),
            "process.on('SIGTERM', () => {}); require('fs').writeFileSync('worker.pid', String(process.pid)); console.log('ready'); setInterval(() => {}, 1000);\n");
          fs.writeFileSync(path.join(dir, 'parent.cjs'),
            "process.on('SIGTERM', () => {}); require('child_process').spawn(process.execPath, ['worker.cjs'], { stdio: 'inherit' }); setInterval(() => {}, 1000);\n");
          const node = "'" + process.execPath.replace(/'/g, "'\\''") + "'";
          const controller = new AbortController();
          let shell;
          const result = await runShell({
            command: mode === 'shell-exit'
              ? node + " worker.cjs >/dev/null & while [ ! -s worker.pid ]; do sleep 0.02; done; exit 0"
              : node + ' parent.cjs',
            cwd: dir, shellBin: SHELL_BIN, isWin: IS_WIN,
            timeoutMs: mode === 'timeout' ? 1000 : 5000,
            signal: controller.signal,
            registerChild: child => { shell = child; },
            onChunk: (_kind, text) => {
              if (!text.includes('ready')) return;
              if (mode === 'abort') controller.abort();
              if (mode === 'stop') stopShellProcess(shell);
            },
          });
          workerPid = Number(fs.readFileSync(pidFile, 'utf8'));
          expect(result.ok).toBe(false);
          expect(result.timedOut).toBe(mode === 'timeout');
          if (mode === 'shell-exit') expect(result.stderr).toContain('child processes still running');
          await vi.waitFor(() => {
            expect(() => process.kill(workerPid, 0)).toThrow();
          }, { timeout: 3000, interval: 25 });
        } finally {
          if (!workerPid && fs.existsSync(pidFile)) workerPid = Number(fs.readFileSync(pidFile, 'utf8'));
          if (workerPid) {
            try { process.kill(workerPid, 'SIGKILL'); }
            catch (error) { if (error.code !== 'ESRCH') throw error; }
          }
          fs.rmSync(dir, { recursive: true, force: true });
        }
      }, 8000,
    );

    it('truncates output beyond maxOutputChars', async () => {
      const result = await runShell({
        // emit a large stdout
        command: 'yes a | head -c 5000',
        shellBin: SHELL_BIN,
        isWin: IS_WIN,
        maxOutputChars: 100,
      });
      expect(result.stdoutTruncated).toBe(true);
      expect(result.stdout.length).toBeLessThanOrEqual(100);
    });

    it('rejects when command is missing', async () => {
      await expect(runShell({ shellBin: SHELL_BIN, isWin: IS_WIN })).rejects.toThrow(/command required/);
    });

    it('calls registerChild with the spawned process', async () => {
      const registerChild = vi.fn();
      await runShell({
        command: 'echo ok',
        shellBin: SHELL_BIN,
        isWin: IS_WIN,
        registerChild,
      });
      expect(registerChild).toHaveBeenCalledTimes(1);
      const child = registerChild.mock.calls[0][0];
      expect(child).toBeDefined();
      expect(typeof child.kill).toBe('function');
    });
  });

  describe('formatShellResultForLLM()', () => {
    it('renders exit code and both streams', () => {
      const out = formatShellResultForLLM({
        exitCode: 0,
        stdout: 'hi\n',
        stderr: '',
        killed: false,
        timedOut: false,
        stdoutTruncated: false,
        stderrTruncated: false,
      });
      expect(out).toContain('exit=0');
      expect(out).toContain('--- stdout ---');
      expect(out).toContain('hi');
    });

    describe('inline shell Stop route', () => {
      it.each([false, true])('stops a managed command and reports failure with stream=%s', async stream => {
        const routes = new Map();
        const shellProcs = new Map();
        registerShellExecRoutes({ post: (url, handler) => routes.set(url, handler) }, {
          shellProcs, shellBin: SHELL_BIN, isWin: IS_WIN, augmentedPath: process.env.PATH,
        });
        const res = {
          chunks: [], writableEnded: false,
          setHeader() {}, flushHeaders() {},
          write(chunk) { this.chunks.push(chunk); },
          end() { this.writableEnded = true; },
          json(body) { this.body = body; },
        };
        const pending = routes.get('/api/shell-exec')({
          body: { command: IS_WIN ? 'Start-Sleep -Seconds 30' : 'sleep 30', killId: 'managed', stream },
        }, res);
        await vi.waitFor(() => expect(shellProcs.has('managed')).toBe(true));
        const stopResponse = { json: vi.fn() };
        routes.get('/api/shell-kill')({ body: { killId: 'managed' } }, stopResponse);
        await pending;
        expect(stopResponse.json).toHaveBeenCalledWith({ ok: true });
        expect(shellProcs.size).toBe(0);
        if (stream) {
          expect(res.writableEnded).toBe(true);
          expect(res.chunks.join('')).toContain('"killed":true');
        } else {
          expect(res.body).toMatchObject({ ok: false, killed: true });
        }
      });
    });

    it('surfaces killed / timed_out / truncated flags', () => {
      const out = formatShellResultForLLM({
        exitCode: 130,
        stdout: '',
        stderr: '',
        killed: true,
        timedOut: true,
        stdoutTruncated: true,
        stderrTruncated: true,
      });
      expect(out).toContain('killed');
      expect(out).toContain('timed_out');
      expect(out).toContain('stdout_truncated');
      expect(out).toContain('stderr_truncated');
    });

    it('truncates very long combined output to maxChars', () => {
      const big = 'x'.repeat(50000);
      const out = formatShellResultForLLM(
        { exitCode: 0, stdout: big, stderr: '', killed: false, timedOut: false, stdoutTruncated: false, stderrTruncated: false },
        { maxChars: 200 },
      );
      expect(out.length).toBeLessThan(400);
      expect(out).toMatch(/truncated/);
    });
  });

  describe('isCommandSafe re-export', () => {
    it('allows benign commands', () => {
      expect(isCommandSafe('echo hi')).toBe(true);
      expect(isCommandSafe('ls -la')).toBe(true);
    });

    it('blocks destructive commands', () => {
      expect(isCommandSafe('rm -rf /')).toBe(false);
      expect(isCommandSafe('sudo apt-get install foo')).toBe(false);
    });
  });
});
