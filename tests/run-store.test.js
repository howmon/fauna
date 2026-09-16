import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createRunStore } from '../server/lib/run-store.js';

const dirs = [];

function makeStore() {
  const configDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fauna-run-store-'));
  dirs.push(configDir);
  return { configDir, store: createRunStore({ configDir }) };
}

afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe('run store', () => {
  it('persists metadata and replays events after a cursor', () => {
    const { configDir, store } = makeStore();
    const run = store.create({ id: 'run-1', kind: 'chat', conversationId: 'conv-1' });
    store.append(run.id, 'content', { content: 'one' });
    store.append(run.id, 'content', { content: 'two' });

    const reopened = createRunStore({ configDir });
    expect(reopened.get(run.id).conversationId).toBe('conv-1');
    expect(reopened.events(run.id, { after: 1 }).map(event => event.data.content)).toEqual(['one', 'two']);
  });

  it('persists pauses and resolves them idempotently', () => {
    const { store } = makeStore();
    const run = store.create({ id: 'approval-run' });
    const pause = store.pause(run.id, { type: 'approval', prompt: 'Allow shell?' });

    expect(store.get(run.id).status).toBe('paused');
    expect(store.resolvePause(run.id, pause.id, { decision: 'allow' }).resolution.decision).toBe('allow');
    expect(store.get(run.id).status).toBe('running');
    expect(store.resolvePause(run.id, pause.id, { decision: 'deny' })).toBeNull();
  });

  it('queues controls and computes a trace summary', () => {
    const { store } = makeStore();
    const run = store.create({ id: 'controlled-run', projectId: 'project-1' });
    store.enqueueControl(run.id, 'steer', { text: 'Focus on tests' });
    expect(store.takeControls(run.id, ['steer'])).toHaveLength(1);
    expect(store.takeControls(run.id, ['steer'])).toEqual([]);

    store.append(run.id, 'model.response', { promptTokens: 20, completionTokens: 5 });
    store.append(run.id, 'tool.completed', { toolName: 'shell', ok: false });
    store.setStatus(run.id, 'completed');
    expect(store.summary(run.id)).toMatchObject({ toolCalls: 1, toolFailures: 1, promptTokens: 20, completionTokens: 5 });
  });

  it('preserves queued control order and pending pauses across restart', () => {
    const { configDir, store } = makeStore();
    const run = store.create({ id: 'restart-run' });
    store.enqueueControl(run.id, 'queue', { text: 'first' });
    store.enqueueControl(run.id, 'queue', { text: 'second' });
    const pause = store.pause(run.id, { type: 'user_action', prompt: 'Choose a path' });

    const reopened = createRunStore({ configDir });
    expect(reopened.get(run.id).pause).toMatchObject({ id: pause.id, status: 'pending', type: 'user_action' });
    expect(reopened.takeControls(run.id, ['queue']).map(control => control.payload.text)).toEqual(['first', 'second']);
  });
});