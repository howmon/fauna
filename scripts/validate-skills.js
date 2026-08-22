#!/usr/bin/env node

import { loadAndValidateSkillGovernance } from '../lib/skill-governance.js';

const result = loadAndValidateSkillGovernance(process.cwd());
if (!result.ok) {
  console.error(`Skill governance failed with ${result.errors.length} error(s):`);
  for (const error of result.errors) console.error(`  - ${error}`);
  process.exit(1);
}
console.log(`Skill governance valid: ${result.scanned} bundled skills checked.`);