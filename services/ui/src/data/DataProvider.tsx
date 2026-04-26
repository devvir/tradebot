import { createContext, useContext, useMemo, type ReactNode } from 'react';
import { BitmexClient } from './BitmexClient';
import { DiggerClient } from './DiggerClient';

const BitmexContext = createContext<BitmexClient | null>(null);
const DiggerContext = createContext<DiggerClient | null>(null);

export function DataProvider({ children }: { children: ReactNode }) {
  // Created once for the app lifetime — no effect cleanup needed.
  // useEffect destroy would fire on StrictMode's double-invoke and permanently
  // poison the client's reconnect flag before widgets even subscribe.
  const bitmex = useMemo(() => new BitmexClient(
    import.meta.env.VITE_BITMEX_REST_URL as string,
    import.meta.env.VITE_BITMEX_WS_URL   as string,
  ), []);

  const diggerUrl = import.meta.env.VITE_DIGGER_URL as string | undefined;
  const digger    = useMemo(
    () => diggerUrl ? new DiggerClient(diggerUrl) : null,
    [diggerUrl],
  );

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

/** Returns null when digger is not configured (e.g. live mode). */
export function useDigger(): DiggerClient | null {
  return useContext(DiggerContext);
}
