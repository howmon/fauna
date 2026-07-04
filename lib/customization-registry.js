// lib/customization-registry.js
//
// VS Code/Copilot-style customization registry for Fauna. This module is the
// shared discovery/parsing layer for prompt files, scoped instructions, custom
// agents, skills, hooks, and legacy always-on instruction files.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { lintSkill } from './skill-anatomy.js';

const FRONTMATTER_RE = /^---\s*\n([\s\S]*?)\n---\s*\n?/;
const NAME_RE = /^[a-z][a-z0-9-]{0,63}$/;

export const CUSTOMIZATION_KINDS = Object.freeze({
  PROMPT: 'prompt',
  INSTRUCTION: 'instruction',
  AGENT: 'agent',
  SKILL: 'skill',
  HOOKS: 'hooks',
  AGENT_INSTRUCTIONS: 'agent-instructions',
});

export const HOOK_EVENTS = Object.freeze([
  'SessionStart',
  'UserPromptSubmit',
  'PreToolUse',
  'PostToolUse',
  'PreCompact',
  'SubagentStart',
  'SubagentStop',
  'Stop',
]);

export const TOOL_ALIASES = Object.freeze({
  execute: ['fauna_shell_exec', 'fauna_verify_build'],
  read: ['fauna_read_file', 'fauna_get_reference', 'fauna_get_skill', 'fauna_get_agent_instructions'],
  edit: ['fauna_apply_patch', 'fauna_replace_string', 'fauna_write_file', 'fauna_write_files'],
  search: ['fauna_file_search', 'fauna_grep', 'fauna_context_search', 'fauna_list_references', 'fauna_list_skills', 'fauna_route_skill'],
  agent: ['fauna_get_agent_instructions', 'fauna_list_skills', 'fauna_get_skill', 'fauna_route_skill'],
  web: ['fauna_browser'],
  todo: ['fauna_create_task', 'fauna_update_task', 'fauna_list_tasks'],
});

function _stripQuotes(value) {
  const text = String(value || '').trim();
  const first = text[0];
  const last = text[text.length - 1];
  if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
    return text.slice(1, -1);
  }
  return text;
}

function _splitInlineArray(source) {
  const out = [];
  let token = '';
  let quote = '';
  for (const ch of String(source || '')) {
    if (quote) {
      token += ch;
      if (ch === quote) quote = '';
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      token += ch;
      continue;
    }
    if (ch === ',') {
      if (token.trim()) out.push(_parseFrontmatterValue(token.trim()));
      token = '';
      continue;
    }
    token += ch;
  }
  if (token.trim()) out.push(_parseFrontmatterValue(token.trim()));
  return out;
}

function _parseFrontmatterValue(raw) {
  const value = String(raw || '').trim();
  if (!value) return '';
  if (value === 'true') return true;
  if (value === 'false') return false;
  if (value === 'null') return null;
  if (/^-?\d+(?:\.\d+)?$/.test(value)) return Number(value);
  if (value.startsWith('[') && value.endsWith(']')) {
    return _splitInlineArray(value.slice(1, -1));
  }
  return _stripQuotes(value);
}

function _indentOf(line) {
  const match = String(line || '').match(/^\s*/);
  return match ? match[0].length : 0;
}

function _parseFrontmatterKeyValue(text) {
  const match = String(text || '').match(/^([a-zA-Z_][a-zA-Z0-9_-]*)\s*:\s*(.*)$/);
  return match ? { key: match[1], value: match[2] || '' } : null;
}

function _parseYamlBlock(lines, state, indent) {
  while (state.index < lines.length && !String(lines[state.index] || '').trim()) state.index++;
  const line = lines[state.index] || '';
  const trimmed = line.trim();
  if (_indentOf(line) < indent) return {};
  return trimmed.startsWith('- ') ? _parseYamlArray(lines, state, indent) : _parseYamlObject(lines, state, indent);
}

function _parseYamlArray(lines, state, indent) {
  const out = [];
  while (state.index < lines.length) {
    const line = lines[state.index];
    if (!String(line || '').trim()) { state.index++; continue; }
    const currentIndent = _indentOf(line);
    if (currentIndent < indent) break;
    const trimmed = line.trim();
    if (currentIndent !== indent || !trimmed.startsWith('- ')) break;
    const itemText = trimmed.slice(2).trim();
    state.index++;
    const itemKv = _parseFrontmatterKeyValue(itemText);
    if (!itemText) {
      out.push(_parseYamlBlock(lines, state, indent + 2));
    } else if (itemKv) {
      const item = {};
      item[itemKv.key] = itemKv.value ? _parseFrontmatterValue(itemKv.value) : _parseYamlBlock(lines, state, indent + 2);
      while (state.index < lines.length) {
        const nextLine = lines[state.index];
        if (!String(nextLine || '').trim()) { state.index++; continue; }
        const nextIndent = _indentOf(nextLine);
        if (nextIndent < indent + 2) break;
        if (nextIndent === indent && nextLine.trim().startsWith('- ')) break;
        if (nextIndent !== indent + 2) break;
        const nextKv = _parseFrontmatterKeyValue(nextLine.trim());
        if (!nextKv) break;
        state.index++;
        item[nextKv.key] = nextKv.value ? _parseFrontmatterValue(nextKv.value) : _parseYamlBlock(lines, state, nextIndent + 2);
      }
      out.push(item);
    } else {
      out.push(_parseFrontmatterValue(itemText));
    }
  }
  return out;
}

function _parseYamlObject(lines, state, indent) {
  const out = {};
  while (state.index < lines.length) {
    const line = lines[state.index];
    if (!String(line || '').trim()) { state.index++; continue; }
    const currentIndent = _indentOf(line);
    if (currentIndent < indent) break;
    if (currentIndent > indent) break;
    const kv = _parseFrontmatterKeyValue(line.trim());
    if (!kv) { state.index++; continue; }
    state.index++;
    out[kv.key] = kv.value ? _parseFrontmatterValue(kv.value) : _parseYamlBlock(lines, state, indent + 2);
  }
  return out;
}

export function parseCustomizationFrontmatter(source) {
  const text = String(source || '');
  const match = text.match(FRONTMATTER_RE);
  if (!match) return { frontmatter: {}, body: text, hasFrontmatter: false };

  const lines = match[1].split('\n');
  const frontmatter = _parseYamlObject(lines, { index: 0 }, 0);

  return {
    frontmatter,
    body: text.slice(match[0].length),
    hasFrontmatter: true,
  };
}

function _safeRead(filePath) {
  try {
    const stat = fs.statSync(filePath);
    if (!stat.isFile() || stat.size === 0) return null;
    return fs.readFileSync(filePath, 'utf8');
  } catch (_) {
    return null;
  }
}

function _safeList(dir) {
  try { return fs.readdirSync(dir, { withFileTypes: true }); }
  catch (_) { return []; }
}

function _slugFromFile(filePath) {
  const base = path.basename(filePath)
    .replace(/\.prompt\.md$/i, '')
    .replace(/\.instructions\.md$/i, '')
    .replace(/\.agent\.md$/i, '')
    .replace(/\.chatmode\.md$/i, '')
    .replace(/\.json$/i, '')
    .replace(/\.md$/i, '');
  return base.toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '');
}

function _normaliseArray(value) {
  if (Array.isArray(value)) return value.map(String).map(s => s.trim()).filter(Boolean);
  if (typeof value === 'string' && value.includes(',')) return value.split(',').map(s => s.trim()).filter(Boolean);
  if (typeof value === 'string' && value.trim()) return [value.trim()];
  return [];
}

function _normaliseToolList(value) {
  if (Array.isArray(value)) return value.map(String).map(s => s.trim()).filter(Boolean);
  if (value === '') return [];
  return _normaliseArray(value);
}

export function expandToolAliases(tools = []) {
  const out = [];
  const seen = new Set();
  for (const tool of _normaliseToolList(tools)) {
    const expanded = TOOL_ALIASES[tool] || [tool];
    for (const name of expanded) {
      if (!name || seen.has(name)) continue;
      seen.add(name);
      out.push(name);
    }
  }
  return out;
}

function _escapeRegExp(text) {
  return String(text).replace(/[|\\{}()[\]^$+?.]/g, '\\$&');
}

export function globToRegExp(glob) {
  const source = String(glob || '').trim().split(path.sep).join('/');
  let out = '^';
  for (let i = 0; i < source.length; i++) {
    const ch = source[i];
    const next = source[i + 1];
    if (ch === '*') {
      if (next === '*') {
        const after = source[i + 2];
        if (after === '/') {
          out += '(?:.*\/)?';
          i += 2;
        } else {
          out += '.*';
          i += 1;
        }
      } else {
        out += '[^/]*';
      }
    } else if (ch === '?') {
      out += '[^/]';
    } else {
      out += _escapeRegExp(ch);
    }
  }
  out += '$';
  return new RegExp(out);
}

export function matchesApplyTo(filePath, patterns = []) {
  const rel = String(filePath || '').split(path.sep).join('/').replace(/^\.\//, '');
  return _normaliseArray(patterns).some(pattern => globToRegExp(pattern).test(rel));
}

function _textTokens(text) {
  const matches = String(text || '').toLowerCase().match(/[a-z0-9]+/g) || [];
  return matches.filter(t => t.length > 2 && !['the', 'and', 'for', 'when', 'use', 'with', 'this', 'that', 'from', 'into', 'editing'].includes(t));
}

export function selectRelevantInstructions(records, opts = {}) {
  const files = _normaliseArray(opts.files || opts.touchedFiles);
  const queryTokens = new Set(_textTokens(opts.userText || opts.query || ''));
  const instructions = (records || []).filter(record => record.kind === CUSTOMIZATION_KINDS.INSTRUCTION);
  const selected = [];
  const seen = new Set();

  for (const record of instructions) {
    const applyTo = record.applyTo || _normaliseArray(record.frontmatter?.applyTo);
    if (!applyTo.length) continue;
    if (files.some(file => matchesApplyTo(file, applyTo))) {
      selected.push({ ...record, relevance: 'applyTo' });
      seen.add(record.path || record.name);
    }
  }

  for (const record of instructions) {
    const key = record.path || record.name;
    if (seen.has(key)) continue;
    const applyTo = record.applyTo || _normaliseArray(record.frontmatter?.applyTo);
    if (applyTo.length && files.length) continue;
    const descTokens = new Set(_textTokens(record.description || record.frontmatter?.description || ''));
    const overlap = [...queryTokens].filter(token => descTokens.has(token));
    if (overlap.length) selected.push({ ...record, relevance: 'description', matches: overlap });
  }

  return selected;
}

export function findCustomization(records, kind, name) {
  const target = String(name || '').trim().toLowerCase();
  if (!target) return null;
  return (records || []).find(record =>
    record.kind === kind && String(record.name || '').toLowerCase() === target
  ) || null;
}

export function renderPromptTemplate(body, opts = {}) {
  const input = String(opts.input ?? opts.arguments ?? opts.userText ?? '');
  const files = _normaliseArray(opts.files || opts.touchedFiles);
  const replacements = {
    input,
    arguments: input,
    args: input,
    files: files.join('\n'),
  };
  let rendered = String(body || '').replace(/\{\{\s*(input|arguments|args|files)\s*\}\}/g, (_m, key) => replacements[key] || '');
  if (input && rendered === String(body || '')) {
    rendered = rendered.trimEnd() + '\n\n## User Input\n' + input + '\n';
  }
  if (files.length && !/\{\{\s*files\s*\}\}/.test(String(body || ''))) {
    rendered = rendered.trimEnd() + '\n\n## Referenced Files\n' + files.map(file => '- ' + file).join('\n') + '\n';
  }
  return rendered;
}

export function buildPromptInvocation(records, opts = {}) {
  const prompt = findCustomization(records, CUSTOMIZATION_KINDS.PROMPT, opts.name);
  if (!prompt) {
    const err = new Error(`Prompt not found: ${opts.name || ''}`);
    err.code = 'PROMPT_NOT_FOUND';
    throw err;
  }
  if (prompt.ok === false) {
    const err = new Error(`Prompt "${prompt.name}" has validation errors.`);
    err.code = 'PROMPT_INVALID';
    err.errors = prompt.errors || [];
    throw err;
  }
  const input = String(opts.input ?? opts.arguments ?? opts.userText ?? '');
  const files = _normaliseArray(opts.files || opts.touchedFiles);
  const instructions = selectRelevantInstructions(records, { files, userText: input });
  const instructionBlock = instructions.length
    ? '## Relevant Instructions\n\n' + instructions.map(record => {
      const label = record.name || record.relativePath || record.path;
      return `### ${label}\n${String(record.body || '').trim()}`;
    }).join('\n\n')
    : '';
  const promptBody = renderPromptTemplate(prompt.body || '', { input, files });
  const content = [instructionBlock, promptBody].filter(Boolean).join('\n\n').trim() + '\n';
  const fm = prompt.frontmatter || {};
  return {
    prompt,
    instructions,
    content,
    model: Array.isArray(prompt.model) ? prompt.model : (prompt.model || []),
    agent: fm.agent || null,
    tools: prompt.tools || [],
    argumentHint: fm['argument-hint'] || null,
  };
}

export function buildAgentPolicy(records, opts = {}) {
  const agent = findCustomization(records, CUSTOMIZATION_KINDS.AGENT, opts.name);
  if (!agent) {
    const err = new Error(`Agent not found: ${opts.name || ''}`);
    err.code = 'AGENT_NOT_FOUND';
    throw err;
  }
  if (agent.ok === false) {
    const err = new Error(`Agent "${agent.name}" has validation errors.`);
    err.code = 'AGENT_INVALID';
    err.errors = agent.errors || [];
    throw err;
  }
  const fm = agent.frontmatter || {};
  const hasTools = Object.prototype.hasOwnProperty.call(fm, 'tools');
  const tools = hasTools ? _normaliseToolList(fm.tools) : [];
  const hasAgents = Object.prototype.hasOwnProperty.call(fm, 'agents');
  return {
    name: agent.name,
    description: agent.description,
    path: agent.relativePath || agent.path,
    scope: agent.scope,
    systemPrompt: String(agent.body || '').trim(),
    model: Array.isArray(agent.model) ? agent.model : [],
    tools,
    expandedTools: hasTools ? expandToolAliases(tools) : null,
    unrestrictedTools: !hasTools,
    allowedSubagents: hasAgents ? _normaliseArray(fm.agents) : null,
    userInvocable: agent.userInvocable !== false,
    disableModelInvocation: agent.disableModelInvocation === true,
    warnings: agent.warnings || [],
  };
}

export function resolveToolPolicy(context = {}) {
  const hasPrompt = Object.prototype.hasOwnProperty.call(context, 'promptTools');
  const hasAgent = Object.prototype.hasOwnProperty.call(context, 'agentTools');
  const hasSkill = Object.prototype.hasOwnProperty.call(context, 'skillTools');
  const source = hasPrompt ? 'prompt' : hasAgent ? 'agent' : hasSkill ? 'skill' : 'default';
  const tools = hasPrompt ? _normaliseToolList(context.promptTools)
    : hasAgent ? _normaliseToolList(context.agentTools)
      : hasSkill ? _normaliseToolList(context.skillTools)
        : [];
  return {
    source,
    unrestricted: source === 'default',
    tools,
    expandedTools: source === 'default' ? null : expandToolAliases(tools),
  };
}

export function filterToolsByPolicy(tools, policy) {
  if (!Array.isArray(tools) || !tools.length) return tools;
  if (!policy || policy.unrestricted || policy.source === 'default') return tools;
  const allowed = new Set(Array.isArray(policy.expandedTools) ? policy.expandedTools : expandToolAliases(policy.tools || []));
  return tools.filter(tool => {
    const name = tool?.function?.name || tool?.name;
    return !name || allowed.has(name);
  });
}

function _inferKind(filePath) {
  const normalized = filePath.split(path.sep).join('/');
  const name = path.basename(filePath);
  if (name.endsWith('.prompt.md')) return CUSTOMIZATION_KINDS.PROMPT;
  if (name.endsWith('.instructions.md')) return CUSTOMIZATION_KINDS.INSTRUCTION;
  if (name.endsWith('.agent.md') || name.endsWith('.chatmode.md')) return CUSTOMIZATION_KINDS.AGENT;
  if (name === 'SKILL.md') return CUSTOMIZATION_KINDS.SKILL;
  if (name === 'AGENTS.md' || name === 'copilot-instructions.md') return CUSTOMIZATION_KINDS.AGENT_INSTRUCTIONS;
  if (normalized.includes('/hooks/') && name.endsWith('.json')) return CUSTOMIZATION_KINDS.HOOKS;
  return null;
}

function _displayName(filePath, frontmatter, kind) {
  if (frontmatter.name) return String(frontmatter.name);
  if (kind === CUSTOMIZATION_KINDS.SKILL) return path.basename(path.dirname(filePath));
  if (kind === CUSTOMIZATION_KINDS.AGENT_INSTRUCTIONS) return path.basename(filePath).replace(/\.md$/i, '');
  return _slugFromFile(filePath);
}

function _scopePath(filePath, workspaceRoot) {
  const rel = workspaceRoot ? path.relative(workspaceRoot, filePath) : filePath;
  return rel && !rel.startsWith('..') && !path.isAbsolute(rel) ? rel : filePath;
}

function _validateHooks(record, parsedJson) {
  const errors = [];
  const warnings = [];
  if (!parsedJson || typeof parsedJson !== 'object' || Array.isArray(parsedJson)) {
    errors.push('Hooks file must contain a JSON object.');
    return { errors, warnings };
  }
  const hooks = parsedJson.hooks || parsedJson;
  if (!hooks || typeof hooks !== 'object' || Array.isArray(hooks)) {
    errors.push('Hooks file must contain a `hooks` object.');
    return { errors, warnings };
  }
  const known = new Set(HOOK_EVENTS);
  for (const [event, entries] of Object.entries(hooks)) {
    if (!known.has(event)) warnings.push(`Unknown hook event "${event}".`);
    if (!Array.isArray(entries)) {
      errors.push(`Hook event "${event}" must be an array.`);
      continue;
    }
    entries.forEach((entry, index) => {
      if (!entry || typeof entry !== 'object') errors.push(`Hook "${event}" entry ${index + 1} must be an object.`);
      else if (entry.type !== 'command') warnings.push(`Hook "${event}" entry ${index + 1} should use type="command".`);
      if (!entry?.command && !entry?.windows && !entry?.linux && !entry?.osx) {
        errors.push(`Hook "${event}" entry ${index + 1} needs a command or platform command.`);
      }
    });
  }
  return { errors, warnings };
}

export function lintCustomization(record) {
  const errors = [];
  const warnings = [];
  const info = [];
  const kind = record?.kind;
  const fm = record?.frontmatter || {};

  if (!kind) errors.push('Unknown customization kind.');

  if ([CUSTOMIZATION_KINDS.PROMPT, CUSTOMIZATION_KINDS.INSTRUCTION, CUSTOMIZATION_KINDS.AGENT].includes(kind)) {
    if (!record.hasFrontmatter) warnings.push('Missing YAML frontmatter; discovery and policy controls will be limited.');
    if (!fm.description) warnings.push('Frontmatter `description` is recommended for discovery.');
  }

  if (kind === CUSTOMIZATION_KINDS.INSTRUCTION) {
    const applyTo = _normaliseArray(fm.applyTo);
    if (applyTo.includes('**')) warnings.push('`applyTo: "**"` attaches to every edit and can burn context.');
    record.applyTo = applyTo;
  }

  if (kind === CUSTOMIZATION_KINDS.PROMPT || kind === CUSTOMIZATION_KINDS.AGENT) {
    record.tools = _normaliseToolList(fm.tools);
    record.model = Array.isArray(fm.model) ? fm.model : (fm.model ? [String(fm.model)] : []);
  }

  if (fm.hooks && typeof fm.hooks === 'object' && !Array.isArray(fm.hooks)) {
    record.hooks = fm.hooks;
    const hookLint = _validateHooks(record, { hooks: fm.hooks });
    errors.push(...hookLint.errors);
    warnings.push(...hookLint.warnings);
  }

  if (kind === CUSTOMIZATION_KINDS.AGENT) {
    record.agents = _normaliseArray(fm.agents);
    record.userInvocable = fm['user-invocable'] !== false;
    record.disableModelInvocation = fm['disable-model-invocation'] === true;
  }

  if (kind === CUSTOMIZATION_KINDS.SKILL) {
    const skillLint = lintSkill(record.source || '', { dirName: path.basename(path.dirname(record.path || '')) });
    errors.push(...skillLint.errors);
    warnings.push(...skillLint.warnings);
    info.push(...skillLint.info);
    record.userInvocable = fm['user-invocable'] !== false;
    record.disableModelInvocation = fm['disable-model-invocation'] === true;
  }

  if (kind === CUSTOMIZATION_KINDS.HOOKS) {
    try {
      const parsed = JSON.parse(record.source || '{}');
      record.hooks = parsed.hooks || parsed;
      const hookLint = _validateHooks(record, parsed);
      errors.push(...hookLint.errors);
      warnings.push(...hookLint.warnings);
    } catch (e) {
      errors.push(`Invalid JSON: ${e.message}`);
    }
  }

  const name = String(record.name || '').trim();
  if ([CUSTOMIZATION_KINDS.PROMPT, CUSTOMIZATION_KINDS.AGENT, CUSTOMIZATION_KINDS.SKILL].includes(kind) && name && !NAME_RE.test(name)) {
    warnings.push(`Name "${name}" should be lowercase alphanumeric with hyphens, max 64 chars.`);
  }

  return { ok: errors.length === 0, errors, warnings, info };
}

function _recordFromFile(filePath, { workspaceRoot, scope }) {
  const kind = _inferKind(filePath);
  if (!kind) return null;
  const source = _safeRead(filePath);
  if (source == null) return null;
  const parsed = kind === CUSTOMIZATION_KINDS.HOOKS
    ? { frontmatter: {}, body: '', hasFrontmatter: false }
    : parseCustomizationFrontmatter(source);
  const record = {
    kind,
    name: _displayName(filePath, parsed.frontmatter, kind),
    description: String(parsed.frontmatter.description || '').trim(),
    scope,
    path: filePath,
    relativePath: _scopePath(filePath, workspaceRoot),
    frontmatter: parsed.frontmatter,
    body: parsed.body,
    source,
    hasFrontmatter: parsed.hasFrontmatter,
    enabled: true,
  };
  const lint = lintCustomization(record);
  record.ok = lint.ok;
  record.errors = lint.errors;
  record.warnings = lint.warnings;
  record.info = lint.info;
  return record;
}

function _pushIfFile(out, seen, filePath, opts) {
  const key = path.resolve(filePath);
  if (seen.has(key)) return;
  seen.add(key);
  const record = _recordFromFile(key, opts);
  if (record) out.push(record);
}

function _scanFlat(out, seen, dir, predicate, opts) {
  for (const ent of _safeList(dir)) {
    const full = path.join(dir, ent.name);
    if (ent.isFile() && predicate(ent.name, full)) _pushIfFile(out, seen, full, opts);
  }
}

function _scanSkillRoot(out, seen, dir, opts) {
  for (const ent of _safeList(dir)) {
    if (!ent.isDirectory()) continue;
    _pushIfFile(out, seen, path.join(dir, ent.name, 'SKILL.md'), opts);
  }
}

export function discoverCustomizations(opts = {}) {
  const workspaceRoot = opts.workspaceRoot ? path.resolve(opts.workspaceRoot) : process.cwd();
  const includeUser = opts.includeUser !== false;
  const userConfigDir = opts.userConfigDir || path.join(os.homedir(), '.config', 'fauna');
  const userHome = opts.userHome || os.homedir();
  const out = [];
  const seen = new Set();

  const repoOpts = { workspaceRoot, scope: 'repo' };
  _pushIfFile(out, seen, path.join(workspaceRoot, 'AGENTS.md'), repoOpts);
  _pushIfFile(out, seen, path.join(workspaceRoot, '.github', 'copilot-instructions.md'), repoOpts);
  _scanFlat(out, seen, path.join(workspaceRoot, '.github', 'prompts'), n => n.endsWith('.prompt.md'), repoOpts);
  _scanFlat(out, seen, path.join(workspaceRoot, '.github', 'instructions'), n => n.endsWith('.instructions.md'), repoOpts);
  _scanFlat(out, seen, path.join(workspaceRoot, '.github', 'agents'), n => n.endsWith('.agent.md') || n.endsWith('.chatmode.md'), repoOpts);
  _scanFlat(out, seen, path.join(workspaceRoot, '.github', 'hooks'), n => n.endsWith('.json'), repoOpts);
  _scanSkillRoot(out, seen, path.join(workspaceRoot, 'skills'), repoOpts);
  _scanSkillRoot(out, seen, path.join(workspaceRoot, '.github', 'skills'), repoOpts);
  _scanSkillRoot(out, seen, path.join(workspaceRoot, '.agents', 'skills'), repoOpts);
  _scanSkillRoot(out, seen, path.join(workspaceRoot, '.claude', 'skills'), repoOpts);

  if (includeUser) {
    const userOpts = { workspaceRoot, scope: 'user' };
    _pushIfFile(out, seen, path.join(userConfigDir, 'AGENTS.md'), userOpts);
    _scanFlat(out, seen, path.join(userConfigDir, 'prompts'), n => n.endsWith('.prompt.md'), userOpts);
    _scanFlat(out, seen, path.join(userConfigDir, 'instructions'), n => n.endsWith('.instructions.md'), userOpts);
    _scanFlat(out, seen, path.join(userConfigDir, 'agents'), n => n.endsWith('.agent.md') || n.endsWith('.chatmode.md'), userOpts);
    _scanFlat(out, seen, path.join(userConfigDir, 'hooks'), n => n.endsWith('.json'), userOpts);
    _scanSkillRoot(out, seen, path.join(userConfigDir, 'skills'), userOpts);
    _scanSkillRoot(out, seen, path.join(userHome, '.copilot', 'skills'), userOpts);
    _scanSkillRoot(out, seen, path.join(userHome, '.agents', 'skills'), userOpts);
    _scanSkillRoot(out, seen, path.join(userHome, '.claude', 'skills'), userOpts);
  }

  return out.sort((a, b) => {
    const scope = a.scope.localeCompare(b.scope);
    if (scope) return scope;
    const kind = a.kind.localeCompare(b.kind);
    if (kind) return kind;
    return a.name.localeCompare(b.name);
  });
}

export function groupCustomizations(records) {
  const grouped = {};
  for (const kind of Object.values(CUSTOMIZATION_KINDS)) grouped[kind] = [];
  for (const record of records || []) {
    if (!grouped[record.kind]) grouped[record.kind] = [];
    grouped[record.kind].push(record);
  }
  return grouped;
}
