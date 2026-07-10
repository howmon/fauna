// Browser action recording routes — CRUD + compile/describe for the recorder.
// The extension start/stop is driven through the existing /api/ext/command
// endpoint (actions record:start / record:stop); persistence of a finished
// recording happens when the extension sends a `recording:complete` WS message
// (handled in server/bridges/ext.js). These routes let the renderer list,
// view, edit, replay-compile, and delete saved recordings.

import {
  saveRecording, listRecordings, getRecording, updateRecording,
  touchRecording, deleteRecording, compileRecording, describeRecording,
  appendSystemStep,
} from '../../browser-recordings-store.js';
import { executeSelfTool } from '../../self-tools.js';
import { execFile } from 'node:child_process';

// Run a host command (osascript / PowerShell) and resolve trimmed stdout.
function _execFile(cmd, argv, timeoutMs = 15000) {
  return new Promise((resolve, reject) => {
    execFile(cmd, argv, { timeout: timeoutMs }, (err, stdout, stderr) => {
      if (err) return reject(new Error(String(stderr || err.message || '').slice(0, 500)));
      resolve(String(stdout || '').trim());
    });
  });
}

// Accessibility gate for system-automation replay. macOS requires the
// Accessibility permission for native input; other platforms pass through.
function _accessibilityOk(getSystemPreferences) {
  if (process.platform !== 'darwin') return true;
  try {
    const sp = getSystemPreferences && getSystemPreferences();
    if (sp && typeof sp.isTrustedAccessibilityClient === 'function') {
      return sp.isTrustedAccessibilityClient(false) === true;
    }
  } catch (_) {}
  return true; // undeterminable — let the step run and surface its own error
}

async function _activateApp(appName) {
  if (!appName) throw new Error('app required');
  if (process.platform === 'darwin') {
    await _execFile('/usr/bin/osascript', ['-e', 'tell application ' + JSON.stringify(appName) + ' to activate']);
    return { ok: true, activated: appName };
  }
  if (process.platform === 'win32') {
    await _execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
      "(New-Object -ComObject WScript.Shell).AppActivate('" + String(appName).replace(/'/g, "''") + "')"]);
    return { ok: true, activated: appName };
  }
  throw new Error('activate-app unsupported on ' + process.platform);
}

// Execute one system-automation step by routing to the existing native-input
// self-tools (fauna_mouse / fauna_keyboard / fauna_arrange_windows) or osascript.
async function _runSystemStep(step) {
  const a = String(step.sysAction || step.action || 'run').toLowerCase();
  const via = async (tool, args) => JSON.parse(await executeSelfTool(tool, args, {}));
  switch (a) {
    case 'activate-app':
      return _activateApp(step.app);
    case 'focus-window':
    case 'arrange-window':
      return via('fauna_arrange_windows', { moves: [{
        app: step.app, x: step.x, y: step.y, w: step.w, h: step.h,
        windowTitle: step.windowTitle, windowIndex: step.windowIndex,
      }] });
    case 'mouse-move':
      return via('fauna_mouse', { action: 'move', x: step.x, y: step.y });
    case 'mouse-click':
      return via('fauna_mouse', {
        action: step.button === 'right' ? 'right_click' : (step.double ? 'double_click' : 'click'),
        x: step.x, y: step.y,
      });
    case 'mouse-drag':
      return via('fauna_mouse', { action: 'drag', x: step.x, y: step.y, toX: step.toX, toY: step.toY });
    case 'scroll':
      return via('fauna_mouse', { action: 'scroll', dy: step.dy });
    case 'key':
      return via('fauna_keyboard', { action: 'key', combo: step.combo });
    case 'type':
      return via('fauna_keyboard', { action: 'type', text: step.text });
    case 'osascript':
    case 'run': {
      if (process.platform !== 'darwin') throw new Error('osascript is macOS-only');
      const script = step.script || step.text || '';
      if (!script) throw new Error('script required');
      return { ok: true, stdout: await _execFile('/usr/bin/osascript', ['-e', script]) };
    }
    default:
      throw new Error('Unknown system step: ' + a);
  }
}

export function registerRecordingsRoutes(app, opts = {}) {
  const getSystemPreferences = opts.getSystemPreferences || (() => null);

  // List (summaries)
  app.get('/api/recordings', (req, res) => {
    try { res.json({ ok: true, recordings: listRecordings({ query: req.query.q }) }); }
    catch (e) { res.status(500).json({ ok: false, error: e.message }); }
  });

  // Full recording (with steps)
  app.get('/api/recordings/:id', (req, res) => {
    const rec = getRecording(req.params.id);
    if (!rec) return res.status(404).json({ ok: false, error: 'Not found' });
    res.json({ ok: true, recording: rec });
  });

  // Human/AI-readable outline
  app.get('/api/recordings/:id/describe', (req, res) => {
    const d = describeRecording(req.params.id);
    if (!d) return res.status(404).json({ ok: false, error: 'Not found' });
    res.json({ ok: true, ...d });
  });

  // Compile to replayable browser-ext-action commands
  app.get('/api/recordings/:id/compile', (req, res) => {
    const c = compileRecording(req.params.id);
    if (!c) return res.status(404).json({ ok: false, error: 'Not found' });
    res.json({ ok: true, ...c });
  });

  // Create (or upsert by id) — used by the renderer if it assembles a recording
  app.post('/api/recordings', (req, res) => {
    try { res.json({ ok: true, recording: saveRecording(req.body || {}) }); }
    catch (e) { res.status(500).json({ ok: false, error: e.message }); }
  });

  // Update name/description/tags/steps
  app.patch('/api/recordings/:id', (req, res) => {
    const rec = updateRecording(req.params.id, req.body || {});
    if (!rec) return res.status(404).json({ ok: false, error: 'Not found' });
    res.json({ ok: true, recording: rec });
  });

  // Mark a replay/use
  app.post('/api/recordings/:id/touch', (req, res) => {
    const rec = touchRecording(req.params.id);
    if (!rec) return res.status(404).json({ ok: false, error: 'Not found' });
    res.json({ ok: true, recording: rec });
  });

  // Insert a system-automation step (osascript / native input) into a recording.
  app.post('/api/recordings/:id/system-step', (req, res) => {
    try {
      const rec = appendSystemStep(req.params.id, req.body || {});
      if (!rec) return res.status(404).json({ ok: false, error: 'Not found' });
      res.json({ ok: true, recording: rec });
    } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
  });

  // Execute a single system-automation step on the host (used by replay for
  // steps with host:true). Gated behind the Accessibility permission on macOS.
  app.post('/api/recordings/system-run', async (req, res) => {
    const step = (req.body && (req.body.step || req.body)) || {};
    if (!_accessibilityOk(getSystemPreferences)) {
      return res.status(403).json({
        ok: false, needsPermission: 'accessibility',
        error: 'Accessibility permission required for system automation. Grant Fauna in System Settings → Privacy & Security → Accessibility, then relaunch.',
      });
    }
    try {
      const result = await _runSystemStep(step);
      res.json({ ok: true, result });
    } catch (e) {
      res.status(500).json({ ok: false, error: e.message });
    }
  });

  // Delete
  app.delete('/api/recordings/:id', (req, res) => {
    const ok = deleteRecording(req.params.id);
    if (!ok) return res.status(404).json({ ok: false, error: 'Not found' });
    res.json({ ok: true });
  });
}
