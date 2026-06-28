import { describe, expect, it, vi } from 'vitest';
import { registerSecurityDashboardRoutes } from '../server/routes/security-dashboard.js';

describe('security dashboard diagnostics', () => {
  it('includes browser and custom MCP diagnostics in active surfaces', async () => {
    const routes = new Map();
    const app = { get: vi.fn((path, handler) => routes.set(path, handler)) };
    registerSecurityDashboardRoutes(app, {
      appDir: process.cwd(),
      getGhToken: () => null,
      getSystemPreferences: () => null,
      getBrowseStatus: () => ({ ok: true, browser: { connected: false } }),
      getBrowseDiagnostics: () => ({ ok: true, schemaVersion: 1, diagnostics: { tabCount: 0 } }),
      getCustomMcpStatus: () => ({ connected: false }),
      getCustomMcpDiagnostics: async () => ({ ok: true, schemaVersion: 1, counts: { total: 1, needsAuth: 1 } }),
      getProcessDiagnostics: () => ({ pid: 123, memory: { rssMb: 250 }, highWater: { rssMb: 250 } }),
    });

    let payload = null;
    await routes.get('/api/security/status')({ query: { limit: '5' } }, { json: body => { payload = body; } });

    expect(payload.ok).toBe(true);
    expect(payload.surfaces.browserDiagnostics).toMatchObject({ ok: true, schemaVersion: 1 });
    expect(payload.surfaces.customMcpDiagnostics).toMatchObject({ ok: true, schemaVersion: 1 });
    expect(payload.surfaces.customMcpDiagnostics.counts.needsAuth).toBe(1);
    expect(payload.surfaces.process).toMatchObject({ pid: 123, memory: { rssMb: 250 } });
  });
});
