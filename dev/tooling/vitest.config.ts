import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    testTimeout: 10000,

    // The cold commands that have not moved onto partitions yet — see src/tools/cold/legacy.
    exclude: ['**/node_modules/**', '**/dist/**', 'tests/tools/cold/legacy/**'],
  },
});
