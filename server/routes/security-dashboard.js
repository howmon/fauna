import fs from 'fs';
import path from 'path';
import { computePermissions } from './permissions.js';
import { listSecurityEvents } from '../lib/security-events.js';

function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (_) { return fallback; }
}

export function registerSecurityDashboardRoutes(app, {
  appDir,
  isWin,
  getGhToken,
  getSystemPreferences,
  getBrowseStatus,
  getFigmaStatus,
  getCustomMcpStatus,
  getPlaywrightMcpStatus,
} = {}) {
  app.get('/api/security/status', async (req, res) => {
    const capabilitiesPath = path.join(appDir || process.cwd(), 'server', 'generated', 'capabilities.json');
    const capabilities = readJson(capabilitiesPath, { count: 0, byCategory: {}, tools: [] });
    const permissions = computePermissions({
      isWin: !!isWin,
      getGhToken: getGhToken || (() => null),
      systemPreferences: getSystemPreferences ? getSystemPreferences() : null,
    });

    let browser = null;
    try { browser = getBrowseStatus ? getBrowseStatus() : null; } catch (e) { browser = { ok: false, error: e.message }; }

    let figma = null;
    try { figma = getFigmaStatus ? getFigmaStatus() : null; } catch (e) { figma = { ok: false, error: e.message }; }

    let customMcp = null;
    try { customMcp = getCustomMcpStatus ? getCustomMcpStatus() : null; } catch (e) { customMcp = { ok: false, error: e.message }; }

    let playwrightMcp = null;
    try { playwrightMcp = getPlaywrightMcpStatus ? await getPlaywrightMcpStatus() : null; } catch (e) { playwrightMcp = { ok: false, error: e.message }; }

    res.json({
      ok: true,
      generatedAt: new Date().toISOString(),
      surfaces: {
        localServer: { enabled: true, port: Number(process.env.PORT || 3737), uiNonce: !!process.env.FAUNA_UI_NONCE },
        browser,
        figma,
        customMcp,
        playwrightMcp,
        teams: { enabled: !!process.env.FAUNA_TEAMS_SECRET },
        mobileTunnel: { packageAvailable: true, active: false, note: 'active tunnel state is owned by mobile routes' },
      },
      permissions,
      capabilities: {
        count: capabilities.count || 0,
        byCategory: capabilities.byCategory || {},
        generatedAt: capabilities.generatedAt || null,
      },
      recentEvents: listSecurityEvents({ limit: Number(req.query.limit) || 50 }),
    });
  });
}
