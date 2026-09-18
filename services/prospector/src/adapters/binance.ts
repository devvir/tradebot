import { asSeries } from '../paths';
import { walkOn } from './recurrence';
import { canonicalInterval } from '../canonical';
import { s3 } from '../scanners/s3';
import { listing } from '../context';
import type { Adapter, Inspection } from '../types';
import { binanceInstruments } from './binance/instruments';
import { declare } from './declare';

/**
 * Binance publishes a standard S3 listing, and serves the files from a
 * CloudFront host in front of the same bucket — hence two URLs, where a listing
 * venue with one host would repeat itself.
 *
 * Everything else about binance is discovered rather than declared: descent finds
 * `data/option/`, `BVOLIndex`, `EOHSummary` and `aggTrades` without any of them
 * being named here.
 */
export const binance: Adapter = declare({
  /** The shared listing context — this venue differs by address, not by shape. */
  getContext: async () => listing(binance),

  name:    'binance',
  scanner: s3,

  /**
   * **No limit found.** Measured 2026-09-29/30 with HEAD and LIST probes: up
   * to 1,788/s from one machine and ~1,200/s from the remote, without a single
   * throttling answer. A probe takes ~300 ms from here, found or missing, so
   * what is in flight sets the rate: 600 at once held ~1,750/s on missing keys
   * (2026-09-30).
   */
  pacing:  { perSecond: 2000, concurrency: 600 },

  /**
   * Probing, with a walking update on Thursdays — see `docs/services/PROSPECTOR.md`, *How each venue updates*.
   */
  recurs:  walkOn('thursday'),

  /**
   * How far behind today this venue is worth asking about.
   *
   * **Measured from the venue's own `Last-Modified`**, 2026-09-25 over the files
   * of 2026-09-15 to 21: p99 33.6 hours after the dated day begins, over 457,671 files.
   *
   * **Every venue publishes more than a day after its period begins**, so a pass
   * running in the small hours finds nothing for yesterday whatever the catalog's
   * newest file suggests — a snapshot taken in the afternoon says only that the
   * file had arrived by the afternoon.
   *
   * **A day further back again**, because a publishing hour that drifts later
   * would put the frontier in front of the archive. Asking early costs a probe
   * per series per night, every night, for a period that cannot exist yet; asking
   * late costs the catalog's edge a day, and loses nothing — the frontier
   * advances daily and the patience window covers what it has not reached.
   */
  probingLag: 3,

  /**
   * What is in the bucket but is not archive.
   *
   * - `data2/` is a staging area: loose `.csv` beside its own `.zip` for the
   *   same period, a `.DS_Store`, everything dated late 2020.
   * - A key sitting **directly** under `data3/` is stray; only its
   *   subdirectories hold data.
   * - **A key beginning with `/`** is binance's `/data/spot/` tree: a second,
   *   abandoned copy of the monthly spot archive under a key that genuinely
   *   starts with a slash, carrying no grain segment. Every file in it is the
   *   same file as one under `data/spot/monthly/`, so cataloguing it doubles
   *   137,212 keys and 86.7 GB for nothing. Binance stopped writing it rather
   *   than deleting it.
   *
   * The browsing UI's own assets need no rule — `index.html` and friends carry
   * no date, so `dateOf` already declines them.
   *
   * **And the `1w`, `3d` and `1mo` intervals, which are an abandoned
   * experiment.** Binance offers them on every interval dataset — klines,
   * markPrice, indexPrice, premiumIndex — and publishes them nowhere reliably:
   * the futures daily trees stop in June 2023 and then emit a single 334-byte
   * file in July 2026, and spot's monthly tree runs months behind and ends on a
   * different date for each symbol and each interval.
   *
   * **Nothing is lost, because every one of them is an aggregate of the `1m`
   * variant of the same dataset**, which binance does publish completely and
   * this catalog holds — spot even has `1s`. `3d` is not even a calendar
   * period: it is a stride from an arbitrary epoch, so it cannot be re-cut to
   * anything else either. Refusing them costs 51 patterns and 22,155 series
   * whose only effect was to be probed nightly and answer nothing.
   */
  accepts: (path) =>
    ! /^\//.test(path) && ! /^data2\//.test(path) && ! /^data3\/[^/]+$/.test(path)
    && ! /\/(?:1w|3d|1mo)\//.test(path),

  /** What this venue lists today — its only discovery. */
  instruments: binanceInstruments,

  /**
   * Which futures service writes to this pattern's tree.
   *
   * **The margin segment, read straight off the path.** `futures/um` is what
   * `fapi` publishes and `futures/cm` is what `dapi` publishes, and the
   * instrument listing records which of the two named a contract — so pairing
   * the two keeps a USDⓈ-margined contract out of the coin-margined tree without
   * anything having to be inferred from its symbol.
   *
   * **Null everywhere else**, spot and options included: those are one archive
   * each, so every pattern of them serves whatever the venue listed.
   *
   * `data3/` is null too, deliberately. It holds liquidation snapshots for
   * perpetuals of both services under one tree, so it is not a keyspace either
   * domicile owns.
   */
  categoryOf: (pattern) => /(?:^|\/)data\/futures\/(um|cm)\//.exec(pattern)?.[1] ?? null,

  /** Reading this venue's paths back into series — see `paths.ts`. */
  inspectUrl: (path) => inspect(path),

  /**
   * Two shapes, and each keeps the grain it was published with: a monthly file
   * is `YYYYMM`, not the first day of that month, which it is not and may hold
   * nothing for. A month sorts among its own days because it is their prefix.
   *
   * `.CHECKSUM` sidecars match neither pattern and so are never catalogued.
   * They are half of every page binance serves and fully derivable from the
   * key, so dropping them halves the catalog for a query nobody makes.
   */
  dateOf: (path) => {
    const daily = /(\d{4})-(\d{2})-(\d{2})\.zip$/.exec(path);

    if (daily) return `${daily[1]}${daily[2]}${daily[3]}`;

    const monthly = /(\d{4})-(\d{2})\.zip$/.exec(path);

    return monthly ? `${monthly[1]}${monthly[2]}` : null;
  },

});

// ── Internals ─────────────────────────────────────────────────────────────────

/**
 * Binance: `data/<market>/<grain>/<dataset>/<SYMBOL>/[<interval>/]<file>`.
 *
 * Two irregularities the tree actually has, both of them documented in
 * `docs/venues/BINANCE.md`:
 *
 * - **futures carries a margin segment** — `futures/um/` and `futures/cm/` — so
 *   the market is two segments there and one everywhere else;
 * - **`data3/`** holds liquidation snapshots for symbols absent from `data/`.
 *
 * A third, `/data/spot/…` with a leading slash and no grain, never arrives here
 * at all: it duplicates the monthly tree and `accepts` refuses it. The grain
 * segment stays optional below only so that a path from it still reads rather
 * than throwing, which is what a refusal wants — the refusal itself is the rule
 * that keeps it out.
 *
 * The interval, where there is one, stays literal in the pattern: a different
 * interval is a different series, and it is not a date.
 */
const inspect = (path: string): Inspection => {
  const main = BINANCE.exec(path);

  if (main) {
    const { market, margin, dataset, interval, symbol, date } = main.groups!;

    const own = margin ? `${market}-${margin}` : market!;

    const canonical = canonicalise(MARKET_OF[own], dataset!, interval, symbol!);

    return canonical
      ? asSeries(path, { ...canonical, symbol: symbol!, date: date! })
      : { of: 'unknown', date: null };
  }

  /**
   * `data3/` has **no market segment at all** — it is a side tree holding
   * liquidation snapshots for symbols the main one does not carry, so nothing is
   * passed for the market and the symbol has to answer for it.
   */
  const side = BINANCE_SIDE.exec(path);

  if (side) {
    const { dataset, symbol, date } = side.groups!;

    const canonical = canonicalise(undefined, dataset!, undefined, symbol!);

    return canonical
      ? asSeries(path, { ...canonical, symbol: symbol!, date: date! })
      : { of: 'unknown', date: null };
  }

  return { of: 'unknown', date: null };
};

/**
 * Binance's own words for a market, in the catalog's.
 *
 * **`um` and `cm` are one market.** Both are perpetual swaps; they differ in
 * what collateralises them, which is a property of the instrument and legible
 * from its symbol.
 */
const MARKET_OF: Record<string, string> = {
  spot:          'spot',
  option:        'option',
  'futures-um':  'perp',
  'futures-cm':  'perp',
};

/** Binance's own words for a dataset, in the catalog's. */
const MEANINGS: Record<string, { dataset: string; variant?: string; binned?: true }> = {
  /**
   * **Binance publishes trades twice**, raw and aggregated, so here — and only
   * where a venue says so itself — the raw one is named. Everywhere else the
   * catalog holds no opinion about aggregation, because nothing in those
   * archives states one.
   */
  trades:             { dataset: 'trades', variant: 'default' },
  aggTrades:          { dataset: 'trades', variant: 'aggregated' },

  klines:             { dataset: 'klines',       binned: true },
  markPriceKlines:    { dataset: 'markPrice',    binned: true },
  indexPriceKlines:   { dataset: 'indexPrice',   binned: true },
  premiumIndexKlines: { dataset: 'premiumIndex', binned: true },

  fundingRate:        { dataset: 'funding', variant: 'realised' },
  bookTicker:         { dataset: 'quotes' },
  bookDepth:          { dataset: 'depthBands' },
  metrics:            { dataset: 'openInterest' },
  liquidationSnapshot:{ dataset: 'liquidations' },

  /** One index value a second, not bars. */
  BVOLIndex:          { dataset: 'volatilityIndex', variant: 'ticks' },

  /**
   * One row per contract per hour, carrying that hour's open, high, low, close,
   * greeks and open interest. The path names the underlying; the rows name the
   * contracts.
   */
  EOHSummary:         { dataset: 'optionSummary', variant: '1h' },
};

/**
 * A binance contract that expires: the venue appends the expiry to the pair.
 *
 * The only thing separating the two markets in `data3/`, which names none.
 */
const DATED = /_[0-9]{6}$/;

const canonicalise = (
  market:   string | undefined,
  dataset:  string,
  interval: string | undefined,
  symbol:   string,
): { market: string; dataset: string; variant?: string } | null => {
  const meaning = MEANINGS[dataset];

  if (! meaning) return null;

  /**
   * **`data3/` names no market, so the symbol is the only thing that does.** It
   * holds perpetuals and dated delivery contracts side by side, and reading the
   * market off each instrument is the only honest answer available.
   */
  const canonical = market ?? (DATED.test(symbol) ? 'future' : 'perp');

  if (! meaning.binned) {
    return { market: canonical, dataset: meaning.dataset,
      ...(meaning.variant ? { variant: meaning.variant } : {}) };
  }

  /** **A kline without an interval is not data**, so a missing one is a refusal. */
  const bar = interval ? canonicalInterval(interval) : null;

  return bar ? { market: canonical, dataset: meaning.dataset, variant: bar } : null;
};

const BINANCE = new RegExp(
  '^/?data/(?<market>spot|option|futures)(?:/(?<margin>um|cm))?'
  + '(?:/(?:daily|monthly))?/(?<dataset>[A-Za-z]+)'
  + '/(?<symbol>[^/]+)(?:/(?<interval>[^/]+))?'
  + '/[^/]*(?<date>\\d{4}-\\d{2}(?:-\\d{2})?)\\.[a-z.]+$');

const BINANCE_SIDE = new RegExp(
  '^/?data3/(?<dataset>[A-Za-z]+)/(?<symbol>[^/]+)(?:/(?<interval>[^/]+))?'
  + '/[^/]*(?<date>\\d{4}-\\d{2}(?:-\\d{2})?)\\.[a-z.]+$');
