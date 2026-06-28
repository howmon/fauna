import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { registerCustomizationRoutes } from '../server/routes/customizations.js';

function makeTmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'fauna-customization-route-'));
}

function write(filePath, body) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, body, 'utf8');
}

function makeFakeApp() {
  const routes = new Map();
  return {
    get(pathName, handler) { routes.set('GET ' + pathName, handler); },
    post(pathName, ...handlers) { routes.set('POST ' + pathName, handlers); },
    invoke(method, pathName, req = {}) {
      const handlers = routes.get(method.toUpperCase() + ' ' + pathName);
      if (!handlers) throw new Error('No route ' + method + ' ' + pathName);
      const res = makeFakeRes();
      const list = Array.isArray(handlers) ? handlers : [handlers];
      let index = 0;
      const next = () => {
        const handler = list[index++];
        if (handler) handler({ query: {}, body: {}, ...req }, res, next);
      };
      next();
      return res;
    },
  };
}

function makeFakeRes() {
  return {
    statusCode: 200,
    body: null,
    status(code) { this.statusCode = code; return this; },
    json(payload) { this.body = payload; return this; },
  };
}

describe('GET /api/customizations', () => {
  let repoDir;
  let userDir;
  let app;

  beforeEach(() => {
    repoDir = makeTmpDir();
    userDir = makeTmpDir();
    app = makeFakeApp();
    registerCustomizationRoutes(app, { workspaceRoot: repoDir, userConfigDir: userDir, userHome: makeTmpDir() });
  });

  afterEach(() => {
    fs.rmSync(repoDir, { recursive: true, force: true });
    fs.rmSync(userDir, { recursive: true, force: true });
  });

  it('returns grouped registry metadata without file bodies by default', () => {
    write(path.join(repoDir, '.github', 'prompts', 'review.prompt.md'), `---
name: review
description: "Use when reviewing a change."
tools: [read, search]
---
Review this.
`);
    write(path.join(repoDir, '.github', 'instructions', 'server.instructions.md'), `---
description: "Use when editing server code."
applyTo: "server/**/*.js"
---
Server rules.
`);

    const res = app.invoke('GET', '/api/customizations');

    expect(res.statusCode).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.count).toBe(2);
    expect(res.body.grouped.prompt[0].name).toBe('review');
    expect(res.body.grouped.prompt[0].tools).toEqual(['read', 'search']);
    expect(res.body.grouped.prompt[0]).not.toHaveProperty('body');
    expect(res.body.grouped.instruction[0].applyTo).toEqual(['server/**/*.js']);
  });

  it('filters by kind and can include bodies explicitly', () => {
    write(path.join(repoDir, '.github', 'prompts', 'review.prompt.md'), `---
name: review
description: "Use when reviewing a change."
---
Review this.
`);
    write(path.join(repoDir, '.github', 'agents', 'reviewer.agent.md'), `---
name: reviewer
description: "Use when acting as reviewer."
---
Agent body.
`);

    const res = app.invoke('GET', '/api/customizations', { query: { kind: 'agent', includeBody: '1' } });

    expect(res.body.count).toBe(1);
    expect(res.body.customizations[0].kind).toBe('agent');
    expect(res.body.customizations[0].body).toMatch(/Agent body/);
  });

  it('returns relevant instructions for files and prompt text', () => {
    write(path.join(repoDir, '.github', 'instructions', 'server.instructions.md'), `---
description: "Use when editing server routes."
applyTo: "server/**/*.js"
---
Server rules.
`);
    write(path.join(repoDir, '.github', 'instructions', 'database.instructions.md'), `---
description: "Use when changing database migrations."
---
Database rules.
`);

    const res = app.invoke('GET', '/api/customizations/relevant-instructions', {
      query: { files: 'server/routes/chat.js', userText: 'update database migrations', includeBody: '1' },
    });

    expect(res.statusCode).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.instructions.map(r => [r.name, r.body.trim()])).toEqual([
      ['server', 'Server rules.'],
      ['database', 'Database rules.'],
    ]);
  });

  it('runs a prompt template into chat-ready content and policy metadata', () => {
    write(path.join(repoDir, '.github', 'prompts', 'review.prompt.md'), `---
name: review
description: "Use when reviewing server changes."
agent: code-reviewer
model: [Claude Sonnet 4.5, GPT-5]
tools: [read, search]
---
Review this:\n{{input}}
`);
    write(path.join(repoDir, '.github', 'instructions', 'server.instructions.md'), `---
description: "Use when editing server code."
applyTo: "server/**/*.js"
---
Server rules.
`);

    const res = app.invoke('POST', '/api/customizations/run-prompt', {
      body: { name: 'review', input: 'Check the auth route.', files: ['server/routes/auth.js'] },
    });

    expect(res.statusCode).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.agent).toBe('code-reviewer');
    expect(res.body.model).toEqual(['Claude Sonnet 4.5', 'GPT-5']);
    expect(res.body.tools).toEqual(['read', 'search']);
    expect(res.body.toolPolicy.source).toBe('prompt');
    expect(res.body.toolPolicy.expandedTools).toContain('fauna_read_file');
    expect(res.body.content).toContain('Server rules.');
    expect(res.body.content).toContain('Check the auth route.');
  });

  it('returns 404 for an unknown prompt', () => {
    const res = app.invoke('POST', '/api/customizations/run-prompt', {
      body: { name: 'missing', input: 'x' },
    });

    expect(res.statusCode).toBe(404);
    expect(res.body.ok).toBe(false);
  });

  it('saves a repo prompt and returns the linted registry record', () => {
    const res = app.invoke('POST', '/api/customizations/save', {
      body: {
        kind: 'prompt',
        scope: 'repo',
        name: 'triage-bug',
        frontmatter: { description: 'Use when triaging bug reports.', tools: ['read', 'search'] },
        body: 'Triage this bug:\n{{input}}\n',
      },
    });

    const savedPath = path.join(repoDir, '.github', 'prompts', 'triage-bug.prompt.md');
    expect(res.statusCode).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.record.kind).toBe('prompt');
    expect(res.body.record.tools).toEqual(['read', 'search']);
    expect(fs.readFileSync(savedPath, 'utf8')).toContain('Triage this bug:');
  });

  it('saves a user hook JSON file', () => {
    const res = app.invoke('POST', '/api/customizations/save', {
      body: {
        kind: 'hooks',
        scope: 'user',
        name: 'policy',
        hooks: { PreToolUse: [{ type: 'command', command: 'node policy.js' }] },
      },
    });

    const savedPath = path.join(userDir, 'hooks', 'policy.json');
    expect(res.statusCode).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.record.kind).toBe('hooks');
    expect(res.body.record.hookEvents).toEqual(['PreToolUse']);
    expect(JSON.parse(fs.readFileSync(savedPath, 'utf8')).hooks.PreToolUse[0].command).toBe('node policy.js');
  });

  it('rejects customization writes outside allowed roots', () => {
    const outside = path.join(os.tmpdir(), 'outside.prompt.md');
    const res = app.invoke('POST', '/api/customizations/save', {
      body: {
        kind: 'prompt',
        name: 'escape-test',
        path: outside,
        frontmatter: { description: 'Bad path.' },
        body: 'Nope.',
      },
    });

    expect(res.statusCode).toBe(403);
    expect(res.body.ok).toBe(false);
  });

  it('returns agent runtime policy for .agent.md files', () => {
    write(path.join(repoDir, '.github', 'agents', 'reviewer.agent.md'), `---
name: reviewer
description: "Use when reviewing code."
tools: [read, search]
model: [Claude Sonnet 4.5, GPT-5]
agents: []
user-invocable: false
disable-model-invocation: true
---
You review code with high signal.
`);

    const res = app.invoke('GET', '/api/customizations/agent-policy/:name', {
      params: { name: 'reviewer' },
    });

    expect(res.statusCode).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.policy.name).toBe('reviewer');
    expect(res.body.policy.systemPrompt).toBe('You review code with high signal.');
    expect(res.body.policy.tools).toEqual(['read', 'search']);
    expect(res.body.policy.expandedTools).toContain('fauna_search_files');
    expect(res.body.policy.allowedSubagents).toEqual([]);
    expect(res.body.policy.userInvocable).toBe(false);
    expect(res.body.policy.disableModelInvocation).toBe(true);
    expect(res.body.toolPolicy.source).toBe('agent');
  });
});
