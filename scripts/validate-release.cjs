#!/usr/bin/env node

const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const releaseTag = process.env.RELEASE_TAG || process.argv[2];

if (!releaseTag || !/^v\d+\.\d+\.\d+$/.test(releaseTag)) {
  console.error('Release tag must use the form vX.Y.Z (set RELEASE_TAG or pass it as the first argument).');
  process.exit(1);
}

const expectedVersion = releaseTag.slice(1);
const artifacts = [
  ['Fauna', 'package.json'],
  ['Fauna lockfile', 'package-lock.json'],
  ['FaunaMCP', 'faunaMCP-main/package.json'],
  ['FaunaMCP lockfile', 'faunaMCP-main/package-lock.json'],
];

const mismatches = [];
for (const [label, relativePath] of artifacts) {
  const manifest = JSON.parse(fs.readFileSync(path.join(root, relativePath), 'utf8'));
  if (manifest.version !== expectedVersion) {
    mismatches.push(`${label}: expected ${expectedVersion}, found ${manifest.version}`);
  }
}

if (mismatches.length > 0) {
  console.error(`Release ${releaseTag} does not match packaged artifact versions:`);
  for (const mismatch of mismatches) console.error(`  - ${mismatch}`);
  process.exit(1);
}

console.log(`Release contract valid: ${releaseTag} matches Fauna and FaunaMCP.`);