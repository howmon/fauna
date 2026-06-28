import path from 'node:path';
import { buildAgentPolicy, buildPromptInvocation, discoverCustomizations, groupCustomizations, resolveToolPolicy, selectRelevantInstructions } from '../../lib/customization-registry.js';

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
  if (includeBody) out.body = record.body || '';
  return out;
}

export function registerCustomizationRoutes(app, deps = {}) {
  const workspaceRoot = path.resolve(deps.workspaceRoot || process.cwd());
  const userConfigDir = deps.userConfigDir;
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
