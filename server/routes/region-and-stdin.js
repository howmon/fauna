// Region capture + Shell stdin routes.
// - Region capture creates a transparent fullscreen overlay window over the
//   desktopCapturer screenshot and waits for the renderer to send back a
//   rectangle via ipcMain.
// - Shell stdin writes a line to the stdin of a streaming shell process
//   tracked in the shared shellProcs Map.

import path from 'path';

export function registerRegionAndStdinRoutes(app, {
  require: _require,
  appDir,
  getElectronBrowserWindow,
  getDesktopCapturer,
  shellProcs,
}) {
  // ── Region capture ──────────────────────────────────────────────────────
  app.post('/api/capture-region', async (req, res) => {
    try {
      const _ElectronBrowserWindow = getElectronBrowserWindow();
      const desktopCapturer        = getDesktopCapturer();
      if (!_ElectronBrowserWindow || !desktopCapturer) {
        return res.status(503).json({ error: 'Capture requires Electron' });
      }
      const { screen, ipcMain } = _require('electron');
      const primaryDisplay = screen.getPrimaryDisplay();
      const { width, height } = primaryDisplay.size;
      const scaleFactor = primaryDisplay.scaleFactor;

      // Hide main window briefly
      const wins = _ElectronBrowserWindow.getAllWindows();
      const mainWin = wins.find(w => !w.isDestroyed() && w.getTitle() !== 'Region Capture');
      const wasVisible = mainWin?.isVisible();
      if (wasVisible) mainWin.hide();
      await new Promise(r => setTimeout(r, 200));

      // Full-screen capture
      const sources = await desktopCapturer.getSources({
        types: ['screen'],
        thumbnailSize: { width: width * scaleFactor, height: height * scaleFactor },
      });
      if (!sources.length) {
        if (wasVisible) mainWin.show();
        return res.json({ cancelled: true, error: 'No screen source found' });
      }
      const fullScreenshot = sources[0].thumbnail;

      // Overlay for region selection
      const overlay = new _ElectronBrowserWindow({
        x: 0, y: 0, width, height,
        frame: false, transparent: true, alwaysOnTop: true,
        fullscreen: true, skipTaskbar: true, resizable: false, hasShadow: false,
        title: 'Region Capture',
        webPreferences: { nodeIntegration: true, contextIsolation: false },
      });
      const overlayPath = path.join(appDir, 'public', 'capture-overlay.html');
      await overlay.loadFile(overlayPath);
      overlay.webContents.send('set-screenshot', fullScreenshot.toDataURL());

      const captureResult = await new Promise((resolve) => {
        ipcMain.once('capture-region-result', (_event, rect) => {
          overlay.close();
          if (wasVisible) mainWin.show();
          if (!rect) return resolve({ cancelled: true });
          const cropRect = {
            x: Math.round(rect.x * scaleFactor),
            y: Math.round(rect.y * scaleFactor),
            width: Math.round(rect.width * scaleFactor),
            height: Math.round(rect.height * scaleFactor),
          };
          const cropped = fullScreenshot.crop(cropRect);
          const base64 = cropped.toDataURL().replace(/^data:image\/png;base64,/, '');
          resolve({ base64, width: rect.width, height: rect.height });
        });
        overlay.webContents.on('before-input-event', (_event, input) => {
          if (input.key === 'Escape') ipcMain.emit('capture-region-result', null, null);
        });
      });
      res.json(captureResult);
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  // ── Shell stdin ─────────────────────────────────────────────────────────
  // POST { killId, input } → writes input to a running streaming shell process
  app.post('/api/shell-stdin', (req, res) => {
    const { killId, input } = req.body || {};
    if (!killId) return res.status(400).json({ error: 'killId required' });
    const child = shellProcs.get(killId);
    if (!child) return res.status(404).json({ error: 'process not found' });
    try {
      if (child.stdin && !child.stdin.destroyed) {
        child.stdin.write((input || '') + '\n');
        res.json({ ok: true });
      } else {
        res.status(409).json({ error: 'stdin not available for this process' });
      }
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });
}
