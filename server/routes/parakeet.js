// Parakeet (sherpa-onnx) voice model routes.
//
// Cross-platform sibling of routes/whisper.js. A Parakeet model is four files
// downloaded from HuggingFace into ~/.config/fauna/parakeet/<alias>/. We use
// Node's https (with redirect following) rather than spawning curl, so the
// download works identically on macOS, Windows, and Linux.

import fs from 'fs';
import https from 'https';

import {
  MODEL_DIR,
  MODEL_FILES,
  isParakeetAlias,
  modelDirFor,
  modelFilePath,
  downloadUrlFor,
  isInstalled,
  resolveActiveModel,
  listModels,
} from '../voice/parakeet-models.js';
import { getSettings } from '../voice/settings.js';

// Download one URL to a destination path, following redirects, reporting
// byte progress. Resolves on success, rejects on error.
function downloadFile(url, dest, onProgress, signal) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { headers: { 'User-Agent': 'fauna' } }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume();
        downloadFile(res.headers.location, dest, onProgress, signal).then(resolve, reject);
        return;
      }
      if (res.statusCode !== 200) {
        res.resume();
        reject(new Error('HTTP ' + res.statusCode + ' for ' + url));
        return;
      }
      const total = parseInt(res.headers['content-length'] || '0', 10);
      let received = 0;
      const out = fs.createWriteStream(dest);
      res.on('data', (chunk) => {
        received += chunk.length;
        if (onProgress) onProgress(received, total);
      });
      res.pipe(out);
      out.on('finish', () => out.close(() => resolve()));
      out.on('error', reject);
    });
    req.on('error', reject);
    if (signal) signal.addEventListener('abort', () => { try { req.destroy(); } catch (_) {} });
  });
}

export function registerParakeetRoutes(app, { express }) {
  function _selectedAlias(reqAlias) {
    if (isParakeetAlias(reqAlias)) return reqAlias;
    const s = getSettings().parakeetModel;
    if (isParakeetAlias(s)) return s;
    return 'parakeet-tdt-0.6b-v2';
  }

  // Current install state + full catalogue for the settings picker.
  app.get('/api/parakeet-model-status', (req, res) => {
    const requested = typeof req.query?.model === 'string' ? req.query.model : null;
    const alias = _selectedAlias(requested);
    res.json({
      ready:   isInstalled(alias),
      model:   alias,
      dir:     modelDirFor(alias),
      models:  listModels(),
      active:  resolveActiveModel(alias),
    });
  });

  // SSE — download all four files of a model with combined progress.
  app.get('/api/parakeet-model-download', (req, res) => {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders?.();

    function send(obj) { res.write(`data: ${JSON.stringify(obj)}\n\n`); }

    const requested = typeof req.query?.model === 'string' ? req.query.model : null;
    const alias = _selectedAlias(requested);
    if (!isParakeetAlias(alias)) {
      send({ error: 'Unknown model alias: ' + (requested || '(none)') });
      return res.end();
    }
    if (isInstalled(alias)) {
      send({ pct: 100, ready: true, model: alias });
      return res.end();
    }

    const dir = modelDirFor(alias);
    fs.mkdirSync(dir, { recursive: true });

    const controller = new AbortController();
    req.on('close', () => controller.abort());

    // Approximate combined progress: files are roughly weighted by the
    // encoder dominating, but content-length gives us exact per-file bytes.
    // We treat all four as one virtual stream by summing received/total.
    (async () => {
      const totals = new Array(MODEL_FILES.length).fill(0);
      const recvd  = new Array(MODEL_FILES.length).fill(0);
      let lastPct = -1;
      try {
        for (let i = 0; i < MODEL_FILES.length; i++) {
          const file = MODEL_FILES[i];
          const url  = downloadUrlFor(alias, file);
          const dest = modelFilePath(alias, file);
          const tmp  = dest + '.tmp';
          await downloadFile(url, tmp, (received, total) => {
            recvd[i] = received;
            totals[i] = total || totals[i];
            const sumT = totals.reduce((a, b) => a + b, 0);
            const sumR = recvd.reduce((a, b) => a + b, 0);
            if (sumT > 0) {
              const pct = Math.min(99, Math.round((sumR / sumT) * 100));
              if (pct !== lastPct) { lastPct = pct; send({ pct, model: alias, file }); }
            }
          }, controller.signal);
          fs.renameSync(tmp, dest);
        }
        send({ pct: 100, ready: true, model: alias });
      } catch (e) {
        // Clean up partials so a retry starts fresh.
        for (const f of MODEL_FILES) {
          try { fs.unlinkSync(modelFilePath(alias, f) + '.tmp'); } catch (_) {}
        }
        send({ error: 'Download failed: ' + e.message, model: alias });
      } finally {
        res.end();
      }
    })();
  });

  // DELETE a downloaded Parakeet model (its whole folder). Returns catalogue.
  app.post('/api/parakeet-model-delete', express.json({ limit: '1kb' }), (req, res) => {
    const alias = String((req.body && req.body.model) || '');
    if (!isParakeetAlias(alias)) return res.status(400).json({ ok: false, error: 'unknown model' });
    const dir = modelDirFor(alias);
    try {
      // Guard: only ever remove folders under our own model dir.
      if (dir && dir.startsWith(MODEL_DIR) && fs.existsSync(dir)) {
        fs.rmSync(dir, { recursive: true, force: true });
      }
      return res.json({ ok: true, models: listModels() });
    } catch (e) {
      return res.status(500).json({ ok: false, error: e.message });
    }
  });
}
