// Regression test for fauna_write_offloaded.
//
// Origin: a 30+ min Figma CSV export session where the model burned tokens
// re-running figma_execute because the offload marker read as flavor text
// and there was no way to land the bytes on disk without round-tripping
// them through context. fauna_write_offloaded fixes both — this test pins
// the contract so a future refactor can't silently break the cheap path.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { executeSelfTool } from '../self-tools.js';
import { stashOutput } from '../server/lib/tool-output-cache.js';

let tmpDir;

beforeEach(() => {
  // _resolveFaunaWritePath only permits writes under $HOME or /tmp. On macOS
  // os.tmpdir() returns /var/folders/... (outside both), so anchor under HOME.
  const home = process.env.HOME || os.homedir();
  tmpDir = fs.mkdtempSync(path.join(home, '.fauna-write-offloaded-test-'));
});

afterEach(() => {
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (_) {}
});

describe('fauna_write_offloaded', () => {
  it('writes the FULL offloaded original to disk', async () => {
    const payload = 'row,value\n' + Array.from({ length: 500 }, (_, i) => `r${i},${i}`).join('\n');
    const hash = stashOutput(payload);
    expect(hash).toBeTruthy();

    const outFile = path.join(tmpDir, 'out.csv');
    const raw = await executeSelfTool('fauna_write_offloaded', { hash, path: outFile });
    const res = JSON.parse(raw);

    expect(res.ok).toBe(true);
    expect(res.result.path).toBe(outFile);
    expect(res.result.bytes).toBe(Buffer.byteLength(payload));
    expect(res.source.hash).toBe(hash);
    expect(res.source.originalChars).toBe(payload.length);

    const onDisk = fs.readFileSync(outFile, 'utf8');
    expect(onDisk).toBe(payload);
  });

  it('appends when append:true and concatenates batched offloads', async () => {
    const a = 'header\n' + 'a-row\n'.repeat(100);
    const b = 'b-row\n'.repeat(100);
    const ha = stashOutput(a);
    const hb = stashOutput(b);
    const outFile = path.join(tmpDir, 'batched.csv');

    const r1 = JSON.parse(await executeSelfTool('fauna_write_offloaded', { hash: ha, path: outFile }));
    expect(r1.ok).toBe(true);
    const r2 = JSON.parse(await executeSelfTool('fauna_write_offloaded', { hash: hb, path: outFile, append: true }));
    expect(r2.ok).toBe(true);

    const onDisk = fs.readFileSync(outFile, 'utf8');
    expect(onDisk).toBe(a + b);
  });

  it('returns a structured error when the hash is unknown', async () => {
    const raw = await executeSelfTool('fauna_write_offloaded', {
      hash: 'deadbeefcafe',
      path: path.join(tmpDir, 'never.txt'),
    });
    const res = JSON.parse(raw);
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/No offloaded output found/i);
    expect(fs.existsSync(path.join(tmpDir, 'never.txt'))).toBe(false);
  });

  it('requires both hash and path', async () => {
    const r1 = JSON.parse(await executeSelfTool('fauna_write_offloaded', { path: '/tmp/x' }));
    expect(r1.ok).toBe(false);
    const r2 = JSON.parse(await executeSelfTool('fauna_write_offloaded', { hash: 'abc123abc123' }));
    expect(r2.ok).toBe(false);
  });

  it('identical content produces a stable hash (offload dedupe)', () => {
    const payload = 'same payload bytes\n'.repeat(50);
    const h1 = stashOutput(payload);
    const h2 = stashOutput(payload);
    expect(h1).toBe(h2);
  });
});
