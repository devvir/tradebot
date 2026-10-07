import { fetchJson } from '../../metadata';
import { seriesFor, venueIdOf } from '../../catalog';
import type { Instrument } from '../../types';
import type { DatabaseSync } from 'node:sqlite';

/** What bybit lists, a category at a time, in the archive's spelling — see `docs/venues/BYBIT.md`. */
export const bybitInstruments = async (db: DatabaseSync, host: string): Promise<Instrument[]> => {
  const out: Instrument[] = [];

  for (const one of await catalogue('spot'))
    out.push({ market: 'spot', symbol: one.symbol, live: one.status === 'Trading' });

  /** `linear` and `inverse` are both perpetuals. */
  for (const category of ['linear', 'inverse'] as const)
    for (const one of await catalogue(category))
      out.push({ market: 'perp', symbol: one.symbol, live: one.status === 'Trading' });

  for (const underlying of optionsOf(db, host))
    out.push({
      market: 'option',
      symbol: underlying,

      /** Options are filed by underlying, which is live while any of its contracts is. */
      live:   (await catalogue('option', underlying)).some(one => one.status === 'Trading'),
    });

  return out;
};

// ── Internals ─────────────────────────────────────────────────────────────────

/** The option underlyings to ask about: the ones on record, since bybit publishes no list of them. */
const optionsOf = (db: DatabaseSync, host: string): string[] => {
  const held = seriesFor(db, venueIdOf(db, 'bybit', host), { market: 'option' });

  return [...new Set(held.map(one => one.symbol))].filter(one => one !== '@');
};

/**
 * One category's instruments, following the cursor: the live ones, and on
 * derivatives the closed ones too.
 */
const catalogue = async (
  category:  'spot' | 'linear' | 'inverse' | 'option',
  baseCoin?: string,
): Promise<{ symbol: string; status: string }[]> => {
  const out: { symbol: string; status: string }[] = [];

  /** Spot answers `status=Closed` with the live list again, so it is not asked. */
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

/** A cap on pages, so that a cursor that never empties cannot spin. */
const PAGES = 12;
