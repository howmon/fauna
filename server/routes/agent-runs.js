function parseCursor(req) {
  const value = req.query?.after ?? req.headers?.['last-event-id'] ?? 0;
  return Math.max(0, Number(value) || 0);
}

function sendEvent(res, event) {
  res.write(`id: ${event.id}\ndata: ${JSON.stringify(event)}\n\n`);
}

function otlpAttribute(key, value) {
  const encoded = typeof value === 'boolean'
    ? { boolValue: value }
    : typeof value === 'number'
      ? { doubleValue: value }
      : { stringValue: String(value ?? '') };
  return { key, value: encoded };
}

export function runToOtlp(summary, events) {
  const run = summary.run;
  const traceId = Buffer.from(run.id).toString('hex').padEnd(32, '0').slice(0, 32);
  const startedAt = Number(run.createdAt || Date.now());
  const endedAt = Number(run.completedAt || run.updatedAt || startedAt);
  return {
    resourceSpans: [{
      resource: { attributes: [otlpAttribute('service.name', 'fauna'), otlpAttribute('fauna.run.kind', run.kind)] },
      scopeSpans: [{
        scope: { name: 'fauna.agent-runs' },
        spans: [{
          traceId,
          spanId: traceId.slice(0, 16),
          name: `${run.kind || 'agent'} run`,
          kind: 1,
          startTimeUnixNano: String(BigInt(startedAt) * 1000000n),
          endTimeUnixNano: String(BigInt(endedAt) * 1000000n),
          attributes: [
            otlpAttribute('fauna.run.id', run.id),
            otlpAttribute('fauna.run.status', run.status),
            otlpAttribute('fauna.run.event_count', events.length),
          ],
          events: events.map(event => ({
            timeUnixNano: String(BigInt(Number(event.ts) || startedAt) * 1000000n),
            name: event.type,
            attributes: [otlpAttribute('fauna.event.id', event.id), otlpAttribute('fauna.event.data', JSON.stringify(event.data || {}))],
          })),
          status: { code: run.status === 'failed' ? 2 : run.status === 'completed' ? 1 : 0 },
        }],
      }],
    }],
  };
}

export function registerAgentRunRoutes(app, { runStore }) {
  app.get('/api/agent-runs', (req, res) => {
    const runs = runStore.list({
      kind: req.query?.kind,
      status: req.query?.status,
      conversationId: req.query?.conversationId,
      projectId: req.query?.projectId,
    });
    res.json(runs);
  });

  app.get('/api/agent-runs/analytics', (req, res) => {
    const runs = runStore.list({ projectId: req.query?.projectId });
    const summaries = runs.map(run => runStore.summary(run.id)).filter(Boolean);
    res.json({
      runs: summaries.length,
      active: summaries.filter(item => ['running', 'paused'].includes(item.run.status)).length,
      completed: summaries.filter(item => item.run.status === 'completed').length,
      failed: summaries.filter(item => item.run.status === 'failed').length,
      toolCalls: summaries.reduce((sum, item) => sum + item.toolCalls, 0),
      toolFailures: summaries.reduce((sum, item) => sum + item.toolFailures, 0),
      promptTokens: summaries.reduce((sum, item) => sum + item.promptTokens, 0),
      completionTokens: summaries.reduce((sum, item) => sum + item.completionTokens, 0),
    });
  });

  app.get('/api/agent-runs/:id', (req, res) => {
    const summary = runStore.summary(req.params.id);
    if (!summary) return res.status(404).json({ error: 'Run not found' });
    res.json(summary);
  });

  app.get('/api/agent-runs/:id/events', (req, res) => {
    if (!runStore.get(req.params.id)) return res.status(404).json({ error: 'Run not found' });
    res.json(runStore.events(req.params.id, { after: parseCursor(req), limit: req.query?.limit }));
  });

  app.get('/api/agent-runs/:id/export', (req, res) => {
    const summary = runStore.summary(req.params.id);
    if (!summary) return res.status(404).json({ error: 'Run not found' });
    const events = runStore.events(req.params.id, { limit: 50000 });
    const format = String(req.query?.format || 'json').toLowerCase();
    if (!['json', 'otlp'].includes(format)) return res.status(400).json({ error: 'Unsupported export format' });
    res.setHeader('Content-Disposition', `attachment; filename="${req.params.id}.${format}.json"`);
    res.json(format === 'otlp' ? runToOtlp(summary, events) : { ...summary, events });
  });

  app.get('/api/agent-runs/:id/stream', (req, res) => {
    if (!runStore.get(req.params.id)) return res.status(404).json({ error: 'Run not found' });
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders?.();

    for (const event of runStore.events(req.params.id, { after: parseCursor(req), limit: 5000 })) {
      sendEvent(res, event);
    }
    const unsubscribe = runStore.subscribe(req.params.id, event => sendEvent(res, event));
    const keepalive = setInterval(() => {
      try { res.write(`: keepalive ${Date.now()}\n\n`); } catch (_) {}
    }, 25000);
    req.on('close', () => {
      clearInterval(keepalive);
      unsubscribe();
    });
  });

  app.post('/api/agent-runs/:id/controls', (req, res) => {
    if (!runStore.get(req.params.id)) return res.status(404).json({ error: 'Run not found' });
    try {
      const control = runStore.enqueueControl(req.params.id, req.body?.action, req.body?.payload || {});
      res.status(202).json({ ok: true, control });
    } catch (error) {
      res.status(400).json({ error: error.message });
    }
  });

  app.post('/api/agent-runs/:id/pauses/:pauseId/resolve', (req, res) => {
    if (!runStore.get(req.params.id)) return res.status(404).json({ error: 'Run not found' });
    const pause = runStore.resolvePause(req.params.id, req.params.pauseId, req.body || {});
    if (!pause) return res.status(409).json({ error: 'Pause is no longer pending' });
    if (req.body?.finalize === true) runStore.setStatus(req.params.id, 'completed', { resumedBy: 'user' });
    res.json({ ok: true, pause });
  });
}
