// lib/skill-anatomy.js
// Skill format parser + linter following the addyosmani/agent-skills
// SKILL.md contract:
//   - YAML frontmatter with `name` (lowercase-hyphen) and `description`
//     (≤1024 chars, mentions "Use when")
//   - Recommended sections: Overview, When to Use, Process/Workflow,
//     Common Rationalizations, Red Flags, Verification
//
// Used by self-tools (skill discovery), the autonomous loop (to extract
// Verification + Rationalizations sections for the anti-rationalization
// gate), the skills CI lint, and the import route.
//
// Zero runtime dependencies. Pure functions only — easy to unit-test.

import fs from 'node:fs';
import path from 'node:path';

const FRONTMATTER_RE = /^---\s*\n([\s\S]*?)\n---\s*\n?/;
const NAME_RE = /^[a-z][a-z0-9-]*$/;
const MAX_DESCRIPTION = 1024;

// Recommended sections (warnings only — equivalent headings are allowed per
// the addyosmani contract).
const RECOMMENDED_SECTIONS = [
  { name: 'Overview',                aliases: [] },
  { name: 'When to Use',             aliases: ['when to apply', 'triggers', 'usage', 'use cases'] },
  { name: 'Process',                 aliases: ['core process', 'procedure', 'implementation procedure', 'workflow', 'workflows', 'the workflow', 'steps'] },
  { name: 'Common Rationalizations', aliases: ['rationalizations'] },
  { name: 'Red Flags',               aliases: ['red flag', 'anti-patterns', 'anti-pattern', 'pitfalls', 'common pitfalls', 'what to avoid', 'avoid', 'critical rules', 'warning'] },
  { name: 'Verification',            aliases: ['verify', 'verification loop', 'validation', 'validation checklist', 'qa', 'testing', 'evidence', 'exit criteria'] },
];

// Parse YAML frontmatter from a SKILL.md body. Returns
// { frontmatter: Record<string,string>, body: string, hasFrontmatter: bool }.
// Only flat string keys are supported — that matches the SKILL.md contract.
export function parseFrontmatter(source) {
  const text = String(source || '');
  const m = text.match(FRONTMATTER_RE);
  if (!m) return { frontmatter: {}, body: text, hasFrontmatter: false };

  const fm = {};
  const raw = m[1];
  const lines = raw.split('\n');
  let currentKey = null;
  let buffer = [];
  const flush = () => {
    if (!currentKey) return;
    const joined = buffer.join('\n').trim();
    // Strip surrounding quotes if symmetric.
    fm[currentKey] = joined.replace(/^["'](.*)["']$/s, '$1');
    currentKey = null;
    buffer = [];
  };
  for (const line of lines) {
    const kv = line.match(/^([a-zA-Z_][a-zA-Z0-9_-]*)\s*:\s*(.*)$/);
    if (kv) {
      flush();
      currentKey = kv[1];
      const v = kv[2];
      if (v.length) buffer.push(v);
    } else if (currentKey) {
      // Continuation line — multi-line YAML block.
      buffer.push(line.replace(/^\s+/, ''));
    }
  }
  flush();

  return {
    frontmatter: fm,
    body: text.slice(m[0].length),
    hasFrontmatter: true,
  };
}

// List top-level (## and ###) section titles in source order.
export function listSections(body) {
  if (!body) return [];
  const out = [];
  for (const line of String(body).split('\n')) {
    const m = line.match(/^(#{2,3})\s+(.+?)\s*$/);
    if (m) out.push({ level: m[1].length, title: m[2].trim() });
  }
  return out;
}

// Extract a single `## Heading` section body (incl. nested subsections,
// excluding the heading line itself). Case-insensitive match against the
// heading text. Returns null if not found.
export function extractSection(body, targetHeading) {
  if (!body || !targetHeading) return null;
  const target = String(targetHeading).trim().toLowerCase();
  const lines = String(body).split('\n');
  let startIdx = -1;
  let startLevel = 0;
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(/^(#{1,6})\s+(.+?)\s*$/);
    if (!m) continue;
    const heading = m[2].trim().toLowerCase();
    if (heading === target || heading.startsWith(target + ':')) {
      startIdx = i;
      startLevel = m[1].length;
      break;
    }
  }
  if (startIdx === -1) return null;
  let endIdx = lines.length;
  for (let i = startIdx + 1; i < lines.length; i++) {
    const m = lines[i].match(/^(#{1,6})\s+/);
    if (m && m[1].length <= startLevel) { endIdx = i; break; }
  }
  // Skip the heading line itself.
  return lines.slice(startIdx + 1, endIdx).join('\n').trim();
}

// Find the first matching section name from a list of candidates
// (case-insensitive substring match against actual section titles).
export function findSection(body, candidates) {
  if (!body) return null;
  const sections = listSections(body);
  const cands = (Array.isArray(candidates) ? candidates : [candidates])
    .map(c => String(c || '').trim().toLowerCase())
    .filter(Boolean);
  for (const s of sections) {
    const t = s.title.toLowerCase();
    for (const c of cands) {
      if (t === c || t.startsWith(c + ':') || t.includes(c)) {
        return extractSection(body, s.title);
      }
    }
  }
  return null;
}

// Lint a parsed skill. Returns { ok, errors[], warnings[], info[] }.
// `dirName` is optional — if provided, the frontmatter.name must match it.
export function lintSkill(source, opts = {}) {
  const errors = [];
  const warnings = [];
  const info = [];
  const { frontmatter: fm, body, hasFrontmatter } = parseFrontmatter(source);

  if (!hasFrontmatter) {
    errors.push('Missing YAML frontmatter. SKILL.md must begin with `---` ... `---`.');
  }
  if (!fm.name) {
    errors.push('Frontmatter `name` is required.');
  } else if (!NAME_RE.test(fm.name)) {
    errors.push(`Frontmatter \`name\` "${fm.name}" must be lowercase-hyphen-separated (e.g. "test-driven-development").`);
  } else if (opts.dirName && fm.name !== opts.dirName) {
    errors.push(`Frontmatter \`name\` "${fm.name}" must match directory name "${opts.dirName}".`);
  }
  if (!fm.description) {
    errors.push('Frontmatter `description` is required.');
  } else {
    if (fm.description.length > MAX_DESCRIPTION) {
      errors.push(`Frontmatter \`description\` exceeds ${MAX_DESCRIPTION} chars (got ${fm.description.length}).`);
    }
    if (!/use when/i.test(fm.description)) {
      warnings.push('Frontmatter `description` should contain a "Use when …" trigger clause so agents know when to activate the skill.');
    }
  }

  if (!body || body.trim().length < 20) {
    errors.push('Skill body is empty or too short to be useful.');
  }

  const sections = listSections(body).map(s => s.title.toLowerCase());
  for (const want of RECOMMENDED_SECTIONS) {
    const candidates = [want.name.toLowerCase(), ...want.aliases.map(a => a.toLowerCase())];
    const found = sections.some(t => candidates.some(c => t === c || t.startsWith(c + ':') || t.includes(c)));
    if (!found) warnings.push(`Missing recommended section "${want.name}" (or equivalent: ${want.aliases.join(', ') || 'none'}).`);
  }

  info.push(`Sections: ${listSections(body).map(s => s.title).join(' · ') || '(none)'}`);

  return {
    ok: errors.length === 0,
    errors,
    warnings,
    info,
    frontmatter: fm,
    sectionCount: sections.length,
  };
}

// Lint a SKILL.md file on disk. Infers `dirName` from the file path.
export function lintSkillFile(filePath) {
  let source;
  try {
    source = fs.readFileSync(filePath, 'utf8');
  } catch (e) {
    return { ok: false, errors: [`Cannot read file: ${e.message}`], warnings: [], info: [] };
  }
  const dirName = path.basename(path.dirname(filePath));
  const result = lintSkill(source, { dirName });
  result.path = filePath;
  return result;
}

// Walk a directory tree finding every SKILL.md and lint them all.
// Returns { ok, results: [{path, ok, errors, warnings}] }.
export function lintSkillsTree(rootDir) {
  const results = [];
  if (!fs.existsSync(rootDir)) return { ok: true, results, scanned: 0 };
  const walk = (dir) => {
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (_) { return; }
    for (const ent of entries) {
      const full = path.join(dir, ent.name);
      if (ent.isDirectory()) {
        if (ent.name.startsWith('.') || ent.name === 'node_modules') continue;
        walk(full);
      } else if (ent.isFile() && ent.name === 'SKILL.md') {
        results.push(lintSkillFile(full));
      }
    }
  };
  walk(rootDir);
  return {
    ok: results.every(r => r.ok),
    results,
    scanned: results.length,
  };
}
