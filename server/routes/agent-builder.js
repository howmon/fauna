// Agent builder routes: AI generation + testing + scanning + audit + decompose + save + export.
// Extracted from server.js. Stateless aside from the shared agentsDir.

import fs from 'fs';
import os from 'os';
import path from 'path';
import crypto from 'crypto';
import { execSync } from 'child_process';

import { scanAgent } from '../../agent-scanner.js';
import { getCopilotClient } from '../copilot/auth.js';

const BUILTIN_AGENT_NAMES = ['research', 'coder', 'writer', 'designer'];

// Whitelist of models callers may request. Anything outside this falls back
// to the default. Keeps a hostile or buggy client from pinning us to a model
// we don't control or charge for.
const ALLOWED_BUILDER_MODELS = new Set([
  'gpt-4.1', 'gpt-4.1-mini', 'gpt-4o', 'gpt-4o-mini',
  'claude-sonnet-4.6', 'claude-sonnet-4', 'claude-3-5-sonnet',
  'o1', 'o1-mini', 'o3-mini',
]);
function safeBuilderModel(requested, fallback = 'gpt-4.1') {
  if (typeof requested !== 'string') return fallback;
  return ALLOWED_BUILDER_MODELS.has(requested) ? requested : fallback;
}

export function registerAgentBuilderRoutes(app, { agentsDir }) {
  // AI-generate agent config from a natural language description
  app.post('/api/agent-builder/generate', async (req, res) => {
    const { description, model: reqModel } = req.body;
    if (!description || !description.trim()) return res.status(400).json({ error: 'description required' });
    // Use the model the client is currently using, fall back to gpt-4.1 which is reliably available
    const model = safeBuilderModel(reqModel, 'gpt-4.1');
    try {
      const client = getCopilotClient();
      const response = await client.chat.completions.create({
        model: model,
        max_tokens: 4000,
        messages: [
          { role: 'system', content: `You are an AI agent builder assistant. Given a user's description of what kind of agent they want, generate a complete agent configuration as a JSON object. Return ONLY valid JSON with no markdown fencing or extra text.

The JSON must have these fields:
- "displayName": string (human-friendly name, 2-4 words)
- "name": string (lowercase slug with hyphens, e.g. "code-reviewer")
- "description": string (1-2 sentence description)
- "category": one of "productivity","development","design","research","writing","data","other"
- "icon": one of "ti-robot","ti-code","ti-search","ti-pencil","ti-vector-triangle","ti-database","ti-chart-bar","ti-terminal-2","ti-world-www","ti-shield-check","ti-brain","ti-bolt","ti-bug","ti-git-merge","ti-palette","ti-mail","ti-file-analytics","ti-api","ti-cpu","ti-cloud","ti-package","ti-wand"
- "orchestrator": boolean — set true if the agent's purpose involves coordinating multiple specialized sub-agents (e.g. "generate a report using 3 agents", "multi-step pipeline", "spec writer with sections"). Set false for single-purpose agents.
- "systemPrompt": string (detailed system prompt). For orchestrators: 100-200 words, dispatch-only — must output ONLY [DELEGATE:agents/sub-agent-name]task[/DELEGATE] blocks, describe inputs to resolve, and list the sub-agents in a dispatch table. For pipelines where step N depends on step N-1, emit ONE block at a time — the system loops automatically, returning results before the next delegation. For parallel work, emit all blocks at once. For regular agents: 200-800 words defining role, capabilities, workflow, output format.
- "shared": string — only for orchestrators (empty string otherwise). Shared infrastructure prompt appended to every sub-agent automatically. Put common facts, APIs, component keys, helpers, or conventions here so sub-agents don't repeat them.
- "subAgents": array — only for orchestrators (empty array otherwise). Each sub-agent has:
  - "name": string (lowercase slug, e.g. "section-overview")
  - "displayName": string (human-friendly, e.g. "Overview Section")
  - "description": string (one sentence)
  - "icon": string (ti-* icon from the list above)
  - "systemPrompt": string (focused prompt for this sub-agent's specific responsibility, 100-300 words. It receives shared context automatically — don't repeat shared infrastructure here. In sequential mode, sub-agents automatically receive prior agents' results as context.)
- "permissions": object with:
  - "shell": boolean
  - "browser": boolean
  - "figma": boolean
  - "fileRead": array of FOLDER paths the agent may read from (e.g. ["~/Documents"]). All files inside the folder are accessible. Use [] for no read access.
  - "fileWrite": array of FOLDER paths the agent may write to (e.g. ["~/Output"]). All files inside the folder can be created or overwritten. Use [] for no write access.
  - "network": { "allowedDomains": string[], "blockAll": boolean }
- "tools": array of custom tool objects (0-3 relevant tools; omit for orchestrators). Each tool has:
  - "name": string (snake_case)
  - "description": string
  - "parameters": JSON Schema object ({ "type": "object", "properties": { ... } })
  - "code": string (JavaScript module.exports async function. Receives (args, context). context has: context.fetch(url), context.readFile(path), context.writeFile(path, content), context.store)
- "testCases": array of 2-4 test cases. Each has:
  - "input": string (a user message to test)
  - "expectedOutput": string (a substring that should appear in the response)

ORCHESTRATOR EXAMPLE — if the user asks for a "report writer with a research agent and a writing agent":
{
  "orchestrator": true,
  "systemPrompt": "You coordinate report generation. Resolve the topic, then output ONLY [DELEGATE:] blocks.\\n\\n## Dispatch\\n[DELEGATE:agents/researcher]Research the topic and return key facts, sources, and a summary[/DELEGATE]\\n[DELEGATE:agents/writer]Write a polished report from the research findings[/DELEGATE]",
  "shared": "Output reports in Markdown. Use headers ##, bullet points, and concise language.",
  "subAgents": [
    { "name": "researcher", "displayName": "Researcher", "icon": "ti-search", "description": "Finds and summarizes facts on a topic.", "systemPrompt": "You research a given topic and return structured findings: key facts, sources, and a short summary." },
    { "name": "writer", "displayName": "Writer", "icon": "ti-pencil", "description": "Writes the final report from research.", "systemPrompt": "You receive research findings and write a polished report. Prior agent results are in your context." }
  ],
  "tools": []
}

Set permissions conservatively — only enable what the agent truly needs.` },
          { role: 'user', content: description.trim() }
        ]
      });
      const text = response.choices?.[0]?.message?.content || '';
      // Extract JSON from response (strip markdown fences if present)
      const jsonMatch = text.match(/\{[\s\S]*\}/);
      if (!jsonMatch) return res.status(500).json({ error: 'Failed to generate valid agent config' });
      const config = JSON.parse(jsonMatch[0]);
      res.json(config);
    } catch (e) {
      res.status(500).json({ error: 'Generation failed: ' + e.message });
    }
  });

  // Test a system prompt by sending a test message through the model
  app.post('/api/agent-builder/test-prompt', async (req, res) => {
    const { systemPrompt, testMessage } = req.body;
    if (!systemPrompt || !testMessage) return res.status(400).json({ error: 'systemPrompt and testMessage required' });
    try {
      const client = getCopilotClient();
      const response = await client.chat.completions.create({
        model: 'claude-sonnet-4.6',
        max_tokens: 500,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: testMessage }
        ]
      });
      const text = response.choices?.[0]?.message?.content || '';
      res.json({ response: text });
    } catch (e) {
      res.status(500).json({ error: 'Test failed: ' + e.message });
    }
  });

  // Test a custom tool in sandbox
  app.post('/api/agent-builder/test-tool', async (req, res) => {
    const { tool, args } = req.body;
    if (!tool || !tool.code) return res.status(400).json({ error: 'tool with code required' });
    try {
      const vm = await import('vm');
      const sandbox = {
        module: { exports: null },
        exports: {},
        console: { log: () => {}, error: () => {}, warn: () => {} },
        setTimeout: () => {},
        clearTimeout: () => {},
      };
      const ctx = vm.default ? vm.default.createContext(sandbox) : vm.createContext(sandbox);
      const script = new (vm.default ? vm.default.Script : vm.Script)(tool.code, { timeout: 5000 });
      script.runInContext(ctx);
      const fn = sandbox.module.exports || sandbox.exports.default;
      if (typeof fn !== 'function') return res.status(400).json({ error: 'Tool code must export a function via module.exports' });

      // Create a minimal tool context
      const toolContext = {
        fetch: () => Promise.resolve({ ok: true, json: () => ({ mock: true }), text: () => 'mock response' }),
        readFile: () => Promise.resolve('(sandbox: file read disabled in test mode)'),
        writeFile: () => Promise.resolve(),
        store: {}
      };
      const result = await Promise.resolve(fn(args || {}, toolContext));
      res.json({ result });
    } catch (e) {
      res.status(500).json({ error: 'Tool test failed: ' + e.message });
    }
  });

  // Scan agent data from builder (not yet saved to disk)
  app.post('/api/agent-builder/scan', (req, res) => {
    const data = req.body;
    if (!data || !data.name) return res.status(400).json({ error: 'Agent data required' });

    // Write to a temp directory, scan, then clean up
    const tmp = path.join(os.tmpdir(), 'agent-builder-scan-' + Date.now());
    try {
      fs.mkdirSync(tmp, { recursive: true });

      // Write agent.json
      const manifest = {
        name: data.name,
        displayName: data.displayName || data.name,
        description: data.description || '',
        version: '1.0',
        category: data.category || 'other',
        icon: data.icon || 'ti-robot',
        permissions: data.permissions || {}
      };
      fs.writeFileSync(path.join(tmp, 'agent.json'), JSON.stringify(manifest, null, 2));

      // Write system prompt
      if (data.systemPrompt) {
        fs.writeFileSync(path.join(tmp, 'system-prompt.md'), data.systemPrompt);
      }

      // Write tools
      if (data.tools && data.tools.length) {
        const toolsDir = path.join(tmp, 'tools');
        fs.mkdirSync(toolsDir, { recursive: true });
        for (const tool of data.tools) {
          const toolFile = path.join(toolsDir, (tool.name || 'tool') + '.js');
          fs.writeFileSync(toolFile, tool.code || '');
        }
      }

      // Write test cases for scan
      if (data.testCases && data.testCases.length) {
        const testsDir = path.join(tmp, 'tests');
        fs.mkdirSync(testsDir, { recursive: true });
        fs.writeFileSync(path.join(testsDir, 'test-cases.json'), JSON.stringify(data.testCases, null, 2));
      }

      // Write auto-generated README
      const readmeContent = '# ' + (data.displayName || data.name) + '\n\n' +
        (data.description || '') + '\n\n' +
        '## Permissions\n\n' +
        (data.permissions ? Object.entries(data.permissions).filter(([k,v]) => v && k !== 'network' && k !== 'fileRead' && k !== 'fileWrite').map(([k]) => '- ' + k).join('\n') : 'None') + '\n';
      fs.writeFileSync(path.join(tmp, 'README.md'), readmeContent);

      const report = scanAgent(tmp);
      res.json(report);
    } catch (e) {
      res.status(500).json({ error: 'Scan failed: ' + e.message });
    } finally {
      try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (_) {}
    }
  });

  // Audit a system prompt against a quality rubric and suggest improvements
  app.post('/api/agent-builder/rubric-audit', async (req, res) => {
    const { systemPrompt, displayName, description, model: reqModel } = req.body;
    if (!systemPrompt || !systemPrompt.trim()) return res.status(400).json({ error: 'systemPrompt required' });

    const auditSystemMsg = `You are an expert AI prompt quality auditor. Evaluate the given agent system prompt against these quality criteria and return ONLY valid JSON with no markdown fencing.

Return a JSON object with:
- "summary": string — one or two sentence overall assessment. Include approximate token savings if the improved prompt is shorter (e.g. "~320 tokens saved").
- "findings": array of issues found (empty array if the prompt passes all checks). Each finding has:
  - "id": short snake_case identifier (e.g. "missing_role", "vague_output_format", "verbose_phrasing")
  - "label": short human-readable label (5-8 words)
  - "detail": one or two sentences explaining the issue and how to fix it
  - "severity": "high" | "medium" | "low"
- "tokenEstimate": { "original": number, "improved": number } — rough token counts (chars/4) for original vs improved prompt
- "improvedPrompt": string — a COMPLETE rewritten version of the system prompt that addresses all findings. You MUST include the ENTIRE prompt text — never truncate, abbreviate, or use placeholders like "[...rest of prompt...]". Actively compress verbose phrasing: use imperative voice, terse bullets, remove filler words, collapse redundant sentences — while keeping every behavioral instruction intact. Omit this field (or set to null) only if there are no findings.

Quality criteria to check:
1. Role clarity (high) — Is the agent's role and purpose clearly defined up front?
2. Instruction specificity (high) — Are instructions specific enough to guide behavior, or are they vague?
3. Output format (medium) — Does the prompt specify expected output format when relevant?
4. Safety & scope limits (medium) — Does the prompt define what the agent should NOT do?
5. Edge case handling (low) — Are common edge cases or failure modes addressed?
6. Conciseness (low) — Is the prompt free of repetitive or contradictory content?
7. Tone & persona consistency (low) — Is the agent persona consistent throughout?
8. Token efficiency (medium) — Is the prompt unnecessarily verbose? Flag wordy phrasing, redundant restatements, over-explained obvious points, or filler sentences that inflate token count without adding behavioral clarity. The improved prompt should preserve 100% of the original intent while using significantly fewer tokens. Prefer terse bullet points, imperative voice, and compressed phrasing over full prose paragraphs.`;

    const userMsg = `Agent name: ${displayName || 'Unnamed'}\nDescription: ${description || 'N/A'}\nOriginal token estimate: ~${Math.ceil(systemPrompt.trim().length / 4)}\n\nSystem prompt:\n${systemPrompt.trim()}`;
    const messages = [{ role: 'system', content: auditSystemMsg }, { role: 'user', content: userMsg }];

    // Try with user's current model first, then fallback models
    const modelsToTry = [safeBuilderModel(reqModel, 'gpt-4.1'), 'gpt-4.1', 'gpt-4.1-mini', 'gpt-4o'].filter(Boolean);
    const client = getCopilotClient();
    let lastError = null;

    for (const model of modelsToTry) {
      try {
        console.log('[rubric-audit] trying model:', model);
        const response = await client.chat.completions.create({
          model,
          max_tokens: 16384,
          stream: false,
          messages
        });
        const text = response.choices?.[0]?.message?.content || '';
        const jsonMatch = text.match(/\{[\s\S]*\}/);
        if (!jsonMatch) {
          lastError = new Error('Failed to parse audit response from ' + model);
          continue;
        }
        const audit = JSON.parse(jsonMatch[0]);
        return res.json(audit);
      } catch (e) {
        console.warn('[rubric-audit] model', model, 'failed:', e.message);
        lastError = e;
      }
    }
    res.status(500).json({ error: 'Rubric audit failed: ' + (lastError?.message || 'all models failed') });
  });

  // Suggest decomposing a large agent into orchestrator + sub-agents
  app.post('/api/agent-builder/decompose', async (req, res) => {
    const { systemPrompt, displayName, description, name: agentName, permissions, icon, category, model: reqModel } = req.body;
    if (!systemPrompt || !systemPrompt.trim()) return res.status(400).json({ error: 'systemPrompt required' });

    const tokenEst = Math.ceil(systemPrompt.trim().length / 4);
    if (tokenEst < 4000) return res.json({ recommend: false, reason: 'Prompt is under 4000 tokens — no split needed.' });

    const decomposeMsg = `You are an expert agent architect. The user has a single agent with a very large system prompt (~${tokenEst} tokens). Your job is to decompose it into an orchestrator agent with specialized sub-agents.

Return ONLY valid JSON with no markdown fencing. The JSON object must have:
- "recommend": true
- "reason": string — 1-2 sentences explaining why splitting helps (faster responses, lower per-call token cost, better separation of concerns)
- "orchestrator": object with:
  - "displayName": string
  - "name": string (slug)
  - "description": string
  - "systemPrompt": string — short dispatch-only prompt (100-200 words). Must use [DELEGATE:agents/NAME]task description[/DELEGATE] syntax for each sub-agent. For parallel work, emit all blocks at once. For pipelines where step N needs step N-1 output, emit ONE block at a time — the system loops automatically, returning results before requesting the next delegation.
- "shared": string — common context/facts/conventions shared across all sub-agents (extract anything repeated or universally needed). This is automatically appended to every sub-agent's prompt.
- "subAgents": array of 2-5 sub-agents, each with:
  - "name": string (slug)
  - "displayName": string (2-4 words)
  - "description": string (1 sentence)
  - "icon": one of "ti-robot","ti-code","ti-search","ti-pencil","ti-vector-triangle","ti-database","ti-chart-bar","ti-terminal-2","ti-world-www","ti-shield-check","ti-brain","ti-bolt","ti-bug","ti-palette","ti-wand"
  - "systemPrompt": string (focused, 100-400 words — the sub-agent's specific responsibility only, no shared context)
- "tokenEstimate": { "original": number, "perCallMax": number } — original = total tokens of the monolithic prompt, perCallMax = max tokens any single sub-agent + shared + orchestrator would consume in one call

Rules:
- Split along natural responsibility boundaries (e.g. research vs writing, planning vs execution, different domains)
- The shared section should contain facts/context that 2+ sub-agents need — don't duplicate across sub-agents
- Each sub-agent prompt should be self-contained for its responsibility (it gets shared context automatically)
- Preserve 100% of the original prompt's behavioral intent — nothing should be lost in the split
- The orchestrator prompt should be a pure dispatcher — it decides which sub-agent(s) to invoke based on the user's request
- In sequential mode each sub-agent automatically receives prior agents' results as context — sub-agent prompts can reference "prior agent results" without you wiring it manually
- The orchestrator systemPrompt MUST include a dispatch table showing which sub-agent handles which responsibility, using the format: [DELEGATE:agents/name]task[/DELEGATE]`;

    const userMsg = `Agent: ${displayName || agentName || 'Unnamed'}\nDescription: ${description || 'N/A'}\n\nFull system prompt (${tokenEst} tokens):\n${systemPrompt.trim()}`;
    const messages = [{ role: 'system', content: decomposeMsg }, { role: 'user', content: userMsg }];

    const modelsToTry = [safeBuilderModel(reqModel, 'gpt-4.1'), 'gpt-4.1', 'claude-sonnet-4.6'].filter(Boolean);
    const client = getCopilotClient();
    let lastError = null;

    for (const model of modelsToTry) {
      try {
        console.log('[decompose] trying model:', model);
        const response = await client.chat.completions.create({ model, max_tokens: 16384, stream: false, messages });
        const text = response.choices?.[0]?.message?.content || '';
        const jsonMatch = text.match(/\{[\s\S]*\}/);
        if (!jsonMatch) { lastError = new Error('Failed to parse from ' + model); continue; }
        const result = JSON.parse(jsonMatch[0]);
        // Carry forward original agent metadata
        result._originalMeta = { permissions: permissions || {}, icon: icon || 'ti-robot', category: category || 'other' };
        return res.json(result);
      } catch (e) {
        console.warn('[decompose] model', model, 'failed:', e.message);
        lastError = e;
      }
    }
    res.status(500).json({ error: 'Decomposition failed: ' + (lastError?.message || 'all models failed') });
  });

  // Save agent from builder
  app.post('/api/agent-builder/save', (req, res) => {
    const data = req.body;
    if (!data || !data.name) return res.status(400).json({ error: 'Agent name required' });
    const agentName = data.name.replace(/[^a-zA-Z0-9_-]/g, '');
    if (!agentName) return res.status(400).json({ error: 'Invalid agent name' });

    // Check uniqueness: reject built-in names, reject duplicate on new agents
    if (BUILTIN_AGENT_NAMES.includes(agentName.toLowerCase())) {
      return res.status(409).json({ error: 'Cannot use a built-in agent name: ' + agentName });
    }
    const isNew = !data._editing;
    const agentDir = path.join(agentsDir, agentName);
    if (isNew && fs.existsSync(path.join(agentDir, 'agent.json'))) {
      return res.status(409).json({ error: 'An agent named "' + agentName + '" already exists. Edit it instead or choose a different name.' });
    }
    try {
      fs.mkdirSync(agentDir, { recursive: true });

      // Auto-increment version on re-save (simple: 1.0 → 2.0 → 3.0)
      let version = '1.0';
      const existingManifestPath = path.join(agentDir, 'agent.json');
      if (!isNew && fs.existsSync(existingManifestPath)) {
        try {
          const existing = JSON.parse(fs.readFileSync(existingManifestPath, 'utf8'));
          if (existing.version) {
            const major = parseInt(existing.version) || 1;
            version = (major + 1) + '.0';
          }
        } catch (_) {}
      }

      // Write agent.json
      const manifest = {
        name: agentName,
        displayName: data.displayName || agentName,
        description: data.description || '',
        version: version,
        category: data.category || 'other',
        icon: data.icon || 'ti-robot',
        orchestrator: data.orchestrator || false,
        permissions: data.permissions || {},
        systemPrompt: data.systemPrompt || ''
      };
      // Include sub-agent references in manifest
      if (data.agents && Array.isArray(data.agents) && data.agents.length) {
        manifest.agents = data.agents; // e.g. ['agents/overview', 'agents/usage']
      }
      // Compute checksum of the manifest for version tracking
      const manifestJson = JSON.stringify(manifest, null, 2);
      const checksum = crypto.createHash('sha256').update(manifestJson).digest('hex').slice(0, 16);
      fs.writeFileSync(path.join(agentDir, 'agent.json'), manifestJson);

      // Write system prompt
      if (data.systemPrompt) {
        fs.writeFileSync(path.join(agentDir, 'system-prompt.md'), data.systemPrompt);
      }

      // Write shared sub-agent infrastructure
      if (data.shared && data.shared.trim()) {
        fs.writeFileSync(path.join(agentDir, 'shared.md'), data.shared);
      } else if (fs.existsSync(path.join(agentDir, 'shared.md')) && data.shared === '') {
        fs.unlinkSync(path.join(agentDir, 'shared.md'));
      }

      // Write sub-agents
      if (data.subAgents && Array.isArray(data.subAgents)) {
        const subAgentsDir = path.join(agentDir, 'agents');
        fs.mkdirSync(subAgentsDir, { recursive: true });
        for (const sub of data.subAgents) {
          const subName = (sub.name || '').replace(/[^a-zA-Z0-9_-]/g, '');
          if (!subName) continue;
          const subDir = path.join(subAgentsDir, subName);
          fs.mkdirSync(subDir, { recursive: true });
          const subManifest = {
            name: subName,
            displayName: sub.displayName || subName,
            description: sub.description || '',
            icon: sub.icon || 'ti-robot',
            category: sub.category || manifest.category,
            permissions: sub.permissions || {},
            systemPrompt: sub.systemPrompt || '',
            _parentAgent: agentName
          };
          fs.writeFileSync(path.join(subDir, 'agent.json'), JSON.stringify(subManifest, null, 2));
          if (sub.systemPrompt) {
            fs.writeFileSync(path.join(subDir, 'system-prompt.md'), sub.systemPrompt);
          }
          // Sub-agent tools
          if (sub.tools && sub.tools.length) {
            const subToolsDir = path.join(subDir, 'tools');
            fs.mkdirSync(subToolsDir, { recursive: true });
            for (const tool of sub.tools) {
              const safeTool = (tool.name || 'tool').replace(/[^a-zA-Z0-9_-]/g, '');
              fs.writeFileSync(path.join(subToolsDir, safeTool + '.json'), JSON.stringify({ name: tool.name, description: tool.description || '', parameters: tool.parameters || {} }, null, 2));
              fs.writeFileSync(path.join(subToolsDir, safeTool + '.js'), tool.code || '');
            }
          }
        }
      }

      // Write tools
      if (data.tools && data.tools.length) {
        const toolsDir = path.join(agentDir, 'tools');
        fs.mkdirSync(toolsDir, { recursive: true });
        for (const tool of data.tools) {
          const safeName = (tool.name || 'tool').replace(/[^a-zA-Z0-9_-]/g, '');
          const toolManifest = {
            name: tool.name,
            description: tool.description || '',
            parameters: tool.parameters || { type: 'object', properties: {} }
          };
          fs.writeFileSync(path.join(toolsDir, safeName + '.json'), JSON.stringify(toolManifest, null, 2));
          fs.writeFileSync(path.join(toolsDir, safeName + '.js'), tool.code || '');
        }
      }

      // Write test cases
      if (data.testCases && data.testCases.length) {
        const testsDir = path.join(agentDir, 'tests');
        fs.mkdirSync(testsDir, { recursive: true });
        fs.writeFileSync(path.join(testsDir, 'test-cases.json'), JSON.stringify(data.testCases, null, 2));
      }

      // Write auto-generated README
      const readmeLines = ['# ' + (manifest.displayName || agentName), '', manifest.description || '', ''];
      if (data.systemPrompt) readmeLines.push('## System Prompt', '', 'This agent has a custom system prompt defining its behavior.', '');
      if (data.tools && data.tools.length) readmeLines.push('## Tools', '', ...data.tools.map(t => '- **' + t.name + '**: ' + (t.description || 'No description')), '');
      fs.writeFileSync(path.join(agentDir, 'README.md'), readmeLines.join('\n'));

      res.json({ ok: true, name: agentName, displayName: manifest.displayName, version: version, checksum: checksum });
    } catch (e) {
      res.status(500).json({ error: 'Failed to save agent: ' + e.message });
    }
  });

  // Export agent as .zip
  app.post('/api/agent-builder/export', async (req, res) => {
    const data = req.body;
    if (!data || !data.name) return res.status(400).json({ error: 'Agent name required' });
    const agentName = data.name.replace(/[^a-zA-Z0-9_-]/g, '');
    if (!agentName) return res.status(400).json({ error: 'Invalid agent name' });

    const tmp = path.join(os.tmpdir(), 'agent-export-' + Date.now());
    const agentTmp = path.join(tmp, agentName);
    try {
      fs.mkdirSync(agentTmp, { recursive: true });

      // Write manifest
      const manifest = {
        name: agentName,
        displayName: data.displayName || agentName,
        description: data.description || '',
        version: '1.0',
        category: data.category || 'other',
        icon: data.icon || 'ti-robot',
        orchestrator: data.orchestrator || false,
        permissions: data.permissions || {},
        systemPrompt: data.systemPrompt || ''
      };
      if (data.agents && Array.isArray(data.agents) && data.agents.length) {
        manifest.agents = data.agents;
      }
      fs.writeFileSync(path.join(agentTmp, 'agent.json'), JSON.stringify(manifest, null, 2));

      if (data.systemPrompt) {
        fs.writeFileSync(path.join(agentTmp, 'system-prompt.md'), data.systemPrompt);
      }

      // Bundle sub-agents from disk if they exist
      const subAgentsSrc = path.join(agentsDir, agentName, 'agents');
      if (fs.existsSync(subAgentsSrc) && fs.statSync(subAgentsSrc).isDirectory()) {
        const subAgentsTmp = path.join(agentTmp, 'agents');
        fs.mkdirSync(subAgentsTmp, { recursive: true });
        const copyRecursiveExport = (src, dst) => {
          for (const item of fs.readdirSync(src)) {
            const s = path.join(src, item);
            const d = path.join(dst, item);
            if (fs.statSync(s).isDirectory()) { fs.mkdirSync(d, { recursive: true }); copyRecursiveExport(s, d); }
            else fs.copyFileSync(s, d);
          }
        };
        copyRecursiveExport(subAgentsSrc, subAgentsTmp);
      }

      if (data.tools && data.tools.length) {
        const toolsDir = path.join(agentTmp, 'tools');
        fs.mkdirSync(toolsDir, { recursive: true });
        for (const tool of data.tools) {
          const safeName = (tool.name || 'tool').replace(/[^a-zA-Z0-9_-]/g, '');
          fs.writeFileSync(path.join(toolsDir, safeName + '.json'), JSON.stringify({ name: tool.name, description: tool.description || '', parameters: tool.parameters || {} }, null, 2));
          fs.writeFileSync(path.join(toolsDir, safeName + '.js'), tool.code || '');
        }
      }

      if (data.testCases && data.testCases.length) {
        const testsDir = path.join(agentTmp, 'tests');
        fs.mkdirSync(testsDir, { recursive: true });
        fs.writeFileSync(path.join(testsDir, 'test-cases.json'), JSON.stringify(data.testCases, null, 2));
      }

      // Create zip
      const zipPath = path.join(tmp, agentName + '.zip');
      execSync(`cd "${tmp}" && zip -r "${zipPath}" "${agentName}"`, { timeout: 30000 });

      const zipData = fs.readFileSync(zipPath);
      res.set({
        'Content-Type': 'application/zip',
        'Content-Disposition': `attachment; filename="${agentName}.zip"`
      });
      res.send(zipData);
    } catch (e) {
      res.status(500).json({ error: 'Export failed: ' + e.message });
    } finally {
      try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (_) {}
    }
  });
}
