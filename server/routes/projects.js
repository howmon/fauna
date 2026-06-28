import express from 'express';

export function registerProjectRoutes(app, deps) {
  // Project-level checkpoints — sidecar restore for uncommitted work.
  // Imported lazily so the route file stays self-contained.
  let _projCp = null;
  async function _checkpointsLib() {
    if (!_projCp) _projCp = await import('../lib/project-checkpoints.js');
    return _projCp;
  }

  // Cross-device sync hook. Calling enqueueChange when the engine isn't
  // running (no Fauna Cloud login) is a no-op, so we can fire it from
  // every project mutation unconditionally.
  let _syncEngine = null;
  async function _enqueueProjectChange(id, op) {
    try {
      if (!_syncEngine) _syncEngine = await import('../lib/sync-engine.js');
      _syncEngine.enqueueChange('project', id, op);
    } catch (_) { /* engine optional */ }
  }

  let _syncFileAdapter = null;
  async function _activateProjectFiles(id) {
    try {
      if (!_syncFileAdapter) _syncFileAdapter = await import('../lib/sync-file-adapter.js');
      _syncFileAdapter.activateProjectFileSync(id);
    } catch (_) { /* file sync optional */ }
  }

  function _pokeKanbanWorker() {
    import('../../kanban-worker.js')
      .then(mod => mod.pokeNow && mod.pokeNow())
      .catch(() => {});
  }

  function _isPickableColumn(column) {
    return column === 'todo' || column === 'in_progress';
  }

  function _kanbanItemPercent(item) {
    const map = { backlog: 0, todo: 20, in_progress: 55, review: 85, done: 100, archived: 100 };
    return map[item && item.column] ?? 0;
  }

  function _conversationKanbanSummary(convId) {
    if (typeof listAllWorkItems !== 'function' || !convId) return { items: [], percent: 0, activeItem: null };
    const items = listAllWorkItems({ limit: 2000 }).filter(it => it && it.originConvId === convId);
    const visible = items.filter(it => it.column !== 'archived');
    const basis = visible.length ? visible : items;
    const percent = basis.length
      ? Math.round(basis.reduce((sum, it) => sum + _kanbanItemPercent(it), 0) / basis.length)
      : 0;
    const activeItem = basis.find(it => it.column === 'in_progress')
      || basis.find(it => it.column === 'review')
      || basis.find(it => it.column === 'todo')
      || basis[0]
      || null;
    return { items, percent, activeItem };
  }

  async function _mirrorKanbanFeedbackToConversation({ convId, projectId, item, comment }) {
    const store = deps.conversationStore;
    if (!store || !convId || !comment || comment.author !== 'human') return;
    try {
      const conv = await store.get(convId);
      if (!conv) return;
      const messages = Array.isArray(conv.messages) ? conv.messages.slice() : [];
      if (messages.some(m => m && m._kanbanFeedbackId === comment.id)) return;
      const cardTitle = item && item.title ? item.title : 'Kanban card';
      messages.push({
        role: 'user',
        content: '[Kanban feedback]\nCard: ' + cardTitle + '\nComment: ' + comment.body,
        _isKanbanFeedback: true,
        _kanbanFeedbackId: comment.id,
        _kanbanProjectId: projectId,
        _kanbanItemId: item && item.id,
        createdAt: Date.now(),
      });
      await store.put(convId, { ...conv, messages, updatedAt: Date.now() });
    } catch (e) {
      console.warn('[projects-route] mirror kanban feedback failed:', e?.message || e);
    }
  }

  const {
    fs,
    createProject,
    getProject,
    getAllProjects,
    updateProject,
    deleteProject,
    touchProject,
    linkConversation,
    linkTask,
    addSource,
    removeSource,
    syncSource,
    listFiles,
    readSourceFile,
    resolveSourceFilePath,
    createSourceEntry,
    writeSourceFileBytes,
    deleteSourceEntry,
    renameSourceEntry,
    getSourceEntryAbsolutePath,
    requireElectron,
    addContext,
    updateContext,
    removeContext,
    contextFromArtifact,
    buildProjectProfile,
    // Kanban (optional — feature works without them, routes return 501)
    addBacklogItem,
    updateBacklogItem,
    moveWorkItem,
    deleteWorkItem,
    emptyArchivedWorkItems,
    addWorkItemComment,
    setWorkItemLock,
    listAllWorkItems,
    getProjectBoard,
    prioritizeBacklog,
    getInternalAICaller,
  } = deps;

  app.get('/api/projects', (_req, res) => {
    res.json(getAllProjects());
  });

  app.post('/api/projects', (req, res) => {
    try {
      const p = createProject(req.body || {});
      res.status(201).json(p);
      if (p && p.id) _enqueueProjectChange(p.id, 'upsert');
    }
    catch (e) { res.status(400).json({ error: e.message }); }
  });

  // Bulk-remove duplicate projects (same trimmed, case-insensitive name).
  // Keeps the oldest one of each name and deletes the rest. Returns the list
  // of deleted ids.
  app.post('/api/projects/dedupe', (_req, res) => {
    try {
      const all = getAllProjects();
      const seen = new Map(); // name -> kept project
      const deleted = [];
      for (const p of all.slice().sort((a, b) => String(a.createdAt || '').localeCompare(String(b.createdAt || '')))) {
        const key = String(p.name || '').trim().toLowerCase();
        if (!key) continue;
        if (!seen.has(key)) { seen.set(key, p); continue; }
        if (deleteProject(p.id)) deleted.push(p.id);
      }
      res.json({ ok: true, deleted, keptCount: seen.size });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  app.get('/api/projects/:id', (req, res) => {
    const project = getProject(req.params.id);
    if (!project) return res.status(404).json({ error: 'Project not found' });
    res.json(project);
  });

  app.put('/api/projects/:id', (req, res) => {
    const project = updateProject(req.params.id, req.body || {});
    if (!project) return res.status(404).json({ error: 'Project not found' });
    _enqueueProjectChange(project.id, 'upsert');
    if (project.kanban && project.kanban.autopilot) _pokeKanbanWorker();
    res.json(project);
  });

  app.patch('/api/projects/:id', (req, res) => {
    const project = updateProject(req.params.id, req.body || {});
    if (!project) return res.status(404).json({ error: 'Project not found' });
    _enqueueProjectChange(project.id, 'upsert');
    if (project.kanban && project.kanban.autopilot) _pokeKanbanWorker();
    res.json(project);
  });

  app.patch('/api/projects/:id/design', (req, res) => {
    const patch = req.body || {};
    const project = updateProject(req.params.id, { design: patch });
    if (!project) return res.status(404).json({ error: 'Project not found' });
    res.json(project);
  });

  app.delete('/api/projects/:id', (req, res) => {
    const ok = deleteProject(req.params.id);
    if (!ok) return res.status(404).json({ error: 'Project not found' });
    _enqueueProjectChange(req.params.id, 'delete');
    res.json({ ok: true });
  });

  app.post('/api/projects/:id/touch', (req, res) => {
    touchProject(req.params.id);
    _activateProjectFiles(req.params.id);
    res.json({ ok: true });
  });

  app.post('/api/projects/:id/conversations', (req, res) => {
    const ok = linkConversation(req.params.id, req.body?.convId);
    if (!ok) return res.status(404).json({ error: 'Project not found' });
    res.json({ ok: true });
  });

  app.post('/api/projects/:id/tasks', (req, res) => {
    const ok = linkTask(req.params.id, req.body?.taskId);
    if (!ok) return res.status(404).json({ error: 'Project not found' });
    res.json({ ok: true });
  });

  app.get('/api/conversations/:convId/kanban', (req, res) => {
    res.json({ ok: true, conversationId: req.params.convId, ..._conversationKanbanSummary(req.params.convId) });
  });

  app.post('/api/projects/:id/sources', (req, res) => {
    try { res.status(201).json(addSource(req.params.id, req.body || {})); }
    catch (e) { res.status(400).json({ error: e.message }); }
  });

  app.delete('/api/projects/:id/sources/:srcId', (req, res) => {
    const ok = removeSource(req.params.id, req.params.srcId);
    if (!ok) return res.status(404).json({ error: 'Source not found' });
    res.json({ ok: true });
  });

  app.post('/api/projects/:id/sources/:srcId/sync', async (req, res) => {
    try {
      const source = await syncSource(req.params.id, req.params.srcId);
      res.json(source);
    } catch (e) {
      res.status(400).json({ error: e.message });
    }
  });

  app.get('/api/projects/:id/sources/:srcId/files', (req, res) => {
    try {
      const entries = listFiles(req.params.id, req.params.srcId, req.query.path || '');
      res.json(entries);
    } catch (e) {
      res.status(400).json({ error: e.message });
    }
  });

  app.get('/api/projects/:id/sources/:srcId/file', (req, res) => {
    try {
      const result = readSourceFile(req.params.id, req.params.srcId, req.query.path || '');
      res.json(result);
    } catch (e) {
      res.status(400).json({ error: e.message });
    }
  });

  app.put('/api/projects/:id/sources/:srcId/file', (req, res) => {
    try {
      const { fullPath } = resolveSourceFilePath(req.params.id, req.params.srcId, req.query.path || '');
      fs.writeFileSync(fullPath, req.body?.content ?? '', 'utf8');
      res.json({ ok: true });
    } catch (e) {
      res.status(400).json({ error: e.message });
    }
  });

  // Create a new empty file or directory inside a source. Body:
  // { path: "foo/bar.txt", type: "file" | "dir" }.
  app.post('/api/projects/:id/sources/:srcId/entry', (req, res) => {
    try {
      const { path: relPath, type } = req.body || {};
      const entry = createSourceEntry(req.params.id, req.params.srcId, relPath, type);
      res.status(201).json(entry);
    } catch (e) {
      res.status(400).json({ error: e.message });
    }
  });

  // Drag-and-drop upload: write raw bytes to a source path. Path supplied
  // via ?path=foo/bar.png (URL-encoded). Optional ?overwrite=1 replaces
  // an existing file; otherwise we 409. Cap matches the chat attachment
  // limit (25mb) so the UX is symmetric. Bypasses the global express.json()
  // parser via the explicit raw middleware below.
  app.post(
    '/api/projects/:id/sources/:srcId/upload',
    express.raw({ type: '*/*', limit: '50mb' }),
    (req, res) => {
      try {
        if (typeof writeSourceFileBytes !== 'function') {
          return res.status(501).json({ error: 'upload not wired on this server' });
        }
        const relPath = String(req.query.path || '').trim();
        if (!relPath) return res.status(400).json({ error: 'path query param required' });
        const overwrite = req.query.overwrite === '1' || req.query.overwrite === 'true';
        const buf = Buffer.isBuffer(req.body)
          ? req.body
          : Buffer.from(req.body || '');
        const entry = writeSourceFileBytes(
          req.params.id, req.params.srcId, relPath, buf, { overwrite },
        );
        res.status(201).json(entry);
      } catch (e) {
        const msg = e?.message || String(e);
        const code = /already exists/i.test(msg) ? 409
          : /traversal|invalid|required|not allowed/i.test(msg) ? 400
          : 500;
        res.status(code).json({ error: msg });
      }
    },
  );

  // Rename / move a file or directory inside a source. Body:
  // { oldPath, newPath }. Both paths are source-relative.
  app.patch('/api/projects/:id/sources/:srcId/entry', (req, res) => {
    try {
      if (typeof renameSourceEntry !== 'function') {
        return res.status(501).json({ error: 'rename not wired on this server' });
      }
      const { oldPath, newPath } = req.body || {};
      if (!oldPath || !newPath) return res.status(400).json({ error: 'oldPath and newPath required' });
      const out = renameSourceEntry(req.params.id, req.params.srcId, oldPath, newPath);
      res.json(out);
    } catch (e) {
      const msg = e?.message || String(e);
      const code = /already exists/i.test(msg) ? 409
        : /not found/i.test(msg) ? 404
        : /traversal|invalid|required|not allowed/i.test(msg) ? 400
        : 500;
      res.status(code).json({ error: msg });
    }
  });

  // Delete a file or directory inside a source. Path supplied via
  // ?path=foo/bar (URL-encoded). Directories are removed recursively.
  app.delete('/api/projects/:id/sources/:srcId/entry', (req, res) => {
    try {
      if (typeof deleteSourceEntry !== 'function') {
        return res.status(501).json({ error: 'delete not wired on this server' });
      }
      const relPath = String(req.query.path || '').trim();
      if (!relPath) return res.status(400).json({ error: 'path query param required' });
      const out = deleteSourceEntry(req.params.id, req.params.srcId, relPath);
      res.json(out);
    } catch (e) {
      const msg = e?.message || String(e);
      const code = /not found/i.test(msg) ? 404
        : /traversal|invalid|required|not allowed/i.test(msg) ? 400
        : 500;
      res.status(code).json({ error: msg });
    }
  });

  // Resolve a source-relative path to its absolute filesystem path
  // without any side effects. Used by the renderer's Copy Path action.
  // Returns { fullPath, type }.
  app.get('/api/projects/:id/sources/:srcId/abspath', (req, res) => {
    try {
      if (typeof getSourceEntryAbsolutePath !== 'function') {
        return res.status(501).json({ error: 'abspath not wired on this server' });
      }
      const relPath = String(req.query.path || '').trim();
      if (!relPath) return res.status(400).json({ error: 'path query param required' });
      const { fullPath, type } = getSourceEntryAbsolutePath(
        req.params.id, req.params.srcId, relPath,
      );
      res.json({ fullPath, type });
    } catch (e) {
      const msg = e?.message || String(e);
      const code = /not found/i.test(msg) ? 404
        : /traversal|invalid|required|not allowed/i.test(msg) ? 400
        : 500;
      res.status(code).json({ error: msg });
    }
  });

  // Reveal a source entry in the OS file manager (Finder / Explorer).
  // Resolves the source-relative path to its absolute filesystem location
  // and hands it to Electron's shell.showItemInFolder. Returns the absolute
  // path in `fullPath` so the renderer can also offer Copy Path / Copy
  // Relative Path without re-deriving it.
  app.post('/api/projects/:id/sources/:srcId/reveal', (req, res) => {
    try {
      if (typeof getSourceEntryAbsolutePath !== 'function') {
        return res.status(501).json({ error: 'reveal not wired on this server' });
      }
      const relPath = String(req.query.path || '').trim();
      if (!relPath) return res.status(400).json({ error: 'path query param required' });
      const { fullPath, type } = getSourceEntryAbsolutePath(
        req.params.id, req.params.srcId, relPath,
      );
      try {
        const { shell } = requireElectron('electron');
        shell.showItemInFolder(fullPath);
      } catch (e) {
        // Electron not available (e.g. server running outside Electron host)
        // — still return the resolved path so the caller can copy/use it.
        return res.json({ ok: false, fullPath, type, error: 'electron unavailable: ' + e.message });
      }
      res.json({ ok: true, fullPath, type });
    } catch (e) {
      const msg = e?.message || String(e);
      const code = /not found/i.test(msg) ? 404
        : /traversal|invalid|required|not allowed/i.test(msg) ? 400
        : 500;
      res.status(code).json({ error: msg });
    }
  });

  app.get('/api/projects/:id/sources/:srcId/raw', (req, res) => {
    try {
      const { fullPath, mime, size } = resolveSourceFilePath(req.params.id, req.params.srcId, req.query.path || '');
      res.setHeader('Content-Type', mime);
      res.setHeader('Content-Length', size);
      res.setHeader('Cache-Control', 'no-store');
      fs.createReadStream(fullPath).pipe(res);
    } catch (e) {
      res.status(404).json({ error: e.message });
    }
  });

  app.get('/api/projects/:id/contexts', (req, res) => {
    const project = getProject(req.params.id);
    if (!project) return res.status(404).json({ error: 'Project not found' });
    res.json(project.contexts || []);
  });

  // Profile: aggregated "what fauna knows about this project". Optional `q`
  // query string scopes the dynamic + context buckets to a query. Cached
  // statically per scope for 60s; dynamic + context recompute every call.
  app.get('/api/projects/:id/profile', async (req, res) => {
    const project = getProject(req.params.id);
    if (!project) return res.status(404).json({ error: 'Project not found' });
    if (typeof buildProjectProfile !== 'function') {
      return res.status(501).json({ error: 'profile builder not wired' });
    }
    try {
      const profile = await buildProjectProfile(req.params.id, {
        q: req.query.q || '',
        includeContext: req.query.includeContext !== 'false',
        staticLimit:  req.query.staticLimit  ? Number(req.query.staticLimit)  : undefined,
        dynamicLimit: req.query.dynamicLimit ? Number(req.query.dynamicLimit) : undefined,
        contextLimit: req.query.contextLimit ? Number(req.query.contextLimit) : undefined,
      });
      res.json(profile);
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  app.post('/api/projects/:id/contexts', (req, res) => {
    try { res.status(201).json(addContext(req.params.id, req.body || {})); }
    catch (e) { res.status(400).json({ error: e.message }); }
  });

  app.put('/api/projects/:id/contexts/:ctxId', (req, res) => {
    const context = updateContext(req.params.id, req.params.ctxId, req.body || {});
    if (!context) return res.status(404).json({ error: 'Context not found' });
    res.json(context);
  });

  app.patch('/api/projects/:id/contexts/:ctxId', (req, res) => {
    const context = updateContext(req.params.id, req.params.ctxId, req.body || {});
    if (!context) return res.status(404).json({ error: 'Context not found' });
    res.json(context);
  });

  app.delete('/api/projects/:id/contexts/:ctxId', (req, res) => {
    const ok = removeContext(req.params.id, req.params.ctxId);
    if (!ok) return res.status(404).json({ error: 'Context not found' });
    res.json({ ok: true });
  });

  app.post('/api/projects/:id/contexts/from-artifact', (req, res) => {
    try { res.status(201).json(contextFromArtifact(req.params.id, req.body || {})); }
    catch (e) { res.status(400).json({ error: e.message }); }
  });

  app.post('/api/projects/:id/contexts/from-file', (req, res) => {
    try {
      const { name, content, mime } = req.body || {};
      if (!content) return res.status(400).json({ error: 'content required' });
      const context = addContext(req.params.id, {
        type: 'file',
        name: name || 'Uploaded file',
        content: typeof content === 'string' ? content : Buffer.from(content).toString('utf8'),
        path: mime || null,
      });
      res.status(201).json(context);
    } catch (e) {
      res.status(400).json({ error: e.message });
    }
  });

  // ── Kanban / Work Items ───────────────────────────────────────────────
  // Per-project board (cards grouped by column).
  app.get('/api/projects/:id/board', async (req, res) => {
    if (typeof getProjectBoard !== 'function') return res.status(501).json({ error: 'kanban not wired' });
    const board = getProjectBoard(req.params.id);
    if (!board) return res.status(404).json({ error: 'Project not found' });
    // Attach the autopilot idle-reason snapshot so the UI can render
    // "why isn't this running?" without waiting for the next SSE tick.
    try {
      const mod = await import('../../kanban-worker.js');
      if (typeof mod.getIdleReasons === 'function') {
        board.idle = mod.getIdleReasons(req.params.id);
      }
    } catch (_) { /* worker not loaded — fine, UI just won't show idle */ }
    res.json(board);
  });

  // Create a work item. Body: { title, body?, column?, assignee?, priority?,
  // acceptance?, tags?, source?, parentId?, blockedBy?, estimateMinutes?, dueAt? }
  app.post('/api/projects/:id/workitems', (req, res) => {
    if (typeof addBacklogItem !== 'function') return res.status(501).json({ error: 'kanban not wired' });
    const project = typeof getProject === 'function' ? getProject(req.params.id) : null;
    const body = Object.assign({}, req.body || {});
    if (
      (body.assignee === undefined || body.assignee === null || body.assignee === '') &&
      _isPickableColumn(body.column) &&
      project && project.kanban && project.kanban.autopilot
    ) {
      body.assignee = 'ai';
    }
    const item = addBacklogItem(req.params.id, body);
    if (!item) return res.status(404).json({ error: 'Project not found' });
    _emitBoardEvent({ type: 'created', projectId: req.params.id, item });
    if (item.assignee === 'ai' && _isPickableColumn(item.column)) _pokeKanbanWorker();
    res.status(201).json(item);
  });

  // Permanently clear every card in the Archived column.
  app.delete('/api/projects/:id/workitems/archived', (req, res) => {
    if (typeof emptyArchivedWorkItems !== 'function') return res.status(501).json({ error: 'kanban not wired' });
    const out = emptyArchivedWorkItems(req.params.id);
    if (!out || out.ok === false) return res.status(404).json({ error: (out && out.error) || 'Project not found' });
    _emitBoardEvent({
      type: 'archive-cleared',
      projectId: req.params.id,
      removedCount: out.removedCount,
      removedIds: out.removedIds,
    });
    res.json(out);
  });

  // Patch a work item (title, body, rice, tags, assignee, priority, etc.)
  app.patch('/api/projects/:id/workitems/:itemId', (req, res) => {
    if (typeof updateBacklogItem !== 'function') return res.status(501).json({ error: 'kanban not wired' });
    const project = typeof getProject === 'function' ? getProject(req.params.id) : null;
    const body = Object.assign({}, req.body || {});
    if (
      (body.assignee === undefined || body.assignee === null || body.assignee === '') &&
      _isPickableColumn(body.column) &&
      project && project.kanban && project.kanban.autopilot
    ) {
      body.assignee = 'ai';
      body.claimedBy = null;
    }
    const item = updateBacklogItem(req.params.id, req.params.itemId, body);
    if (!item) return res.status(404).json({ error: 'Item not found' });
    _emitBoardEvent({ type: 'updated', projectId: req.params.id, item });
    if (item.assignee === 'ai' && _isPickableColumn(item.column) && !item.claimedBy && !item.lockedByUser) {
      _pokeKanbanWorker();
    }
    res.json(item);
  });

  // Default behavior soft-archives a work item (column='archived').
  // Use ?hard=1 to permanently delete the card.
  app.delete('/api/projects/:id/workitems/:itemId', (req, res) => {
    const hard = req.query.hard === '1' || req.query.hard === 'true';
    if (hard) {
      if (typeof deleteWorkItem !== 'function') return res.status(501).json({ error: 'kanban not wired' });
      const del = deleteWorkItem(req.params.id, req.params.itemId);
      if (!del.ok) return res.status(404).json({ error: del.error });
      _emitBoardEvent({ type: 'deleted', projectId: req.params.id, itemId: req.params.itemId, item: del.item });
      return res.json({ ok: true, deleted: true, itemId: req.params.itemId });
    }

    if (typeof moveWorkItem !== 'function') return res.status(501).json({ error: 'kanban not wired' });
    const r = moveWorkItem(req.params.id, req.params.itemId, { column: 'archived' }, { actor: 'human' });
    if (!r.ok) return res.status(404).json({ error: r.error });
    _emitBoardEvent({ type: 'archived', projectId: req.params.id, item: r.item });
    res.json({ ok: true, archived: true, itemId: req.params.itemId });
  });

  // Move a card. Body: { column, assignee?, claimedBy?, runEntry? }
  // Header `x-fauna-actor: ai|human` controls the strict-forward check.
  app.post('/api/projects/:id/workitems/:itemId/move', (req, res) => {
    if (typeof moveWorkItem !== 'function') return res.status(501).json({ error: 'kanban not wired' });
    const actor = req.get('x-fauna-actor') === 'ai' ? 'ai' : 'human';
    const patch = req.body || {};
    const r = moveWorkItem(req.params.id, req.params.itemId, patch, { actor, strict: actor === 'ai' });
    if (!r.ok) return res.status(400).json({ error: r.error });

    // ── Re-arm autopilot on human drag-back ─────────────────────────────
    // When a human drags a previously-AI card back into a working column
    // (todo or in_progress) without explicitly setting an assignee, treat
    // that as "give it another go." Otherwise the card sits there with
    // assignee='human' (from the prior handoff) and autopilot ignores it
    // forever — which is surprising because the user's clear intent was
    // to put it back in play.
    //
    // We only do this when:
    //   • The actor is a human (the AI controls its own assignee).
    //   • The body did NOT explicitly set assignee (so we don't override
    //     a deliberate human assignment).
    //   • The card has prior AI run history (so we never accidentally
    //     auto-assign a card a human originally created for themselves).
    //   • The card landed in todo or in_progress (not done/archived/review).
    let finalItem = r.item;
    if (
      actor === 'human' &&
      patch.assignee === undefined &&
      patch.claimedBy === undefined &&
      _isPickableColumn(finalItem.column)
    ) {
      const project = typeof getProject === 'function' ? getProject(req.params.id) : null;
      const hasPriorAiRun = Array.isArray(finalItem.runs) && finalItem.runs.some(x => x && x.taskId);
      const shouldRearmForAi =
        finalItem.assignee === 'ai' ||
        hasPriorAiRun ||
        (project && project.kanban && project.kanban.autopilot);
      if (shouldRearmForAi) {
        const rearm = moveWorkItem(
          req.params.id, req.params.itemId,
          { assignee: 'ai', claimedBy: null },
          { actor: 'human' },
        );
        if (rearm.ok) {
          finalItem = rearm.item;
          if (typeof addWorkItemComment === 'function' && hasPriorAiRun) {
            addWorkItemComment(req.params.id, req.params.itemId, {
              author: 'ai',
              body: 'Re-armed by user (dragged back to ' + finalItem.column + ') — autopilot will pick this up immediately. Prior failure history will be included in the new run prompt.',
            });
          }
        }
      }
    }

    _emitBoardEvent({ type: 'moved', projectId: req.params.id, item: finalItem });
    // Poke the autopilot worker — if the human just dragged an AI card into
    // todo or in_progress, the next poll should happen now, not in 15 s.
    if (finalItem.assignee === 'ai' && _isPickableColumn(finalItem.column) && !finalItem.claimedBy && !finalItem.lockedByUser) {
      _pokeKanbanWorker();
    }
    res.json(finalItem);
  });

  // Claim a card. Body: { by:'ai:<agent>' | 'user:<id>' }
  app.post('/api/projects/:id/workitems/:itemId/claim', (req, res) => {
    if (typeof moveWorkItem !== 'function') return res.status(501).json({ error: 'kanban not wired' });
    const by = String((req.body && req.body.by) || '').slice(0, 200);
    if (!by) return res.status(400).json({ error: 'by required' });
    const actor = by.startsWith('ai:') ? 'ai' : 'human';
    const r = moveWorkItem(req.params.id, req.params.itemId, { claimedBy: by }, { actor });
    if (!r.ok) return res.status(400).json({ error: r.error });
    _emitBoardEvent({ type: 'claimed', projectId: req.params.id, item: r.item });
    res.json(r.item);
  });

  // Lock / unlock a card (humans only — prevents AI from auto-archiving or
  // moving it). Body: { locked: bool }
  app.post('/api/projects/:id/workitems/:itemId/lock', (req, res) => {
    if (typeof setWorkItemLock !== 'function') return res.status(501).json({ error: 'kanban not wired' });
    const item = setWorkItemLock(req.params.id, req.params.itemId, !!(req.body && req.body.locked));
    if (!item) return res.status(404).json({ error: 'Item not found' });
    _emitBoardEvent({ type: 'updated', projectId: req.params.id, item });
    res.json(item);
  });

  // Add a comment. Body: { body, author?:'ai'|'human' (default human) }
  app.post('/api/projects/:id/workitems/:itemId/comments', (req, res) => {
    if (typeof addWorkItemComment !== 'function') return res.status(501).json({ error: 'kanban not wired' });
    const author = req.body && req.body.author === 'ai' ? 'ai' : 'human';
    const comment = addWorkItemComment(req.params.id, req.params.itemId, {
      author,
      body: (req.body && req.body.body) || '',
    });
    if (!comment) return res.status(404).json({ error: 'Item not found' });
    let commentItem = null;
    try {
      const board = typeof getProjectBoard === 'function' ? getProjectBoard(req.params.id) : null;
      if (board && board.columns) {
        for (const col of Object.keys(board.columns)) {
          commentItem = (board.columns[col] || []).find(it => it.id === req.params.itemId) || commentItem;
        }
      }
    } catch (_) {}
    _emitBoardEvent({
      type: 'comment',
      projectId: req.params.id,
      itemId: req.params.itemId,
      item: commentItem,
      originConvId: commentItem && commentItem.originConvId,
      comment,
    });
    _mirrorKanbanFeedbackToConversation({
      convId: commentItem && commentItem.originConvId,
      projectId: req.params.id,
      item: commentItem,
      comment,
    });
    // If a HUMAN comment arrives while an autopilot run is in-flight for
    // this card, inject it into the live conversation so the model reads
    // it as a steering message at the top of its next step. AI-authored
    // comments must NOT steer (would self-loop with fauna_workitem_comment).
    if (author === 'human') {
      import('../../kanban-worker.js')
        .then(mod => mod.steerCard && mod.steerCard(req.params.id, req.params.itemId, comment.body))
        .catch(e => console.warn('[projects-route] steerCard failed:', e?.message || e));
    }
    res.status(201).json(comment);
  });

  // Prioritise + auto-promote new items into Todo. Body: { method?:'rice'|'moscow' }
  app.post('/api/projects/:id/prioritize', (req, res) => {
    if (typeof prioritizeBacklog !== 'function') return res.status(501).json({ error: 'kanban not wired' });
    const r = prioritizeBacklog(req.params.id, req.body || {});
    if (!r) return res.status(404).json({ error: 'Project not found' });
    _emitBoardEvent({ type: 'prioritized', projectId: req.params.id });
    _pokeKanbanWorker();
    res.json(r);
  });

  // Run a project audit on demand. Body: { maxProposals?:number, dryRun?:bool }
  app.post('/api/projects/:id/audit', async (req, res) => {
    try {
      const aiCaller = typeof getInternalAICaller === 'function' ? getInternalAICaller() : null;
      const opts = {
        aiCaller: req.body?.dryRun ? null : aiCaller,
        maxProposals: Math.min(10, Math.max(1, Number(req.body?.maxProposals) || 5)),
      };
      const mod = await import('../../lib/project-audit.js');
      const result = await mod.auditProject(req.params.id, opts);
      if (!result || !result.ok) return res.status(400).json(result || { ok: false });
      if (Array.isArray(result.added)) {
        for (const it of result.added) _emitBoardEvent({ type: 'created', projectId: req.params.id, itemId: it.id });
      }
      // Trim summary blobs from the response so the wire payload stays small.
      if (result.summary && result.summary.hintBlobs) {
        result.summary = { ...result.summary, hintBlobs: Object.keys(result.summary.hintBlobs) };
      }
      res.json(result);
    } catch (e) {
      res.status(500).json({ ok: false, error: e?.message || String(e) });
    }
  });

  // ── Global board ─────────────────────────────────────────────────────
  // Items across every project, optionally filtered by ?column=&assignee=
  app.get('/api/board', (req, res) => {
    if (typeof listAllWorkItems !== 'function') return res.status(501).json({ error: 'kanban not wired' });
    const items = listAllWorkItems({
      column: req.query.column || null,
      assignee: req.query.assignee || null,
      claimedBy: req.query.claimedBy || null,
      limit: req.query.limit ? Math.max(1, Math.min(2000, Number(req.query.limit))) : 1000,
    });
    res.json({ items });
  });

  // Live updates for both per-project and global boards. Reuses the same
  // SSE pattern as /api/tasks/stream so the client can subscribe once.
  app.get('/api/board/stream', (req, res) => {
    const _o = req.headers.origin;
    if (_o && /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(_o)) {
      res.setHeader('Access-Control-Allow-Origin', _o);
      res.setHeader('Vary', 'Origin');
    }
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders?.();
    const send = (data) => {
      try { res.write('data: ' + JSON.stringify(data) + '\n\n'); } catch (_) {}
    };
    send({ type: 'hello', ts: Date.now() });
    _boardSubscribers.add(send);
    const ping = setInterval(() => send({ type: 'ping', ts: Date.now() }), 30000);
    req.on('close', () => {
      clearInterval(ping);
      _boardSubscribers.delete(send);
    });
  });

  // ── Project Checkpoints ─────────────────────────────────────────────
  // Copilot-worktree-inspired sidecar history. Stores delta packs only
  // (respects .gitignore via `git ls-files` when the project is a git repo)
  // so users can undo agent edits even before a commit. See
  // server/lib/project-checkpoints.js.
  app.get('/api/projects/:id/checkpoints', async (req, res) => {
    try {
      const project = getProject(req.params.id);
      if (!project) return res.status(404).json({ error: 'Project not found' });
      const lib = await _checkpointsLib();
      res.json({
        ok: true,
        settings: lib.getCheckpointSettings(project),
        checkpoints: lib.listCheckpoints(project.id),
      });
    } catch (e) { res.status(500).json({ ok: false, error: e?.message || String(e) }); }
  });

  app.post('/api/projects/:id/checkpoints', async (req, res) => {
    try {
      const project = getProject(req.params.id);
      if (!project) return res.status(404).json({ error: 'Project not found' });
      const lib = await _checkpointsLib();
      const meta = lib.createCheckpoint(project, {
        title:    req.body?.title,
        trigger:  req.body?.trigger || 'manual',
        note:     req.body?.note,
        includeUntracked: req.body?.includeUntracked,
      });
      res.status(201).json({ ok: true, checkpoint: meta });
    } catch (e) { res.status(400).json({ ok: false, error: e?.message || String(e) }); }
  });

  app.get('/api/projects/:id/checkpoints/:number', async (req, res) => {
    try {
      const project = getProject(req.params.id);
      if (!project) return res.status(404).json({ error: 'Project not found' });
      const lib = await _checkpointsLib();
      const meta = lib.readCheckpointMeta(project.id, Number(req.params.number));
      if (!meta) return res.status(404).json({ error: 'Checkpoint not found' });
      const includePatch = req.query.patch === '1' || req.query.patch === 'true';
      res.json({
        ok: true,
        checkpoint: meta,
        patch: includePatch ? lib.readCheckpointPatch(project.id, Number(req.params.number)) : undefined,
      });
    } catch (e) { res.status(500).json({ ok: false, error: e?.message || String(e) }); }
  });

  app.delete('/api/projects/:id/checkpoints/:number', async (req, res) => {
    try {
      const project = getProject(req.params.id);
      if (!project) return res.status(404).json({ error: 'Project not found' });
      const lib = await _checkpointsLib();
      const ok = lib.deleteCheckpoint(project.id, Number(req.params.number));
      if (!ok) return res.status(404).json({ ok: false, error: 'Checkpoint not found' });
      res.json({ ok: true });
    } catch (e) { res.status(500).json({ ok: false, error: e?.message || String(e) }); }
  });

  // mode: 'preview' | 'forward' | 'reverse' | '3way'
  app.post('/api/projects/:id/checkpoints/:number/restore', async (req, res) => {
    try {
      const project = getProject(req.params.id);
      if (!project) return res.status(404).json({ error: 'Project not found' });
      const lib = await _checkpointsLib();
      const result = lib.restoreCheckpoint(project, Number(req.params.number), {
        mode:  req.body?.mode || req.query?.mode || 'preview',
        force: !!(req.body?.force),
      });
      res.json(result);
    } catch (e) { res.status(400).json({ ok: false, error: e?.message || String(e) }); }
  });

  // Update retention/auto-snapshot settings for a project.
  app.put('/api/projects/:id/checkpoints/settings', (req, res) => {
    try {
      const project = getProject(req.params.id);
      if (!project) return res.status(404).json({ error: 'Project not found' });
      const incoming = req.body || {};
      const cur = project.checkpoints || {};
      const next = {
        autoSnapshotOnAgentTurn:   typeof incoming.autoSnapshotOnAgentTurn   === 'boolean' ? incoming.autoSnapshotOnAgentTurn   : cur.autoSnapshotOnAgentTurn,
        autoSnapshotOnDestructive: typeof incoming.autoSnapshotOnDestructive === 'boolean' ? incoming.autoSnapshotOnDestructive : cur.autoSnapshotOnDestructive,
        includeUntracked:          typeof incoming.includeUntracked          === 'boolean' ? incoming.includeUntracked          : cur.includeUntracked,
        maxCount: Number.isFinite(incoming.maxCount) && incoming.maxCount > 0 ? Math.min(500, Math.floor(incoming.maxCount)) : cur.maxCount,
        maxBytes: Number.isFinite(incoming.maxBytes) && incoming.maxBytes > 0 ? Math.min(10 * 1024 * 1024 * 1024, Math.floor(incoming.maxBytes)) : cur.maxBytes,
      };
      const updated = updateProject(project.id, { checkpoints: next });
      res.json({ ok: true, settings: next, project: updated });
    } catch (e) { res.status(500).json({ ok: false, error: e?.message || String(e) }); }
  });
}

// ── Board event bus (module-scoped) ────────────────────────────────────
// Lightweight pub/sub for /api/board/stream. The kanban-worker (P4) and
// the chat route emit through the exported `emitBoardEvent` helper.
const _boardSubscribers = new Set();
function _emitBoardEvent(evt) {
  for (const send of _boardSubscribers) {
    try { send(evt); } catch (_) { _boardSubscribers.delete(send); }
  }
}
export function emitBoardEvent(evt) { _emitBoardEvent(evt); }
