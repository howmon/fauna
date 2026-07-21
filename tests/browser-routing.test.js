import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const source = fs.readFileSync(path.join(process.cwd(), 'public/js/browser.js'), 'utf8');
const chatSource = fs.readFileSync(path.join(process.cwd(), 'public/js/chat.js'), 'utf8');
const shellSource = fs.readFileSync(path.join(process.cwd(), 'public/js/shell.js'), 'utf8');

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

  it('keeps native fauna_browser calls internal before backend arbitration', () => {
    expect(chatSource).toContain("Object.assign({}, ev.args || {}, { forceInternal: true })");
    expect(source).toContain("var preferPlaywright = !action.forceInternal && !isLocalUrl");
  });

  it('defers mixed browser actions until shell results settle', () => {
    expect(chatSource).toContain('var deferBrowserActions = shellBlocks > 0;');
    expect(chatSource).toContain('extractAndRenderBrowserActions(buffer, msgEl, false, convId, deferBrowserActions)');
    expect(source).toContain('function runDeferredBrowserActionsForMessage(messageEl)');
    expect(source).toContain("statusEl.textContent = 'Waiting for shell…'");
    expect(shellSource).toContain('resumedBrowserActions = runDeferredBrowserActionsForMessage');
    expect(shellSource).toContain('if (opts.autoFeed && !resumedBrowserActions)');
  });
});