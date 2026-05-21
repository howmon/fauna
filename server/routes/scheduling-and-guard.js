// Heartbeat + Scheduled Workflows + Permission Guard routes.
// Pure route bundle — all stateful logic lives in heartbeat.js,
// workflow-manager.js, and permission-guard.js (this file just maps
// HTTP endpoints onto their exports).

import {
  getSettings as hbGetSettings, updateSettings as hbUpdateSettings,
  getLog as hbGetLog, clearLog as hbClearLog, runHeartbeat,
} from '../../heartbeat.js';
import {
  createWorkflow, getWorkflow, getAllWorkflows, updateWorkflow, deleteWorkflow,
  getHistory as wfGetHistory, runWorkflow, parseSchedule,
} from '../../workflow-manager.js';
import {
  isCommandSafe, addAutoAllow, getAutoAllowList, removeAutoAllow, clearAutoAllow,
} from '../../permission-guard.js';

export function registerSchedulingAndGuardRoutes(app) {
  // ── Heartbeat Monitoring ────────────────────────────────────────────────
  app.get('/api/heartbeat/settings', (req, res) => {
    res.json(hbGetSettings());
  });

  app.put('/api/heartbeat/settings', (req, res) => {
    const settings = hbUpdateSettings(req.body);
    res.json(settings);
  });

  app.get('/api/heartbeat/log', (req, res) => {
    res.json(hbGetLog());
  });

  app.post('/api/heartbeat/clear-log', (req, res) => {
    hbClearLog();
    res.json({ ok: true });
  });

  app.post('/api/heartbeat/run-now', async (req, res) => {
    try {
      const result = await runHeartbeat(true);
      res.json(result);
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  // ── Scheduled Workflows ─────────────────────────────────────────────────
  app.get('/api/workflows', (req, res) => {
    res.json(getAllWorkflows());
  });

  app.post('/api/workflows', (req, res) => {
    const wf = createWorkflow(req.body);
    res.json(wf);
  });

  app.get('/api/workflows/:id', (req, res) => {
    const wf = getWorkflow(req.params.id);
    if (!wf) return res.status(404).json({ error: 'Workflow not found' });
    res.json(wf);
  });

  app.put('/api/workflows/:id', (req, res) => {
    const wf = updateWorkflow(req.params.id, req.body);
    if (!wf) return res.status(404).json({ error: 'Workflow not found' });
    res.json(wf);
  });

  app.delete('/api/workflows/:id', (req, res) => {
    const ok = deleteWorkflow(req.params.id);
    if (!ok) return res.status(404).json({ error: 'Workflow not found' });
    res.json({ ok: true });
  });

  app.post('/api/workflows/:id/run-now', async (req, res) => {
    try {
      const result = await runWorkflow(req.params.id);
      res.json(result);
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  app.get('/api/workflows/:id/history', (req, res) => {
    res.json(wfGetHistory(req.params.id));
  });

  app.post('/api/workflows/parse-schedule', (req, res) => {
    const { text } = req.body || {};
    res.json(parseSchedule(text));
  });

  // ── Permission Guard ────────────────────────────────────────────────────
  app.get('/api/permissions/auto-allow', (req, res) => {
    res.json(getAutoAllowList());
  });

  app.post('/api/permissions/auto-allow', (req, res) => {
    const { command } = req.body || {};
    if (!command) return res.status(400).json({ error: 'command required' });
    addAutoAllow(command);
    res.json({ ok: true });
  });

  app.delete('/api/permissions/auto-allow', (req, res) => {
    const { command } = req.body || {};
    if (command) removeAutoAllow(command);
    else clearAutoAllow();
    res.json({ ok: true });
  });

  app.post('/api/permissions/check', (req, res) => {
    const { command } = req.body || {};
    res.json({ safe: isCommandSafe(command) });
  });
}
