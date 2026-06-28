import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  buildAgentPolicy,
  buildPromptInvocation,
  CUSTOMIZATION_KINDS,
  discoverCustomizations,
  expandToolAliases,
  filterToolsByPolicy,
  matchesApplyTo,
  groupCustomizations,
  parseCustomizationFrontmatter,
  resolveToolPolicy,
  selectRelevantInstructions,
} from '../lib/customization-registry.js';

function makeTmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'fauna-customizations-'));
}

function write(filePath, body) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, body, 'utf8');
}

describe('parseCustomizationFrontmatter', () => {
  it('parses booleans and inline arrays', () => {
    const parsed = parseCustomizationFrontmatter(`---
name: code-reviewer
tools: [read, search, execute]
user-invocable: false
disable-model-invocation: true
---
Body
`);
    expect(parsed.hasFrontmatter).toBe(true);
    expect(parsed.frontmatter.name).toBe('code-reviewer');
    expect(parsed.frontmatter.tools).toEqual(['read', 'search', 'execute']);
    expect(parsed.frontmatter['user-invocable']).toBe(false);
    expect(parsed.frontmatter['disable-model-invocation']).toBe(true);
    expect(parsed.body).toBe('Body\n');
  });

  it('parses nested hook arrays in frontmatter', () => {
    const parsed = parseCustomizationFrontmatter(`---
name: guarded-agent
hooks:
  UserPromptSubmit:
    - type: command
      command: ./scripts/check-prompt.js
      timeout: 2500
  SubagentStart:
    - type: command
      osx: ./scripts/subagent-start.sh
---
Body
`);

    expect(parsed.frontmatter.hooks.UserPromptSubmit).toEqual([{ type: 'command', command: './scripts/check-prompt.js', timeout: 2500 }]);
    expect(parsed.frontmatter.hooks.SubagentStart).toEqual([{ type: 'command', osx: './scripts/subagent-start.sh' }]);
  });
});

describe('discoverCustomizations', () => {
  let repoDir;
  let userDir;
  let userHome;

  beforeEach(() => {
    repoDir = makeTmpDir();
    userDir = makeTmpDir();
    userHome = makeTmpDir();
  });

  afterEach(() => {
    fs.rmSync(repoDir, { recursive: true, force: true });
    fs.rmSync(userDir, { recursive: true, force: true });
    fs.rmSync(userHome, { recursive: true, force: true });
  });

  it('discovers prompts, scoped instructions, custom agents, hooks, skills, and legacy instructions', () => {
    write(path.join(repoDir, 'AGENTS.md'), '# Repo Instructions\n');
    write(path.join(repoDir, '.github', 'prompts', 'review-api.prompt.md'), `---
name: review-api
description: "Use when reviewing API changes."
agent: code-reviewer
model: [Claude Sonnet 4.5, GPT-5]
tools: [read, search]
---
Review the API change.
`);
    write(path.join(repoDir, '.github', 'instructions', 'server.instructions.md'), `---
description: "Use when editing server code."
applyTo: "server/**/*.js"
---
Prefer small route handlers.
`);
    write(path.join(repoDir, '.github', 'agents', 'code-reviewer.agent.md'), `---
name: code-reviewer
description: "Use when reviewing code changes."
tools: [read, search]
user-invocable: false
hooks:
  UserPromptSubmit:
    - type: command
      command: ./scripts/prompt-policy.sh
---
You review code.
`);
    write(path.join(repoDir, '.github', 'hooks', 'policy.json'), JSON.stringify({
      hooks: { PreToolUse: [{ type: 'command', command: './scripts/policy.sh' }] },
    }, null, 2));
    write(path.join(repoDir, 'skills', 'debugging', 'SKILL.md'), `---
name: debugging
description: "Use when diagnosing failures."
---
# Debugging

## Overview
Diagnose failures.

## When to Use
- Failures

## Process
1. Reproduce

## Common Rationalizations
- None

## Red Flags
- Guessing

## Verification
- Run a check
`);
    write(path.join(userDir, 'prompts', 'standup.prompt.md'), `---
name: standup
description: "Use when writing standups."
---
Write a standup.
`);

    const records = discoverCustomizations({ workspaceRoot: repoDir, userConfigDir: userDir, userHome });
    const grouped = groupCustomizations(records);

    expect(grouped[CUSTOMIZATION_KINDS.AGENT_INSTRUCTIONS]).toHaveLength(1);
    expect(grouped[CUSTOMIZATION_KINDS.PROMPT].map(r => r.name).sort()).toEqual(['review-api', 'standup']);
    expect(grouped[CUSTOMIZATION_KINDS.INSTRUCTION][0].applyTo).toEqual(['server/**/*.js']);
    expect(grouped[CUSTOMIZATION_KINDS.AGENT][0].tools).toEqual(['read', 'search']);
    expect(grouped[CUSTOMIZATION_KINDS.AGENT][0].userInvocable).toBe(false);
    expect(grouped[CUSTOMIZATION_KINDS.AGENT][0].hooks.UserPromptSubmit[0].command).toBe('./scripts/prompt-policy.sh');
    expect(grouped[CUSTOMIZATION_KINDS.HOOKS][0].hooks.PreToolUse[0].command).toBe('./scripts/policy.sh');
    expect(grouped[CUSTOMIZATION_KINDS.SKILL][0].ok).toBe(true);
    expect(records.every(r => r.enabled)).toBe(true);
  });

  it('warns on broad applyTo and invalid hooks', () => {
    write(path.join(repoDir, '.github', 'instructions', 'global.instructions.md'), `---
description: "Use everywhere."
applyTo: "**"
---
Global rules.
`);
    write(path.join(repoDir, '.github', 'hooks', 'bad.json'), JSON.stringify({
      hooks: { PreToolUse: [{ type: 'command' }] },
    }));

    const records = discoverCustomizations({ workspaceRoot: repoDir, userConfigDir: userDir, userHome });
    const instruction = records.find(r => r.kind === CUSTOMIZATION_KINDS.INSTRUCTION);
    const hooks = records.find(r => r.kind === CUSTOMIZATION_KINDS.HOOKS);

    expect(instruction.warnings.join(' ')).toMatch(/burn context/i);
    expect(hooks.ok).toBe(false);
    expect(hooks.errors.join(' ')).toMatch(/needs a command/i);
  });
});

describe('instruction relevance', () => {
  it('matches applyTo globs against touched files', () => {
    expect(matchesApplyTo('server/routes/chat.js', ['server/**/*.js'])).toBe(true);
    expect(matchesApplyTo('public/css/styles.css', ['server/**/*.js'])).toBe(false);
  });

  it('selects instructions by applyTo before description discovery', () => {
    const records = [
      {
        kind: CUSTOMIZATION_KINDS.INSTRUCTION,
        name: 'server',
        path: '/repo/.github/instructions/server.instructions.md',
        description: 'Use when editing server routes.',
        frontmatter: { applyTo: 'server/**/*.js' },
      },
      {
        kind: CUSTOMIZATION_KINDS.INSTRUCTION,
        name: 'database',
        path: '/repo/.github/instructions/database.instructions.md',
        description: 'Use when editing migrations and database queries.',
        frontmatter: {},
      },
    ];

    const byFile = selectRelevantInstructions(records, {
      files: ['server/routes/chat.js'],
      userText: 'change the database query',
    });
    expect(byFile.map(r => [r.name, r.relevance])).toEqual([
      ['server', 'applyTo'],
      ['database', 'description'],
    ]);

    const byText = selectRelevantInstructions(records, {
      userText: 'adjust database migrations',
    });
    expect(byText.map(r => r.name)).toEqual(['database']);
  });
});

describe('prompt invocation', () => {
  it('renders prompt templates with arguments, files, and relevant instructions', () => {
    const records = [
      {
        kind: CUSTOMIZATION_KINDS.PROMPT,
        name: 'review-api',
        ok: true,
        frontmatter: { agent: 'code-reviewer', 'argument-hint': 'Route diff' },
        body: 'Review this change:\n{{input}}\n\nFiles:\n{{files}}\n',
        tools: ['read', 'search'],
        model: ['Claude Sonnet 4.5', 'GPT-5'],
      },
      {
        kind: CUSTOMIZATION_KINDS.INSTRUCTION,
        name: 'server',
        path: '/repo/.github/instructions/server.instructions.md',
        description: 'Use when editing server routes.',
        frontmatter: { applyTo: 'server/**/*.js' },
        body: 'Keep handlers small.',
        applyTo: ['server/**/*.js'],
      },
    ];

    const invocation = buildPromptInvocation(records, {
      name: 'review-api',
      input: 'Check auth behavior.',
      files: ['server/routes/auth.js'],
    });

    expect(invocation.agent).toBe('code-reviewer');
    expect(invocation.tools).toEqual(['read', 'search']);
    expect(invocation.model).toEqual(['Claude Sonnet 4.5', 'GPT-5']);
    expect(invocation.content).toContain('## Relevant Instructions');
    expect(invocation.content).toContain('Keep handlers small.');
    expect(invocation.content).toContain('Check auth behavior.');
    expect(invocation.content).toContain('server/routes/auth.js');
  });

  it('throws a typed error when the prompt is missing', () => {
    expect(() => buildPromptInvocation([], { name: 'missing' })).toThrow(/Prompt not found/);
  });
});

describe('agent and tool policy', () => {
  it('expands VS Code-style tool aliases deterministically', () => {
    expect(expandToolAliases(['read', 'search', 'custom_tool'])).toEqual([
      'fauna_read_file',
      'fauna_list_files',
      'fauna_get_reference',
      'fauna_get_skill',
      'fauna_get_agent_instructions',
      'fauna_search_files',
      'fauna_list_references',
      'fauna_list_skills',
      'custom_tool',
    ]);
  });

  it('builds runtime policy from .agent.md frontmatter', () => {
    const records = [{
      kind: CUSTOMIZATION_KINDS.AGENT,
      name: 'code-reviewer',
      description: 'Use when reviewing code.',
      path: '/repo/.github/agents/code-reviewer.agent.md',
      scope: 'repo',
      ok: true,
      frontmatter: {
        name: 'code-reviewer',
        tools: ['read', 'search'],
        model: ['Claude Sonnet 4.5', 'GPT-5'],
        agents: [],
        'user-invocable': false,
        'disable-model-invocation': true,
      },
      body: 'You review code changes.',
      tools: ['read', 'search'],
      model: ['Claude Sonnet 4.5', 'GPT-5'],
      userInvocable: false,
      disableModelInvocation: true,
      warnings: [],
    }];

    const policy = buildAgentPolicy(records, { name: 'code-reviewer' });
    expect(policy.systemPrompt).toBe('You review code changes.');
    expect(policy.model).toEqual(['Claude Sonnet 4.5', 'GPT-5']);
    expect(policy.tools).toEqual(['read', 'search']);
    expect(policy.expandedTools).toContain('fauna_read_file');
    expect(policy.allowedSubagents).toEqual([]);
    expect(policy.userInvocable).toBe(false);
    expect(policy.disableModelInvocation).toBe(true);
  });

  it('resolves tool policy precedence prompt over agent over skill', () => {
    expect(resolveToolPolicy({ agentTools: ['read'], skillTools: ['execute'] })).toMatchObject({
      source: 'agent',
      tools: ['read'],
      unrestricted: false,
    });
    expect(resolveToolPolicy({ promptTools: [], agentTools: ['read'] })).toMatchObject({
      source: 'prompt',
      tools: [],
      expandedTools: [],
    });
    expect(resolveToolPolicy({})).toMatchObject({ source: 'default', unrestricted: true, expandedTools: null });
  });

  it('filters tool schemas by resolved policy allowlist', () => {
    const tools = [
      { type: 'function', function: { name: 'fauna_read_file' } },
      { type: 'function', function: { name: 'fauna_shell_exec' } },
      { type: 'function', function: { name: 'custom_tool' } },
    ];
    const policy = resolveToolPolicy({ promptTools: ['read', 'custom_tool'] });
    expect(filterToolsByPolicy(tools, policy).map(t => t.function.name)).toEqual([
      'fauna_read_file',
      'custom_tool',
    ]);
    expect(filterToolsByPolicy(tools, resolveToolPolicy({}))).toHaveLength(3);
  });
});
