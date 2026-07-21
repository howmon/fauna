import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const source = fs.readFileSync(path.join(process.cwd(), 'public/js/browser.js'), 'utf8');

describe('browser backend routing', () => {
  it('gives extension blocks precedence over internal legacy blocks', () => {
    const functionStart = source.indexOf('function extractAndRenderBrowserActions');
    const extensionGuard = source.indexOf("container.querySelectorAll('code.language-browser-ext-action", functionStart);
    const internalRun = source.indexOf('_runBrowserActionSequence(widgets', functionStart);

    expect(functionStart).toBeGreaterThanOrEqual(0);
    expect(extensionGuard).toBeGreaterThan(functionStart);
    expect(extensionGuard).toBeLessThan(internalRun);
    expect(source.slice(extensionGuard, internalRun)).toContain('return;');
  });
});