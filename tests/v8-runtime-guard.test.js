import { describe, expect, it } from 'vitest';
import {
  buildV8SafetyRelaunchArgs,
  V8_SAFETY_FLAGS,
  V8_SAFETY_MARKER,
  V8_SAFETY_MODE,
} from '../lib/v8-runtime-guard.js';

describe('V8 runtime guard', () => {
  it('preserves app arguments and installs the safe compiler flags', () => {
    const args = buildV8SafetyRelaunchArgs([
      '/Applications/Fauna.app/Contents/MacOS/Fauna',
      '/tmp/task.md',
      '--js-flags=--trace-gc',
    ]);

    expect(args).toEqual([
      '/tmp/task.md',
      `--js-flags=--trace-gc ${V8_SAFETY_FLAGS}`,
      V8_SAFETY_MARKER,
    ]);
    expect(V8_SAFETY_MODE).toBe('jitless');
    expect(V8_SAFETY_FLAGS).toContain('--jitless');
    expect(V8_SAFETY_FLAGS).toContain('--disable-optimizing-compilers');
    expect(V8_SAFETY_FLAGS).toContain('--no-concurrent-recompilation');
  });

  it('does not relaunch a process already in safe mode', () => {
    expect(buildV8SafetyRelaunchArgs(['/Applications/Fauna.app/Contents/MacOS/Fauna', V8_SAFETY_MARKER])).toBeNull();
  });
});