import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

/**
 * Vite dev-server proxies — keep the browser same-origin, no CORS dance.
 *
 *   /api/v1     →  UI_REST_PROXY     (default http://proxy)
 *   /replay     →  UI_REPLAY_HOST    (REST, rewritten to upstream root)
 *   /replay-ws  →  UI_REPLAY_HOST    (WS, ws: true, rewritten to upstream root)
 *
 * `__REPLAY_ENABLED__` is a build-time boolean exposed to the browser bundle —
 * the env dropdown uses it to gate the Replay option.
 */
const REST_PROXY     = process.env.UI_REST_PROXY  ?? 'http://proxy';
const REPLAY_HOST    = process.env.UI_REPLAY_HOST ?? '';
const REPLAY_ENABLED = Boolean(REPLAY_HOST);

export default defineConfig({
  plugins: [react()],

  define: {
    __REPLAY_ENABLED__: JSON.stringify(REPLAY_ENABLED),
  },

  server: {
    port: 3000,
    host: true,
    proxy: {
      '/api/v1': {
        target:       REST_PROXY,
        changeOrigin: true,
      },
      ...(REPLAY_ENABLED ? {
        '/replay': {
          target:       REPLAY_HOST,
          changeOrigin: true,
          rewrite:      (path: string) => path.replace(/^\/replay/, ''),
        },
        '/replay-ws': {
          target:       REPLAY_HOST,
          changeOrigin: true,
          ws:           true,
          rewrite:      (path: string) => path.replace(/^\/replay-ws/, ''),
        },
      } : {}),
    },
  },
});
