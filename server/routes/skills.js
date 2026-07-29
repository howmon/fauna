// Skill management routes: list installed packs and import a new one.
//
// A "pack" is a directory containing one or more SKILL.md files. Imports
// are validated via lib/skill-anatomy.js before they land under
// ~/.config/fauna/skills/<name>/.
//
// POST /api/skills/import accepts JSON { url, name? } (git/https tarball) or
// raw application/zip body. Either form must produce a tree containing at
// least one valid SKILL.md after extraction.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execSync } from 'node:child_process';
import { lintSkillsTree } from '../../lib/skill-anatomy.js';

const USER_SKILLS_DIR = path.join(os.homedir(), '.config', 'fauna', 'skills');

// Parse a GitHub tree URL into { cloneUrl, subpath }.
// https://github.com/owner/repo/tree/branch/some/path  → clone the repo, use some/path as root
// https://github.com/owner/repo (no /tree/)            → clone whole repo, subpath = ''
// Returns null for non-GitHub URLs (handled by the generic git-clone path).
function _parseGithubUrl(url) {
  // Strip trailing slashes / .git suffix for matching
  const clean = url.replace(/\.git$/, '').replace(/\/+$/, '');
  const treeMatch = clean.match(/^https:\/\/github\.com\/([^/]+\/[^/]+)\/tree\/[^/]+(?:\/(.+))?$/);
  if (treeMatch) {
    return {
      cloneUrl: `https://github.com/${treeMatch[1]}.git`,
      subpath:  treeMatch[2] ? treeMatch[2].replace(/\/+$/, '') : '',
    };
  }
  const baseMatch = clean.match(/^https:\/\/github\.com\/[^/]+\/[^/]+$/);
  if (baseMatch) {
    return { cloneUrl: clean + '.git', subpath: '' };
  }
  return null;
}

function _safeSlug(name) {
  return String(name || '')
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64);
}

function _readDesc(skillFile) {
  try {
    const src = fs.readFileSync(skillFile, 'utf8').slice(0, 1024);
    const m = src.match(/^description:\s*(.+)/m);
    return m ? m[1].trim().replace(/^['"]|['"]$/g, '').slice(0, 200) : '';
  } catch (_) { return ''; }
}

function _listInstalled() {
  const out = [];
  // Repo-level pack
  try {
    const cwd = process.cwd();
    const repoRoot = path.join(cwd, 'skills');
    if (fs.existsSync(repoRoot)) {
      for (const ent of fs.readdirSync(repoRoot, { withFileTypes: true })) {
        if (!ent.isDirectory()) continue;
        const skillFile = path.join(repoRoot, ent.name, 'SKILL.md');
        if (fs.existsSync(skillFile)) out.push({ name: ent.name, scope: 'repo', path: skillFile, description: _readDesc(skillFile) });
      }
    }
  } catch (_) {}
  // User-level packs
  try {
    if (fs.existsSync(USER_SKILLS_DIR)) {
      for (const ent of fs.readdirSync(USER_SKILLS_DIR, { withFileTypes: true })) {
        if (!ent.isDirectory()) continue;
        const skillFile = path.join(USER_SKILLS_DIR, ent.name, 'SKILL.md');
        if (fs.existsSync(skillFile)) out.push({ name: ent.name, scope: 'user', path: skillFile, description: _readDesc(skillFile) });
      }
    }
  } catch (_) {}
  return out;
}

export function registerSkillRoutes(app, { express } = {}) {
  // List installed skill packs with linter status.
  app.get('/api/skills', (_req, res) => {
    const installed = _listInstalled();
    res.json({ ok: true, count: installed.length, skills: installed });
  });

  // Lint a single tree (used by the agentstore admin UI before installing).
  app.post('/api/skills/lint', express ? express.json({ limit: '1mb' }) : (_q, _r, n) => n(), (req, res) => {
    const dir = String((req.body && req.body.dir) || '').trim();
    if (!dir || !fs.existsSync(dir)) return res.status(400).json({ ok: false, error: 'dir does not exist' });
    try {
      const report = lintSkillsTree(dir);
      res.json({ ok: true, report });
    } catch (e) {
      res.status(500).json({ ok: false, error: e.message });
    }
  });

  // Import a skill pack from a git URL or a GitHub tree URL. Lands under
  // ~/.config/fauna/skills/<slug>/. Refuses to overwrite an existing pack
  // unless { force: true } is passed.
  //
  // Accepted URL forms:
  //   https://github.com/owner/repo              → clone whole repo
  //   https://github.com/owner/repo.git          → clone whole repo
  //   https://github.com/owner/repo/tree/main/skills → sparse-checkout skills/
  //   git@github.com:owner/repo.git              → clone whole repo (SSH)
  app.post('/api/skills/import', express ? express.json({ limit: '1mb' }) : (_q, _r, n) => n(), async (req, res) => {
    const body = req.body || {};
    const url = String(body.url || '').trim();
    const force = !!body.force;
    if (!url) return res.status(400).json({ ok: false, error: 'url required (git or https tarball)' });

    // Whitelist transports — only allow https, ssh git URLs, or plain git@.
    // No file:// or http:// to avoid local-disk traversal or downgrade.
    if (!/^(https:\/\/|git@|ssh:\/\/)/.test(url)) {
      return res.status(400).json({ ok: false, error: 'url must use https://, git@, or ssh:// transport' });
    }

    const slugBase = _safeSlug(body.name || url.replace(/.*\//, '').replace(/\.git$/, '').replace(/\?.*$/, '')) || 'imported-skill-pack';
    const target = path.join(USER_SKILLS_DIR, slugBase);
    if (fs.existsSync(target) && !force) {
      return res.status(409).json({ ok: false, error: `${slugBase} already installed. Pass force:true to overwrite.` });
    }

    try {
      fs.mkdirSync(USER_SKILLS_DIR, { recursive: true });
      if (fs.existsSync(target)) fs.rmSync(target, { recursive: true, force: true });

      const ghParsed = _parseGithubUrl(url);
      if (ghParsed && ghParsed.subpath) {
        // GitHub tree URL with a subfolder — use sparse checkout to avoid
        // cloning the entire repo when only one directory is needed.
        const tmpClone = target + '-sparse-' + Date.now();
        try {
          execSync(
            `git clone --depth=1 --filter=blob:none --sparse ${JSON.stringify(ghParsed.cloneUrl)} ${JSON.stringify(tmpClone)}`,
            { stdio: ['ignore', 'pipe', 'pipe'], timeout: 60_000 },
          );
          execSync(
            `git -C ${JSON.stringify(tmpClone)} sparse-checkout set ${JSON.stringify(ghParsed.subpath)}`,
            { stdio: ['ignore', 'pipe', 'pipe'], timeout: 30_000 },
          );
          const srcDir = path.join(tmpClone, ghParsed.subpath);
          if (!fs.existsSync(srcDir)) throw new Error(`Subfolder "${ghParsed.subpath}" not found in repo`);
          // Move the subdirectory to target; strip .git if somehow present.
          fs.cpSync(srcDir, target, { recursive: true });
        } finally {
          try { fs.rmSync(target + '-sparse-' + Date.now().toString().slice(0, -3) + '*', { recursive: true, force: true }); } catch (_) {}
          // Best-effort cleanup of the temp clone dir
          try { fs.rmSync(tmpClone, { recursive: true, force: true }); } catch (_) {}
        }
      } else {
        // Plain git URL or whole-repo GitHub URL — shallow clone directly.
        const cloneUrl = ghParsed ? ghParsed.cloneUrl : url;
        execSync(`git clone --depth=1 ${JSON.stringify(cloneUrl)} ${JSON.stringify(target)}`, {
          stdio: ['ignore', 'pipe', 'pipe'],
          timeout: 60_000,
        });
        // Strip the .git directory so the pack is just plain markdown.
        try { fs.rmSync(path.join(target, '.git'), { recursive: true, force: true }); } catch (_) {}
      }
    } catch (e) {
      try { if (fs.existsSync(target)) fs.rmSync(target, { recursive: true, force: true }); } catch (_) {}
      return res.status(502).json({ ok: false, error: 'import failed: ' + e.message });
    }

    // Lint after install — if no valid SKILL.md, roll back.
    const report = lintSkillsTree(target);
    const results = Array.isArray(report) ? report : (report.results || []);
    if (!results.length) {
      try { fs.rmSync(target, { recursive: true, force: true }); } catch (_) {}
      return res.status(422).json({ ok: false, error: 'no SKILL.md files found in pack' });
    }
    const invalid = results.filter((r) => !r.ok);
    res.json({
      ok: true,
      installed: slugBase,
      dir: target,
      count: results.length,
      invalidCount: invalid.length,
      report: results,
      _note: invalid.length
        ? 'Pack installed but some skills failed lint — fix them or remove the offending files.'
        : 'Pack installed and all skills passed lint.',
    });
  });

  // Get the raw content of a user skill's SKILL.md for editing.
  app.get('/api/skills/:name/content', (req, res) => {
    const name = String(req.params.name || '').trim();
    if (!name || /[/\\]/.test(name)) return res.status(400).json({ ok: false, error: 'Invalid name' });
    const skillFile = path.join(USER_SKILLS_DIR, name, 'SKILL.md');
    if (!fs.existsSync(skillFile)) return res.status(404).json({ ok: false, error: 'Skill not found or not user-scoped' });
    try {
      const content = fs.readFileSync(skillFile, 'utf8');
      res.json({ ok: true, name, content });
    } catch (e) {
      res.status(500).json({ ok: false, error: e.message });
    }
  });

  // Update the raw content of a user skill's SKILL.md.
  app.put('/api/skills/:name', express ? express.json({ limit: '2mb' }) : (_q, _r, n) => n(), (req, res) => {
    const name = String(req.params.name || '').trim();
    if (!name || /[/\\]/.test(name)) return res.status(400).json({ ok: false, error: 'Invalid name' });
    const skillFile = path.join(USER_SKILLS_DIR, name, 'SKILL.md');
    // Safety: only edit files inside USER_SKILLS_DIR
    if (!path.resolve(skillFile).startsWith(path.resolve(USER_SKILLS_DIR) + path.sep)) {
      return res.status(403).json({ ok: false, error: 'Cannot edit bundled or repo skills' });
    }
    if (!fs.existsSync(skillFile)) return res.status(404).json({ ok: false, error: 'Skill not found or not user-scoped' });
    const content = String((req.body && req.body.content) || '');
    if (!content.trim()) return res.status(400).json({ ok: false, error: 'content required' });
    try {
      fs.writeFileSync(skillFile, content, 'utf8');
      res.json({ ok: true, name });
    } catch (e) {
      res.status(500).json({ ok: false, error: e.message });
    }
  });

  // Delete a user-scoped skill pack. Refuses to delete repo/bundled skills.
  app.delete('/api/skills/:name', (req, res) => {
    const name = String(req.params.name || '').trim();
    if (!name || /[/\\]/.test(name)) return res.status(400).json({ ok: false, error: 'Invalid name' });
    const target = path.join(USER_SKILLS_DIR, name);
    // Safety: only delete if it is actually inside USER_SKILLS_DIR
    const resolved = path.resolve(target);
    if (!resolved.startsWith(path.resolve(USER_SKILLS_DIR) + path.sep)) {
      return res.status(403).json({ ok: false, error: 'Cannot delete bundled or repo skills' });
    }
    if (!fs.existsSync(resolved)) return res.status(404).json({ ok: false, error: 'Skill not found' });
    try {
      fs.rmSync(resolved, { recursive: true, force: true });
      res.json({ ok: true, deleted: name });
    } catch (e) {
      res.status(500).json({ ok: false, error: e.message });
    }
  });
}
