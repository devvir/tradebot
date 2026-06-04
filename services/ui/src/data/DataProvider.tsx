/**
 * Builds the data clients for the currently-selected environment and exposes
 * them via context. Use `key={env}` on this provider from the caller so that
 * an env switch unmounts the whole subtree — widgets cleanly unsubscribe from
 * the old WS, and a fresh client wires up to the new env.
 */

import { createContext, useContext, useEffect, useMemo, type ReactNode } from 'react';
import { BitmexClient } from './BitmexClient';
import { DiggerClient } from './DiggerClient';
import { useEnv } from './EnvProvider';
import { ENV_CONFIGS } from './envs';

declare const __REPLAY_ENABLED__: boolean;

const BitmexContext = createContext<BitmexClient | null>(null);
const DiggerContext = createContext<DiggerClient | null>(null);

export function DataProvider({ children }: { children: ReactNode }) {
  const { env } = useEnv();

  const bitmex = useMemo(() => {
    const cfg = ENV_CONFIGS[env];

    return new BitmexClient(cfg.restPath, cfg.wsUrl, cfg.headers);
  }, [env]);

  const digger = useMemo(
    () => __REPLAY_ENABLED__ && env === 'replay' ? new DiggerClient('/replay-control') : null,
    [env],
  );

  /** Close the WS when this provider unmounts (e.g. env-switch via `key`).
   *  `WsClient.destroy()` is idempotent, so StrictMode's double-mount won't
   *  poison the instance. */
  useEffect(() => () => bitmex.destroy(), [bitmex]);

  return (
    <BitmexContext.Provider value={bitmex}>
      <DiggerContext.Provider value={digger}>
        {children}
      </DiggerContext.Provider>
    </BitmexContext.Provider>
  );
}

export function useBitmex(): BitmexClient {
  const client = useContext(BitmexContext);

  if (! client) {
    throw new Error('useBitmex must be used within DataProvider');
  }

  return client;
}

/** Returns null when digger is not configured (e.g. live or testnet env). */
export function useDigger(): DiggerClient | null {
  return useContext(DiggerContext);
}

// ── Test-only exports ─────────────────────────────────────────────────────────

export const _test_BitmexContext = BitmexContext;
export const _test_DiggerContext = DiggerContext;
