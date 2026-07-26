import { defineConfig, mergeConfig } from 'vitest/config';
import baseConfig from '../../vitest.config';

export default mergeConfig(
  baseConfig,
  defineConfig({
    test: {
      globalSetup: ['./tests/global-setup.ts'],
      setupFiles:  ['./tests/setup.ts'],
      hookTimeout: 30000,
    },
  })
);
