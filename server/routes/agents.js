// Agent management routes: list/get/update/import/delete/icon/meta/tests/tools/MCP/scan.
// Extracted from server.js. Accepts deps via factory.

import fs from 'fs';
import os from 'os';
import path from 'path';
import { execSync } from 'child_process';

import { getAgentTools, startAgentMCPServers, stopAgentMCPServers } from '../../agent-tools.js';
import { scanAgent, formatScanReport } from '../../agent-scanner.js';

export function registerAgentRoutes(app, {
  express,
  agentsDir,
  iterAgentDirs,
  builtinAgentNames = [],
}) {
  // List all installed agents
  app.get('/api/agents', (req, res) => {
    try {
      const agents = [];
      const seen = new Set();
      for (const { name, agentDir, source } of iterAgentDirs()) {
        if (seen.has(name)) continue; // user dir takes precedence over local
        const manifestPath = path.join(agentDir, 'agent.json');
        if (!fs.statSync(agentDir).isDirectory()) continue;
        if (!fs.existsSync(manifestPath)) continue;
        try {
          const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
          // Skip sub-agents (they live inside a parent's agents/ folder)
          if (manifest._parentAgent) continue;
          seen.add(name);
          manifest._dir = agentDir;
          manifest._source = source;
          // Load system prompt if referenced
          if (manifest.systemPromptFile) {
            const promptPath = path.join(agentDir, manifest.systemPromptFile);
            if (fs.existsSync(promptPath)) {
              manifest.systemPrompt = fs.readFileSync(promptPath, 'utf8');
            }
          }
          // Load meta
          const metaPath = path.join(agentDir, '.meta.json');
          if (fs.existsSync(metaPath)) {
            try { manifest._meta = JSON.parse(fs.readFileSync(metaPath, 'utf8')); } catch (_) {}
          }
          // Load learnings journal (consolidated patterns only — not full log)
          const learningsPath = path.join(agentDir, 'learnings.md');
          if (fs.existsSync(learningsPath)) {
            const raw = fs.readFileSync(learningsPath, 'utf8');
            const pEnd = raw.indexOf('\n---\n');
            manifest._learnings = pEnd !== -1 ? raw.slice(0, pEnd).trim() : '';
          }
          // Load sub-agents — from manifest.agents array or auto-discover agents/ subdirectory
          let subRefs = manifest.agents && Array.isArray(manifest.agents) ? manifest.agents : null;
          if (!subRefs) {
            const agentsSubDir = path.join(agentDir, 'agents');
            if (fs.existsSync(agentsSubDir) && fs.statSync(agentsSubDir).isDirectory()) {
              subRefs = fs.readdirSync(agentsSubDir).filter(d => fs.existsSync(path.join(agentsSubDir, d, 'agent.json'))).map(d => 'agents/' + d);
            }
          }
          if (subRefs && subRefs.length) {
            manifest._subAgents = [];
            // Load optional shared.md to append to every sub-agent prompt
            const sharedPromptPath = path.join(agentDir, 'shared.md');
            const sharedPrompt = fs.existsSync(sharedPromptPath)
              ? '\n\n---\n## Shared Infrastructure\n\n' + fs.readFileSync(sharedPromptPath, 'utf8')
              : '';
            for (const subRef of subRefs) {
              const subDir = path.join(agentDir, subRef);
              const subManifestPath = path.join(subDir, 'agent.json');
              if (fs.existsSync(subManifestPath)) {
                try {
                  const sub = JSON.parse(fs.readFileSync(subManifestPath, 'utf8'));
                  sub._dir = subDir;
                  // Load sub-agent system prompt and append shared infrastructure
                  const subPromptPath = path.join(subDir, 'system-prompt.md');
                  if (fs.existsSync(subPromptPath)) {
                    sub.systemPrompt = fs.readFileSync(subPromptPath, 'utf8') + sharedPrompt;
                  }
                  manifest._subAgents.push(sub);
                } catch (_) {}
              }
            }
          }
          agents.push(manifest);
        } catch (_) { /* skip invalid manifests */ }
      }
      res.json({ agents });
    } catch (e) {
      res.status(500).json({ error: 'Failed to list agents' });
    }
  });

  // Get a single agent's manifest
  app.get('/api/agents/:name', (req, res) => {
    const name = req.params.name.replace(/[^a-zA-Z0-9_-]/g, '');
    const agentDir = path.join(agentsDir, name);
    const manifestPath = path.join(agentDir, 'agent.json');
    if (!fs.existsSync(manifestPath)) return res.status(404).json({ error: 'Agent not found' });
    try {
      const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
      if (manifest.systemPromptFile) {
        const promptPath = path.join(agentDir, manifest.systemPromptFile);
        if (fs.existsSync(promptPath)) {
          manifest.systemPrompt = fs.readFileSync(promptPath, 'utf8');
        }
      }
      // Load learnings journal (consolidated patterns only)
      const learningsPath = path.join(agentDir, 'learnings.md');
      if (fs.existsSync(learningsPath)) {
        const raw = fs.readFileSync(learningsPath, 'utf8');
        const pEnd = raw.indexOf('\n---\n');
        manifest._learnings = pEnd !== -1 ? raw.slice(0, pEnd).trim() : '';
      }
      // Load sub-agents — from manifest.agents array or auto-discover agents/ subdirectory
      let subRefs = manifest.agents && Array.isArray(manifest.agents) ? manifest.agents : null;
      if (!subRefs) {
        const agentsSubDir = path.join(agentDir, 'agents');
        if (fs.existsSync(agentsSubDir) && fs.statSync(agentsSubDir).isDirectory()) {
          subRefs = fs.readdirSync(agentsSubDir).filter(d => fs.existsSync(path.join(agentsSubDir, d, 'agent.json'))).map(d => 'agents/' + d);
        }
      }
      if (subRefs && subRefs.length) {
        manifest._subAgents = [];
        // Expose shared.md content for the builder editor
        const sharedPath = path.join(agentDir, 'shared.md');
        if (fs.existsSync(sharedPath)) manifest._shared = fs.readFileSync(sharedPath, 'utf8');
        for (const subRef of subRefs) {
          const subDir = path.join(agentDir, subRef);
          const subManifestPath = path.join(subDir, 'agent.json');
          if (fs.existsSync(subManifestPath)) {
            try {
              const sub = JSON.parse(fs.readFileSync(subManifestPath, 'utf8'));
              const subPromptPath = path.join(subDir, 'system-prompt.md');
              if (fs.existsSync(subPromptPath)) {
                sub.systemPrompt = fs.readFileSync(subPromptPath, 'utf8');
              }
              manifest._subAgents.push(sub);
            } catch (_) {}
          }
        }
      }
      res.json(manifest);
    } catch (e) {
      res.status(500).json({ error: 'Failed to read agent' });
    }
  });

  // Update an agent's system prompt (writes both system-prompt.md and agent.json atomically)
  app.post('/api/agents/:name/update-prompt', (req, res) => {
    const name = req.params.name.replace(/[^a-zA-Z0-9_-]/g, '');
    const agentDir = path.join(agentsDir, name);
    const manifestPath = path.join(agentDir, 'agent.json');
    if (!fs.existsSync(manifestPath)) return res.status(404).json({ error: 'Agent not found' });
    const { systemPrompt } = req.body || {};
    if (!systemPrompt || typeof systemPrompt !== 'string') {
      return res.status(400).json({ error: 'systemPrompt string required' });
    }
    try {
      const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
      manifest.systemPrompt = systemPrompt;
      fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
      fs.writeFileSync(path.join(agentDir, 'system-prompt.md'), systemPrompt);
      res.json({ ok: true, name, bytes: systemPrompt.length });
    } catch (e) {
      res.status(500).json({ error: 'Failed to update prompt: ' + e.message });
    }
  });

  // Agent learnings journal — append or read learnings.md
  app.get('/api/agents/:name/learnings', (req, res) => {
    const name = req.params.name.replace(/[^a-zA-Z0-9_-]/g, '');
    const agentDir = path.join(agentsDir, name);
    if (!fs.existsSync(agentDir)) return res.status(404).json({ error: 'Agent not found' });
    const lPath = path.join(agentDir, 'learnings.md');
    const content = fs.existsSync(lPath) ? fs.readFileSync(lPath, 'utf8') : '';
    res.json({ name, learnings: content });
  });

  app.post('/api/agents/:name/learnings', (req, res) => {
    const name = req.params.name.replace(/[^a-zA-Z0-9_-]/g, '');
    const agentDir = path.join(agentsDir, name);
    if (!fs.existsSync(agentDir)) return res.status(404).json({ error: 'Agent not found' });
    const { entry, consolidatedPatterns } = req.body || {};
    if (!entry && !consolidatedPatterns) {
      return res.status(400).json({ error: 'Provide "entry" (append) and/or "consolidatedPatterns" (replace top section)' });
    }
    try {
      const lPath = path.join(agentDir, 'learnings.md');
      let content = fs.existsSync(lPath) ? fs.readFileSync(lPath, 'utf8') : '';

      // If consolidatedPatterns provided, replace/create the top patterns section
      if (consolidatedPatterns) {
        const patternsBlock = '## Consolidated Patterns\n\n' + consolidatedPatterns.trim() + '\n\n---\n\n';
        const marker = '## Consolidated Patterns';
        const divider = '---\n\n';
        const idx = content.indexOf(marker);
        if (idx !== -1) {
          // Replace existing patterns section (up to the first ---)
          const endIdx = content.indexOf(divider, idx);
          const cutEnd = endIdx !== -1 ? endIdx + divider.length : content.indexOf('\n## Session Log', idx);
          content = patternsBlock + (cutEnd !== -1 ? content.slice(cutEnd) : '');
        } else {
          content = patternsBlock + content;
        }
      }

      // Append new entry to the session log
      if (entry) {
        const timestamp = new Date().toISOString().slice(0, 16).replace('T', ' ');
        const logEntry = '\n### ' + timestamp + '\n' + entry.trim() + '\n';
        if (!content.includes('## Session Log')) {
          content += '## Session Log\n';
        }
        content += logEntry;
      }

      fs.writeFileSync(lPath, content);
      res.json({ ok: true, name, bytes: content.length });
    } catch (e) {
      res.status(500).json({ error: 'Failed to update learnings: ' + e.message });
    }
  });

  // Import agent from uploaded zip
  app.post('/api/agents/import', express.raw({ type: 'application/zip', limit: '10mb' }), async (req, res) => {
    const tmp = path.join(os.tmpdir(), 'agent-import-' + Date.now());
    try {
      fs.mkdirSync(tmp, { recursive: true });
      const zipPath = path.join(tmp, 'agent.zip');
      fs.writeFileSync(zipPath, req.body);
      // Extract using unzip (available on macOS and most Linux)
      execSync(`unzip -o -q "${zipPath}" -d "${tmp}/extracted"`, { timeout: 30000 });
      const extracted = path.join(tmp, 'extracted');
      // Find agent.json (may be in root or one level deep)
      let agentRoot = extracted;
      if (!fs.existsSync(path.join(extracted, 'agent.json'))) {
        const dirs = fs.readdirSync(extracted).filter(d => fs.statSync(path.join(extracted, d)).isDirectory());
        for (const d of dirs) {
          if (fs.existsSync(path.join(extracted, d, 'agent.json'))) { agentRoot = path.join(extracted, d); break; }
        }
      }
      if (!fs.existsSync(path.join(agentRoot, 'agent.json'))) {
        return res.status(400).json({ error: 'No agent.json found in archive' });
      }
      const manifest = JSON.parse(fs.readFileSync(path.join(agentRoot, 'agent.json'), 'utf8'));
      const agentName = (manifest.name || '').replace(/[^a-zA-Z0-9_-]/g, '');
      if (!agentName) return res.status(400).json({ error: 'Agent name is required in agent.json' });

      // Check uniqueness
      if (builtinAgentNames.includes(agentName.toLowerCase())) {
        return res.status(409).json({ error: 'Cannot import an agent with a built-in name: ' + agentName });
      }
      const destDir = path.join(agentsDir, agentName);
      const force = req.query.force === '1';
      if (fs.existsSync(path.join(destDir, 'agent.json')) && !force) {
        return res.status(409).json({ error: 'An agent named "' + agentName + '" already exists. Delete it first or rename the import.' });
      }
      // Preserve .meta.json across forced re-imports
      let savedMeta = null;
      if (force && fs.existsSync(path.join(destDir, '.meta.json'))) {
        try { savedMeta = fs.readFileSync(path.join(destDir, '.meta.json')); } catch (_) {}
      }
      if (force && fs.existsSync(destDir)) {
        fs.rmSync(destDir, { recursive: true, force: true });
      }
      fs.mkdirSync(destDir, { recursive: true });
      const copyRecursive = (src, dst) => {
        for (const item of fs.readdirSync(src)) {
          const s = path.join(src, item);
          const d = path.join(dst, item);
          if (fs.statSync(s).isDirectory()) { fs.mkdirSync(d, { recursive: true }); copyRecursive(s, d); }
          else fs.copyFileSync(s, d);
        }
      };
      copyRecursive(agentRoot, destDir);
      // Restore preserved .meta.json
      if (savedMeta) {
        try { fs.writeFileSync(path.join(destDir, '.meta.json'), savedMeta); } catch (_) {}
      }
      res.json({ ok: true, name: agentName, displayName: manifest.displayName || agentName });
    } catch (e) {
      res.status(500).json({ error: 'Failed to import agent' });
    } finally {
      try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (_) {}
    }
  });

  // Delete an installed agent
  app.delete('/api/agents/:name', (req, res) => {
    const name = req.params.name.replace(/[^a-zA-Z0-9_-]/g, '');
    const agentDir = path.join(agentsDir, name);
    if (!fs.existsSync(agentDir)) return res.status(404).json({ error: 'Agent not found' });
    try {
      fs.rmSync(agentDir, { recursive: true, force: true });
      res.json({ ok: true });
    } catch (e) {
      res.status(500).json({ error: 'Failed to delete agent' });
    }
  });

  // ── Agent Custom Icon ───────────────────────────────────────────────────

  app.post('/api/agents/:name/icon', express.raw({ type: ['image/png', 'image/jpeg', 'image/gif', 'image/webp'], limit: '2mb' }), (req, res) => {
    const name = req.params.name.replace(/[^a-zA-Z0-9_-]/g, '');
    const agentDir = path.join(agentsDir, name);
    if (!fs.existsSync(agentDir)) return res.status(404).json({ error: 'Agent not found' });
    try {
      fs.writeFileSync(path.join(agentDir, 'icon.png'), req.body);
      res.json({ ok: true });
    } catch (e) {
      res.status(500).json({ error: 'Failed to save icon' });
    }
  });

  app.get('/api/agents/:name/icon', (req, res) => {
    const name = req.params.name.replace(/[^a-zA-Z0-9_-]/g, '');
    const iconPath = path.join(agentsDir, name, 'icon.png');
    if (!fs.existsSync(iconPath)) return res.status(404).send('No custom icon');
    res.set('Content-Type', 'image/png');
    res.set('Cache-Control', 'public, max-age=3600');
    res.send(fs.readFileSync(iconPath));
  });

  app.get('/api/agents/:name/meta', (req, res) => {
    const name = req.params.name.replace(/[^a-zA-Z0-9_-]/g, '');
    const metaPath = path.join(agentsDir, name, '.meta.json');
    if (!fs.existsSync(metaPath)) return res.json({});
    try {
      res.json(JSON.parse(fs.readFileSync(metaPath, 'utf8')));
    } catch (_) { res.json({}); }
  });

  app.post('/api/agents/:name/meta', (req, res) => {
    const name = req.params.name.replace(/[^a-zA-Z0-9_-]/g, '');
    const agentDir = path.join(agentsDir, name);
    if (!fs.existsSync(agentDir)) return res.status(404).json({ error: 'Agent not found' });
    const metaPath = path.join(agentDir, '.meta.json');
    try {
      let existing = {};
      if (fs.existsSync(metaPath)) {
        existing = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
      }
      const updated = Object.assign(existing, req.body);
      fs.writeFileSync(metaPath, JSON.stringify(updated, null, 2));
      res.json(updated);
    } catch (e) {
      res.status(500).json({ error: 'Failed to save meta' });
    }
  });

  // ── Agent Test Cases ────────────────────────────────────────────────────

  app.get('/api/agents/:name/tests', (req, res) => {
    const name = req.params.name.replace(/[^a-zA-Z0-9_-]/g, '');
    const testsPath = path.join(agentsDir, name, 'tests', 'test-cases.json');
    if (!fs.existsSync(testsPath)) return res.json({ testCases: [] });
    try {
      const cases = JSON.parse(fs.readFileSync(testsPath, 'utf8'));
      res.json({ testCases: Array.isArray(cases) ? cases : [] });
    } catch (_) { res.json({ testCases: [] }); }
  });

  // Execute a single agent tool (for testing / manual invocation)
  app.post('/api/agents/:name/tool/:tool', async (req, res) => {
    const agentName = req.params.name.replace(/[^a-zA-Z0-9_-]/g, '');
    const toolName = req.params.tool;
    const args = req.body.args || {};

    const agentDir = path.join(agentsDir, agentName);
    const manifestPath = path.join(agentDir, 'agent.json');
    if (!fs.existsSync(manifestPath)) return res.status(404).json({ error: 'Agent not found' });

    try {
      const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
      const { handlers } = getAgentTools(agentDir, manifest, agentName);

      if (!handlers.has(toolName)) {
        return res.status(404).json({ error: 'Tool "' + toolName + '" not found for agent "' + agentName + '"' });
      }

      const result = await handlers.get(toolName)(args);
      res.json({ ok: true, result });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  // List tools available for an agent
  app.get('/api/agents/:name/tools', (req, res) => {
    const agentName = req.params.name.replace(/[^a-zA-Z0-9_-]/g, '');
    const agentDir = path.join(agentsDir, agentName);
    const manifestPath = path.join(agentDir, 'agent.json');
    if (!fs.existsSync(manifestPath)) return res.status(404).json({ error: 'Agent not found' });

    try {
      const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
      const { definitions } = getAgentTools(agentDir, manifest, agentName);
      res.json({ tools: definitions.map(d => ({ name: d.function.name, description: d.function.description, parameters: d.function.parameters })) });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  // Start/stop MCP servers for an agent
  app.post('/api/agents/:name/mcp/start', async (req, res) => {
    const agentName = req.params.name.replace(/[^a-zA-Z0-9_-]/g, '');
    const manifestPath = path.join(agentsDir, agentName, 'agent.json');
    if (!fs.existsSync(manifestPath)) return res.status(404).json({ error: 'Agent not found' });

    try {
      const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
      const result = await startAgentMCPServers(manifest, agentName);
      res.json({ ok: true, servers: result });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  app.post('/api/agents/:name/mcp/stop', (req, res) => {
    const agentName = req.params.name.replace(/[^a-zA-Z0-9_-]/g, '');
    stopAgentMCPServers(agentName);
    res.json({ ok: true });
  });

  // Run vulnerability scan on an installed agent
  app.post('/api/agents/:name/scan', (req, res) => {
    const agentName = req.params.name.replace(/[^a-zA-Z0-9_-]/g, '');
    const agentDir = path.join(agentsDir, agentName);
    if (!fs.existsSync(path.join(agentDir, 'agent.json'))) {
      return res.status(404).json({ error: 'Agent not found' });
    }
    try {
      const report = scanAgent(agentDir);
      // Cache the report
      const reportPath = path.join(agentDir, '.scan-report.json');
      fs.writeFileSync(reportPath, JSON.stringify(report, null, 2), 'utf8');
      res.json(report);
    } catch (e) {
      res.status(500).json({ error: 'Scan failed: ' + e.message });
    }
  });

  // Get cached scan report
  app.get('/api/agents/:name/scan-report', (req, res) => {
    const agentName = req.params.name.replace(/[^a-zA-Z0-9_-]/g, '');
    const reportPath = path.join(agentsDir, agentName, '.scan-report.json');
    if (!fs.existsSync(reportPath)) {
      return res.status(404).json({ error: 'No scan report found. Run POST /api/agents/:name/scan first.' });
    }
    try {
      const report = JSON.parse(fs.readFileSync(reportPath, 'utf8'));
      res.json(report);
    } catch (e) {
      res.status(500).json({ error: 'Failed to read scan report' });
    }
  });

  // Get formatted scan report as markdown
  app.get('/api/agents/:name/scan-report/markdown', (req, res) => {
    const agentName = req.params.name.replace(/[^a-zA-Z0-9_-]/g, '');
    const reportPath = path.join(agentsDir, agentName, '.scan-report.json');
    if (!fs.existsSync(reportPath)) {
      return res.status(404).json({ error: 'No scan report found' });
    }
    try {
      const report = JSON.parse(fs.readFileSync(reportPath, 'utf8'));
      const markdown = formatScanReport(report);
      res.type('text/markdown').send(markdown);
    } catch (e) {
      res.status(500).json({ error: 'Failed to format scan report' });
    }
  });

  // Scan a zip archive before import (pre-publish check)
  app.post('/api/agents/scan-zip', express.raw({ type: 'application/zip', limit: '10mb' }), (req, res) => {
    const tmp = path.join(os.tmpdir(), 'agent-scan-' + Date.now());
    try {
      fs.mkdirSync(tmp, { recursive: true });
      const zipPath = path.join(tmp, 'agent.zip');
      fs.writeFileSync(zipPath, req.body);
      execSync(`unzip -o -q "${zipPath}" -d "${tmp}/extracted"`, { timeout: 30000 });
      const extracted = path.join(tmp, 'extracted');
      // Find agent root
      let agentRoot = extracted;
      if (!fs.existsSync(path.join(extracted, 'agent.json'))) {
        const dirs = fs.readdirSync(extracted).filter(d => fs.statSync(path.join(extracted, d)).isDirectory());
        for (const d of dirs) {
          if (fs.existsSync(path.join(extracted, d, 'agent.json'))) { agentRoot = path.join(extracted, d); break; }
        }
      }
      if (!fs.existsSync(path.join(agentRoot, 'agent.json'))) {
        return res.status(400).json({ error: 'No agent.json found in archive' });
      }
      const report = scanAgent(agentRoot);
      res.json(report);
    } catch (e) {
      res.status(500).json({ error: 'Scan failed: ' + e.message });
    } finally {
      try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (_) {}
    }
  });
}
