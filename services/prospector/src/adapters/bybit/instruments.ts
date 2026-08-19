import { fetchJson } from '../../metadata';
import { seriesFor, venueIdOf } from '../../catalog';
import type { Instrument } from '../../types';
import type { DatabaseSync } from 'node:sqlite';

/**
 * What bybit lists, in the archive's own spelling.
 *
 * **Nothing is translated, and that was measured rather than assumed.** Every
 * one of bybit's 549 live spot symbols and 859 of its 862 live perpetuals are
 * already in the catalog under exactly the name the API returns; the three that
 * are not were listed the day the check ran. So `symbol` passes through, and the
 * work here is which endpoint to ask and what its answer means.
 *
 * ```
 * category=spot                    -> spot
 * category=linear | inverse        -> perp
 * category=option, per underlying  -> option
 * ```
 *
 * **Its derivatives say when they are finished; its spot does not.** Asking a
 * derivative category for `status=Closed` answers with 955 contracts that share
 * nothing with the 836 live ones — a venue stating an ending rather than merely
 * omitting it. Asking spot the same question returns the live list again, byte
 * for byte, so there the only signal is absence and the extra call buys nothing.
 */
export const bybitInstruments = async (db: DatabaseSync, host: string): Promise<Instrument[]> => {
  const out: Instrument[] = [];

  for (const one of await catalogue('spot'))
    out.push({ market: 'spot', symbol: one.symbol, live: one.status === 'Trading' });

  /**
   * **Both margins are perpetuals here.** `linear` settles in stablecoin and
   * `inverse` in the base coin, which is a property of the contract rather than
   * of what it is — and the archive files them under one market, keyed by names
   * that cannot collide (`BTCUSDT` against `BTCUSD`).
   */
  for (const category of ['linear', 'inverse'] as const)
    for (const one of await catalogue(category))
      out.push({ market: 'perp', symbol: one.symbol, live: one.status === 'Trading' });

  for (const underlying of optionsOf(db, host))
    out.push({
      market: 'option',
      symbol: underlying,

      /**
       * **An underlying is live while any of its contracts is.** The archive
       * files options by underlying — one chain a day, not one file per strike —
       * so what the catalog holds is `BTC`, and what makes that live is bybit
       * still writing contracts under it.
       */
      live:   (await catalogue('option', underlying)).some(one => one.status === 'Trading'),
    });

  return out;
};

// ── Internals ─────────────────────────────────────────────────────────────────

/**
 * Which option underlyings to ask about.
 *
 * **Read from the catalog, because bybit publishes no list of them.** The
 * instruments endpoint defaults to `baseCoin=BTC` and answers per underlying,
 * with no public way to enumerate which exist — so the ones already on record
 * are the question, and a new underlying arrives the way it always has, by a
 * walk finding files under a name nobody asked about.
 *
 * That is a real limit and a small one: bybit has eight, and a ninth is a rarer
 * event than a walk.
 *
 * The venue-wide bucket is dropped: `@` is not an underlying and asking bybit
 * about it would answer nothing.
 */
const optionsOf = (db: DatabaseSync, host: string): string[] => {
  const held = seriesFor(db, venueIdOf(db, 'bybit', host), { market: 'option' });

  return [...new Set(held.map(one => one.symbol))].filter(one => one !== '@');
};

/**
 * One category's instruments, live and closed, following the cursor.
 *
 * **Two calls where the second says something.** The default answers only what
 * is trading, so on a derivative category asking once would report every
 * delisted contract as an absence — the weaker signal, indistinguishable from an
 * endpoint that simply did not mention it. On spot the second call is the same
 * answer twice, so it is not made.
 */
const catalogue = async (
  category:  'spot' | 'linear' | 'inverse' | 'option',
  baseCoin?: string,
): Promise<{ symbol: string; status: string }[]> => {
  const out: { symbol: string; status: string }[] = [];

  /**
   * **Spot has no second answer.** `status=Closed` there returns the trading
   * list again, identical, so asking twice spends a call to learn nothing — and
   * an instrument bybit has stopped listing arrives as an absence instead.
   */
  const asked = category === 'spot' ? ['Trading'] as const : ['Trading', 'Closed'] as const;

  for (const status of asked) {
    let cursor = '';

    for (let page = 0; page < PAGES; page++) {
      const query = new URLSearchParams({ category, status, limit: '1000' });

      if (baseCoin) query.set('baseCoin', baseCoin);
      if (cursor) query.set('cursor', cursor);

      const body = await fetchJson<Answer>(`${INSTRUMENTS}?${query}`, 'bybit');

      for (const one of body.result?.list ?? [])
        out.push({ symbol: one.symbol, status: one.status });

      cursor = body.result?.nextPageCursor ?? '';

      if (! cursor) break;
    }
  }

  return out;
};

interface Answer {
  result?: {
    list?:            { symbol: string; status: string }[];
    nextPageCursor?:  string;
  };
}

const INSTRUMENTS = 'https://api.bybit.com/v5/market/instruments-info';

/**
 * How many pages one category may run to.
 *
 * A thousand instruments a page against a venue with a few thousand: the cap is
 * there so a cursor that never empties cannot spin, not because anything here is
 * expected to reach it.
 */
const PAGES = 12;
