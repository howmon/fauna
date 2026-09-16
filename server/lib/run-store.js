import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { EventEmitter } from 'node:events';
import { saveJsonAtomic } from './json-store.js';

const TERMINAL_STATUSES = new Set(['completed', 'failed', 'cancelled']);

function safeId(value) {
  const id = String(value || '');
  if (!/^[a-zA-Z0-9_.-]+$/.test(id)) throw new Error('Invalid run id');
  return id;
}

function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (_) { return fallback; }
}

function readJsonl(file) {
  let raw = '';
  try { raw = fs.readFileSync(file, 'utf8'); } catch (_) { return []; }
  return raw.split('\n').filter(Boolean).flatMap(line => {
    try { return [JSON.parse(line)]; } catch (_) { return []; }
  });
}

export function createRunStore({ configDir }) {
  const dir = path.join(configDir, 'runs');
  const indexFile = path.join(dir, 'index.json');
  const emitter = new EventEmitter();

  function readIndex() {
    const value = readJson(indexFile, { schema: 1, runs: [] });
    return value && Array.isArray(value.runs) ? value : { schema: 1, runs: [] };
  }

  function writeIndex(index) {
    fs.mkdirSync(dir, { recursive: true });
    saveJsonAtomic(indexFile, index);
  }

  function eventFile(runId) {
    return path.join(dir, `${safeId(runId)}.jsonl`);
  }

  function get(runId) {
    return readIndex().runs.find(run => run.id === runId) || null;
  }

  function update(runId, patch) {
    const index = readIndex();
    const position = index.runs.findIndex(run => run.id === runId);
    if (position < 0) return null;
    const current = index.runs[position];
    const nextPatch = typeof patch === 'function' ? patch(current) : patch;
    const next = { ...current, ...nextPatch, id: current.id, updatedAt: Date.now() };
    index.runs[position] = next;
    writeIndex(index);
    return next;
  }

  function create(meta = {}) {
    const now = Date.now();
    const id = safeId(meta.id || `run-${now}-${crypto.randomBytes(4).toString('hex')}`);
    if (get(id)) throw new Error(`Run already exists: ${id}`);
    const run = {
      id,
      kind: meta.kind || 'chat',
      status: meta.status || 'running',
      conversationId: meta.conversationId || null,
      projectId: meta.projectId || null,
      agentName: meta.agentName || null,
      parentRunId: meta.parentRunId || null,
      ownerId: meta.ownerId || null,
      model: meta.model || null,
      capabilitySnapshot: meta.capabilitySnapshot || null,
      nextEventId: 1,
      createdAt: now,
      updatedAt: now,
      completedAt: null,
      pause: null,
      controls: [],
    };
    const index = readIndex();
    index.runs.push(run);
    writeIndex(index);
    append(id, 'run.created', { run: { ...run, controls: undefined } });
    return get(id);
  }

  function append(runId, type, data = {}) {
    const run = get(runId);
    if (!run) throw new Error(`Run not found: ${runId}`);
    const event = { id: run.nextEventId, runId, type, ts: Date.now(), data };
    fs.mkdirSync(dir, { recursive: true });
    fs.appendFileSync(eventFile(runId), JSON.stringify(event) + '\n');
    update(runId, { nextEventId: event.id + 1 });
    emitter.emit(runId, event);
    emitter.emit('*', event);
    return event;
  }

  function events(runId, { after = 0, limit = 1000 } = {}) {
    const cursor = Math.max(0, Number(after) || 0);
    const cap = Math.max(1, Math.min(5000, Number(limit) || 1000));
    return readJsonl(eventFile(runId)).filter(event => event.id > cursor).slice(0, cap);
  }

  function list(filters = {}) {
    return readIndex().runs
      .filter(run => !filters.kind || run.kind === filters.kind)
      .filter(run => !filters.status || run.status === filters.status)
      .filter(run => !filters.conversationId || run.conversationId === filters.conversationId)
      .filter(run => !filters.projectId || run.projectId === filters.projectId)
      .sort((a, b) => b.updatedAt - a.updatedAt);
  }

  function setStatus(runId, status, detail = {}) {
    const completedAt = TERMINAL_STATUSES.has(status) ? Date.now() : null;
    const run = update(runId, { status, completedAt, pause: status === 'paused' ? get(runId)?.pause : null });
    if (!run) return null;
    append(runId, `run.${status}`, detail);
    return get(runId);
  }

  function pause(runId, pauseRecord) {
    const pause = {
      id: pauseRecord?.id || `pause-${crypto.randomBytes(6).toString('hex')}`,
      type: pauseRecord?.type || 'approval',
      status: 'pending',
      prompt: pauseRecord?.prompt || '',
      payload: pauseRecord?.payload || null,
      createdAt: Date.now(),
      expiresAt: pauseRecord?.expiresAt || null,
      resolution: null,
    };
    update(runId, { status: 'paused', pause });
    append(runId, 'run.paused', { pause });
    return pause;
  }

  function resolvePause(runId, pauseId, resolution) {
    const run = get(runId);
    if (!run?.pause || run.pause.id !== pauseId || run.pause.status !== 'pending') return null;
    const pause = { ...run.pause, status: 'resolved', resolvedAt: Date.now(), resolution };
    update(runId, { status: 'running', pause });
    append(runId, 'run.resumed', { pauseId, resolution });
    return pause;
  }

  function enqueueControl(runId, action, payload = {}) {
    if (!['steer', 'queue', 'interrupt', 'cancel'].includes(action)) throw new Error('Invalid run control');
    const control = { id: `ctl-${crypto.randomBytes(6).toString('hex')}`, action, payload, status: 'pending', createdAt: Date.now() };
    update(runId, run => ({ controls: [...(run.controls || []), control] }));
    append(runId, 'run.control.queued', { control });
    return control;
  }

  function takeControls(runId, actions = null) {
    const run = get(runId);
    if (!run) return [];
    const allowed = actions ? new Set(actions) : null;
    const taken = (run.controls || []).filter(item => item.status === 'pending' && (!allowed || allowed.has(item.action)));
    if (!taken.length) return [];
    const ids = new Set(taken.map(item => item.id));
    update(runId, current => ({
      controls: (current.controls || []).map(item => ids.has(item.id) ? { ...item, status: 'applied', appliedAt: Date.now() } : item),
    }));
    for (const control of taken) append(runId, 'run.control.applied', { controlId: control.id, action: control.action });
    return taken;
  }

  function subscribe(runId, listener) {
    emitter.on(runId, listener);
    return () => emitter.off(runId, listener);
  }

  function summary(runId) {
    const run = get(runId);
    if (!run) return null;
    const allEvents = events(runId, { limit: 5000 });
    const tools = allEvents.filter(event => event.type === 'tool.completed');
    const models = allEvents.filter(event => event.type === 'model.response');
    return {
      run,
      eventCount: allEvents.length,
      lastEventId: allEvents.at(-1)?.id || 0,
      toolCalls: tools.length,
      toolFailures: tools.filter(event => event.data?.ok === false).length,
      promptTokens: models.reduce((sum, event) => sum + (Number(event.data?.promptTokens) || 0), 0),
      completionTokens: models.reduce((sum, event) => sum + (Number(event.data?.completionTokens) || 0), 0),
      durationMs: (run.completedAt || Date.now()) - run.createdAt,
    };
  }

  return { create, get, update, list, append, events, setStatus, pause, resolvePause, enqueueControl, takeControls, subscribe, summary };
}
