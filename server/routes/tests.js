import crypto from 'crypto';
import net from 'net';
import path from 'path';
import WebSocket from 'ws';
import { buildTestCommand, discoverWorkspaceTests, normalizeTestRun } from '../../lib/test-service.js';
import { runShell } from '../lib/shell-runner.js';

class InspectorClient {
  constructor(url, onEvent) {
    this.url = url;
    this.onEvent = onEvent;
    this.nextId = 1;
    this.pending = new Map();
    this.scripts = new Map();
    this.socket = null;
  }

  connect() {
    return new Promise((resolve, reject) => {
      const socket = new WebSocket(this.url);
      this.socket = socket;
      socket.once('open', resolve);
      socket.once('error', reject);
      socket.on('message', data => {
        let message;
        try { message = JSON.parse(String(data)); } catch (_) { return; }
        if (message.id) {
          const pending = this.pending.get(message.id);
          if (!pending) return;
          this.pending.delete(message.id);
          if (message.error) pending.reject(new Error(message.error.message));
          else pending.resolve(message.result || {});
          return;
        }
        if (message.method === 'Debugger.scriptParsed') this.scripts.set(message.params.scriptId, message.params.url || '');
        this.onEvent?.(message.method, message.params || {});
      });
      socket.on('close', () => this.onEvent?.('Inspector.detached', {}));
    });
  }

  send(method, params = {}) {
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) return Promise.reject(new Error('Debugger is not connected.'));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.socket.send(JSON.stringify({ id, method, params }));
    });
  }

  close() { try { this.socket?.close(); } catch (_) {} }
}

function _remoteValue(value) {
  if (!value) return '';
  if (Object.prototype.hasOwnProperty.call(value, 'value')) return String(value.value);
  return String(value.description || value.unserializableValue || value.type || '');
}

function _freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      server.close(error => error ? reject(error) : resolve(port));
    });
  });
}

export function createTestRunManager({ shellBin, isWin, augmentedPath, runCommand = runShell } = {}) {
  const runs = new Map();
  const listeners = new Set();

  function emit(event) {
    for (const listener of listeners) {
      try { listener(event); } catch (_) {}
    }
  }

  function publicRun(run) {
    if (!run) return null;
    const { controller, _inspector, ...safe } = run;
    return safe;
  }

  async function attachDebugger(run, inspectorUrl, location) {
    if (run._inspector || run.status !== 'running') return;
    run.debugger = { status: 'connecting', inspectorUrl, paused: false, frames: [], scopes: [] };
    emit({ type: 'debug', run: publicRun(run) });
    let debuggerReady = false;
    let startupPausePending = false;
    let startupPauseSkipped = false;
    const inspector = new InspectorClient(inspectorUrl, async (method, params) => {
      if (method === 'Debugger.paused') {
        const firstLine = Number(params.callFrames?.[0]?.location?.lineNumber || 0) + 1;
        const isStartupPause = !startupPauseSkipped && (params.reason === 'Break on start' || firstLine === 1);
        if (isStartupPause) {
          if (!debuggerReady) { startupPausePending = true; return; }
          startupPauseSkipped = true;
          try { await inspector.send('Debugger.resume'); } catch (_) {}
          return;
        }
        const frames = (params.callFrames || []).slice(0, 30).map(frame => ({
          id: frame.callFrameId,
          name: frame.functionName || '(anonymous)',
          file: (() => {
            const url = inspector.scripts.get(frame.location.scriptId) || '';
            let absolute = url;
            try { if (url.startsWith('file://')) absolute = decodeURIComponent(new URL(url).pathname); } catch (_) {}
            const relative = absolute ? path.relative(run.root, absolute).split(path.sep).join('/') : '';
            return relative && !relative.startsWith('..') ? relative : '';
          })(),
          line: Number(frame.location.lineNumber || 0) + 1,
          column: Number(frame.location.columnNumber || 0) + 1,
        }));
        const scopes = [];
        for (const scope of (params.callFrames?.[0]?.scopeChain || []).slice(0, 8)) {
          if (!scope.object?.objectId) continue;
          try {
            const result = await inspector.send('Runtime.getProperties', { objectId: scope.object.objectId, ownProperties: true, generatePreview: true });
            scopes.push({
              name: scope.name || scope.type,
              type: scope.type,
              variables: (result.result || []).filter(item => item.enumerable !== false).slice(0, 100).map(item => ({ name: item.name, value: _remoteValue(item.value), type: item.value?.type || '' })),
            });
          } catch (_) {}
        }
        run.debugger = { ...run.debugger, status: 'paused', paused: true, reason: params.reason || 'breakpoint', frames, scopes };
        emit({ type: 'debug', run: publicRun(run) });
      } else if (method === 'Debugger.resumed') {
        run.debugger = { ...run.debugger, status: 'running', paused: false, frames: [], scopes: [] };
        emit({ type: 'debug', run: publicRun(run) });
      } else if (method === 'Inspector.detached') {
        run.debugger = { ...run.debugger, status: 'disconnected', paused: false };
        emit({ type: 'debug', run: publicRun(run) });
      }
    });
    run._inspector = inspector;
    try {
      await inspector.connect();
      await inspector.send('Runtime.enable');
      await inspector.send('Debugger.enable');
      if (location.file && location.line) {
        const absolute = path.resolve(run.root, location.file).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        await inspector.send('Debugger.setBreakpointByUrl', {
          urlRegex: absolute + '$',
          lineNumber: Math.max(0, Number(location.line) - 1),
          columnNumber: Math.max(0, Number(location.column || 1) - 1),
        });
      }
      run.debugger = { ...run.debugger, status: 'running', connected: true };
      emit({ type: 'debug', run: publicRun(run) });
      debuggerReady = true;
      await inspector.send('Runtime.runIfWaitingForDebugger');
      if (startupPausePending && !startupPauseSkipped) {
        startupPauseSkipped = true;
        await inspector.send('Debugger.resume');
      }
    } catch (error) {
      run.debugger = { ...run.debugger, status: 'error', error: error.message };
      emit({ type: 'debug', run: publicRun(run) });
    }
  }

  async function start({ root, framework, file, fullName, debug = false, line = null, column = null }) {
    const active = Array.from(runs.values()).find(run => run.root === root && run.status === 'running');
    if (active) throw new Error('A test run is already active for this project.');
    const id = crypto.randomUUID();
    const controller = new AbortController();
    const debugPort = debug && framework !== 'playwright' ? await _freePort() : null;
    const command = buildTestCommand({ framework, file, fullName, debug, debugPort: debugPort || undefined });
    const run = {
      id, root, framework, file: file || null, fullName: fullName || null, debug, debugPort,
      command, status: 'running', startedAt: Date.now(), finishedAt: null,
      output: '', result: null, debugger: debug ? { status: framework === 'playwright' ? 'external' : 'waiting', paused: false, frames: [], scopes: [] } : null, controller,
    };
    runs.set(id, run);
    emit({ type: 'started', run: publicRun(run) });
    runCommand({
      command, cwd: root, shellBin, isWin, augmentedPath,
      timeoutMs: debug ? 30 * 60 * 1000 : 10 * 60 * 1000,
      maxOutputChars: 500000,
      signal: controller.signal,
      onChunk(kind, text) {
        run.output = (run.output + text).slice(-100000);
        emit({ type: 'output', runId: id, kind, text });
        if (debug && framework !== 'playwright') {
          const match = text.match(/Debugger listening on (ws:\/\/[^\s]+)/);
          if (match) attachDebugger(run, match[1], { file, line, column });
        }
      },
    }).then(shellResult => {
      run.status = shellResult.killed ? 'cancelled' : (shellResult.ok ? 'passed' : 'failed');
      run.finishedAt = Date.now();
      run.result = normalizeTestRun({ ...shellResult, framework, root, fullName });
      run.output = run.result.output;
      run._inspector?.close();
      emit({ type: 'finished', run: publicRun(run) });
    }).catch(error => {
      run.status = 'failed';
      run.finishedAt = Date.now();
      run.result = { ok: false, framework, counts: { passed: 0, failed: 1, skipped: 0 }, tests: [], problems: [], output: error.message };
      emit({ type: 'finished', run: publicRun(run) });
    });
    return publicRun(run);
  }

  function stop(id) {
    const run = runs.get(id);
    if (!run || run.status !== 'running') return false;
    run.controller.abort();
    return true;
  }

  async function debugAction(id, action) {
    const run = runs.get(id);
    if (!run?._inspector) throw new Error('Debugger is not connected.');
    const methods = { resume: 'Debugger.resume', pause: 'Debugger.pause', stepOver: 'Debugger.stepOver', stepInto: 'Debugger.stepInto', stepOut: 'Debugger.stepOut' };
    if (!methods[action]) throw new Error('Unknown debug action.');
    await run._inspector.send(methods[action]);
    return publicRun(run);
  }

  return {
    start,
    stop,
    debugAction,
    get: id => publicRun(runs.get(id)),
    latest: root => publicRun(Array.from(runs.values()).filter(run => run.root === root).sort((a, b) => b.startedAt - a.startedAt)[0]),
    subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
  };
}

export function registerTestRoutes(app, deps = {}) {
  const manager = deps.manager || createTestRunManager(deps);

  function projectRoot(req, res) {
    const project = deps.getProject?.(req.params.id);
    if (!project) { res.status(404).json({ ok: false, error: 'Project not found.' }); return null; }
    if (!project.rootPath) { res.status(400).json({ ok: false, error: 'Project has no working folder.' }); return null; }
    return path.resolve(project.rootPath);
  }

  app.get('/api/projects/:id/tests', (req, res) => {
    const root = projectRoot(req, res);
    if (!root) return;
    try { res.json({ ...discoverWorkspaceTests({ cwd: root }), run: manager.latest(root) }); }
    catch (error) { res.status(500).json({ ok: false, error: error.message }); }
  });

  app.post('/api/projects/:id/tests/run', async (req, res) => {
    const root = projectRoot(req, res);
    if (!root) return;
    try {
      const discovery = discoverWorkspaceTests({ cwd: root });
      const file = req.body.file ? String(req.body.file) : null;
      if (file && !discovery.files.some(item => item.path === file)) return res.status(400).json({ ok: false, error: 'Unknown test file.' });
      const run = await manager.start({ root, framework: discovery.framework, file, fullName: req.body.fullName, debug: req.body.debug === true, line: req.body.line, column: req.body.column });
      res.status(202).json({ ok: true, run });
    } catch (error) { res.status(409).json({ ok: false, error: error.message }); }
  });

  app.get('/api/projects/:id/tests/runs/:runId', (req, res) => {
    const root = projectRoot(req, res);
    if (!root) return;
    const run = manager.get(req.params.runId);
    if (!run || run.root !== root) return res.status(404).json({ ok: false, error: 'Test run not found.' });
    res.json({ ok: true, run });
  });

  app.delete('/api/projects/:id/tests/runs/:runId', (req, res) => {
    const root = projectRoot(req, res);
    if (!root) return;
    const run = manager.get(req.params.runId);
    if (!run || run.root !== root) return res.status(404).json({ ok: false, error: 'Test run not found.' });
    res.json({ ok: manager.stop(req.params.runId) });
  });

  app.post('/api/projects/:id/tests/runs/:runId/debug', async (req, res) => {
    const root = projectRoot(req, res);
    if (!root) return;
    const run = manager.get(req.params.runId);
    if (!run || run.root !== root) return res.status(404).json({ ok: false, error: 'Test run not found.' });
    try { res.json({ ok: true, run: await manager.debugAction(req.params.runId, req.body.action) }); }
    catch (error) { res.status(409).json({ ok: false, error: error.message }); }
  });

  app.get('/api/tests/events', (req, res) => {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders?.();
    res.write('data: {"type":"ready"}\n\n');
    const unsubscribe = manager.subscribe(event => res.write(`data: ${JSON.stringify(event)}\n\n`));
    req.on('close', unsubscribe);
  });

  return manager;
}