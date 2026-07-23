import { describe, expect, it } from 'vitest';
import { detectRequiredUserAction, extractEmbeddedUserAction } from '../server/routes/chat.js';
import { normalizeInteractiveAuthCommand } from '../server/lib/interactive-auth.js';
import { executeSelfTool, SELF_TOOL_DEFS } from '../self-tools.js';
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

describe('fauna_ask_user_decision self-tool', () => {
  const validArgs = {
    title: 'Create a new Figma page?',
    prompt: 'The script would create a new page called "Onboarding". Put it on the current page instead, or confirm the new page?',
    options: [
      {
        id: 'use-current',
        label: 'Use the current page',
        description: 'Redo the design on figma.currentPage.',
        recommended: true,
        response: 'Do NOT create a new page. Re-run the previous figma_execute call so it builds on figma.currentPage.',
      },
      {
        id: 'confirm-new',
        label: 'Create new page "Onboarding"',
        response: 'Yes, create the new page as planned.',
      },
    ],
  };

  it('is registered in SELF_TOOL_DEFS with a required schema', () => {
    const def = SELF_TOOL_DEFS.find(d => d.function?.name === 'fauna_ask_user_decision');
    expect(def).toBeTruthy();
    expect(def.function.parameters.required).toEqual(expect.arrayContaining(['title', 'prompt', 'options']));
  });

  it('returns a paused payload with an action envelope', async () => {
    const raw = await executeSelfTool('fauna_ask_user_decision', validArgs, {});
    const parsed = JSON.parse(raw);
    expect(parsed).toMatchObject({
      ok: true,
      paused: true,
      code: 'AWAITING_USER_DECISION',
      action: expect.objectContaining({
        kind: 'agent-decision',
        title: validArgs.title,
        prompt: validArgs.prompt,
        allowCustom: true,
        options: expect.arrayContaining([
          expect.objectContaining({ id: 'use-current', recommended: true }),
          expect.objectContaining({ id: 'confirm-new' }),
        ]),
      }),
    });
  });

  it('rejects malformed calls', async () => {
    const missing = JSON.parse(await executeSelfTool('fauna_ask_user_decision', { title: 't', prompt: 'p', options: [] }, {}));
    expect(missing).toMatchObject({ ok: false });
    const oneOpt = JSON.parse(await executeSelfTool('fauna_ask_user_decision', {
      title: 't', prompt: 'p',
      options: [{ id: 'a', label: 'A', response: 'r' }],
    }, {}));
    expect(oneOpt).toMatchObject({ ok: false });
    const badOptions = JSON.parse(await executeSelfTool('fauna_ask_user_decision', {
      title: 't', prompt: 'p',
      options: [{ id: 'a', label: 'A' }, { id: 'b', label: 'B' }], // no response
    }, {}));
    expect(badOptions).toMatchObject({ ok: false });
  });

  it('drops duplicate ids and enforces at most one recommended option', async () => {
    const raw = await executeSelfTool('fauna_ask_user_decision', {
      title: 't', prompt: 'p',
      options: [
        { id: 'a', label: 'A', response: 'ra', recommended: true },
        { id: 'a', label: 'dup', response: 'dup' },
        { id: 'b', label: 'B', response: 'rb', recommended: true },
      ],
    }, {});
    const parsed = JSON.parse(raw);
    expect(parsed.action.options).toHaveLength(2);
    const recCount = parsed.action.options.filter(o => o.recommended).length;
    expect(recCount).toBe(1);
    expect(parsed.action.options[0].recommended).toBe(true);
  });
});

describe('extractEmbeddedUserAction()', () => {
  it('returns null for non-JSON or unrelated payloads', () => {
    expect(extractEmbeddedUserAction('not json', 'x')).toBeNull();
    expect(extractEmbeddedUserAction(JSON.stringify({ ok: true }), 'x')).toBeNull();
    expect(extractEmbeddedUserAction(JSON.stringify({ paused: true }), 'x')).toBeNull();
  });

  it('normalizes a well-formed paused envelope', () => {
    const raw = JSON.stringify({
      paused: true,
      action: {
        title: 'Overwrite existing file?',
        prompt: 'foo.txt already exists.',
        options: [
          { id: 'skip', label: 'Skip', response: 'Do not overwrite.' },
          { id: 'over', label: 'Overwrite', response: 'Overwrite it.', recommended: true },
        ],
      },
    });
    const action = extractEmbeddedUserAction(raw, 'fauna_write_file');
    expect(action).toMatchObject({
      kind: 'agent-decision',
      title: 'Overwrite existing file?',
      toolName: 'fauna_write_file',
      allowCustom: true,
      options: [
        expect.objectContaining({ id: 'skip' }),
        expect.objectContaining({ id: 'over', recommended: true }),
      ],
    });
  });

  it('accepts the AWAITING_USER_DECISION code as an alternate signal', () => {
    const raw = JSON.stringify({
      ok: true,
      code: 'AWAITING_USER_DECISION',
      action: {
        title: 't', prompt: 'p',
        options: [
          { id: 'a', label: 'A', response: 'ra' },
          { id: 'b', label: 'B', response: 'rb' },
        ],
      },
    });
    expect(extractEmbeddedUserAction(raw, 'anything')).toBeTruthy();
  });
});

describe('detectRequiredUserAction() + tool-driven pause', () => {
  it('surfaces the embedded action from a fauna_ask_user_decision result', async () => {
    const raw = await executeSelfTool('fauna_ask_user_decision', {
      title: 'Delete branch main?',
      prompt: 'This will remove the main branch locally.',
      options: [
        { id: 'cancel', label: 'Cancel', response: 'Do not delete anything.', recommended: true },
        { id: 'delete', label: 'Delete', response: 'Yes, delete it.' },
      ],
    }, {});
    const action = detectRequiredUserAction('fauna_ask_user_decision', {}, raw);
    expect(action).toMatchObject({
      kind: 'agent-decision',
      title: 'Delete branch main?',
      options: expect.arrayContaining([
        expect.objectContaining({ id: 'cancel', recommended: true }),
      ]),
    });
  });

  it('does not clobber the existing Cowork detection', () => {
    // Regression: the new embedded-action path must not fire on ordinary
    // JSON results that happen to include an "action" string but no proper
    // envelope.
    expect(detectRequiredUserAction('fauna_shell_exec', { command: 'ls' },
      JSON.stringify({ ok: true, action: 'listed 3 files' }))).toBeNull();
    expect(detectRequiredUserAction(
      'fauna_shell_exec',
      { command: 'cowork auth login --device-code' },
      'To sign in, use a web browser to open https://login.microsoft.com/device and enter the code B5A7FAKHH.',
    )).toMatchObject({ kind: 'device-code-auth' });
  });
});