// ── Connector routes — REST surface for syncing external sources ───────────
//
// Phase 5. Thin wrappers over server/lib/connectors.js. Keep response shapes
// small — clients only need ok/ingested/skipped/errors counts to surface a
// status toast.

import {
  syncGitHubRepo,
  syncLocalFolder,
} from '../lib/connectors.js';
import {
  listDocuments as ctxListDocs,
  deleteDocument as ctxDeleteDoc,
  getStats as ctxGetStats,
} from '../lib/context-store.js';
import { projectContainerTag } from '../../memory-store.js';

function _resolveContainerTag(body, query) {
  const scope = (body?.scope || query?.scope || '').toLowerCase();
  const projectId = body?.projectId || query?.projectId;
  if (scope === 'global' || !projectId) return 'global';
  return projectContainerTag(projectId);
}

export function registerConnectorRoutes(app) {
  app.post('/api/connectors/github', async (req, res) => {
    const body = req.body || {};
    if (!body.repo) return res.status(400).json({ error: 'repo is required ("owner/name")' });
    try {
      const result = await syncGitHubRepo({
        repo: body.repo,
        branch: body.branch,
        containerTag: _resolveContainerTag(body),
        maxFiles: body.maxFiles ? Number(body.maxFiles) : undefined,
      });
      if (!result.ok) return res.status(400).json(result);
      res.json(result);
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  app.post('/api/connectors/folder', async (req, res) => {
    const body = req.body || {};
    if (!body.path) return res.status(400).json({ error: 'path is required' });
    try {
      const result = await syncLocalFolder({
        path: body.path,
        containerTag: _resolveContainerTag(body),
        maxFiles: body.maxFiles ? Number(body.maxFiles) : undefined,
      });
      if (!result.ok) return res.status(400).json(result);
      res.json(result);
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  // List all ingested context documents (any source). Doubles as a connector
  // status view — clients group by sourceType client-side.
  app.get('/api/connectors/documents', (req, res) => {
    const containerTag = req.query.projectId
      ? projectContainerTag(req.query.projectId)
      : (req.query.scope === 'global' ? 'global' : null);
    const opts = {};
    if (containerTag) {
      opts.containerTag = containerTag;
      opts.includeGlobal = req.query.includeGlobal !== 'false';
    }
    res.json({ documents: ctxListDocs(opts), stats: ctxGetStats() });
  });

  app.delete('/api/connectors/documents/:docId', (req, res) => {
    res.json(ctxDeleteDoc(req.params.docId));
  });
}
