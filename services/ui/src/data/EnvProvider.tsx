/**
 * Holds the currently selected data environment (live / testnet / replay).
 * Persists across reloads via localStorage. Consumers are the `Header`
 * dropdown (writer) and `DataProvider` (reader, recreates clients on change).
 */

import { createContext, useContext, useState, type ReactNode } from 'react';
import { get, set } from '../utils/storage';
import type { Env, EnvContextValue } from '../types';

const STORAGE_KEY = 'tradebot.ui.env';
const DEFAULT_ENV: Env = 'live';

const EnvContext = createContext<EnvContextValue | null>(null);

export function EnvProvider({ children }: { children: ReactNode }) {
  const [env, setEnvState] = useState<Env>(() => get<Env>(STORAGE_KEY, DEFAULT_ENV));

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
