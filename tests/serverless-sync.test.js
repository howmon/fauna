import { describe, it, expect, afterEach } from 'vitest';
import express from 'express';
import fs from 'fs';
import fsp from 'fs/promises';
import os from 'os';
import path from 'path';

import { registerServerlessSyncRoutes } from '../server/routes/serverless-sync.js';

const servers = [];
let tmpDir = null;

function makeConversationStore(seed = []) {
  const rows = new Map(seed.map((row) => [row.id, structuredClone(row)]));
  return {
    rows,
    async list({ full = false } = {}) {
      const all = Array.from(rows.values()).map((row) => structuredClone(row));
      return full ? all : all.map((row) => ({ id: row.id, title: row.title, updatedAt: row.updatedAt }));
    },
    async get(id) {
      return rows.has(id) ? structuredClone(rows.get(id)) : null;
    },
    async put(id, conv) {
      const next = { ...(rows.get(id) || {}), ...structuredClone(conv), id };
      rows.set(id, next);
      return structuredClone(next);
    },
    async del(id) {
      return rows.delete(id) ? 1 : 0;
    },
  };
}

function makeProjectManager(seed = []) {
  const rows = new Map(seed.map((row) => [row.id, structuredClone(row)]));
  return {
    rows,
    getAllProjects() { return Array.from(rows.values()).map((row) => structuredClone(row)); },
    getProject(id) { return rows.has(id) ? structuredClone(rows.get(id)) : null; },
    deleteProject(id) { return rows.delete(id); },
    _adoptProject(project) {
      const existing = rows.get(project.id) || {};
      const next = { ...structuredClone(project), rootPath: existing.rootPath || project.rootPath };
      rows.set(project.id, next);
      return next;
    },
    writeSourceFileBytes(projectId, _srcId, relPath, buffer) {
      const project = rows.get(projectId);
      if (!project?.rootPath) throw new Error('Project root missing');
      const full = path.join(project.rootPath, relPath);
      fs.mkdirSync(path.dirname(full), { recursive: true });
      fs.writeFileSync(full, buffer);
      return { path: relPath, type: 'file', size: buffer.length };
    },
    deleteSourceEntry(projectId, _srcId, relPath) {
      const project = rows.get(projectId);
      if (!project?.rootPath) throw new Error('Project root missing');
      fs.unlinkSync(path.join(project.rootPath, relPath));
      return { path: relPath, type: 'file' };
    },
  };
}

async function listen(app) {
  const server = await new Promise((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  servers.push(server);
  return server.address().port;
}

async function makeApp(deps) {
  const app = express();
  app.use(express.json({ limit: '25mb' }));
  const port = await listen(app);
  registerServerlessSyncRoutes(app, { ...deps, port });
  return { app, port };
}

afterEach(async () => {
  while (servers.length) {
    const server = servers.pop();
    await new Promise((resolve) => server.close(resolve));
  }
  delete process.env.FAUNA_SERVERLESS_PEERS_FILE;
  if (tmpDir) await fsp.rm(tmpDir, { recursive: true, force: true });
  tmpDir = null;
});

describe('serverless sync routes', () => {
  it('imports an encrypted peer snapshot without an agentstore account', async () => {
    tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'fauna-serverless-sync-'));
    process.env.FAUNA_SERVERLESS_PEERS_FILE = path.join(tmpDir, 'peers.json');
    const sourceStore = makeConversationStore([
      { id: 'c1', title: 'Peer chat', messages: [{ role: 'user', content: 'hello' }], updatedAt: 2000 },
    ]);
    const sourceProjects = makeProjectManager([
      { id: 'p1', name: 'Peer project', rootPath: '/Users/source/Documents/Fauna/Peer project', updatedAt: 2000 },
    ]);
    const destStore = makeConversationStore();
    const destProjects = makeProjectManager();

    const source = await makeApp({ conversationStore: sourceStore, projectManager: sourceProjects });
    const dest = await makeApp({ conversationStore: destStore, projectManager: destProjects });

    const shareRes = await fetch(`http://127.0.0.1:${source.port}/api/serverless-sync/share`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ relay: false }),
    });
    expect(shareRes.ok).toBe(true);
    const share = await shareRes.json();
    const pair = new URL(share.pairingUrl);
    const token = pair.searchParams.get('token');
    const key = pair.searchParams.get('key');
    expect(token).toBeTruthy();
    expect(key).toBeTruthy();

    const importRes = await fetch(`http://127.0.0.1:${dest.port}/api/serverless-sync/import`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        url: `http://127.0.0.1:${source.port}/api/serverless-sync/snapshot?token=${encodeURIComponent(token)}`,
        token,
        key,
      }),
    });
    expect(importRes.ok).toBe(true);
    const imported = await importRes.json();
    expect(imported.ok).toBe(true);
    expect(imported.stats.projects.imported).toBe(1);
    expect(imported.stats.conversations.imported).toBe(1);
    expect(destProjects.rows.get('p1').name).toBe('Peer project');
    expect(destStore.rows.get('c1').messages[0].content).toBe('hello');
  });

  it('keeps a paired device and syncs later changes in both directions without a new QR', async () => {
    tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'fauna-serverless-sync-'));
    process.env.FAUNA_SERVERLESS_PEERS_FILE = path.join(tmpDir, 'peers.json');
    const sourceStore = makeConversationStore([
      { id: 'c1', title: 'First title', messages: [], updatedAt: 2000 },
    ]);
    const sourceProjects = makeProjectManager();
    const destStore = makeConversationStore();
    const destProjects = makeProjectManager();

    const source = await makeApp({ conversationStore: sourceStore, projectManager: sourceProjects });
    const dest = await makeApp({ conversationStore: destStore, projectManager: destProjects });

    const shareRes = await fetch(`http://127.0.0.1:${source.port}/api/serverless-sync/share`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ relay: false }),
    });
    const share = await shareRes.json();
    const pair = new URL(share.pairingUrl);
    const token = pair.searchParams.get('token');
    const key = pair.searchParams.get('key');
    const url = `http://127.0.0.1:${source.port}/api/serverless-sync/snapshot?token=${encodeURIComponent(token)}`;

    const importRes = await fetch(`http://127.0.0.1:${dest.port}/api/serverless-sync/import`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url, token, key, name: 'Source device' }),
    });
    const imported = await importRes.json();
    expect(imported.ok).toBe(true);
    expect(imported.peer.id).toBeTruthy();

    await sourceStore.put('c1', { id: 'c1', title: 'Updated title', messages: [], updatedAt: 3000 });
    await destStore.put('c2', { id: 'c2', title: 'Destination title', messages: [{ role: 'user', content: 'from destination' }], updatedAt: 4000 });

    const syncRes = await fetch(`http://127.0.0.1:${dest.port}/api/serverless-sync/peers/${imported.peer.id}/sync`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ push: true }),
    });
    expect(syncRes.ok).toBe(true);
    const synced = await syncRes.json();
    expect(synced.ok).toBe(true);
    expect(synced.stats.conversations.imported).toBe(1);
    expect(synced.pushed.conversations.imported).toBe(1);
    expect(destStore.rows.get('c1').title).toBe('Updated title');
    expect(sourceStore.rows.get('c2').messages[0].content).toBe('from destination');

    const peersRes = await fetch(`http://127.0.0.1:${dest.port}/api/serverless-sync/peers`);
    const peers = await peersRes.json();
    expect(peers.peers).toHaveLength(1);
    expect(peers.peers[0].name).toBe('Source device');
  });

  it('records a conflict instead of overwriting divergent local edits', async () => {
    tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'fauna-serverless-sync-'));
    process.env.FAUNA_SERVERLESS_PEERS_FILE = path.join(tmpDir, 'peers.json');
    const sourceStore = makeConversationStore([
      { id: 'c1', title: 'Original', messages: [], updatedAt: new Date(Date.now() - 10_000).toISOString() },
    ]);
    const destStore = makeConversationStore();

    const source = await makeApp({ conversationStore: sourceStore, projectManager: makeProjectManager() });
    const dest = await makeApp({ conversationStore: destStore, projectManager: makeProjectManager() });

    const shareRes = await fetch(`http://127.0.0.1:${source.port}/api/serverless-sync/share`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ relay: false }),
    });
    const share = await shareRes.json();
    const pair = new URL(share.pairingUrl);
    const token = pair.searchParams.get('token');
    const key = pair.searchParams.get('key');
    const url = `http://127.0.0.1:${source.port}/api/serverless-sync/snapshot?token=${encodeURIComponent(token)}`;

    const importRes = await fetch(`http://127.0.0.1:${dest.port}/api/serverless-sync/import`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url, token, key, name: 'Source device' }),
    });
    const imported = await importRes.json();
    expect(imported.ok).toBe(true);

    await destStore.put('c1', { id: 'c1', title: 'Destination edit', messages: [], updatedAt: new Date(Date.now() + 10_000).toISOString() });
    await sourceStore.put('c1', { id: 'c1', title: 'Source edit', messages: [], updatedAt: new Date(Date.now() + 20_000).toISOString() });

    const syncRes = await fetch(`http://127.0.0.1:${dest.port}/api/serverless-sync/peers/${imported.peer.id}/sync`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ push: true }),
    });
    expect(syncRes.ok).toBe(true);
    const synced = await syncRes.json();
    expect(synced.stats.conflicts.detected).toBe(1);
    expect(destStore.rows.get('c1').title).toBe('Destination edit');

    const peersRes = await fetch(`http://127.0.0.1:${dest.port}/api/serverless-sync/peers`);
    const peers = await peersRes.json();
    expect(peers.peers[0].conflictCount).toBe(1);
    expect(peers.conflicts[0].namespace).toBe('conversation');
  });

  it('propagates unchanged project file deletes with file deltas', async () => {
    tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'fauna-serverless-sync-'));
    process.env.FAUNA_SERVERLESS_PEERS_FILE = path.join(tmpDir, 'peers.json');
    const sourceRoot = path.join(tmpDir, 'source-root');
    const destRoot = path.join(tmpDir, 'dest-root');
    fs.mkdirSync(path.join(sourceRoot, 'src'), { recursive: true });
    fs.mkdirSync(destRoot, { recursive: true });
    fs.writeFileSync(path.join(sourceRoot, 'src', 'note.txt'), 'sync me');

    const sourceStore = makeConversationStore();
    const destStore = makeConversationStore();
    const sourceProjects = makeProjectManager([
      { id: 'p1', name: 'Files', rootPath: sourceRoot, updatedAt: 1000 },
    ]);
    const destProjects = makeProjectManager([
      { id: 'p1', name: 'Files', rootPath: destRoot, updatedAt: 0 },
    ]);

    const source = await makeApp({ conversationStore: sourceStore, projectManager: sourceProjects });
    const dest = await makeApp({ conversationStore: destStore, projectManager: destProjects });

    const shareRes = await fetch(`http://127.0.0.1:${source.port}/api/serverless-sync/share`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ relay: false, includeFiles: true }),
    });
    const share = await shareRes.json();
    const pair = new URL(share.pairingUrl);
    const token = pair.searchParams.get('token');
    const key = pair.searchParams.get('key');
    const url = `http://127.0.0.1:${source.port}/api/serverless-sync/snapshot?token=${encodeURIComponent(token)}`;

    const importRes = await fetch(`http://127.0.0.1:${dest.port}/api/serverless-sync/import`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url, token, key, name: 'Source device' }),
    });
    const imported = await importRes.json();
    expect(imported.ok).toBe(true);
    expect(fs.existsSync(path.join(destRoot, 'src', 'note.txt'))).toBe(true);

    fs.unlinkSync(path.join(sourceRoot, 'src', 'note.txt'));
    const syncRes = await fetch(`http://127.0.0.1:${dest.port}/api/serverless-sync/peers/${imported.peer.id}/sync`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ push: true, includeFiles: true }),
    });
    expect(syncRes.ok).toBe(true);
    const synced = await syncRes.json();
    expect(synced.stats.fileDeletes.applied).toBe(1);
    expect(fs.existsSync(path.join(destRoot, 'src', 'note.txt'))).toBe(false);
  });

  it('propagates unchanged conversation and project deletes', async () => {
    tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'fauna-serverless-sync-'));
    process.env.FAUNA_SERVERLESS_PEERS_FILE = path.join(tmpDir, 'peers.json');
    const sourceStore = makeConversationStore([
      { id: 'c1', title: 'Delete me', messages: [], updatedAt: 1000 },
    ]);
    const destStore = makeConversationStore();
    const sourceProjects = makeProjectManager([
      { id: 'p1', name: 'Delete project', rootPath: path.join(tmpDir, 'source-root'), updatedAt: 1000 },
    ]);
    const destProjects = makeProjectManager();

    const source = await makeApp({ conversationStore: sourceStore, projectManager: sourceProjects });
    const dest = await makeApp({ conversationStore: destStore, projectManager: destProjects });

    const shareRes = await fetch(`http://127.0.0.1:${source.port}/api/serverless-sync/share`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ relay: false }),
    });
    const share = await shareRes.json();
    const pair = new URL(share.pairingUrl);
    const token = pair.searchParams.get('token');
    const key = pair.searchParams.get('key');
    const url = `http://127.0.0.1:${source.port}/api/serverless-sync/snapshot?token=${encodeURIComponent(token)}`;

    const importRes = await fetch(`http://127.0.0.1:${dest.port}/api/serverless-sync/import`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url, token, key, name: 'Source device' }),
    });
    const imported = await importRes.json();
    expect(imported.ok).toBe(true);
    expect(destStore.rows.has('c1')).toBe(true);
    expect(destProjects.rows.has('p1')).toBe(true);

    await sourceStore.del('c1');
    sourceProjects.deleteProject('p1');

    const syncRes = await fetch(`http://127.0.0.1:${dest.port}/api/serverless-sync/peers/${imported.peer.id}/sync`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ push: true }),
    });
    expect(syncRes.ok).toBe(true);
    const synced = await syncRes.json();
    expect(synced.stats.conversationDeletes.applied).toBe(1);
    expect(synced.stats.projectDeletes.applied).toBe(1);
    expect(destStore.rows.has('c1')).toBe(false);
    expect(destProjects.rows.has('p1')).toBe(false);
  });
});
