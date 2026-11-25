import { fetchJson, metadataGap } from '../../metadata';
import type { Instrument } from '../../types';

/** What kucoin lists: spot and futures, each from its own endpoint. Neither states an ending. */
export const kucoinInstruments = async (): Promise<Instrument[]> => {
  const out: Instrument[] = [];

  const spot = await fetchJson<{ data?: Spot[] }>(SPOT, 'kucoin', refused);

  for (const one of listOf(spot, SPOT))
    if (one.symbol) out.push({ market: 'spot', symbol: one.symbol, live: one.enableTrading !== false });

  await metadataGap();

  const futures = await fetchJson<{ data?: Contract[] }>(FUTURES, 'kucoin', refused);

  for (const one of listOf(futures, FUTURES))
    if (one.symbol) out.push({ market: 'perp', symbol: one.symbol, live: one.status === 'Open' });

  return out;
};

// ── Internals ─────────────────────────────────────────────────────────────────

/** Every answer is `{code, data}`, and only `"200000"` is success. */
const refused = (body: unknown): boolean => (body as { code?: unknown }).code !== '200000';

/** An answer's records, or a failure: a body without a list is not an empty listing. */
const listOf = <T>(body: { data?: T[] }, url: string): T[] => {
  if (! Array.isArray(body.data)) throw new Error(`kucoin instruments: no list in the answer from ${url}`);

  return body.data;
};

interface Spot     { symbol?: string; enableTrading?: boolean }
interface Contract { symbol?: string; status?: string }

const SPOT    = 'https://api.kucoin.com/api/v2/symbols';
const FUTURES = 'https://api-futures.kucoin.com/api/v1/contracts/active';
