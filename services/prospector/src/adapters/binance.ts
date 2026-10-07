import { asSeries } from '../paths';
import { canonicalInterval } from '../canonical';
import { s3 } from '../scanners/s3';
import { listing } from '../context';
import type { Adapter, Inspection } from '../types';
import { binanceInstruments } from './binance/instruments';
import { declare } from './declare';

/**
 * Binance's archive: a standard listing, with the files served from a CDN in
 * front of the same bucket. The venue is described in `docs/venues/BINANCE.md`.
 */
export const binance: Adapter = declare({
  /** The shared listing context — this venue differs by address, not by shape. */
  getContext: async () => listing(binance),

  name:    'binance',
  scanner: s3,

  /** No limit was found — measured in `docs/venues/BINANCE.md`. */
  pacing:  { perSecond: 2000, concurrency: 500 },

  /** Days behind today a probing pass stops asking: the venue's measured publishing delay, and a day more. */
  probingLag: 3,

  /**
   * Not archive: `data2/`, keys directly under `data3/`, the tree whose keys begin
   * with `/`, and the `1w`, `3d` and `1mo` intervals.
   */
  accepts: (path) =>
    ! /^\//.test(path) && ! /^data2\//.test(path) && ! /^data3\/[^/]+$/.test(path)
    && ! /\/(?:1w|3d|1mo)\//.test(path),

  /** What this venue lists today — its only discovery. */
  instruments: binanceInstruments,

  /**
   * Which futures service writes a pattern's tree — `um` or `cm`, off the path —
   * and null where a tree is everyone's.
   */
  categoryOf: (pattern) => /(?:^|\/)data\/futures\/(um|cm)\//.exec(pattern)?.[1] ?? null,

  /** Reading this venue's paths back into series — see `paths.ts`. */
  inspectUrl: (path) => inspect(path),

  /** A day or a month, as the file is named; a month is dated as the month. */
  dateOf: (path) => {
    const daily = /(\d{4})-(\d{2})-(\d{2})\.zip$/.exec(path);

    if (daily) return `${daily[1]}${daily[2]}${daily[3]}`;

    const monthly = /(\d{4})-(\d{2})\.zip$/.exec(path);

    return monthly ? `${monthly[1]}${monthly[2]}` : null;
  },

});

// ── Internals ─────────────────────────────────────────────────────────────────

/** Read `data/<market>/[um|cm/]<grain>/<dataset>/<SYMBOL>/[<interval>/]<file>`, or the side tree `data3/`. */
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

  /** `data3/` names no market: the symbol answers for it. */
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

/** Binance's words for a market, in the catalog's: `um` and `cm` are both perpetual swaps. */
const MARKET_OF: Record<string, string> = {
  spot:          'spot',
  option:        'option',
  'futures-um':  'perp',
  'futures-cm':  'perp',
};

/** Binance's own words for a dataset, in the catalog's. */
const MEANINGS: Record<string, { dataset: string; variant?: string; binned?: true }> = {
  /** Every trade, and the same trades rolled up by order: the second is a variant of the first. */
  trades:             { dataset: 'trades' },
  aggTrades:          { dataset: 'trades', variant: 'aggregated' },

  klines:             { dataset: 'klines',       binned: true },
  markPriceKlines:    { dataset: 'markPrice',    binned: true },
  indexPriceKlines:   { dataset: 'indexPrice',   binned: true },
  premiumIndexKlines: { dataset: 'premiumIndex', binned: true },

  fundingRate:        { dataset: 'funding', variant: 'realised' },
  bookTicker:         { dataset: 'quotes' },
  bookDepth:          { dataset: 'books', variant: 'bands,5pct' },
  metrics:            { dataset: 'openInterest' },
  liquidationSnapshot:{ dataset: 'liquidations' },

  /** One index value a second, not bars. */
  BVOLIndex:          { dataset: 'volatilityIndex', variant: 'ticks' },

  /** One row a contract an hour; the path names the underlying, the rows the contracts. */
  EOHSummary:         { dataset: 'optionSummary', variant: '1h' },
};

/** A contract that expires: the venue appends the expiry to the pair. */
const DATED = /_[0-9]{6}$/;

const canonicalise = (
  market:   string | undefined,
  dataset:  string,
  interval: string | undefined,
  symbol:   string,
): { market: string; dataset: string; variant?: string } | null => {
  const meaning = MEANINGS[dataset];

  if (! meaning) return null;

  /** Where no market came with the path, a dated symbol is a future and any other a perpetual. */
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
