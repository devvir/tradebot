/**
 * Shared Vitest configuration for all packages and services
 * Each project extends this with custom overrides
 */
import { resolve } from 'node:path';
import { defineConfig } from 'vitest/config';

/** A workspace package's source file, by path from the repository root. */
const source = (path: string) => resolve(__dirname, path);

export default defineConfig({
  /**
   * The shared packages resolve to their source, not their built `dist`, so every
   * suite tests the code as it is in the tree, built or not. The patterns are
   * anchored so `@tradebot/utils/testing` gets its own entry.
   */
  resolve: {
    alias: [
      { find: /^@tradebot\/lenses$/, replacement: source('shared/lenses/src/index.ts') },
      { find: /^@tradebot\/utils$/, replacement: source('shared/utils/src/index.ts') },
      { find: /^@tradebot\/utils\/testing$/, replacement: source('shared/utils/src/testing/index.ts') },
    ],
  },
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts', 'tests/**/*.spec.ts'],
    globals: true,
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json', 'html'],
      include: ['src/**/*.ts'],
      exclude: ['src/index.ts', 'src/**/*.d.ts', 'node_modules/'],
      thresholds: {
        branches: 60,
        functions: 60,
        lines: 60,
        statements: 60,
      },
    },
  },
});
