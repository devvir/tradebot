import { defineConfig, mergeConfig } from 'vitest/config';
import baseConfig from '../../vitest.config';

/**
 * Its own file because `vite.config.ts` roots the build at `web/`, which would
 * put `tests/` out of reach.
 */
export default mergeConfig(baseConfig, defineConfig({ root: __dirname }));
