import { describe, expect, it } from 'vitest';
import { projectCapabilities } from '../server/lib/capability-projection.js';

describe('capability projection', () => {
  it('fails closed when the model cannot call tools', () => {
    const snapshot = projectCapabilities({
      model: { tools: false, streaming: true },
      projectPermissions: { shell: true, browser: true },
      requested: { browser: true },
      runtime: { browser: true },
    });
    expect(snapshot.capabilities.tools).toMatchObject({ enabled: false, reason: 'model-does-not-support-tools' });
    expect(snapshot.capabilities.shell.reason).toBe('tools-disabled');
    expect(snapshot.capabilities.browser.reason).toBe('tools-disabled');
  });

  it('combines requests, permissions, runtime state, and the final tool catalog', () => {
    const snapshot = projectCapabilities({
      model: { tools: true, streaming: true },
      projectPermissions: { shell: false, browser: true, fileRead: ['/repo'], fileWrite: [] },
      requested: { browser: true, figma: false, mcp: true },
      runtime: { browser: true, figma: true, mcp: true },
      tools: [{ function: { name: 'z_tool' } }, { function: { name: 'a_tool' } }, { function: { name: 'a_tool' } }],
    });
    expect(snapshot.capabilities.browser.enabled).toBe(true);
    expect(snapshot.capabilities.shell.reason).toBe('permission-denied');
    expect(snapshot.capabilities.fileWrite.reason).toBe('no-writable-paths');
    expect(snapshot.capabilities.figma.reason).toBe('not-requested');
    expect(snapshot.toolNames).toEqual(['a_tool', 'z_tool']);
  });
});
