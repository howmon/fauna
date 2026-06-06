import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    include: ['tests/**/*.test.js'],
    exclude: ['tests/instruction-discovery.test.js'], // legacy node:test format
    // Never load the bundled local LLM during tests — keep them deterministic
    // and fast. Production code uses isModelCached()/tryMini() which respect
    // this flag and fall back to the remote (Copilot) path.
    env: {
      FAUNA_DISABLE_LOCAL_MINI: '1',
    },
    coverage: {
      provider: 'v8',
      include: ['memory-store.js', 'workflow-manager.js', 'heartbeat.js', 'self-tools.js', 'permission-guard.js'],
    },
  },
});
