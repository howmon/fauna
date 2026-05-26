// ── Voice settings HTTP routes (Phase 7) ─────────────────────────────────
//
// Backs the voice settings UI at /voice-settings.html. The routes are
// deliberately small — the heavy lifting (sanitisation, persistence,
// change notification) all happens inside ../voice/settings.js so the
// renderer, IPC handlers, and CLI helpers can share one source of truth.
//
// Endpoints:
//   GET  /api/voice-settings           → full settings object
//   PATCH/PUT /api/voice-settings      → merge partial patch, returns new state
//   POST /api/voice-settings/reset     → restore defaults, returns new state
//   GET  /api/voice-settings/voices    → enumerate host TTS voices

import {
  getSettings, updateSettings, resetSettings, DEFAULTS,
} from '../voice/settings.js';
import { listVoices } from '../voice/tts.js';

export function registerVoiceSettingsRoutes(app) {
  app.get('/api/voice-settings', (_req, res) => {
    res.json({ ok: true, settings: getSettings(), defaults: DEFAULTS });
  });

  const writeHandler = (req, res) => {
    try {
      const patch = req.body && typeof req.body === 'object' ? req.body : {};
      const next = updateSettings(patch);
      res.json({ ok: true, settings: next });
    } catch (e) {
      res.status(400).json({ ok: false, error: e.message });
    }
  };
  app.patch('/api/voice-settings', writeHandler);
  app.put('/api/voice-settings',   writeHandler);

  app.post('/api/voice-settings/reset', (_req, res) => {
    res.json({ ok: true, settings: resetSettings() });
  });

  app.get('/api/voice-settings/voices', async (_req, res) => {
    try {
      const voices = await listVoices();
      res.json({ ok: true, voices });
    } catch (e) {
      res.json({ ok: true, voices: [], warn: e.message });
    }
  });
}
