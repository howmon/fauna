// Mobile QR pairing + remote-access tunnel (localtunnel).
// Token persisted at FAUNA_CONFIG_DIR/mobile-token.json and required on the
// authenticated /api/system probe used by the mobile app's verifyConnection().
import fs from 'fs';
import os from 'os';
import path from 'path';
import crypto from 'crypto';
import QRCode from 'qrcode';
import localtunnel from 'localtunnel';

function mobilePairUrl({ host, port, token, name, tunnelUrl }) {
  const params = new URLSearchParams({ host, port: String(port), token, name });
  if (tunnelUrl) params.set('tunnel', tunnelUrl);
  return `fauna://pair?${params.toString()}`;
}

export function registerMobileRoutes(app, { faunaConfigDir, port }) {
  const MOBILE_TOKEN_FILE = path.join(faunaConfigDir, 'mobile-token.json');
  let _mobileTunnel = null;
  let _mobileTunnelUrl = null;

  function getMobilePairData() {
    let token;
    try { token = JSON.parse(fs.readFileSync(MOBILE_TOKEN_FILE, 'utf8')).token; } catch (_) {}
    if (!token) {
      token = crypto.randomBytes(32).toString('hex');
      fs.mkdirSync(faunaConfigDir, { recursive: true });
      fs.writeFileSync(MOBILE_TOKEN_FILE, JSON.stringify({ token }));
    }
    const ifaces = os.networkInterfaces();
    const ips = [];
    for (const iface of Object.values(ifaces)) {
      for (const addr of (iface || [])) {
        if (addr.family === 'IPv4' && !addr.internal) ips.push(addr.address);
      }
    }
    const primary = ips[0] || '127.0.0.1';
    const hostname = os.hostname();
    const primaryQr = mobilePairUrl({ host: primary, port, token, name: hostname, tunnelUrl: _mobileTunnelUrl });
    return { token, ips, port, hostname, primaryQr, qrImage: null, tunnelUrl: _mobileTunnelUrl };
  }

  app.get('/api/mobile/pair', async (_req, res) => {
    try {
      const data = getMobilePairData();
      data.qrImage = await QRCode.toDataURL(data.primaryQr, { width: 200, margin: 2 });
      res.json(data);
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  app.post('/api/mobile/pair/reset', (_req, res) => {
    try {
      const token = crypto.randomBytes(32).toString('hex');
      fs.mkdirSync(faunaConfigDir, { recursive: true });
      fs.writeFileSync(MOBILE_TOKEN_FILE, JSON.stringify({ token }));
      res.json({ ok: true });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // Token-protected probe used by the mobile app's verifyConnection().
  app.get('/api/system', (req, res) => {
    let storedToken;
    try { storedToken = JSON.parse(fs.readFileSync(MOBILE_TOKEN_FILE, 'utf8')).token; } catch (_) {}
    const provided = (req.headers['x-fauna-token'] || '').trim();
    if (!storedToken || !provided || provided !== storedToken) {
      return res.status(401).json({ error: 'Invalid or missing token' });
    }
    res.json({ ok: true, hostname: os.hostname() });
  });

  app.get('/api/tunnel/status', (_req, res) => {
    res.json({ ok: true, active: !!_mobileTunnelUrl, url: _mobileTunnelUrl });
  });

  app.post('/api/tunnel/start', async (_req, res) => {
    try {
      if (_mobileTunnelUrl) return res.json({ ok: true, url: _mobileTunnelUrl, active: true });

      const tunnelOptions = { port };
      const subdomain = process.env.FAUNA_MOBILE_TUNNEL_SUBDOMAIN || process.env.FAUNA_TUNNEL_SUBDOMAIN || '';
      if (subdomain) tunnelOptions.subdomain = subdomain;

      _mobileTunnel = await localtunnel(tunnelOptions);
      _mobileTunnelUrl = _mobileTunnel.url;

      _mobileTunnel.on('close', () => {
        _mobileTunnel = null;
        _mobileTunnelUrl = null;
      });
      _mobileTunnel.on('error', (err) => {
        console.warn('[mobile tunnel] error:', err.message);
      });

      res.json({ ok: true, url: _mobileTunnelUrl, active: true });
    } catch (e) {
      _mobileTunnel = null;
      _mobileTunnelUrl = null;
      res.status(500).json({ ok: false, error: e.message || 'Failed to start remote tunnel' });
    }
  });

  app.post('/api/tunnel/stop', (_req, res) => {
    try {
      if (_mobileTunnel) _mobileTunnel.close();
    } catch (_) {}
    _mobileTunnel = null;
    _mobileTunnelUrl = null;
    res.json({ ok: true, active: false, url: null });
  });
}
