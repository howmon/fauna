#!/usr/bin/env node
// ── Harness-100 fetcher CLI ──
// Shallow-clones (or updates) revfactory/harness-100 into a cache dir, then
// imports one or more team folders into Fauna's agents directory via the
// existing harness-adapter. Each team is imported with its folder name (e.g.
// "21-code-reviewer") as the slug prefix so agents from different teams
// never collide.
//
// Usage:
//   node scripts/fetch-harness-100.cjs --list
//   node scripts/fetch-harness-100.cjs <team-name|number> [more...]
//   node scripts/fetch-harness-100.cjs --all          # import all 100 (heavy)
//   node scripts/fetch-harness-100.cjs --lang=ko ...  # Korean teams
//   node scripts/fetch-harness-100.cjs --force ...    # overwrite existing
//
// Notes:
//   - Requires `git` on PATH. Cache lives at ~/.cache/fauna/harness-100/.
//   - Apache 2.0 source; imported files carry _meta.source="harness-100" so
//     downstream tooling can credit/audit.
//   - Each team's prefix is derived from its directory name (e.g. team
//     "21-code-reviewer" → agents named "21-code-reviewer-<agent>"). Pass
//     --no-prefix to skip prefixing (collisions become your problem).

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execSync } = require('child_process');

const REPO_URL = 'https://github.com/revfactory/harness-100.git';
const CACHE_DIR = path.join(os.homedir(), '.cache', 'fauna', 'harness-100');

function sh(cmd, opts = {}) {
  return execSync(cmd, { stdio: 'pipe', encoding: 'utf8', ...opts });
}

function ensureRepo() {
  fs.mkdirSync(path.dirname(CACHE_DIR), { recursive: true });
  if (fs.existsSync(path.join(CACHE_DIR, '.git'))) {
    console.log('[harness-100] updating cache at', CACHE_DIR);
    try { sh('git fetch --depth=1 origin main', { cwd: CACHE_DIR }); }
    catch (e) { console.warn('[harness-100] fetch failed (using existing cache):', e.message); }
    try { sh('git reset --hard origin/main', { cwd: CACHE_DIR }); } catch (_) {}
  } else {
    console.log('[harness-100] cloning to', CACHE_DIR);
    sh(`git clone --depth=1 ${REPO_URL} "${CACHE_DIR}"`);
  }
}

function listTeams(lang) {
  const dir = path.join(CACHE_DIR, lang);
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir, { withFileTypes: true })
    .filter(e => e.isDirectory() && /^\d+-/.test(e.name))
    .map(e => e.name)
    .sort((a, b) => {
      const na = parseInt(a, 10), nb = parseInt(b, 10);
      return na - nb;
    });
}

function resolveTeams(args, lang, allAvailable) {
  if (args.includes('--all')) return allAvailable;
  const wanted = args.filter(a => !a.startsWith('--'));
  if (!wanted.length) return [];
  const resolved = [];
  for (const want of wanted) {
    // Number → match folder starting with that number.
    if (/^\d+$/.test(want)) {
      const n = parseInt(want, 10);
      const hit = allAvailable.find(t => parseInt(t, 10) === n);
      if (hit) { resolved.push(hit); continue; }
      console.warn('[harness-100] no team #' + n + ' in', lang);
      continue;
    }
    // Exact folder name
    if (allAvailable.includes(want)) { resolved.push(want); continue; }
    // Substring match against the slug after "NN-"
    const hits = allAvailable.filter(t => t.replace(/^\d+-/, '').includes(want.toLowerCase()));
    if (hits.length === 1) { resolved.push(hits[0]); continue; }
    if (hits.length > 1) {
      console.warn('[harness-100] "' + want + '" matches multiple teams: ' + hits.join(', ') + ' — be more specific.');
      continue;
    }
    console.warn('[harness-100] no match for', want);
  }
  return Array.from(new Set(resolved));
}

async function main() {
  const args = process.argv.slice(2);
  const langArg = args.find(a => a.startsWith('--lang='));
  const lang = langArg ? langArg.slice('--lang='.length) : 'en';
  const force = args.includes('--force');
  const noPrefix = args.includes('--no-prefix');

  ensureRepo();
  const teams = listTeams(lang);
  if (!teams.length) {
    console.error('[harness-100] no teams under', path.join(CACHE_DIR, lang));
    process.exit(1);
  }

  if (args.includes('--list')) {
    console.log(`# ${teams.length} teams in ${lang}/`);
    for (const t of teams) console.log(t);
    return;
  }

  const wanted = resolveTeams(args, lang, teams);
  if (!wanted.length) {
    console.error('No teams selected. Try: --list, --all, or pass numbers/names. Example:');
    console.error('  node scripts/fetch-harness-100.cjs 21 22 code-reviewer');
    process.exit(2);
  }

  const { convertHarnessTeam } = await import(
    require('url').pathToFileURL(path.join(__dirname, '..', 'lib', 'harness-adapter.js')).href
  );

  const agentsDir = process.env.FAUNA_AGENTS_DIR
    || path.join(os.homedir(), '.config', 'fauna', 'agents');
  fs.mkdirSync(agentsDir, { recursive: true });
  fs.mkdirSync(path.join(agentsDir, '_skills'), { recursive: true });

  let totalAgents = 0, totalSkills = 0, totalSkipped = 0;
  for (const team of wanted) {
    const teamDir = path.join(CACHE_DIR, lang, team);
    const prefix = noPrefix ? '' : team; // e.g. "21-code-reviewer"
    console.log(`\n[harness-100] importing ${team}${prefix ? ' (prefix=' + prefix + ')' : ''}`);

    const { agents, skills, warnings } = convertHarnessTeam(teamDir);
    for (const w of warnings) console.warn('  warn:', w);
    if (!agents.length && !skills.length) {
      console.warn('  (empty — no .claude/agents or .claude/skills found)');
      continue;
    }

    // Slug remap so orchestrator cross-references survive prefixing.
    const remap = new Map();
    for (const { manifest } of agents) {
      if (manifest.name) remap.set(manifest.name, prefix ? prefix + '-' + manifest.name : manifest.name);
    }

    for (const { manifest, systemPromptBody } of agents) {
      let slug = manifest.name;
      if (prefix) slug = prefix + '-' + slug;
      if (!slug) continue;
      const destDir = path.join(agentsDir, slug);
      if (fs.existsSync(path.join(destDir, 'agent.json')) && !force) {
        console.log('  skip:', slug, '(exists)');
        totalSkipped++;
        continue;
      }
      fs.mkdirSync(destDir, { recursive: true });
      const final = { ...manifest, name: slug, systemPromptFile: 'system-prompt.md' };
      delete final.systemPrompt;
      // Stamp the harness-100 source so we can audit/re-fetch later.
      final._meta = { ...(final._meta || {}), source: 'harness-100', team, lang };
      if (Array.isArray(final.agents) && final.agents.length) {
        const remapped = [];
        for (const ref of final.agents) if (remap.has(ref)) remapped.push(remap.get(ref));
        final.agents = remapped;
        if (remapped.length) final.orchestrator = true;
      }
      fs.writeFileSync(path.join(destDir, 'agent.json'), JSON.stringify(final, null, 2));
      fs.writeFileSync(path.join(destDir, 'system-prompt.md'), systemPromptBody || '');
      const orchTag = final.orchestrator ? ` orchestrator->[${final.agents.length}]` : '';
      console.log('  imported:', slug, (final._meta.harnessPattern ? `[${final._meta.harnessPattern}]` : '') + orchTag);
      totalAgents++;
    }

    // Skills go to the global pool but are namespaced with the team prefix
    // to avoid collisions across imported teams.
    for (const sk of skills) {
      if (!sk.slug) continue;
      const skillSlug = prefix ? prefix + '-' + sk.slug : sk.slug;
      const destSkillDir = path.join(agentsDir, '_skills', skillSlug);
      if (fs.existsSync(path.join(destSkillDir, 'SKILL.md')) && !force) {
        console.log('  skill skip:', skillSlug);
        continue;
      }
      fs.mkdirSync(destSkillDir, { recursive: true });
      fs.writeFileSync(path.join(destSkillDir, 'SKILL.md'), sk.body || '');
      console.log('  skill:', skillSlug);
      totalSkills++;
    }

    // ── Synthesize a team orchestrator from the SKILL.md composition table ──
    // Harness teams declare their member agents inside the SKILL.md (in an
    // `## Agent Composition` table that references `.claude/agents/<name>.md`).
    // The agent.json files themselves don't carry a `agents:` reference, so
    // without this step the imported team is just a pile of co-equal agents
    // with no dispatcher. We extract the member list and emit one synthetic
    // orchestrator per skill that has a composition table.
    for (const sk of skills) {
      const composed = extractTeamMembers(sk.body);
      if (composed.length < 2) continue; // not a team
      const orchSlug = prefix ? prefix + '-orchestrator' : (sk.slug + '-orchestrator');
      const orchDir = path.join(agentsDir, orchSlug);
      if (fs.existsSync(path.join(orchDir, 'agent.json')) && !force) {
        console.log('  orch skip:', orchSlug);
        continue;
      }
      const memberSlugs = composed.map(m => prefix ? prefix + '-' + m : m).filter(s => remap.has(stripPrefix(s, prefix)));
      if (!memberSlugs.length) continue;
      fs.mkdirSync(orchDir, { recursive: true });
      const orchManifest = {
        name: orchSlug,
        displayName: (sk.parsed?.frontmatter?.name || team).replace(/-/g, ' ').replace(/\b\w/g, c => c.toUpperCase()) + ' Team',
        description: sk.description || ('Team orchestrator for ' + team),
        orchestrator: true,
        agents: memberSlugs,
        permissions: {},
        systemPromptFile: 'system-prompt.md',
        _meta: { source: 'harness-100', team, lang, synthetic: true, skill: sk.slug, harnessPattern: 'team' },
      };
      const orchPrompt = buildOrchestratorPrompt(orchManifest, memberSlugs, sk);
      fs.writeFileSync(path.join(orchDir, 'agent.json'), JSON.stringify(orchManifest, null, 2));
      fs.writeFileSync(path.join(orchDir, 'system-prompt.md'), orchPrompt);
      console.log('  orchestrator:', orchSlug, `(${memberSlugs.length} members)`);
      totalAgents++;
    }
  }

  console.log(`\nDone. ${totalAgents} agent(s), ${totalSkills} skill(s), ${totalSkipped} skipped.`);
  console.log('Agents dir:', agentsDir);
  console.log('License: source is Apache 2.0 (revfactory/harness-100).');
}

function stripPrefix(slug, prefix) {
  if (!prefix) return slug;
  return slug.startsWith(prefix + '-') ? slug.slice(prefix.length + 1) : slug;
}

// Extract `name` from `agents/<name>.md` references in a SKILL body. Looks
// at markdown tables and inline backtick paths. Returns deduped slug list.
function extractTeamMembers(body) {
  if (!body || typeof body !== 'string') return [];
  const out = new Set();
  const reTablePath = /`?\.?\/?\.claude\/agents\/([a-z0-9][a-z0-9_-]*)\.md`?/gi;
  let m;
  while ((m = reTablePath.exec(body)) !== null) out.add(m[1].toLowerCase());
  // Fallback: bare `agents/<name>.md` without .claude/ prefix
  const reBare = /(?:^|[\s`(])agents\/([a-z0-9][a-z0-9_-]*)\.md/gi;
  while ((m = reBare.exec(body)) !== null) out.add(m[1].toLowerCase());
  return Array.from(out);
}

function buildOrchestratorPrompt(manifest, memberSlugs, skill) {
  const skillName = skill?.parsed?.frontmatter?.name || skill?.slug || 'team';
  const lines = [];
  lines.push(`# ${manifest.displayName}`);
  lines.push('');
  lines.push(manifest.description || '');
  lines.push('');
  lines.push('You are the orchestrator for this team. Delegate work to specialist sub-agents using the `[DELEGATE: agents/<name>]` block, wait for their replies, and synthesize the final answer for the user.');
  lines.push('');
  lines.push('## Team members');
  lines.push('');
  for (const s of memberSlugs) lines.push(`- \`${s}\``);
  lines.push('');
  lines.push('## Operating principles');
  lines.push('');
  lines.push('1. Parse the user request, identify which specialists are needed.');
  lines.push('2. Dispatch independent subtasks in parallel by emitting one `[DELEGATE: agents/<slug>]` block per specialist, each with a focused brief.');
  lines.push('3. Wait for all delegated responses, then synthesize a single coherent answer.');
  lines.push('4. When findings conflict across specialists, arbitrate and explain your decision.');
  lines.push('5. End with a concise summary and a clear next action for the user.');
  lines.push('');
  lines.push(`## Source skill: \`${skillName}\``);
  lines.push('');
  lines.push('Refer to the team\'s skill for detailed workflow, phases, and acceptance criteria. The skill is loaded into your context automatically when relevant.');
  return lines.join('\n');
}

main().catch(e => { console.error(e); process.exit(1); });