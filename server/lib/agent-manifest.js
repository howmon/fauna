// Shared agent-manifest loader.
//
// Resolves an agent's manifest from a folder. Two modes:
//   - A proper Fauna agent: reads agent.json (and resolves systemPromptFile).
//   - A dropped folder WITHOUT agent.json (e.g. a Claude-style AGENT.md folder
//     or a bare system-prompt.md): synthesizes an in-memory manifest so the
//     agent is still discoverable AND its instructions flow into chat context.
//
// Used by the agents routes (listing), the chat route (authoritative
// instruction injection), and self-tools (fauna_get_agent_instructions) so all
// three agree on how a folder maps to a usable agent.

import fs from 'fs';
import path from 'path';

// Build an in-memory manifest for an agent folder that has no agent.json.
// Returns null if the folder doesn't look like an agent (no prompt source, or
// an internal/hidden folder like `_skills` / `.git`).
export function synthesizeManifest(agentDir, name) {
  if (/^[._]/.test(name)) return null;
  let entries;
  try { entries = fs.readdirSync(agentDir); } catch (_) { return null; }
  const findFile = (re) => entries.find((f) => re.test(f) && (() => {
    try { return fs.statSync(path.join(agentDir, f)).isFile(); } catch (_) { return false; }
  })());
  const promptFile = findFile(/^agent\.md$/i)
    || findFile(/^system-prompt\.md$/i)
    || findFile(/^prompt\.md$/i)
    || findFile(/^readme\.md$/i)
    || findFile(/^skill\.md$/i);
  if (!promptFile) return null;
  let body = '';
  try { body = fs.readFileSync(path.join(agentDir, promptFile), 'utf8'); } catch (_) { return null; }
  if (!body.trim()) return null;
  // Display name from the first H1, else title-case the folder slug.
  const h1 = (body.match(/^\s*#\s+(.+?)\s*$/m) || [])[1];
  const displayName = (h1 && h1.trim())
    || name.replace(/[-_]+/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
  // Description: first non-empty, non-heading, non-bold-only line.
  let description = '';
  for (const line of body.split('\n')) {
    const t = line.trim();
    if (!t || t.startsWith('#')) continue;
    description = t.replace(/^\*\*|\*\*$/g, '').replace(/^[*_>-]\s*/, '').trim();
    if (description) break;
  }
  return {
    name,
    displayName,
    description: description.slice(0, 200),
    icon: 'ti-robot',
    systemPrompt: body,
    _synthesized: true,
    _promptFile: promptFile,
  };
}

// Load an agent manifest by name from agentsDir. Returns the manifest object
// (with `systemPrompt` populated) or null if the folder is missing / invalid.
// Prefers a real agent.json; falls back to a synthesized manifest.
export function loadAgentManifest(agentsDir, name) {
  if (!agentsDir || !name) return null;
  const safe = String(name).replace(/[^a-zA-Z0-9_-]/g, '');
  if (!safe) return null;
  const agentDir = path.join(agentsDir, safe);
  const manifestPath = path.join(agentDir, 'agent.json');
  if (fs.existsSync(manifestPath)) {
    try {
      const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
      // Resolve an external prompt file if the inline body is absent.
      if (!manifest.systemPrompt && manifest.systemPromptFile) {
        const promptPath = path.join(agentDir, manifest.systemPromptFile);
        if (fs.existsSync(promptPath)) {
          try { manifest.systemPrompt = fs.readFileSync(promptPath, 'utf8'); } catch (_) {}
        }
      }
      manifest._dir = agentDir;
      return manifest;
    } catch (_) {
      return null;
    }
  }
  // No agent.json — synthesize from AGENT.md / system-prompt.md.
  try {
    if (!fs.existsSync(agentDir) || !fs.statSync(agentDir).isDirectory()) return null;
  } catch (_) { return null; }
  const synth = synthesizeManifest(agentDir, safe);
  if (synth) synth._dir = agentDir;
  return synth;
}
