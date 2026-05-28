// Video routes — /api/video/*
//
// Exposes the video-job pipeline over HTTP+SSE so:
//   - the Video Studio widget can drive the pipeline and stream progress
//   - the model can also drive it via fauna_video_* self-tools (which call
//     directly into ./video/job.js without HTTP)
//   - the file route lets the widget <video> element load final.mp4

import fs from 'fs';
import path from 'path';
import {
  createJob, getJob, listJobs, deleteJob, patchJob,
  runStep, runAll, subscribe, STEPS,
} from '../video/job.js';

export function registerVideoRoutes(app, { getCopilotClient }) {
  // CORS: the Video Studio widget runs in a sandboxed iframe (null origin) so
  // its fetch / EventSource requests are cross-origin. Loopback-only routes,
  // safe to allow * here.
  app.use('/api/video', (req, res, next) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET,POST,DELETE,OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    if (req.method === 'OPTIONS') return res.sendStatus(204);
    next();
  });

  app.get('/api/video/jobs', (_req, res) => {
    res.json({ ok: true, jobs: listJobs() });
  });

  app.post('/api/video/jobs', (req, res) => {
    try {
      const job = createJob(req.body || {});
      res.json({ ok: true, job });
    } catch (e) {
      res.status(400).json({ ok: false, error: e.message });
    }
  });

  app.get('/api/video/jobs/:id', (req, res) => {
    const job = getJob(req.params.id);
    if (!job) return res.status(404).json({ ok: false, error: 'not found' });
    res.json(job);
  });

  app.delete('/api/video/jobs/:id', (req, res) => {
    deleteJob(req.params.id);
    res.json({ ok: true });
  });

  app.post('/api/video/jobs/:id/patch', (req, res) => {
    try {
      const r = patchJob(req.params.id, req.body || {});
      res.json({ ok: true, ...r });
    } catch (e) {
      res.status(400).json({ ok: false, error: e.message });
    }
  });

  app.post('/api/video/jobs/:id/step/:step', async (req, res) => {
    try {
      if (!STEPS.includes(req.params.step)) {
        return res.status(400).json({ ok: false, error: 'unknown step' });
      }
      const force = req.body?.force === true || req.query.force === '1';
      const job = await runStep(req.params.id, req.params.step, { client: getCopilotClient?.(), force });
      res.json({ ok: true, job });
    } catch (e) {
      res.status(500).json({ ok: false, error: e.message });
    }
  });

  app.post('/api/video/jobs/:id/run-all', async (req, res) => {
    try {
      // Don't await — let it stream via SSE. Reply immediately.
      runAll(req.params.id, { client: getCopilotClient?.() }).catch(() => {});
      res.json({ ok: true, started: true });
    } catch (e) {
      res.status(500).json({ ok: false, error: e.message });
    }
  });

  app.get('/api/video/jobs/:id/events', (req, res) => {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders?.();
    res.write(`data: ${JSON.stringify({ status: 'connected' })}\n\n`);
    const unsub = subscribe(req.params.id, (evt) => {
      try { res.write(`data: ${JSON.stringify(evt)}\n\n`); } catch (_) {}
    });
    req.on('close', () => unsub());
  });

  // Serve an artifact file (final.mp4, combined.mp4, audio.mp3, subtitles.srt).
  app.get('/api/video/jobs/:id/file', (req, res) => {
    const job = getJob(req.params.id);
    if (!job) return res.status(404).end();
    const which = String(req.query.path || 'final');
    const map = {
      final: job.artifacts.finalPath,
      combined: job.artifacts.combinedPath,
      audio: job.artifacts.audioFile,
      subtitle: job.artifacts.subtitlePath,
    };
    const f = map[which];
    if (!f || !fs.existsSync(f)) return res.status(404).end();
    // Range support for <video> seeking.
    const stat = fs.statSync(f);
    const range = req.headers.range;
    const contentType = f.endsWith('.mp4') ? 'video/mp4'
      : f.endsWith('.mp3') ? 'audio/mpeg'
      : f.endsWith('.srt') ? 'text/plain'
      : 'application/octet-stream';
    if (range) {
      const m = /bytes=(\d+)-(\d*)/.exec(range);
      const start = m ? Number(m[1]) : 0;
      const end = m && m[2] ? Number(m[2]) : stat.size - 1;
      res.writeHead(206, {
        'Content-Range': `bytes ${start}-${end}/${stat.size}`,
        'Accept-Ranges': 'bytes',
        'Content-Length': end - start + 1,
        'Content-Type': contentType,
      });
      fs.createReadStream(f, { start, end }).pipe(res);
    } else {
      res.writeHead(200, { 'Content-Length': stat.size, 'Content-Type': contentType, 'Accept-Ranges': 'bytes' });
      fs.createReadStream(f).pipe(res);
    }
  });
}
