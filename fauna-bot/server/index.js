/**
 * Fauna Teams Bot — Express server entry point
 *
 * Endpoints:
 *   POST /api/messages   Azure Bot Framework messages (authenticated)
 *   GET  /health         Liveness probe + current tunnel URL
 *   GET  /pair           Returns a QR code / pairing page for Fauna desktop
 *   GET  /download-app   Download the Teams app zip pre-filled with correct App ID + domain
 */

import 'dotenv/config';
import express                        from 'express';
import { BotFrameworkAdapter }        from 'botbuilder';
import QRCode                         from 'qrcode';
import localtunnel                    from 'localtunnel';
import { zipSync, strToU8 }           from 'fflate';
import crypto                         from 'crypto';
import { readFileSync }               from 'fs';
import { fileURLToPath }              from 'url';
import { dirname, join }              from 'path';
import { FaunaBot }                   from './fauna-bot.js';
import { handleGatewayActivity }      from './gateway-handler.js';
import { relay }                      from './relay.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname  = dirname(__filename);
const BOT_ROOT   = join(__dirname, '..');

const PORT            = process.env.PORT             || 3978;
const APP_ID          = process.env.MicrosoftAppId       || '';
const APP_PASSWORD    = process.env.MicrosoftAppPassword  || '';
const APP_TENANT_ID   = process.env.MicrosoftAppTenantId  || '';  // required for Single Tenant
const BOT_DOMAIN      = process.env.BOT_DOMAIN            || `localhost:${PORT}`;
const GATEWAY_MODE    = process.env.FAUNA_GATEWAY_MODE === '1';
const GATEWAY_SECRET  = process.env.FAUNA_GATEWAY_SECRET || '';

// ── Bot Framework adapter ─────────────────────────────────────────────────

const adapter = new BotFrameworkAdapter({
  appId:       APP_ID,
  appPassword: APP_PASSWORD,
  // Include tenantId when using Single Tenant app registration
  ...(APP_TENANT_ID ? { channelAuthTenant: APP_TENANT_ID } : {}),
});

adapter.onTurnError = async (ctx, err) => {
  console.error('[adapter] Unhandled error:', err);
  await ctx.sendTraceActivity('OnTurnError', err.message, 'https://www.botframework.com/schemas/error', 'TurnError');
  await ctx.sendActivity('Fauna encountered an error. Please try again.');
};

// ── Bot instance ──────────────────────────────────────────────────────────

const bot = new FaunaBot();

// ── Relay — connect to Fauna desktop ─────────────────────────────────────

relay.connect();

relay.on('connect',    () => console.log('[server] Fauna desktop relay: connected'));
relay.on('disconnect', () => console.log('[server] Fauna desktop relay: disconnected, retrying…'));
relay.on('error',  (e)  => console.warn('[server] Fauna relay error:', e.message));

// ── Express app ───────────────────────────────────────────────────────────

const app = express();
app.use(express.json({
  verify: (req, _res, buf) => { req.rawBody = buf.toString('utf8'); },
}));

// Bot Framework messages endpoint
app.post('/api/messages', async (req, res) => {
  if (GATEWAY_MODE) {
    if (!_verifyGatewaySignature(req)) {
      return res.status(401).json({ error: 'Invalid gateway signature' });
    }

    try {
      const result = await handleGatewayActivity(req.body);
      return res.json(result);
    } catch (err) {
      console.error('[gateway] Handler error:', err);
      return res.status(500).json({ error: err.message });
    }
  }

  adapter.processActivity(req, res, async (ctx) => {
    await bot.run(ctx);
  });
});

// Liveness probe — also exposes current public domain for Fauna UI
app.get('/health', (_req, res) => {
  res.json({
    status:   'ok',
    relay:    relay.isConnected ? 'connected' : 'disconnected',
    uptime:   process.uptime(),
    domain:   process.env.BOT_DOMAIN || `localhost:${PORT}`,
    ts:       new Date().toISOString(),
  });
});

// Download Teams app zip pre-filled with correct App ID + messaging endpoint domain
app.get('/download-app', (_req, res) => {
  try {
    const domain = process.env.BOT_DOMAIN || `localhost:${PORT}`;
    if (!APP_ID) return res.status(400).json({ error: 'MicrosoftAppId not configured' });

    const manifest = readFileSync(join(BOT_ROOT, 'manifest.json'), 'utf8')
      .replace(/\{\{MICROSOFT_APP_ID\}\}/g, APP_ID)
      .replace(/\{\{BOT_DOMAIN\}\}/g, domain);

    const zip = zipSync({
      'manifest.json': strToU8(manifest),
      'color.png':     readFileSync(join(BOT_ROOT, 'color.png')),
      'outline.png':   readFileSync(join(BOT_ROOT, 'outline.png')),
    });

    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Content-Disposition', 'attachment; filename="fauna-teams-bot.zip"');
    res.setHeader('Content-Length', zip.byteLength);
    res.end(Buffer.from(zip));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Pairing page — scan this QR code in Fauna desktop
app.get('/pair', async (_req, res) => {
  const pairingUrl = `fauna://pair?bot=${encodeURIComponent(`https://${BOT_DOMAIN}/api/messages`)}&id=${APP_ID}`;

  try {
    const qrSvg = await QRCode.toString(pairingUrl, { type: 'svg' });
    res.setHeader('Content-Type', 'text/html');
    res.send(`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Pair Fauna with Teams</title>
  <style>
    body { font-family: -apple-system, sans-serif; display: flex; flex-direction: column;
           align-items: center; justify-content: center; min-height: 100vh; margin: 0;
           background: #0f172a; color: #e2e8f0; }
    h1   { font-size: 1.5rem; margin-bottom: 0.5rem; }
    p    { color: #94a3b8; font-size: 0.9rem; text-align: center; max-width: 340px; }
    .qr  { background: white; padding: 16px; border-radius: 12px; margin: 24px 0; }
    .qr svg { display: block; width: 200px; height: 200px; }
    .url { font-family: monospace; font-size: 0.75rem; color: #64748b;
           word-break: break-all; max-width: 340px; text-align: center; }
  </style>
</head>
<body>
  <h1>🌿 Pair Fauna with Teams</h1>
  <p>Open the Fauna desktop app and scan this QR code to link your Teams bot.</p>
  <div class="qr">${qrSvg}</div>
  <p class="url">${pairingUrl}</p>
</body>
</html>`);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Start ─────────────────────────────────────────────────────────────────

app.listen(PORT, async () => {
  console.log(`\n🌿 Fauna Teams Bot running on port ${PORT}`);
  if (GATEWAY_MODE) console.log('   Mode:              gateway target (Microsoft credentials live upstream)');
  console.log(`   Messages endpoint: http://localhost:${PORT}/api/messages`);
  console.log(`   Health:            http://localhost:${PORT}/health`);
  console.log(`   Pair:              http://localhost:${PORT}/pair`);
  console.log(`   Relay:             ${process.env.FAUNA_WS_URL || 'ws://localhost:3737/api/teams-relay'}\n`);

  // Auto-start tunnel unless BOT_DOMAIN is explicitly set to a real hostname
  const needsTunnel = !process.env.BOT_DOMAIN
    || process.env.BOT_DOMAIN.includes('localhost')
    || process.env.BOT_DOMAIN.includes('ngrok-free.app');

  if (needsTunnel) {
    console.log('🔗 Starting built-in tunnel (no ngrok needed)…');
    try {
      const subdomain = process.env.TUNNEL_SUBDOMAIN || 'fauna-bot';
      const tunnel = await localtunnel({ port: Number(PORT), subdomain });
      const publicUrl = tunnel.url;
      const domain = publicUrl.replace('https://', '');

      console.log(`\n✅ Public URL: ${publicUrl}`);
      if (GATEWAY_MODE) {
        console.log(`\n📋 Register this target with the hosted gateway:`);
        console.log(`   ${publicUrl}/api/messages\n`);
      } else {
        console.log(`\n📋 Paste this into Azure Bot → Configuration → Messaging endpoint:`);
        console.log(`   ${publicUrl}/api/messages\n`);
      }

      process.env.BOT_DOMAIN = domain;

      tunnel.on('close', () => console.log('[tunnel] Tunnel closed'));
      tunnel.on('error', (e) => console.warn('[tunnel] Tunnel error:', e.message));
    } catch (err) {
      console.warn('[tunnel] Could not start tunnel:', err.message);
      console.warn('[tunnel] You can still use ngrok manually: ngrok http', PORT);
    }
  }
});

function _verifyGatewaySignature(req) {
  if (!GATEWAY_SECRET) {
    console.warn('[gateway] FAUNA_GATEWAY_SECRET is required in gateway mode');
    return false;
  }

  const header = String(req.get('x-fauna-gateway-signature') || '');
  const provided = header.startsWith('sha256=') ? header.slice(7) : header;
  const expected = crypto
    .createHmac('sha256', GATEWAY_SECRET)
    .update(req.rawBody || '')
    .digest('hex');

  const providedBuf = Buffer.from(provided, 'hex');
  const expectedBuf = Buffer.from(expected, 'hex');
  return providedBuf.length === expectedBuf.length
    && crypto.timingSafeEqual(providedBuf, expectedBuf);
}
