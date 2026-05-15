#!/usr/bin/env node
/**
 * Fauna Teams Bot — packaging script
 * Usage: node scripts/pack.js <APP_ID> <BOT_DOMAIN> [TEAMS_APP_ID]
 * Example: node scripts/pack.js abc123 abc123.ngrok-free.app 11111111-1111-4111-8111-111111111111
 *
 * Produces: fauna-teams-bot.zip  (sideload this in Teams)
 */

import fs   from 'fs';
import path from 'path';
import crypto from 'crypto';
import { execSync } from 'child_process';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');

const [,, APP_ID, BOT_DOMAIN, TEAMS_APP_ID] = process.argv;

if (!APP_ID || !BOT_DOMAIN) {
  console.error('\nUsage: node scripts/pack.js <APP_ID> <BOT_DOMAIN> [TEAMS_APP_ID]\n');
  console.error('Example: node scripts/pack.js abc123 abc123.ngrok-free.app 11111111-1111-4111-8111-111111111111\n');
  process.exit(1);
}

// Read and fill manifest placeholders
const manifestSrc = fs.readFileSync(path.join(ROOT, 'manifest.json'), 'utf8');
const filled = manifestSrc
  .replace(/\{\{TEAMS_APP_ID\}\}/g, TEAMS_APP_ID || stableTeamsAppId(APP_ID))
  .replace(/\{\{MICROSOFT_APP_ID\}\}/g, APP_ID)
  .replace(/\{\{BOT_DOMAIN\}\}/g, BOT_DOMAIN);

// Write filled manifest to a temp dir so zip picks it up as "manifest.json"
const tmpDir = path.join(ROOT, '_tmp_pack');
fs.mkdirSync(tmpDir, { recursive: true });
const tmpManifest = path.join(tmpDir, 'manifest.json');
fs.writeFileSync(tmpManifest, filled);

const zipPath = path.join(ROOT, 'fauna-teams-bot.zip');
if (fs.existsSync(zipPath)) fs.unlinkSync(zipPath);

execSync(
  `zip -j "${zipPath}" "${tmpManifest}" "${path.join(ROOT, 'color.png')}" "${path.join(ROOT, 'outline.png')}"`,
  { cwd: ROOT }
);

fs.rmSync(tmpDir, { recursive: true, force: true });

console.log(`\n✅ Created: fauna-teams-bot.zip`);
console.log(`\nNext steps:`);
console.log(`  1. Teams → Apps → Manage your apps → Upload an app → fauna-teams-bot.zip`);
console.log(`  2. Make sure your bot server is running: npm start`);
console.log(`  3. Make sure ngrok is tunneling port 3978\n`);

function stableTeamsAppId(appId) {
  const hexChars = crypto
    .createHash('sha256')
    .update(`fauna-teams-app:${appId}`)
    .digest('hex')
    .slice(0, 32)
    .split('');

  hexChars[12] = '4';
  hexChars[16] = ((parseInt(hexChars[16], 16) & 0x3) | 0x8).toString(16);

  const hex = hexChars.join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}
