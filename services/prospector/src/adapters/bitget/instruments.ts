import { logger } from '@devvir/service-kit';
import { fetchJson } from '../../metadata';
import { seriesFor, venueIdOf } from '../../catalog';
import { archiveNamesOf, halfOf, pathSymbolOf } from './symbols';
import { marketOf, tokenOf, unknownMargin } from './shapes';
import type { DatabaseSync } from 'node:sqlite';
import type { DeclaredTransform, Found, Instrument, Searched } from '../../types';

/** What bitget lists, and how the archive files it. */

/**
 * How the archive spells an instrument under one pattern, or undefined where it
 * spells it as the venue does.
 */
export const bitgetUrlSymbol = (of: Found): string | undefined => {
  const spelt = asked.get(of.symbol)?.spelling ?? pathSymbolOf(halfOf(of.pattern), of.symbol);

  return spelt === of.symbol ? undefined : spelt;
};

/** What the venue's search said of the instruments this pass had never seen. Held for the pass only. */
const asked = new Map<string, Searched>();

// ── The venue's instruments ───────────────────────────────────────────────────

/** What bitget lists today, in the catalog's markets and under the venue's own names. Its only discovery. */
export const bitgetInstruments = async (db: DatabaseSync): Promise<Instrument[]> => {
  const out: Instrument[] = [];

  /**
   * Everything that is not crypto is refused here, before the search is asked
   * about it — `marketOf` decides.
   */
  const all = (await listing()).filter(one => marketOf(one) !== EXCLUDED);

  /** Ask the venue how it files the names the catalog has never met. */
  asked.clear();

  {
    const venueId = venueIdOf(db, 'bitget', '');
    const known   = new Set(seriesFor(db, venueId).map(one => one.symbol));
    const fresh   = [...new Set(all.map(one => one.symbol))].filter(one => ! known.has(one));

    /** Said first: one request a name, at about two a second. */
    if (fresh.length > 0)
      logger.info({ venue: 'bitget', instruments: fresh.length },
        'Looking up how bitget files its new instruments');

    for (const [symbol, found] of await archiveNamesOf(fresh)) asked.set(symbol, found);
  }

  for (const one of all) {
    /** The venue's own name: the archive's spelling is answered apart, by `urlSymbolFor`. */
    out.push({
      market:   marketOf(one),
      symbol:   one.symbol,
      live:     one.live,
      transforms: marginOf(one, asked.get(one.symbol)?.token ?? null),
    });
  }

  return out;
};

/**
 * What bitget lists today, a category a call: the category is what says where a
 * contract's trades are filed.
 */
const listing = async (): Promise<Instrument[]> => {
  const out: Instrument[] = [];

  for (const category of CATEGORIES) {
    const body = await fetchJson<{ data?: {
      symbol: string; launchTime?: string; symbolType?: string; isRwa?: string; type?: string;
    }[] }>(`${INSTRUMENTS}?category=${category}`, 'bitget');

    for (const one of body.data ?? [])
      out.push({
        market:     category === 'SPOT' ? 'SPOT' : 'FUTURES',
        category,
        symbol:     one.symbol,
        launchedAt: stamp(one.launchTime),

        /** What the instrument is, beside where it is listed — see `marketOf`. */
        symbolType: one.symbolType,
        isRwa:      one.isRwa,
        type:       one.type,

        // This endpoint answers with what bitget trades, so everything it names
        // is live and everything it omits is not.
        live:       true,
      });
  }

  return out;
};

/**
 * The margin line an instrument's futures trades are filed under, where it is
 * not the pattern's default: from the venue's search where that answered, and
 * from the listing's category otherwise.
 */
const marginOf = (one: Instrument, stated: string | null): DeclaredTransform[] | undefined => {
  if (one.market === 'SPOT') return undefined;

  if (stated === null && unknownMargin(one)) return undefined;

  const token = stated ?? tokenOf(one, 'trades');

  if (token === DEFAULT_MARGIN) return undefined;

  return [{
    dataset:   'trades',
    kind:      'marginToken',
    transform: token,
    from_:     ALWAYS,
    to_:       null,
  }];
};

/** What every `{TRANSFORM:marginToken:…}` slot in the shipped patterns defaults to. */
const DEFAULT_MARGIN = 'UMCBL';

/** Below any date bitget can have published, so the row holds for the whole life. */
const ALWAYS = '19700101';

/** The canonical market this venue's non-crypto listings fall in, and which is refused. */
const EXCLUDED = 'tradfi';

const INSTRUMENTS = 'https://api.bitget.com/api/v3/market/instruments';

const CATEGORIES = ['SPOT', 'USDT-FUTURES', 'COIN-FUTURES', 'USDC-FUTURES'] as const;

/** A launch time as milliseconds, read at the grain everything here works in. */
const stamp = (ms: string | undefined): string | null => {
  const at = Number(ms);

  return Number.isFinite(at) && at > 0
    ? new Date(at).toISOString().slice(0, 10).replaceAll('-', '')
    : null;
};

// ── Test access ───────────────────────────────────────────────────────────────

export const _test_marginOf = marginOf;
