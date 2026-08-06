import { loadNotebook, executeNotebook, isJupyterAvailable, summarizeNotebook } from '../lib/notebook-runner.js';
import path from 'path';
import os from 'os';

export function registerNotebookRoutes(app) {
  /** GET /api/notebook/load?path=… — parse without executing */
  app.get('/api/notebook/load', (req, res) => {
    const filePath = req.query.path;
    if (!filePath || typeof filePath !== 'string') {
      return res.status(400).json({ ok: false, error: 'path required' });
    }
    try {
      const nb = loadNotebook(filePath);
      res.json({
        ok: true,
        path: nb.path,
        cells: nb.cells,
        metadata: nb.metadata,
        kernelspec: nb.kernelspec,
        languageInfo: nb.languageInfo,
        nbformat: nb.nbformat,
      });
    } catch (e) {
      res.status(400).json({ ok: false, error: e.message });
    }
  });

  /** POST /api/notebook/execute — run via jupyter nbconvert */
  app.post('/api/notebook/execute', async (req, res) => {
    const { path: filePath, timeoutSec } = req.body || {};
    if (!filePath || typeof filePath !== 'string') {
      return res.status(400).json({ ok: false, error: 'path required' });
    }
    if (!isJupyterAvailable()) {
      return res.status(422).json({
        ok: false,
        error: 'Jupyter is not installed. Run `pip install jupyter` or `conda install jupyter` then restart Fauna.',
      });
    }
    try {
      const result = await executeNotebook(filePath, { timeoutSec: timeoutSec || 120 });
      res.json(result);
    } catch (e) {
      res.status(500).json({ ok: false, error: e.message });
    }
  });

  /** GET /api/notebook/status — check jupyter availability */
  app.get('/api/notebook/status', (_req, res) => {
    res.json({ ok: true, jupyterAvailable: isJupyterAvailable() });
  });
}
