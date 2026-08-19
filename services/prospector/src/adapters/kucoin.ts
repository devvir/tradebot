import { asSeries } from '../paths';
import { canonicalInterval } from '../canonical';
import { s3 } from '../scanners/s3';
import { listing } from '../context';
import type { Adapter, Inspection } from '../types';
import { kucoinInstruments } from './kucoin/instruments';
import { declare } from './declare';

/**
 * KuCoin publishes a standard S3 listing on the same host that serves the
 * files, so `list` and `base` are one address.
 *
 * One granularity only — every file is a day — so there is nothing to tag.
 */
export const kucoin: Adapter = declare({
  /** The shared listing context — this venue differs by address, not by shape. */
  getContext: async () => listing(kucoin),

  name:    'kucoin',
  scanner: s3,
  list:    'https://historical-data.kucoin.com',

  /**
   * **Lowered on timeouts, and only the in-flight half of it.**
   *
   * This venue had declared nothing and so inherited the default hundred, which
   * is a hundred sockets asked of one origin. Requests that never reached it at
   * all were the symptom — a socket that is never answered on, rather than a
   * venue objecting to a rate — and `concurrency` is what decides how many of
   * those are open at once, which is why it is the figure that moves first.
   *
   * The rate is left where it was on purpose. Nothing observed says 100/s is
   * too much for this host, and with five in flight it is not reached at all
   * unless this host answers inside fifty milliseconds: the pace settles below
   * the cap on its own, which is the correct answer to a host that is slow
   * rather than a smaller number written down.
   *
   * Not measured. If the timeouts survive five, this is still the number to
   * move before the rate is touched.
   */
  pacing:  { concurrency: 5 },

  /** What this venue lists today — its only discovery. */
  instruments: kucoinInstruments,

  /** Reading this venue's paths back into series — see `paths.ts`. */
  inspectUrl: (path) => inspect(path),

  /**
   * How the archive spells an instrument under one shape — the same knowledge
   * `inspect` applies to a path, asked the other way for a series created from
   * the listing rather than from a key.
   */
  urlSymbolFor: (of) => spelling(of.market, of.dataset, of.symbol),

  dateOf: (path) => {
    const m = /(\d{4})-(\d{2})-(\d{2})\.zip$/.exec(path);

    return m ? `${m[1]}${m[2]}${m[3]}` : null;
  },

  /**
   * Futures klines at `1d` are **published broken** and are refused.
   *
   * Every one of those files declares `time,open,high,low,close,volume` and
   * then writes five fields per row: the volume is not empty, it is absent.
   * A kline without volume is not a kline anyone can use, and KuCoin's own
   * archive is the source of it — a file fetched fresh from them is
   * byte-identical to the stored copy, matching the MD5 they publish beside it,
   * so nothing downstream mangled it.
   *
   * It is the interval and not the venue that is wrong. Futures klines at every
   * other interval carry six fields and six values, spot klines carry seven and
   * seven, and `index` and `mark` carry five and five at every interval —
   * correctly, since a mark-price bar has no volume to report. Checked across
   * forty symbols and every row of a sample of them: `1d` is 6/5 everywhere.
   *
   * **Nothing is lost by refusing them.** A daily bar is an aggregate of
   * finer ones, and the 1m series is published complete over the same range, so
   * a consumer that wants a day builds one *with* volume — the same thing it
   * already does for venues that publish fewer intervals.
   *
   * Described rather than enumerated, so it belongs here and not in the
   * `exclusion` table: KuCoin adds a file per symbol per day, and the rule has
   * to hold for keys nobody has published yet.
   */
  accepts: (path) => ! /^futures\/daily\/klines\/[^/]+\/1d(?:\/|$)/.test(path),
});

// ── Internals ─────────────────────────────────────────────────────────────────

/**
 * KuCoin: `<market>/<grain>/[<group>/]<dataset>/<SYMBOL>/[<interval>/]<file>`.
 *
 * The optional group is `depth/`, which holds the order books at their level —
 * `futures/daily/depth/orderbooklv50/…` — and is the only place this tree is
 * three deep before the instrument.
 */
const inspect = (path: string): Inspection => {
  const found = KUCOIN.exec(path);

  if (! found) return { of: 'unknown', date: null };

  const { market, dataset, interval, symbol, date } = found.groups!;

  const canonical = canonicalise(market!, dataset!, interval);

  if (! canonical) return { of: 'unknown', date: null };

  /**
   * **The path spells the instrument; kucoin's API names it.** Where the two
   * differ the row is keyed by the venue's own name and the archive's spelling
   * is recorded beside it — see `named`, and `urlSymbolFor` for the same
   * knowledge applied to a series created from the listing.
   */
  return asSeries(path, { ...canonical, ...named(canonical.market, symbol!), date: date! });
};

/**
 * The instrument a path names, as kucoin itself names it.
 *
 * **The venue's API is the authority on what an instrument is called**, and its
 * archive does not always agree with it. Neither spelling is wrong; one is a
 * name and the other is a URL, and the catalog keys rows by the name so that a
 * consumer asking kucoin's own question gets kucoin's own answer.
 *
 * Two divergences, both measured against the archive:
 *
 * - **Spot drops the dash outside books.** `depth/orderbooklv50/0G-USDT/` keeps
 *   it, `klines/0GUSDT/` and `trades/0GUSDT/` do not. All 1,775 dashed names in
 *   the archive round-trip through `QUOTES`, and so do all 1,007 the API lists.
 * - **Futures write `BTC` where kucoin trades `XBT`.** Its three bitcoin
 *   perpetuals are `BTCUSDTM`, `BTCUSDM` and `BTCUSDCM` in every tree, and its
 *   dated bitcoin contracts are `BTCMU26` under books while every other tree
 *   spells them `XBTMU26`. No contract the API lists begins with `BTC`.
 *
 * **The path is enough on its own** — a dash is there or it is not, a name
 * begins with `BTC` or it does not — so unlike `spelling` this needs no dataset.
 *
 * A name that cannot be split keeps the path's spelling: 23 of the archive's
 * 2,419 dashless spot names use a quote kucoin no longer lists, and inventing a
 * dash for them would be a guess.
 */
const named = (market: string, path: string): { symbol: string; urlSymbol?: string } => {
  const symbol = market === 'perp' && path.startsWith('BTC') ? `XBT${path.slice(3)}`
    : market === 'spot' && ! path.includes('-') ? (dashed(path) ?? path)
      : path;

  return symbol === path ? { symbol } : { symbol, urlSymbol: path };
};

/** Where the dash goes, from the quote the pair settles in. Null where none is known. */
const dashed = (flat: string): string | null => {
  const quote = QUOTES.find(one => flat.endsWith(one) && flat.length > one.length);

  return quote ? `${flat.slice(0, -quote.length)}-${quote}` : null;
};

/**
 * The quote currencies kucoin has ever priced a spot pair in, longest first.
 *
 * **Longest first is what makes the split unambiguous**, and it is checked
 * rather than assumed: every dashed name in the archive and every pair the API
 * lists reconstructs exactly from its dashless form.
 *
 * The four at the end are retired — no pair the API lists uses them — and they
 * are kept because the archive does.
 */
const QUOTES = ['USDT', 'USDC', 'USD1', 'USDG', 'TUSD', 'DOGE', 'BTC', 'ETH', 'KCS', 'EUR',
  'TRX', 'BRL', 'DAI', 'GBP', 'THB', 'TRY']
  .sort((a, b) => b.length - a.length);

/**
 * The same divergence, for a series created from the listing rather than a path.
 *
 * **Answers what the URL must say, given what kucoin calls the instrument** —
 * so it is `named` inverted, and the two are tested against each other.
 */
const spelling = (market: string, dataset: string, symbol: string): string | undefined => {
  if (market === 'spot') return dataset === 'books' ? undefined : symbol.replaceAll('-', '');

  if (market !== 'perp' || ! symbol.startsWith('XBT')) return undefined;

  /**
   * **A dated contract diverges only under books**, where the three perpetuals
   * diverge everywhere. Both are `BTC` in the archive; they differ in how much
   * of it.
   */
  return DATED.test(symbol) && dataset !== 'books' ? undefined : `BTC${symbol.slice(3)}`;
};

/** A quarterly contract: the month code and a two-digit year — `XBTMU26`. */
const DATED = /^XBTM[HMUZ]\d{2}$/;

/**
 * KuCoin's own words for a market, in the catalog's.
 *
 * **`futures` maps to `perp` whole**, which is what its perpetuals are —
 * `XBTUSDTM` and the rest, carrying the `M` suffix kucoin gives them. The
 * handful of quarterly contracts in the same tree (see `DATED`) land there too,
 * and the instrument listing says nothing that would separate them.
 */
const MARKET_OF: Record<string, string> = { spot: 'spot', futures: 'perp' };

/** KuCoin's own words for a dataset, in the catalog's. */
const MEANINGS: Record<string, { dataset: string; variant?: string; binned?: true }> = {
  trades:       { dataset: 'trades' },
  klines:       { dataset: 'klines',     binned: true },
  index:        { dataset: 'indexPrice', binned: true },
  mark:         { dataset: 'markPrice',  binned: true },
  fundingRates: { dataset: 'funding', variant: 'realised' },
};

/**
 * The books name their depth inside the dataset — `orderbooklv50` — and are
 * whole books one per row, verified on a real file: fifty levels a side, no
 * deltas.
 */
const BOOK = /^orderbooklv([0-9]+)$/;

const canonicalise = (
  market:   string,
  dataset:  string,
  interval: string | undefined,
): { market: string; dataset: string; variant?: string } | null => {
  const canonical = MARKET_OF[market];

  if (! canonical) return null;

  const book = dataset.match(BOOK);

  if (book) return { market: canonical, dataset: 'books', variant: `${book[1]},snapshot` };

  const meaning = MEANINGS[dataset];

  if (! meaning) return null;

  if (! meaning.binned) {
    return { market: canonical, dataset: meaning.dataset,
      ...(meaning.variant ? { variant: meaning.variant } : {}) };
  }

  const bar = interval ? canonicalInterval(interval) : null;

  return bar ? { market: canonical, dataset: meaning.dataset, variant: bar } : null;
};

const KUCOIN = new RegExp(
  '^(?<market>spot|futures)/(?:daily|monthly)(?:/depth)?/(?<dataset>[A-Za-z0-9]+)'
  + '/(?<symbol>[^/]+)(?:/(?<interval>[^/]+))?'
  + '/[^/]*(?<date>\\d{4}-\\d{2}(?:-\\d{2})?)\\.[a-z.]+$');
