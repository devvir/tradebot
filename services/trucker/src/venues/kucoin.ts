import { after, listNested, s3List } from './listing';
import { dashed } from '../dates';
import type { ArchiveFile, Dataset } from '../types';
import type { VenueArchive } from './types';

const HOST = 'https://historical-data.kucoin.com';

/**
 * KuCoin's bucket (`k-line-history-data`) is listable through the website host
 * with S3 query parameters, and ships `.CHECKSUM` companions like Binance.
 *
 * Symbol naming differs per market — `BTCUSDT` on spot, `BTCUSDTM` on futures,
 * `XBTMH25` for dated contracts — so symbols are always read from the listing.
 */
export const kucoin: VenueArchive = {
  name: 'kucoin',

  checksums: true,

  /**
   * KuCoin publishes nothing before **2022-12**: the oldest key across 10,464
   * enumerated symbols is `20221231`, on the futures mark series. This is the
   * venue that first showed why the inventory is needed — a run bounded below
   * it listed all 2,397 symbols of every dataset and discarded every file.
   */
  floor: '202212',

  // `data/{market}/` contains only `daily/` — no monthly shape exists, so the
  // cutover never applies and days are taken for the whole history.
  //
  // `index` and `mark` nest an interval below the symbol like klines do, so a
  // non-delimited listing picks up every interval at once.
  datasets: [
    { id: 'spot-trades',    kind: 'trades',  market: 'spot',    path: 'trades' },
    { id: 'futures-trades', kind: 'trades',  market: 'futures', path: 'trades' },
    { id: 'spot-klines',    kind: 'klines',  market: 'spot',    path: 'klines' },
    { id: 'futures-klines', kind: 'klines',  market: 'futures', path: 'klines' },

    { id: 'futures-fundingRates', kind: 'funding', market: 'futures', path: 'fundingRates' },
    { id: 'futures-index',        kind: 'index',   market: 'futures', path: 'index'        },
    { id: 'futures-mark',         kind: 'mark',    market: 'futures', path: 'mark'         },

    // 50 levels, one of the few real order-book archives published anywhere.
    { id: 'spot-orderbooklv50',    kind: 'book', market: 'spot',    path: 'depth/orderbooklv50' },
    { id: 'futures-orderbooklv50', kind: 'book', market: 'futures', path: 'depth/orderbooklv50' },
  ],

  symbols: async (dataset) => {
    const { prefixes } = await s3List(HOST, prefixOf(dataset), true);

    return prefixes.map(p => p.split('/').filter(Boolean).pop()!).sort();
  },

  files: async (dataset, symbol, since) => {
    const prefix = `${prefixOf(dataset)}${symbol}/`;

    // The cursor becomes the S3 marker, so a settled symbol costs one page
    // instead of a walk over its whole history. Filenames are
    // `{symbol}-{last path segment}-yyyy-mm-dd.zip` — verified on trades,
    // fundingRates and orderbooklv50 listings. The nested datasets put an
    // interval directory below the symbol and are marked one interval at a
    // time, since a symbol-level marker sorts past those directories.
    const keys = nested(dataset)
      ? await listNested(HOST, prefix, interval =>
        // Verified on spot klines; the index and mark families were not read
        // off a listing, so they are listed per interval without a marker.
        (dataset.kind === 'klines' ? `${symbol}-${interval}-` : null), since)
      : (await s3List(HOST, prefix, false, since
        ? `${prefix}${symbol}-${stemOf(dataset)}-${dashed(since)}`
        : undefined)).keys;

    const files = keys
      .filter(k => k.endsWith('.zip'))
      .map<ArchiveFile>(key => ({
        url:         `${HOST}/${key}`,
        path:        strip(key),
        date:        dateOf(key),
        symbol,
        checksumUrl: `${HOST}/${key}.CHECKSUM`,
        period:      'daily',
      }))
      .filter(f => f.date !== '');

    return after(files, since);
  },
};

// ── Internals ─────────────────────────────────────────────────────────────────

/**
 * Drop the bucket's `data/` wrapper from the stored path. It is part of how the
 * bucket is addressed, not a meaningful level of organisation — every key lives
 * under it — so the local tree starts at the first segment that means something.
 */
const strip = (key: string): string => key.replace(/^data\//, '');

const prefixOf = (dataset: Dataset): string =>
  `data/${dataset.market}/daily/${dataset.path}/`;

/** Whether the series puts an interval directory between the symbol and its files. */
const nested = (dataset: Dataset): boolean =>
  dataset.kind === 'klines' || dataset.kind === 'index' || dataset.kind === 'mark';

/** The filename stem is the last path segment — `depth/orderbooklv50` → `orderbooklv50`. */
const stemOf = (dataset: Dataset): string => dataset.path.split('/').pop()!;

const dateOf = (key: string): string => {
  const m = key.match(/(\d{4})-(\d{2})-(\d{2})\.zip$/);

  return m ? `${m[1]}${m[2]}${m[3]}` : '';
};
