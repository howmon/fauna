#!/usr/bin/env node
'use strict';

// Export Fauna's canonical skill pack to per-tool adapter formats so the
// same SKILL.md content also lights up in Claude Code, Codex, Gemini,
// Antigravity, and Copilot. Idempotent — re-running overwrites.
//
// Usage: node scripts/export-skill-pack.cjs [--out <dir>] [--src <dir>]
//
// Layout produced under <out>/ (default: dist/skill-pack):
//   .claude/commands/<name>.md          (Claude Code slash command)
//   .codex/skills/<name>.md             (Codex skill)
//   .gemini/commands/<name>.toml        (Gemini CLI custom command)
//   commands/<name>.md                  (Antigravity / generic)
//   .github/copilot-instructions.md     (single concatenated file)
//   plugin.json                         (manifest enumerating the pack)
//   skills/<name>/SKILL.md              (verbatim source — for re-import)

const fs   = require('fs');
const path = require('path');

const args = process.argv.slice(2);
function argv(name, dflt) {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] ? args[i + 1] : dflt;
}

const SRC = path.resolve(argv('--src', path.join(__dirname, '..', 'skills')));
const OUT = path.resolve(argv('--out', path.join(__dirname, '..', 'dist', 'skill-pack')));

function parseFrontmatter(source) {
  const m = source.match(/^---\s*\n([\s\S]*?)\n---\s*\n?/);
  if (!m) return { data: {}, body: source };
  const data = {};
  for (const line of m[1].split('\n')) {
    const kv = line.match(/^([A-Za-z0-9_-]+)\s*:\s*(.*)$/);
    if (!kv) continue;
    data[kv[1]] = kv[2].replace(/^['"]|['"]$/g, '').trim();
  }
  return { data, body: source.slice(m[0].length) };
}

function listSkills(srcDir) {
  if (!fs.existsSync(srcDir)) return [];
  const out = [];
  for (const ent of fs.readdirSync(srcDir, { withFileTypes: true })) {
    if (!ent.isDirectory()) continue;
    const f = path.join(srcDir, ent.name, 'SKILL.md');
    if (!fs.existsSync(f)) continue;
    const source = fs.readFileSync(f, 'utf8');
    const { data, body } = parseFrontmatter(source);
    out.push({ slug: ent.name, name: data.name || ent.name, description: data.description || '', source, body });
  }
  return out;
}

function writeFile(p, content) {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, content);
}

function tomlEscape(s) {
  return String(s).replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

function main() {
  const skills = listSkills(SRC);
  if (!skills.length) {
    console.error('[export-skill-pack] no skills found under', SRC);
    process.exit(1);
  }

  // Clean output directory.
  if (fs.existsSync(OUT)) fs.rmSync(OUT, { recursive: true, force: true });
  fs.mkdirSync(OUT, { recursive: true });

  for (const s of skills) {
    // 1. Verbatim source (for re-import into Fauna).
    writeFile(path.join(OUT, 'skills', s.slug, 'SKILL.md'), s.source);

    // 2. Claude Code slash command.
    writeFile(path.join(OUT, '.claude', 'commands', s.slug + '.md'),
      `# /${s.slug}\n\n${s.description}\n\n---\n\n${s.body.trim()}\n`);

    // 3. Codex skill (same shape, different folder).
    writeFile(path.join(OUT, '.codex', 'skills', s.slug + '.md'), s.source);

    // 4. Gemini CLI TOML command.
    writeFile(path.join(OUT, '.gemini', 'commands', s.slug + '.toml'),
      `description = "${tomlEscape(s.description)}"\nprompt = """\n${s.body.trim()}\n"""\n`);

    // 5. Antigravity / generic commands folder.
    writeFile(path.join(OUT, 'commands', s.slug + '.md'),
      `# ${s.name}\n\n${s.description}\n\n${s.body.trim()}\n`);
  }

  // 6. Single concatenated Copilot instructions file.
  const copilot = skills.map((s) =>
    `# ${s.name}\n\n${s.description}\n\n${s.body.trim()}\n`
  ).join('\n---\n\n');
  writeFile(path.join(OUT, '.github', 'copilot-instructions.md'), copilot);

  // 7. plugin.json manifest enumerating the pack.
  const manifest = {
    name: 'fauna-canonical-skill-pack',
    version: '1.0.0',
    generatedAt: new Date().toISOString(),
    skills: skills.map((s) => ({ name: s.name, slug: s.slug, description: s.description })),
  };
  writeFile(path.join(OUT, 'plugin.json'), JSON.stringify(manifest, null, 2) + '\n');

  console.log('[export-skill-pack] wrote', skills.length, 'skills to', OUT);
}

main();
