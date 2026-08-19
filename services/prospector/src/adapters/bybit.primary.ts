import { asSeries } from '../paths';
import { canonicalInterval } from '../canonical';
import { s3 } from '../scanners/s3';
import { listing } from '../context';
import type { Adapter, Inspection } from '../types';
import { bybitInstruments } from './bybit/instruments';
import { declare } from './declare';

/**
 * Bybit's archive is a standard S3 bucket, surveyed at its **origin** rather
 * than through the CDN in front of it.
 *
 * `public.bybit.com` is CloudFront, and CloudFront answers no listing API at
 * all: every query parameter is ignored, `?prefix=` returns the same browsable
 * HTML index as `/`, and the index names files while saying nothing about them.
 * It also bans an address that asks too fast — with an HTML error page naming no
 * key, and no budget stated in any header.
 *
 * The bucket behind it is publicly listable, and answers the ordinary listing
 * API with `prefix`, `delimiter`, `max-keys` and `marker` all honoured. Three
 * things follow, and together they are why the origin is the address used here:
 *
 * - **Listings carry metadata.** Size, last-modified and a real md5 ETag arrive
 *   with every key, which is why `probes` is false below.
 * - **A listing is a slice of the keyspace**, so a partition is a marker walked
 *   in a straight line rather than a tree traversal, and the shared `s3` scanner
 *   serves it with no dialect of its own.
 * - **The block is a property of the edge, not of the bucket.** Both have been
 *   observed at the same instant: CloudFront refusing every request from this
 *   address while the origin answered normally.
 *
 * The path-style URL is deliberate. `public.bybit.com.s3-ap-southeast-1.
 * amazonaws.com` puts the bucket's own dots in the hostname, where the wildcard
 * certificate does not reach and TLS fails outright; addressing the bucket as a
 * path keeps the hostname clean.
 *
 * Eight trees, and descent finds all of them without any being named here:
 *
 * ```
 * trading/<SYMBOL>/<SYMBOL><yyyy-mm-dd>.csv.gz              derivatives trades
 * spot/<SYMBOL>/<SYMBOL>-<yyyy-mm>.csv.gz                   spot, monthly
 *                <SYMBOL>_<yyyy-mm-dd>.csv.gz               spot, daily
 * premium_index/<SYMBOL>/<SYMBOL><date>_premium_index.csv.gz
 * spot_index/<SYMBOL>/<SYMBOL><date>_index_price.csv.gz
 * kline_for_metatrader4/<SYMBOL>/<year>/<SYMBOL>_<interval>_<from>_<to>.csv.gz
 * trade/option/<UNDERLYING>/<date>_<UNDERLYING>_USDT.trades.csv.zip
 * mark_kline/option/<UNDERLYING>/<date>_<UNDERLYING>_USDT.OHLC.csv.zip
 * ```
 *
 * The last two are options, and the HTML index exposes neither — they are
 * reachable and promised to nobody, which is a reason to take them sooner rather
 * than to skip them.
 *
 * The one known bad file, `trading/DOTUSD/DOTUSDT2021-12-06.csv.gz`, is a
 * truncated duplicate of a file served correctly under `trading/DOTUSDT/`. It is
 * a single misfiled artifact rather than a pattern, so it belongs in the
 * `exclusion` table rather than in code here.
 */
export const bybitPrimary: Adapter = declare({
  /** The shared listing context — this venue differs by address, not by shape. */
  getContext: async () => listing(bybitPrimary),

  name:    'bybit',
  host:    'primary',
  scanner: s3,
  list:    'https://s3.ap-southeast-1.amazonaws.com/public.bybit.com',

  /**
   * What is in the bucket but is not archive.
   *
   * - `backup/` is a copy: one symbol's `trading/` files, served correctly under
   *   `trading/` as well.
   * - A key with no `/` in it sits at the bucket root, which serves the browsing
   *   UI rather than the archive. A directory can never match, since every
   *   prefix carries a trailing slash.
   * - **The four 2021 expiries** — `BTCUSDU21`, `BTCUSDZ21`, `ETHUSDU21`,
   *   `ETHUSDZ21` — are abandoned rather than archived, and nothing in them can
   *   be relied on. See `docs/venues/BYBIT.md`.
   */
  accepts: (path) => ! /^(?:backup\/|[^/]+$)/.test(path)
    && ! /^trading\/(?:BTC|ETH)USD[UZ]21\//.test(path),

  /**
   * **Nothing to probe.** A listing here states size, ETag and last-modified
   * for every key, so a HEAD would ask for what the listing already gave.
   */
  probes:  false,

  /**
   * **This venue bans an address that asks too fast**, and the address does not
   * change. Its API documents 600 requests per 5 seconds per IP and answers
   * "403, access too frequent" past that, lifting on its own after about ten
   * minutes.
   *
   * That was measured here against the CDN: with the gate applied to every
   * caller and the cap at 50, CloudFront refused after 3,855 requests in about
   * 103 seconds, the block reporting 39 in the last second, 39 over five and 40
   * over ten. So the edge tolerates neither 50 nor a sustained 40.
   *
   * **Kept at 30 because none of that measures the origin**, which is a
   * different host with a different limiter — S3 asks for a slower pace with a
   * retryable 503 rather than turning an address away. If it refuses, the block
   * log states the rate at that moment; move this from that and from nothing
   * else.
   *
   * **The stand-down is bybit's own figure, not the default.** Its ban lifts on
   * its own after "at least 10 minutes" — its words — so coming back at the
   * shorter default would spend the whole wait re-earning it. Every other venue
   * here starts short because a refusal is usually an edge having a bad minute;
   * this one has told us how long its is.
   */
  pacing:  { perSecond: 30, concurrency: 20, standDownMs: 10 * 60_000 },

  /** What bybit lists today — see `bybit/instruments.ts`. */
  instruments: async (db) => bybitInstruments(db, 'primary'),

  /** Reading this venue's paths back into series — see `paths.ts`. */
  inspectUrl: (path) => inspect(path),

  /**
   * `{MONTH_LAST_DAY}` — the last day of the month being generated.
   *
   * `kline_for_metatrader4` names a whole month by both its ends,
   * `ADAUSDT_15_2021-01-01_2021-01-31.csv.gz`, and February is why it cannot be
   * a literal in the pattern. Nothing else on this venue, or any other here,
   * spells a period that way.
   */
  slotsFor: (at) => ({
    '{MONTH_LAST_DAY}': String(new Date(Date.UTC(+at.slice(0, 4), +at.slice(4, 6), 0)).getUTCDate())
      .padStart(2, '0'),
  }),

  /**
   * The date is wherever it falls in the name rather than at the end of it —
   * `premium_index` puts a suffix after it and MetaTrader klines put a second
   * date after the first — so the **first** date in the filename is the one
   * that counts, and a range is dated by where it starts.
   *
   * **A month is dated as a month.** A file covering all of November is
   * `202211`, not `20221101` — it is not a file for the 1st, and may hold
   * nothing for that day. Six characters sort correctly against that month's
   * eight-character days, because a month is their prefix.
   */
  dateOf: (path) => {
    const file = path.slice(path.lastIndexOf('/') + 1);

    const day = /(\d{4})-(\d{2})-(\d{2})/.exec(file);

    if (day) return `${day[1]}${day[2]}${day[3]}`;

    const month = /(\d{4})-(\d{2})(?!\d)/.exec(file);

    return month ? `${month[1]}${month[2]}` : null;
  },
});

// ── Internals ─────────────────────────────────────────────────────────────────

/**
 * Bybit, which is four shapes rather than one.
 *
 * The others put the instrument in a directory and repeat it in the filename
 * with a separator. Bybit does three different things:
 *
 * - **the instrument runs straight into the date** — `BTCUSD2019-10-01_…` — so
 *   there is no separator to anchor on and the directory name is what says where
 *   the instrument ends;
 * - **options are dated first** and keyed by the underlying coin:
 *   `trade/option/BTC/2026-08-03_BTC_USDT.trades.csv.zip`;
 * - **spot publishes both grains** under one directory, told apart by the
 *   separator — `-2026-08` monthly against `_2026-08-03` daily.
 *
 * - **`kline_for_metatrader4` names a range** rather than a date —
 *   `BTCUSDT_15_2020-01-01_2020-01-31.csv.gz`. Every one of the 4,423 files in
 *   the archive is a whole calendar month, five intervals, no exceptions, so it
 *   is an ordinary monthly series that happens to spell out its own last day —
 *   which is what `{MONTH_LAST_DAY}` renders.
 */
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

    /**
     * **A range that is not a whole month is not this series.** The venue has
     * never published one, and a pattern that assumed otherwise would generate
     * keys for months it would then report as missing.
     */
    if (+last! !== new Date(Date.UTC(+year!, +month!, 0)).getUTCDate()) return { of: 'unknown', date: null };

    return {
      of: 'series', date: `${year}${month}`,
      found: {
        market:  'spot',
        dataset: 'klines',

        /**
         * **Bybit's MetaTrader feed counts bare minutes** — `_15_` — and means
         * nothing else by the number. Every other venue writes a unit.
         */
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
 * `premium_index/BTCUSD/BTCUSD2019-10-01_premium_index.csv.gz` — no separator at
 * all, so the date is what says where the instrument ends.
 *
 * **An instrument name is letters, digits, dashes and underscores** — bybit
 * lists match-outcome markets like `WC_ARG_ALG_USDT-17JUN26` — so its own
 * punctuation says nothing about where it ends. The date does.
 *
 * **The directory is not required to agree with the filename**, because at least
 * once it does not: bybit renamed `DATAUSDT` to `DATAOLD01USDT`, moved the
 * directory and left every filename as it was — 527 files across eighteen
 * months, and there is no `trading/DATAUSDT/` at all. Anchoring on the date
 * rather than on the directory repeating itself reads them, and the directory
 * stays literal in the pattern, which is what the URL needs.
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

/**
 * Which market a bybit dataset belongs to.
 *
 * `trading` is the perpetual trade tape and `premium_index` its funding input,
 * so both are linear; `spot_index` is spot's. The venue does not put a market in
 * the path, so this is the one place its own arrangement has to be written down.
 */
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

/**
 * Bybit's own words for a market, in the catalog's.
 *
 * `linear` and `inverse` are both perpetual swaps, differing in what settles
 * them — a property of the instrument rather than of the market.
 */
const MARKET_OF: Record<string, string> = {
  spot:    'spot',
  linear:  'perp',
  inverse: 'perp',
  option:  'option',
};

/**
 * Bybit's own words for a dataset, in the catalog's.
 *
 * **The three index series are minute bars, and they say so.** Each carries a
 * `period` column reading `1` and its rows are a measured 60 seconds apart —
 * 1,440 a day, checked across twelve files of each — so the length is stated by
 * the data rather than declared from outside it. Option mark bars are the same,
 * measured at a uniform 60,000 ms between `open_time` values.
 */
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
