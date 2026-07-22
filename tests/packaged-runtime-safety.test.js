import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const repoRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const read = relativePath => fs.readFileSync(path.join(repoRoot, relativePath), 'utf8');

describe('packaged macOS runtime safety', () => {
  it('keeps normal builds signed and declares protected-folder usage', () => {
    const packageJson = JSON.parse(read('package.json'));

    expect(packageJson.scripts.build).not.toContain('identity=null');
    expect(packageJson.scripts['build:unsigned']).toContain('identity=null');
    expect(packageJson.build.mac.extendInfo).toMatchObject({
      NSDownloadsFolderUsageDescription: expect.any(String),
      NSDocumentsFolderUsageDescription: expect.any(String),
      NSDesktopFolderUsageDescription: expect.any(String),
    });
  });

  it('keeps MCP runtime output outside the signed app bundle', () => {
    const playwrightRoutes = read('server/routes/playwright-mcp.js');
    const customMcpBridge = read('server/bridges/custom-mcp.js');

    expect(playwrightRoutes).toContain("path.join(runtimeDir, 'playwright-mcp')");
    expect(playwrightRoutes).not.toContain('cwd: path.dirname(cliPath)');
    expect(customMcpBridge).toContain("path.join(faunaConfigDir, 'browser-server')");
    expect(customMcpBridge).not.toContain('cwd: path.dirname(bundledBrowserServerPath)');
  });

  it('does not composite the hidden voice overlay', () => {
    const styles = read('public/css/styles.css');
    const hiddenSelectors = ['#vl-outer', '#vl-mid', '#vl-inner', '#vl-center', '.vw-bar'];

    expect(styles).toMatch(/#voice-overlay\s*\{[^}]*visibility:\s*hidden/s);
    for (const selector of hiddenSelectors) {
      const escapedSelector = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      expect(styles.match(new RegExp(`${escapedSelector}\\s*\\{[^}]*\\}`, 's'))?.[0]).not.toContain('animation:');
      expect(styles).toContain(`#voice-overlay.visible ${selector}`);
    }
  });
});
