// Enterprise auth + WorkIQ stubs. Real implementations live in
// enterprise-auth.js / workiq-integration.js (not yet wired). These routes
// keep the UI happy by reporting "not configured" instead of 404-ing.

export function registerEnterpriseStubRoutes(app) {
  app.get('/api/enterprise-auth/status', (_req, res) => {
    res.json({ configured: false, signedIn: false, pendingDeviceCode: null });
  });
  app.post('/api/enterprise-auth/sign-in', (_req, res) => {
    res.status(501).json({ ok: false, error: 'Enterprise auth not configured' });
  });
  app.post('/api/enterprise-auth/sign-out', (_req, res) => {
    res.json({ ok: true });
  });

  app.get('/api/workiq/status', (_req, res) => {
    res.json({ connected: false, available: false });
  });
  app.post('/api/workiq/connect', (_req, res) => {
    res.status(501).json({ ok: false, error: 'WorkIQ not configured' });
  });
  app.post('/api/workiq/sign-out', (_req, res) => {
    res.json({ ok: true });
  });
}
