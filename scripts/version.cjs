#!/usr/bin/env node
/**
 * Fauna version manager
 *
 * Usage:
 *   node scripts/version.js                       — print all current versions
 *   node scripts/version.js patch                 — bump patch across all components
 *   node scripts/version.js minor                 — bump minor across all components
 *   node scripts/version.js major                 — bump major across all components
 *   node scripts/version.js set 1.2.3             — set exact version across all components
 *   node scripts/version.js patch --only figma    — bump only FaunaFigmaMCP
 *   node scripts/version.js patch --only browser  — bump only FaunaBrowserMCP
 *   node scripts/version.js patch --only app      — bump only main Fauna app
 *   node scripts/version.js patch --only relay    — bump only relay
 *   node scripts/version.js patch --only mobile   — bump only mobile
 *   node scripts/version.js patch --only ext      — bump only browser-extension
 *
 * Component tags: app, figma, browser, relay, mobile, ext
 */

const fs   = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');

// ─── Artifact registry ────────────────────────────────────────────────────────
// Each entry: { tag, label, file, field }
//   field: 'version' for package.json / manifest.json (string path to key)
const ARTIFACTS = [
  { tag: 'app',     label: 'Fauna (main app)',           file: 'package.json',                            field: 'version' },
  { tag: 'figma',   label: 'FaunaFigmaMCP',              file: 'faunafigmamcp/package.json',              field: 'version' },
  { tag: 'browser', label: 'FaunaBrowserMCP',            file: 'faunabrowsermcp/package.json',            field: 'version' },
  { tag: 'ext',     label: 'FaunaBrowserMCP extension',  file: 'faunabrowsermcp/extension/manifest.json', field: 'version' },
  { tag: 'bext',    label: 'Browser extension (legacy)', file: 'browser-extension/manifest.json',         field: 'version' },
  { tag: 'relay',   label: 'Relay server',               file: 'relay/package.json',                      field: 'version' },
  { tag: 'mobile',  label: 'Mobile (Expo)',               file: 'mobile/package.json',                     field: 'version' },
];

// ─── Helpers ─────────────────────────────────────────────────────────────────
function readJson(relPath) {
  const abs = path.join(ROOT, relPath);
  return JSON.parse(fs.readFileSync(abs, 'utf8'));
}

function writeJson(relPath, obj) {
  const abs = path.join(ROOT, relPath);
  const raw = fs.readFileSync(abs, 'utf8');
  // Preserve original indentation style
  const indent = raw.match(/^(\s+)"/m)?.[1] ?? '  ';
  fs.writeFileSync(abs, JSON.stringify(obj, null, indent.length === 4 ? 4 : 2) + '\n');
}

function bumpVersion(current, type) {
  const [maj, min, pat] = current.split('.').map(Number);
  if (type === 'major') return `${maj + 1}.0.0`;
  if (type === 'minor') return `${maj}.${min + 1}.0`;
  if (type === 'patch') return `${maj}.${min}.${pat + 1}`;
  throw new Error(`Unknown bump type: ${type}`);
}

function getVersion(tag) {
  const a = ARTIFACTS.find(x => x.tag === tag);
  return readJson(a.file)[a.field];
}

function setVersion(tag, newVer) {
  const a = ARTIFACTS.find(x => x.tag === tag);
  const obj = readJson(a.file);
  obj[a.field] = newVer;
  writeJson(a.file, obj);
}

function pad(str, n) { return str.padEnd(n); }

// ─── Commands ─────────────────────────────────────────────────────────────────
function printAll() {
  console.log('\nFauna component versions\n' + '─'.repeat(48));
  for (const a of ARTIFACTS) {
    try {
      const v = getVersion(a.tag);
      console.log(`  ${pad(a.label, 30)} v${v}`);
    } catch {
      console.log(`  ${pad(a.label, 30)} (not found)`);
    }
  }
  console.log();
}

function bump(type, onlyTag) {
  const targets = onlyTag ? ARTIFACTS.filter(a => a.tag === onlyTag) : ARTIFACTS;
  if (onlyTag && targets.length === 0) {
    console.error(`Unknown tag: ${onlyTag}. Valid tags: ${ARTIFACTS.map(a => a.tag).join(', ')}`);
    process.exit(1);
  }

  console.log(`\nBumping ${type}${onlyTag ? ` (--only ${onlyTag})` : ' (all)'}\n` + '─'.repeat(48));
  for (const a of targets) {
    try {
      const cur = getVersion(a.tag);
      const next = bumpVersion(cur, type);
      setVersion(a.tag, next);
      console.log(`  ${pad(a.label, 30)} ${cur} → ${next}`);
    } catch (err) {
      console.log(`  ${pad(a.label, 30)} skipped (${err.message})`);
    }
  }
  console.log();
}

function setAll(ver, onlyTag) {
  // Validate semver
  if (!/^\d+\.\d+\.\d+$/.test(ver)) {
    console.error(`Invalid version "${ver}". Must be X.Y.Z`);
    process.exit(1);
  }
  const targets = onlyTag ? ARTIFACTS.filter(a => a.tag === onlyTag) : ARTIFACTS;

  console.log(`\nSetting version to ${ver}${onlyTag ? ` (--only ${onlyTag})` : ' (all)'}\n` + '─'.repeat(48));
  for (const a of targets) {
    try {
      const cur = getVersion(a.tag);
      setVersion(a.tag, ver);
      console.log(`  ${pad(a.label, 30)} ${cur} → ${ver}`);
    } catch (err) {
      console.log(`  ${pad(a.label, 30)} skipped (${err.message})`);
    }
  }
  console.log();
}

// ─── CLI ──────────────────────────────────────────────────────────────────────
const args    = process.argv.slice(2);
const cmd     = args[0];
const onlyIdx = args.indexOf('--only');
const onlyTag = onlyIdx !== -1 ? args[onlyIdx + 1] : null;

if (!cmd || cmd === 'list' || cmd === 'show') {
  printAll();
} else if (cmd === 'patch' || cmd === 'minor' || cmd === 'major') {
  bump(cmd, onlyTag);
} else if (cmd === 'set') {
  const ver = args[1];
  if (!ver) { console.error('Usage: version.js set X.Y.Z'); process.exit(1); }
  setAll(ver, onlyTag);
} else {
  console.error(`Unknown command: ${cmd}`);
  console.error('Usage: version.js [patch|minor|major|set X.Y.Z] [--only <tag>]');
  console.error('Tags:', ARTIFACTS.map(a => a.tag).join(', '));
  process.exit(1);
}
