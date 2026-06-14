export function registerProjectRoutes(app, deps) {
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
    addContext,
    updateContext,
    removeContext,
    contextFromArtifact,
    buildProjectProfile,
    // Kanban (optional — feature works without them, routes return 501)
    addBacklogItem,
    updateBacklogItem,
    moveWorkItem,
    addWorkItemComment,
    setWorkItemLock,
    listAllWorkItems,
    getProjectBoard,
    prioritizeBacklog,
    getInternalAICaller,
  } = deps;

  // Best-effort: fire an audit shortly after a project is created so the
  // backlog isn't empty. Async + swallows all errors. Held to a 30s deadline.
  function _scheduleInitialAudit(projectId) {
    setTimeout(async () => {
      try {
        const aiCaller = typeof getInternalAICaller === 'function'
          ? getInternalAICaller() : null;
        if (typeof aiCaller !== 'function') return;
        const mod = await import('../../lib/project-audit.js');
        const result = await Promise.race([
          mod.auditProject(projectId, { aiCaller, maxProposals: 5 }),
          new Promise((_r, rej) => setTimeout(() => rej(new Error('audit timeout')), 60_000)),
        ]);
        if (result && result.added && result.added.length) {
          for (const it of result.added) {
            _emitBoardEvent({ type: 'created', projectId, itemId: it.id });
          }
          console.log('[project-audit] seeded ' + result.added.length + ' item(s) for ' + projectId);
        }
      } catch (e) { console.warn('[project-audit] initial audit failed:', e?.message || e); }
    }, 2_000);
  }

  app.get('/api/projects', (_req, res) => {
    res.json(getAllProjects());
  });

  app.post('/api/projects', (req, res) => {
    try {
      const p = createProject(req.body || {});
      res.status(201).json(p);
      if (p && p.rootPath) _scheduleInitialAudit(p.id);
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
    res.json(project);
  });

  app.patch('/api/projects/:id', (req, res) => {
    const project = updateProject(req.params.id, req.body || {});
    if (!project) return res.status(404).json({ error: 'Project not found' });
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
    res.json({ ok: true });
  });

  app.post('/api/projects/:id/touch', (req, res) => {
    touchProject(req.params.id);
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
    const item = addBacklogItem(req.params.id, req.body || {});
    if (!item) return res.status(404).json({ error: 'Project not found' });
    _emitBoardEvent({ type: 'created', projectId: req.params.id, item });
    res.status(201).json(item);
  });

  // Patch a work item (title, body, rice, tags, assignee, priority, etc.)
  app.patch('/api/projects/:id/workitems/:itemId', (req, res) => {
    if (typeof updateBacklogItem !== 'function') return res.status(501).json({ error: 'kanban not wired' });
    const item = updateBacklogItem(req.params.id, req.params.itemId, req.body || {});
    if (!item) return res.status(404).json({ error: 'Item not found' });
    _emitBoardEvent({ type: 'updated', projectId: req.params.id, item });
    res.json(item);
  });

  // Soft-archive a work item (sets column='archived'). Hard delete is not
  // exposed via API — undo from the UI by dragging out of Archived.
  app.delete('/api/projects/:id/workitems/:itemId', (req, res) => {
    if (typeof moveWorkItem !== 'function') return res.status(501).json({ error: 'kanban not wired' });
    const r = moveWorkItem(req.params.id, req.params.itemId, { column: 'archived' }, { actor: 'human' });
    if (!r.ok) return res.status(404).json({ error: r.error });
    _emitBoardEvent({ type: 'archived', projectId: req.params.id, item: r.item });
    res.json({ ok: true });
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
      (finalItem.column === 'todo' || finalItem.column === 'in_progress') &&
      finalItem.assignee !== 'ai' &&
      Array.isArray(finalItem.runs) && finalItem.runs.some(x => x && x.taskId)
    ) {
      const rearm = moveWorkItem(
        req.params.id, req.params.itemId,
        { assignee: 'ai', claimedBy: null },
        { actor: 'human' },
      );
      if (rearm.ok) {
        finalItem = rearm.item;
        if (typeof addWorkItemComment === 'function') {
          addWorkItemComment(req.params.id, req.params.itemId, {
            author: 'ai',
            body: 'Re-armed by user (dragged back to ' + finalItem.column + ') — autopilot will pick this up on the next poll. Prior failure history will be included in the new run prompt.',
          });
        }
      }
    }

    _emitBoardEvent({ type: 'moved', projectId: req.params.id, item: finalItem });
    // Poke the autopilot worker — if the human just dragged an AI card into
    // todo or in_progress, the next poll should happen now, not in 15 s.
    import('../../kanban-worker.js')
      .then(mod => mod.pokeNow && mod.pokeNow())
      .catch(() => {});
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
    _emitBoardEvent({ type: 'comment', projectId: req.params.id, itemId: req.params.itemId, comment });
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
