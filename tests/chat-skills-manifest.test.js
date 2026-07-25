import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildSkillsManifestContext } from '../server/routes/chat.js';
import { listSkillsOnDisk } from '../self-tools.js';

// Build a throwaway workspace with a couple of skills, then drive
// buildSkillsManifestContext() against it. Skills use every discovery root
// that doesn't require agent scaffolding.

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'fauna-skills-'));
const workspaceRoot = path.join(tmpRoot, 'ws');
const agentsDir = path.join(tmpRoot, 'agents');

function writeSkill(dir, name, frontmatter, body = '# Body\n\nDetails.') {
  const skillDir = path.join(dir, name);
  fs.mkdirSync(skillDir, { recursive: true });
  const fm = Object.entries(frontmatter).map(([k, v]) => `${k}: ${v}`).join('\n');
  fs.writeFileSync(path.join(skillDir, 'SKILL.md'), `---\n${fm}\n---\n\n${body}\n`);
}

beforeAll(() => {
  fs.mkdirSync(workspaceRoot, { recursive: true });
  fs.mkdirSync(agentsDir, { recursive: true });
  writeSkill(path.join(workspaceRoot, 'skills'), 'figma-design', {
    name: 'figma-design',
    description: '"Design work in Figma via figma_execute. Use whenever the user asks to design, mock up, style, lay out, or restyle anything in Figma."',
  });
  writeSkill(path.join(agentsDir, '_skills'), 'pptx', {
    name: 'pptx',
    description: '"PowerPoint decks — create with pptxgenjs, edit via unpack/edit XML/repack, read with markitdown."',
  });
});

afterAll(() => {
  try { fs.rmSync(tmpRoot, { recursive: true, force: true }); } catch (_) {}
});

describe('buildSkillsManifestContext()', () => {
  it('returns bundled skills even when no external roots are provided', () => {
    // Bundled skills ship in-the-box, so a bare install still surfaces them.
    const emptyRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'fauna-empty-'));
    try {
      const ctx = buildSkillsManifestContext(emptyRoot, null, emptyRoot);
      expect(ctx).toContain('## Available skills');
      expect(ctx).toContain('[bundled]');
    } finally {
      fs.rmSync(emptyRoot, { recursive: true, force: true });
    }
  });

  it('renders one manifest line per installed skill with path + description', () => {
    const ctx = buildSkillsManifestContext(agentsDir, null, workspaceRoot);
    expect(ctx).toContain('## Available skills');
    expect(ctx).toContain('- figma-design');
    expect(ctx).toContain('- pptx');
    expect(ctx).toContain(path.join(workspaceRoot, 'skills', 'figma-design', 'SKILL.md'));
    expect(ctx).toContain(path.join(agentsDir, '_skills', 'pptx', 'SKILL.md'));
    expect(ctx).toContain('Design work in Figma');
    expect(ctx).toContain('PowerPoint decks');
  });

  it('tells the model to load bodies with fauna_read_file, not to guess', () => {
    const ctx = buildSkillsManifestContext(agentsDir, null, workspaceRoot);
    expect(ctx).toContain('fauna_read_file');
    expect(ctx).toMatch(/do NOT guess/i);
  });

  it('labels each skill with its discovery scope', () => {
    const ctx = buildSkillsManifestContext(agentsDir, null, workspaceRoot);
    expect(ctx).toContain('[repo]');
    expect(ctx).toContain('[global]');
  });

  it('is safe when only workspaceRoot is provided', () => {
    const ctx = buildSkillsManifestContext(null, null, workspaceRoot);
    expect(ctx).toContain('- figma-design');
  });
});

describe('bundled skills (ship with Fauna out-of-the-box)', () => {
  it('discovers every skill in <fauna>/skills/ with scope "bundled"', () => {
    // No agentsDir, no workspaceRoot — only the bundled root should surface.
    const bundled = listSkillsOnDisk(null, null, {}).filter(s => s.scope === 'bundled');
    const names = bundled.map(s => s.name).sort();
    expect(names).toContain('figma-design');
    expect(names).toContain('pptx');
    expect(names).toContain('pr-writer');
  });

  it('bundled skills show up in the manifest with paths inside the app', () => {
    const ctx = buildSkillsManifestContext(null, null, null);
    expect(ctx).toContain('- figma-design [bundled]');
    expect(ctx).toContain('- pptx [bundled]');
    expect(ctx).toContain('- pr-writer [bundled]');
    // Paths must resolve to the real files on disk (dev) or asar (packaged).
    for (const name of ['figma-design', 'pptx', 'pr-writer']) {
      const skill = listSkillsOnDisk(null, null, {}).find(s => s.name === name);
      expect(skill).toBeTruthy();
      expect(fs.existsSync(skill.path)).toBe(true);
    }
  });

  it('a repo-scope skill of the same name overrides the bundled one', () => {
    // The scanner is first-match-wins with order: agent → global → repo → user → bundled.
    const shadowingRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'fauna-shadow-'));
    try {
      const dir = path.join(shadowingRoot, 'skills', 'pr-writer');
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, 'SKILL.md'),
        '---\nname: pr-writer\ndescription: "REPO OVERRIDE — team-specific PR template."\n---\n\n# Team template\n');
      const found = listSkillsOnDisk(null, null, { workspaceRoot: shadowingRoot });
      const pr = found.find(s => s.name === 'pr-writer');
      expect(pr).toBeTruthy();
      expect(pr.scope).toBe('repo');
      expect(pr.description).toContain('REPO OVERRIDE');
    } finally {
      fs.rmSync(shadowingRoot, { recursive: true, force: true });
    }
  });
});
