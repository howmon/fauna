// GitHub auth + PAT management HTTP routes.
// Token discovery itself lives in server/copilot/auth.js — these routes are
// just the thin HTTP surface on top.
import { getGhToken, readSavedConfig, writeSavedConfig } from '../copilot/auth.js';

export function registerAuthRoutes(app) {
  app.get('/api/auth', (req, res) => {
    try {
      const token   = getGhToken();
      const cfg     = readSavedConfig();
      const source  = cfg.pat ? 'pat' : (process.env.GH_TOKEN || process.env.GITHUB_TOKEN) ? 'env' : 'keychain';
      const preview = token ? token.slice(0, 4) + '…' + token.slice(-4) : '?';
      res.json({ authenticated: true, preview, source });
    } catch (e) {
      res.json({ authenticated: false, error: e.message });
    }
  });

  app.post('/api/token', (req, res) => {
    const { pat } = req.body;
    if (!pat || !pat.trim()) return res.status(400).json({ error: 'PAT required' });

    const trimmed = pat.trim();
    const looksValid = /^(ghp_|gho_|github_pat_|ghs_|ghr_)/.test(trimmed) || /^[a-f0-9]{40}$/i.test(trimmed);
    if (!looksValid) {
      return res.status(400).json({ error: "This doesn't look like a valid GitHub token (should start with ghp_, gho_, or github_pat_)" });
    }

    const cfg = readSavedConfig();
    cfg.pat = trimmed;
    writeSavedConfig(cfg);
    res.json({ ok: true, preview: trimmed.slice(0, 4) + '…' + trimmed.slice(-4) });
  });

  app.delete('/api/token', (req, res) => {
    const cfg = readSavedConfig();
    delete cfg.pat;
    writeSavedConfig(cfg);
    res.json({ ok: true });
  });

  app.get('/api/token', (req, res) => {
    const cfg = readSavedConfig();
    if (cfg.pat) {
      const t = cfg.pat;
      res.json({ hasPat: true, preview: t.slice(0, 4) + '…' + t.slice(-4) });
    } else {
      res.json({ hasPat: false });
    }
  });
}
