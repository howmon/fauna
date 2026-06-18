// ── Sync REST routes — bridge the Electron renderer to the sync engine ─────
//
// Surfaces a small REST shape on top of agentstore-client + sync-engine so
// the renderer (and CLI / tests) can:
//
//   GET  /api/sync/session                  → { baseUrl, user, loggedIn }
//   POST /api/sync/login    { email, pwd }  → { ok, user, error? }
//   POST /api/sync/adopt-token { token }    → { ok, user, error? }
//   POST /api/sync/logout                   → { ok }
//   GET  /api/sync/status                   → engine.getStatus()
//   POST /api/sync/start                    → start engine + return status
//   POST /api/sync/stop                     → stop engine + return status
//   POST /api/sync/now                      → force immediate pull+push
//   POST /api/sync/backfill                 → re-enqueue all existing local records
//   GET  /api/sync/events                   → SSE stream of engine apply/pull/push events
//   GET  /api/sync/prefs                    → { excludedProjects: [...] }
//   POST /api/sync/prefs    { excludedProjects } → { ok, prefs }
//   GET  /api/sync/projects                 → [{ id, name, excluded, pending }]
//   POST /api/sync/projects/:id/exclude { excluded } → { ok, prefs }
//   GET  /api/sync/checkpoints?projectId=X  → [{ id, deviceId, number, title, …, isLocal }]
//
// The actual data movement (PUT /api/sync/objects/…) goes directly from the
// engine to the agentstore backend — these routes are management-plane only.

import * as agentstore from '../lib/agentstore-client.js';
import * as syncEngine from '../lib/sync-engine.js';
import * as syncAdapters from '../lib/sync-adapters.js';
import * as syncPrefs from '../lib/sync-prefs.js';
import * as syncCheckpoints from '../lib/sync-checkpoint-adapter.js';

// Module-singleton SSE client set + one-time engine emitter wiring so the
// /api/sync/events broadcasts every interesting engine event without each
// handler re-subscribing. Safe to import the module repeatedly — the
// subscription block below only runs once per process.
const _syncSseClients = new Set();
function _broadcastSyncEvent(type, payload = {}) {
  if (_syncSseClients.size === 0) return;
  const data = JSON.stringify({ type, ...payload, ts: Date.now() });
  for (const c of _syncSseClients) {
    try { c.write(`data: ${data}\n\n`); } catch (_) {}
  }
}
syncEngine.events.on('apply',     (e) => _broadcastSyncEvent('apply', e));
syncEngine.events.on('pull:end',  (e) => _broadcastSyncEvent('pull:end', e));
syncEngine.events.on('push:end',  (e) => _broadcastSyncEvent('push:end', e));
syncEngine.events.on('bootstrap', (e) => _broadcastSyncEvent('bootstrap', e));
syncEngine.events.on('locked',    (e) => _broadcastSyncEvent('locked', e));
syncEngine.events.on('unlocked',  (e) => _broadcastSyncEvent('unlocked', e));
syncEngine.events.on('password-changed', (e) => _broadcastSyncEvent('password-changed', e));

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

  // Adopt a bearer token that was issued via another in-app sign-in flow
  // (e.g. the Agent Store sign-in dialog). Lets the Cloud Sync feature
  // reuse the existing session instead of asking the user to sign in twice
  // against the same backend. Body: { token, baseUrl?, user? }.
  app.post('/api/sync/adopt-token', async (req, res) => {
    const { token, baseUrl, user } = req.body || {};
    if (!token || typeof token !== 'string') {
      return res.status(400).json({ ok: false, error: 'token is required' });
    }
    try {
      const r = await agentstore.adoptToken({ token, baseUrl, user });
      if (!r.ok) return res.status(r.status === 401 ? 401 : 400).json(r);
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

  // Force a full re-backfill of every namespace. Resets the per-namespace
  // bootstrap markers and re-enqueues every existing local record. Used
  // when the user wants to seed a fresh device or replay all data after a
  // server-side wipe.
  app.post('/api/sync/backfill', async (_req, res) => {
    try {
      const status = await syncEngine.forceBackfill();
      res.json(status);
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  // ── E2E (end-to-end encryption) management ──
  //
  // The sync engine refuses to push plaintext or apply encrypted pulls
  // until a key is derived from the user's password. The login flow
  // unlocks automatically; for adopt-token sign-ins the renderer prompts
  // the user and POSTs here.
  app.post('/api/sync/unlock', async (req, res) => {
    const { password } = req.body || {};
    if (!password || typeof password !== 'string') {
      return res.status(400).json({ ok: false, error: 'password required' });
    }
    try {
      const r = await syncEngine.unlockE2E({ password });
      if (!r.ok) return res.status(401).json(r);
      res.json({ ok: true, firstDevice: !!r.firstDevice, status: syncEngine.getStatus() });
    } catch (e) {
      res.status(502).json({ ok: false, error: e.message || 'unlock failed' });
    }
  });

  // Wipe the cached E2E key from this device. Sync stays running but is
  // locked; the user has to re-enter the password to push or pull again.
  app.post('/api/sync/lock', (_req, res) => {
    try {
      syncEngine.lockE2E();
      res.json({ ok: true, status: syncEngine.getStatus() });
    } catch (e) {
      res.status(500).json({ ok: false, error: e.message });
    }
  });

  // Change the user's password (atomic: account hash + wrappedMk rotate
  // in one backend transaction). Body: { oldPassword, newPassword }.
  // Engine must be unlocked first — we need the cached MK to rewrap.
  app.post('/api/sync/change-password', async (req, res) => {
    const { oldPassword, newPassword } = req.body || {};
    if (!oldPassword || !newPassword) {
      return res.status(400).json({ ok: false, error: 'oldPassword and newPassword required' });
    }
    try {
      const r = await syncEngine.changePassword({ oldPassword, newPassword });
      if (!r.ok) return res.status(r.status === 401 ? 401 : 400).json(r);
      res.json({ ok: true });
    } catch (e) {
      res.status(502).json({ ok: false, error: e.message || 'change-password failed' });
    }
  });

  // Live event stream — pushes engine events to the renderer so the UI can
  // auto-refresh when a pull lands or a push completes. Without this, the
  // All Projects overlay and conversation list only re-load on manual
  // navigation, so cross-device updates appear stale.
  //
  // Event payloads (one per `data: …\n\n`):
  //   { type: 'ready' }
  //   { type: 'apply',     ns, id, deleted }   — a remote change was applied locally
  //   { type: 'pull:end',  applied: {ns: n} }  — a full pull cycle finished
  //   { type: 'push:end',  pending, pushed }   — a push batch drained
  //   { type: 'bootstrap', ns, count }         — first-run backfill enqueued
  app.get('/api/sync/events', (req, res) => {
    const _o = req.headers.origin;
    if (_o && /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(_o)) {
      res.setHeader('Access-Control-Allow-Origin', _o);
      res.setHeader('Vary', 'Origin');
    }
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders?.();
    res.write(`data: ${JSON.stringify({ type: 'ready', ts: Date.now() })}\n\n`);
    _syncSseClients.add(res);
    const keepalive = setInterval(() => {
      try { res.write(`: keepalive ${Date.now()}\n\n`); } catch (_) {}
    }, 25000);
    req.on('close', () => {
      clearInterval(keepalive);
      _syncSseClients.delete(res);
    });
  });

  // Profile refresh — useful after a server-side rename / email change.
  app.post('/api/sync/refresh-profile', async (_req, res) => {
    const r = await agentstore.refreshProfile();
    res.status(r.ok ? 200 : 401).json(r);
  });

  // ── Per-device sync preferences ────────────────────────────────────
  // Track which projects this device wants to keep local-only. Stored in
  // ~/.config/fauna/sync/prefs.json (see server/lib/sync-prefs.js). The
  // list is NOT synced — "exclude this big project from MY laptop" is the
  // common case.
  app.get('/api/sync/prefs', (_req, res) => {
    res.json(syncPrefs.getPrefs());
  });

  app.post('/api/sync/prefs', async (req, res) => {
    const { excludedProjects } = req.body || {};
    if (!Array.isArray(excludedProjects)) {
      return res.status(400).json({ ok: false, error: 'excludedProjects must be an array' });
    }
    try {
      const prefs = await syncPrefs.setExcludedProjects(excludedProjects);
      res.json({ ok: true, prefs });
    } catch (e) {
      res.status(500).json({ ok: false, error: e.message });
    }
  });

  app.post('/api/sync/projects/:id/exclude', async (req, res) => {
    const id = req.params.id;
    const excluded = !!(req.body && req.body.excluded);
    if (!id) return res.status(400).json({ ok: false, error: 'project id required' });
    try {
      const prefs = await syncPrefs.setProjectExcluded(id, excluded);
      res.json({ ok: true, prefs, status: syncEngine.getStatus() });
    } catch (e) {
      res.status(500).json({ ok: false, error: e.message });
    }
  });

  // Project list joined with pending-push counts + excluded flag, so the
  // Cloud Sync UI can render per-project rows in a single call.
  app.get('/api/sync/projects', (_req, res) => {
    try {
      const status = syncEngine.getStatus();
      const byProject = status.pendingByProject || {};
      const excluded = new Set(status.excludedProjects || []);
      let projects = [];
      if (projectManager && typeof projectManager.listProjects === 'function') {
        projects = projectManager.listProjects() || [];
      } else if (projectManager && typeof projectManager.getAllProjects === 'function') {
        projects = projectManager.getAllProjects() || [];
      }
      const rows = projects.map(p => ({
        id: p.id,
        name: p.name || p.id,
        icon: p.icon || null,
        color: p.color || null,
        excluded: excluded.has(p.id),
        pending: byProject[p.id] || 0,
      }));
      // Pending changes that don't map to any current project (orphans).
      const orphan = byProject._unassigned || 0;
      res.json({ projects: rows, unassignedPending: orphan });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  // List a project's checkpoints — local plus archived copies from any
  // other device this user has signed in on. Cross-device entries carry
  // `isLocal: false` so the UI can grey-out the Restore button.
  app.get('/api/sync/checkpoints', async (req, res) => {
    const projectId = String(req.query.projectId || '');
    if (!projectId) return res.status(400).json({ error: 'projectId required' });
    try {
      const checkpoints = await syncCheckpoints.listAllForProject(projectId);
      res.json({ projectId, checkpoints });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });
}
