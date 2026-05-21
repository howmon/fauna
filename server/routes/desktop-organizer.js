// Desktop organizer — POST /api/organize-desktop categorises files on
// ~/Desktop and moves them into named subfolders. dryRun=true (default)
// returns the plan without touching the filesystem.

import fs from 'fs';
import os from 'os';
import path from 'path';

const ORGANIZE_RULES = [
  { folder: 'Screenshots',       test: n => /^Screenshot\s/.test(n) && /\.(png|jpg|jpeg)$/i.test(n) },
  { folder: 'Screen Recordings', test: n => /\.(mov|mp4|mkv|webm)$/i.test(n) },
  { folder: 'Images',            test: n => /\.(png|jpg|jpeg|gif|webp|heic|svg|tiff|bmp)$/i.test(n) },
  { folder: 'Documents',         test: n => /\.(pdf|doc|docx|txt|pages|xls|xlsx|csv|ppt|pptx|numbers|key|rtf|md)$/i.test(n) },
  { folder: 'Archives',          test: n => /\.(zip|tar|gz|bz2|dmg|pkg|rar|7z)$/i.test(n) },
  { folder: 'Code',              test: n => /\.(js|ts|py|rb|sh|zsh|bash|json|html|css|swift|go|rs|cpp|c|h|java)$/i.test(n) },
];

export function registerDesktopOrganizerRoutes(app) {
  app.post('/api/organize-desktop', (req, res) => {
    const dryRun  = req.body?.dryRun !== false; // default dry-run for safety
    const desktop = path.join(os.homedir(), 'Desktop');

    let entries;
    try { entries = fs.readdirSync(desktop); }
    catch (e) { return res.json({ ok: false, error: e.message }); }

    const moves    = [];  // { file, from, to, folder }
    const skipped  = [];  // dirs or unmatched

    for (const name of entries) {
      const fullPath = path.join(desktop, name);
      let stat;
      try { stat = fs.statSync(fullPath); } catch (_) { continue; }
      if (stat.isDirectory()) { skipped.push(name); continue; }

      const rule = ORGANIZE_RULES.find(r => r.test(name));
      if (rule) {
        moves.push({ file: name, from: fullPath, to: path.join(desktop, rule.folder, name), folder: rule.folder });
      } else {
        skipped.push(name);
      }
    }

    if (!dryRun) {
      const created = new Set();
      const done = [], errors = [];
      for (const m of moves) {
        try {
          const dir = path.dirname(m.to);
          if (!created.has(dir)) { fs.mkdirSync(dir, { recursive: true }); created.add(dir); }
          // Avoid overwriting: rename if destination exists
          let dest = m.to;
          if (fs.existsSync(dest)) {
            const ext  = path.extname(m.file);
            const base = path.basename(m.file, ext);
            dest = path.join(path.dirname(dest), `${base}_${Date.now()}${ext}`);
          }
          fs.renameSync(m.from, dest);
          done.push({ ...m, to: dest });
        } catch (e) {
          errors.push({ file: m.file, error: e.message });
        }
      }
      return res.json({ ok: true, dryRun: false, moved: done.length, done, errors, skipped });
    }

    res.json({ ok: true, dryRun: true, moves, skipped,
      summary: Object.entries(moves.reduce((acc, m) => {
        acc[m.folder] = (acc[m.folder] || 0) + 1; return acc;
      }, {})).map(([f, c]) => `${f} (${c})`).join(', ')
    });
  });
}
