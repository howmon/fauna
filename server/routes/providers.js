// Local provider API-key storage (OpenAI / Anthropic / Google).
// Keys live in FAUNA_CONFIG_DIR/provider-keys.json as plain text — local-only.
import fs from 'fs';
import path from 'path';

const KNOWN_PROVIDERS = [
  { id: 'openai',    name: 'OpenAI',    placeholder: 'sk-…'     },
  { id: 'anthropic', name: 'Anthropic', placeholder: 'sk-ant-…' },
  { id: 'google',    name: 'Google',    placeholder: 'AIza…'    },
  // Stock media providers — used by Video Studio (server/video/footage.js).
  // All three are optional; missing tiers fall through to browser-extension
  // scrape and local folders.
  { id: 'pexels',    name: 'Pexels',    placeholder: '563492ad6f9170000…' },
  { id: 'pixabay',   name: 'Pixabay',   placeholder: '12345678-abc…' },
  { id: 'unsplash',  name: 'Unsplash',  placeholder: 'Access Key…' },
];

function keyPreview(k) { return k ? k.slice(0, 4) + '…' + k.slice(-4) : ''; }

export function registerProviderRoutes(app, { faunaConfigDir }) {
  const PROVIDER_KEYS_FILE = path.join(faunaConfigDir, 'provider-keys.json');

  function readProviderKeys() {
    try { return JSON.parse(fs.readFileSync(PROVIDER_KEYS_FILE, 'utf8')); } catch (_) { return {}; }
  }
  function writeProviderKeys(keys) {
    fs.mkdirSync(faunaConfigDir, { recursive: true });
    fs.writeFileSync(PROVIDER_KEYS_FILE, JSON.stringify(keys, null, 2));
  }

  app.get('/api/providers', (_req, res) => {
    const stored = readProviderKeys();
    res.json({
      providers: KNOWN_PROVIDERS.map(p => ({
        id: p.id, name: p.name,
        configured: !!stored[p.id],
        preview: stored[p.id] ? keyPreview(stored[p.id]) : null,
      })),
    });
  });

  app.post('/api/providers/:provider/key', (req, res) => {
    const { provider } = req.params;
    const key = (req.body?.key || '').trim();
    if (!key) return res.status(400).json({ error: 'key required' });
    if (!KNOWN_PROVIDERS.find(p => p.id === provider)) return res.status(404).json({ error: 'Unknown provider' });
    const keys = readProviderKeys();
    keys[provider] = key;
    writeProviderKeys(keys);
    res.json({ ok: true, preview: keyPreview(key) });
  });

  app.delete('/api/providers/:provider/key', (req, res) => {
    const keys = readProviderKeys();
    delete keys[req.params.provider];
    writeProviderKeys(keys);
    res.json({ ok: true });
  });
}
