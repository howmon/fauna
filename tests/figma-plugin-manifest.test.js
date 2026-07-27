import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const repoRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

describe('Figma plugin manifests', () => {
  it.each([
    'assets/figma-plugin/manifest.json',
    'faunaMCP-main/figma-plugin/manifest.json',
  ])('%s grants TeamLibrary API access', relativePath => {
    const manifest = JSON.parse(fs.readFileSync(path.join(repoRoot, relativePath), 'utf8'));

    expect(manifest.permissions).toContain('teamlibrary');
  });
});