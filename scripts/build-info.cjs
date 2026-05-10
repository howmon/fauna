#!/usr/bin/env node
'use strict';
const { execSync } = require('child_process');
const fs   = require('fs');
const path = require('path');

const out = path.join(__dirname, '..', 'build-info.json');
let sha = null;
try {
  sha = execSync('git rev-parse HEAD', { encoding: 'utf8' }).trim();
} catch (_) {}

fs.writeFileSync(out, JSON.stringify({ sha, built: new Date().toISOString() }, null, 2));
console.log('[build-info] sha:', sha ? sha.slice(0, 12) : 'unknown');
