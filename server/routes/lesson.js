// Lesson HTTP route — serves per-scene mp3s with Range support and the
// lesson JSON for the runtime widget to (re)hydrate state.

import fs from 'fs';
import { lessonAudioPath, loadLesson } from '../lesson/generator.js';

export function registerLessonRoutes(app) {
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
}
