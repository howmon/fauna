// Window context routes — Codex-style "what apps are open / arrange them"
// surfaces backed by server/lib/mac-window-context.js. macOS-only; on
// Windows the endpoints return an explicit ok:false so callers can skip.

import { listVisibleWindows, arrangeWindows, getScreenBounds } from '../lib/mac-window-context.js';

export function registerWindowContextRoutes(app) {
  // GET /api/window-context — running visible apps with their windows.
  app.get('/api/window-context', async (req, res) => {
    try {
      const [winInfo, screen] = await Promise.all([
        listVisibleWindows(),
        getScreenBounds().catch(() => ({ ok: false })),
      ]);
      res.json({ ...winInfo, screen: screen.ok ? screen : null });
    } catch (e) {
      res.status(500).json({ ok: false, error: e.message });
    }
  });

  // POST /api/window-arrange — apply a list of {app, x, y, w, h, windowIndex?, windowTitle?}
  app.post('/api/window-arrange', async (req, res) => {
    try {
      const moves = Array.isArray(req.body?.moves) ? req.body.moves : [];
      const result = await arrangeWindows(moves);
      res.json(result);
    } catch (e) {
      res.status(500).json({ ok: false, error: e.message });
    }
  });
}
