import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildAgentPolicy, buildPromptInvocation, discoverCustomizations, groupCustomizations, resolveToolPolicy, selectRelevantInstructions } from '../../lib/customization-registry.js';

const WRITABLE_KINDS = new Set(['prompt', 'instruction', 'agent', 'skill', 'hooks']);
const NAME_RE = /^[a-z][a-z0-9-]{0,63}$/;

function _publicRecord(record, { includeBody = false } = {}) {
  const out = {
    kind: record.kind,
    name: record.name,
    description: record.description,
    scope: record.scope,
    path: record.relativePath || record.path,
    frontmatter: record.frontmatter || {},
    enabled: record.enabled !== false,
    ok: !!record.ok,
    errors: record.errors || [],
    warnings: record.warnings || [],
    info: record.info || [],
  };
  if (record.applyTo) out.applyTo = record.applyTo;
  if (record.tools) out.tools = record.tools;
  if (record.model) out.model = record.model;
  if (record.agents) out.agents = record.agents;
  if (typeof record.userInvocable === 'boolean') out.userInvocable = record.userInvocable;
  if (typeof record.disableModelInvocation === 'boolean') out.disableModelInvocation = record.disableModelInvocation;
  if (record.hooks) out.hookEvents = Object.keys(record.hooks);
  if (record.hooks) out.hooks = record.hooks;
  if (includeBody) {
    out.body = record.body || '';
    if (record.kind === 'hooks') out.body = record.source || JSON.stringify(record.hooks || {}, null, 2);
  }
  return out;
}

function _isInside(parent, child) {
  const rel = path.relative(path.resolve(parent), path.resolve(child));
  return rel === '' || (!!rel && !rel.startsWith('..') && !path.isAbsolute(rel));
}

function _canonicalPath({ workspaceRoot, userConfigRoot, kind, name, scope }) {
  const root = scope === 'user' ? userConfigRoot : workspaceRoot;
  if (kind === 'prompt') return path.join(root, scope === 'user' ? 'prompts' : path.join('.github', 'prompts'), name + '.prompt.md');
  if (kind === 'instruction') return path.join(root, scope === 'user' ? 'instructions' : path.join('.github', 'instructions'), name + '.instructions.md');
  if (kind === 'agent') return path.join(root, scope === 'user' ? 'agents' : path.join('.github', 'agents'), name + '.agent.md');
  if (kind === 'skill') return path.join(root, 'skills', name, 'SKILL.md');
  if (kind === 'hooks') return path.join(root, scope === 'user' ? 'hooks' : path.join('.github', 'hooks'), name + '.json');
  return null;
}

function _kindMatchesPath(kind, filePath) {
  const normalized = filePath.split(path.sep).join('/');
  const base = path.basename(filePath);
  if (kind === 'prompt') return base.endsWith('.prompt.md');
  if (kind === 'instruction') return base.endsWith('.instructions.md');
  if (kind === 'agent') return base.endsWith('.agent.md') || base.endsWith('.chatmode.md');
  if (kind === 'skill') return base === 'SKILL.md';
  if (kind === 'hooks') return normalized.includes('/hooks/') && base.endsWith('.json');
  return false;
}

function _resolveWritePath({ workspaceRoot, userConfigRoot, kind, name, scope, requestedPath }) {
  if (requestedPath) {
    const candidate = path.isAbsolute(requestedPath) ? requestedPath : path.join(workspaceRoot, requestedPath);
    const allowed = [workspaceRoot, userConfigRoot].some(root => root && _isInside(root, candidate));
    if (!allowed) {
      const err = new Error('Customization path must be inside the workspace or Fauna config directory.');
      err.code = 'CUSTOMIZATION_PATH_FORBIDDEN';
      throw err;
    }
    if (!_kindMatchesPath(kind, candidate)) {
      const err = new Error(`Path does not match customization kind "${kind}".`);
      err.code = 'CUSTOMIZATION_PATH_INVALID';
      throw err;
    }
    return candidate;
  }
  return _canonicalPath({ workspaceRoot, userConfigRoot, kind, name, scope });
}

function _frontmatterValue(value) {
  if (Array.isArray(value)) return '[' + value.map(_frontmatterValue).join(', ') + ']';
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (typeof value === 'number') return String(value);
  const text = String(value ?? '');
  if (!text || /[:#\[\]{},]|^\s|\s$|\n/.test(text)) return JSON.stringify(text);
  return text;
}

function _markdownSource(frontmatter, body) {
  const fm = frontmatter && typeof frontmatter === 'object' && !Array.isArray(frontmatter) ? frontmatter : {};
  const lines = Object.entries(fm)
    .filter(([, value]) => value !== undefined && value !== null && value !== '')
    .map(([key, value]) => `${key}: ${_frontmatterValue(value)}`);
  return ['---', ...lines, '---', String(body || '').trimStart()].join('\n').replace(/\s*$/, '\n');
}

function _hooksSource(body, hooks) {
  if (body && String(body).trim()) {
    const parsed = JSON.parse(String(body));
    return JSON.stringify(parsed, null, 2) + '\n';
  }
  return JSON.stringify({ hooks: hooks && typeof hooks === 'object' ? hooks : {} }, null, 2) + '\n';
}

export function registerCustomizationRoutes(app, deps = {}) {
  const workspaceRoot = path.resolve(deps.workspaceRoot || process.cwd());
  const userConfigDir = deps.userConfigDir;
  const userConfigRoot = path.resolve(userConfigDir || path.join(os.homedir(), '.config', 'fauna'));
  const userHome = deps.userHome;
  const jsonParser = deps.express ? deps.express.json({ limit: '1mb' }) : (_req, _res, next) => next();

  app.get('/api/customizations', (req, res) => {
    try {
      const includeBody = String(req.query?.includeBody || '') === '1';
      const includeUser = String(req.query?.includeUser || '1') !== '0';
      const kind = String(req.query?.kind || '').trim();
      let records = discoverCustomizations({ workspaceRoot, userConfigDir, userHome, includeUser });
      if (kind) records = records.filter(record => record.kind === kind);
      const items = records.map(record => _publicRecord(record, { includeBody }));
      res.json({
        ok: true,
        count: items.length,
        customizations: items,
        grouped: groupCustomizations(items),
      });
    } catch (e) {
      res.status(500).json({ ok: false, error: e.message });
    }
  });

  app.get('/api/customizations/relevant-instructions', (req, res) => {
    try {
      const includeBody = String(req.query?.includeBody || '') === '1';
      const includeUser = String(req.query?.includeUser || '1') !== '0';
      const userText = String(req.query?.userText || req.query?.q || '');
      const files = Array.isArray(req.query?.file)
        ? req.query.file
        : String(req.query?.files || req.query?.file || '').split(',').map(s => s.trim()).filter(Boolean);
      const records = discoverCustomizations({ workspaceRoot, userConfigDir, userHome, includeUser });
      const instructions = selectRelevantInstructions(records, { files, userText })
        .map(record => _publicRecord(record, { includeBody }));
      res.json({ ok: true, count: instructions.length, instructions });
    } catch (e) {
      res.status(500).json({ ok: false, error: e.message });
    }
  });

  app.post('/api/customizations/run-prompt', jsonParser, (req, res) => {
    try {
      const body = req.body || {};
      const includeUser = body.includeUser !== false;
      const records = discoverCustomizations({ workspaceRoot, userConfigDir, userHome, includeUser });
      const invocation = buildPromptInvocation(records, {
        name: body.name,
        input: body.input ?? body.arguments ?? body.userText,
        files: body.files || body.file,
      });
      const toolPolicy = resolveToolPolicy({ promptTools: invocation.tools });
      res.json({
        ok: true,
        prompt: _publicRecord(invocation.prompt),
        instructions: invocation.instructions.map(record => _publicRecord(record)),
        content: invocation.content,
        model: invocation.model,
        agent: invocation.agent,
        tools: invocation.tools,
        toolPolicy,
        argumentHint: invocation.argumentHint,
      });
    } catch (e) {
      const status = e.code === 'PROMPT_NOT_FOUND' ? 404 : e.code === 'PROMPT_INVALID' ? 422 : 500;
      res.status(status).json({ ok: false, error: e.message, errors: e.errors || [] });
    }
  });

  app.post('/api/customizations/save', jsonParser, (req, res) => {
    try {
      const body = req.body || {};
      const kind = String(body.kind || '').trim();
      const scope = body.scope === 'user' ? 'user' : 'repo';
      const name = String(body.name || body.frontmatter?.name || '').trim().toLowerCase();
      if (!WRITABLE_KINDS.has(kind)) {
        const err = new Error('Unsupported customization kind.');
        err.code = 'CUSTOMIZATION_KIND_INVALID';
        throw err;
      }
      if (!NAME_RE.test(name)) {
        const err = new Error('Customization name must be lowercase alphanumeric with hyphens and start with a letter.');
        err.code = 'CUSTOMIZATION_NAME_INVALID';
        throw err;
      }
      const targetPath = _resolveWritePath({
        workspaceRoot,
        userConfigRoot,
        kind,
        name,
        scope,
        requestedPath: body.path,
      });
      const frontmatter = { ...(body.frontmatter || {}), name };
      const source = kind === 'hooks'
        ? _hooksSource(body.body, body.hooks)
        : _markdownSource(frontmatter, body.body || '');
      fs.mkdirSync(path.dirname(targetPath), { recursive: true });
      fs.writeFileSync(targetPath, source, 'utf8');

      const records = discoverCustomizations({ workspaceRoot, userConfigDir: userConfigRoot, userHome, includeUser: true });
      const saved = records.find(record => path.resolve(record.path) === path.resolve(targetPath))
        || records.find(record => record.kind === kind && record.name === name && record.scope === scope);
      res.json({ ok: true, record: saved ? _publicRecord(saved, { includeBody: true }) : null });
    } catch (e) {
      const status = e.code === 'CUSTOMIZATION_NAME_INVALID' || e.code === 'CUSTOMIZATION_KIND_INVALID' || e.code === 'CUSTOMIZATION_PATH_INVALID'
        ? 422
        : e.code === 'CUSTOMIZATION_PATH_FORBIDDEN'
          ? 403
          : 500;
      res.status(status).json({ ok: false, error: e.message });
    }
  });

  app.get('/api/customizations/agent-policy/:name', (req, res) => {
    try {
      const includeUser = String(req.query?.includeUser || '1') !== '0';
      const records = discoverCustomizations({ workspaceRoot, userConfigDir, userHome, includeUser });
      const policy = buildAgentPolicy(records, { name: req.params.name });
      res.json({ ok: true, policy, toolPolicy: resolveToolPolicy({ agentTools: policy.tools }) });
    } catch (e) {
      const status = e.code === 'AGENT_NOT_FOUND' ? 404 : e.code === 'AGENT_INVALID' ? 422 : 500;
      res.status(status).json({ ok: false, error: e.message, errors: e.errors || [] });
    }
  });
}
