import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { registerChatRoute } from '../server/routes/chat.js';
import { createRunStore } from '../server/lib/run-store.js';

const llm = vi.hoisted(() => ({ create: vi.fn(), supportsTools: false }));

vi.mock('../server/llm/registry.js', () => ({
  getLLMClient: vi.fn(() => ({
    client: { chat: { completions: { create: llm.create } } },
    providerId: 'test',
    supports: { tools: llm.supportsTools, vision: false, streaming: true, usageEvents: false },
  })),
}));

function makeTmpDir() {
  return fs.mkdtempSync(path.join(process.cwd(), '.fauna-chat-hooks-'));
}

function write(filePath, body) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, body, 'utf8');
}

function makeFakeApp() {
  const routes = new Map();
  return {
    get(pathName, ...handlers) { routes.set('GET ' + pathName, handlers); },
    post(pathName, ...handlers) { routes.set('POST ' + pathName, handlers); },
    async invoke(method, pathName, req = {}) {
      const handlers = routes.get(method.toUpperCase() + ' ' + pathName);
      if (!handlers) throw new Error('No route ' + method + ' ' + pathName);
      const res = makeFakeSseRes(req.onEvent);
      const list = Array.isArray(handlers) ? handlers : [handlers];
      let index = 0;
      const next = async () => {
        const handler = list[index++];
        if (handler) await handler({ query: {}, body: {}, ...req }, res, next);
      };
      await next();
      return res;
    },
  };
}

function makeFakeSseRes(onEvent) {
  const emitter = new EventEmitter();
  return {
    statusCode: 200,
    headers: null,
    chunks: [],
    writableEnded: false,
    on: emitter.on.bind(emitter),
    off: emitter.off.bind(emitter),
    writeHead(code, headers) { this.statusCode = code; this.headers = headers; return this; },
    write(chunk) {
      this.chunks.push(String(chunk));
      if (onEvent) for (const event of parseSse([String(chunk)])) onEvent(event);
      return true;
    },
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; },
    end() { this.writableEnded = true; emitter.emit('finish'); },
  };
}

function makeDeps(workspaceRoot) {
  return {
    figma: {
      listFiles: vi.fn(() => []),
      getMcpTools: vi.fn(async () => []),
      executeToolDef: { type: 'function', function: { name: 'figma_execute' } },
    },
    customMcp: null,
    agentsDir: path.join(workspaceRoot, '.agents'),
    workspaceRoot,
    userConfigDir: path.join(workspaceRoot, '.user-config'),
    userHome: workspaceRoot,
    callPlaywrightMcpTool: vi.fn(),
    setActiveModel: vi.fn(),
    shellBin: '/bin/zsh',
    augmentedPath: process.env.PATH,
  };
}

function parseSse(chunks) {
  return chunks.join('').split('\n').filter(line => line.startsWith('data: ')).map(line => JSON.parse(line.slice(6)));
}

function mockTextStream(text = 'ok') {
  llm.create.mockResolvedValue((async function* () {
    yield { choices: [{ delta: { content: text }, finish_reason: null }] };
    yield { choices: [{ delta: {}, finish_reason: 'stop' }] };
  })());
}

function mockToolCallStream(name, args) {
  return (async function* () {
    yield { choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_read_1', type: 'function', function: { name, arguments: JSON.stringify(args) } }] }, finish_reason: null }] };
    yield { choices: [{ delta: {}, finish_reason: 'tool_calls' }] };
  })();
}

function mockNarratedToolCallStream(text, name, args) {
  return (async function* () {
    yield { choices: [{ delta: { content: text }, finish_reason: null }] };
    yield { choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_narrated_1', type: 'function', function: { name, arguments: JSON.stringify(args) } }] }, finish_reason: null }] };
    yield { choices: [{ delta: {}, finish_reason: 'tool_calls' }] };
  })();
}

function mockStopStream(text) {
  return (async function* () {
    yield { choices: [{ delta: { content: text }, finish_reason: null }] };
    yield { choices: [{ delta: {}, finish_reason: 'stop' }] };
  })();
}

describe('POST /api/chat lifecycle hooks', () => {
  let workspaceRoot;
  let app;

  beforeEach(() => {
    workspaceRoot = makeTmpDir();
    app = makeFakeApp();
    llm.create.mockReset();
    llm.supportsTools = false;
    registerChatRoute(app, makeDeps(workspaceRoot));
  });

  afterEach(() => {
    fs.rmSync(workspaceRoot, { recursive: true, force: true });
  });

  const browserEvidence = {
    ok: true, kind: 'browser-journey', source: 'internal', url: 'http://localhost:3000',
    navigated: true, consoleChecked: true, consoleErrors: [],
    steps: [{ action: 'click', selector: '#submit', ok: true }, { action: 'assert', ok: true }],
    checks: [{ selector: '#outcome', property: 'text', actual: 'After', expected: 'After', ok: true }],
  };
  const browserArgs = {
    action: 'verify', url: 'http://localhost:3000',
    steps: [{ action: 'click', selector: '#submit' },
      { action: 'assert', selector: '#outcome', property: 'text', expected: 'After' }],
  };

  it.each([false, true])('blocks UI completion without executed journeys, noTools=%s', async noTools => {
    llm.supportsTools = !noTools;
    llm.create.mockImplementation(async () => mockStopStream('DONE: fixed UI'));
    const res = await app.invoke('POST', '/api/chat', {
      body: { messages: [{ role: 'user', content: 'Fix sidebar UI' }], noTools,
        autonomousMode: true, clientContext: 'test' },
    });
    const events = parseSse(res.chunks);
    expect(events.find(event => event.type === 'task_result')).toMatchObject({ status: 'BLOCKED' });
    expect(events.find(event => event.type === 'done')).toMatchObject({ finish_reason: 'browser_verification_failed' });
  });

  it('does not impose browser checks on documentation about UI', async () => {
    mockTextStream('Use the sidebar to open settings.');
    const res = await app.invoke('POST', '/api/chat', {
      body: { messages: [{ role: 'user', content: 'Create documentation for the sidebar UI' }],
        noTools: true, clientContext: 'test' },
    });
    expect(parseSse(res.chunks).some(event => event.type === 'task_result')).toBe(false);
    expect(parseSse(res.chunks).find(event => event.type === 'done').finish_reason).toBe('stop');
  });

  it('accepts native executed evidence but requires a fresh journey after a later code edit', async () => {
    llm.supportsTools = true;
    write(path.join(workspaceRoot, 'package.json'), JSON.stringify({ scripts: { test: 'node --check app.js' } }));
    write(path.join(workspaceRoot, 'app.js'), 'const ok = true;\n');
    llm.create
      .mockResolvedValueOnce(mockToolCallStream('fauna_browser', browserArgs))
      .mockResolvedValueOnce(mockToolCallStream('fauna_write_file', {
        path: path.join(workspaceRoot, 'index.html'), content: '<button id="submit">Submit</button>',
      }))
      .mockResolvedValueOnce(mockStopStream('DONE: updated UI'))
      .mockResolvedValueOnce(mockStopStream('DONE: tests passed'))
      .mockResolvedValueOnce(mockToolCallStream('fauna_browser', browserArgs))
      .mockResolvedValueOnce(mockStopStream('DONE: UI journey passed'))
      .mockResolvedValueOnce(mockStopStream('No lessons.'));
    let executions = 0;
    const res = await app.invoke('POST', '/api/chat', {
      body: { messages: [{ role: 'user', content: 'Fix sidebar UI' }],
        autonomousMode: true, taskCwd: workspaceRoot, clientContext: 'test' },
      onEvent(event) {
        if (event.type === 'client_tool_pending') {
          executions++;
          void app.invoke('POST', '/api/client-tool-result', {
            body: { callId: event.callId, result: browserEvidence },
          });
        }
      },
    });
    expect(executions).toBe(2);
    expect(parseSse(res.chunks).find(event => event.type === 'task_result')).toMatchObject({
      status: 'DONE', verification: { ok: true, browser: browserEvidence },
    });
    expect(llm.create.mock.calls.some(([call]) => call.messages?.some(
      message => /UI changes REQUIRE live ad-hoc/.test(message.content || ''),
    ))).toBe(true);
  });

  it('routes headless browser verification to the native renderer and fails immediately without one', async () => {
    llm.supportsTools = true;
    const sendNative = vi.fn((_channel, payload) => {
      void app.invoke('POST', '/api/client-tool-result', {
        body: { callId: payload.callId, result: browserEvidence },
      });
    });
    registerChatRoute(app, { ...makeDeps(workspaceRoot),
      getMainWindows: () => [{ webContents: { getURL: () => 'http://localhost:3737/', send: sendNative } }] });
    write(path.join(workspaceRoot, 'app.js'), 'const valid = true;\n');
    write(path.join(workspaceRoot, 'package.json'), JSON.stringify({ scripts: { check: 'node --check app.js' } }));
    llm.create
      .mockResolvedValueOnce(mockToolCallStream('fauna_shell_exec', {
        command: 'npm run check', cwd: workspaceRoot,
      }))
      .mockResolvedValueOnce(mockToolCallStream('fauna_browser', browserArgs))
      .mockResolvedValueOnce(mockStopStream('DONE: browser verified'))
      .mockResolvedValueOnce(mockStopStream('No lessons.'));
    const body = { messages: [{ role: 'user', content: 'Fix sidebar UI' }],
      headlessTask: true, autonomousMode: true, browserEnabled: true, clientContext: 'test' };
    const res = await app.invoke('POST', '/api/chat', { body });
    expect(sendNative).toHaveBeenCalledWith('fauna:browser-tool', expect.objectContaining({ args: browserArgs }));
    expect(parseSse(res.chunks).find(event => event.type === 'task_result'), JSON.stringify(
      llm.create.mock.calls.map(([call]) => call.messages?.filter(m => m.role === 'user').slice(-2)),
    )).toMatchObject({ status: 'DONE' });
    registerChatRoute(app, makeDeps(workspaceRoot));
    llm.create.mockImplementation(async () => mockStopStream('DONE: fixed UI'));
    const blocked = await app.invoke('POST', '/api/chat', { body });
    expect(parseSse(blocked.chunks).find(event => event.type === 'task_result').status).toBe('BLOCKED');
  });

  it('rejects Project Search before model execution when project scope is missing', async () => {
    const res = await app.invoke('POST', '/api/chat', {
      body: {
        messages: [{ role: 'user', content: 'find the auth flow' }],
        clientContext: 'project-search',
        agentName: 'repository-agent',
      },
    });

    expect(llm.create).not.toHaveBeenCalled();
    expect(parseSse(res.chunks)).toEqual([
      { type: 'error', error: 'Project Search requires projectId and sourceId' },
      { type: 'done', finish_reason: 'project_search_rejected' },
    ]);
  });

  it('blocks a new chat turn when SessionStart denies it', async () => {
    write(path.join(workspaceRoot, '.github', 'hooks', 'policy.json'), JSON.stringify({
      hooks: { SessionStart: [{ type: 'command', command: `node -e "process.stdout.write(JSON.stringify({continue:false,stopReason:'session blocked'}))"` }] },
    }));

    const res = await app.invoke('POST', '/api/chat', {
      body: { messages: [{ role: 'user', content: 'hello' }], noTools: true, clientContext: 'test' },
    });

    expect(llm.create).not.toHaveBeenCalled();
    expect(parseSse(res.chunks)).toEqual([
      { type: 'error', error: 'session blocked' },
      { type: 'done', finish_reason: 'hook_blocked', hook: 'SessionStart' },
    ]);
  });

  it('interrupts the active provider stream and continues the same durable run', async () => {
    const runStore = createRunStore({ configDir: workspaceRoot });
    const interruptible = {
      pendingResolve: null,
      next() { return new Promise(resolve => { this.pendingResolve = resolve; }); },
      return: vi.fn(function() {
        this.pendingResolve?.({ done: true });
        return Promise.resolve({ done: true });
      }),
      [Symbol.asyncIterator]() { return this; },
    };
    llm.create
      .mockResolvedValueOnce(interruptible)
      .mockResolvedValueOnce((async function* () {
        yield { choices: [{ delta: { content: 'redirected' }, finish_reason: null }] };
        yield { choices: [{ delta: {}, finish_reason: 'stop' }] };
      })());
    const interruptApp = makeFakeApp();
    registerChatRoute(interruptApp, { ...makeDeps(workspaceRoot), runStore });

    const responsePromise = interruptApp.invoke('POST', '/api/chat', {
      body: { runId: 'interrupt-run', messages: [{ role: 'user', content: 'start' }], noTools: true, clientContext: 'test' },
    });
    await vi.waitFor(() => expect(interruptible.pendingResolve).toBeTypeOf('function'));
    runStore.enqueueControl('interrupt-run', 'interrupt', { text: 'change direction' });
    const res = await responsePromise;

    expect(interruptible.return).toHaveBeenCalledOnce();
    expect(llm.create).toHaveBeenCalledTimes(2);
    expect(parseSse(res.chunks)).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: 'run_interrupted' }),
      expect.objectContaining({ type: 'content', content: 'redirected' }),
    ]));
    expect(runStore.get('interrupt-run').status).toBe('completed');
  });

  it('blocks submitted prompts when UserPromptSubmit denies them', async () => {
    write(path.join(workspaceRoot, '.github', 'hooks', 'policy.json'), JSON.stringify({
      hooks: { UserPromptSubmit: [{ type: 'command', command: `node -e "process.stdin.resume();process.stdin.on('data',d=>{const p=JSON.parse(d);process.stdout.write(JSON.stringify({continue:false,stopReason:'blocked '+p.prompt}))})"` }] },
    }));

    const res = await app.invoke('POST', '/api/chat', {
      body: { messages: [{ role: 'assistant', content: 'previous' }, { role: 'user', content: 'ship it' }], noTools: true, clientContext: 'test' },
    });

    expect(llm.create).not.toHaveBeenCalled();
    expect(parseSse(res.chunks)).toEqual([
      { type: 'error', error: 'blocked ship it' },
      { type: 'done', finish_reason: 'hook_blocked', hook: 'UserPromptSubmit' },
    ]);
  });

  it('injects UserPromptSubmit system messages before the model call', async () => {
    mockTextStream('accepted');
    write(path.join(workspaceRoot, '.github', 'hooks', 'policy.json'), JSON.stringify({
      hooks: { UserPromptSubmit: [{ type: 'command', command: `node -e "process.stdout.write(JSON.stringify({systemMessage:'policy context'}))"` }] },
    }));

    const res = await app.invoke('POST', '/api/chat', {
      body: { messages: [{ role: 'assistant', content: 'previous' }, { role: 'user', content: 'continue' }], noTools: true, clientContext: 'test' },
    });

    expect(llm.create.mock.calls.length, JSON.stringify(parseSse(res.chunks))).toBe(1);
    const params = llm.create.mock.calls[0][0];
    expect(params.messages.some(message => message.role === 'system' && message.content === 'policy context')).toBe(true);
    expect(parseSse(res.chunks).some(event => event.type === 'content' && event.content === 'accepted')).toBe(true);
  });

  it('injects ownership, canonical-source, runtime, and measured-count rules', async () => {
    mockTextStream('acknowledged');

    await app.invoke('POST', '/api/chat', {
      body: { messages: [{ role: 'user', content: 'fix the catalog' }], noTools: true, clientContext: 'test' },
    });

    const systemText = llm.create.mock.calls[0][0].messages
      .filter(message => message.role === 'system')
      .map(message => message.content)
      .join('\n');
    expect(systemText).toContain('code path the running product actually consumes');
    expect(systemText).toContain('one canonical implementation path');
    expect(systemText).toContain('A passing build proves compilation, not that a UI changed');
    expect(systemText).toContain('Report measured quantities precisely');
  });

  it('blocks delegated subagent runs when SubagentStart denies them', async () => {
    write(path.join(workspaceRoot, '.github', 'hooks', 'policy.json'), JSON.stringify({
      hooks: { SubagentStart: [{ type: 'command', command: `node -e "process.stdout.write(JSON.stringify({continue:false,stopReason:'delegate blocked'}))"` }] },
    }));

    const res = await app.invoke('POST', '/api/chat', {
      body: { messages: [{ role: 'user', content: 'delegated task' }], isDelegation: true, agentName: 'worker', noTools: true, clientContext: 'test' },
    });

    expect(llm.create).not.toHaveBeenCalled();
    expect(parseSse(res.chunks)).toEqual([
      { type: 'error', error: 'delegate blocked' },
      { type: 'done', finish_reason: 'hook_blocked', hook: 'SubagentStart' },
    ]);
  });

  it('runs SubagentStop after delegated model completion', async () => {
    mockTextStream('done');
    write(path.join(workspaceRoot, '.github', 'hooks', 'policy.json'), JSON.stringify({
      hooks: { SubagentStop: [{ type: 'command', command: `node -e "require('fs').writeFileSync('subagent-stop-ran.txt','ok')"` }] },
    }));

    const res = await app.invoke('POST', '/api/chat', {
      body: { messages: [{ role: 'user', content: 'delegated task' }], isDelegation: true, agentName: 'worker', noTools: true, clientContext: 'test' },
    });

    expect(llm.create.mock.calls.length, JSON.stringify(parseSse(res.chunks))).toBe(1);
    expect(fs.readFileSync(path.join(workspaceRoot, 'subagent-stop-ran.txt'), 'utf8')).toBe('ok');
  });

  it('continues implementation requests after inspection-only tool use', async () => {
    llm.supportsTools = true;
    write(path.join(workspaceRoot, 'target.js'), 'export const value = 1;\n');
    llm.create
      .mockResolvedValueOnce(mockToolCallStream('fauna_read_file', { path: path.join(workspaceRoot, 'target.js') }))
      .mockResolvedValueOnce(mockStopStream('I confirmed the file and will fix it next.'))
      .mockResolvedValueOnce(mockStopStream('BLOCKED: no safe edit was possible.'));

    const res = await app.invoke('POST', '/api/chat', {
      body: { messages: [{ role: 'user', content: 'fix all issues in this project' }], clientContext: 'test' },
    });

    expect(llm.create.mock.calls.length, JSON.stringify(parseSse(res.chunks))).toBe(3);
    const thirdCallMessages = llm.create.mock.calls[2][0].messages;
    expect(thirdCallMessages.some(message => message.role === 'user' && /only inspected\/read\/audited files/.test(message.content))).toBe(true);
    const events = parseSse(res.chunks);
    expect(events.some(event => event.type === 'tool_call' && event.name === 'fauna_read_file')).toBe(true);
    expect(events.some(event => event.type === 'content' && /BLOCKED:/.test(event.content))).toBe(true);
  });

  it('treats a remove request as implementation instead of accepting a proposal', async () => {
    llm.supportsTools = true;
    write(path.join(workspaceRoot, 'sidebar.css'), '.sidebar { display: block; }\n');
    llm.create
      .mockResolvedValueOnce(mockToolCallStream('fauna_read_file', { path: path.join(workspaceRoot, 'sidebar.css') }))
      .mockResolvedValueOnce(mockStopStream('Want me to hide the sidebar now?'))
      .mockResolvedValueOnce(mockStopStream('The proper next step is to add an override.'))
      .mockResolvedValueOnce(mockStopStream('BLOCKED: no safe edit was possible.'));

    const res = await app.invoke('POST', '/api/chat', {
      body: { messages: [{ role: 'user', content: 'remove the sidebar that is taking up space' }], clientContext: 'test' },
    });

    expect(llm.create.mock.calls.length, JSON.stringify(parseSse(res.chunks))).toBe(4);
    expect(llm.create.mock.calls[2][0].messages.some(message =>
      message.role === 'user' && /Make the smallest safe edit NOW/.test(message.content)
    )).toBe(true);
    expect(llm.create.mock.calls[3][0].messages.filter(message =>
      message.role === 'user' && /Make the smallest safe edit NOW/.test(message.content)
    )).toHaveLength(2);
  });

  it('continues extraction requests after a discovery-only summary', async () => {
    llm.supportsTools = true;
    write(path.join(workspaceRoot, 'builder.tsx'), 'export function Builder() { return null; }\n');
    llm.create
      .mockResolvedValueOnce(mockToolCallStream('fauna_read_file', { path: path.join(workspaceRoot, 'builder.tsx') }))
      .mockResolvedValueOnce(mockStopStream('No files were modified. Next concrete step: locate the live builder page source module.'))
      .mockResolvedValueOnce(mockStopStream('BLOCKED: the builder source is not present in the selected workspace.'));

    const res = await app.invoke('POST', '/api/chat', {
      body: {
        messages: [{
          role: 'user',
          content: 'Extract the inspector panel, CSS, images, and subcomponents and bring them to the builder page',
        }],
        clientContext: 'test',
      },
    });

    expect(llm.create.mock.calls.length, JSON.stringify(parseSse(res.chunks))).toBe(3);
    expect(llm.create.mock.calls[2][0].messages.some(message =>
      message.role === 'user' && /Make the smallest safe edit NOW/.test(message.content)
    )).toBe(true);
    expect(parseSse(res.chunks).some(event => event.type === 'content' && /BLOCKED:/.test(event.content))).toBe(true);
  });

  it('routes explicit model input requests through the Decision Prompt', async () => {
    mockTextStream('NEEDS-INPUT: Which builder page should receive the inspector?');

    const res = await app.invoke('POST', '/api/chat', {
      body: { messages: [{ role: 'user', content: 'continue the integration' }], noTools: true, clientContext: 'test' },
    });

    const event = parseSse(res.chunks).find(item => item.type === 'requires_user_action');
    expect(event?.action).toMatchObject({
      kind: 'model-input',
      title: 'Fauna needs your input',
      prompt: 'Which builder page should receive the inspector?',
      options: expect.arrayContaining([
        expect.objectContaining({ id: 'provide-details', recommended: true, custom: true }),
      ]),
    });
  });

  it('rejects an evidence-free autonomous BLOCKED marker once', async () => {
    llm.create
      .mockResolvedValueOnce(mockStopStream('BLOCKED: I am stuck.'))
      .mockResolvedValueOnce(mockStopStream('BLOCKED: `npm test` failed with exit code 1 and stderr reported a missing module.'))
      .mockResolvedValueOnce(mockStopStream('BLOCKED: `npm test` failed with exit code 1 and stderr reported a missing module.'));

    const res = await app.invoke('POST', '/api/chat', {
      body: {
        messages: [{ role: 'user', content: 'finish the task' }],
        autonomousMode: true,
        noTools: true,
        clientContext: 'test',
      },
    });

    expect(llm.create).toHaveBeenCalledTimes(3);
    expect(llm.create.mock.calls[1][0].messages.some(message =>
      message.role === 'user' && /without concrete blocker evidence/.test(message.content)
    )).toBe(true);
    expect(llm.create.mock.calls[2][0].messages.some(message =>
      message.role === 'system' && /extract durable lessons/.test(message.content)
    )).toBe(true);
  });

  it('separates narrated tool rounds from the next model response', async () => {
    llm.supportsTools = true;
    write(path.join(workspaceRoot, 'target.js'), 'export const value = 1;\n');
    llm.create
      .mockResolvedValueOnce(mockNarratedToolCallStream('I am checking the target.', 'fauna_read_file', { path: path.join(workspaceRoot, 'target.js') }))
      .mockResolvedValueOnce(mockStopStream('The target is valid.'))
      .mockResolvedValueOnce(mockStopStream('BLOCKED: no mutation was requested.'));

    const res = await app.invoke('POST', '/api/chat', {
      body: { messages: [{ role: 'user', content: 'analyze this project' }], clientContext: 'test' },
    });

    const content = parseSse(res.chunks).filter(event => event.type === 'content').map(event => event.content).join('');
    expect(content).toContain('I am checking the target.\n\nThe target is valid.');
  });

  it('redirects recursive shell discovery to indexed search without running it', async () => {
    llm.supportsTools = true;
    llm.create
      .mockResolvedValueOnce(mockToolCallStream('fauna_shell_exec', {
        command: 'grep -r "sfe-shell" . --include="*.tsx"',
        cwd: workspaceRoot,
      }))
      .mockResolvedValueOnce(mockStopStream('The recursive scan was skipped; I will use indexed search.'));

    const startedAt = Date.now();
    const res = await app.invoke('POST', '/api/chat', {
      body: { messages: [{ role: 'user', content: 'find the sidebar implementation' }], clientContext: 'test' },
    });

    expect(Date.now() - startedAt).toBeLessThan(2000);
    expect(llm.create).toHaveBeenCalledTimes(2);
    const secondCallMessages = llm.create.mock.calls[1][0].messages;
    expect(
      secondCallMessages.some(message => message.role === 'tool' && /USE_INDEXED_SEARCH/.test(message.content)),
      JSON.stringify(secondCallMessages),
    ).toBe(true);
    expect(parseSse(res.chunks).some(event => event.type === 'content' && /indexed search/.test(event.content))).toBe(true);
  });

  it('does not open the internal browser for a shared extension-tab turn', async () => {
    llm.supportsTools = true;
    llm.create
      .mockResolvedValueOnce(mockToolCallStream('fauna_browser', { action: 'extract' }))
      .mockResolvedValueOnce(mockStopStream('The request is routed through the shared browser extension.'))
      .mockResolvedValueOnce(mockStopStream('BLOCKED: the shared extension action was unavailable in this test.'));

    const res = await app.invoke('POST', '/api/chat', {
      body: {
        messages: [{
          role: 'user',
          content: '[Resolved live browser tab context — already extracted from the user shared browser tab via the extension.] remove the sidebar',
        }],
        clientContext: 'test',
      },
    });

    expect(llm.create).toHaveBeenCalledTimes(3);
    const secondCallMessages = llm.create.mock.calls[1][0].messages;
    expect(secondCallMessages.some(message => message.role === 'tool' && /USE_BROWSER_EXTENSION/.test(message.content))).toBe(true);
    expect(llm.create.mock.calls[2][0].messages.some(message =>
      message.role === 'user' && /Make the smallest safe edit NOW/.test(message.content)
    )).toBe(true);
  });

  it('removes tools from the final response after repeated narration trips the hard stop', async () => {
    llm.supportsTools = true;
    for (let index = 0; index < 5; index++) {
      write(path.join(workspaceRoot, `target-${index}.js`), `export const value = ${index};\n`);
      llm.create.mockResolvedValueOnce(mockNarratedToolCallStream(
        'I have confirmed the same investigation details and I am checking the next target now.',
        'fauna_read_file',
        { path: path.join(workspaceRoot, `target-${index}.js`) },
      ));
    }
    llm.create.mockResolvedValueOnce(mockStopStream('I stopped the repeated investigation.'));

    const res = await app.invoke('POST', '/api/chat', {
      body: { messages: [{ role: 'user', content: 'inspect these files' }], clientContext: 'test' },
    });

    expect(parseSse(res.chunks).some(event => event.type === 'content' && /stopped the repeated/.test(event.content))).toBe(true);
    expect(llm.create.mock.calls.at(-1)[0].tools).toBeUndefined();
  });

  it('continues implementation requests after mutation without validation', async () => {
    llm.supportsTools = true;
    write(path.join(workspaceRoot, 'package.json'), JSON.stringify({ scripts: { build: 'node --check changed.js' } }));
    write(path.join(workspaceRoot, 'changed.js'), 'const changed = true;\n');
    llm.create
      .mockResolvedValueOnce(mockToolCallStream('fauna_shell_exec', { command: 'touch changed.js', cwd: workspaceRoot }))
      .mockResolvedValueOnce(mockStopStream('Implemented the change.'))
      .mockResolvedValueOnce(mockToolCallStream('fauna_shell_exec', { command: 'npm run build', cwd: workspaceRoot }))
      .mockResolvedValueOnce(mockStopStream('Done after validation.'));

    const res = await app.invoke('POST', '/api/chat', {
      body: { messages: [{ role: 'user', content: 'implement all fixes' }], clientContext: 'test' },
    });

    expect(llm.create.mock.calls.length, JSON.stringify(parseSse(res.chunks))).toBe(4);
    const thirdCallMessages = llm.create.mock.calls[2][0].messages;
    expect(thirdCallMessages.some(message => message.role === 'user' && /made a concrete change, but you have not validated it/.test(message.content))).toBe(true);
    const events = parseSse(res.chunks);
    expect(events.filter(event => event.type === 'tool_call' && event.name === 'fauna_shell_exec').length).toBe(2);
    expect(events.some(event => event.type === 'content' && event.content === 'Done after validation.')).toBe(true);
  });

  describe('test-backed completion', () => {
    function seedCompletionTests(initial = 'fixed') {
      write(path.join(workspaceRoot, 'package.json'), JSON.stringify({
        scripts: { test: 'node --test checks.test.cjs' },
      }));
      write(path.join(workspaceRoot, 'changed.js'), initial);
      write(path.join(workspaceRoot, 'checks.test.cjs'), [
        "const fs = require('node:fs');",
        "const assert = require('node:assert/strict');",
        "require('node:test')('changed behavior', () => {",
        "  fs.appendFileSync('verification-runs.txt', process.env.CI + '\\n');",
        "  assert.equal(fs.readFileSync('changed.js', 'utf8'), 'fixed');",
        '});',
      ].join('\n'));
    }

    it('actually runs detected tests before completing a normal coding turn', async () => {
      llm.supportsTools = true;
      seedCompletionTests();
      llm.create
        .mockResolvedValueOnce(mockToolCallStream('fauna_shell_exec', { command: 'touch changed.js', cwd: workspaceRoot }))
        .mockResolvedValueOnce(mockStopStream('Implemented the change.'))
        .mockResolvedValueOnce(mockStopStream('Completed; npm run test passed.'));

      const res = await app.invoke('POST', '/api/chat', {
        body: { messages: [{ role: 'user', content: 'fix the code' }], clientContext: 'test' },
      });

      expect(fs.readFileSync(path.join(workspaceRoot, 'verification-runs.txt'), 'utf8')).toBe('1\n');
      const result = parseSse(res.chunks).find(event => event.type === 'tool_result' && event.name === 'autonomous_qa_gate');
      expect(JSON.parse(result.result)).toMatchObject({ ok: true, exitCode: 0 });
      expect(llm.create.mock.calls.at(-1)[0].messages.some(message =>
        message.role === 'user' && /Completion verification PASSED/.test(message.content)
      )).toBe(true);
    });

    it('rechecks after failed QA is repaired instead of trusting a second DONE', async () => {
      llm.supportsTools = true;
      seedCompletionTests('broken');
      llm.create
        .mockResolvedValueOnce(mockStopStream('DONE: implemented'))
        .mockResolvedValueOnce(mockToolCallStream('fauna_shell_exec', { command: "printf fixed > changed.js", cwd: workspaceRoot }))
        .mockResolvedValueOnce(mockStopStream('DONE: repaired'))
        .mockResolvedValueOnce(mockStopStream('DONE: npm run test passed after repair'));

      const res = await app.invoke('POST', '/api/chat', {
        body: {
          messages: [{ role: 'user', content: 'fix the code' }], clientContext: 'test',
          autonomousMode: true, taskCwd: workspaceRoot, qa: { command: 'npm run test' },
        },
      });

      const results = parseSse(res.chunks).filter(event => event.type === 'tool_result' && event.name === 'autonomous_qa_gate');
      expect(results.map(event => JSON.parse(event.result).ok)).toEqual([false, true]);
      expect(fs.readFileSync(path.join(workspaceRoot, 'verification-runs.txt'), 'utf8')).toBe('1\n1\n');
      expect(parseSse(res.chunks).find(event => event.type === 'task_result')).toMatchObject({
        status: 'DONE', content: 'DONE: npm run test passed after repair', verification: { ok: true },
      });
    });

    it('invalidates a passing check when the agent edits again', async () => {
      llm.supportsTools = true;
      seedCompletionTests();
      llm.create
        .mockResolvedValueOnce(mockToolCallStream('fauna_shell_exec', { command: 'touch changed.js', cwd: workspaceRoot }))
        .mockResolvedValueOnce(mockStopStream('Implemented the change.'))
        .mockResolvedValueOnce(mockToolCallStream('fauna_shell_exec', { command: 'touch another.js', cwd: workspaceRoot }))
        .mockResolvedValueOnce(mockStopStream('Implemented the follow-up.'))
        .mockResolvedValueOnce(mockStopStream('Completed after tests passed again.'));

      await app.invoke('POST', '/api/chat', {
        body: { messages: [{ role: 'user', content: 'fix the code' }], clientContext: 'test' },
      });

      expect(fs.readFileSync(path.join(workspaceRoot, 'verification-runs.txt'), 'utf8')).toBe('1\n1\n');
      expect(llm.create).toHaveBeenCalledTimes(5);
    });

    it('blocks repeated failing checks even when the agent keeps claiming DONE', async () => {
      seedCompletionTests('broken');
      llm.create.mockImplementation(async () => mockStopStream('DONE: implemented'));
      const res = await app.invoke('POST', '/api/chat', {
        body: {
          messages: [{ role: 'user', content: 'fix the code' }], clientContext: 'test',
          autonomousMode: true, taskCwd: workspaceRoot, qa: { command: 'npm run test' },
        },
      });

      expect(llm.create).toHaveBeenCalledTimes(3);
      expect(fs.readFileSync(path.join(workspaceRoot, 'verification-runs.txt'), 'utf8')).toBe('1\n1\n1\n');
      expect(parseSse(res.chunks).find(event => event.type === 'task_result').status).toBe('BLOCKED');
      expect(parseSse(res.chunks).at(-1)).toMatchObject({ type: 'done', finish_reason: 'verification_failed' });
    });

    it('does not run checks during a conversational turn or bypass disabled shell access', async () => {
      seedCompletionTests();
      llm.create.mockImplementation(async () => mockStopStream('Hello.'));
      await app.invoke('POST', '/api/chat', {
        body: { messages: [{ role: 'user', content: 'hello' }], clientContext: 'test' },
      });
      expect(fs.existsSync(path.join(workspaceRoot, 'verification-runs.txt'))).toBe(false);

      llm.create.mockImplementation(async () => mockStopStream('DONE: implemented'));
      const res = await app.invoke('POST', '/api/chat', {
        body: {
          messages: [{ role: 'user', content: 'fix the code' }], clientContext: 'test',
          autonomousMode: true, taskCwd: workspaceRoot, shellEnabled: false,
        },
      });
      expect(fs.existsSync(path.join(workspaceRoot, 'verification-runs.txt'))).toBe(false);
      expect(parseSse(res.chunks).find(event => event.type === 'task_result')).toMatchObject({
        status: 'BLOCKED', content: expect.stringContaining('Shell access is disabled'),
      });
    });

    it('blocks completion when code changes have no successful validation', async () => {
      llm.supportsTools = true;
      write(path.join(workspaceRoot, 'changed.js'), 'const changed = true;\n');
      llm.create
        .mockResolvedValueOnce(mockToolCallStream('fauna_shell_exec', { command: 'touch changed.js', cwd: workspaceRoot }))
        .mockImplementation(async () => mockStopStream('Implemented the change.'));
      const res = await app.invoke('POST', '/api/chat', {
        body: { messages: [{ role: 'user', content: 'fix the code' }], clientContext: 'test' },
      });
      expect(llm.create).toHaveBeenCalledTimes(4);
      expect(parseSse(res.chunks).find(event => event.type === 'task_result').status).toBe('BLOCKED');
      expect(parseSse(res.chunks).at(-1)).toMatchObject({ type: 'done', finish_reason: 'verification_missing' });
    });

    it('does not auto-run project tests for a documentation-only file edit', async () => {
      llm.supportsTools = true;
      seedCompletionTests();
      llm.create
        .mockResolvedValueOnce(mockToolCallStream('fauna_write_file', { path: path.join(workspaceRoot, 'README.md'), content: '# Docs\n' }))
        .mockResolvedValueOnce(mockStopStream('Documentation saved.'));
      await app.invoke('POST', '/api/chat', {
        body: { messages: [{ role: 'user', content: 'save this documentation' }], clientContext: 'test' },
      });
      expect(fs.readFileSync(path.join(workspaceRoot, 'README.md'), 'utf8')).toBe('# Docs\n');
      expect(fs.existsSync(path.join(workspaceRoot, 'verification-runs.txt'))).toBe(false);
    });

  });

  it('does not count a failed mutation command as an actual fix', async () => {
    llm.supportsTools = true;
    llm.create
      .mockResolvedValueOnce(mockToolCallStream('fauna_shell_exec', { command: 'touch /missing-fauna-parent/changed.txt', cwd: workspaceRoot }))
      .mockResolvedValueOnce(mockStopStream('Implemented the change.'))
      .mockResolvedValueOnce(mockStopStream('BLOCKED: the mutation command failed.'));

    const res = await app.invoke('POST', '/api/chat', {
      body: { messages: [{ role: 'user', content: 'fix the sidebar' }], clientContext: 'test' },
    });

    expect(llm.create).toHaveBeenCalledTimes(3);
    const thirdCallMessages = llm.create.mock.calls[2][0].messages;
    expect(thirdCallMessages.some(message =>
      message.role === 'user' && /Make the smallest safe edit NOW/.test(message.content)
    )).toBe(true);
    expect(thirdCallMessages.some(message =>
      message.role === 'user' && /you have not validated it/.test(message.content)
    )).toBe(false);
    expect(parseSse(res.chunks).some(event =>
      event.type === 'tool_activity_result' && event.name === 'fauna_shell_exec' && event.status === 'failed'
    )).toBe(true);
  });

  it('requires validation after a heredoc script may have rewritten files', async () => {
    llm.supportsTools = true;
    write(path.join(workspaceRoot, 'package.json'), JSON.stringify({ scripts: { build: 'node --check changed.js' } }));
    write(path.join(workspaceRoot, 'changed.js'), 'const changed = true;\n');
    llm.create
      .mockResolvedValueOnce(mockToolCallStream('fauna_shell_exec', {
        command: "python3 - <<'EOF'\nprint('rewrite')\nEOF",
        cwd: workspaceRoot,
      }))
      .mockResolvedValueOnce(mockStopStream('The patch landed.'))
      .mockResolvedValueOnce(mockToolCallStream('fauna_shell_exec', { command: 'npm run build', cwd: workspaceRoot }))
      .mockResolvedValueOnce(mockStopStream('Done after validation.'));

    const res = await app.invoke('POST', '/api/chat', {
      body: { messages: [{ role: 'user', content: 'apply the proper fix' }], clientContext: 'test' },
    });

    expect(llm.create.mock.calls.length, JSON.stringify(parseSse(res.chunks))).toBe(4);
    expect(llm.create.mock.calls[2][0].messages.some(message =>
      message.role === 'user' && /made a concrete change, but you have not validated it/.test(message.content)
    )).toBe(true);
  });

  it('rejects visible UI success claims without post-edit browser evidence', async () => {
    llm.supportsTools = true;
    write(path.join(workspaceRoot, 'package.json'), JSON.stringify({ scripts: { build: 'node --check catalog.js' } }));
    write(path.join(workspaceRoot, 'catalog.js'), 'export const count = 9;\n');
    llm.create
      .mockResolvedValueOnce(mockToolCallStream('fauna_shell_exec', { command: "printf 'export const count = 52;\\n' > catalog.js", cwd: workspaceRoot }))
      .mockResolvedValueOnce(mockStopStream('The catalog update is implemented.'))
      .mockResolvedValueOnce(mockToolCallStream('fauna_shell_exec', { command: 'npm run build', cwd: workspaceRoot }))
      .mockResolvedValueOnce(mockStopStream('Storybook is live. HMR should now show 52 components. Open http://127.0.0.1:6006 to confirm.'))
      .mockResolvedValueOnce(mockStopStream('BLOCKED: browser runtime verification is unavailable in this test.'));

    const res = await app.invoke('POST', '/api/chat', {
      body: { messages: [{ role: 'user', content: 'fix the incomplete Storybook component catalog' }], clientContext: 'test' },
    });

    expect(llm.create).toHaveBeenCalledTimes(5);
    const finalCallMessages = llm.create.mock.calls[4][0].messages;
    expect(finalCallMessages.some(message =>
      message.role === 'user' && /UI changes REQUIRE live ad-hoc/.test(message.content)
    )).toBe(true);
    expect(parseSse(res.chunks).some(event =>
      event.type === 'content' && /BLOCKED: browser runtime verification/.test(event.content)
    )).toBe(true);
  });

  it('does not count a failed browser inspection as runtime evidence', async () => {
    llm.supportsTools = true;
    write(path.join(workspaceRoot, 'package.json'), JSON.stringify({ scripts: { build: 'node --check catalog.js' } }));
    write(path.join(workspaceRoot, 'catalog.js'), 'export const count = 9;\n');
    const customMcp = {
      getTools: vi.fn(async () => [{
        type: 'function',
        function: { name: 'browser_snapshot', description: 'Inspect the browser', parameters: { type: 'object', properties: {} } },
      }]),
      getStatus: vi.fn(async () => []),
      callTool: vi.fn(async () => ({ ok: false, error: 'No matching browser tab' })),
    };
    app = makeFakeApp();
    registerChatRoute(app, { ...makeDeps(workspaceRoot), customMcp });
    llm.create
      .mockResolvedValueOnce(mockToolCallStream('fauna_shell_exec', { command: "printf 'export const count = 52;\\n' > catalog.js", cwd: workspaceRoot }))
      .mockResolvedValueOnce(mockStopStream('The catalog update is implemented.'))
      .mockResolvedValueOnce(mockToolCallStream('fauna_shell_exec', { command: 'npm run build', cwd: workspaceRoot }))
      .mockResolvedValueOnce(mockToolCallStream('browser_snapshot', {}))
      .mockResolvedValueOnce(mockStopStream('The catalog now shows 52 components.'))
      .mockResolvedValueOnce(mockStopStream('BLOCKED: the browser tab could not be inspected.'));

    const res = await app.invoke('POST', '/api/chat', {
      body: { messages: [{ role: 'user', content: 'fix and verify the Storybook UI catalog in the browser' }], clientContext: 'test' },
    });

    expect(llm.create).toHaveBeenCalledTimes(6);
    expect(customMcp.callTool).toHaveBeenCalledWith('browser_snapshot', {});
    expect(parseSse(res.chunks).some(event =>
      event.type === 'tool_activity_result' && event.name === 'browser_snapshot' && event.status === 'failed'
    )).toBe(true);
    expect(llm.create.mock.calls[5][0].messages.some(message =>
      message.role === 'user' && /UI changes REQUIRE live ad-hoc/.test(message.content)
    )).toBe(true);
  });

  it('rejects a visible UI claim backed only by a successful external snapshot', async () => {
    llm.supportsTools = true;
    write(path.join(workspaceRoot, 'package.json'), JSON.stringify({ scripts: { build: 'node --check catalog.js' } }));
    write(path.join(workspaceRoot, 'catalog.js'), 'export const count = 9;\n');
    const customMcp = {
      getTools: vi.fn(async () => [{
        type: 'function',
        function: { name: 'browser_snapshot', description: 'Inspect the browser', parameters: { type: 'object', properties: {} } },
      }]),
      getStatus: vi.fn(async () => []),
      callTool: vi.fn(async () => ({ ok: true, text: 'Catalog heading; 52 unique component cards' })),
    };
    app = makeFakeApp();
    registerChatRoute(app, { ...makeDeps(workspaceRoot), customMcp });
    llm.create
      .mockResolvedValueOnce(mockToolCallStream('fauna_shell_exec', { command: "printf 'export const count = 52;\\n' > catalog.js", cwd: workspaceRoot }))
      .mockResolvedValueOnce(mockStopStream('The catalog update is implemented.'))
      .mockResolvedValueOnce(mockToolCallStream('fauna_shell_exec', { command: 'npm run build', cwd: workspaceRoot }))
      .mockResolvedValueOnce(mockToolCallStream('browser_snapshot', {}))
      .mockResolvedValueOnce(mockStopStream('The catalog now shows 52 unique component cards.'))
      .mockResolvedValueOnce(mockStopStream('BLOCKED: native browser verification is unavailable.'));

    const res = await app.invoke('POST', '/api/chat', {
      body: { messages: [{ role: 'user', content: 'fix and verify the Storybook UI catalog in the browser' }], clientContext: 'test' },
    });

    expect(llm.create).toHaveBeenCalledTimes(6);
    expect(parseSse(res.chunks).some(event =>
      event.type === 'content' && /52 unique component cards/.test(event.content)
    )).toBe(true);
    expect(llm.create.mock.calls.some(call => call[0].messages.some(message =>
      message.role === 'user' && /UI changes REQUIRE live ad-hoc/.test(message.content)
    ))).toBe(true);
  });
});