// ── Harness ↔ Fauna agent format adapter ──
// Harness (https://github.com/revfactory/harness) ships sub-agent teams in the
// Claude Code format:
//   .claude/agents/<slug>.md     — agent definition (YAML frontmatter + body)
//   .claude/skills/<slug>/SKILL.md — reusable workflow skill (frontmatter + body)
//
// This module converts those files to Fauna's agent.json + system-prompt.md +
// skills/<skill>/SKILL.md layout. It is intentionally pure (no I/O): callers
// pass file paths or contents and receive plain objects ready to be written
// to disk. Side-effects happen in the importer route, not here.
//
// References:
//   Claude Code agents — name/description/tools frontmatter
//   Harness teams — name/description/agents body keywords pattern hints

import fs from 'fs';
import path from 'path';

// ── Tool name translation ──
// Claude Code uses capitalized capability names; Fauna uses fine-grained
// permissions. This mapping is intentionally conservative — anything we
// don't recognize is dropped (Fauna will reject unknown tools at runtime).
const CLAUDE_TOOL_MAP = {
  Bash: { shell: true },
  Read: { fileRead: ['~/**'] },
  Write: { fileWrite: ['~/**'] },
  Edit: { fileWrite: ['~/**'] },
  Glob: { fileRead: ['~/**'] },
  Grep: { fileRead: ['~/**'] },
  WebFetch: { network: { allowedDomains: ['*'] } },
  WebSearch: { network: { allowedDomains: ['*'] } },
  Browser: { browser: true },
  Computer: { browser: true, shell: true },
};

// ── YAML frontmatter parser (zero-dep, handles the subset Harness uses) ──
// Supports: scalar strings (quoted or unquoted), inline flow arrays
// (`tools: [Bash, Read]`), and basic boolean/numeric literals. NOT a full
// YAML 1.2 parser — Harness only uses these forms, and pulling in js-yaml
// would bloat the Electron bundle.
export function parseFrontmatter(content) {
  const m = String(content || '').match(/^---\s*\n([\s\S]*?)\n---\s*\n?([\s\S]*)$/);
  if (!m) return { frontmatter: {}, body: String(content || '').trim() };
  const fm = {};
  const lines = m[1].split('\n');
  for (const raw of lines) {
    const line = raw.replace(/#.*$/, '').trimEnd();
    if (!line.trim()) continue;
    const km = line.match(/^([a-zA-Z_][\w-]*)\s*:\s*(.*)$/);
    if (!km) continue;
    const key = km[1];
    let val = km[2].trim();
    if (!val) { fm[key] = ''; continue; }
    // Flow array: [a, b, "c"]
    if (val.startsWith('[') && val.endsWith(']')) {
      fm[key] = val.slice(1, -1).split(',').map(s => s.trim().replace(/^["']|["']$/g, '')).filter(Boolean);
      continue;
    }
    // Quoted scalar
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      fm[key] = val.slice(1, -1);
      continue;
    }
    if (val === 'true') { fm[key] = true; continue; }
    if (val === 'false') { fm[key] = false; continue; }
    if (/^-?\d+(\.\d+)?$/.test(val)) { fm[key] = Number(val); continue; }
    fm[key] = val;
  }
  return { frontmatter: fm, body: m[2].trim() };
}

// ── Pattern detection (best-effort) ──
// Harness ships 6 named team patterns. We sniff the body for keywords so the
// converted agent can self-describe in its `_meta.harnessPattern` field —
// useful for downstream filtering in the agent picker.
const PATTERN_KEYWORDS = {
  'sequential':   /\b(sequential|pipeline|step\s*\d|in order|then\s+pass|hand[- ]?off)\b/i,
  'parallel':     /\b(parallel|concurrent(?:ly)?|fan[- ]?out|simultaneously)\b/i,
  'conditional':  /\b(if\s+.*then|conditional|branch(?:ing)?|route\s+to|when\s+.*else)\b/i,
  'hierarchical': /\b(hierarchical|coordinator|sub[- ]?agent.*manager|nested orchestrat)/i,
  'review':       /\b(review|critic|evaluat(?:e|ion)|grade|score|quality gate)\b/i,
  'iterative':    /\b(iterat(?:e|ive)|loop until|refine|revise|round\s*\d)\b/i,
};

export function detectHarnessPattern(body) {
  if (!body) return null;
  for (const [pattern, re] of Object.entries(PATTERN_KEYWORDS)) {
    if (re.test(body)) return pattern;
  }
  return null;
}

// ── Tool translation ──
// `tools` in frontmatter is either an array or a comma-separated string.
// Unknown tools are returned in `unknownTools` for caller logging.
export function translatePermissions(toolsField) {
  let toolList = [];
  if (Array.isArray(toolsField)) toolList = toolsField;
  else if (typeof toolsField === 'string') toolList = toolsField.split(',').map(s => s.trim()).filter(Boolean);

  const permissions = {};
  const unknown = [];
  for (const t of toolList) {
    const map = CLAUDE_TOOL_MAP[t];
    if (!map) { unknown.push(t); continue; }
    for (const [k, v] of Object.entries(map)) {
      if (Array.isArray(v)) {
        permissions[k] = Array.from(new Set([...(permissions[k] || []), ...v]));
      } else if (k === 'network') {
        const existing = permissions.network?.allowedDomains || [];
        permissions.network = { allowedDomains: Array.from(new Set([...existing, ...v.allowedDomains])) };
      } else {
        permissions[k] = v;
      }
    }
  }
  return { permissions, unknownTools: unknown };
}

// ── Single agent file → Fauna manifest + body ──
// Returns { manifest, systemPromptBody, warnings }.
// The caller is responsible for writing agent.json + system-prompt.md to disk.
export function claudeAgentToFauna(filePath, contents) {
  const raw = contents != null ? contents : fs.readFileSync(filePath, 'utf8');
  const { frontmatter, body } = parseFrontmatter(raw);
  const warnings = [];

  const slug = String(frontmatter.name || path.basename(filePath, '.md'))
    .toLowerCase().replace(/[^a-z0-9_-]/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '');
  if (!slug) warnings.push('Could not derive a valid slug for ' + filePath);

  const displayName = frontmatter.displayName ||
    slug.split(/[-_]/).map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');

  const { permissions, unknownTools } = translatePermissions(frontmatter.tools);
  if (unknownTools.length) warnings.push('Unknown Claude tools dropped for ' + slug + ': ' + unknownTools.join(', '));

  const pattern = detectHarnessPattern(body);

  const manifest = {
    name: slug,
    displayName,
    description: frontmatter.description || '',
    systemPrompt: body, // duplicated in system-prompt.md for human editing
    permissions,
    _meta: {
      source: 'harness',
      harnessPattern: pattern,
      originalName: frontmatter.name || null,
      originalTools: Array.isArray(frontmatter.tools) ? frontmatter.tools : (frontmatter.tools ? [frontmatter.tools] : []),
      importedAt: new Date().toISOString(),
    },
  };

  // If the agent looks like an orchestrator (declares sub-agents in body or
  // frontmatter), surface them so the importer can resolve cross-references.
  const subAgentRefs = [];
  if (Array.isArray(frontmatter.agents)) subAgentRefs.push(...frontmatter.agents);
  const inlineRefs = body.match(/(?:agents?\/|sub[- ]?agent[:\s]+)([a-z][\w-]+)/gi) || [];
  for (const ref of inlineRefs) {
    const m = ref.match(/([a-z][\w-]+)$/i);
    if (m) subAgentRefs.push(m[1]);
  }
  if (subAgentRefs.length) {
    manifest.agents = Array.from(new Set(subAgentRefs));
  }

  return { manifest, systemPromptBody: body, warnings };
}

// ── Single SKILL.md → Fauna skill ──
// Fauna skills live at `<agentsDir>/<agent>/skills/<slug>/SKILL.md` (agent-
// scoped) or `<agentsDir>/_skills/<slug>/SKILL.md` (global). We preserve the
// SKILL.md format unchanged — Fauna's fauna_list_skills/fauna_get_skill tools
// read the same frontmatter + body shape.
export function claudeSkillToFauna(filePath, contents) {
  const raw = contents != null ? contents : fs.readFileSync(filePath, 'utf8');
  const { frontmatter, body } = parseFrontmatter(raw);
  const slug = String(frontmatter.name || path.basename(path.dirname(filePath)) || path.basename(filePath, '.md'))
    .toLowerCase().replace(/[^a-z0-9_-]/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '');
  return {
    slug,
    description: frontmatter.description || '',
    body: raw, // preserve original, including frontmatter
    parsed: { frontmatter, body },
  };
}

// ── Full team conversion ──
// Walk a directory laid out like Harness/Claude Code:
//   <root>/.claude/agents/*.md
//   <root>/.claude/skills/<slug>/SKILL.md
// Returns { agents: [...], skills: [...], warnings }. Caller writes to disk.
export function convertHarnessTeam(rootDir) {
  const warnings = [];
  const agents = [];
  const skills = [];

  const agentsRoot = [
    path.join(rootDir, '.claude', 'agents'),
    path.join(rootDir, 'agents'),
  ].find(p => fs.existsSync(p));

  if (agentsRoot) {
    for (const ent of fs.readdirSync(agentsRoot, { withFileTypes: true })) {
      if (!ent.isFile() || !ent.name.toLowerCase().endsWith('.md')) continue;
      const result = claudeAgentToFauna(path.join(agentsRoot, ent.name));
      warnings.push(...result.warnings);
      agents.push(result);
    }
  } else {
    warnings.push('No agents directory found under ' + rootDir);
  }

  const skillsRoot = [
    path.join(rootDir, '.claude', 'skills'),
    path.join(rootDir, 'skills'),
  ].find(p => fs.existsSync(p));

  if (skillsRoot) {
    for (const ent of fs.readdirSync(skillsRoot, { withFileTypes: true })) {
      if (ent.isDirectory()) {
        const skillFile = path.join(skillsRoot, ent.name, 'SKILL.md');
        if (fs.existsSync(skillFile)) skills.push(claudeSkillToFauna(skillFile));
      } else if (ent.isFile() && ent.name.toLowerCase().endsWith('.md')) {
        skills.push(claudeSkillToFauna(path.join(skillsRoot, ent.name)));
      }
    }
  }

  return { agents, skills, warnings };
}

// ── Fauna → Claude (export, for round-trip) ──
// Emit a .claude/agents/<slug>.md file from a Fauna manifest + body.
// Reverse-maps permissions to Claude tool names (lossy — Fauna's fine-grained
// glob/domain lists collapse to coarse Claude capabilities).
const FAUNA_PERM_TO_CLAUDE = [
  { pred: (p) => p.shell, tools: ['Bash'] },
  { pred: (p) => p.fileRead && p.fileRead.length, tools: ['Read', 'Glob', 'Grep'] },
  { pred: (p) => p.fileWrite && p.fileWrite.length, tools: ['Write', 'Edit'] },
  { pred: (p) => p.network && p.network.allowedDomains && p.network.allowedDomains.length, tools: ['WebFetch'] },
  { pred: (p) => p.browser, tools: ['Browser'] },
];

export function faunaAgentToClaude(manifest) {
  const tools = new Set();
  const perms = manifest.permissions || {};
  for (const rule of FAUNA_PERM_TO_CLAUDE) {
    if (rule.pred(perms)) for (const t of rule.tools) tools.add(t);
  }
  const fm = ['---'];
  fm.push('name: ' + (manifest.name || ''));
  if (manifest.description) fm.push('description: ' + JSON.stringify(manifest.description));
  if (tools.size) fm.push('tools: [' + Array.from(tools).join(', ') + ']');
  fm.push('---');
  fm.push('');
  return fm.join('\n') + (manifest.systemPrompt || '');
}
