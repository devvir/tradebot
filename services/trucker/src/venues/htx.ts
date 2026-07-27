import { after, listNested, s3List } from './listing';
import { dashed } from '../dates';
import type { ArchiveFile, Dataset } from '../types';
import type { VenueArchive } from './types';

const HOST = 'https://www.htx.com';
const LIST = `${HOST}/data/`;

/**
 * HTX publishes bucket `huobi-service-data`, listable through
 * `www.htx.com/data/?prefix=…`. The `/vision/` page is only a browser UI over
 * it — the same s3-bucket-listing script KuCoin uses — which is why probing
 * hostnames like `futures.huobi.com/data` found nothing.
 *
 * Note the listing endpoint 301s without its trailing slash.
 *
 * Beyond trades and klines it also publishes `funding-rates`, `index-klines`,
 * `mark-klines` and **`orderbook`** for futures, and `orderbook` for spot —
 * none collected yet, but they are there.
 */
export const htx: VenueArchive = {
  name: 'htx',

  /**
   * **HTX's archive is a rolling window, not a growing one.** Listing
   * `historical_data/spot/daily/trades/BTC-USDT/` returns
   * `BTC-USDT-trades-2026-02-01.zip` as its oldest key, and the oldest date
   * across 3,119 recorded symbol ranges is the same `20260201` — roughly six
   * months deep, on a venue trading since 2013.
   *
   * So this floor is the one here that **moves**, and it moves forward: what
   * HTX served last year is gone. The value drifts too early rather than too
   * late, which costs empty months and never data, and the published tip is
   * what actually bounds the walk in practice.
   *
   * HTX data is therefore perishable — see `docs/venues/HTX.md`.
   */
  floor: '202602',

  // `historical_data/{market}/` contains only `daily/` — no monthly shape, so
  // the cutover never applies.
  //
  // The book is the richest published anywhere bar OKX: **400 levels on spot,
  // 150 on futures**, shipped as `.tar.gz` rather than the `.zip` everything
  // else here uses. Its records carry the same `instId`/`action`/`ts` shape as
  // OKX's, which is why both venues' portals look alike.
  datasets: [
    { id: 'spot-trades',    kind: 'trades', market: 'spot',    path: 'trades' },
    { id: 'futures-trades', kind: 'trades', market: 'futures', path: 'trades' },
    { id: 'spot-klines',    kind: 'klines', market: 'spot',    path: 'klines' },
    { id: 'futures-klines', kind: 'klines', market: 'futures', path: 'klines' },

    { id: 'futures-fundingRates', kind: 'funding', market: 'futures', path: 'funding-rates' },
    { id: 'futures-indexKlines',  kind: 'index',   market: 'futures', path: 'index-klines'  },
    { id: 'futures-markKlines',   kind: 'mark',    market: 'futures', path: 'mark-klines'   },

    { id: 'spot-orderbook',    kind: 'book', market: 'spot',    path: 'orderbook/lv400' },
    { id: 'futures-orderbook', kind: 'book', market: 'futures', path: 'orderbook/lv150' },
  ],

  symbols: async (dataset) => {
    const { prefixes } = await s3List(LIST, prefixOf(dataset), true);

    return prefixes.map(p => p.split('/').filter(Boolean).pop()!).sort();
  },

  files: async (dataset, symbol, since) => {
    const prefix = `${prefixOf(dataset)}${symbol}/`;

    // The cursor becomes the S3 marker, so a settled symbol costs one page
    // instead of a walk over its whole history. Klines nest an interval below
    // the symbol and carry the series stem as well —
    // `BTC-USDT-klines-1h-2026-02-01.zip` — so each interval is marked in its
    // own right rather than the symbol as a whole.
    const keys = nested(dataset)
      // The nested stems were not read off a live listing, so each interval is
      // listed whole rather than marked from a guessed filename. One directory
      // beats the whole symbol either way, and HTX keeps only ~6 months.
      ? await listNested(LIST, prefix, () => null, since)
      : (await s3List(LIST, prefix, false, since && STEMS[dataset.id]
        ? `${prefix}${symbol}-${STEMS[dataset.id]}-${dashed(since)}`
        : undefined)).keys;

    const files = keys
      // Books ship as `.tar.gz`, everything else as `.zip`.
      .filter(k => k.endsWith('.zip') || k.endsWith('.tar.gz'))
      .map<ArchiveFile>(key => ({
        url:    `${HOST}/data/${key}`,
        path:   strip(key),
        date:   dateOf(key),
        symbol,
        period: 'daily',
      }))
      .filter(f => f.date !== '');

    return after(files, since);
  },
};

// ── Internals ─────────────────────────────────────────────────────────────────

/**
 * The filename stem between the symbol and the date, for the datasets whose
 * files sit directly under the symbol. It is not derivable from the path —
 * `funding-rates/` holds `{sym}-fundingRates-…`, `orderbook/lv400/` holds
 * `{sym}-l2orderbook-400lv-…` — so each was read off a live listing.
 *
 * The kline families are missing deliberately: they nest an interval directory
 * below the symbol (`…/BTC-USDT/15m/…`), where a symbol-level marker would sort
 * past the interval directories and skip them all — the same trap Binance's
 * nested datasets have. They are listed unmarked instead.
 */
const STEMS: Record<string, string> = {
  'spot-trades':          'trades',
  'futures-trades':       'trades',
  'futures-fundingRates': 'fundingRates',
  'spot-orderbook':       'l2orderbook-400lv',
  'futures-orderbook':    'l2orderbook-150lv',
};

const prefixOf = (dataset: Dataset): string =>
  `historical_data/${dataset.market}/daily/${dataset.path}/`;

/** Whether the series puts an interval directory between the symbol and its files. */
const nested = (dataset: Dataset): boolean =>
  dataset.kind === 'klines' || dataset.kind === 'index' || dataset.kind === 'mark';

/** `historical_data/` is the bucket's own wrapper, not a level that means anything. */
const strip = (key: string): string => key.replace(/^historical_data\//, '');

const dateOf = (key: string): string => {
  const m = key.match(/(\d{4})-(\d{2})-(\d{2})\.(?:zip|tar\.gz)$/);

  return m ? `${m[1]}${m[2]}${m[3]}` : '';
};
