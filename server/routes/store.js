// server/routes/store.js
//
// All /api/store/* routes — proxies for the agent store backend
// (browse/install/publish/admin/notifications) and cross-device draft sync.
// Single source of truth for storeProxy() and parseMultipart().
//
// Factory: registerStoreRoutes(app, deps)
//
// Deps:
//   - express              : the express module (for express.json() middleware)
//   - agentsDir            : absolute path to installed-agents directory
//   - storeBackendUrl      : base URL for agent store backend
//   - builtinAgentNames    : array of reserved agent slugs to skip in pull

import fs from 'fs';
import os from 'os';
import path from 'path';
import { execSync } from 'child_process';

export function registerStoreRoutes(app, {
  express,
  agentsDir,
  storeBackendUrl,
  builtinAgentNames = [],
}) {
  // ── Generic proxy to the store backend ──────────────────────────────────
  async function storeProxy(req, res, method, backendPath, body) {
    const url = storeBackendUrl + backendPath;
    const headers = { 'Accept': 'application/json' };
    if (req.headers['authorization']) headers['Authorization'] = req.headers['authorization'];

    const opts = { method, headers };
    if (body instanceof Buffer || body instanceof Uint8Array) {
      headers['Content-Type'] = req.headers['content-type'];
      opts.body = body;
    } else if (body) {
      headers['Content-Type'] = 'application/json';
      opts.body = JSON.stringify(body);
    }

    try {
      const upstream = await fetch(url, opts);
      const ct = upstream.headers.get('content-type') || '';
      const status = upstream.status;
      if (status >= 400) {
        console.error('[storeProxy] %s %s → %d', method, backendPath, status);
      }
      if (ct.includes('json')) {
        const data = await upstream.json();
        return res.status(status).json(data);
      }
      // Binary (zip download)
      const buf = Buffer.from(await upstream.arrayBuffer());
      for (const h of ['content-type', 'content-disposition']) {
        const v = upstream.headers.get(h);
        if (v) res.set(h, v);
      }
      return res.status(status).send(buf);
    } catch (e) {
      res.status(502).json({ error: 'Store backend unavailable: ' + e.message });
    }
  }

  // ── Cross-device sync helpers ───────────────────────────────────────────
  let _archiverMod = null;
  async function _archiver() {
    if (!_archiverMod) _archiverMod = (await import('archiver')).default;
    return _archiverMod;
  }

  function _syncLocalUpdatedAt(name) {
    const dir = path.join(agentsDir, name);
    if (!fs.existsSync(dir)) return 0;
    try {
      const metaPath = path.join(dir, '.meta.json');
      if (fs.existsSync(metaPath)) {
        const m = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
        if (m.updatedAt) return Number(m.updatedAt) || 0;
      }
    } catch (_) {}
    try {
      let max = 0;
      const walk = (p) => {
        for (const item of fs.readdirSync(p)) {
          const full = path.join(p, item);
          const st = fs.statSync(full);
          if (st.isDirectory()) walk(full);
          else if (st.mtimeMs > max) max = st.mtimeMs;
        }
      };
      walk(dir);
      return Math.floor(max);
    } catch (_) { return 0; }
  }

  function _syncStampUpdatedAt(name, ts) {
    const dir = path.join(agentsDir, name);
    if (!fs.existsSync(dir)) return;
    const metaPath = path.join(dir, '.meta.json');
    let meta = {};
    try { meta = JSON.parse(fs.readFileSync(metaPath, 'utf8')); } catch (_) {}
    meta.updatedAt = ts;
    try { fs.writeFileSync(metaPath, JSON.stringify(meta, null, 2)); } catch (_) {}
  }

  async function _syncZipAgentDir(name) {
    const dir = path.join(agentsDir, name);
    if (!fs.existsSync(path.join(dir, 'agent.json'))) {
      throw new Error('Agent not found: ' + name);
    }
    const archiver = await _archiver();
    return await new Promise((resolve, reject) => {
      const a = archiver('zip', { zlib: { level: 6 } });
      const chunks = [];
      a.on('data', c => chunks.push(c));
      a.on('end', () => resolve(Buffer.concat(chunks)));
      a.on('error', reject);
      a.directory(dir, false);
      a.finalize();
    });
  }

  // ── Multipart parser for /publish ───────────────────────────────────────
  function parseMultipart(buffer, boundary) {
    const sep = Buffer.from('--' + boundary);
    const parts = [];
    let start = 0;
    while (true) {
      const idx = buffer.indexOf(sep, start);
      if (idx === -1) break;
      if (start > 0) parts.push(buffer.slice(start, idx));
      start = idx + sep.length;
      if (buffer[start] === 0x0d && buffer[start + 1] === 0x0a) start += 2;
    }

    const fields = {};
    let fileBuffer = null;
    let fileName = null;

    for (const part of parts) {
      const headerEnd = part.indexOf('\r\n\r\n');
      if (headerEnd === -1) continue;
      const headerStr = part.slice(0, headerEnd).toString('utf-8');
      const body = part.slice(headerEnd + 4);
      const trimmed = (body.length >= 2 && body[body.length - 2] === 0x0d && body[body.length - 1] === 0x0a)
        ? body.slice(0, body.length - 2)
        : body;

      const nameMatch = headerStr.match(/name="([^"]+)"/);
      const fileMatch = headerStr.match(/filename="([^"]+)"/);
      if (!nameMatch) continue;

      if (fileMatch) {
        fileBuffer = trimmed;
        fileName = fileMatch[1];
      } else {
        fields[nameMatch[1]] = trimmed.toString('utf-8');
      }
    }

    return { fields, fileBuffer, fileName };
  }

  // ── Routes ──────────────────────────────────────────────────────────────

  // Auth/me — used by the store sign-in UI
  app.get('/api/store/auth/me', (req, res) => {
    storeProxy(req, res, 'GET', '/auth/me');
  });

  // Browse / search
  app.get('/api/store/agents', (req, res) => {
    const qs = new URLSearchParams(req.query).toString();
    storeProxy(req, res, 'GET', '/agents' + (qs ? '?' + qs : ''));
  });

  // Proxy zip download (streams directly from backend) — must be before :slug catch-all
  app.get('/api/store/agents/:slug/zip', async (req, res) => {
    const slug = req.params.slug.replace(/[^a-zA-Z0-9_-]/g, '');
    try {
      const token = req.headers.authorization || '';
      const zipRes = await fetch(storeBackendUrl + '/agents/' + slug + '/download', {
        method: 'POST',
        headers: {
          'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
          'Content-Type': 'application/x-www-form-urlencoded',
          ...(token ? { 'Authorization': token } : {})
        },
        body: ''
      });
      if (!zipRes.ok) {
        const text = await zipRes.text();
        return res.status(zipRes.status).json({ error: 'Download failed: ' + text });
      }
      const buf = Buffer.from(await zipRes.arrayBuffer());
      res.set('Content-Type', 'application/zip');
      res.set('Content-Disposition', 'attachment; filename="' + slug + '.zip"');
      res.send(buf);
    } catch (e) {
      res.status(502).json({ error: 'Zip proxy failed: ' + e.message });
    }
  });

  // Install
  app.post('/api/store/agents/:slug/install', (req, res) => {
    const slug = req.params.slug.replace(/[^a-zA-Z0-9_-]/g, '');
    storeProxy(req, res, 'POST', '/agents/' + slug + '/download');
  });

  // Agent detail — try local installed agent first, fall back to store proxy
  app.get('/api/store/agents/:slug', async (req, res) => {
    const slug = req.params.slug.replace(/[^a-zA-Z0-9_-]/g, '');

    const localAgentDir = path.join(agentsDir, slug);
    const localManifest = path.join(localAgentDir, 'agent.json');
    if (fs.existsSync(localManifest)) {
      try {
        const manifest = JSON.parse(fs.readFileSync(localManifest, 'utf8'));
        let meta = {};
        try { meta = JSON.parse(fs.readFileSync(path.join(localAgentDir, '.meta.json'), 'utf8')); } catch (_) {}
        return res.json({
          slug: manifest.name || slug,
          name: manifest.name || slug,
          displayName: manifest.displayName || manifest.name || slug,
          description: manifest.description || '',
          category: manifest.category || 'general',
          icon: manifest.icon || 'ti-robot',
          version: manifest.version || meta.storeVersion || '1.0',
          scanScore: manifest.scanScore ?? 90,
          author: manifest.author || meta.installedBy || '',
          installedAt: meta.installedAt || null,
          permissions: manifest.permissions || {},
          _source: 'local',
        });
      } catch (_) {}
    }

    storeProxy(req, res, 'GET', '/agents/' + slug);
  });

  // Agent ownership check
  app.get('/api/store/agents/:slug/ownership', (req, res) => {
    const slug = req.params.slug.replace(/[^a-zA-Z0-9_-]/g, '');
    if (!req.headers.authorization) return res.json({ owned: false, isAdmin: false });
    storeProxy(req, res, 'GET', '/agents/' + slug + '/ownership');
  });

  // Update agent metadata (owner or admin only)
  app.put('/api/store/agents/:slug', express.json(), (req, res) => {
    const slug = req.params.slug.replace(/[^a-zA-Z0-9_-]/g, '');
    storeProxy(req, res, 'PUT', '/agents/' + slug, req.body);
  });

  // ── Cross-Device Sync — Private Drafts ────────────────────────────────
  app.post('/api/store/sync/push/:name', async (req, res) => {
    const auth = req.headers['authorization'];
    if (!auth) return res.status(401).json({ error: 'Sign in to the store first' });
    const name = req.params.name.replace(/[^a-zA-Z0-9_-]/g, '');
    try {
      const updatedAt = Date.now();
      _syncStampUpdatedAt(name, updatedAt);
      const zip = await _syncZipAgentDir(name);
      const upstream = await fetch(storeBackendUrl + '/drafts/' + encodeURIComponent(name), {
        method: 'PUT',
        headers: {
          Authorization: auth,
          'Content-Type': 'application/zip',
          'X-Updated-At': String(updatedAt),
        },
        body: zip,
      });
      const status = upstream.status;
      let body = null;
      try { body = await upstream.json(); } catch (_) { body = { ok: status < 400 }; }
      if (status >= 400) return res.status(status).json(body);
      res.json({ ok: true, updatedAt, size: zip.length });
    } catch (e) {
      res.status(500).json({ error: 'Sync push failed: ' + e.message });
    }
  });

  app.delete('/api/store/sync/:name', async (req, res) => {
    const auth = req.headers['authorization'];
    if (!auth) return res.status(401).json({ error: 'Sign in to the store first' });
    const name = req.params.name.replace(/[^a-zA-Z0-9_-]/g, '');
    try {
      const upstream = await fetch(storeBackendUrl + '/drafts/' + encodeURIComponent(name), {
        method: 'DELETE',
        headers: { Authorization: auth },
      });
      const status = upstream.status;
      let body = null;
      try { body = await upstream.json(); } catch (_) { body = { ok: status < 400 }; }
      res.status(status).json(body);
    } catch (e) {
      res.status(502).json({ error: 'Sync delete failed: ' + e.message });
    }
  });

  app.get('/api/store/sync', async (req, res) => {
    const auth = req.headers['authorization'];
    if (!auth) return res.status(401).json({ error: 'Sign in to the store first' });
    try {
      const upstream = await fetch(storeBackendUrl + '/drafts', {
        headers: { Authorization: auth, Accept: 'application/json' },
      });
      const status = upstream.status;
      const data = await upstream.json().catch(() => ({}));
      res.status(status).json(data);
    } catch (e) {
      res.status(502).json({ error: 'Sync list failed: ' + e.message });
    }
  });

  app.post('/api/store/sync/pull', async (req, res) => {
    const auth = req.headers['authorization'];
    if (!auth) return res.status(401).json({ error: 'Sign in to the store first' });
    try {
      const idxRes = await fetch(storeBackendUrl + '/drafts', {
        headers: { Authorization: auth, Accept: 'application/json' },
      });
      if (!idxRes.ok) {
        // 404 from the upstream means the store backend doesn't expose
        // cross-device draft sync. Treat that as "nothing to pull" rather
        // than surfacing a noisy 404 to the renderer console.
        if (idxRes.status === 404) {
          return res.json({ pulled: [], skipped: [], failed: [], note: 'sync-not-deployed' });
        }
        const text = await idxRes.text();
        return res.status(idxRes.status).json({ error: 'List failed: ' + text });
      }
      const idx = await idxRes.json();
      const drafts = Array.isArray(idx.drafts) ? idx.drafts : [];
      const report = { pulled: [], skipped: [], failed: [] };

      for (const d of drafts) {
        const slug = String(d.slug || '').replace(/[^a-zA-Z0-9_-]/g, '');
        if (!slug) { report.failed.push({ slug: d.slug, reason: 'invalid slug' }); continue; }
        if (builtinAgentNames.includes(slug.toLowerCase())) {
          report.skipped.push({ slug, reason: 'builtin name' });
          continue;
        }
        const remoteUpdated = Number(d.updatedAt) || 0;
        const localUpdated = _syncLocalUpdatedAt(slug);
        if (remoteUpdated > 0 && localUpdated >= remoteUpdated) {
          report.skipped.push({ slug, reason: 'local newer or equal', localUpdated, remoteUpdated });
          continue;
        }
        const tmp = path.join(os.tmpdir(), 'agent-sync-pull-' + Date.now() + '-' + slug);
        try {
          const zipRes = await fetch(storeBackendUrl + '/drafts/' + encodeURIComponent(slug), {
            headers: { Authorization: auth },
          });
          if (!zipRes.ok) { report.failed.push({ slug, reason: 'fetch ' + zipRes.status }); continue; }
          const buf = Buffer.from(await zipRes.arrayBuffer());
          fs.mkdirSync(tmp, { recursive: true });
          const zipPath = path.join(tmp, 'agent.zip');
          fs.writeFileSync(zipPath, buf);
          execSync(`unzip -o -q "${zipPath}" -d "${tmp}/extracted"`, { timeout: 30000 });
          const extracted = path.join(tmp, 'extracted');
          let agentRoot = extracted;
          if (!fs.existsSync(path.join(extracted, 'agent.json'))) {
            const dirs = fs.readdirSync(extracted).filter(x => fs.statSync(path.join(extracted, x)).isDirectory());
            for (const x of dirs) {
              if (fs.existsSync(path.join(extracted, x, 'agent.json'))) { agentRoot = path.join(extracted, x); break; }
            }
          }
          if (!fs.existsSync(path.join(agentRoot, 'agent.json'))) {
            report.failed.push({ slug, reason: 'no agent.json in zip' });
            continue;
          }
          const destDir = path.join(agentsDir, slug);
          if (fs.existsSync(destDir)) fs.rmSync(destDir, { recursive: true, force: true });
          fs.mkdirSync(destDir, { recursive: true });
          const copyRecursive = (src, dst) => {
            for (const item of fs.readdirSync(src)) {
              const s = path.join(src, item);
              const dd = path.join(dst, item);
              if (fs.statSync(s).isDirectory()) { fs.mkdirSync(dd, { recursive: true }); copyRecursive(s, dd); }
              else fs.copyFileSync(s, dd);
            }
          };
          copyRecursive(agentRoot, destDir);
          _syncStampUpdatedAt(slug, remoteUpdated || Date.now());
          report.pulled.push({ slug, updatedAt: remoteUpdated });
        } catch (e) {
          report.failed.push({ slug, reason: e.message });
        } finally {
          try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (_) {}
        }
      }
      res.json({ ok: true, ...report });
    } catch (e) {
      res.status(502).json({ error: 'Sync pull failed: ' + e.message });
    }
  });

  // Categories
  app.get('/api/store/categories', (req, res) => {
    storeProxy(req, res, 'GET', '/categories');
  });

  // Publish (receive multipart, forward as base64 JSON to avoid WAF blocking)
  app.post('/api/store/publish', (req, res) => {
    const chunks = [];
    req.on('data', c => chunks.push(c));
    req.on('end', async () => {
      try {
        const raw = Buffer.concat(chunks);
        const contentType = req.headers['content-type'] || '';

        const boundary = contentType.split('boundary=')[1];
        if (!boundary) {
          return res.status(400).json({ error: 'Missing multipart boundary' });
        }

        const { fields, fileBuffer, fileName } = parseMultipart(raw, boundary);
        if (!fileBuffer) {
          return res.status(400).json({ error: 'No agent file found in upload' });
        }

        const jsonBody = {
          agentData: fileBuffer.toString('base64'),
          fileName: fileName || 'agent.zip',
          scanScore: fields.scanScore ? parseInt(fields.scanScore, 10) : 0,
          changelog: fields.changelog || '',
        };

        console.log('[store-publish] forwarding %d bytes as base64 JSON, has-auth: %s',
          fileBuffer.length, !!req.headers['authorization']);
        storeProxy(req, res, 'POST', '/agents', jsonBody);
      } catch (e) {
        console.error('[store-publish] parse error:', e.message);
        res.status(500).json({ error: 'Failed to process upload: ' + e.message });
      }
    });
  });

  // Auth
  app.post('/api/store/auth/login', express.json(), (req, res) => {
    storeProxy(req, res, 'POST', '/auth/login', req.body);
  });
  app.post('/api/store/auth/register', express.json(), (req, res) => {
    storeProxy(req, res, 'POST', '/auth/register', req.body);
  });

  // Developer dashboard
  app.get('/api/store/dashboard/agents', (req, res) => {
    storeProxy(req, res, 'GET', '/dashboard/agents');
  });

  // ── Admin review routes (reviewer+) ────────────────────────────────────
  app.get('/api/store/admin/agents', (req, res) => {
    var qs = req.query.status ? '?status=' + encodeURIComponent(req.query.status) : '';
    storeProxy(req, res, 'GET', '/admin/agents' + qs);
  });
  app.get('/api/store/admin/agents/:id', (req, res) => {
    storeProxy(req, res, 'GET', '/admin/agents/' + req.params.id);
  });
  app.post('/api/store/admin/agents/:id/approve', express.json(), (req, res) => {
    storeProxy(req, res, 'POST', '/admin/agents/' + req.params.id + '/approve', req.body);
  });
  app.post('/api/store/admin/agents/:id/reject', express.json(), (req, res) => {
    storeProxy(req, res, 'POST', '/admin/agents/' + req.params.id + '/reject', req.body);
  });
  app.post('/api/store/admin/agents/:id/request-changes', express.json(), (req, res) => {
    storeProxy(req, res, 'POST', '/admin/agents/' + req.params.id + '/request-changes', req.body);
  });
  app.post('/api/store/admin/agents/:id/unpublish', express.json(), (req, res) => {
    storeProxy(req, res, 'POST', '/admin/agents/' + req.params.id + '/unpublish', req.body);
  });
  app.post('/api/store/admin/agents/:id/deprecate', express.json(), (req, res) => {
    storeProxy(req, res, 'POST', '/admin/agents/' + req.params.id + '/deprecate', req.body);
  });
  app.delete('/api/store/admin/agents/:id', express.json(), (req, res) => {
    storeProxy(req, res, 'DELETE', '/admin/agents/' + req.params.id, req.body);
  });

  // ── Notification routes ────────────────────────────────────────────────
  app.get('/api/store/notifications', (req, res) => {
    storeProxy(req, res, 'GET', '/notifications');
  });
  app.get('/api/store/notifications/unread-count', (req, res) => {
    storeProxy(req, res, 'GET', '/notifications/unread-count');
  });
  app.post('/api/store/notifications/:id/read', (req, res) => {
    storeProxy(req, res, 'POST', '/notifications/' + req.params.id + '/read');
  });
  app.post('/api/store/notifications/read-all', (req, res) => {
    storeProxy(req, res, 'POST', '/notifications/read-all');
  });
}
