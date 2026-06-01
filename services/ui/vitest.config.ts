import { defineConfig, mergeConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import baseConfig from '../../vitest.config';

export default mergeConfig(
  baseConfig,
  defineConfig({
    plugins: [react()],
    test: {
      environment: 'jsdom',
      include:     ['tests/**/*.test.ts', 'tests/**/*.test.tsx'],
      setupFiles:  ['./tests/setup.ts'],
      coverage: {
        include: ['src/**/*.ts', 'src/**/*.tsx'],
        exclude: ['src/main.tsx', 'src/**/*.d.ts'],
      },
    },
  })
);
