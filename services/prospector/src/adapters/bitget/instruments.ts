import { logger } from '@devvir/service-kit';
import { fetchJson } from '../../metadata';
import { seriesFor, venueIdOf } from '../../catalog';
import { archiveNamesOf, halfOf, pathSymbolOf } from './symbols';
import { marketOf, tokenOf, unknownMargin } from './shapes';
import type { DatabaseSync } from 'node:sqlite';
import type { DeclaredTransform, Found, Instrument, Searched } from '../../types';

/**
 * What bitget lists, and which of its series can produce a path.
 *
 * It lives apart from the adapter for the reason okx's does — an adapter should
 * read as a description of a venue, not as several hundred lines of strategy.
 */

/**
 * How the archive spells one instrument under one shape, or undefined where it
 * spells it as the venue does.
 *
 * Asked per shape rather than per instrument because bitget renames differ by
 * half: `AISLEEPLESSUSDT` is `AIUSDT` in futures and `$AIUSDT` in spot.
 */
export const bitgetUrlSymbol = (of: Found): string | undefined => {
  const spelt = asked.get(of.symbol)?.spelling ?? pathSymbolOf(halfOf(of.pattern), of.symbol);

  return spelt === of.symbol ? undefined : spelt;
};

/**
 * What the venue's own search said about the instruments this pass had never
 * seen, filled in by `bitgetInstruments` before the preamble asks for spellings.
 *
 * **Held for the pass rather than for ever.** A re-listing can move where an
 * instrument files, and the answer is one request away; caching it across runs
 * would be preserving exactly the staleness this replaced.
 */
const asked = new Map<string, Searched>();

// ── The venue's instruments ───────────────────────────────────────────────────

/**
 * What bitget lists, in the catalog's words and the archive's spelling.
 *
 * **The only discovery bitget has.** Its bucket serves no listing, so a symbol
 * listed since the seed was built is reachable no other way.
 *
 * Two translations, both the adapter's own and both already written: the venue's
 * `SPOT`/`FUTURES` into the catalog's markets, and its own name for an
 * instrument into the one its keys use — bitget renamed its spot symbols in 2024
 * and the archive carries both spellings, which is what `pathSymbolOf` knows.
 *
 * **Everything it names is live.** This endpoint answers with what bitget
 * trades, so a symbol leaving the list is the only ending it states.
 */
export const bitgetInstruments = async (db: DatabaseSync): Promise<Instrument[]> => {
  const out: Instrument[] = [];

  /**
   * **Refused before anything is asked about them**, not while they are being
   * built. The venue lists roughly 1,500 tokenised equities, ETFs, metals and
   * currency pairs beside its crypto - `rTSLA/USDT` and `rARKK/USDT` on the spot
   * line, `AAPLUSDT` and `ASMLUSDT` as perpetuals on the futures one - and the
   * catalog holds none of them. Every one is therefore a name it has never met,
   * and refusing them a loop later meant the search below asked the venue about
   * 1,498 instruments, one request apiece, to discard every answer.
   *
   * **`marketOf` is the predicate, not `symbolType`.** Measured over 2,941
   * listed instruments: `symbolType = 'stock'` alone misses 2 spot metals, 7
   * futures metals, 3 futures commodities and 11 futures contracts the venue
   * types `crypto` and flags `isRwa: YES` - `HPQ`, `BHP`, `RIO`, `VALE`,
   * `EURUSD`, `USDJPY` and the like. Both fields it reads are present on every
   * instrument of every category, so there is no missing value to default.
   *
   * The spot half of that rule refuses anything **not** `crypto`, so a type
   * bitget invents tomorrow is refused rather than admitted by omission.
   */
  const all = (await listing()).filter(one => marketOf(one) !== EXCLUDED);

  /**
   * **Ask the venue how it files what the catalog has never met.**
   *
   * A re-issued ticker files under a name no rule reaches - `APPUSDT`'s candles
   * are `APPSTOCKUSDT` - and the venue states it, per instrument, through its own
   * search. Asked only about names absent from the catalog, which is a handful on
   * any ordinary pass, so this costs nothing on the passes where nothing is new.
   */
  asked.clear();

  {
    const venueId = venueIdOf(db, 'bitget', '');
    const known   = new Set(seriesFor(db, venueId).map(one => one.symbol));
    const fresh   = [...new Set(all.map(one => one.symbol))].filter(one => ! known.has(one));

    /**
     * **Said before the asking, because the asking is the quiet part.** One
     * request per name against an endpoint that answers about two a second, so a
     * pass over a catalog that has met nothing spends twenty minutes here with
     * nothing else to show for it.
     */
    if (fresh.length > 0)
      logger.info({ venue: 'bitget', instruments: fresh.length },
        'Asking bitget how it files the instruments the catalog has not met — one request each');

    for (const [symbol, found] of await archiveNamesOf(fresh)) asked.set(symbol, found);
  }

  for (const one of all) {
    /**
     * **The venue's own name, not the archive's.** A series is identified by its
     * canonical symbol and spells its keys through `url_symbol`; reporting the
     * archive spelling here would make every renamed instrument a second series
     * beside the one the seed already holds. The spelling is answered separately,
     * by `urlSymbolFor`, which is per shape because the two halves of the venue
     * spell the same rename differently.
     */
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
 * What bitget lists **today**, across every contract type it offers.
 *
 * Four calls, because the endpoint is per category and the category is
 * load-bearing: it is what says whether a futures instrument's trades are filed
 * under `UMCBL`, `DMCBL` or `CMCBL`, which nothing in the symbol reveals.
 *
 * **This is not the same question as "what has bitget ever listed".** It returns
 * only what trades now, so it bounds what survives rather than what existed —
 * which is exactly right for finding new instruments and useless for finding old
 * ones.
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

        /**
         * **What the instrument is, not just where it is listed.** The category
         * says which half of the venue it trades on; these say whether it is
         * crypto at all and whether it expires - see `marketOf`.
         */
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
 * The margin line this instrument's futures trades are filed under, where it is
 * not the one the pattern assumes.
 *
 * **Nothing but the listing can answer this.** The token is a directory segment
 * - `trades/DMCBL/…` against `trades/UMCBL/…` - and neither the symbol nor the
 * path reveals which; only the category the venue listed the contract under
 * does, and that is known here and nowhere later. Asked wrongly it costs the
 * whole instrument: the key is well formed, the bucket answers that it is not
 * there, and the contract reads as one that publishes nothing.
 *
 * **Only where it departs from the pattern's own default.** A USDT-margined
 * contract is what `{TRANSFORM:marginToken:UMCBL}` already says, so writing a
 * row for it would be the default spelled twice.
 *
 * **From the beginning of time, because the token is not a span.** It is a
 * property of the contract's margin type, which does not change during its life
 * - where the shipped seed carries dates it is because a sweep measured spans,
 * not because the token moved. A floor below any date this instrument can carry
 * is therefore the honest bound, and the one that cannot be wrong downward.
 *
 * **The venue's own answer is preferred to any inference.** Its search states the
 * token outright, as the suffix of `symbolId`, and the preamble has already asked
 * about exactly these instruments - so where that answered, nothing is derived.
 * `tokenOf` is the fallback for an instrument the search does not know, and a
 * contract type neither source covers keeps the default and says so through
 * `unknownMargin`.
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
