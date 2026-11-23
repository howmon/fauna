import { testRunRegistry } from '../lib/test-run-registry.js';

export function registerTestRunRoutes(app, { registry = testRunRegistry, uiNonce = () => process.env.FAUNA_UI_NONCE } = {}) {
  const authorize = (req, res, next) => {
    const ip = (req.ip || req.connection?.remoteAddress || '').replace(/^::ffff:/, '');
    const expected = uiNonce();
    if (!['127.0.0.1', '::1'].includes(ip) || !expected || req.get('x-fauna-ui') !== expected) {
      return res.status(403).json({ error: 'Test monitor restricted to local UI' });
    }
    next();
  };
  app.get('/api/test-runs', authorize, async (req, res) => {
    try { res.json(await registry.list({ memory: req.query.memory === '1' })); }
    catch (error) {
      console.warn('[test-monitor] cannot load commands:', error.message);
      res.status(500).json({ error: 'Unable to load test commands' });
    }
  });
  app.get('/api/test-runs/:id', authorize, (req, res) => {
    const run = registry.get(req.params.id);
    if (!run) return res.status(404).json({ error: 'Test command not found' });
    res.json(run);
  });
  app.post('/api/test-runs/:id/stop', authorize, (req, res) => {
    try {
      const result = registry.stop(req.params.id);
      res.status(result.status || 200).json(result);
    } catch (error) {
      console.warn('[test-monitor] cannot stop command:', error.message);
      res.status(500).json({ error: 'Unable to stop test command' });
    }
  });
}
