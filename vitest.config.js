import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    include: ['tests/**/*.test.js'],
    exclude: ['tests/instruction-discovery.test.js'], // legacy node:test format
    coverage: {
      provider: 'v8',
      include: ['memory-store.js', 'workflow-manager.js', 'heartbeat.js', 'self-tools.js', 'permission-guard.js'],
    },
  },
});
