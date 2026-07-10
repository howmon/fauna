import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, describe, expect, it, vi } from 'vitest';

describe('permission state', () => {
  let tempDir = null;

  afterEach(() => {
    delete process.env.FAUNA_PERMISSION_STATE_FILE;
    if (tempDir) fs.rmSync(tempDir, { recursive: true, force: true });
    tempDir = null;
    vi.resetModules();
  });

  async function loadWithTempState() {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fauna-perms-'));
    process.env.FAUNA_PERMISSION_STATE_FILE = path.join(tempDir, 'permission-state.json');
    vi.resetModules();
    return import('../server/routes/permissions.js');
  }

  it('reports previously granted macOS permissions separately after an update resets the live check', async () => {
    const { computePermissions } = await loadWithTempState();
    const grantedPrefs = {
      getMediaAccessStatus: () => 'granted',
      isTrustedAccessibilityClient: () => true,
    };
    const deniedPrefs = {
      getMediaAccessStatus: () => 'denied',
      isTrustedAccessibilityClient: () => false,
    };

    const initial = computePermissions({
      isWin: false,
      getGhToken: () => 'token',
      systemPreferences: grantedPrefs,
    });
    expect(initial.screenRecording).toBe('granted');
    expect(initial.accessibility).toBe('granted');

    const afterUpdate = computePermissions({
      isWin: false,
      getGhToken: () => 'token',
      systemPreferences: deniedPrefs,
    });
    expect(afterUpdate.screenRecording).toBe('previously-granted');
    expect(afterUpdate.accessibility).toBe('previously-granted');
  });
});