/**
 * Per-environment wiring table. Live and testnet open the public BitMEX WS
 * endpoints directly. Every other URL is a same-origin path that the Vite dev
 * server proxies: REST at `/api/v1` for live/testnet, and `/replay`,
 * `/replay-ws` and `/replay-control` for replay (targets in vite.config.ts).
 * The replay WS URL follows the page's scheme (`http` → `ws`, `https` → `wss`).
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
    restPath:    '/replay',
    /** Lazy so SSR / non-browser contexts don't blow up loading this module. */
    get wsUrl(): string { return replayWsUrl(); },
    headers:     {},
    controlPath: '/replay-control',
  },
};
