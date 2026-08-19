import { fetchJson, metadataGap } from '../../metadata';
import type { Instrument } from '../../types';

/**
 * What kucoin lists, in the archive's own spelling.
 *
 * **Two hosts and no translation.** Spot answers `0G-USDT` and its files say
 * `0G-USDT`; futures answers `0GUSDTM` and its files say `0GUSDTM`. The archive
 * also holds older spot names written without the separator, but those belong to
 * a tree kucoin stopped writing to — a new instrument is filed the way the
 * listing spells it.
 *
 * **Neither endpoint states an ending.** Spot carries `enableTrading`, which is
 * a halt rather than a delisting — one symbol of a thousand — and the futures
 * endpoint is named for what it returns. So a symbol leaving the list is the only
 * ending either of them states.
 */
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
