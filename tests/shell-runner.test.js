import { describe, it, expect, vi } from 'vitest';
import { runShell, formatShellResultForLLM, isCommandSafe } from '../server/lib/shell-runner.js';

const SHELL_BIN = process.platform === 'win32' ? 'powershell.exe' : '/bin/zsh';
const IS_WIN = process.platform === 'win32';

describe('shell-runner', () => {
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
