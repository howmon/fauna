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
    enableWebhook,
    disableWebhook,
    rotateWebhookToken,
    getRunningTaskInfo,
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
    const _o = req.headers.origin;
    if (_o && /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(_o)) {
      res.setHeader('Access-Control-Allow-Origin', _o);
      res.setHeader('Vary', 'Origin');
    }
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

  // Snapshot of what an in-flight task is doing right now: model, step,
  // reasoning entries, latest "current" step. Returns 200 with `running:false`
  // for tasks that have already finished so the UI can fall back to
  // task.result.reasoning without a second roundtrip. For tasks killed
  // mid-run (laptop sleep, crash) we also expose task._partialReasoning so
  // the user sees what the model was thinking before it was interrupted.
  app.get('/api/tasks/:id/live', (req, res) => {
    const task = getTask(req.params.id);
    if (!task) return res.status(404).json({ error: 'Task not found' });
    const running = isTaskRunning(req.params.id);
    const live = running && typeof getRunningTaskInfo === 'function'
      ? getRunningTaskInfo(req.params.id) : null;
    // Resolution order for reasoning when NOT running:
    //   1. final result.reasoning (clean exit)
    //   2. _partialReasoning (sleep/crash-killed mid-run)
    //   3. empty
    const persistedReasoning = (task.result && Array.isArray(task.result.reasoning))
      ? task.result.reasoning
      : (Array.isArray(task._partialReasoning) ? task._partialReasoning : []);
    const persistedStats = (task.result && task.result.stats) || task._partialStats || null;
    const persistedStep = (task.result && task.result.totalSteps)
      || task._partialStep || 0;
    res.json({
      ok: true,
      running,
      taskId: task.id,
      title: task.title,
      model: task.model || null,
      agents: Array.isArray(task.agents) ? task.agents : [],
      status: task.status,
      // Hint to the UI that this snapshot is from a previous interrupted run.
      interrupted: !running && task.status === 'running' && !!task._partialUpdatedAt,
      interruptedAt: !running ? (task._partialUpdatedAt || null) : null,
      startedAt: live ? live.startedAt : null,
      elapsedMs: live ? live.elapsed : null,
      step: live ? live.step : persistedStep,
      stats: live ? live.stats : persistedStats,
      current: live ? live.current : null,
      reasoning: live ? live.reasoning : persistedReasoning,
    });
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

  function hookUrl(req, token) {
    return `${req.protocol}://${req.get('host')}/api/hooks/${token}`;
  }

  app.post('/api/tasks/:id/webhook', (req, res) => {
    const fn = req.body && req.body.rotate ? rotateWebhookToken : enableWebhook;
    const task = fn(req.params.id);
    if (!task) return res.status(404).json({ error: 'Task not found' });
    res.json({ ok: true, webhook: task.webhook, url: hookUrl(req, task.webhook.token) });
  });

  app.delete('/api/tasks/:id/webhook', (req, res) => {
    const task = disableWebhook(req.params.id);
    if (!task) return res.status(404).json({ error: 'Task not found' });
    res.json({ ok: true, webhook: task.webhook || null });
  });
}
