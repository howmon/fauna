import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { formatImageAssetContext, persistConversationImageAssets } from '../server/lib/attachment-assets.js';

const roots = [];

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe('conversation image assets', () => {
  it('copies an original local image into the active project', () => {
    const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'fauna-image-project-'));
    const sourceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'fauna-image-source-'));
    roots.push(projectRoot, sourceRoot);
    const sourcePath = path.join(sourceRoot, 'birthday portrait.png');
    fs.writeFileSync(sourcePath, Buffer.from('original-pixels'));

    const assets = persistConversationImageAssets([{
      role: 'user',
      images: [{
        name: 'birthday portrait.png',
        mime: 'image/png',
        path: sourcePath,
        base64: Buffer.from('compressed-preview').toString('base64'),
      }],
    }], { projectRoot, conversationId: 'conv-1' });

    expect(assets).toHaveLength(1);
    expect(assets[0].absolutePath).toContain(path.join('.fauna', 'assets', 'uploads'));
    expect(fs.readFileSync(assets[0].absolutePath, 'utf8')).toBe('original-pixels');
    expect(assets[0].relativePath).toMatch(/^\.fauna\/assets\/uploads\//);
  });

  it('persists clipboard images and emits exact-asset guidance', () => {
    const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'fauna-clipboard-project-'));
    roots.push(projectRoot);
    const assets = persistConversationImageAssets([{
      role: 'user',
      images: [{ name: 'portrait.jpg', mime: 'image/jpeg', base64: Buffer.from('pixels').toString('base64') }],
    }], { projectRoot, conversationId: 'conv-2' });
    const context = formatImageAssetContext(assets);

    expect(fs.existsSync(assets[0].absolutePath)).toBe(true);
    expect(context).toContain('EXACT ASSET');
    expect(context).toContain(assets[0].absolutePath);
    expect(context).toContain('Do not redraw, regenerate, replace, or omit it');
  });
});