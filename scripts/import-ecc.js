#!/usr/bin/env node
// scripts/import-ecc.js
//
// Clones the ECC repository (shallow) and repurposes all its skills and
// agents for Fauna. Run once (or re-run to pick up upstream changes).
//
// Usage:
//   node scripts/import-ecc.js [--dry-run] [--force] [--skills-only] [--agents-only]
//
// Outputs:
//   ~/.config/fauna/skills/<name>/SKILL.md   — one per ECC skill (~200+)
//   ~/.config/fauna/agents/<name>/            — one folder per ECC agent (~60+)
//     agent.json                              — Fauna manifest
//     SKILL.md                                — system prompt body
//
// HOW "WITHOUT ADDING TO CONTEXT" WORKS
// ─────────────────────────────────────
// Fauna never bulk-loads skill content. Skills land on disk; `listSkillsOnDisk`
// reads only their frontmatter/description (~1 line per skill) and the BM25
// catalog (`lib/skill-catalog.js`) routes each request to the SINGLE most
// relevant skill. The model then calls `fauna_get_skill(name)` to pull just
// that skill's body — ~5-20 KB instead of the full library.  Unmatched skills
// cost zero tokens every turn.

import { execSync, spawnSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import os from 'os';

// ── CLI flags ─────────────────────────────────────────────────────────────
const argv = process.argv.slice(2);
const DRY       = argv.includes('--dry-run');
const FORCE     = argv.includes('--force');
const SKIP_SKI  = argv.includes('--agents-only');
const SKIP_AGE  = argv.includes('--skills-only');

// ── Paths ─────────────────────────────────────────────────────────────────
const HOME       = os.homedir();
const CONFIG     = path.join(HOME, '.config', 'fauna');
const SKILLS_OUT = path.join(CONFIG, 'skills');
const AGENTS_OUT = path.join(CONFIG, 'agents');
const TMP        = path.join(os.tmpdir(), 'ecc-import-' + process.pid);
const ECC_REPO   = 'https://github.com/affaan-m/ECC.git';

// ── Tool-name translation (ECC Claude Code → Fauna) ───────────────────────
const TOOL_MAP = {
  'Read':          'fauna_read_file',
  'Write':         'fauna_write_file',
  'Edit':          'fauna_replace_string',
  'MultiEdit':     'fauna_write_files',
  'Grep':          'fauna_grep',
  'Glob':          'fauna_list_directory',
  'Bash':          'fauna_shell_exec',
  'WebFetch':      'fauna_browser',
  'WebSearch':     'fauna_browser',
  'TodoWrite':     'fauna_plan',
  'TodoRead':      'fauna_recall',
  'Task':          'fauna_shell_exec',
  'NotebookRead':  'fauna_read_file',
  'NotebookEdit':  'fauna_write_file',
  'LS':            'fauna_list_directory',
  'Dispatch':      'fauna_shell_exec',
  'Computer':      'fauna_mouse',
};

// ── Model translation (ECC → Fauna model ids) ────────────────────────────
const MODEL_MAP = {
  'sonnet':       'claude-sonnet-4-5',
  'claude-sonnet': 'claude-sonnet-4-5',
  'opus':         'claude-opus-4-5',
  'claude-opus':  'claude-opus-4-5',
  'haiku':        'claude-haiku-3-5',
  'claude-haiku': 'claude-haiku-3-5',
};
const DEFAULT_MODEL = 'claude-sonnet-4-5';

// ── Helpers ───────────────────────────────────────────────────────────────

function log(msg)  { process.stdout.write(msg + '\n'); }
function warn(msg) { process.stderr.write('[warn] ' + msg + '\n'); }

function ensureDir(d) {
  if (!DRY) fs.mkdirSync(d, { recursive: true });
}

function writeFile(p, content) {
  if (DRY) { log('  [DRY] write → ' + p); return; }
  ensureDir(path.dirname(p));
  fs.writeFileSync(p, content, 'utf8');
}

// Parse flat YAML frontmatter (--- ... ---) from a SKILL.md body.
// Returns { fm: Map, body: string }.
function parseFm(source) {
  const FM_RE = /^---\s*\n([\s\S]*?)\n---\s*\n?/;
  const m = source.match(FM_RE);
  if (!m) return { fm: new Map(), body: source };
  const fm = new Map();
  let curKey = null, buf = [];
  const flush = () => {
    if (!curKey) return;
    const v = buf.join('\n').trim().replace(/^["'](.*)["']$/s, '$1');
    fm.set(curKey, v);
    curKey = null; buf = [];
  };
  for (const line of m[1].split('\n')) {
    const kv = line.match(/^([a-zA-Z_][a-zA-Z0-9_-]*)\s*:\s*(.*)$/);
    if (kv) { flush(); curKey = kv[1]; if (kv[2].length) buf.push(kv[2]); }
    else if (curKey) buf.push(line.replace(/^\s+/, ''));
  }
  flush();
  return { fm, body: source.slice(m[0].length) };
}

// Re-serialise frontmatter Map as YAML string (flat, no nesting).
function fmToYaml(fm) {
  const lines = [];
  for (const [k, v] of fm) {
    const safe = String(v).includes('\n') ? JSON.stringify(v) : v;
    lines.push(k + ': ' + safe);
  }
  return lines.join('\n');
}

// Translate a comma-separated ECC tools string to Fauna equivalents.
function mapTools(toolsStr) {
  if (!toolsStr) return [];
  return toolsStr.split(',')
    .map(t => t.trim())
    .map(t => TOOL_MAP[t] || null)
    .filter(Boolean);
}

// Translate ECC model name to Fauna model id.
function mapModel(modelStr) {
  if (!modelStr) return DEFAULT_MODEL;
  const lower = modelStr.toLowerCase().trim();
  for (const [k, v] of Object.entries(MODEL_MAP)) {
    if (lower.includes(k)) return v;
  }
  return DEFAULT_MODEL;
}

// Convert a slug like 'code-reviewer' → 'Code Reviewer'.
function slugToTitle(slug) {
  return slug.replace(/[-_]+/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
}

// Remove sections whose content is ECC-specific boilerplate we don't want.
// Currently strips "Project-Specific" sections that reference ECC's stack.
function stripEccSections(body) {
  // Remove the Prompt Defense Baseline section (it's boilerplate added by ECC;
  // Fauna has its own safety layer). Keep all actual skill/agent knowledge.
  return body.replace(/## Prompt Defense Baseline[\s\S]*?(?=\n## |\n# |$)/, '').trim();
}

// ── Skill transform ───────────────────────────────────────────────────────

function transformSkill(srcPath) {
  let src;
  try { src = fs.readFileSync(srcPath, 'utf8'); }
  catch (e) { warn('Cannot read ' + srcPath + ': ' + e.message); return null; }

  const { fm, body } = parseFm(src);

  // Name is required; derive from folder name if absent.
  const folder  = path.basename(path.dirname(srcPath));
  const name    = fm.get('name') || folder;
  const desc    = (fm.get('description') || '').slice(0, 1024);

  // Rebuild frontmatter — only carry over fields Fauna understands.
  const newFm = new Map();
  newFm.set('name', name);
  if (desc) newFm.set('description', desc);
  const toolsFauna = mapTools(fm.get('tools') || '');
  if (toolsFauna.length) newFm.set('tools', toolsFauna.join(', '));
  const model = fm.get('model');
  if (model) newFm.set('model', mapModel(model));

  const newBody = stripEccSections(body);
  const output = '---\n' + fmToYaml(newFm) + '\n---\n\n' + newBody + '\n';

  return { name, content: output };
}

// ── Agent transform ───────────────────────────────────────────────────────

function transformAgent(srcPath) {
  let src;
  try { src = fs.readFileSync(srcPath, 'utf8'); }
  catch (e) { warn('Cannot read ' + srcPath + ': ' + e.message); return null; }

  const { fm, body } = parseFm(src);

  const slug  = path.basename(srcPath, '.md');
  const name  = fm.get('name') || slug;
  const desc  = (fm.get('description') || '').slice(0, 500);
  const tools = mapTools(fm.get('tools') || '');
  const model = mapModel(fm.get('model') || '');

  // Infer permissions from declared tools.
  const hasShell   = tools.includes('fauna_shell_exec');
  const hasBrowser = tools.includes('fauna_browser');

  const manifest = {
    name,
    displayName: slugToTitle(name),
    description: desc,
    icon: 'ti-robot',
    systemPrompt: '',
    systemPromptFile: 'SKILL.md',
    model,
    permissions: {
      shell:     hasShell,
      browser:   hasBrowser,
      fileRead:  [],
      fileWrite: hasShell ? [] : false,
    },
    _source: 'ecc-import',
  };

  const cleanBody = stripEccSections(body);
  const skillContent = cleanBody.trim() + '\n';

  return { name, manifest, skillContent };
}

// ── Clone / update ECC ────────────────────────────────────────────────────

function cloneEcc() {
  if (fs.existsSync(TMP)) {
    log('Updating existing ECC clone at ' + TMP + '...');
    const r = spawnSync('git', ['-C', TMP, 'pull', '--ff-only', '--depth=1'], { stdio: 'inherit' });
    if (r.status !== 0) {
      warn('git pull failed; deleting and re-cloning...');
      fs.rmSync(TMP, { recursive: true, force: true });
    }
  }
  if (!fs.existsSync(TMP)) {
    log('Cloning ECC (shallow)...');
    const r = spawnSync('git', ['clone', '--depth=1', '--filter=blob:none', '--sparse', ECC_REPO, TMP], { stdio: 'inherit' });
    if (r.status !== 0) throw new Error('git clone failed');
    // Only check out skills/ and agents/ — much faster than a full clone.
    const init = spawnSync('git', ['-C', TMP, 'sparse-checkout', 'set', 'skills', 'agents'], { stdio: 'inherit' });
    if (init.status !== 0) throw new Error('sparse-checkout failed');
  }
}

// ── Main ─────────────────────────────────────────────────────────────────

function main() {
  if (DRY) log('*** DRY RUN — no files will be written ***\n');

  cloneEcc();

  let skillsOk = 0, skillsSkip = 0, agentsOk = 0, agentsSkip = 0;

  // ── Skills ──────────────────────────────────────────────────────────────
  if (!SKIP_SKI) {
    const skillsDir = path.join(TMP, 'skills');
    if (!fs.existsSync(skillsDir)) {
      warn('ECC skills/ dir not found at ' + skillsDir);
    } else {
      const skillFolders = fs.readdirSync(skillsDir, { withFileTypes: true })
        .filter(e => e.isDirectory())
        .map(e => e.name);

      log('\nImporting ' + skillFolders.length + ' skills → ' + SKILLS_OUT + '\n');

      for (const folder of skillFolders) {
        const srcPath = path.join(skillsDir, folder, 'SKILL.md');
        if (!fs.existsSync(srcPath)) { skillsSkip++; continue; }

        const result = transformSkill(srcPath);
        if (!result) { skillsSkip++; continue; }

        const outPath = path.join(SKILLS_OUT, result.name, 'SKILL.md');
        if (!FORCE && !DRY && fs.existsSync(outPath)) { skillsSkip++; continue; }

        writeFile(outPath, result.content);
        log('  [skill] ' + result.name);
        skillsOk++;
      }
    }
  }

  // ── Agents ──────────────────────────────────────────────────────────────
  if (!SKIP_AGE) {
    const agentsDir = path.join(TMP, 'agents');
    if (!fs.existsSync(agentsDir)) {
      warn('ECC agents/ dir not found at ' + agentsDir);
    } else {
      const agentFiles = fs.readdirSync(agentsDir)
        .filter(f => f.endsWith('.md'));

      log('\nImporting ' + agentFiles.length + ' agents → ' + AGENTS_OUT + '\n');

      for (const file of agentFiles) {
        const srcPath = path.join(agentsDir, file);
        const result = transformAgent(srcPath);
        if (!result) { agentsSkip++; continue; }

        const outDir    = path.join(AGENTS_OUT, result.name);
        const jsonPath  = path.join(outDir, 'agent.json');
        const skillPath = path.join(outDir, 'SKILL.md');

        if (!FORCE && !DRY && fs.existsSync(jsonPath)) { agentsSkip++; continue; }

        writeFile(jsonPath, JSON.stringify(result.manifest, null, 2) + '\n');
        writeFile(skillPath, result.skillContent);
        log('  [agent] ' + result.name);
        agentsOk++;
      }
    }
  }

  log('\n─────────────────────────────────────');
  log('Skills  written: ' + skillsOk + '  skipped: ' + skillsSkip);
  log('Agents  written: ' + agentsOk + '  skipped: ' + agentsSkip);
  log('\nSkills land at : ' + SKILLS_OUT);
  log('Agents land at : ' + AGENTS_OUT);
  log('\nFauna auto-discovers them via listSkillsOnDisk().');
  log('No context added until the skill catalog matches a request.');
  if (DRY) log('\n(DRY RUN — re-run without --dry-run to write files)');
}

main();
