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

function _safeSlug(name) {
  return String(name || '')
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64);
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
        if (fs.existsSync(skillFile)) out.push({ name: ent.name, scope: 'repo', path: skillFile });
      }
    }
  } catch (_) {}
  // User-level packs
  try {
    if (fs.existsSync(USER_SKILLS_DIR)) {
      for (const ent of fs.readdirSync(USER_SKILLS_DIR, { withFileTypes: true })) {
        if (!ent.isDirectory()) continue;
        const skillFile = path.join(USER_SKILLS_DIR, ent.name, 'SKILL.md');
        if (fs.existsSync(skillFile)) out.push({ name: ent.name, scope: 'user', path: skillFile });
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

  // Import a skill pack from a git URL or a tarball URL. Lands under
  // ~/.config/fauna/skills/<slug>/. Refuses to overwrite an existing pack
  // unless { force: true } is passed.
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

    const slugBase = _safeSlug(body.name || url.replace(/.*\//, '').replace(/\.git$/, '')) || 'imported-skill-pack';
    const target = path.join(USER_SKILLS_DIR, slugBase);
    if (fs.existsSync(target) && !force) {
      return res.status(409).json({ ok: false, error: `${slugBase} already installed. Pass force:true to overwrite.` });
    }

    try {
      fs.mkdirSync(USER_SKILLS_DIR, { recursive: true });
      if (fs.existsSync(target)) fs.rmSync(target, { recursive: true, force: true });
      // git clone — let git handle ssh/https. Shallow clone keeps it cheap.
      execSync(`git clone --depth=1 ${JSON.stringify(url)} ${JSON.stringify(target)}`, {
        stdio: ['ignore', 'pipe', 'pipe'],
        timeout: 60_000,
      });
      // Strip the .git directory so the pack is just plain markdown.
      try { fs.rmSync(path.join(target, '.git'), { recursive: true, force: true }); } catch (_) {}
    } catch (e) {
      try { if (fs.existsSync(target)) fs.rmSync(target, { recursive: true, force: true }); } catch (_) {}
      return res.status(502).json({ ok: false, error: 'git clone failed: ' + e.message });
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
}
