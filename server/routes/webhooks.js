// ── Inbound Webhook Triggers ───────────────────────────────────────────────
// Opt-in, token-gated endpoint that fires an automation when an external
// service calls it. The request payload (JSON body for POST, query for GET)
// is passed into the task as the trigger node's output / autonomy context.
//
// Security: tokens are 192-bit random (crypto.randomBytes), so guessing is
// infeasible. The server binds to 127.0.0.1 only. Payloads are size-bounded
// before being threaded into the run.

const MAX_PAYLOAD_CHARS = 16000;

function _serializePayload(req) {
  let raw;
  if (req.method === 'GET') {
    raw = req.query && Object.keys(req.query).length ? req.query : null;
  } else {
    raw = req.body;
  }
  if (raw == null) return '';
  let str;
  if (typeof raw === 'string') {
    str = raw;
  } else {
    try { str = JSON.stringify(raw, null, 2); }
    catch (_) { str = String(raw); }
  }
  return str.length > MAX_PAYLOAD_CHARS ? str.slice(0, MAX_PAYLOAD_CHARS) : str;
}

export function registerWebhookRoutes(app, deps) {
  const { getTaskByWebhookToken, markWebhookFired, runTask, isTaskRunning } = deps;

  function handle(req, res) {
    const token = req.params.token || '';
    const task = getTaskByWebhookToken(token);
    // Generic 404 for unknown/disabled tokens — do not reveal which case.
    if (!task) return res.status(404).json({ error: 'Not found' });

    if (isTaskRunning(task.id)) {
      return res.status(409).json({ error: 'Task already running', taskId: task.id });
    }

    const payload = _serializePayload(req);
    try { markWebhookFired(task.id); } catch (_) { /* non-fatal */ }

    // Fire-and-forget — webhook callers should not block on full execution.
    runTask(task.id, { trigger: 'webhook', triggerPayload: payload })
      .catch(e => {
        if (e && e.code === 'TASK_ALREADY_RUNNING') return;
        console.error('[webhooks] run failed:', e?.message || e);
      });

    res.status(202).json({ ok: true, taskId: task.id, title: task.title });
  }

  app.post('/api/hooks/:token', handle);
  app.get('/api/hooks/:token', handle);
}
