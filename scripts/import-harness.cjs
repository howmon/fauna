#!/usr/bin/env node
// ── Harness team importer CLI ──
// Usage:
//   node scripts/import-harness.cjs /path/to/harness/team [--force] [--prefix=hn]
//
// Resolves the team directory locally, calls into the harness-adapter, and
// writes converted agents + skills directly to ~/.config/fauna/agents/. Useful
// when the Electron app isn't running (CI seeding, batch imports). When the
// app IS running, prefer the HTTP route POST /api/agents/import-harness.

const fs = require('fs');
const os = require('os');
const path = require('path');

async function main() {
  const args = process.argv.slice(2);
  const sourceArg = args.find(a => !a.startsWith('--'));
  if (!sourceArg) {
    console.error('Usage: import-harness <dir> [--force] [--prefix=<slug>]');
    process.exit(2);
  }
  const force = args.includes('--force');
  const prefixArg = args.find(a => a.startsWith('--prefix='));
  const prefix = prefixArg ? prefixArg.slice('--prefix='.length).replace(/[^a-z0-9_-]/gi, '') : '';

  const source = path.resolve(sourceArg.replace(/^~/, os.homedir()));
  if (!fs.existsSync(source) || !fs.statSync(source).isDirectory()) {
    console.error('Not a directory:', source);
    process.exit(2);
  }

  // Adapter is ESM; load via dynamic import.
  const { convertHarnessTeam } = await import(
    require('url').pathToFileURL(path.join(__dirname, '..', 'lib', 'harness-adapter.js')).href
  );

  // Match Electron app's agentsDir default (~/.config/fauna/agents). Allow
  // override via FAUNA_AGENTS_DIR for CI/dev.
  const agentsDir = process.env.FAUNA_AGENTS_DIR
    || path.join(os.homedir(), '.config', 'fauna', 'agents');
  fs.mkdirSync(agentsDir, { recursive: true });

  const { agents, skills, warnings } = convertHarnessTeam(source);
  console.log(`Found ${agents.length} agent(s), ${skills.length} skill(s) in ${source}`);
  for (const w of warnings) console.warn('warn:', w);

  let imported = 0, skipped = 0;
  // Slug remap so orchestrator cross-references survive prefixing.
  const remap = new Map();
  for (const { manifest } of agents) {
    if (manifest.name) remap.set(manifest.name, prefix ? prefix + '-' + manifest.name : manifest.name);
  }
  for (const { manifest, systemPromptBody } of agents) {
    let slug = manifest.name;
    if (prefix) slug = prefix + '-' + slug;
    if (!slug) { console.warn('skip: empty slug'); continue; }
    const destDir = path.join(agentsDir, slug);
    if (fs.existsSync(path.join(destDir, 'agent.json')) && !force) {
      console.log('skip:', slug, '(exists, pass --force)');
      skipped++;
      continue;
    }
    fs.mkdirSync(destDir, { recursive: true });
    const final = { ...manifest, name: slug, systemPromptFile: 'system-prompt.md' };
    delete final.systemPrompt;
    if (Array.isArray(final.agents) && final.agents.length) {
      const remapped = [];
      const dropped = [];
      for (const ref of final.agents) {
        if (remap.has(ref)) remapped.push(remap.get(ref));
        else dropped.push(ref);
      }
      final.agents = remapped;
      if (remapped.length) final.orchestrator = true;
      if (dropped.length) console.warn('warn: orchestrator', slug, 'references unknown sub-agents (dropped):', dropped.join(', '));
    }
    fs.writeFileSync(path.join(destDir, 'agent.json'), JSON.stringify(final, null, 2));
    fs.writeFileSync(path.join(destDir, 'system-prompt.md'), systemPromptBody || '');
    const tag = final._meta?.harnessPattern ? `[${final._meta.harnessPattern}]` : '';
    const orchTag = final.orchestrator ? ` orchestrator->[${final.agents.join(',')}]` : '';
    console.log('imported:', slug, tag + orchTag);
    imported++;
  }

  const skillsDir = path.join(agentsDir, '_skills');
  if (skills.length) fs.mkdirSync(skillsDir, { recursive: true });
  let skillCount = 0;
  for (const sk of skills) {
    if (!sk.slug) continue;
    const destSkillDir = path.join(skillsDir, sk.slug);
    if (fs.existsSync(path.join(destSkillDir, 'SKILL.md')) && !force) {
      console.log('skill skip:', sk.slug, '(exists, pass --force)');
      continue;
    }
    fs.mkdirSync(destSkillDir, { recursive: true });
    fs.writeFileSync(path.join(destSkillDir, 'SKILL.md'), sk.body || '');
    console.log('skill:', sk.slug);
    skillCount++;
  }

  console.log(`\nDone. Imported ${imported} agent(s), skipped ${skipped}, ${skillCount} skill(s).`);
  console.log('Agents dir:', agentsDir);
}

main().catch(e => { console.error(e); process.exit(1); });
