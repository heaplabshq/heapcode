import { defineConfig } from 'vitest/config';

// These tests drive a real Chrome, which starts, acts and closes far slower
// when the whole repo's suite is running beside it.
export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    environment: 'node',
    testTimeout: 30_000,
    hookTimeout: 60_000,
  },
});
