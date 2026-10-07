import { fetchJson, metadataGap } from '../../metadata';
import type { Instrument } from '../../types';

/**
 * What binance lists, in the archive's spelling: four services, one list. The
 * futures service that answered is kept as the instrument's `category` — see
 * `docs/venues/BINANCE.md`.
 */
export const binanceInstruments = async (): Promise<Instrument[]> => {
  const out: Instrument[] = [];

  const spot = await fetchJson<{ symbols?: Spot[] }>(SPOT, 'binance');

  for (const one of spot.symbols ?? [])
    if (one.symbol) out.push({ market: 'spot', symbol: one.symbol, live: one.status === 'TRADING' });

  /** `status` and `contractStatus` are one field under two names, a service each. */
  for (const [category, url] of Object.entries(FUTURES)) {
    await metadataGap();

    const body = await fetchJson<{ symbols?: Contract[] }>(url, 'binance');

    for (const one of body.symbols ?? []) {
      if (! one.symbol) continue;

      const market = PERPETUAL.has(one.contractType ?? '') ? 'perp'
        : one.contractType ? 'future' : null;

      if (! market) continue;

      out.push({
        market,
        category,
        symbol: one.symbol,
        live:   (one.status ?? one.contractStatus) === 'TRADING',
      });
    }
  }

  await metadataGap();

  const options = await fetchJson<{ optionSymbols?: Option[] }>(OPTIONS, 'binance');
  const chains  = new Set<string>();

  for (const one of options.optionSymbols ?? [])
    if (one.underlying) chains.add(one.underlying);

  for (const underlying of chains)
    out.push({ market: 'option', symbol: underlying, live: true });

  return out;
};

// ── Internals ─────────────────────────────────────────────────────────────────

interface Spot     { symbol?: string; status?: string }
interface Contract { symbol?: string; contractType?: string; status?: string; contractStatus?: string }
interface Option   { underlying?: string }

/** The contract types that never expire — everything else is dated. */
const PERPETUAL = new Set(['PERPETUAL', 'TRADIFI_PERPETUAL']);

const SPOT    = 'https://api.binance.com/api/v3/exchangeInfo';
const OPTIONS = 'https://eapi.binance.com/eapi/v1/exchangeInfo';

/** The two futures services, keyed by the archive segment each writes to. */
const FUTURES: Record<string, string> = {
  um: 'https://fapi.binance.com/fapi/v1/exchangeInfo',
  cm: 'https://dapi.binance.com/dapi/v1/exchangeInfo',
};
