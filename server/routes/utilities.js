export function registerUtilityRoutes(app, deps) {
  const {
    fs,
    path,
    os,
    execSync,
    exec,
    requireElectron,
    isWin,
    rootDir,
    resolvePath,
  } = deps;

  app.post('/api/open-folder', async (req, res) => {
    const { folderPath } = req.body;
    if (!folderPath) return res.status(400).json({ error: 'folderPath required' });
    try {
      const { shell } = requireElectron('electron');
      await shell.openPath(folderPath);
      res.json({ ok: true });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  app.post('/api/window/:action', (req, res) => {
    try {
      const { BrowserWindow } = requireElectron('electron');
      const win = BrowserWindow.getFocusedWindow() || BrowserWindow.getAllWindows()[0];
      if (!win) return res.status(404).json({ error: 'No window' });
      switch (req.params.action) {
        case 'minimize': win.minimize(); break;
        case 'maximize': win.isMaximized() ? win.unmaximize() : win.maximize(); break;
        case 'close': win.close(); break;
        default: return res.status(400).json({ error: 'Unknown action' });
      }
      res.json({ ok: true });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  app.get('/api/preview-file/status', (req, res) => {
    const filePath = req.query.path;
    if (!filePath) return res.json({ ok: false, exists: false, error: 'path required' });
    try {
      const abs = resolvePath(String(filePath));
      const exists = fs.existsSync(abs) && fs.statSync(abs).isFile();
      res.json({ ok: true, exists, path: abs });
    } catch (e) {
      res.json({ ok: false, exists: false, error: e.message });
    }
  });

  app.head('/api/preview-file', (req, res) => {
    const filePath = req.query.path;
    if (!filePath) return res.status(400).end();
    try {
      const abs = resolvePath(String(filePath));
      if (fs.existsSync(abs) && fs.statSync(abs).isFile()) {
        res.setHeader('Content-Type', 'application/octet-stream');
        res.status(200).end();
      } else {
        res.status(404).end();
      }
    } catch (_) {
      res.status(404).end();
    }
  });

  app.get('/api/preview-file', (req, res) => {
    const filePath = req.query.path;
    if (!filePath) return res.status(400).json({ error: 'path required' });
    try {
      const abs = resolvePath(String(filePath));
      if (!fs.existsSync(abs) || !fs.statSync(abs).isFile()) {
        return res.status(404).json({ error: 'File not found', path: abs });
      }
      res.sendFile(abs);
    } catch (e) {
      res.status(404).json({ error: e.message });
    }
  });

  app.get('/api/serve-media', (req, res) => {
    const rawPath = req.query.path;
    if (!rawPath) return res.status(400).end();
    try {
      let abs = path.isAbsolute(rawPath) ? rawPath
        : rawPath.startsWith('~') ? path.join(os.homedir(), rawPath.slice(1))
        : path.join(os.homedir(), rawPath);
      if (!fs.existsSync(abs) || !fs.statSync(abs).isFile()) {
        const dir = path.dirname(abs);
        const basename = path.basename(abs);
        const normalize = s => s.normalize('NFC').replace(/[\u00A0\u2009\u202F\u2007\u200A\uFEFF\u2060]/g, ' ');
        let resolved = null;
        try {
          const entries = fs.readdirSync(dir);
          const match = entries.find(e => normalize(e) === normalize(basename));
          if (match) resolved = path.join(dir, match);
        } catch (_) {}
        if (!resolved) return res.status(404).end();
        abs = resolved;
      }

      const ext = path.extname(abs).toLowerCase().slice(1);
      const mime = {
        mp4: 'video/mp4', mov: 'video/quicktime', webm: 'video/webm', mkv: 'video/x-matroska', avi: 'video/x-msvideo',
        mp3: 'audio/mpeg', wav: 'audio/wav', ogg: 'audio/ogg', aac: 'audio/aac', m4a: 'audio/mp4', flac: 'audio/flac',
        png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', svg: 'image/svg+xml',
      }[ext] || 'application/octet-stream';

      const stat = fs.statSync(abs);
      const total = stat.size;
      const range = req.headers.range;

      if (range) {
        const [startStr, endStr] = range.replace(/bytes=/, '').split('-');
        const start = parseInt(startStr, 10);
        const end = endStr ? parseInt(endStr, 10) : Math.min(start + 1024 * 1024 - 1, total - 1);
        const chunkSize = end - start + 1;
        res.writeHead(206, {
          'Content-Range': `bytes ${start}-${end}/${total}`,
          'Accept-Ranges': 'bytes',
          'Content-Length': chunkSize,
          'Content-Type': mime,
        });
        fs.createReadStream(abs, { start, end }).pipe(res);
      } else {
        res.writeHead(200, { 'Content-Length': total, 'Content-Type': mime, 'Accept-Ranges': 'bytes' });
        fs.createReadStream(abs).pipe(res);
      }
    } catch (_) {
      res.status(500).end();
    }
  });

  app.post('/api/pick-folder', async (req, res) => {
    try {
      const { dialog, BrowserWindow } = requireElectron('electron');
      const win = BrowserWindow.getFocusedWindow() || BrowserWindow.getAllWindows()[0];
      const result = await dialog.showOpenDialog(win || undefined, {
        properties: ['openDirectory', 'createDirectory'],
      });
      if (result.cancelled || !result.filePaths || !result.filePaths.length) {
        return res.json({ ok: false, cancelled: true });
      }
      res.json({ ok: true, folderPath: result.filePaths[0] });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  app.post('/api/open-url', async (req, res) => {
    const { url } = req.body || {};
    if (!url) return res.status(400).json({ error: 'url required' });
    if (!/^https?:\/\//i.test(url)) return res.status(400).json({ error: 'Only http/https URLs allowed' });
    try {
      const { shell } = requireElectron('electron');
      await shell.openExternal(url);
      res.json({ ok: true });
    } catch (_) {
      try {
        const opener = isWin ? 'start' : (process.platform === 'darwin' ? 'open' : 'xdg-open');
        exec(`${opener} ${JSON.stringify(url)}`);
        res.json({ ok: true });
      } catch (e) {
        res.status(500).json({ error: e.message });
      }
    }
  });

  app.get('/api/bundled-bin/:bin', (req, res) => {
    const binName = req.params.bin;
    const candidates = [
      path.join(rootDir, 'node_modules', '.bin', binName),
      path.join(rootDir, 'node_modules', '.bin', binName + (isWin ? '.cmd' : '')),
      path.join(process.resourcesPath || '', 'node_modules', '.bin', binName),
    ];
    for (const candidate of candidates) {
      if (fs.existsSync(candidate)) return res.json({ ok: true, path: candidate });
    }
    try {
      const found = execSync(`${isWin ? 'where' : 'which'} ${binName} 2>/dev/null`, { encoding: 'utf8' }).trim().split('\n')[0];
      if (found) return res.json({ ok: true, path: found });
    } catch (_) {}
    res.json({ ok: false, path: binName });
  });

  app.post('/api/rrule/next', (req, res) => {
    const { rrule: rruleStr, count = 3 } = req.body || {};
    if (!rruleStr) return res.status(400).json({ error: 'rrule required' });
    try {
      const occurrences = computeRruleNext(rruleStr, Math.min(count, 20));
      res.json({ occurrences });
    } catch (e) {
      res.status(400).json({ error: e.message });
    }
  });

  app.get('/api/design/directions', (req, res) => {
    res.json({
      directions: [
        { id: 'minimal', name: 'Minimal', description: 'Clean, white space-heavy, monochromatic', palette: ['#ffffff', '#f5f5f5', '#111111', '#555555'] },
        { id: 'bold', name: 'Bold', description: 'High contrast, vivid accent colors, strong typography', palette: ['#0d0d0d', '#ff3b30', '#007aff', '#f5f5f5'] },
        { id: 'warm', name: 'Warm', description: 'Earthy tones, editorial, warm neutrals', palette: ['#fdf6ec', '#d4a574', '#8b5e3c', '#2c1810'] },
        { id: 'dark', name: 'Dark', description: 'Dark mode first, neon accents, techy', palette: ['#0a0a0f', '#1a1a2e', '#7c5cff', '#00d4aa'] },
        { id: 'pastel', name: 'Pastel', description: 'Soft colors, rounded, playful', palette: ['#fce4ec', '#e8f5e9', '#e3f2fd', '#fff9c4'] },
        { id: 'corporate', name: 'Corporate', description: 'Professional, trustworthy, structured', palette: ['#003087', '#0066cc', '#ffffff', '#e8ecf0'] },
      ],
    });
  });

  app.get('/api/design/skills', (req, res) => {
    const skillsDir = path.join(rootDir, 'public', 'design-skills');
    const skills = [];
    try {
      for (const dir of fs.readdirSync(skillsDir)) {
        const md = path.join(skillsDir, dir, 'SKILL.md');
        if (!fs.existsSync(md)) continue;
        const src = fs.readFileSync(md, 'utf8');
        const title = (src.match(/^#\s+(.+)/m) || [])[1] || dir;
        const desc = (src.match(/^(?!#)[^\n]{10,}/m) || [])[0] || '';
        skills.push({ id: dir, name: title.trim(), description: desc.trim().slice(0, 160) });
      }
    } catch (_) {}
    res.json({ skills });
  });

  app.get('/api/design/systems', (req, res) => {
    const systemsDir = path.join(rootDir, 'public', 'design-systems');
    const systems = [];
    try {
      for (const dir of fs.readdirSync(systemsDir)) {
        const md = path.join(systemsDir, dir, 'DESIGN.md');
        if (!fs.existsSync(md)) continue;
        const src = fs.readFileSync(md, 'utf8');
        const title = (src.match(/^#\s+(.+)/m) || [])[1] || dir;
        const desc = (src.match(/^(?!#)[^\n]{10,}/m) || [])[0] || '';
        systems.push({ id: dir, name: title.trim(), description: desc.trim().slice(0, 160) });
      }
    } catch (_) {}
    res.json({ systems });
  });
}

function computeRruleNext(rruleStr, n) {
  const now = new Date();
  const pairs = {};
  const raw = rruleStr.replace(/^RRULE:/i, '');
  raw.split(';').forEach(part => {
    const eq = part.indexOf('=');
    if (eq !== -1) pairs[part.slice(0, eq).toUpperCase()] = part.slice(eq + 1);
  });
  const freq = (pairs.FREQ || 'DAILY').toUpperCase();
  const interval = parseInt(pairs.INTERVAL || '1', 10) || 1;
  const byHour = pairs.BYHOUR ? parseInt(pairs.BYHOUR, 10) : null;
  const byMin = pairs.BYMINUTE ? parseInt(pairs.BYMINUTE, 10) : null;
  const byDay = pairs.BYDAY ? pairs.BYDAY.split(',') : null;
  const dayMap = { SU: 0, MO: 1, TU: 2, WE: 3, TH: 4, FR: 5, SA: 6 };

  const results = [];
  let cur = new Date(now);
  cur.setSeconds(0, 0);
  cur.setMinutes(cur.getMinutes() + 1);
  if (byHour !== null) cur.setHours(byHour, byMin ?? 0, 0, 0);
  if (byMin !== null && byHour === null) cur.setMinutes(byMin, 0, 0);

  let tries = 0;
  while (results.length < n && tries < 10000) {
    tries++;
    const day = cur.getDay();
    let match = true;
    if (byDay) {
      const dayNames = byDay.map(d => d.replace(/^[-+]?\d*/, '').toUpperCase());
      const dayNums = dayNames.map(d => dayMap[d] ?? -1);
      if (!dayNums.includes(day)) match = false;
    }
    if (match && cur > now) {
      results.push(cur.toISOString());
      cur = new Date(cur);
    }
    if (freq === 'MINUTELY') {
      cur.setMinutes(cur.getMinutes() + interval);
    } else if (freq === 'HOURLY') {
      cur.setHours(cur.getHours() + interval);
      if (byMin !== null) cur.setMinutes(byMin, 0, 0);
    } else if (freq === 'DAILY') {
      cur.setDate(cur.getDate() + interval);
      if (byHour !== null) cur.setHours(byHour, byMin ?? 0, 0, 0);
    } else if (freq === 'WEEKLY') {
      cur.setDate(cur.getDate() + 1);
      if (byHour !== null) cur.setHours(byHour, byMin ?? 0, 0, 0);
    } else if (freq === 'MONTHLY') {
      const dom = parseInt(pairs.BYMONTHDAY || String(now.getDate()), 10);
      cur.setMonth(cur.getMonth() + interval, dom);
      if (byHour !== null) cur.setHours(byHour, byMin ?? 0, 0, 0);
    } else {
      cur.setDate(cur.getDate() + 1);
    }
  }
  return results;
}
