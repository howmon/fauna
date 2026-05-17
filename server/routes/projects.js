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
    addContext,
    updateContext,
    removeContext,
    contextFromArtifact,
  } = deps;

  app.get('/api/projects', (_req, res) => {
    res.json(getAllProjects());
  });

  app.post('/api/projects', (req, res) => {
    try { res.status(201).json(createProject(req.body || {})); }
    catch (e) { res.status(400).json({ error: e.message }); }
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
}
