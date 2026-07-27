import { after, listNested, s3List } from './listing';
import { DAILY_FROM, atCutover } from './granularity';
import { dashed } from '../dates';
import type { ArchiveFile, Dataset, Period } from '../types';
import type { VenueArchive } from './types';

const HOST   = 'https://data.binance.vision';
const BUCKET = 'https://s3-ap-northeast-1.amazonaws.com/data.binance.vision';

/**
 * Binance publishes the largest archive of any venue and the only one with a
 * `.CHECKSUM` beside every file. Fully enumerable through the S3 API.
 *
 * Only `trades` is collected, not `aggTrades`. The aggregated form was verified
 * to be exactly reconstructible from the raw fills — on an ADAUSDT day, every one
 * of 113,501 futures aggregates rebuilt from the published id range with matching
 * quantity, price and side, and every trade fell inside exactly one aggregate.
 * Its timestamp is the **first** fill of the range on futures, the last on spot.
 * `trades` also starts earlier (um BTCUSDT 2019-09 against aggTrades 2020-01) and
 * covers the same symbol set, so aggTrades can add nothing.
 */
export const binance: VenueArchive = {
  name: 'binance',

  checksums: true,

  /**
   * The oldest listed file across every symbol of every dataset is
   * `2017-07-31` — spot klines for `BCCBTC`, `BNBBTC` and `BNTETH`, days after
   * binance opened. Read from the listings themselves, over 6,418 recorded
   * symbol ranges, not from a claim about when the exchange started.
   */
  floor: '201707',

  /**
   * Which of these publish months as well as days is read from the listing, not
   * declared — `fundingRate` is monthly-only, `metrics`, `bookDepth` and
   * `liquidationSnapshot` are daily-only, and the rest publish both.
   *
   * The monthly kline intervals are a superset of the daily ones — `1mo`, `1w`
   * and `3d` exist only monthly — so taking months before the cutover loses
   * nothing and gains three series.
   */
  datasets: [
    { id: 'spot-trades',    kind: 'trades', market: 'spot',       path: 'trades'    },
    { id: 'um-trades',      kind: 'trades', market: 'futures/um', path: 'trades'    },
    { id: 'cm-trades',      kind: 'trades', market: 'futures/cm', path: 'trades'    },

    // Klines nest an interval below the symbol (`…/BTCUSDT/12h/…`). Listing the
    // symbol prefix without a delimiter returns every interval at once, so all
    // of them are collected without enumerating intervals. The same nesting
    // applies to the mark/index/premium kline variants.
    { id: 'spot-klines',    kind: 'klines', market: 'spot',       path: 'klines' },
    { id: 'um-klines',      kind: 'klines', market: 'futures/um', path: 'klines' },
    { id: 'cm-klines',      kind: 'klines', market: 'futures/cm', path: 'klines' },

    { id: 'um-markPriceKlines',    kind: 'mark',  market: 'futures/um', path: 'markPriceKlines'    },
    { id: 'um-indexPriceKlines',   kind: 'index', market: 'futures/um', path: 'indexPriceKlines'   },
    { id: 'um-premiumIndexKlines', kind: 'index', market: 'futures/um', path: 'premiumIndexKlines' },
    { id: 'cm-markPriceKlines',    kind: 'mark',  market: 'futures/cm', path: 'markPriceKlines'    },
    { id: 'cm-indexPriceKlines',   kind: 'index', market: 'futures/cm', path: 'indexPriceKlines'   },
    { id: 'cm-premiumIndexKlines', kind: 'index', market: 'futures/cm', path: 'premiumIndexKlines' },

    // `bookTicker` is best bid/ask over time; `bookDepth` is notional at ±%
    // bands around the mid, which is a depth summary and **not** an order book.
    { id: 'um-bookTicker', kind: 'book', market: 'futures/um', path: 'bookTicker' },
    { id: 'cm-bookTicker', kind: 'book', market: 'futures/cm', path: 'bookTicker' },
    { id: 'um-bookDepth',  kind: 'book', market: 'futures/um', path: 'bookDepth'  },
    { id: 'cm-bookDepth',  kind: 'book', market: 'futures/cm', path: 'bookDepth'  },

    { id: 'um-fundingRate', kind: 'funding', market: 'futures/um', path: 'fundingRate' },
    { id: 'cm-fundingRate', kind: 'funding', market: 'futures/cm', path: 'fundingRate' },

    // Open interest and the long/short ratios, sampled every 5 minutes.
    { id: 'um-metrics', kind: 'metrics', market: 'futures/um', path: 'metrics' },
    { id: 'cm-metrics', kind: 'metrics', market: 'futures/cm', path: 'metrics' },

    { id: 'cm-liquidationSnapshot', kind: 'liquidations', market: 'futures/cm',
      path: 'liquidationSnapshot' },

  ],

  /**
   * Both prefixes are listed and the results unioned: the bulk of the history is
   * taken monthly, so a symbol that appears only under `monthly/` would
   * otherwise never be discovered at all.
   */
  symbols: async (dataset) => {
    const listed = await Promise.all(
      (['monthly', 'daily'] as const)
        .map(period => s3List(BUCKET, prefixOf(dataset, period), true)),
    );

    const names = listed.flatMap(({ prefixes }) =>
      prefixes.map(p => p.split('/').filter(Boolean).pop()!));

    return [...new Set(names)].sort();
  },

  /**
   * Every dataset here is published at both periods, for the whole history —
   * verified back to `BTCUSDT-trades-2017-08`, the first file of either shape.
   *
   * Both listings are avoided wherever the cursor makes them pointless. Once it
   * is past the cutover every monthly file is older than it and would be
   * discarded by `after()`, so that prefix is not listed at all; and the daily
   * listing starts at the cursor rather than at 2017. Discovering that a
   * settled symbol has nothing new drops from about five requests to one, which
   * matters at ~2.8 s per request across 3,680 symbols.
   */
  files: async (dataset, symbol, since) => {
    const periods = since && since >= DAILY_FROM
      ? (['daily'] as const)
      : (['monthly', 'daily'] as const);

    const listed = await Promise.all(
      periods.map(period => list(dataset, symbol, period, since)),
    );

    return after(atCutover(listed.flat()), since);
  },
};

// ── Internals ─────────────────────────────────────────────────────────────────

/**
 * Drop the bucket's `data/` wrapper from the stored path. It is part of how the
 * bucket is addressed, not a meaningful level of organisation — every key lives
 * under it — so the local tree starts at the first segment that means something.
 */
const strip = (key: string): string => key.replace(/^data\//, '');

/**
 * `since` becomes the S3 marker for the daily prefix: keys sort lexicographically
 * and the filenames carry ISO dates, so a cursor of `20260727` skips everything
 * before `…-2026-07-27`.
 *
 * Two shapes must not be marked. Monthly keys carry no day, so a day-granular
 * marker cannot be built for them. And the kline family nests an interval
 * directory under the symbol (`…/BTCUSDT/1m/BTCUSDT-1m-…`), where a marker
 * built from the symbol would sort *after* every interval directory and skip
 * the lot — `1m/` begins with a digit and sorts below `BTCUSDT-…`.
 */
const list = async (
  dataset: Dataset,
  symbol:  string,
  period:  Period,
  since?:  string | null,
): Promise<ArchiveFile[]> => {
  const prefix = `${prefixOf(dataset, period)}${symbol}/`;

  // The kline family keeps its files under an interval directory, so each
  // interval is listed and marked in its own right — see `listNested`. Monthly
  // keys carry no day and cannot be marked at all.
  const keys = nested(dataset) && period === 'daily'
    ? await listNested(BUCKET, prefix, interval => `${symbol}-${interval}-`, since)
    : (await s3List(BUCKET, prefix, false,
      period === 'daily' && since
        ? `${prefix}${symbol}-${dataset.path}-${dashed(since)}`
        : undefined)).keys;

  return keys
    .filter(k => k.endsWith('.zip'))
    .map<ArchiveFile>(key => ({
      url:         `${HOST}/${key}`,
      path:        strip(key),
      date:        dateOf(key),
      symbol,
      checksumUrl: `${HOST}/${key}.CHECKSUM`,
      period,
    }))
    .filter(f => f.date !== '');
};

/**
 * Whether the series puts an interval directory between the symbol and its
 * files. Klines and the mark/index/premium kline variants do; everything else
 * sits directly under the symbol.
 */
const nested = (dataset: Dataset): boolean =>
  dataset.kind === 'klines' || dataset.kind === 'mark' || dataset.kind === 'index';

/** `spot-aggTrades` → `data/spot/daily/aggTrades/`. */
const prefixOf = (dataset: Dataset, period: Period): string =>
  `data/${dataset.market}/${period}/${dataset.path}/`;

/** `…-2026-07-24.zip` → `20260724`; `…-2026-07.zip` → `202607`. */
const dateOf = (key: string): string => {
  const daily = key.match(/(\d{4})-(\d{2})-(\d{2})\.zip$/);

  if (daily) return `${daily[1]}${daily[2]}${daily[3]}`;

  const monthly = key.match(/(\d{4})-(\d{2})\.zip$/);

  return monthly ? `${monthly[1]}${monthly[2]}` : '';
};

// ── Test access ───────────────────────────────────────────────────────────────

export const _test_prefixOf = prefixOf;
export const _test_dateOf   = dateOf;
