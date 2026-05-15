#!/usr/bin/env node
/**
 * Fauna Teams Bot — packaging script
 * Usage: node scripts/pack.js <APP_ID> <BOT_DOMAIN>
 * Example: node scripts/pack.js abc123 abc123.ngrok-free.app
 *
 * Produces: fauna-teams-bot.zip  (sideload this in Teams)
 */

import fs   from 'fs';
import path from 'path';
import { execSync } from 'child_process';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');

const [,, APP_ID, BOT_DOMAIN] = process.argv;

if (!APP_ID || !BOT_DOMAIN) {
  console.error('\nUsage: node scripts/pack.js <APP_ID> <BOT_DOMAIN>\n');
  console.error('Example: node scripts/pack.js abc123 abc123.ngrok-free.app\n');
  process.exit(1);
}

// Read and fill manifest placeholders
const manifestSrc = fs.readFileSync(path.join(ROOT, 'manifest.json'), 'utf8');
const filled = manifestSrc
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
