// ── Credentials routes — REST surface for the encrypted secrets vault ──────
//
// Phase: n8n-parity #1. Thin wrappers over credentials-store.js. The list/read
// surface returns METADATA ONLY — secret values are never serialised to a
// client. Decryption happens exclusively inside the task runner via
// resolveCredential().

import {
  listCredentials,
  getCredentialMeta,
  createCredential,
  updateCredential,
  deleteCredential,
  CRED_TYPES,
} from '../../credentials-store.js';

export function registerCredentialRoutes(app) {
  app.get('/api/credentials', (_req, res) => {
    res.json({ credentials: listCredentials(), types: CRED_TYPES });
  });

  app.get('/api/credentials/:id', (req, res) => {
    const meta = getCredentialMeta(req.params.id);
    if (!meta) return res.status(404).json({ error: 'Credential not found' });
    res.json(meta);
  });

  app.post('/api/credentials', (req, res) => {
    try {
      const meta = createCredential(req.body || {});
      res.status(201).json(meta);
    } catch (e) {
      res.status(400).json({ error: e.message });
    }
  });

  app.put('/api/credentials/:id', (req, res) => {
    try {
      const meta = updateCredential(req.params.id, req.body || {});
      if (!meta) return res.status(404).json({ error: 'Credential not found' });
      res.json(meta);
    } catch (e) {
      res.status(400).json({ error: e.message });
    }
  });

  app.delete('/api/credentials/:id', (req, res) => {
    const ok = deleteCredential(req.params.id);
    if (!ok) return res.status(404).json({ error: 'Credential not found' });
    res.json({ ok: true });
  });
}
