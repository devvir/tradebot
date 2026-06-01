/**
 * Per-environment wiring table. WS URLs for live/testnet are public BitMEX
 * endpoints (CORS-friendly, the browser can open them directly). REST goes
 * through the Vite dev-server proxy (`/api/v1` → `UI_REST_PROXY`, `/replay`
 * → `UI_REPLAY_HOST`) — same-origin to the browser, no CORS dance.
 *
 * The replay WS comes back through the same dev-server proxy (`ws: true`
 * forwarder) so it stays same-origin too; the actual scheme follows the page
 * (`http` → `ws`, `https` → `wss`).
 */

import type { Env, EnvConfig } from '../types';

const BITMEX_WS_LIVE    = 'wss://ws.bitmex.com/realtime';
const BITMEX_WS_TESTNET = 'wss://ws.testnet.bitmex.com/realtime';

function replayWsUrl(): string {
  const proto = window.location.protocol === 'https:' ? 'wss' : 'ws';

  return `${proto}://${window.location.host}/replay-ws/realtime`;
}

export const ENV_CONFIGS: Record<Env, EnvConfig> = {
  live: {
    restPath: '/api/v1',
    wsUrl:    BITMEX_WS_LIVE,
    headers:  {},
  },
  testnet: {
    restPath: '/api/v1',
    wsUrl:    BITMEX_WS_TESTNET,
    headers:  { 'x-testnet': 'true' },
  },
  replay: {
    restPath: '/replay',
    /** Lazy so SSR / non-browser contexts don't blow up loading this module. */
    get wsUrl(): string { return replayWsUrl(); },
    headers:  {},
  },
};
