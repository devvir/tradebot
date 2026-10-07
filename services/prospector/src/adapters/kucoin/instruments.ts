import { fetchJson, metadataGap } from '../../metadata';
import type { Instrument } from '../../types';

/** What kucoin lists: spot and futures, each from its own endpoint. Neither states an ending. */
export const kucoinInstruments = async (): Promise<Instrument[]> => {
  const out: Instrument[] = [];

  const spot = await fetchJson<{ data?: Spot[] }>(SPOT, 'kucoin');

  for (const one of spot.data ?? [])
    if (one.symbol) out.push({ market: 'spot', symbol: one.symbol, live: one.enableTrading !== false });

  await metadataGap();

  const futures = await fetchJson<{ data?: Contract[] }>(FUTURES, 'kucoin');

  for (const one of futures.data ?? [])
    if (one.symbol) out.push({ market: 'perp', symbol: one.symbol, live: one.status === 'Open' });

  return out;
};

// ── Internals ─────────────────────────────────────────────────────────────────

interface Spot     { symbol?: string; enableTrading?: boolean }
interface Contract { symbol?: string; status?: string }

const SPOT    = 'https://api.kucoin.com/api/v2/symbols';
const FUTURES = 'https://api-futures.kucoin.com/api/v1/contracts/active';
