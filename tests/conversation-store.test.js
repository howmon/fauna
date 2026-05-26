// Tests for the conversation store: legacy + split backends, async writes,
// per-id mutex, payload caps, dual-write behaviour.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import fsp from 'fs/promises';
import os from 'os';
import path from 'path';

import {
  createConversationStore,
  PayloadTooLargeError,
  MAX_CONVERSATION_BYTES,
  MAX_MESSAGE_BYTES,
  migrateLegacyToSplit,
} from '../server/lib/conversation-store.js';

let tmpDir;

beforeEach(async () => {
  tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'fauna-conv-store-'));
});

afterEach(async () => {
  try { await fsp.rm(tmpDir, { recursive: true, force: true }); } catch (_) {}
});

function sampleConv(id, overrides = {}) {
  return {
    id,
    title: `Conv ${id}`,
    model: 'gpt-4.1',
    projectId: null,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    messages: [{ role: 'user', content: 'hello ' + id }],
    ...overrides,
  };
}

describe('conversation-store: legacy backend', () => {
  function makeStore() {
    return createConversationStore({ configDir: tmpDir, mode: 'single' });
  }

  it('put then get round-trips', async () => {
    const store = makeStore();
    await store.put('a', sampleConv('a'));
    const got = await store.get('a');
    expect(got).toBeTruthy();
    expect(got.id).toBe('a');
    expect(got.title).toBe('Conv a');
  });

  it('list returns slim metadata, full=true returns bodies', async () => {
    const store = makeStore();
    await store.put('a', sampleConv('a'));
    await store.put('b', sampleConv('b'));
    const slim = await store.list();
    expect(slim).toHaveLength(2);
    expect(slim[0]).toHaveProperty('messageCount');
    expect(slim[0].messages).toBeUndefined();

    const full = await store.list({ full: true });
    expect(full).toHaveLength(2);
    expect(full[0].messages).toBeDefined();
  });

  it('delete removes the conv', async () => {
    const store = makeStore();
    await store.put('a', sampleConv('a'));
    const deleted = await store.del('a');
    expect(deleted).toBe(1);
    expect(await store.get('a')).toBeNull();
  });

  it('writes to conversations.json in configDir', async () => {
    const store = makeStore();
    await store.put('a', sampleConv('a'));
    const file = path.join(tmpDir, 'conversations.json');
    expect(fs.existsSync(file)).toBe(true);
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    expect(parsed).toHaveLength(1);
    expect(parsed[0].id).toBe('a');
  });

  it('rejects oversize message with PayloadTooLargeError', async () => {
    const store = makeStore();
    const huge = 'x'.repeat(MAX_MESSAGE_BYTES + 1);
    await expect(
      store.put('a', sampleConv('a', { messages: [{ role: 'user', content: huge }] }))
    ).rejects.toThrow(PayloadTooLargeError);
  });

  it('serializes concurrent puts to the same id', async () => {
    const store = makeStore();
    // Fire 10 parallel puts; final state must reflect every increment.
    await Promise.all(
      Array.from({ length: 10 }, (_, i) =>
        store.put('a', sampleConv('a', { messages: [{ role: 'user', content: 'msg-' + i }] }))
      )
    );
    const file = path.join(tmpDir, 'conversations.json');
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    expect(parsed).toHaveLength(1);
    // Last writer wins — but importantly, the file is not corrupt and
    // there's only ever exactly one entry for id 'a'.
    expect(parsed[0].id).toBe('a');
  });
});

describe('conversation-store: split backend', () => {
  function makeStore(mode = 'split-only') {
    return createConversationStore({ configDir: tmpDir, mode });
  }

  it('writes per-conversation files plus an index', async () => {
    const store = makeStore();
    await store.put('a', sampleConv('a'));
    await store.put('b', sampleConv('b'));

    const dir = path.join(tmpDir, 'conversations');
    expect(fs.existsSync(path.join(dir, 'a.json'))).toBe(true);
    expect(fs.existsSync(path.join(dir, 'b.json'))).toBe(true);
    expect(fs.existsSync(path.join(dir, 'index.json'))).toBe(true);

    const idx = JSON.parse(fs.readFileSync(path.join(dir, 'index.json'), 'utf8'));
    expect(idx.schema).toBe(1);
    expect(idx.conversations).toHaveLength(2);
    expect(idx.conversations[0].messageCount).toBe(1);
  });

  it('list returns slim index rows, full=true loads bodies', async () => {
    const store = makeStore();
    await store.put('a', sampleConv('a'));
    const slim = await store.list();
    expect(slim[0].messages).toBeUndefined();
    const full = await store.list({ full: true });
    expect(full[0].messages).toBeDefined();
  });

  it('delete removes body file and index row', async () => {
    const store = makeStore();
    await store.put('a', sampleConv('a'));
    await store.del('a');
    expect(fs.existsSync(path.join(tmpDir, 'conversations', 'a.json'))).toBe(false);
    const idx = JSON.parse(fs.readFileSync(path.join(tmpDir, 'conversations', 'index.json'), 'utf8'));
    expect(idx.conversations).toHaveLength(0);
  });

  it('rejects path-traversal ids', async () => {
    const store = makeStore();
    await expect(store.put('../etc/passwd', sampleConv('x'))).rejects.toThrow(/Invalid conversation id/);
  });

  it('dual-write mode also writes the legacy file', async () => {
    const store = makeStore('split');
    await store.put('a', sampleConv('a'));
    // Settle the fire-and-forget legacy write.
    await new Promise(r => setTimeout(r, 50));
    const legacy = path.join(tmpDir, 'conversations.json');
    expect(fs.existsSync(legacy)).toBe(true);
    const parsed = JSON.parse(fs.readFileSync(legacy, 'utf8'));
    expect(parsed.find(c => c.id === 'a')).toBeTruthy();
  });

  it('split-only mode does NOT write the legacy file', async () => {
    const store = makeStore('split-only');
    await store.put('a', sampleConv('a'));
    await new Promise(r => setTimeout(r, 50));
    const legacy = path.join(tmpDir, 'conversations.json');
    expect(fs.existsSync(legacy)).toBe(false);
  });

  it('rejects oversize conversation body', async () => {
    const store = makeStore();
    // Build a payload above the conservative byte cap.
    const big = 'a'.repeat(MAX_MESSAGE_BYTES);
    const conv = sampleConv('a', {
      messages: Array.from({ length: 4 }, () => ({ role: 'user', content: big })),
    });
    // Approx bytes = stringify length × 2. 4 × MAX_MESSAGE_BYTES > MAX_CONVERSATION_BYTES.
    await expect(store.put('a', conv)).rejects.toThrow(PayloadTooLargeError);
  });
});

describe('conversation-store: backend selection', () => {
  it('defaults to legacy when no mode and no env', async () => {
    const prev = process.env.FAUNA_CONV_STORAGE;
    delete process.env.FAUNA_CONV_STORAGE;
    try {
      const store = createConversationStore({ configDir: tmpDir });
      expect(store.name).toBe('legacy');
    } finally {
      if (prev) process.env.FAUNA_CONV_STORAGE = prev;
    }
  });

  it('respects FAUNA_CONV_STORAGE env', async () => {
    const prev = process.env.FAUNA_CONV_STORAGE;
    process.env.FAUNA_CONV_STORAGE = 'split-only';
    try {
      const store = createConversationStore({ configDir: tmpDir });
      expect(store.name).toBe('split');
    } finally {
      if (prev) process.env.FAUNA_CONV_STORAGE = prev;
      else delete process.env.FAUNA_CONV_STORAGE;
    }
  });
});

describe('payload cap constants', () => {
  it('are reasonable and ordered', () => {
    expect(MAX_MESSAGE_BYTES).toBeLessThan(MAX_CONVERSATION_BYTES);
  });
});

describe('migrateLegacyToSplit', () => {
  async function seedLegacy(convs) {
    await fsp.writeFile(path.join(tmpDir, 'conversations.json'), JSON.stringify(convs));
  }

  it('migrates each conv to its own body file and builds an index', async () => {
    await seedLegacy([sampleConv('a'), sampleConv('b')]);
    const result = await migrateLegacyToSplit({ configDir: tmpDir });
    expect(result.ok).toBe(true);
    expect(result.migrated).toBe(2);
    expect(fs.existsSync(path.join(tmpDir, 'conversations', 'a.json'))).toBe(true);
    expect(fs.existsSync(path.join(tmpDir, 'conversations', 'b.json'))).toBe(true);
    const idx = JSON.parse(fs.readFileSync(path.join(tmpDir, 'conversations', 'index.json'), 'utf8'));
    expect(idx.conversations).toHaveLength(2);
  });

  it('leaves the original legacy file untouched and writes a backup', async () => {
    await seedLegacy([sampleConv('a')]);
    const before = fs.readFileSync(path.join(tmpDir, 'conversations.json'), 'utf8');
    const result = await migrateLegacyToSplit({ configDir: tmpDir });
    expect(result.backupPath).toBeTruthy();
    expect(fs.existsSync(result.backupPath)).toBe(true);
    const after = fs.readFileSync(path.join(tmpDir, 'conversations.json'), 'utf8');
    expect(after).toBe(before);
  });

  it('is idempotent — second run skips when split layout exists', async () => {
    await seedLegacy([sampleConv('a')]);
    await migrateLegacyToSplit({ configDir: tmpDir });
    const second = await migrateLegacyToSplit({ configDir: tmpDir });
    expect(second.skipped).toBe(true);
  });

  it('force=true re-runs even when split layout exists', async () => {
    await seedLegacy([sampleConv('a')]);
    await migrateLegacyToSplit({ configDir: tmpDir });
    const second = await migrateLegacyToSplit({ configDir: tmpDir, force: true });
    expect(second.skipped).toBeFalsy();
    expect(second.migrated).toBe(1);
  });

  it('skips entries with invalid ids and reports them', async () => {
    await seedLegacy([sampleConv('a'), { id: '../bad', title: 'evil' }]);
    const result = await migrateLegacyToSplit({ configDir: tmpDir });
    expect(result.migrated).toBe(1);
    expect(result.errors.length).toBeGreaterThan(0);
  });

  it('handles missing legacy file by creating an empty index', async () => {
    const result = await migrateLegacyToSplit({ configDir: tmpDir });
    expect(result.ok).toBe(true);
    expect(result.migrated).toBe(0);
    expect(fs.existsSync(path.join(tmpDir, 'conversations', 'index.json'))).toBe(true);
  });

  it('migrated data is readable via a split store afterward', async () => {
    await seedLegacy([sampleConv('a', { title: 'Migrated A' })]);
    await migrateLegacyToSplit({ configDir: tmpDir });
    const store = createConversationStore({ configDir: tmpDir, mode: 'split-only' });
    const got = await store.get('a');
    expect(got.title).toBe('Migrated A');
  });
});
