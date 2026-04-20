import { createContext, useContext, useMemo, type ReactNode } from 'react';
import { BitmexClient } from './BitmexClient';

const BitmexContext = createContext<BitmexClient | null>(null);

export function DataProvider({ children }: { children: ReactNode }) {
  // Created once for the app lifetime — no effect cleanup needed.
  // useEffect destroy would fire on StrictMode's double-invoke and permanently
  // poison the client's reconnect flag before widgets even subscribe.
  const client = useMemo(() => new BitmexClient(
    import.meta.env.VITE_BITMEX_REST_URL as string,
    import.meta.env.VITE_BITMEX_WS_URL   as string,
  ), []);

  return (
    <BitmexContext.Provider value={client}>
      {children}
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
