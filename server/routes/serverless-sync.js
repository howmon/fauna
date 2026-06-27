import crypto from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';
import zlib from 'zlib';
import QRCode from 'qrcode';
import localtunnel from 'localtunnel';

import * as pathPortability from '../lib/path-portability.js';

const SESSION_TTL_MS = 15 * 60 * 1000;
const SNAPSHOT_AAD_PREFIX = 'fauna-serverless-sync:v1:';
const MAX_IMPORT_BYTES = 100 * 1024 * 1024;
const MAX_FILE_BYTES = Number(process.env.FAUNA_SERVERLESS_SYNC_MAX_FILE_BYTES) || (5 * 1024 * 1024);
const MAX_TOTAL_FILE_BYTES = Number(process.env.FAUNA_SERVERLESS_SYNC_MAX_TOTAL_FILE_BYTES) || (75 * 1024 * 1024);
const MAX_FILE_COUNT = Number(process.env.FAUNA_SERVERLESS_SYNC_MAX_FILE_COUNT) || 2000;
const IGNORE_DIRS = new Set(['.git', 'node_modules', 'dist', 'build', 'out', '.next', '.cache', 'coverage', '.venv', 'venv', 'target']);
const IGNORE_FILES = new Set(['.DS_Store', 'Thumbs.db', '.env', '.env.local']);

function _stateFile() {
  return process.env.FAUNA_SERVERLESS_PEERS_FILE || path.join(os.homedir(), '.config', 'fauna', 'serverless-peers.json');
}

function _readPeerState() {
  try {
    const data = JSON.parse(fs.readFileSync(_stateFile(), 'utf8'));
    return {
      peers: Array.isArray(data?.peers) ? data.peers : [],
      shares: Array.isArray(data?.shares) ? data.shares : [],
      conflicts: Array.isArray(data?.conflicts) ? data.conflicts : [],
    };
  } catch (_) {
    return { peers: [], shares: [], conflicts: [] };
  }
}

function _writePeerState(state) {
  const file = _stateFile();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}`;
  fs.writeFileSync(tmp, JSON.stringify({ peers: state.peers || [], shares: state.shares || [], conflicts: state.conflicts || [] }, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, file);
  try { fs.chmodSync(file, 0o600); } catch (_) {}
}

function _b64url(buf) {
  return Buffer.from(buf).toString('base64url');
}

function _fromB64url(s) {
  return Buffer.from(String(s || ''), 'base64url');
}

function _hostname() {
  return os.hostname() || 'Fauna device';
}

function _lanIps() {
  const ips = [];
  for (const iface of Object.values(os.networkInterfaces())) {
    for (const addr of (iface || [])) {
      if (addr.family === 'IPv4' && !addr.internal) ips.push(addr.address);
    }
  }
  return ips;
}

function _pairingUrl({ shareUrl, token, key, name }) {
  const params = new URLSearchParams({ url: shareUrl, token, key, name });
  return `fauna://serverless-sync?${params.toString()}`;
}

function _peerId({ url, token }) {
  return crypto.createHash('sha256').update(`${url}\n${token}`).digest('hex').slice(0, 16);
}

function _encryptSnapshot(snapshot, keyB64, token) {
  const key = _fromB64url(keyB64);
  if (key.length !== 32) throw new Error('bad pairing key');
  const nonce = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, nonce);
  cipher.setAAD(Buffer.from(SNAPSHOT_AAD_PREFIX + token, 'utf8'));
  const plain = Buffer.from(JSON.stringify(snapshot), 'utf8');
  const gz = zlib.gzipSync(plain, { level: zlib.constants.Z_BEST_COMPRESSION });
  const ct = Buffer.concat([cipher.update(gz), cipher.final()]);
  const tag = cipher.getAuthTag();
  return {
    serverlessSync: 1,
    alg: 'A256GCM',
    z: 'gzip',
    n: _b64url(nonce),
    c: _b64url(Buffer.concat([ct, tag])),
  };
}

function _decryptSnapshot(envelope, keyB64, token) {
  if (!envelope || envelope.serverlessSync !== 1 || envelope.alg !== 'A256GCM') {
    throw new Error('not a Fauna serverless sync envelope');
  }
  const key = _fromB64url(keyB64);
  const nonce = _fromB64url(envelope.n);
  const blob = _fromB64url(envelope.c);
  if (key.length !== 32 || nonce.length !== 12 || blob.length < 17) {
    throw new Error('invalid encrypted snapshot');
  }
  const ct = blob.subarray(0, blob.length - 16);
  const tag = blob.subarray(blob.length - 16);
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, nonce);
  decipher.setAAD(Buffer.from(SNAPSHOT_AAD_PREFIX + token, 'utf8'));
  decipher.setAuthTag(tag);
  const zipped = Buffer.concat([decipher.update(ct), decipher.final()]);
  const json = (envelope.z === 'gzip') ? zlib.gunzipSync(zipped).toString('utf8') : zipped.toString('utf8');
  return JSON.parse(json);
}

function _newSession(baseUrl, opts = {}) {
  const token = crypto.randomBytes(32).toString('hex');
  const key = _b64url(crypto.randomBytes(32));
  const shareUrl = `${baseUrl.replace(/\/+$/, '')}/api/serverless-sync/snapshot?token=${encodeURIComponent(token)}`;
  return {
    id: token.slice(0, 16),
    token,
    key,
    shareUrl,
    createdAt: Date.now(),
    expiresAt: opts.persistent ? null : Date.now() + SESSION_TTL_MS,
    uses: 0,
    includeFiles: !!opts.includeFiles,
    persistent: !!opts.persistent,
    revoked: false,
  };
}

function _fresh(session) {
  return session && !session.revoked && (session.persistent || session.expiresAt > Date.now());
}

function _ts(v) {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  const n = Date.parse(v || '');
  return Number.isFinite(n) ? n : 0;
}

function _stableStringify(value) {
  if (Array.isArray(value)) return `[${value.map(_stableStringify).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${_stableStringify(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function _objectHash(value) {
  return crypto.createHash('sha256').update(_stableStringify(value)).digest('hex');
}

function _shouldApply(incoming, existing) {
  if (!existing) return true;
  return _ts(incoming?.updatedAt || incoming?.createdAt) >= _ts(existing?.updatedAt || existing?.createdAt);
}

function _hasDivergentLocalEdit(incoming, existing, since) {
  if (!incoming || !existing || !since) return false;
  const incomingTs = _ts(incoming.updatedAt || incoming.createdAt);
  const existingTs = _ts(existing.updatedAt || existing.createdAt);
  const sinceTs = _ts(since);
  if (!incomingTs || !existingTs || incomingTs <= sinceTs || existingTs <= sinceTs) return false;
  return _objectHash(incoming) !== _objectHash(existing);
}

function _safeRel(relPath) {
  const rel = String(relPath || '').replace(/^\/+/, '').replace(/\\/g, '/');
  if (!rel || rel === '.' || rel === '..') return null;
  const parts = rel.split('/').filter(Boolean);
  if (!parts.length) return null;
  for (const part of parts) {
    if (part === '.' || part === '..' || part.includes('\0')) return null;
  }
  return parts.join('/');
}

function _walkFiles(root) {
  const out = [];
  const stack = [''];
  while (stack.length && out.length < MAX_FILE_COUNT) {
    const rel = stack.pop();
    let entries = [];
    try { entries = fs.readdirSync(path.join(root, rel), { withFileTypes: true }); }
    catch (_) { continue; }
    for (const ent of entries) {
      if (ent.isSymbolicLink()) continue;
      if (ent.isDirectory()) {
        if (!IGNORE_DIRS.has(ent.name)) stack.push(rel ? path.posix.join(rel, ent.name) : ent.name);
        continue;
      }
      if (!ent.isFile() || IGNORE_FILES.has(ent.name)) continue;
      out.push(rel ? path.posix.join(rel, ent.name) : ent.name);
      if (out.length >= MAX_FILE_COUNT) break;
    }
  }
  return out;
}

function _collectProjectFiles(projects) {
  const files = [];
  let totalBytes = 0;
  for (const project of projects) {
    if (!project || !project.id || !project.rootPath) continue;
    const root = project.rootPath;
    let rootStat = null;
    try { rootStat = fs.statSync(root); } catch (_) {}
    if (!rootStat || !rootStat.isDirectory()) continue;
    for (const relPath of _walkFiles(root)) {
      const safeRel = _safeRel(relPath);
      if (!safeRel) continue;
      const abs = path.resolve(path.join(root, safeRel));
      const resolvedRoot = path.resolve(root);
      if (!abs.startsWith(resolvedRoot + path.sep)) continue;
      let stat = null;
      try { stat = fs.statSync(abs); } catch (_) { continue; }
      if (!stat.isFile() || stat.size > MAX_FILE_BYTES) continue;
      if (totalBytes + stat.size > MAX_TOTAL_FILE_BYTES) return files;
      let buf;
      try { buf = fs.readFileSync(abs); } catch (_) { continue; }
      totalBytes += buf.length;
      files.push({
        projectId: project.id,
        relPath: safeRel,
        encoding: 'base64',
        content: buf.toString('base64'),
        size: buf.length,
        mtimeMs: stat.mtimeMs,
        hash: crypto.createHash('sha256').update(buf).digest('hex'),
      });
    }
  }
  return files;
}

function _manifestMap(items) {
  const map = new Map();
  for (const item of Array.isArray(items) ? items : []) {
    if (item && item.id) map.set(item.id, item);
  }
  return map;
}

function _fileManifestId(file) {
  return `${file.projectId}:${file.relPath}`;
}

function _remoteNeedsObject(local, remote) {
  if (!local || !local.id) return false;
  if (!remote) return true;
  return _ts(local.updatedAt || local.createdAt) > _ts(remote.updatedAt || remote.createdAt);
}

function _remoteNeedsFile(local, remote) {
  if (!local || !local.projectId || !local.relPath) return false;
  if (!remote) return true;
  if (local.hash && remote.hash) return local.hash !== remote.hash;
  return Number(local.mtimeMs || 0) > Number(remote.mtimeMs || 0) || Number(local.size || 0) !== Number(remote.size || 0);
}

function _deletedFiles(previousManifest = {}, currentManifest = {}, remoteManifest = {}) {
  const currentFiles = _manifestMap(currentManifest.files);
  const remoteFiles = _manifestMap(remoteManifest.files);
  const out = [];
  for (const previous of Array.isArray(previousManifest.files) ? previousManifest.files : []) {
    if (!previous?.id || currentFiles.has(previous.id)) continue;
    const remote = remoteFiles.get(previous.id);
    if (!remote) continue;
    if (previous.hash && remote.hash && previous.hash !== remote.hash) continue;
    out.push({
      id: previous.id,
      projectId: previous.projectId,
      relPath: previous.relPath,
      deleted: true,
      previousHash: previous.hash || null,
      previousSize: previous.size || 0,
      deletedAt: new Date().toISOString(),
    });
  }
  return out;
}

function _deletedObjects(namespace, previousItems = [], currentItems = [], remoteItems = []) {
  const current = _manifestMap(currentItems);
  const remote = _manifestMap(remoteItems);
  const out = [];
  for (const previous of Array.isArray(previousItems) ? previousItems : []) {
    if (!previous?.id || current.has(previous.id)) continue;
    const remoteItem = remote.get(previous.id);
    if (!remoteItem) continue;
    const previousTs = _ts(previous.updatedAt || previous.createdAt);
    const remoteTs = _ts(remoteItem.updatedAt || remoteItem.createdAt);
    if (previousTs && remoteTs > previousTs) continue;
    out.push({
      id: previous.id,
      namespace,
      deleted: true,
      previousUpdatedAt: previous.updatedAt || previous.createdAt || null,
      deletedAt: new Date().toISOString(),
    });
  }
  return out;
}

async function _fetchJson(url, token) {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), 60_000);
  try {
    const res = await fetch(url, {
      headers: { 'Accept': 'application/json', 'X-Fauna-Serverless-Token': token },
      signal: ac.signal,
    });
    const text = await res.text();
    if (text.length > MAX_IMPORT_BYTES) throw new Error('snapshot too large');
    let body = null;
    try { body = text ? JSON.parse(text) : null; } catch (_) {}
    if (!res.ok) {
      const msg = (body && (body.error || body.message)) || `HTTP ${res.status}`;
      throw new Error(msg);
    }
    if (!body) throw new Error('empty snapshot response');
    return body;
  } finally {
    clearTimeout(timer);
  }
}

async function _postJson(url, token, body) {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), 60_000);
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Accept': 'application/json', 'Content-Type': 'application/json', 'X-Fauna-Serverless-Token': token },
      body: JSON.stringify(body),
      signal: ac.signal,
    });
    const text = await res.text();
    if (text.length > MAX_IMPORT_BYTES) throw new Error('response too large');
    let parsed = null;
    try { parsed = text ? JSON.parse(text) : null; } catch (_) {}
    if (!res.ok) {
      const msg = (parsed && (parsed.error || parsed.message)) || `HTTP ${res.status}`;
      throw new Error(msg);
    }
    return parsed || { ok: true };
  } finally {
    clearTimeout(timer);
  }
}

function _pushUrlFromSnapshotUrl(snapshotUrl) {
  const u = new URL(snapshotUrl);
  u.pathname = u.pathname.replace(/\/snapshot$/, '/push');
  return u.toString();
}

function _deltaUrlFromSnapshotUrl(snapshotUrl) {
  const u = new URL(snapshotUrl);
  u.pathname = u.pathname.replace(/\/snapshot$/, '/delta');
  return u.toString();
}

function _parsePairInput(body = {}) {
  if (body.pairUrl) {
    const u = new URL(String(body.pairUrl));
    if (u.protocol !== 'fauna:') throw new Error('pairing link must start with fauna://');
    const params = u.searchParams;
    return {
      url: params.get('url'),
      token: params.get('token'),
      key: params.get('key'),
      name: params.get('name'),
    };
  }
  return { url: body.url, token: body.token, key: body.key, name: body.name };
}

export function registerServerlessSyncRoutes(app, deps = {}) {
  const { conversationStore, projectManager, port } = deps;
  if (!conversationStore) throw new Error('registerServerlessSyncRoutes: conversationStore required');
  if (!projectManager) throw new Error('registerServerlessSyncRoutes: projectManager required');

  const sessions = new Map();
  let relay = null;
  let relayUrl = null;

  for (const share of _readPeerState().shares) {
    if (share && share.token && !share.revoked) sessions.set(share.token, share);
  }

  function saveShare(session) {
    const state = _readPeerState();
    const idx = state.shares.findIndex((s) => s.token === session.token);
    const saved = { ...session, key: session.key };
    if (idx >= 0) state.shares[idx] = { ...state.shares[idx], ...saved };
    else state.shares.push(saved);
    _writePeerState(state);
  }

  function savePeer(pair, result = {}) {
    const state = _readPeerState();
    const id = _peerId({ url: pair.url, token: pair.token });
    const nowIso = new Date().toISOString();
    const peer = {
      id,
      name: pair.name || result.source?.name || 'Fauna device',
      url: pair.url,
      token: pair.token,
      key: pair.key,
      createdAt: nowIso,
      lastSyncAt: nowIso,
      lastStats: result.stats || null,
    };
    if (result.localManifest) peer.localManifest = result.localManifest;
    if (result.remoteManifest) peer.remoteManifest = result.remoteManifest;
    const idx = state.peers.findIndex((p) => p.id === id);
    if (idx >= 0) state.peers[idx] = { ...state.peers[idx], ...peer, createdAt: state.peers[idx].createdAt || peer.createdAt };
    else state.peers.push(peer);
    _writePeerState(state);
    return peer;
  }

  function publicPeer(peer) {
    const state = _readPeerState();
    const conflictCount = state.conflicts.filter((c) => c.peerId === peer.id && c.status !== 'resolved').length;
    return {
      id: peer.id,
      name: peer.name,
      url: peer.url,
      createdAt: peer.createdAt,
      lastSyncAt: peer.lastSyncAt,
      lastStats: peer.lastStats || null,
      conflictCount,
    };
  }

  function recordConflict({ peerId, namespace, objectId, local, remote }) {
    const state = _readPeerState();
    const localHash = _objectHash(local);
    const remoteHash = _objectHash(remote);
    const id = crypto.createHash('sha256').update(`${peerId || 'unknown'}:${namespace}:${objectId}:${localHash}:${remoteHash}`).digest('hex').slice(0, 24);
    const existing = state.conflicts.find((c) => c.id === id);
    const row = {
      id,
      peerId: peerId || null,
      namespace,
      objectId,
      status: 'open',
      detectedAt: new Date().toISOString(),
      localUpdatedAt: local?.updatedAt || local?.createdAt || null,
      remoteUpdatedAt: remote?.updatedAt || remote?.createdAt || null,
      localHash,
      remoteHash,
    };
    if (existing) Object.assign(existing, row, { detectedAt: existing.detectedAt || row.detectedAt });
    else state.conflicts.push(row);
    _writePeerState(state);
    return row;
  }

  async function ensureRelay() {
    if (relayUrl) return relayUrl;
    const tunnelOptions = { port };
    const subdomain = process.env.FAUNA_SERVERLESS_TUNNEL_SUBDOMAIN || '';
    if (subdomain) tunnelOptions.subdomain = subdomain;
    relay = await localtunnel(tunnelOptions);
    relayUrl = relay.url;
    relay.on('close', () => { relay = null; relayUrl = null; });
    relay.on('error', (err) => console.warn('[serverless-sync relay] error:', err?.message || err));
    return relayUrl;
  }

  async function buildSnapshot(session) {
    const conversations = await conversationStore.list({ full: true });
    const localProjects = (projectManager.getAllProjects?.() || []);
    const projects = localProjects.map((project) => pathPortability.serializeForWire(project, ['rootPath', 'clonePath']));
    const files = session?.includeFiles ? _collectProjectFiles(localProjects) : [];
    return {
      version: 1,
      exportedAt: new Date().toISOString(),
      device: { name: _hostname(), platform: process.platform },
      namespaces: files.length ? ['project', 'conversation', 'project_file'] : ['project', 'conversation'],
      projects,
      conversations,
      files,
    };
  }

  async function buildManifest(opts = {}) {
    const conversations = await conversationStore.list({ full: true });
    const localProjects = (projectManager.getAllProjects?.() || []);
    const files = opts.includeFiles ? _collectProjectFiles(localProjects) : [];
    return {
      version: 1,
      exportedAt: new Date().toISOString(),
      device: { name: _hostname(), platform: process.platform },
      projects: localProjects.filter((project) => project?.id).map((project) => ({ id: project.id, updatedAt: project.updatedAt || project.createdAt || null })),
      conversations: conversations.filter((conv) => conv?.id).map((conv) => ({ id: conv.id, updatedAt: conv.updatedAt || conv.createdAt || null })),
      files: files.map((file) => ({ id: _fileManifestId(file), projectId: file.projectId, relPath: file.relPath, size: file.size, mtimeMs: file.mtimeMs, hash: file.hash })),
    };
  }

  async function buildDelta(remoteManifest = {}, opts = {}) {
    const snapshot = await buildSnapshot({ includeFiles: !!opts.includeFiles });
    const currentManifest = await buildManifest({ includeFiles: !!opts.includeFiles });
    const remoteProjects = _manifestMap(remoteManifest.projects);
    const remoteConversations = _manifestMap(remoteManifest.conversations);
    const remoteFiles = _manifestMap(remoteManifest.files);
    snapshot.projects = snapshot.projects.filter((project) => _remoteNeedsObject(project, remoteProjects.get(project.id)));
    snapshot.conversations = snapshot.conversations.filter((conv) => _remoteNeedsObject(conv, remoteConversations.get(conv.id)));
    snapshot.files = snapshot.files.filter((file) => _remoteNeedsFile(file, remoteFiles.get(_fileManifestId(file))));
    snapshot.projectDeletes = _deletedObjects('project', opts.previousManifest?.projects, currentManifest.projects, remoteManifest.projects);
    snapshot.conversationDeletes = _deletedObjects('conversation', opts.previousManifest?.conversations, currentManifest.conversations, remoteManifest.conversations);
    snapshot.fileDeletes = opts.includeFiles ? _deletedFiles(opts.previousManifest || {}, currentManifest, remoteManifest) : [];
    snapshot.delta = true;
    return snapshot;
  }

  async function applySnapshot(snapshot, opts = {}) {
    if (!snapshot || snapshot.version !== 1) throw new Error('unsupported snapshot');
    const stats = {
      projects: { imported: 0, skipped: 0 },
      conversations: { imported: 0, skipped: 0 },
      projectDeletes: { applied: 0, skipped: 0 },
      conversationDeletes: { applied: 0, skipped: 0 },
      files: { imported: 0, skipped: 0 },
      fileDeletes: { applied: 0, skipped: 0 },
      conflicts: { detected: 0 },
    };

    for (const wireProject of Array.isArray(snapshot.projects) ? snapshot.projects : []) {
      if (!wireProject || !wireProject.id) continue;
      const incoming = pathPortability.deserializeFromWire(wireProject, ['rootPath', 'clonePath']);
      const existing = projectManager.getProject?.(incoming.id) || null;
      if (_hasDivergentLocalEdit(incoming, existing, opts.since)) {
        recordConflict({ peerId: opts.peerId, namespace: 'project', objectId: incoming.id, local: existing, remote: incoming });
        stats.conflicts.detected++;
        stats.projects.skipped++;
        continue;
      }
      if (!_shouldApply(incoming, existing)) { stats.projects.skipped++; continue; }
      projectManager._adoptProject?.(incoming);
      stats.projects.imported++;
    }

    for (const conv of Array.isArray(snapshot.conversations) ? snapshot.conversations : []) {
      if (!conv || !conv.id) continue;
      const existing = await conversationStore.get(conv.id);
      if (_hasDivergentLocalEdit(conv, existing, opts.since)) {
        recordConflict({ peerId: opts.peerId, namespace: 'conversation', objectId: conv.id, local: existing, remote: conv });
        stats.conflicts.detected++;
        stats.conversations.skipped++;
        continue;
      }
      if (!_shouldApply(conv, existing)) { stats.conversations.skipped++; continue; }
      await conversationStore.put(conv.id, conv);
      stats.conversations.imported++;
    }

    for (const tombstone of Array.isArray(snapshot.projectDeletes) ? snapshot.projectDeletes : []) {
      if (!tombstone?.id || !tombstone.deleted) continue;
      const existing = projectManager.getProject?.(tombstone.id) || null;
      if (!existing) { stats.projectDeletes.skipped++; continue; }
      const previousTs = _ts(tombstone.previousUpdatedAt);
      if (previousTs && _ts(existing.updatedAt || existing.createdAt) > previousTs) {
        recordConflict({ peerId: opts.peerId, namespace: 'project', objectId: tombstone.id, local: existing, remote: tombstone });
        stats.conflicts.detected++;
        stats.projectDeletes.skipped++;
        continue;
      }
      if (typeof projectManager.deleteProject !== 'function') { stats.projectDeletes.skipped++; continue; }
      if (projectManager.deleteProject(tombstone.id)) stats.projectDeletes.applied++;
      else stats.projectDeletes.skipped++;
    }

    for (const tombstone of Array.isArray(snapshot.conversationDeletes) ? snapshot.conversationDeletes : []) {
      if (!tombstone?.id || !tombstone.deleted) continue;
      const existing = await conversationStore.get(tombstone.id);
      if (!existing) { stats.conversationDeletes.skipped++; continue; }
      const previousTs = _ts(tombstone.previousUpdatedAt);
      if (previousTs && _ts(existing.updatedAt || existing.createdAt) > previousTs) {
        recordConflict({ peerId: opts.peerId, namespace: 'conversation', objectId: tombstone.id, local: existing, remote: tombstone });
        stats.conflicts.detected++;
        stats.conversationDeletes.skipped++;
        continue;
      }
      if (typeof conversationStore.del !== 'function') { stats.conversationDeletes.skipped++; continue; }
      const removed = await conversationStore.del(tombstone.id);
      if (removed) stats.conversationDeletes.applied++;
      else stats.conversationDeletes.skipped++;
    }

    for (const file of Array.isArray(snapshot.files) ? snapshot.files : []) {
      if (!file || !file.projectId || !file.relPath || file.encoding !== 'base64') continue;
      const relPath = _safeRel(file.relPath);
      if (!relPath) { stats.files.skipped++; continue; }
      if (typeof projectManager.writeSourceFileBytes !== 'function') { stats.files.skipped++; continue; }
      let buf;
      try { buf = Buffer.from(String(file.content || ''), 'base64'); } catch (_) { stats.files.skipped++; continue; }
      if (buf.length > MAX_FILE_BYTES) { stats.files.skipped++; continue; }
      try {
        projectManager.writeSourceFileBytes(file.projectId, '__rootpath__', relPath, buf, { overwrite: true });
        stats.files.imported++;
      } catch (_) {
        stats.files.skipped++;
      }
    }

    if (Array.isArray(snapshot.fileDeletes) && snapshot.fileDeletes.length) {
      const localManifest = await buildManifest({ includeFiles: true });
      const localFiles = _manifestMap(localManifest.files);
      for (const tombstone of snapshot.fileDeletes) {
        if (!tombstone || !tombstone.projectId || !tombstone.relPath || !tombstone.deleted) continue;
        const relPath = _safeRel(tombstone.relPath);
        if (!relPath) { stats.fileDeletes.skipped++; continue; }
        const localFile = localFiles.get(_fileManifestId(tombstone));
        if (!localFile) { stats.fileDeletes.skipped++; continue; }
        if (tombstone.previousHash && localFile.hash && tombstone.previousHash !== localFile.hash) {
          recordConflict({ peerId: opts.peerId, namespace: 'project_file', objectId: _fileManifestId(tombstone), local: localFile, remote: tombstone });
          stats.conflicts.detected++;
          stats.fileDeletes.skipped++;
          continue;
        }
        if (typeof projectManager.deleteSourceEntry !== 'function') { stats.fileDeletes.skipped++; continue; }
        try {
          projectManager.deleteSourceEntry(tombstone.projectId, '__rootpath__', relPath);
          stats.fileDeletes.applied++;
        } catch (_) {
          stats.fileDeletes.skipped++;
        }
      }
    }

    return stats;
  }

  app.get('/api/serverless-sync/status', (_req, res) => {
    const state = _readPeerState();
    res.json({
      ok: true,
      relayActive: !!relayUrl,
      relayUrl,
      activeShares: state.shares.filter(_fresh).length,
      peers: state.peers.length,
      bindHost: process.env.FAUNA_BIND_HOST || '127.0.0.1',
      lanIps: _lanIps(),
    });
  });

  app.get('/api/serverless-sync/peers', (_req, res) => {
    const state = _readPeerState();
    res.json({ ok: true, peers: state.peers.map(publicPeer), shares: state.shares.filter((s) => !s.revoked).map((s) => ({ id: s.id, shareUrl: s.shareUrl, createdAt: s.createdAt, uses: s.uses || 0, includeFiles: !!s.includeFiles })), conflicts: state.conflicts.filter((c) => c.status !== 'resolved') });
  });

  app.get('/api/serverless-sync/conflicts', (_req, res) => {
    const state = _readPeerState();
    res.json({ ok: true, conflicts: state.conflicts.filter((c) => c.status !== 'resolved') });
  });

  app.post('/api/serverless-sync/conflicts/:id/resolve', (req, res) => {
    const state = _readPeerState();
    const conflict = state.conflicts.find((c) => c.id === req.params.id);
    if (!conflict) return res.status(404).json({ ok: false, error: 'conflict not found' });
    conflict.status = 'resolved';
    conflict.resolvedAt = new Date().toISOString();
    conflict.resolution = req.body?.resolution || 'dismissed';
    _writePeerState(state);
    res.json({ ok: true });
  });

  app.post('/api/serverless-sync/relay/start', async (_req, res) => {
    try {
      const url = await ensureRelay();
      res.json({ ok: true, relayUrl: url });
    } catch (e) {
      res.status(500).json({ ok: false, error: e.message || 'could not start relay' });
    }
  });

  app.post('/api/serverless-sync/relay/stop', (_req, res) => {
    try { if (relay) relay.close(); } catch (_) {}
    relay = null;
    relayUrl = null;
    res.json({ ok: true });
  });

  app.post('/api/serverless-sync/share', async (req, res) => {
    try {
      const useRelay = req.body?.relay !== false;
      let baseUrl = null;
      let mode = 'lan';
      let warning = null;
      if (useRelay) {
        try {
          baseUrl = await ensureRelay();
          mode = 'relay';
        } catch (e) {
          warning = 'Encrypted relay unavailable; falling back to LAN URL.';
        }
      }
      if (!baseUrl) {
        const primary = _lanIps()[0] || '127.0.0.1';
        baseUrl = `http://${primary}:${port}`;
        if ((process.env.FAUNA_BIND_HOST || '127.0.0.1') === '127.0.0.1' && primary !== '127.0.0.1') {
          warning = 'Fauna is bound to 127.0.0.1, so LAN sync may not be reachable until FAUNA_BIND_HOST=0.0.0.0 is used.';
        }
      }
      const session = _newSession(baseUrl, { includeFiles: req.body?.includeFiles === true, persistent: req.body?.persistent !== false });
      sessions.set(session.token, session);
      saveShare(session);
      const pairingUrl = _pairingUrl({ shareUrl: session.shareUrl, token: session.token, key: session.key, name: _hostname() });
      const qrImage = await QRCode.toDataURL(pairingUrl, { width: 220, margin: 2 });
      res.json({
        ok: true,
        pairingUrl,
        qrImage,
        shareUrl: session.shareUrl,
        expiresAt: session.expiresAt ? new Date(session.expiresAt).toISOString() : null,
        persistent: session.persistent,
        mode,
        relayUrl,
        lanIps: _lanIps(),
        warning,
      });
    } catch (e) {
      res.status(500).json({ ok: false, error: e.message || 'could not create share link' });
    }
  });

  app.post('/api/serverless-sync/shares/:id/revoke', (req, res) => {
    const id = req.params.id;
    const state = _readPeerState();
    const share = state.shares.find((s) => s.id === id || s.token === id);
    if (!share) return res.status(404).json({ ok: false, error: 'share not found' });
    share.revoked = true;
    sessions.delete(share.token);
    _writePeerState(state);
    res.json({ ok: true });
  });

  app.get('/api/serverless-sync/snapshot', async (req, res) => {
    const token = String(req.query.token || req.headers['x-fauna-serverless-token'] || '');
    const session = sessions.get(token);
    if (!_fresh(session)) return res.status(401).json({ error: 'Pairing link expired or invalid' });
    try {
      session.uses++;
      const snapshot = await buildSnapshot(session);
      session.localManifest = await buildManifest({ includeFiles: !!session.includeFiles });
      if (session.persistent) saveShare(session);
      res.json(_encryptSnapshot(snapshot, session.key, session.token));
    } catch (e) {
      res.status(500).json({ error: e.message || 'snapshot failed' });
    }
  });

  app.get('/api/serverless-sync/manifest', async (req, res) => {
    const token = String(req.query.token || req.headers['x-fauna-serverless-token'] || '');
    const session = sessions.get(token);
    if (!_fresh(session)) return res.status(401).json({ error: 'Pairing link expired or invalid' });
    try {
      const manifest = await buildManifest({ includeFiles: session.includeFiles });
      res.json(_encryptSnapshot(manifest, session.key, session.token));
    } catch (e) {
      res.status(500).json({ error: e.message || 'manifest failed' });
    }
  });

  app.post('/api/serverless-sync/delta', async (req, res) => {
    const token = String(req.query.token || req.headers['x-fauna-serverless-token'] || '');
    const session = sessions.get(token);
    if (!_fresh(session)) return res.status(401).json({ ok: false, error: 'Pairing link expired, revoked, or invalid' });
    try {
      const request = _decryptSnapshot(req.body?.envelope || req.body, session.key, session.token);
      const includeFiles = !!(request.includeFiles && session.includeFiles);
      const snapshot = await buildDelta(request.manifest || {}, { includeFiles, previousManifest: session.localManifest || null });
      const manifest = await buildManifest({ includeFiles });
      session.uses++;
      session.localManifest = manifest;
      session.peerManifest = request.manifest || null;
      if (session.persistent) saveShare(session);
      res.json(_encryptSnapshot({ version: 1, delta: true, snapshot, manifest }, session.key, session.token));
    } catch (e) {
      res.status(500).json({ ok: false, error: e.message || 'delta failed' });
    }
  });

  app.post('/api/serverless-sync/push', async (req, res) => {
    const token = String(req.query.token || req.headers['x-fauna-serverless-token'] || '');
    const session = sessions.get(token);
    if (!_fresh(session)) return res.status(401).json({ ok: false, error: 'Pairing link expired, revoked, or invalid' });
    try {
      const snapshot = _decryptSnapshot(req.body?.envelope || req.body, session.key, session.token);
      const stats = await applySnapshot(snapshot);
      session.uses++;
      if (session.persistent) saveShare(session);
      res.json({ ok: true, importedAt: new Date().toISOString(), source: snapshot.device || null, stats });
    } catch (e) {
      res.status(500).json({ ok: false, error: e.message || 'push failed' });
    }
  });

  app.post('/api/serverless-sync/import', async (req, res) => {
    try {
      const pair = _parsePairInput(req.body || {});
      if (!pair.url || !pair.token || !pair.key) {
        return res.status(400).json({ ok: false, error: 'pairUrl, or url/token/key, is required' });
      }
      const url = new URL(pair.url);
      if (url.protocol !== 'http:' && url.protocol !== 'https:') {
        return res.status(400).json({ ok: false, error: 'snapshot URL must be http or https' });
      }
      const envelope = await _fetchJson(url.toString(), pair.token);
      const snapshot = _decryptSnapshot(envelope, pair.key, pair.token);
      const stats = await applySnapshot(snapshot);
      const localManifest = await buildManifest({ includeFiles: Array.isArray(snapshot.files) && snapshot.files.length > 0 });
      const peer = savePeer(pair, { source: snapshot.device || null, stats, localManifest });
      res.json({ ok: true, importedAt: new Date().toISOString(), source: snapshot.device || null, stats, peer: publicPeer(peer) });
    } catch (e) {
      res.status(500).json({ ok: false, error: e.message || 'import failed' });
    }
  });

  app.post('/api/serverless-sync/peers/:id/sync', async (req, res) => {
    try {
      const state = _readPeerState();
      const peer = state.peers.find((p) => p.id === req.params.id);
      if (!peer) return res.status(404).json({ ok: false, error: 'peer not found' });
      const includeFiles = req.body?.includeFiles === true;
      const localManifest = await buildManifest({ includeFiles });
      const deltaRequest = _encryptSnapshot({ version: 1, manifest: localManifest, includeFiles }, peer.key, peer.token);
      const deltaEnvelope = await _postJson(_deltaUrlFromSnapshotUrl(peer.url), peer.token, { envelope: deltaRequest });
      const deltaResponse = _decryptSnapshot(deltaEnvelope, peer.key, peer.token);
      const snapshot = deltaResponse.snapshot;
      const previousSyncAt = peer.lastSyncAt || peer.createdAt || null;
      const stats = await applySnapshot(snapshot, { peerId: peer.id, since: previousSyncAt });
      let pushed = null;
      if (req.body?.push !== false) {
        const localSnapshot = await buildDelta(deltaResponse.manifest || {}, { includeFiles, previousManifest: peer.localManifest || null });
        const pushEnvelope = _encryptSnapshot(localSnapshot, peer.key, peer.token);
        pushed = await _postJson(_pushUrlFromSnapshotUrl(peer.url), peer.token, { envelope: pushEnvelope });
      }
      const latestState = _readPeerState();
      const latestPeer = latestState.peers.find((p) => p.id === peer.id) || peer;
      latestPeer.name = latestPeer.name || snapshot.device?.name || 'Fauna device';
      latestPeer.lastSyncAt = new Date().toISOString();
      latestPeer.lastStats = { pulled: stats, pushed: pushed?.stats || null };
      latestPeer.localManifest = await buildManifest({ includeFiles });
      latestPeer.remoteManifest = deltaResponse.manifest || null;
      if (!latestState.peers.find((p) => p.id === latestPeer.id)) latestState.peers.push(latestPeer);
      _writePeerState(latestState);
      res.json({ ok: true, peer: publicPeer(latestPeer), source: snapshot.device || null, stats, pushed: pushed?.stats || null });
    } catch (e) {
      res.status(500).json({ ok: false, error: e.message || 'sync failed' });
    }
  });

  app.delete('/api/serverless-sync/peers/:id', (req, res) => {
    const state = _readPeerState();
    const next = state.peers.filter((p) => p.id !== req.params.id);
    if (next.length === state.peers.length) return res.status(404).json({ ok: false, error: 'peer not found' });
    state.peers = next;
    _writePeerState(state);
    res.json({ ok: true });
  });
}