import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

/**
 * Vite dev-server proxies — keep the browser same-origin, no CORS dance.
 *
 *   /api/v1          →  UI_REST_PROXY (default http://proxy)  — live/testnet REST
 *   /replay          →  digger REST    (rewritten /replay → /api/v1)
 *   /replay-ws       →  digger WS      (ws: true, rewritten to upstream root)
 *   /replay-control  →  digger control (rewritten to upstream root)
 *
 * Digger exposes three host-mapped ports. Set `UI_DIGGER_HOST` (e.g. `localhost`)
 * to enable the Replay env; ports default to the replay module's mappings.
 * `__REPLAY_ENABLED__` is a build-time boolean — the env dropdown gates Replay on it.
 */
const REST_PROXY = process.env.UI_REST_PROXY ?? 'http://proxy';

const DIGGER_HOST         = process.env.UI_DIGGER_HOST         ?? '';
const DIGGER_WS_PORT      = process.env.UI_DIGGER_WS_PORT      ?? '8180';
const DIGGER_REST_PORT    = process.env.UI_DIGGER_REST_PORT    ?? '3101';
const DIGGER_CONTROL_PORT = process.env.UI_DIGGER_CONTROL_PORT ?? '8280';

const REPLAY_ENABLED = Boolean(DIGGER_HOST);
const digger = (port: string): string => `http://${DIGGER_HOST}:${port}`;

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

      /** Replay rules — the specific prefixes must precede the generic `/replay`. */
      ...(REPLAY_ENABLED ? {
        '/replay-ws': {
          target:       digger(DIGGER_WS_PORT),
          changeOrigin: true,
          ws:           true,
          rewrite:      (path: string) => path.replace(/^\/replay-ws/, ''),
        },
        '/replay-control': {
          target:       digger(DIGGER_CONTROL_PORT),
          changeOrigin: true,
          rewrite:      (path: string) => path.replace(/^\/replay-control/, ''),
        },
        '/replay': {
          target:       digger(DIGGER_REST_PORT),
          changeOrigin: true,
          rewrite:      (path: string) => path.replace(/^\/replay/, '/api/v1'),
        },
      } : {}),
    },
  },
});
