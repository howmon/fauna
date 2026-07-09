// Browser action recording routes — CRUD + compile/describe for the recorder.
// The extension start/stop is driven through the existing /api/ext/command
// endpoint (actions record:start / record:stop); persistence of a finished
// recording happens when the extension sends a `recording:complete` WS message
// (handled in server/bridges/ext.js). These routes let the renderer list,
// view, edit, replay-compile, and delete saved recordings.

import {
  saveRecording, listRecordings, getRecording, updateRecording,
  touchRecording, deleteRecording, compileRecording, describeRecording,
} from '../../browser-recordings-store.js';

export function registerRecordingsRoutes(app) {
  // List (summaries)
  app.get('/api/recordings', (req, res) => {
    try { res.json({ ok: true, recordings: listRecordings({ query: req.query.q }) }); }
    catch (e) { res.status(500).json({ ok: false, error: e.message }); }
  });

  // Full recording (with steps)
  app.get('/api/recordings/:id', (req, res) => {
    const rec = getRecording(req.params.id);
    if (!rec) return res.status(404).json({ ok: false, error: 'Not found' });
    res.json({ ok: true, recording: rec });
  });

  // Human/AI-readable outline
  app.get('/api/recordings/:id/describe', (req, res) => {
    const d = describeRecording(req.params.id);
    if (!d) return res.status(404).json({ ok: false, error: 'Not found' });
    res.json({ ok: true, ...d });
  });

  // Compile to replayable browser-ext-action commands
  app.get('/api/recordings/:id/compile', (req, res) => {
    const c = compileRecording(req.params.id);
    if (!c) return res.status(404).json({ ok: false, error: 'Not found' });
    res.json({ ok: true, ...c });
  });

  // Create (or upsert by id) — used by the renderer if it assembles a recording
  app.post('/api/recordings', (req, res) => {
    try { res.json({ ok: true, recording: saveRecording(req.body || {}) }); }
    catch (e) { res.status(500).json({ ok: false, error: e.message }); }
  });

  // Update name/description/tags/steps
  app.patch('/api/recordings/:id', (req, res) => {
    const rec = updateRecording(req.params.id, req.body || {});
    if (!rec) return res.status(404).json({ ok: false, error: 'Not found' });
    res.json({ ok: true, recording: rec });
  });

  // Mark a replay/use
  app.post('/api/recordings/:id/touch', (req, res) => {
    const rec = touchRecording(req.params.id);
    if (!rec) return res.status(404).json({ ok: false, error: 'Not found' });
    res.json({ ok: true, recording: rec });
  });

  // Delete
  app.delete('/api/recordings/:id', (req, res) => {
    const ok = deleteRecording(req.params.id);
    if (!ok) return res.status(404).json({ ok: false, error: 'Not found' });
    res.json({ ok: true });
  });
}
