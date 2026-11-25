import { defineConfig, mergeConfig } from 'vitest/config';
import baseConfig from '../../vitest.config';

const INTEGRATION_TESTS = 'tests/integration.test.ts';

/**
 * Two projects: 'unit' runs every test file but the integration one, without a broker;
 * 'integration' runs tests/integration.test.ts against a RabbitMQ that its globalSetup starts.
 * Run one with `vitest run --project unit`.
 */
export default mergeConfig(
  baseConfig,
  defineConfig({
    test: {
      setupFiles: ['./tests/setup.ts'],
      onConsoleLog: () => false,
      projects: [
        {
          extends: true,
          test: { name: 'unit', exclude: [INTEGRATION_TESTS] },
        },
        {
          extends: true,
          test: {
            name:        'integration',
            exclude:     ['tests/!(integration).test.ts'],
            globalSetup: ['./tests/global-setup.ts'],
            hookTimeout: 30000,
          },
        },
      ],
    },
  })
);
