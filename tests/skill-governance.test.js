import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { lintSkillFile } from '../lib/skill-anatomy.js';
import { loadAndValidateSkillGovernance, scanSkillSecurity, validateSkillGovernance } from '../lib/skill-governance.js';

const ROOT = process.cwd();

function governanceInputs(registry) {
  return {
    rootDir: path.join(ROOT, 'skills'),
    registry,
    packageManifest: JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')),
    readme: fs.readFileSync(path.join(ROOT, 'skills', 'README.md'), 'utf8'),
    changelog: fs.readFileSync(path.join(ROOT, 'skills', 'CHANGELOG.md'), 'utf8'),
  };
}

describe('skill governance', () => {
  it('validates the bundled governance registry', () => {
    const result = loadAndValidateSkillGovernance(ROOT);
    expect(result.ok, result.errors.join('\n')).toBe(true);
    expect(result.scanned).toBeGreaterThan(0);
  });

  it('keeps shared vocabulary primitives model-only and composed by workflows', () => {
    for (const name of ['domain-modeling', 'codebase-design']) {
      const lint = lintSkillFile(path.join(ROOT, 'skills', name, 'SKILL.md'));
      expect(lint.policy).toMatchObject({
        invocation: 'model-only',
        maturity: 'promoted',
        userInvocable: false,
        modelInvocable: true,
      });
    }

    const consumers = {
      'domain-modeling': ['spec-driven-development', 'code-review-and-quality', 'setup-fauna-engineering'],
      'codebase-design': ['spec-driven-development', 'incremental-implementation', 'code-review-and-quality', 'setup-fauna-engineering'],
    };
    for (const [reference, workflows] of Object.entries(consumers)) {
      for (const workflow of workflows) {
        const body = fs.readFileSync(path.join(ROOT, 'skills', workflow, 'SKILL.md'), 'utf8');
        expect(body, `${workflow} must compose ${reference}`).toContain(`\`${reference}\``);
      }
    }
  });

  it('fails closed when promoted evidence and packaging are absent', () => {
    const result = validateSkillGovernance({
      rootDir: 'skills',
      registry: { defaults: {}, skills: [] },
      packageManifest: { build: { files: [] } },
      readme: '',
      changelog: '',
    });
    expect(result.ok).toBe(false);
    expect(result.errors).toContain('package build.files must include skills/**');
    expect(result.errors.some(error => error.includes('missing from governance registry'))).toBe(true);
  });

  it('fails closed when promotion evidence is missing or outside the repository', () => {
    const registry = JSON.parse(fs.readFileSync(path.join(ROOT, 'skills', 'governance.json'), 'utf8'));
    registry.defaults.promotionEvidence.files = ['tests/does-not-exist.test.js', '../outside.json'];
    const result = validateSkillGovernance(governanceInputs(registry));
    expect(result.ok).toBe(false);
    expect(result.errors.some(error => error.includes('promotion evidence file does not exist'))).toBe(true);
    expect(result.errors.some(error => error.includes('must stay inside the repository'))).toBe(true);
  });

  it('fails closed when rollback policy cannot demote or deprecate', () => {
    const registry = JSON.parse(fs.readFileSync(path.join(ROOT, 'skills', 'governance.json'), 'utf8'));
    registry.defaults.rollback = { condition: '', action: 'ignore' };
    const result = validateSkillGovernance(governanceInputs(registry));
    expect(result.ok).toBe(false);
    expect(result.errors.some(error => error.includes('rollback.condition is required'))).toBe(true);
    expect(result.errors.some(error => error.includes('rollback.action must be one of'))).toBe(true);
  });

  it('reports high-severity executable security findings', async () => {
    const fs = await import('node:fs');
    const os = await import('node:os');
    const path = await import('node:path');
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fauna-skill-scan-'));
    try {
      fs.writeFileSync(path.join(root, 'unsafe.js'), 'const secret = process.env.API_KEY;\n');
      expect(scanSkillSecurity(root)).toEqual(expect.arrayContaining([
        expect.objectContaining({ checkId: 'env-access', severity: 'critical', file: 'unsafe.js' }),
      ]));
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
