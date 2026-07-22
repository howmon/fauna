import { describe, expect, it } from 'vitest';
import { detectRequiredUserAction } from '../server/routes/chat.js';
import { normalizeInteractiveAuthCommand } from '../server/lib/interactive-auth.js';
import fs from 'node:fs';
import path from 'node:path';

const clientSource = fs.readFileSync(path.join(process.cwd(), 'public/js/chat.js'), 'utf8');
const serverSource = fs.readFileSync(path.join(process.cwd(), 'server/routes/chat.js'), 'utf8');
const promptSource = fs.readFileSync(path.join(process.cwd(), 'server/prompts/core-guidelines.js'), 'utf8');

describe('normalizeInteractiveAuthCommand()', () => {
  it('forces Cowork device-code auth through the working browser login', () => {
    expect(normalizeInteractiveAuthCommand('fauna_shell_exec', {
      command: 'cowork auth login --device-code',
      cwd: '/tmp/project',
    })).toEqual({
      command: 'cowork auth login',
      cwd: '/tmp/project',
    });
  });

  it('normalizes interactive terminal input too', () => {
    expect(normalizeInteractiveAuthCommand('fauna_terminal', {
      input: 'cowork auth login --device-code',
    })).toEqual({ input: 'cowork auth login' });
  });

  it('does not change unrelated commands', () => {
    const args = { command: 'cowork auth whoami' };
    expect(normalizeInteractiveAuthCommand('fauna_shell_exec', args)).toBe(args);
  });

  it('collapses plain and device-code login attempts to one command identity', () => {
    const plain = normalizeInteractiveAuthCommand('fauna_shell_exec', { command: 'cowork auth login' });
    const deviceCode = normalizeInteractiveAuthCommand('fauna_shell_exec', { command: 'cowork auth login --device-code' });
    expect(JSON.stringify(deviceCode)).toBe(JSON.stringify(plain));
  });
});

describe('detectRequiredUserAction()', () => {
  it('detects a Microsoft device-code prompt', () => {
    const result = detectRequiredUserAction(
      'fauna_shell_exec',
      { command: 'cowork auth login --device-code' },
      'To sign in, use a web browser to open https://login.microsoft.com/device and enter the code B5A7FAKHH to authenticate.',
    );

    expect(result).toMatchObject({
      kind: 'device-code-auth',
      url: 'https://login.microsoft.com/device',
      code: 'B5A7FAKHH',
      options: expect.arrayContaining([expect.objectContaining({ id: 'retry-browser', recommended: true })]),
    });
  });

  it('detects the same prompt from an interactive terminal tool', () => {
    expect(detectRequiredUserAction(
      'fauna_terminal',
      { input: 'cowork auth login --device-code' },
      'Open the page https://login.microsoft.com/device and enter code BH6GYQWED.',
    )).toMatchObject({ kind: 'device-code-auth', code: 'BH6GYQWED' });
  });

  it('accepts the standard Microsoft devicelogin URL', () => {
    expect(detectRequiredUserAction(
      'fauna_shell_exec',
      { command: 'cowork auth login --device-code' },
      'Open https://microsoft.com/devicelogin and use the code Z8K4P2QM.',
    )).toMatchObject({
      kind: 'device-code-auth',
      url: 'https://microsoft.com/devicelogin',
      code: 'Z8K4P2QM',
    });
  });

  it('does not pause for an expired-token error without an active login prompt', () => {
    expect(detectRequiredUserAction(
      'fauna_shell_exec',
      { command: 'cowork auth whoami' },
      'Status: EXPIRED\nNot authenticated. Run: cowork auth login',
    )).toBeNull();
  });

  it('returns a recommended completion step for plain browser login', () => {
    expect(detectRequiredUserAction(
      'fauna_shell_exec',
      { command: 'cowork auth login' },
      'Opening your browser. Complete sign-in to continue.',
    )).toMatchObject({
      kind: 'browser-auth',
      title: 'Complete Cowork sign-in',
      options: expect.arrayContaining([expect.objectContaining({ id: 'completed', recommended: true })]),
    });
  });

  it('does not pause after browser authentication completes', () => {
    expect(detectRequiredUserAction(
      'fauna_shell_exec',
      { command: 'cowork auth login' },
      'Opening your browser. Successfully authenticated.',
    )).toBeNull();
  });
});

describe('required user action client boundary', () => {
  it('blocks auto-feed and plan continuation until a real user turn', () => {
    expect(clientSource).toContain("if (opts.fromAutoFeed && conv._waitingForUserAction)");
    expect(clientSource).toContain("if (evt.type === 'requires_user_action')");
    expect(clientSource).toContain('&& !conv._waitingForUserAction');
    expect(clientSource).toContain('delete conv._waitingForUserAction;');
  });

  it('locks native tools and instructs one final waiting response', () => {
    expect(serverSource).toContain("send({ type: 'requires_user_action', action: requiredAction })");
    expect(serverSource).toContain('toolsLockedForFinalResponse = true;');
    expect(serverSource).toContain('Do not start another login or call more tools');
    expect(promptSource).toContain('Interactive user gates are a valid pause');
    expect(promptSource).toContain('cowork auth login');
    expect(promptSource).toContain('--device-code');
  });
});