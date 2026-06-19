// server/routes/genui-share.js
//
// "Share GenUI to browser" — exposes any gen-ui spec at a stable localhost
// URL so the user can open / mirror it in a normal browser tab with the
// same Fauna theme. Updating an existing share id broadcasts to any open
// browser tabs over SSE so the page re-renders live.
//
// Routes
//   POST   /api/genui/share              create or update a share
//                                        body: { spec, title?, id? }
//                                        → { id, url, title }
//   GET    /api/genui/shared             list active shares
//   GET    /api/genui/shared/:id         spec JSON (used by the renderer)
//   PUT    /api/genui/shared/:id         body: { spec, title? } → broadcast
//   DELETE /api/genui/shared/:id         unpublish
//   GET    /api/genui/stream/:id         SSE — push updates to browser tab
//   GET    /genui/:id                    standalone HTML page mounting it
//
// Spec storage is two-layer: an in-process Map (hot path) plus an optional
// JSON snapshot at `<faunaConfigDir>/genui-shares.json` so shares survive
// process restarts. Snapshot writes are debounced and best-effort.

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

export function registerGenUiShareRoutes(app, { faunaConfigDir, port, appDir } = {}) {
  // id -> { spec, title, createdAt, updatedAt, hits }
  const _shares = new Map();
  // id -> Set<express.Response> for live SSE listeners
  const _subscribers = new Map();

  const snapshotPath = faunaConfigDir
    ? path.join(faunaConfigDir, 'genui-shares.json')
    : null;

  // ── persistence ────────────────────────────────────────────────────────
  if (snapshotPath && fs.existsSync(snapshotPath)) {
    try {
      const raw = fs.readFileSync(snapshotPath, 'utf8');
      const items = JSON.parse(raw);
      if (Array.isArray(items)) {
        for (const it of items) {
          if (it && it.id && it.spec) _shares.set(String(it.id), {
            spec: it.spec,
            title: String(it.title || 'Shared UI'),
            createdAt: Number(it.createdAt) || Date.now(),
            updatedAt: Number(it.updatedAt) || Date.now(),
            hits: 0,
          });
        }
      }
    } catch (e) {
      console.warn('[genui-share] failed to load snapshot:', e.message);
    }
  }

  let _saveTimer = null;
  function _scheduleSnapshot() {
    if (!snapshotPath) return;
    if (_saveTimer) return;
    _saveTimer = setTimeout(() => {
      _saveTimer = null;
      try {
        fs.mkdirSync(path.dirname(snapshotPath), { recursive: true });
        const items = Array.from(_shares.entries()).map(([id, v]) => ({
          id, spec: v.spec, title: v.title,
          createdAt: v.createdAt, updatedAt: v.updatedAt,
        }));
        const tmp = snapshotPath + '.tmp';
        fs.writeFileSync(tmp, JSON.stringify(items));
        fs.renameSync(tmp, snapshotPath);
      } catch (e) {
        console.warn('[genui-share] snapshot write failed:', e.message);
      }
    }, 400);
  }

  // ── helpers ────────────────────────────────────────────────────────────
  function _newId() {
    // 8-char hex — short, copy-pasteable, ample collision headroom for
    // this single-user, per-process use case.
    return crypto.randomBytes(4).toString('hex');
  }

  function _validSpec(spec) {
    if (!spec || typeof spec !== 'object') return false;
    // Accept either { root, elements } or a bare { type, props, children }
    // shorthand — the renderer handles both.
    if (spec.root && spec.elements && typeof spec.elements === 'object') return true;
    if (spec.type && typeof spec.type === 'string') return true;
    return false;
  }

  function _safeId(id) {
    return typeof id === 'string' && /^[a-z0-9_-]{1,40}$/i.test(id);
  }

  function _shareUrl(req, id) {
    // Honour the listening port; client-supplied Host headers may already
    // include the port so prefer those, falling back to the port we were
    // started with.
    const host = req.headers.host || ('localhost:' + (port || 3737));
    const proto = req.headers['x-forwarded-proto'] || 'http';
    return `${proto}://${host}/genui/${id}`;
  }

  function _broadcast(id, payload) {
    const subs = _subscribers.get(id);
    if (!subs) return;
    const data = 'data: ' + JSON.stringify(payload) + '\n\n';
    for (const res of subs) {
      try { res.write(data); } catch (_) { /* dead socket */ }
    }
  }

  // ── routes ─────────────────────────────────────────────────────────────
  // Create OR update (idempotent when id is supplied — lets the renderer
  // overwrite a share in place so the open browser tab refreshes).
  app.post('/api/genui/share', (req, res) => {
    try {
      const body = req.body || {};
      if (!_validSpec(body.spec)) {
        return res.status(400).json({ error: 'spec is required and must be a gen-ui object ({root,elements} or {type,...})' });
      }
      let id = body.id != null ? String(body.id) : '';
      if (id && !_safeId(id)) {
        return res.status(400).json({ error: 'id must be alphanumeric / underscore / hyphen, 1-40 chars' });
      }
      if (!id) id = _newId();
      const now = Date.now();
      const existing = _shares.get(id);
      const title = (body.title && String(body.title).trim()) || (existing && existing.title) || 'Shared UI';
      _shares.set(id, {
        spec: body.spec,
        title,
        createdAt: existing ? existing.createdAt : now,
        updatedAt: now,
        hits: existing ? existing.hits : 0,
      });
      _scheduleSnapshot();
      _broadcast(id, { kind: 'update', spec: body.spec, title, updatedAt: now });
      res.status(existing ? 200 : 201).json({
        id, title, url: _shareUrl(req, id),
        updatedAt: now, created: !existing,
      });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  app.get('/api/genui/shared', (req, res) => {
    const items = Array.from(_shares.entries())
      .map(([id, v]) => ({
        id, title: v.title, createdAt: v.createdAt, updatedAt: v.updatedAt,
        hits: v.hits, url: _shareUrl(req, id),
      }))
      .sort((a, b) => b.updatedAt - a.updatedAt);
    res.json({ ok: true, shares: items });
  });

  app.get('/api/genui/shared/:id', (req, res) => {
    const v = _shares.get(req.params.id);
    if (!v) return res.status(404).json({ error: 'share not found' });
    v.hits++;
    res.json({
      id: req.params.id, spec: v.spec, title: v.title,
      createdAt: v.createdAt, updatedAt: v.updatedAt,
    });
  });

  app.put('/api/genui/shared/:id', (req, res) => {
    const id = req.params.id;
    const existing = _shares.get(id);
    if (!existing) return res.status(404).json({ error: 'share not found' });
    const body = req.body || {};
    if (!_validSpec(body.spec)) {
      return res.status(400).json({ error: 'spec is required and must be a gen-ui object' });
    }
    const title = (body.title && String(body.title).trim()) || existing.title;
    const now = Date.now();
    _shares.set(id, { ...existing, spec: body.spec, title, updatedAt: now });
    _scheduleSnapshot();
    _broadcast(id, { kind: 'update', spec: body.spec, title, updatedAt: now });
    res.json({ id, title, updatedAt: now, url: _shareUrl(req, id) });
  });

  app.delete('/api/genui/shared/:id', (req, res) => {
    const id = req.params.id;
    const had = _shares.delete(id);
    if (had) {
      _scheduleSnapshot();
      _broadcast(id, { kind: 'deleted' });
      const subs = _subscribers.get(id);
      if (subs) {
        for (const r of subs) { try { r.end(); } catch (_) {} }
        _subscribers.delete(id);
      }
    }
    res.json({ ok: true, deleted: had });
  });

  // ── SSE stream for live updates ────────────────────────────────────────
  // Browser tab opens this, then immediately re-renders when a new spec
  // arrives. Drops on `kind:'deleted'`.
  app.get('/api/genui/stream/:id', (req, res) => {
    const id = req.params.id;
    if (!_shares.has(id)) return res.status(404).end();
    res.set({
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    res.flushHeaders?.();
    res.write(': connected\n\n');

    if (!_subscribers.has(id)) _subscribers.set(id, new Set());
    _subscribers.get(id).add(res);

    // Heartbeat every 25s so proxies / browser idle timers don't close us.
    const hb = setInterval(() => {
      try { res.write(': hb\n\n'); } catch (_) { /* swallow */ }
    }, 25000);

    req.on('close', () => {
      clearInterval(hb);
      const subs = _subscribers.get(id);
      if (subs) {
        subs.delete(res);
        if (!subs.size) _subscribers.delete(id);
      }
    });
  });

  // ── Standalone renderer page ───────────────────────────────────────────
  // Serves the public/genui-share.html file with `?id=<id>` so the static
  // page can self-hydrate. We do not template the spec into the HTML —
  // the page fetches /api/genui/shared/:id, which keeps caching predictable
  // and lets the page recover when the spec is updated.
  app.get('/genui/:id', (req, res) => {
    if (!_shares.has(req.params.id)) {
      res.status(404).send('<h1>Shared UI not found</h1><p>This share may have expired or been removed.</p>');
      return;
    }
    const base = appDir || process.cwd();
    res.sendFile(path.join(base, 'public', 'genui-share.html'), (err) => {
      if (err) res.status(500).end();
    });
  });

  // ── Test hooks ─────────────────────────────────────────────────────────
  // Exposed for unit tests; not part of the public API.
  return {
    _shares,
    _subscribers,
    _scheduleSnapshot,
  };
}
