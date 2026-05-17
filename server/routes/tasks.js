export function registerTaskRoutes(app, deps) {
  const {
    createTask,
    getTask,
    getAllTasks,
    updateTask,
    deleteTask,
    runTask,
    pauseTask,
    stopTask,
    steerTask,
    isTaskRunning,
    subscribe,
  } = deps;

  function taskWithRuntime(task) {
    if (!task) return task;
    return { ...task, _running: isTaskRunning(task.id) };
  }

  function sendTaskEvent(res, evt) {
    res.write(`data: ${JSON.stringify(evt)}\n\n`);
  }

  app.get('/api/tasks', (_req, res) => {
    res.json(getAllTasks().map(taskWithRuntime));
  });

  app.post('/api/tasks', (req, res) => {
    try {
      const task = createTask(req.body || {});
      res.status(201).json(taskWithRuntime(task));
    } catch (e) {
      res.status(400).json({ error: e.message });
    }
  });

  app.get('/api/tasks/stream', (req, res) => {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders?.();
    sendTaskEvent(res, { event: 'ready' });
    const unsubscribe = subscribe('*', evt => sendTaskEvent(res, evt));
    req.on('close', unsubscribe);
  });

  app.get('/api/tasks/:id', (req, res) => {
    const task = getTask(req.params.id);
    if (!task) return res.status(404).json({ error: 'Task not found' });
    res.json(taskWithRuntime(task));
  });

  app.put('/api/tasks/:id', (req, res) => {
    const task = updateTask(req.params.id, req.body || {});
    if (!task) return res.status(404).json({ error: 'Task not found' });
    res.json(taskWithRuntime(task));
  });

  app.delete('/api/tasks/:id', (req, res) => {
    if (isTaskRunning(req.params.id)) stopTask(req.params.id);
    const ok = deleteTask(req.params.id);
    if (!ok) return res.status(404).json({ error: 'Task not found' });
    res.json({ ok: true });
  });

  app.post('/api/tasks/:id/run', (req, res) => {
    const task = getTask(req.params.id);
    if (!task) return res.status(404).json({ error: 'Task not found' });
    runTask(req.params.id, req.body || {}).catch(e => console.error('[tasks] run failed:', e.message));
    res.json({ ok: true, runId: req.params.id });
  });

  app.post('/api/tasks/:id/pause', (req, res) => {
    const task = getTask(req.params.id);
    if (!task) return res.status(404).json({ error: 'Task not found' });
    if (isTaskRunning(req.params.id)) pauseTask(req.params.id);
    else updateTask(req.params.id, { status: 'paused', _historyEvent: 'paused', _historyDetail: 'manual' });
    res.json({ ok: true });
  });

  app.post('/api/tasks/:id/resume', (req, res) => {
    const task = getTask(req.params.id);
    if (!task) return res.status(404).json({ error: 'Task not found' });
    const status = task.schedule?.type === 'manual' ? 'pending' : 'scheduled';
    res.json(taskWithRuntime(updateTask(req.params.id, { status, _historyEvent: 'resumed', _historyDetail: 'manual' })));
  });

  app.post('/api/tasks/:id/stop', (req, res) => {
    const task = getTask(req.params.id);
    if (!task) return res.status(404).json({ error: 'Task not found' });
    if (isTaskRunning(req.params.id)) stopTask(req.params.id);
    else updateTask(req.params.id, { status: 'paused', _historyEvent: 'stopped', _historyDetail: 'manual' });
    res.json({ ok: true });
  });

  app.post('/api/tasks/:id/steer', (req, res) => {
    const ok = steerTask(req.params.id, req.body?.message || '');
    if (!ok) return res.status(409).json({ error: 'Task is not running' });
    res.json({ ok: true });
  });
}
