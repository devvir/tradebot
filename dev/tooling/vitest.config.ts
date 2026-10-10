import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    testTimeout: 10000,

    // Two kinds of code that is kept and not run: the cold commands that have not moved onto
    // partitions yet (src/tools/cold/legacy), and the tools kept for reference (.deprecated).
    exclude: ['**/node_modules/**', '**/dist/**', 'tests/tools/cold/legacy/**', '.deprecated/**'],
  },
});
