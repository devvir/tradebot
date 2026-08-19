import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { correctFile, fileOf, keyOf, markDownloaded, markPending, monthTotals, catalogFiles, putFiles, putVenue, recordSeries, venueIds, venueTotals } from '../src/catalog';
import { openCatalog } from '../src/database';
import type { CatalogFile } from '../src/types';
import type { DatabaseSync } from 'node:sqlite';

let dir: string;
let db:  DatabaseSync;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'queries-'));
  db  = openCatalog(join(dir, 'catalog.db'), { seedData: false });
});

afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

/**
 * A series for the venue to hang files on. These tests are about `file` and
 * `wip`, not about series, so one stands in for all of them.
 */
const seriesOn = (venueId: number): number =>
  recordSeries(db, venueId, {
    market: 'perp', dataset: 'klines', symbol: 'BTCUSDT',
    pattern: 'p/{YYYY}{MM}/{SYMBOL}.zip',
  }).id!;

const file = (path: string, over: Partial<CatalogFile> = {}): CatalogFile => ({
  venueId: 1, path, date: '20240201', size: 10, etag: 'e',
  modified: null, existence: 'confirmed', seenAt: 'T1',
  seriesId: seriesOn(over.venueId ?? 1), ...over,
});

describe('how a caller names a file', () => {
  it('survives a round trip', () => {
    expect(fileOf(keyOf(7, 'spot/monthly/a-2024-02.zip')))
      .toEqual({ venueId: 7, path: 'spot/monthly/a-2024-02.zip' });
  });

  it('carries a path with spaces and slashes intact', () => {
    const path = 'trade/option/BTC USD/2024-02-01_x.csv.zip';

    expect(fileOf(keyOf(2, path))?.path).toBe(path);
  });

  /** A key arrives from a client, so it is input rather than a fact. */
  it('answers null for anything that is not one', async () => {
    expect(fileOf('not-base64-!!')).toBeNull();
    expect(fileOf(Buffer.from('nonsense').toString('base64url'))).toBeNull();
    expect(fileOf(Buffer.from('0 a/b').toString('base64url'))).toBeNull();
  });
});

describe('what a venue holds', () => {
  /** Two hosts of one venue are one answer: the caller asked about a venue. */
  const seed = async () => {
    putVenue(db, 'bybit', 'https://x', '', 'primary');
    putVenue(db, 'bybit', 'https://y', 'orderbook/', 'secondary');

    await putFiles(db, [
      file('trading/a.csv.gz', { venueId: 1, date: '20240115', size: 100 }),
      file('trading/b.csv.gz', { venueId: 1, date: '20240210', size: 200 }),
      file('linear/c.data.zip', { venueId: 2, date: '20240220', size: 400 }),
    ]);
  };

  it('sums its hosts into one row', async () => {
    await seed();

    expect(venueTotals(db)).toEqual([{
      venue: 'bybit', firstMonth: '202401', lastMonth: '202402',
      files: 3, bytes: 700, pending: 3, pendingBytes: 700, withdrawn: 0,
    }]);
  });

  it('follows downloads through the totals', async () => {
    await seed();
    markDownloaded(db, [{ venueId: 2, path: 'linear/c.data.zip' }], 'D1');

    expect(venueTotals(db)[0]).toMatchObject({ files: 3, pending: 2, pendingBytes: 300 });
  });

  it('reports a venue nothing is known about without inventing figures', async () => {
    putVenue(db, 'gate', 'https://g', '');

    expect(venueTotals(db)).toEqual([{
      venue: 'gate', firstMonth: null, lastMonth: null,
      files: 0, bytes: 0, pending: 0, pendingBytes: 0, withdrawn: 0,
    }]);
  });
});

describe('months', () => {
  const seed = async () => {
    putVenue(db, 'binance', 'https://x', '');
    await putFiles(db, [
      file('a.zip', { date: '20240115' }),
      file('b.zip', { date: '20240210' }),
      file('c.zip', { date: '20240211' }),
    ]);
  };

  it('says which state each is in', async () => {
    await seed();
    markDownloaded(db, [{ venueId: 1, path: 'a.zip' }], 'D1');

    expect(monthTotals(db, venueIds(db, 'binance')).map(m => [m.month, m.state]))
      .toEqual([['202401', 'closed'], ['202402', 'open']]);
  });

  it('filters to one state', async () => {
    await seed();
    markDownloaded(db, [{ venueId: 1, path: 'a.zip' }], 'D1');

    expect(monthTotals(db, venueIds(db, 'binance'), { state: 'closed' }).map(m => m.month))
      .toEqual(['202401']);
  });

  it('bounds by month', async () => {
    await seed();

    expect(monthTotals(db, venueIds(db, 'binance'), { from: '202402' }).map(m => m.month))
      .toEqual(['202402']);
  });

  /** A year, a month, or a month with a dash — all three are things people type. */
  it('scopes to named periods in any of their forms', async () => {
    await seed();

    expect(monthTotals(db, venueIds(db, 'binance'), { in: ['2024-01'] }).map(m => m.month))
      .toEqual(['202401']);
    expect(monthTotals(db, venueIds(db, 'binance'), { in: ['2024'] })).toHaveLength(2);
    expect(monthTotals(db, venueIds(db, 'binance'), { in: ['202312'] })).toEqual([]);
  });
});

describe('what is still owed', () => {
  const seed = async () => {
    putVenue(db, 'binance', 'https://x', '');
    await putFiles(db, [
      file('a.zip', { date: '20240115' }),
      file('b.zip', { date: '20240210' }),
      file('c.zip', { date: '20240211' }),
    ]);
  };

  it('offers the oldest first, and no bounds means the lot', async () => {
    await seed();

    expect(catalogFiles(db, venueIds(db, 'binance'), { downloaded: false, limit: 10 }).map(f => f.path))
      .toEqual(['a.zip', 'b.zip', 'c.zip']);
  });

  it('pages by value, so writes cannot shift it', async () => {
    await seed();

    const [first] = catalogFiles(db, venueIds(db, 'binance'), { downloaded: false, limit: 1 });

    expect(catalogFiles(db, venueIds(db, 'binance'), { downloaded: false, after: first as never, limit: 10 })
      .map(f => f.path)).toEqual(['b.zip', 'c.zip']);
  });

  /** Stepping past what will not download is how a caller stops retrying it. */
  it('bounds by date', async () => {
    await seed();

    expect(catalogFiles(db, venueIds(db, 'binance'), { downloaded: false, from: '20240211', limit: 10 })
      .map(f => f.path)).toEqual(['c.zip']);
  });

  it('drops a file once it lands', async () => {
    await seed();
    markDownloaded(db, [{ venueId: 1, path: 'a.zip' }], 'D1');

    expect(catalogFiles(db, venueIds(db, 'binance'), { downloaded: false, limit: 10 }).map(f => f.path))
      .toEqual(['b.zip', 'c.zip']);
  });
});

/**
 * The archive changed under us. The bytes in hand are a real version and the
 * record is stale, so the observation is recorded and the displaced version is
 * kept with the download state it had.
 */
describe('correcting what was recorded', () => {
  const seed = async () => {
    putVenue(db, 'binance', 'https://x', '');
    await putFiles(db, [file('a.zip', { size: 10, etag: 'v1' })]);
    markDownloaded(db, [{ venueId: 1, path: 'a.zip' }], 'D1');
  };

  it('records the observation and keeps what it replaced', async () => {
    await seed();

    expect(correctFile(db, 1, 'a.zip', { size: 99, etag: 'v2', modified: null }, 'T2', true))
      .toBe(true);

    expect(db.prepare('SELECT size, etag, downloaded_at FROM file').get())
      .toMatchObject({ size: 99, etag: 'v2', downloaded_at: 'T2' });
    expect(db.prepare('SELECT etag, downloaded_at FROM revision').get())
      .toMatchObject({ etag: 'v1', downloaded_at: 'D1' });
  });

  /** A correction from outside the download flow leaves the file owed. */
  it('leaves it pending when the caller does not hold it', async () => {
    await seed();
    correctFile(db, 1, 'a.zip', { size: 99, etag: 'v2', modified: null }, 'T2', false);

    expect(db.prepare('SELECT downloaded_at FROM file').get())
      .toMatchObject({ downloaded_at: null });
    expect(monthTotals(db, venueIds(db, 'binance'))[0])
      .toMatchObject({ pending: 1, pendingBytes: 99, bytes: 99 });
  });

  it('says so when there is no such file', async () => {
    await seed();

    expect(correctFile(db, 1, 'nope.zip', { size: 1, etag: 'x', modified: null }, 'T2', true))
      .toBe(false);
  });
});

describe('putting a file back among what is owed', () => {
  it('undoes a download and returns it to the count', async () => {
    putVenue(db, 'binance', 'https://x', '');
    await putFiles(db, [file('a.zip')]);
    markDownloaded(db, [{ venueId: 1, path: 'a.zip' }], 'D1');

    expect(monthTotals(db, venueIds(db, 'binance'))[0]).toMatchObject({ pending: 0 });
    expect(markPending(db, 1, 'a.zip')).toBe(true);
    expect(monthTotals(db, venueIds(db, 'binance'))[0]).toMatchObject({ pending: 1 });
  });

  it('reports nothing to do for a file already owed', async () => {
    putVenue(db, 'binance', 'https://x', '');
    await putFiles(db, [file('a.zip')]);

    expect(markPending(db, 1, 'a.zip')).toBe(false);
  });
});

/**
 * A listing narrowed to a set of series.
 *
 * **The narrowing is the caller's, resolved from the registry it already holds
 * in memory.** What reaches SQLite is one indexed seek per series, which is the
 * only plan that stays fast: handed the same set as a join, the optimiser drives
 * from `file_when` instead and scans every file the venue published that month.
 */
describe('listing one dataset out of a venue', () => {
  let klines: number;
  let trades: number;
  let other:  number;

  beforeEach(async () => {
    const venue = putVenue(db, 'demo', 'https://example.invalid', '');

    const of = (dataset: string, symbol: string): number =>
      recordSeries(db, venue, {
        market: 'SPOT', dataset, symbol, urlSymbol: symbol,
        pattern: `${dataset}/{SYMBOL}/{YYYY}{MM}{DD}.zip`,
      }, { first: '20240101' }).id!;

    klines = of('klines', 'BTC-USDT');
    trades = of('trades', 'BTC-USDT');
    other  = of('klines', 'ETH-USDT');

    /** A fourth, so the listing has something to leave out that no test names. */
    const spare = of('depth', 'BTC-USDT');

    await putFiles(db, [
      file('a/1', { venueId: venue, seriesId: klines, date: '20240201' }),
      file('a/2', { venueId: venue, seriesId: klines, date: '20240202' }),
      file('b/1', { venueId: venue, seriesId: other,  date: '20240201' }),
      file('c/1', { venueId: venue, seriesId: trades, date: '20240115' }),
      file('d/1', { venueId: venue, seriesId: spare,  date: '20240201' }),
    ]);
  });

  it('returns only the series it was given', () => {
    const rows = catalogFiles(db, [1], { downloaded: false, series: [klines], limit: 100 });

    expect(rows.map(row => row.path)).toEqual(['a/1', 'a/2']);
  });

  it('carries the series, so a caller need not read the path', () => {
    const [row] = catalogFiles(db, [1], { downloaded: false, series: [klines], limit: 1 });

    expect(row?.seriesId).toBe(klines);
  });

  /**
   * An empty set means "nothing matched that filter", which is the opposite of
   * "no filter" — answering the whole venue there would hand back every dataset
   * it has for a request that asked for one nobody publishes.
   */
  it('answers nothing for an empty set rather than everything', () => {
    expect(catalogFiles(db, [1], { downloaded: false, series: [], limit: 100 })).toEqual([]);
  });

  it('still honours the date range', () => {
    const rows = catalogFiles(db, [1],
      { downloaded: false, series: [klines, trades, other], from: '202402', limit: 100 });

    expect(rows.map(row => row.path).sort()).toEqual(['a/1', 'a/2', 'b/1']);
  });

  it('leaves out a file already downloaded', async () => {
    markDownloaded(db, [{ venueId: 1, path: 'a/1' }], 'T2');

    expect(catalogFiles(db, [1], { downloaded: false, series: [klines], limit: 100 }).map(row => row.path))
      .toEqual(['a/2']);
  });

  /**
   * Paging walks the series in turn and seeks inside each, so where a page
   * stopped is a series *and* a position within it. Carrying the position into
   * the next series would skip its early files.
   */
  it('resumes inside the series a page stopped in', () => {
    const first = catalogFiles(db, [1], { downloaded: false, series: [klines, other], limit: 1 });

    expect(first.map(row => row.path)).toEqual(['a/1']);

    const next = catalogFiles(db, [1], {
      downloaded: false,
      series: [klines, other],
      after:  { date: '20240201', path: 'a/1', venueId: 1, seriesId: klines },
      limit:  100,
    });

    expect(next.map(row => row.path)).toEqual(['a/2', 'b/1']);
  });

  it('is unchanged when nothing narrows it', async () => {
    expect(catalogFiles(db, [1], { downloaded: false, limit: 100 }).length).toBe(5);
  });

  /**
   * The three states of the download filter, which is the whole difference
   * between the general listing and `/pending`. Leaving it out is not a default
   * of "owed" — it is the catalog's whole answer, which is what makes asking
   * about a file already held possible at all.
   */
  describe('the download filter', () => {
    beforeEach(() => {
      markDownloaded(db, [{ venueId: 1, path: 'a/1' }], 'T3');
    });

    it('answers either when nothing asks', () => {
      expect(catalogFiles(db, [1], { limit: 100 }).map(row => row.path).sort())
        .toEqual(['a/1', 'a/2', 'b/1', 'c/1', 'd/1']);
    });

    it('answers only what is held', () => {
      expect(catalogFiles(db, [1], { downloaded: true, limit: 100 }).map(row => row.path))
        .toEqual(['a/1']);
    });

    it('answers only what is owed', () => {
      expect(catalogFiles(db, [1], { downloaded: false, limit: 100 }).map(row => row.path).sort())
        .toEqual(['a/2', 'b/1', 'c/1', 'd/1']);
    });

    /** A listing that is not scoped to one state has to say which each row is. */
    it('carries the download state, so an unscoped listing can be read', () => {
      const rows = new Map(catalogFiles(db, [1], { limit: 100 })
        .map(row => [row.path, row.downloadedAt]));

      expect(rows.get('a/1')).toBe('T3');
      expect(rows.get('a/2')).toBe(null);
    });

    it('applies inside a narrowed listing too', () => {
      expect(catalogFiles(db, [1], { downloaded: true, series: [klines], limit: 100 })
        .map(row => row.path)).toEqual(['a/1']);
    });
  });
});
