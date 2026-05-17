export function registerProjectRunRoutes(app, deps) {
  const {
    express,
    fs,
    path,
    os,
    spawn,
    getProject,
    shellBin,
    isWin,
    augmentedPath,
  } = deps;

  const projectRuns = new Map();
  const projectTerminals = new Map();

  function runId() {
    return 'run-' + Date.now() + '-' + Math.random().toString(36).slice(2, 6);
  }

  function termId() {
    return 'term-' + Date.now() + '-' + Math.random().toString(36).slice(2, 6);
  }

  app.get('/api/projects/:id/runs', (req, res) => {
    const list = [];
    for (const run of projectRuns.values()) {
      if (run.projectId === req.params.id) {
        list.push({
          runId: run.runId,
          name: run.name,
          cmd: run.cmd,
          port: run.port,
          srcName: run.srcName,
          status: run.status,
        });
      }
    }
    res.json(list);
  });

  app.post('/api/projects/:id/sources/:srcId/run', (req, res) => {
    const { cmd, name, port } = req.body || {};
    if (!cmd) return res.status(400).json({ error: 'cmd required' });
    const project = getProject(req.params.id);
    if (!project) return res.status(404).json({ error: 'Project not found' });
    const source = (project.sources || []).find(item => item.id === req.params.srcId);
    const sourcePath = source?.path || project.rootPath || os.homedir();

    const id = runId();
    const env = { ...process.env, PATH: augmentedPath, HOME: os.homedir() };
    const child = spawn(shellBin, ['-c', cmd], {
      cwd: sourcePath || os.homedir(),
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    const record = {
      runId: id,
      projectId: req.params.id,
      srcId: req.params.srcId,
      srcName: source?.name || req.params.srcId,
      name: name || cmd.split(' ')[0],
      cmd,
      port: port || null,
      status: 'starting',
      child,
      sseClients: new Set(),
      logBuf: [],
    };
    projectRuns.set(id, record);

    function emit(line, statusUpdate) {
      record.logBuf.push(line);
      if (record.logBuf.length > 5000) record.logBuf.shift();
      const payload = JSON.stringify({ line, status: statusUpdate || undefined });
      for (const sse of record.sseClients) {
        try { sse.write(`data: ${payload}\n\n`); } catch (_) {}
      }
    }

    child.stdout.on('data', chunk => {
      const text = chunk.toString();
      if (!record.port) {
        const match = text.match(/(?:localhost|127\.0\.0\.1|port)[:\s]+(\d{4,5})/i);
        if (match) {
          record.port = parseInt(match[1], 10);
          emit('', undefined);
        }
      }
      for (const line of text.split('\n')) {
        if (line) emit(line);
      }
      if (record.status === 'starting') {
        record.status = 'running';
        emit('', 'running');
      }
    });

    child.stderr.on('data', chunk => {
      const text = chunk.toString();
      for (const line of text.split('\n')) {
        if (line) emit(line);
      }
      if (record.status === 'starting') {
        record.status = 'running';
        emit('', 'running');
      }
    });

    child.on('exit', code => {
      record.status = code === 0 ? 'stopped' : 'exited';
      record.child = null;
      emit('', record.status);
    });

    child.on('error', err => {
      record.status = 'error';
      record.child = null;
      emit('[Error: ' + err.message + ']', 'error');
    });

    res.json({ ok: true, runId: id });
  });

  app.delete('/api/projects/:id/runs/:runId', (req, res) => {
    const record = projectRuns.get(req.params.runId);
    if (!record) return res.status(404).json({ error: 'Run not found' });
    if (record.child) {
      try { record.child.kill('SIGTERM'); } catch (_) {}
      setTimeout(() => {
        try { if (record.child) record.child.kill('SIGKILL'); } catch (_) {}
      }, 3000);
    }
    record.status = 'stopped';
    record.child = null;
    projectRuns.delete(req.params.runId);
    res.json({ ok: true });
  });

  app.get('/api/projects/:id/runs/:runId/logs', (req, res) => {
    const record = projectRuns.get(req.params.runId);
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders?.();
    if (!record) {
      res.write(`data: ${JSON.stringify({ line: '[Run not found]', status: 'error' })}\n\n`);
      return res.end();
    }
    for (const line of record.logBuf) {
      res.write(`data: ${JSON.stringify({ line })}\n\n`);
    }
    res.write(`data: ${JSON.stringify({ status: record.status })}\n\n`);
    record.sseClients.add(res);
    req.on('close', () => { record.sseClients.delete(res); });
  });

  app.get('/api/projects/:id/sources/:srcId/run-commands', (req, res) => {
    const project = getProject(req.params.id);
    if (!project) return res.status(404).json({ error: 'Project not found' });
    const source = (project.sources || []).find(item => item.id === req.params.srcId);
    const sourcePath = source?.path || project.rootPath || '';

    const commands = [];
    const stack = [];

    if (!sourcePath || !fs.existsSync(sourcePath)) return res.json({ commands, stack });

    const packagePath = path.join(sourcePath, 'package.json');
    if (fs.existsSync(packagePath)) {
      try {
        const pkg = JSON.parse(fs.readFileSync(packagePath, 'utf8'));
        const scripts = pkg.scripts || {};
        for (const scriptName of ['dev', 'start', 'serve', 'preview']) {
          if (scripts[scriptName]) commands.push({ label: `npm run ${scriptName}`, cmd: `npm run ${scriptName}`, detected: true });
        }
        const deps = { ...pkg.dependencies, ...pkg.devDependencies };
        if (deps.next) stack.push('Next.js');
        if (deps.react) stack.push('React');
        if (deps.vue) stack.push('Vue');
        if (deps.svelte) stack.push('Svelte');
        if (deps.vite) stack.push('Vite');
        if (deps.express || deps.fastify || deps.koa) stack.push('Node.js');
      } catch (_) {}
    }

    for (const fileName of ['manage.py', 'app.py', 'main.py', 'run.py']) {
      if (fs.existsSync(path.join(sourcePath, fileName))) {
        if (fileName === 'manage.py') {
          commands.push({ label: 'python manage.py runserver', cmd: 'python manage.py runserver', detected: true });
          stack.push('Django');
        } else {
          commands.push({ label: `python ${fileName}`, cmd: `python ${fileName}`, detected: true });
          stack.push('Python');
        }
        break;
      }
    }

    if (fs.existsSync(path.join(sourcePath, 'Makefile')) || fs.existsSync(path.join(sourcePath, 'makefile'))) {
      commands.push({ label: 'make', cmd: 'make', detected: true });
    }

    if (fs.existsSync(path.join(sourcePath, 'docker-compose.yml')) || fs.existsSync(path.join(sourcePath, 'docker-compose.yaml'))) {
      commands.push({ label: 'docker compose up', cmd: 'docker compose up', detected: true });
      stack.push('Docker');
    }

    if (fs.existsSync(path.join(sourcePath, 'go.mod'))) {
      commands.push({ label: 'go run .', cmd: 'go run .', detected: true });
      stack.push('Go');
    }

    if (fs.existsSync(path.join(sourcePath, 'Cargo.toml'))) {
      commands.push({ label: 'cargo run', cmd: 'cargo run', detected: true });
      stack.push('Rust');
    }

    res.json({ commands: commands.slice(0, 8), stack });
  });

  app.post('/api/projects/:id/terminal', (req, res) => {
    const project = getProject(req.params.id);
    if (!project) return res.status(404).json({ error: 'Project not found' });
    const cwd = project.rootPath && fs.existsSync(project.rootPath) ? project.rootPath : os.homedir();

    const id = termId();
    const env = { ...process.env, PATH: augmentedPath, HOME: os.homedir(), TERM: 'xterm-256color' };

    const child = spawn(shellBin, isWin ? [] : ['-i', '-l'], {
      cwd,
      env,
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    const session = { termId: id, projectId: req.params.id, child, sseClients: new Set(), buf: '' };
    projectTerminals.set(id, session);

    function emit(out) {
      session.buf += out;
      if (session.buf.length > 200000) session.buf = session.buf.slice(-150000);
      const payload = JSON.stringify({ out });
      for (const sse of session.sseClients) {
        try { sse.write(`data: ${payload}\n\n`); } catch (_) {}
      }
    }

    child.stdout.on('data', chunk => emit(chunk.toString()));
    child.stderr.on('data', chunk => emit(chunk.toString()));
    child.on('exit', () => {
      projectTerminals.delete(id);
      const payload = JSON.stringify({ out: '\r\n[Shell exited]\r\n' });
      for (const sse of session.sseClients) {
        try { sse.write(`data: ${payload}\n\n`); sse.end(); } catch (_) {}
      }
    });
    child.on('error', err => {
      const payload = JSON.stringify({ out: `\r\n[Error: ${err.message}]\r\n` });
      for (const sse of session.sseClients) {
        try { sse.write(`data: ${payload}\n\n`); sse.end(); } catch (_) {}
      }
      projectTerminals.delete(id);
    });

    res.json({ ok: true, termId: id });
  });

  app.delete('/api/projects/:id/terminal/:termId', (req, res) => {
    const session = projectTerminals.get(req.params.termId);
    if (!session) return res.json({ ok: true, already: true });
    if (session.child) {
      try { session.child.kill('SIGHUP'); } catch (_) {}
      setTimeout(() => {
        try { if (session.child) session.child.kill('SIGKILL'); } catch (_) {}
      }, 2000);
    }
    for (const sse of session.sseClients) {
      try { sse.end(); } catch (_) {}
    }
    projectTerminals.delete(req.params.termId);
    res.json({ ok: true });
  });

  app.post('/api/projects/:id/terminal/:termId/input', express.json({ limit: '64kb' }), (req, res) => {
    const session = projectTerminals.get(req.params.termId);
    if (!session) return res.status(404).json({ error: 'Terminal not found' });
    const data = req.body?.data ?? '';
    try {
      if (session.child && session.child.stdin && !session.child.stdin.destroyed) {
        session.child.stdin.write(data);
      }
      res.json({ ok: true });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  app.get('/api/projects/:id/terminal/:termId/output', (req, res) => {
    const session = projectTerminals.get(req.params.termId);
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders?.();
    if (!session) {
      res.write(`data: ${JSON.stringify({ out: '[Terminal not found or closed]\r\n' })}\n\n`);
      return res.end();
    }
    if (session.buf) res.write(`data: ${JSON.stringify({ out: session.buf })}\n\n`);
    session.sseClients.add(res);
    req.on('close', () => { session.sseClients.delete(res); });
  });
}
