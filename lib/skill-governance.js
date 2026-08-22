import fs from 'node:fs';
import path from 'node:path';
import { CHECKS } from '../agent-scanner.js';
import { lintSkillFile } from './skill-anatomy.js';
import { buildCatalog, routeSkill } from './skill-catalog.js';

const EXECUTABLE_EXTENSIONS = new Set(['.js', '.ts', '.py', '.sh']);
const BLOCKING_SEVERITIES = new Set(['critical', 'high']);

function semver(value) {
  return /^\d+\.\d+\.\d+$/.test(String(value || ''));
}

function collectExecutableFiles(root, current = root, output = []) {
  let entries = [];
  try { entries = fs.readdirSync(current, { withFileTypes: true }); } catch (_) { return output; }
  for (const entry of entries) {
    const absolute = path.join(current, entry.name);
    if (entry.isDirectory()) collectExecutableFiles(root, absolute, output);
    else if (entry.isFile() && EXECUTABLE_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) {
      output.push({ path: path.relative(root, absolute), content: fs.readFileSync(absolute, 'utf8') });
    }
  }
  return output;
}

export function scanSkillSecurity(skillDir) {
  const findings = [];
  for (const file of collectExecutableFiles(skillDir)) {
    const extension = path.extname(file.path).slice(1).toLowerCase();
    for (const check of CHECKS.filter(item => BLOCKING_SEVERITIES.has(item.severity) && item.patterns && item.fileTypes?.includes(extension))) {
      for (const pattern of check.patterns) {
        pattern.lastIndex = 0;
        let match;
        while ((match = pattern.exec(file.content)) !== null) {
          findings.push({ checkId: check.id, severity: check.severity, file: file.path, match: match[0].slice(0, 80) });
          if (!pattern.global) break;
        }
      }
    }
  }
  return findings;
}

export function validateSkillGovernance({ rootDir, registry, packageManifest, readme, changelog } = {}) {
  const errors = [];
  const warnings = [];
  const skillsRoot = path.resolve(rootDir || 'skills');
  const entries = Array.isArray(registry?.skills) ? registry.skills : [];
  const defaults = registry?.defaults || {};
  const skillDirs = fs.readdirSync(skillsRoot, { withFileTypes: true })
    .filter(entry => entry.isDirectory() && fs.existsSync(path.join(skillsRoot, entry.name, 'SKILL.md')))
    .map(entry => entry.name)
    .sort();
  const byName = new Map();
  for (const entry of entries) {
    if (!entry?.name) { errors.push('governance entry requires a name'); continue; }
    if (byName.has(entry.name)) errors.push(`duplicate governance entry: ${entry.name}`);
    byName.set(entry.name, entry);
  }
  for (const name of skillDirs) if (!byName.has(name)) errors.push(`skill missing from governance registry: ${name}`);
  for (const name of byName.keys()) if (!skillDirs.includes(name)) errors.push(`governance entry has no bundled skill: ${name}`);

  const descriptors = [];
  const lintByName = new Map();
  for (const name of skillDirs) {
    const skillPath = path.join(skillsRoot, name, 'SKILL.md');
    const lint = lintSkillFile(skillPath);
    lintByName.set(name, lint);
    descriptors.push({ name, path: skillPath, body: fs.readFileSync(skillPath, 'utf8'), description: lint.frontmatter?.description || '', scope: 'bundled' });
  }
  const catalog = buildCatalog(descriptors);

  for (const name of skillDirs) {
    const entry = byName.get(name);
    const lint = lintByName.get(name);
    if (!entry || !lint) continue;
    for (const error of lint.errors) errors.push(`${name}: ${error}`);
    const compatibility = entry.compatibility || defaults.compatibility;
    const minimumVersion = entry.minimumFaunaVersion || defaults.minimumFaunaVersion;
    if (!Array.isArray(compatibility) || compatibility.length === 0) errors.push(`${name}: compatibility is required`);
    if (!semver(minimumVersion)) errors.push(`${name}: minimumFaunaVersion must be semver`);
    if (!readme.includes(`](${name}/SKILL.md)`)) errors.push(`${name}: missing from skills/README.md`);
    if (!changelog.includes(`\`${name}\``)) errors.push(`${name}: missing changelog entry`);

    if (lint.policy.maturity === 'deprecated') {
      if (!entry.replacement || !byName.has(entry.replacement)) errors.push(`${name}: deprecated skill requires a valid replacement`);
      if (!entry.migration) errors.push(`${name}: deprecated skill requires migration guidance`);
      continue;
    }
    if (lint.policy.maturity !== 'promoted') continue;
    for (const warning of lint.warnings) errors.push(`${name}: ${warning}`);
    if (!Array.isArray(entry.goldenRoutes) || entry.goldenRoutes.length === 0) errors.push(`${name}: requires a golden route`);
    if (!Array.isArray(entry.negativeRoutes) || entry.negativeRoutes.length === 0) errors.push(`${name}: requires a negative route`);
    if (!Array.isArray(entry.behavioralEvaluations) || entry.behavioralEvaluations.length === 0) errors.push(`${name}: requires a behavioral evaluation`);
    for (const evaluation of entry.behavioralEvaluations || []) {
      if (!evaluation.situation || !Array.isArray(evaluation.expectedSignals) || evaluation.expectedSignals.length === 0) {
        errors.push(`${name}: behavioral evaluation requires a situation and expectedSignals`);
      }
    }
    const invocation = lint.policy.userInvocable && !lint.policy.modelInvocable ? 'user' : 'model';
    for (const route of entry.goldenRoutes || []) {
      const result = routeSkill(route.query, catalog, { invocation, includeDeprecated: false });
      if (result.top !== route.expect) errors.push(`${name}: golden route selected ${result.top || 'none'} for "${route.query}"`);
    }
    for (const route of entry.negativeRoutes || []) {
      const result = routeSkill(route.query, catalog, { invocation, includeDeprecated: false });
      if (result.top === route.reject) errors.push(`${name}: negative route incorrectly selected ${route.reject}`);
    }
    for (const finding of scanSkillSecurity(path.join(skillsRoot, name))) {
      errors.push(`${name}: ${finding.severity} security finding ${finding.checkId} in ${finding.file}`);
    }
  }

  if (!Array.isArray(packageManifest?.build?.files) || !packageManifest.build.files.includes('skills/**')) {
    errors.push('package build.files must include skills/**');
  }
  return { ok: errors.length === 0, errors, warnings, scanned: skillDirs.length };
}

export function loadAndValidateSkillGovernance(rootDir) {
  const root = path.resolve(rootDir || process.cwd());
  const skillsRoot = path.join(root, 'skills');
  const readJson = file => JSON.parse(fs.readFileSync(file, 'utf8'));
  return validateSkillGovernance({
    rootDir: skillsRoot,
    registry: readJson(path.join(skillsRoot, 'governance.json')),
    packageManifest: readJson(path.join(root, 'package.json')),
    readme: fs.readFileSync(path.join(skillsRoot, 'README.md'), 'utf8'),
    changelog: fs.readFileSync(path.join(skillsRoot, 'CHANGELOG.md'), 'utf8'),
  });
}
