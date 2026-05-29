// Lesson HTTP route — serves per-scene mp3s with Range support and the
// lesson JSON for the runtime widget to (re)hydrate state.

import fs from 'fs';
import { lessonAudioPath, loadLesson } from '../lesson/generator.js';
import { renderLessonVideo, lessonVideoPath } from '../lesson/video-render.js';
import { buildLessonHtmlBundle, lessonHtmlBundlePath } from '../lesson/html-export.js';

// In-flight video render promises keyed by lessonId, so concurrent requests
// (e.g. double-click on the download button) share one render job.
const _videoJobs = new Map();
const _htmlJobs = new Map();

export function registerLessonRoutes(app, { getElectronBrowserWindow } = {}) {
  app.get('/api/lesson-audio/:lessonId/:filename', (req, res) => {
    const lessonId = String(req.params.lessonId || '');
    const filename = String(req.params.filename || '');
    if (!/^L_[a-z0-9]{8,32}$/i.test(lessonId)) return res.status(400).end();
    const file = lessonAudioPath(lessonId, filename);
    if (!file || !fs.existsSync(file)) return res.status(404).end();
    const stat = fs.statSync(file);
    const range = req.headers.range;
    if (range) {
      const m = /bytes=(\d+)-(\d*)/.exec(range);
      const start = m ? Number(m[1]) : 0;
      const end = m && m[2] ? Number(m[2]) : stat.size - 1;
      res.writeHead(206, {
        'Content-Range': `bytes ${start}-${end}/${stat.size}`,
        'Accept-Ranges': 'bytes',
        'Content-Length': end - start + 1,
        'Content-Type': 'audio/mpeg',
      });
      fs.createReadStream(file, { start, end }).pipe(res);
    } else {
      res.writeHead(200, {
        'Content-Length': stat.size,
        'Content-Type': 'audio/mpeg',
        'Accept-Ranges': 'bytes',
      });
      fs.createReadStream(file).pipe(res);
    }
  });

  app.get('/api/lesson/:id', (req, res) => {
    const id = String(req.params.id || '');
    if (!/^L_[a-z0-9]{8,32}$/i.test(id)) return res.status(400).json({ ok: false, error: 'bad id' });
    const lesson = loadLesson(id);
    if (!lesson) return res.status(404).json({ ok: false, error: 'not found' });
    res.json({ ok: true, id, lesson });
  });

  // Build (on first request) and stream the lesson as a downloadable mp4.
  // ?download=1 forces a Content-Disposition attachment. ?force=1 re-renders.
  app.get('/api/lesson-video/:id', async (req, res) => {
    const id = String(req.params.id || '');
    if (!/^L_[a-z0-9]{8,32}$/i.test(id)) return res.status(400).json({ ok: false, error: 'bad id' });
    const lesson = loadLesson(id);
    if (!lesson) return res.status(404).json({ ok: false, error: 'lesson not found' });
    const force = req.query.force === '1';
    const wantDownload = req.query.download === '1';
    const mp4 = lessonVideoPath(id);
    try {
      if (force || !fs.existsSync(mp4) || fs.statSync(mp4).size === 0) {
        if (!_videoJobs.has(id)) {
          _videoJobs.set(id, renderLessonVideo({
            lessonId: id,
            getBrowserWindow: getElectronBrowserWindow,
            force,
          }).finally(() => _videoJobs.delete(id)));
        }
        await _videoJobs.get(id);
      }
    } catch (err) {
      return res.status(500).json({ ok: false, error: 'render failed: ' + err.message });
    }
    if (!fs.existsSync(mp4)) return res.status(500).json({ ok: false, error: 'mp4 missing after render' });

    const stat = fs.statSync(mp4);
    const safeTitle = String(lesson.title || 'lesson').replace(/[^a-z0-9._-]+/gi, '_').slice(0, 60) || 'lesson';
    const headers = {
      'Content-Type': 'video/mp4',
      'Content-Length': stat.size,
      'Accept-Ranges': 'bytes',
    };
    if (wantDownload) headers['Content-Disposition'] = `attachment; filename="${safeTitle}.mp4"`;
    const range = req.headers.range;
    if (range) {
      const m = /bytes=(\d+)-(\d*)/.exec(range);
      const start = m ? Number(m[1]) : 0;
      const end = m && m[2] ? Number(m[2]) : stat.size - 1;
      res.writeHead(206, {
        ...headers,
        'Content-Range': `bytes ${start}-${end}/${stat.size}`,
        'Content-Length': end - start + 1,
      });
      fs.createReadStream(mp4, { start, end }).pipe(res);
    } else {
      res.writeHead(200, headers);
      fs.createReadStream(mp4).pipe(res);
    }
  });

  // Build (on first request) and stream a portable HTML+audio zip suitable
  // for upload to any static web host.
  app.get('/api/lesson-html/:id', async (req, res) => {
    const id = String(req.params.id || '');
    if (!/^L_[a-z0-9]{8,32}$/i.test(id)) return res.status(400).json({ ok: false, error: 'bad id' });
    const lesson = loadLesson(id);
    if (!lesson) return res.status(404).json({ ok: false, error: 'lesson not found' });
    const force = req.query.force === '1';
    const wantDownload = req.query.download === '1';
    const zipFile = lessonHtmlBundlePath(id);
    try {
      if (force || !fs.existsSync(zipFile) || fs.statSync(zipFile).size === 0) {
        if (!_htmlJobs.has(id)) {
          _htmlJobs.set(id, buildLessonHtmlBundle({ lessonId: id, force }).finally(() => _htmlJobs.delete(id)));
        }
        await _htmlJobs.get(id);
      }
    } catch (err) {
      return res.status(500).json({ ok: false, error: 'bundle failed: ' + err.message });
    }
    if (!fs.existsSync(zipFile)) return res.status(500).json({ ok: false, error: 'zip missing after build' });
    const stat = fs.statSync(zipFile);
    const safeTitle = String(lesson.title || 'lesson').replace(/[^a-z0-9._-]+/gi, '_').slice(0, 60) || 'lesson';
    const headers = {
      'Content-Type': 'application/zip',
      'Content-Length': stat.size,
    };
    if (wantDownload) headers['Content-Disposition'] = `attachment; filename="${safeTitle}-bundle.zip"`;
    res.writeHead(200, headers);
    fs.createReadStream(zipFile).pipe(res);
  });
}
