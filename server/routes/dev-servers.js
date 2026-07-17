// server/routes/dev-servers.js
//
// REST endpoints for the global dev-server registry. Lets the UI list / stop
// / restart background dev servers Fauna has spawned via shell commands.
//
//   GET    /api/dev-servers           — list all tracked entries
//   GET    /api/dev-servers/events     — SSE stream: server-ready / server-exited / heartbeat
//   POST   /api/dev-servers/:id/kill   — SIGTERM the underlying process
//   POST   /api/dev-servers/:id/restart — kill + respawn same command/cwd

import * as registry from '../lib/dev-server-registry.js';

export function registerDevServerRoutes(app, { shellBin, isWin, augmentedPath } = {}) {
  app.get('/api/dev-servers', (_req, res) => {
    res.json({ ok: true, servers: registry.list() });
  });

  // SSE stream — mirrors VS Code’s Ports panel: pushes an event the moment a
  // background server becomes reachable on a port so the UI can show a
  // “Port 3000 — Open in Browser” balloon without waiting for the next poll.
  app.get('/api/dev-servers/events', (req, res) => {
    res.setHeader('Content-Type',  'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection',    'keep-alive');
    res.flushHeaders();

    const send = (event, data) => {
      try { res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`); } catch (_) {}
    };

    // Push current state immediately so the client syncs on connect.
    send('snapshot', { servers: registry.list() });

    const prev = new Map(); // id → status at last emit
    for (const s of registry.list()) prev.set(s.id, s.status);

    const unsubscribe = registry.subscribe(() => {
      const current = registry.list();
      for (const s of current) {
        const was = prev.get(s.id);
        if (s.status === 'running' && was !== 'running') {
          send('server-ready', { id: s.id, name: s.name, port: s.port, cmd: s.command, cwd: s.cwd });
        } else if ((s.status === 'exited' || s.status === 'stopped') && was === 'running') {
          send('server-exited', { id: s.id, name: s.name, port: s.port });
        }
        prev.set(s.id, s.status);
      }
      // Clean up stale ids
      const ids = new Set(current.map(s => s.id));
      for (const id of prev.keys()) { if (!ids.has(id)) prev.delete(id); }
      send('snapshot', { servers: current });
    });

    // Keep-alive heartbeat every 25s
    const hb = setInterval(() => { try { res.write(':heartbeat\n\n'); } catch (_) {} }, 25000);

    req.on('close', () => { unsubscribe(); clearInterval(hb); });
  });

  app.post('/api/dev-servers/:id/kill', (req, res) => {
    const result = registry.kill(req.params.id);
    res.json(result);
  });

  app.post('/api/dev-servers/:id/restart', (req, res) => {
    const result = registry.restart(req.params.id, { shellBin, isWin, augmentedPath });
    res.json(result);
  });
}
