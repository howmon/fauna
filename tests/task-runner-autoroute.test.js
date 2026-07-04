import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const { _testables } = await import('../task-runner.js');

// _scanSkillFiles scans process.cwd()/skills, so run these tests from an
// isolated temp workspace containing a couple of canned SKILL.md files.
let tmp;
let origCwd;

function writeSkill(dir, name, description, extra = '') {
  const skillDir = path.join(dir, 'skills', name);
  fs.mkdirSync(skillDir, { recursive: true });
  fs.writeFileSync(
    path.join(skillDir, 'SKILL.md'),
    `---\nname: ${name}\ndescription: ${description}\n---\n\n# ${name}\n\n${extra}\n`,
  );
}

beforeAll(() => {
  origCwd = process.cwd();
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'fauna-autoroute-'));
  writeSkill(tmp, 'debugging-and-error-recovery', 'Systematically debug failing tests, crashes, and unexpected exceptions by forming and testing hypotheses.');
  writeSkill(tmp, 'test-driven-development', 'Write a failing test first, then implement the minimal code to make it pass, then refactor.');
  process.chdir(tmp);
});

afterAll(() => {
  process.chdir(origCwd);
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (_) {}
});

describe('task-runner auto skill routing', () => {
  it('scans on-disk SKILL.md files from the workspace skills dir', () => {
    const skills = _testables.scanSkillFiles();
    const names = skills.map((s) => s.name);
    expect(names).toContain('debugging-and-error-recovery');
    expect(names).toContain('test-driven-development');
    const dbg = skills.find((s) => s.name === 'debugging-and-error-recovery');
    expect(dbg.description).toMatch(/debug/i);
  });

  it('routes a debugging task to the debugging skill and caches the result', () => {
    const task = { id: 'a1', title: 'The test suite crashes with an unexpected exception', description: 'Figure out why it fails and fix it.' };
    const slug = _testables.autoRouteSkill(task);
    expect(slug).toBe('debugging-and-error-recovery');
    // Cached (non-enumerable) so a second call is stable and cheap.
    expect(task.__autoRoutedSkill).toBe('debugging-and-error-recovery');
    expect(_testables.autoRouteSkill(task)).toBe('debugging-and-error-recovery');
  });

  it('never adds auto-routed skills to the evidence-gate skill list', () => {
    // _resolveTaskSkills feeds the anti-rationalization gate — auto-routed
    // skills must NOT appear there, or every task would be force-gated.
    const task = { id: 'a2', title: 'The test suite crashes with an unexpected exception' };
    expect(_testables.resolveTaskSkills(task)).toEqual([]);
  });

  it('surfaces an auto-routed skill as SUGGESTED (advisory) in the system prompt', () => {
    const task = { id: 'a3', title: 'The test suite crashes with an unexpected exception' };
    const lines = _testables.skillSystemPromptLines(task);
    expect(lines.length).toBeGreaterThan(0);
    expect(lines[0]).toMatch(/SUGGESTED SKILL/);
    expect(lines.join('\n')).toMatch(/debugging-and-error-recovery/);
  });

  it('marks explicitly-bound skills as ACTIVE (enforced) in the system prompt', () => {
    const task = { id: 'a4', title: 'Anything', skills: ['test-driven-development'] };
    const lines = _testables.skillSystemPromptLines(task);
    expect(lines[0]).toMatch(/ACTIVE SKILLS/);
    expect(lines.join('\n')).toMatch(/MUST follow/);
  });

  it('produces a per-task ledger path under the fauna config dir', () => {
    const p = _testables.ledgerPath('task-123');
    expect(p).toContain(path.join('.config', 'fauna', 'autonomous-runs'));
    expect(p.endsWith('task-123.ledger.jsonl')).toBe(true);
  });
});
