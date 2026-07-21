import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { artifactTypeForPath, detectShellArtifacts } from '../server/routes/chat.js';

describe('chat shell artifact detection', () => {
  it('classifies presentation and spreadsheet outputs', () => {
    expect(artifactTypeForPath('deck.pptx')).toBe('deck');
    expect(artifactTypeForPath('report.xlsx')).toBe('xlsx');
  });

  it('does not report quoted input evidence as a newly created artifact', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fauna-artifact-input-'));
    try {
      fs.writeFileSync(path.join(root, 'package.json'), '{}');
      expect(detectShellArtifacts('jq . "package.json"', root)).toEqual([]);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('reports explicit save calls and redirect outputs', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fauna-artifact-output-'));
    try {
      fs.writeFileSync(path.join(root, 'deck.pptx'), 'deck');
      fs.writeFileSync(path.join(root, 'report.json'), '{}');
      expect(detectShellArtifacts('prs.save("deck.pptx"); echo ok > report.json', root)).toEqual([
        { path: path.join(root, 'deck.pptx'), type: 'deck' },
        { path: path.join(root, 'report.json'), type: 'json' },
      ]);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});