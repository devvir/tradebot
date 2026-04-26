import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Server-side vars (no VITE_ prefix) — read at Vite startup, never sent to browser.
// Vite proxies browser requests to these targets, keeping the browser on the same
// origin and avoiding CORS entirely.
const REST_TARGET   = process.env.BITMEX_REST_PROXY_URL ?? 'http://localhost:3101';
const DIGGER_TARGET = process.env.DIGGER_PROXY_URL      ?? '';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 3000,
    host: true,
    proxy: {
      '/api/v1': {
        target:      REST_TARGET,
        changeOrigin: true,
      },
      ...(DIGGER_TARGET ? {
        '/digger': {
          target:      DIGGER_TARGET,
          changeOrigin: true,
          rewrite:     (path: string) => path.replace(/^\/digger/, ''),
        },
      } : {}),
    },
  },
});
