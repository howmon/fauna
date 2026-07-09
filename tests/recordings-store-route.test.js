import { describe, it, expect, beforeEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Fresh store + route module (and fresh temp files) per test so the module-level
// cache never leaks between cases.
let store;
let registerRecordingsRoutes;
let tmpDir;
let docsDir;

beforeEach(async () => {
  vi.resetModules();
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fauna-rec-'));
  docsDir = path.join(tmpDir, 'docs');
  process.env.FAUNA_RECORDINGS_FILE = path.join(tmpDir, 'recordings.json');
  process.env.FAUNA_RECORDINGS_DOCS_DIR = docsDir;
  store = await import('../browser-recordings-store.js');
  ({ registerRecordingsRoutes } = await import('../server/routes/recordings.js'));
});

function makeFakeApp() {
  const routes = new Map();
  const add = (m) => (p, ...h) => routes.set(m + ' ' + p, h);
  return {
    get: add('GET'), post: add('POST'), patch: add('PATCH'),
    put: add('PUT'), delete: add('DELETE'),
    invoke(method, p, req = {}) {
      const handlers = routes.get(method.toUpperCase() + ' ' + p);
      if (!handlers) throw new Error('No route ' + method + ' ' + p);
      const res = makeFakeRes();
      const list = Array.isArray(handlers) ? handlers : [handlers];
      let i = 0;
      const next = () => { const h = list[i++]; if (h) h({ query: {}, body: {}, params: {}, ...req }, res, next); };
      next();
      return res;
    },
  };
}

function makeFakeRes() {
  return {
    statusCode: 200, body: null,
    status(c) { this.statusCode = c; return this; },
    json(p) { this.body = p; return this; },
  };
}

// A realistic recording matching what the renderer POSTs on Stop (the failing
// path): 11 steps across two Figma tabs with base64 screenshots + a copy/paste.
function sampleRecording(overrides = {}) {
  const shot = 'data:image/jpeg;base64,' + 'A'.repeat(2000);
  return {
    sessionId: 'sess_test_1',
    name: 'Figma cross-tab copy',
    startedAt: 1000,
    endedAt: 12000,
    durationMs: 11000,
    steps: [
      { id: 'st_0', t: 0, type: 'navigate', url: 'https://figma.com/a', title: 'A', tabId: 1, shot },
      { id: 'st_1', t: 500, type: 'click', selector: 'canvas', label: 'Canvas', x: 500, y: 400, tabId: 1 },
      { id: 'st_2', t: 1200, type: 'key', keys: 'Meta+a', tabId: 1 },
      { id: 'st_3', t: 1800, type: 'copy', text: 'Agent tag', tabId: 1 },
      { id: 'st_4', t: 3000, type: 'tabswitch', url: 'https://figma.com/b', title: 'B', tabId: 2 },
      { id: 'st_5', t: 3500, type: 'click', selector: 'canvas', tabId: 2, shot },
      { id: 'st_6', t: 4200, type: 'paste', text: 'Agent tag', tabId: 2 },
      { id: 'st_7', t: 5000, type: 'input', selector: '#name', value: 'hello', label: 'Name', tabId: 2 },
      { id: 'st_8', t: 6000, type: 'select', selector: '#kind', value: 'v2', label: 'V2', tabId: 2 },
      { id: 'st_9', t: 7000, type: 'selection', text: 'some selected text', tabId: 2 },
      { id: 'st_10', t: 8000, type: 'scroll', x: 0, y: 300, tabId: 2 },
    ],
    ...overrides,
  };
}

describe('browser-recordings-store', () => {
  it('saves a new recording and persists it to disk + documents folder', () => {
    const rec = store.saveRecording(sampleRecording());
    expect(rec.id).toMatch(/^rec_/);
    expect(rec.stepCount).toBe(11);
    // index file written
    const index = JSON.parse(fs.readFileSync(process.env.FAUNA_RECORDINGS_FILE, 'utf8'));
    expect(index.length).toBe(1);
    // documents-folder copy written
    const docFiles = fs.readdirSync(docsDir);
    expect(docFiles.length).toBe(1);
    expect(docFiles[0]).toContain(rec.id);
    // screenshots preserved
    expect(rec.steps[0].shot).toMatch(/^data:image\/jpeg/);
  });

  it('upserts by sessionId (no duplicate) and keeps the fuller step list', () => {
    const first = store.saveRecording({ sessionId: 'S', name: 'R', steps: [{ id: 'a', t: 0, type: 'click' }] });
    const second = store.saveRecording({ sessionId: 'S', name: 'R', durationMs: 5000, steps: sampleRecording().steps });
    expect(second.id).toBe(first.id);
    expect(store.listRecordings().length).toBe(1);
    expect(second.stepCount).toBe(11);
  });

  it('lists summaries and fetches the full recording by id', () => {
    const rec = store.saveRecording(sampleRecording());
    const list = store.listRecordings();
    expect(list[0].id).toBe(rec.id);
    expect(list[0].stepCount).toBe(11);
    expect(list[0].startUrl).toContain('figma.com');
    const full = store.getRecording(rec.id);
    expect(full.steps.length).toBe(11);
  });

  it('compiles steps to replayable browser-ext-action commands', () => {
    const rec = store.saveRecording(sampleRecording());
    const { actions } = store.compileRecording(rec.id);
    const types = actions.map((a) => a.action);
    expect(types).toContain('navigate');
    expect(types).toContain('click');
    expect(types).toContain('key');
    expect(types).toContain('copy');
    expect(types).toContain('paste');
    expect(types).toContain('tab:switch');
    // selection is context, not replayable
    expect(actions.find((a) => a.action === 'selection')).toBeUndefined();
    // copy/paste carry their tabId
    expect(actions.find((a) => a.action === 'paste').tabId).toBe(2);
  });

  it('describes a recording as a readable outline', () => {
    const rec = store.saveRecording(sampleRecording());
    const d = store.describeRecording(rec.id);
    expect(d.stepCount).toBe(11);
    expect(d.outline).toContain('copy');
    expect(d.outline).toContain('paste');
    expect(d.outline.split('\n').length).toBe(11);
  });

  it('deletes a recording', () => {
    const rec = store.saveRecording(sampleRecording());
    expect(store.deleteRecording(rec.id)).toBe(true);
    expect(store.getRecording(rec.id)).toBeNull();
  });
});

describe('recordings routes (the renderer save path)', () => {
  let app;
  beforeEach(() => { app = makeFakeApp(); registerRecordingsRoutes(app); });

  it('POST /api/recordings saves the renderer live copy and returns ok', () => {
    const res = app.invoke('POST', '/api/recordings', { body: sampleRecording() });
    expect(res.statusCode).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.recording.id).toMatch(/^rec_/);
    expect(res.body.recording.stepCount).toBe(11);
  });

  it('POST then GET list + GET by id round-trips', () => {
    const saved = app.invoke('POST', '/api/recordings', { body: sampleRecording() }).body.recording;
    const list = app.invoke('GET', '/api/recordings').body;
    expect(list.ok).toBe(true);
    expect(list.recordings.some((r) => r.id === saved.id)).toBe(true);
    const full = app.invoke('GET', '/api/recordings/:id', { params: { id: saved.id } }).body;
    expect(full.ok).toBe(true);
    expect(full.recording.steps.length).toBe(11);
  });

  it('duplicate POST with same sessionId does not create a second recording', () => {
    app.invoke('POST', '/api/recordings', { body: sampleRecording() });
    app.invoke('POST', '/api/recordings', { body: sampleRecording() });
    const list = app.invoke('GET', '/api/recordings').body;
    expect(list.recordings.length).toBe(1);
  });

  it('PATCH renames, /compile + /describe work, DELETE removes', () => {
    const saved = app.invoke('POST', '/api/recordings', { body: sampleRecording() }).body.recording;
    const patched = app.invoke('PATCH', '/api/recordings/:id', { params: { id: saved.id }, body: { name: 'Renamed' } }).body;
    expect(patched.recording.name).toBe('Renamed');
    const compiled = app.invoke('GET', '/api/recordings/:id/compile', { params: { id: saved.id } }).body;
    expect(compiled.actions.length).toBeGreaterThan(0);
    const described = app.invoke('GET', '/api/recordings/:id/describe', { params: { id: saved.id } }).body;
    expect(described.outline).toContain('copy');
    const del = app.invoke('DELETE', '/api/recordings/:id', { params: { id: saved.id } }).body;
    expect(del.ok).toBe(true);
    const gone = app.invoke('GET', '/api/recordings/:id', { params: { id: saved.id } });
    expect(gone.statusCode).toBe(404);
  });

  it('404s for a missing recording', () => {
    const res = app.invoke('GET', '/api/recordings/:id', { params: { id: 'nope' } });
    expect(res.statusCode).toBe(404);
    expect(res.body.ok).toBe(false);
  });
});
