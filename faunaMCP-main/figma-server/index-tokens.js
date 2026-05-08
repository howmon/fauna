/**
 * Token indexer — run once per design system to build tokens.json
 *
 * Usage:
 *   FIGMA_TOKEN=<your-figma-pat> node server/index-tokens.js <system-id>
 *
 * Where <system-id> matches an entry in systems.json (e.g. "security-sfe")
 *
 * Requires a Figma Personal Access Token (not the GitHub PAT).
 * Generate one at: https://www.figma.com/developers/api#access-tokens
 */

import { createRequire } from 'module';
import fs   from 'fs';
import path from 'path';
import https from 'https';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const require   = createRequire(import.meta.url);

const systemsPath = path.join(__dirname, 'systems.json');
const systems     = JSON.parse(fs.readFileSync(systemsPath, 'utf8')).systems;

const systemId    = process.argv[2];
const figmaToken  = process.env.FIGMA_TOKEN;

if (!systemId) {
  console.error('Usage: FIGMA_TOKEN=<token> node server/index-tokens.js <system-id>');
  console.error('Available systems:', systems.map(s => s.id).join(', '));
  process.exit(1);
}
if (!figmaToken) {
  console.error('Error: FIGMA_TOKEN env var not set.');
  console.error('Generate a Figma PAT at https://www.figma.com/developers/api#access-tokens');
  process.exit(1);
}

const system = systems.find(s => s.id === systemId);
if (!system) {
  console.error(`System "${systemId}" not found in systems.json`);
  process.exit(1);
}

console.log(`Indexing tokens for: ${system.name} (${system.figmaFileKey})`);

function figmaGet(endpoint) {
  return new Promise((resolve, reject) => {
    const options = {
      hostname: 'api.figma.com',
      path: endpoint,
      headers: { 'X-Figma-Token': figmaToken }
    };
    https.get(options, res => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch (e) { reject(new Error('JSON parse error: ' + data.slice(0, 200))); }
      });
    }).on('error', reject);
  });
}

// ── Fetch and parse Figma variables ──────────────────────────────────────

const raw = await figmaGet(`/v1/files/${system.figmaFileKey}/variables/local`);

if (raw.status === 403 || raw.err) {
  console.error('Figma API error:', raw.err || raw.status);
  console.error('Make sure your FIGMA_TOKEN has read access to this file.');
  process.exit(1);
}

const meta        = raw.meta || {};
const collections = meta.variableCollections || {};
const variables   = meta.variables           || {};

// Build output structure
const output = {
  system:      system.id,
  systemName:  system.name,
  figmaFileKey: system.figmaFileKey,
  indexedAt:   new Date().toISOString(),
  collections: []
};

for (const [colId, col] of Object.entries(collections)) {
  const modeMap = {};
  for (const mode of (col.modes || [])) modeMap[mode.modeId] = mode.name;

  const tokenList = [];
  for (const varId of (col.variableIds || [])) {
    const v = variables[varId];
    if (!v || v.remote) continue;

    const resolved = {};
    for (const [modeId, val] of Object.entries(v.valuesByMode || {})) {
      const modeName = modeMap[modeId] || modeId;
      if (val.type === 'VARIABLE_ALIAS') {
        // Resolve alias to the source variable name
        const src = variables[val.id];
        resolved[modeName] = src ? { alias: src.name } : { alias: val.id };
      } else {
        resolved[modeName] = val;
      }
    }

    tokenList.push({
      name:           v.name,
      key:            v.key,
      id:             varId,
      type:           v.resolvedType,   // COLOR | FLOAT | STRING | BOOLEAN
      collection:     col.name,
      collectionId:   colId,
      scopes:         v.scopes || [],   // FILL_COLOR, CORNER_RADIUS, GAP, etc.
      resolvedValues: resolved
    });
  }

  output.collections.push({
    id:        colId,
    name:      col.name,
    modes:     Object.values(modeMap),
    tokenCount: tokenList.length,
    tokens:    tokenList
  });
}

const totalTokens = output.collections.reduce((n, c) => n + c.tokenCount, 0);
console.log(`Found ${output.collections.length} collections, ${totalTokens} tokens`);

const outPath = path.join(__dirname, system.tokenIndex);
fs.mkdirSync(path.dirname(outPath), { recursive: true });
fs.writeFileSync(outPath, JSON.stringify(output, null, 2));
console.log(`✅  Written to ${system.tokenIndex}`);
