// ── Sync REST routes — bridge the Electron renderer to the sync engine ─────
//
// Surfaces a small REST shape on top of agentstore-client + sync-engine so
// the renderer (and CLI / tests) can:
//
//   GET  /api/sync/session                  → { baseUrl, user, loggedIn }
//   POST /api/sync/login    { email, pwd }  → { ok, user, error? }
//   POST /api/sync/logout                   → { ok }
//   GET  /api/sync/status                   → engine.getStatus()
//   POST /api/sync/start                    → start engine + return status
//   POST /api/sync/stop                     → stop engine + return status
//   POST /api/sync/now                      → force immediate pull+push
//
// The actual data movement (PUT /api/sync/objects/…) goes directly from the
// engine to the agentstore backend — these routes are management-plane only.

import * as agentstore from '../lib/agentstore-client.js';
import * as syncEngine from '../lib/sync-engine.js';
import * as syncAdapters from '../lib/sync-adapters.js';

export function registerSyncRoutes(app, deps = {}) {
  const { conversationStore, projectManager } = deps;

  // Install adapters once. Safe to call before login — adapters are passive
  // until enqueueChange() fires, and enqueueChange is a no-op while the
  // engine isn't running.
  let _adaptersInstalled = false;
  function _ensureAdapters() {
    if (_adaptersInstalled) return;
    syncAdapters.installAllAdapters({
      conversationStore,
      projectManager,
    });
    _adaptersInstalled = true;
  }

  // If a token was already on disk from a prior session, auto-start the
  // engine. This makes Fauna Cloud "just work" across app restarts.
  (async () => {
    try {
      _ensureAdapters();
      const session = agentstore.getSession();
      if (session.loggedIn) {
        await syncEngine.start();
        console.log('[sync] auto-started for', session.user?.email || '(unknown)');
      }
    } catch (e) {
      console.warn('[sync] auto-start failed:', e?.message || e);
    }
  })();

  app.get('/api/sync/session', (_req, res) => {
    res.json(agentstore.getSession());
  });

  app.post('/api/sync/login', async (req, res) => {
    const { email, password, baseUrl } = req.body || {};
    try {
      const r = await agentstore.login({ email, password, baseUrl });
      if (!r.ok) return res.status(401).json(r);
      _ensureAdapters();
      try { await syncEngine.start(); } catch (_) { /* will retry on next call */ }
      res.json({ ok: true, user: r.user, status: syncEngine.getStatus() });
    } catch (e) {
      res.status(500).json({ ok: false, error: e.message });
    }
  });

  app.post('/api/sync/logout', async (_req, res) => {
    try { await syncEngine.stop(); } catch (_) {}
    try { await agentstore.logout(); } catch (_) {}
    res.json({ ok: true });
  });

  app.get('/api/sync/status', (_req, res) => {
    res.json(syncEngine.getStatus());
  });

  app.post('/api/sync/start', async (_req, res) => {
    if (!agentstore.getSession().loggedIn) {
      return res.status(401).json({ error: 'Not logged in' });
    }
    try {
      _ensureAdapters();
      const status = await syncEngine.start();
      res.json(status);
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  app.post('/api/sync/stop', async (_req, res) => {
    try { await syncEngine.stop(); res.json(syncEngine.getStatus()); }
    catch (e) { res.status(500).json({ error: e.message }); }
  });

  app.post('/api/sync/now', async (_req, res) => {
    try {
      const status = await syncEngine.syncNow();
      res.json(status);
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  // Profile refresh — useful after a server-side rename / email change.
  app.post('/api/sync/refresh-profile', async (_req, res) => {
    const r = await agentstore.refreshProfile();
    res.status(r.ok ? 200 : 401).json(r);
  });
}
