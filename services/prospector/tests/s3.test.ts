import { afterEach, describe, expect, it, vi } from 'vitest';
import { _test_reset, _test_seed } from '../src/exclusions';
import { fetchText } from '../src/http';
import {
  _test_accepted,
  _test_catalogable,
  _test_descend,
  _test_listingUrl,
  _test_parse,
} from '../src/scanners/s3';
import { binance } from '../src/adapters/binance';
import { htx } from '../src/adapters/htx';
import { kucoin } from '../src/adapters/kucoin';
import { listing } from '../src/context';
import type { Adapter } from '../src/types';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { addressVenues } from '../src/venues';
import { venues } from '../src/catalog';
import { openCatalog } from '../src/database';

/** What the core would hand the scanner: one venue's addresses and a paced fetcher. */
const context = listing(binance);

/**
 * Descent is the only thing here that talks to a venue, so the wire is stubbed —
 * and only the wire. `etagOf` is parsing rather than fetching, and stubbing it
 * would hide what these tests are checking.
 */
vi.mock('../src/http', async (importOriginal) => ({
  ...await importOriginal<typeof import('../src/http')>(),
  fetchText: vi.fn(),
}));

const page = (contents: string, extra = '') => `<?xml version="1.0" encoding="UTF-8"?>
<ListBucketResult><Name>b</Name><Prefix>data/</Prefix><MaxKeys>1000</MaxKeys>
${extra}${contents}</ListBucketResult>`;

const object = (key: string, size = '1045') => `
<Contents><Key>${key}</Key><LastModified>2025-10-06T09:39:01.000Z</LastModified>
<ETag>&quot;9cfc390fb9f68d8ef1fdbc7053d2698c&quot;</ETag><Size>${size}</Size></Contents>`;

describe('parsing an S3 page', () => {
  it('reads the metadata every key carries', () => {
    const { listed } = _test_parse(page(object('data/spot/monthly/trades/BTCUSDT/x-2025-01.zip')));

    expect(listed).toEqual([{
      key:      'data/spot/monthly/trades/BTCUSDT/x-2025-01.zip',
      size:     1045,
      etag:     '9cfc390fb9f68d8ef1fdbc7053d2698c',
      modified: '2025-10-06T09:39:01.000Z',
    }]);
  });

  /**
   * OKX serves the same order-book file from Alibaba OSS and from S3 — identical
   * bytes, identical length, the same md5 in opposite cases. Kept as sent, that
   * reads as a new version: a revision is appended and `downloaded_at` cleared,
   * so a file already on disk becomes one that is owed.
   */
  it('lower-cases an ETag, since the case is the server\'s and not the file\'s', () => {
    const upper = `<?xml version="1.0" encoding="UTF-8"?>
<ListBucketResult><Contents><Key>a.zip</Key>
<ETag>&quot;CDC23CB7F799B55087E0AF9F98419660&quot;</ETag><Size>1</Size></Contents></ListBucketResult>`;

    expect(_test_parse(upper).listed[0]!.etag).toBe('cdc23cb7f799b55087e0af9f98419660');
  });

  /**
   * The bare `<Prefix>` echoing the request ends in `/` exactly like a child
   * does. Matching it turns the last path segment into a phantom directory on
   * every S3 venue at once.
   */
  it('does not mistake the echoed request prefix for a child', () => {
    const { prefixes } = _test_parse(page('', `
      <CommonPrefixes><Prefix>data/spot/</Prefix></CommonPrefixes>
      <CommonPrefixes><Prefix>data/futures/</Prefix></CommonPrefixes>`));

    expect(prefixes).toEqual(['data/spot/', 'data/futures/']);
    expect(prefixes).not.toContain('data/');
  });

  /**
   * S3 omits NextMarker when no delimiter was sent. Without falling back to the
   * last key a walk stops after one page and reports success — the whole
   * archive below that point silently missing.
   */
  it('falls back to the last key when NextMarker is absent', () => {
    const { next } = _test_parse(page(
      object('a/1.zip') + object('a/2.zip'),
      '<IsTruncated>true</IsTruncated>',
    ));

    expect(next).toBe('a/2.zip');
  });

  it('prefers NextMarker when the venue does send one', () => {
    const { next } = _test_parse(page(
      object('a/1.zip'),
      '<IsTruncated>true</IsTruncated><NextMarker>a/9.zip</NextMarker>',
    ));

    expect(next).toBe('a/9.zip');
  });

  it('stops when the listing is not truncated', () => {
    expect(_test_parse(page(object('a/1.zip'))).next).toBeNull();
  });

  /**
   * A truncated `delimiter=/` page can end on a child directory rather than a
   * key, so the marker is whichever of the two sorts last. Taking the last key
   * regardless would re-read the same page for ever.
   */
  it('resumes from the last entry, key or directory', () => {
    const { next } = _test_parse(page(
      object('a/1.zip'),
      '<IsTruncated>true</IsTruncated><CommonPrefixes><Prefix>a/z/</Prefix></CommonPrefixes>',
    ));

    expect(next).toBe('a/z/');
  });

  it('reports a missing size as unknown rather than zero', () => {
    const { listed } = _test_parse(page('<Contents><Key>a/1.zip</Key></Contents>'));

    expect(listed[0]!.size).toBeNull();
    expect(listed[0]!.etag).toBeNull();
  });
});

describe('building a listing URL', () => {
  /**
   * `max-keys` above 1000 is echoed back in `<MaxKeys>` and never applied, so
   * asking for more looks like it worked and silently does not.
   */
  it('asks for 1000 keys, which is the real cap', () => {
    expect(_test_listingUrl('https://host', 'data/', null, false))
      .toBe('https://host/?prefix=data/&max-keys=1000');
  });

  it('tolerates a base that already ends in a slash', () => {
    expect(_test_listingUrl('https://host/', 'data/', null, false))
      .toBe('https://host/?prefix=data/&max-keys=1000');
  });

  /**
   * KuCoin serves its HTML index instead of the XML listing when the slashes
   * are percent-encoded, and S3 accepts the raw form everywhere.
   */
  it('leaves prefix and marker unencoded', () => {
    const url = _test_listingUrl('https://host', 'data/spot/', 'data/spot/a/b-2025-01.zip', false);

    expect(url).toContain('prefix=data/spot/');
    expect(url).toContain('marker=data/spot/a/b-2025-01.zip');
    expect(url).not.toContain('%2F');
  });

  it('adds the delimiter only when descending', () => {
    expect(_test_listingUrl('https://host', 'data/', null, true)).toContain('&delimiter=/');
    expect(_test_listingUrl('https://host', 'data/', null, false)).not.toContain('delimiter');
  });
});

describe('what counts as a file when deciding to descend', () => {
  /**
   * The rule protects files that would be *dropped* by replacing a prefix with
   * its children. A key the adapter declines would never have been recorded, so
   * descending past it loses nothing.
   *
   * Getting this wrong is not subtle: a bucket root serves `index.html` and
   * `favicon.ico`, and treating those as files to protect collapses an entire
   * venue into one scope walked as a single serial chain.
   */
  it('ignores keys the venue would never catalogue', () => {
    expect(_test_catalogable(binance, 'index.html')).toBe(false);
    expect(_test_catalogable(binance, 'favicon.ico')).toBe(false);
    expect(_test_catalogable(binance, 'test.file')).toBe(false);
  });

  it('counts a key that would become a row', () => {
    expect(_test_catalogable(binance,
      'data/spot/monthly/trades/BTCUSDT/BTCUSDT-trades-2025-03.zip')).toBe(true);
  });

  /** Checksum sidecars are not files to protect either — they are never stored. */
  it('ignores checksum sidecars', () => {
    expect(_test_catalogable(binance,
      'data/spot/monthly/trades/BTCUSDT/BTCUSDT-trades-2025-03.zip.CHECKSUM')).toBe(false);
  });

  /** And it honours the adapter's own refusals, not just its date pattern. */
  it('ignores what the adapter refuses', () => {
    expect(_test_catalogable(binance,
      'data2/data/spot/trades/A/A-trades-2020-12.zip')).toBe(false);
  });

  /** Same answer for a venue whose root is stripped before the adapter sees it. */
  it('strips the root before asking the adapter', () => {
    expect(_test_catalogable(kucoin,
      'data/spot/daily/trades/A/A-trades-2024-07-03.zip')).toBe(true);
  });
});

/**
 * A refused directory is ignored as though it were not there, rather than walked
 * to exhaustion and discarded key by key. Filtering only at the recording step
 * is correct and expensive: binance's `data2/data/spot/klines/` cost 655 pages
 * and 43 minutes of a worker to store nothing.
 *
 * Which means `accepts` is asked about **prefixes**, so every adapter's patterns
 * have to hold for a directory as well as a key.
 */
describe('refusing a directory before descending into it', () => {
  it('refuses binance staging as a directory, not only as a key', () => {
    expect(_test_accepted(binance, 'data2/')).toBe(false);
    expect(_test_accepted(binance, 'data2/data/spot/klines/')).toBe(false);
  });

  /**
   * The abandoned duplicate of the monthly spot tree, under a key that really
   * does start with a slash. Refused at the root so descent never enters it —
   * every key inside is a second name for a file already catalogued under
   * `data/spot/monthly/`.
   */
  it('refuses the leading-slash duplicate of the binance spot tree', () => {
    expect(_test_accepted(binance, '/')).toBe(false);
    expect(_test_accepted(binance, '/data/spot/klines/BTCUSDT/1m/')).toBe(false);
    expect(_test_accepted(binance,
      '/data/spot/aggTrades/BNBBTC/BNBBTC-aggTrades-2017-07.zip')).toBe(false);
    expect(_test_accepted(binance, 'data/spot/monthly/klines/BTCUSDT/1m/')).toBe(true);
  });

  it('refuses the htx directories that are not archive', () => {
    expect(_test_accepted(htx, 'assets/')).toBe(false);
    expect(_test_accepted(htx, 'test/')).toBe(false);
    expect(_test_accepted(htx, 'test/daily/')).toBe(false);
  });

  /**
   * Field descriptions, one at the root of every dataset and market under
   * `data/`. Documentation rather than archive, and dateless, so nothing could
   * place it in a series — refused by name so it does not sit in the unreadable
   * list looking like a shape nobody has parsed.
   */
  it('refuses the htx field-description files', () => {
    expect(_test_accepted(htx, 'data/klines/spot/remark.txt')).toBe(false);
    expect(_test_accepted(htx, 'data/trades/linear-swap/remark.txt')).toBe(false);

    expect(_test_accepted(htx,
      'data/klines/spot/daily/BTCUSDT/1min/BTCUSDT-1min-2026-01-31.zip')).toBe(true);
  });

  /**
   * **htx migrated on 2026-02-01** and went on writing the old shapes under
   * `data/` until 2026-08-04, so those six months are the same trading twice.
   * The cut is the migration, not the day the old tree stopped: below it, that
   * tree is the only place the data exists.
   */
  it('refuses the htx duplicates the migration superseded', () => {
    const at = (day: string) =>
      `data/klines/spot/daily/BTCUSDT/1min/BTCUSDT-1min-${day}.zip`;

    expect(_test_accepted(htx, at('2026-01-31'))).toBe(true);
    expect(_test_accepted(htx, at('2026-02-01'))).toBe(false);
    expect(_test_accepted(htx, at('2026-08-04'))).toBe(false);

    // The tree that took over is untouched, whatever the date.
    expect(_test_accepted(htx,
      'historical_data/spot/daily/klines/BTC-USDT/1min/BTC-USDT-1min-2026-08-04.zip')).toBe(true);
  });

  /**
   * The one that would lose data if a pattern were written carelessly. Binance's
   * rule refuses a **stray key** directly under `data3/`, and the trailing slash
   * is what keeps it from swallowing the directory holding 311 symbols of
   * USDT-margined liquidation snapshots that exist nowhere else in the bucket.
   */
  it('keeps the data3 directory while refusing a stray key beside it', () => {
    expect(_test_accepted(binance, 'data3/liquidationSnapshot/')).toBe(true);
    expect(_test_accepted(binance, 'data3/stray.zip')).toBe(false);
  });

  it('keeps the archive directories of every venue', () => {
    expect(_test_accepted(binance, 'data/')).toBe(true);
    expect(_test_accepted(htx, 'historical_data/')).toBe(true);
    expect(_test_accepted(htx, 'data/')).toBe(true);
  });

  /**
   * KuCoin refuses one interval of one dataset, and it has to hold for the
   * directory: the alternative is descending into 134 symbols to discard every
   * key under them.
   *
   * Those files declare `time,open,high,low,close,volume` and write five fields
   * per row — the volume is absent, not empty. Nothing is lost by refusing
   * them, since a day is an aggregate of the 1m bars published complete over
   * the same range.
   */
  it('refuses kucoin futures 1d klines as a directory, not only as a key', () => {
    expect(_test_accepted(kucoin, 'data/futures/daily/klines/SANDUSDTM/1d/')).toBe(false);
    expect(_test_accepted(kucoin, 'data/futures/daily/klines/SANDUSDTM/1d')).toBe(false);
    expect(_test_accepted(kucoin,
      'data/futures/daily/klines/SANDUSDTM/1d/SANDUSDTM-1d-2023-01-01.zip')).toBe(false);
  });

  /**
   * The interval is what is broken, not the venue or the dataset — every other
   * interval carries its volume, spot is well formed at `1d`, and `index` and
   * `mark` have no volume column at any interval by design.
   */
  it('keeps everything kucoin publishes correctly', () => {
    expect(_test_accepted(kucoin, 'data/spot/')).toBe(true);
    expect(_test_accepted(kucoin, 'data/futures/daily/klines/SANDUSDTM/1h/')).toBe(true);
    expect(_test_accepted(kucoin, 'data/futures/daily/klines/SANDUSDTM/12h/x.zip')).toBe(true);
    expect(_test_accepted(kucoin, 'data/spot/daily/klines/SANDUSDT/1d/x.zip')).toBe(true);
    expect(_test_accepted(kucoin, 'data/futures/daily/index/SANDUSDTM/1d/x.zip')).toBe(true);
    expect(_test_accepted(kucoin, 'data/futures/daily/mark/SANDUSDTM/1d/x.zip')).toBe(true);
  });

  /** A symbol may begin with the interval's own name. */
  it('does not mistake a symbol for the refused interval', () => {
    expect(_test_accepted(kucoin, 'data/futures/daily/klines/1dCOIN/1h/x.zip')).toBe(true);
  });

  /** And the root comes off first, as it does everywhere else. */
  it('strips the root before asking the adapter', () => {
    expect(_test_accepted(kucoin, 'data/futures/')).toBe(true);
  });
});

/**
 * The enumerated half: specific files a venue serves that are not historical
 * data. Matched exactly, checked before the adapter is asked, and maintained as
 * rows so finding one costs a row rather than a redeploy.
 */
describe('the enumerated exclusions', () => {
  afterEach(() => _test_reset());

  it('refuses a listed file the adapter would otherwise accept', () => {
    const path = 'data/spot/monthly/trades/BTCUSDT/BTCUSDT-trades-2025-03.zip';

    expect(_test_catalogable(binance, path)).toBe(true);

    _test_seed('binance', [path]);

    expect(_test_catalogable(binance, path)).toBe(false);
  });

  /** Exactly, not as a prefix — describable rules belong in `accepts`. */
  it('matches the whole path and nothing near it', () => {
    _test_seed('binance', ['data/spot/monthly/trades/BTCUSDT/BTCUSDT-trades-2025-03.zip']);

    expect(_test_catalogable(binance,
      'data/spot/monthly/trades/BTCUSDT/BTCUSDT-trades-2025-04.zip')).toBe(true);
    expect(_test_accepted(binance, 'data/spot/monthly/trades/BTCUSDT/')).toBe(true);
  });

  /** One venue's bad file says nothing about another's. */
  it('is kept apart per venue', () => {
    const path = 'data/spot/daily/trades/A/A-trades-2024-07-03.zip';

    _test_seed('binance', [path]);

    expect(_test_accepted(kucoin, `data/${path}`)).toBe(true);
  });

  /** The path is the one the catalog stores, so the root comes off first. */
  it('is matched against the stored path, not the raw key', () => {
    _test_seed('kucoin', ['spot/daily/trades/A/A-trades-2024-07-03.zip']);

    expect(_test_catalogable(kucoin,
      'data/spot/daily/trades/A/A-trades-2024-07-03.zip')).toBe(false);
  });
});

/**
 * A `delimiter=/` reply is capped at 1000 entries, with child directories and
 * keys sharing that budget, so a level wider than a page arrives cut off. What is
 * missed decides whether the prefix is split, and a dated key sorting past the
 * cut would end up inside no partition at all — so the reply's own `IsTruncated`
 * is followed rather than assumed away.
 */
describe('mapping a level wider than one page', () => {
  const limits = { concurrency: 64 };

  // These pages are served under `data/`, so descent has to start there.
  const context = { ...listing(binance), root: 'data/' };

  const dir = (prefix: string) => `<CommonPrefixes><Prefix>${prefix}</Prefix></CommonPrefixes>`;

  /**
   * Serve these pages by URL fragment, and an empty listing for anything else.
   *
   * **The longest matching fragment wins**, so a rule for a marked page beats the
   * one for the prefix it carries. Matching the shortest instead served the same
   * truncated page for every marker, which used to be harmless — the level stopped
   * reading once it had seen enough children — and became an infinite loop the
   * moment levels were read to exhaustion.
   */
  const serving = (pages: Record<string, string>) =>
    vi.mocked(fetchText).mockImplementation(async (_adapter: Adapter, url: string) => {
      const hit = Object.keys(pages)
        .filter(fragment => url.includes(fragment))
        .sort((a, b) => b.length - a.length)[0];

      return hit ? pages[hit]! : page('');
    });

  afterEach(() => vi.mocked(fetchText).mockReset());

  /** The one that loses data: the only file at this level is on page two. */
  it('sees a file that only the second page carries', async () => {
    serving({
      'marker=data/sub/': page(object('data/late-2025-01-01.zip')),
      'prefix=data/&':   page(dir('data/sub/'), '<IsTruncated>true</IsTruncated>'),
    });

    expect(await _test_descend(context, limits)).toEqual(['data/']);
  });

  it('collects children from every page before judging the level', async () => {
    serving({
      'marker=data/b/': page(dir('data/c/')),
      'prefix=data/&':   page(dir('data/a/') + dir('data/b/'), '<IsTruncated>true</IsTruncated>'),
    });

    expect(await _test_descend(context, limits)).toEqual(['data/a/', 'data/b/', 'data/c/']);
  });

  /**
   * **Every page of a level, however wide.** Reading only the first used to be an
   * optimisation — a prefix past `FANOUT` children was terminal whichever way the
   * rest went — and that shortcut is what closed binance over unwalked keyspace
   * when splitting reused the same reader: 1,000 children of 3,694, a cursor
   * already past all of them, and a partition closed holding nothing.
   */
  it('reads every page of a wide level rather than judging from the first', async () => {
    serving({
      'marker=data/c/': page(dir('data/d/')),
      'prefix=data/&':  page(dir('data/a/') + dir('data/b/') + dir('data/c/'),
        '<IsTruncated>true</IsTruncated>'),
    });

    expect(await _test_descend(context, { concurrency: 2 }))
      .toEqual(['data/a/', 'data/b/', 'data/c/', 'data/d/']);
  });

  /** And a level that fits in one page still costs exactly one request. */
  it('asks once when nothing was held back', async () => {
    serving({ 'prefix=data/&': page(dir('data/a/')) });

    expect(await _test_descend(context, limits)).toEqual(['data/a/']);
    expect(fetchText).toHaveBeenCalledTimes(2);
  });
});

/**
 * Give the adapters their addresses, as startup does.
 *
 * **Where a venue is lives in the `venue` table**, written by a migration, so an
 * adapter carries no address until it is handed one. A test that uses a real
 * venue needs that step; one that invents its own venue does not.
 */
const address = () => {
  const here = mkdtempSync(join(tmpdir(), 'addresses-'));
  const db   = openCatalog(join(here, 'catalog.db'));

  addressVenues(venues(db));

  db.close();
  rmSync(here, { recursive: true, force: true });
};

address();
