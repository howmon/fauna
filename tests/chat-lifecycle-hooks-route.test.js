import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { registerChatRoute } from '../server/routes/chat.js';

const llm = vi.hoisted(() => ({ create: vi.fn() }));

vi.mock('../server/llm/registry.js', () => ({
  getLLMClient: vi.fn(() => ({
    client: { chat: { completions: { create: llm.create } } },
    providerId: 'test',
    supports: { tools: false, vision: false, streaming: true, usageEvents: false },
  })),
}));

function makeTmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'fauna-chat-hooks-'));
}

function write(filePath, body) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, body, 'utf8');
}

function makeFakeApp() {
  const routes = new Map();
  return {
    post(pathName, ...handlers) { routes.set('POST ' + pathName, handlers); },
    async invoke(method, pathName, req = {}) {
      const handlers = routes.get(method.toUpperCase() + ' ' + pathName);
      if (!handlers) throw new Error('No route ' + method + ' ' + pathName);
      const res = makeFakeSseRes();
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

function makeFakeSseRes() {
  const emitter = new EventEmitter();
  return {
    statusCode: 200,
    headers: null,
    chunks: [],
    writableEnded: false,
    on: emitter.on.bind(emitter),
    off: emitter.off.bind(emitter),
    writeHead(code, headers) { this.statusCode = code; this.headers = headers; return this; },
    write(chunk) { this.chunks.push(String(chunk)); return true; },
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
  };
}

function parseSse(chunks) {
  return chunks.join('').split('\n\n').filter(Boolean).filter(part => part.startsWith('data: ')).map(part => JSON.parse(part.slice(6)));
}

function mockTextStream(text = 'ok') {
  llm.create.mockResolvedValue((async function* () {
    yield { choices: [{ delta: { content: text }, finish_reason: null }] };
    yield { choices: [{ delta: {}, finish_reason: 'stop' }] };
  })());
}

describe('POST /api/chat lifecycle hooks', () => {
  let workspaceRoot;
  let app;

  beforeEach(() => {
    workspaceRoot = makeTmpDir();
    app = makeFakeApp();
    llm.create.mockReset();
    registerChatRoute(app, makeDeps(workspaceRoot));
  });

  afterEach(() => {
    fs.rmSync(workspaceRoot, { recursive: true, force: true });
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
});