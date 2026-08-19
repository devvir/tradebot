import { defineConfig, mergeConfig } from 'vitest/config';
import baseConfig from '../../vitest.config';

/**
 * **Bounded on purpose.** These tests build real SQLite catalogs, and the seeded
 * ones apply thirty-four thousand series before a single assertion runs. Left to
 * its default vitest takes a worker per core, and eight of those doing that at
 * once starves the machine they are running on — including the machine somebody
 * is trying to work on while they run.
 *
 * Four leaves headroom without making the suite noticeably slower: the work is
 * disk-bound long before it is CPU-bound.
 */
export default mergeConfig(
  baseConfig,
  defineConfig({
    test: {
      setupFiles: ['./tests/setup.ts'],
      maxWorkers: 4,
      minWorkers: 1,
    },
  })
);
