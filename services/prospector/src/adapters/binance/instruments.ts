import { fetchJson, metadataGap } from '../../metadata';
import type { Instrument } from '../../types';

/**
 * What binance lists, in the archive's own spelling.
 *
 * **Four hosts, because binance runs a service per margin.** Spot, USDⓈ-margined
 * futures, coin-margined futures and options each answer at their own address
 * with their own shape. None of that reaches the core.
 *
 * **Nothing is translated.** The archive files an instrument under the name the
 * API returns — `0GBNB`, `DOGSUSDT`, `BTCUSDT_230630` — so the work here is
 * which market a contract belongs to, not what it is called.
 *
 * **A contract's type decides its market, not the host it came from.** Both
 * futures services mix perpetuals and dated contracts in one answer, so
 * `contractType` is what separates them: a quarterly expires and is a `future`,
 * a perpetual does not and is a `perp`.
 *
 * **But the host decides its archive, so it is kept.** `um` and `cm` are one
 * market and two keyspaces: binance runs USDⓈ-margined futures at `fapi` and
 * coin-margined at `dapi`, files them under `futures/um` and `futures/cm`, and
 * domiciles every contract in exactly one of the two. Dropping which service
 * answered left a newly listed contract with a series under both trees, half of
 * them describing keys that market has never held — 130 of them for the one perp
 * listed on 2026-08-31, every one a `404` a day for ever.
 *
 * Nothing has to be inferred: the endpoint that answered *is* the domicile. It
 * is recorded as the `category`, which is what that field is for — the venue's
 * own name for the group it lists an instrument under.
 *
 * **Options are filed by underlying**, one chain rather than one file per
 * strike, so the 1,862 contracts binance lists collapse to the handful of
 * underlyings the archive actually holds.
 */
export const binanceInstruments = async (): Promise<Instrument[]> => {
  const out: Instrument[] = [];

  const spot = await fetchJson<{ symbols?: Spot[] }>(SPOT, 'binance');

  for (const one of spot.symbols ?? [])
    if (one.symbol) out.push({ market: 'spot', symbol: one.symbol, live: one.status === 'TRADING' });

  /**
   * **`status` and `contractStatus` are the same field under two names**, one
   * per service, which is why both are read rather than one being assumed.
   */
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

/**
 * The two futures services, keyed by the archive segment each writes to.
 *
 * **The key is the answer, which is why they are a map rather than a list.** A
 * contract is domiciled in whichever of these listed it, and the archive names
 * that domicile in the path — so iterating the pair carries the fact that used
 * to be thrown away when both were read into one bag.
 */
const FUTURES: Record<string, string> = {
  um: 'https://fapi.binance.com/fapi/v1/exchangeInfo',
  cm: 'https://dapi.binance.com/dapi/v1/exchangeInfo',
};
