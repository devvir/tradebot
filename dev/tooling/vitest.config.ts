import { defineConfig, mergeConfig } from 'vitest/config';
import baseConfig from '../../vitest.config';

export default mergeConfig(
  baseConfig,
  defineConfig({
    test: {
      testTimeout: 10000,

      // The tools kept for reference (.deprecated) are not run.
      exclude: ['**/node_modules/**', '**/dist/**', '.deprecated/**'],
    },
  })
);
