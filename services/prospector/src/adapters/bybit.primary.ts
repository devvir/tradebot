import { asSeries } from '../paths';
import { canonicalInterval } from '../canonical';
import { s3 } from '../scanners/s3';
import { listing } from '../context';
import type { Adapter, Inspection } from '../types';
import { bybitInstruments } from './bybit/instruments';
import { declare } from './declare';

/**
 * Bybit's archive, listed at the bucket behind its CDN — the CDN answers no
 * listing. The venue is described in `docs/venues/BYBIT.md`.
 */
export const bybitPrimary: Adapter = declare({
  /** The shared listing context — this venue differs by address, not by shape. */
  getContext: async () => listing(bybitPrimary),

  name:    'bybit',
  host:    'primary',
  scanner: s3,

  /** Not archive: the `backup/` copy, keys at the bucket root, and the four abandoned 2021 expiries. */
  accepts: (path) => ! /^(?:backup\/|[^/]+$)/.test(path)
    && ! /^trading\/(?:BTC|ETH)USD[UZ]21\//.test(path),

  /** A listing states size, ETag and last-modified, so there is nothing to probe. */
  probes:  false,

  /** No limit was found on this bucket — measured in `docs/venues/BYBIT.md`. */
  pacing:  { perSecond: 2000, concurrency: 500 },

  /** Days behind today a probing pass stops asking: the venue's measured publishing delay, and a day more. */
  probingLag: 3,

  /** What bybit lists today — see `bybit/instruments.ts`. */
  instruments: async (db) => bybitInstruments(db, 'primary'),

  /** Reading this venue's paths back into series — see `paths.ts`. */
  inspectUrl: (path) => inspect(path),

  /**
   * `{MONTH_LAST_DAY}`: MetaTrader klines name a month by both its ends, and
   * February is why the last is not a literal.
   */
  slotsFor: (at) => ({
    '{MONTH_LAST_DAY}': String(new Date(Date.UTC(+at.slice(0, 4), +at.slice(4, 6), 0)).getUTCDate())
      .padStart(2, '0'),
  }),

  /** The first date in the filename; a month with no day is dated as the month. */
  dateOf: (path) => {
    const file = path.slice(path.lastIndexOf('/') + 1);

    const day = /(\d{4})-(\d{2})-(\d{2})/.exec(file);

    if (day) return `${day[1]}${day[2]}${day[3]}`;

    const month = /(\d{4})-(\d{2})(?!\d)/.exec(file);

    return month ? `${month[1]}${month[2]}` : null;
  },
});

// ── Internals ─────────────────────────────────────────────────────────────────

/** Read a path as one of bybit's four shapes — see `docs/venues/BYBIT.md`. */
const inspect = (path: string): Inspection => {
  const option = BYBIT_OPTION.exec(path);

  if (option) {
    const { dataset, coin, date } = option.groups!;

    return read(path, 'option', dataset!, undefined, coin!, date!);
  }

  const joined = BYBIT_JOINED.exec(path);

  if (joined) {
    const { dataset, symbol, date } = joined.groups!;

    return read(path, marketOf(dataset!), dataset!, undefined, symbol!, date!);
  }

  const spot = BYBIT_SPOT.exec(path);

  if (spot) {
    const { symbol, date } = spot.groups!;

    return asSeries(path, { market: 'spot', dataset: 'trades', symbol: symbol!, date: date! });
  }

  const range = BYBIT_RANGE.exec(path);

  if (range) {
    const { symbol, interval, year, month, last } = range.groups!;

    /** A range that is not a whole month is not this series. */
    if (+last! !== new Date(Date.UTC(+year!, +month!, 0)).getUTCDate()) return { of: 'unknown', date: null };

    return {
      of: 'series', date: `${year}${month}`,
      found: {
        /** The path names no market: these are the perpetual's bars. */
        market:  'perp',
        dataset: 'klines',

        /** A bare number here is minutes. */
        variant: canonicalInterval(interval!) ?? interval!,
        symbol:  symbol!,
        pattern: `kline_for_metatrader4/${symbol}/{YYYY}/{SYMBOL}_${interval}`
          + '_{YYYY}-{MM}-01_{YYYY}-{MM}-{MONTH_LAST_DAY}.csv.gz',
      },
    };
  }

  return { of: 'unknown', date: null };
};

/** `trade/option/BTC/2026-08-03_BTC_USDT.trades.csv.zip` — dated first, keyed by coin. */
const BYBIT_OPTION = new RegExp(
  '^(?<dataset>trade|mark_kline)/option/(?<coin>[A-Za-z0-9_-]+)'
  + '/(?<date>\\d{4}-\\d{2}-\\d{2})_[^/]+\\.[a-z.]+$');

/**
 * `premium_index/BTCUSD/BTCUSD2019-10-01_premium_index.csv.gz` — no separator, so
 * the date says where the instrument ends. The directory need not repeat the
 * instrument: a renamed one does not.
 */
const BYBIT_JOINED = new RegExp(
  '^(?<dataset>premium_index|spot_index|trading)/[^/]+'
  + '/(?<symbol>[A-Za-z0-9_-]+?)(?<date>\\d{4}-\\d{2}-\\d{2})[^/]*\\.[a-z.]+$');

/** Both grains in one directory, told apart by the separator before the date. */
const BYBIT_SPOT = new RegExp(
  '^spot/(?<symbol>[^/]+)/\\k<symbol>[-_](?<date>\\d{4}-\\d{2}(?:-\\d{2})?)\\.[a-z.]+$');

/**
 * `kline_for_metatrader4/ADAUSDT/2021/ADAUSDT_15_2021-01-01_2021-01-31.csv.gz` —
 * a whole month, named by both its ends.
 */
const BYBIT_RANGE = new RegExp(
  '^kline_for_metatrader4/[^/]+/\\d{4}/(?<symbol>[A-Za-z0-9_-]+)_(?<interval>\\d+)'
  + '_(?<year>\\d{4})-(?<month>\\d{2})-01_\\k<year>-\\k<month>-(?<last>\\d{2})\\.csv\\.gz$');

/** Which market a dataset is: the path names none. */
const marketOf = (dataset: string): string =>
  (dataset === 'spot_index' ? 'spot' : 'linear');

const read = (
  path:     string,
  market:   string,
  dataset:  string,
  interval: string | undefined,
  symbol:   string,
  date:     string,
): Inspection => {
  const canonical = canonicalise(market, dataset, interval);

  return canonical ? asSeries(path, { ...canonical, symbol, date }) : { of: 'unknown', date: null };
};

/** Bybit's words for a market, in the catalog's. */
const MARKET_OF: Record<string, string> = {
  spot:    'spot',
  linear:  'perp',
  inverse: 'perp',
  option:  'option',
};

/** Bybit's words for a dataset, in the catalog's. The index and mark series are one-minute bars. */
const MEANINGS: Record<string, { dataset: string; variant?: string }> = {
  trading:       { dataset: 'trades' },
  trade:         { dataset: 'trades' },
  spot:          { dataset: 'trades' },
  premium_index: { dataset: 'premiumIndex', variant: '1m' },
  spot_index:    { dataset: 'indexPrice',   variant: '1m' },
  mark_kline:    { dataset: 'markPrice',    variant: '1m' },
};

const canonicalise = (
  market:   string,
  dataset:  string,
  interval: string | undefined,
): { market: string; dataset: string; variant?: string } | null => {
  const canonical = MARKET_OF[market];
  const meaning   = MEANINGS[dataset];

  if (! canonical || ! meaning) return null;

  const variant = interval ? canonicalInterval(interval) : meaning.variant;

  return { market: canonical, dataset: meaning.dataset,
    ...(variant ? { variant } : {}) };
};
