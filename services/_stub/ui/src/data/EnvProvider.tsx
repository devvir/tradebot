/**
 * Holds the currently selected data environment (live / testnet / replay).
 * Persists across reloads via localStorage. A stored value that is not a known
 * env, or is 'replay' in a build without replay, restores as the default env.
 */

import { createContext, useContext, useState, type ReactNode } from 'react';
import { get, set } from '../utils/storage';
import type { Env, EnvContextValue } from '../types';

const STORAGE_KEY = 'tradebot.ui.env';
const DEFAULT_ENV: Env = 'live';

declare const __REPLAY_ENABLED__: boolean;

const EnvContext = createContext<EnvContextValue | null>(null);

const isEnv = (v: unknown): v is Env => v === 'live' || v === 'testnet' || v === 'replay';

function restoreEnv(): Env {
  const stored = get<unknown>(STORAGE_KEY, DEFAULT_ENV);

  return isEnv(stored) && (stored !== 'replay' || __REPLAY_ENABLED__) ? stored : DEFAULT_ENV;
}

export function EnvProvider({ children }: { children: ReactNode }) {
  const [env, setEnvState] = useState<Env>(restoreEnv);

  const setEnv = (next: Env) => {
    set(STORAGE_KEY, next);
    setEnvState(next);
  };

  return (
    <EnvContext.Provider value={{ env, setEnv }}>
      {children}
    </EnvContext.Provider>
  );
}

export function useEnv(): EnvContextValue {
  const ctx = useContext(EnvContext);

  if (! ctx) throw new Error('useEnv must be used within EnvProvider');

  return ctx;
}
