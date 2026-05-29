// server/routes/dev-servers.js
//
// REST endpoints for the global dev-server registry. Lets the UI list / stop
// / restart background dev servers Fauna has spawned via shell commands.
//
//   GET    /api/dev-servers           — list all tracked entries
//   POST   /api/dev-servers/:id/kill  — SIGTERM the underlying process
//   POST   /api/dev-servers/:id/restart — kill + respawn same command/cwd

import * as registry from '../lib/dev-server-registry.js';

export function registerDevServerRoutes(app, { shellBin, isWin, augmentedPath } = {}) {
  app.get('/api/dev-servers', (_req, res) => {
    res.json({ ok: true, servers: registry.list() });
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
