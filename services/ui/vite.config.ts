import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// BITMEX_REST_PROXY_URL is a server-side var (no VITE_ prefix) read at Vite
// startup time. The browser never sees it — Vite forwards /api/v1/* to this
// target, keeping the browser on the same origin and avoiding CORS entirely.
const REST_TARGET = process.env.BITMEX_REST_PROXY_URL ?? 'http://localhost:3101';

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
    },
  },
});
