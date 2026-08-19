import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { markDownloaded, markWithdrawn, putFiles, putVenue, recordSeries } from '../src/catalog';
import { openCatalog } from '../src/database';
import { deltasOf, drift, rebuild, months } from '../src/catalog/cache/months';
import type { CatalogFile, FileState } from '../src/types';
import type { DatabaseSync } from 'node:sqlite';

/**
 * The rollup is what makes an aggregate affordable, so the thing that matters is
 * that it says what the rows say. Two halves: the arithmetic, which needs no
 * database, and the wiring, which is checked against `drift` — the same
 * recomputation that would catch a call site nobody wired.
 */

let dir: string;
let db:  DatabaseSync;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'cache-'));
  db  = openCatalog(join(dir, 'catalog.db'), { seedData: false });
});

afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

const state = (over: Partial<FileState> = {}): FileState =>
  ({ month: '202503', confirmed: true, downloaded: false, bytes: 10, ...over });

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
  venueId: 1, path, date: '20250301', size: 10, etag: 'e',
  modified: null, existence: 'confirmed', seenAt: 'T1',
  seriesId: seriesOn(over.venueId ?? 1), ...over,
});

describe('the arithmetic', () => {
  it('counts a file nobody had seen', () => {
    expect(deltasOf([{ venueId: 1, was: null, now: state() }]))
      .toEqual([{ venueId: 1, month: '202503', files: 1, bytes: 10, pending: 1, pendingBytes: 10, withdrawn: 0 }]);
  });

  it('takes a file out of pending when it lands', () => {
    expect(deltasOf([{ venueId: 1, was: state(), now: state({ downloaded: true }) }]))
      .toEqual([{ venueId: 1, month: '202503', files: 0, bytes: 0, pending: -1, pendingBytes: -10, withdrawn: 0 }]);
  });

  /** A withdrawn file stops counting as one and stops being owed. */
  it('moves a withdrawal out of files and out of pending', () => {
    expect(deltasOf([{ venueId: 1, was: state(), now: state({ confirmed: false }) }]))
      .toEqual([{ venueId: 1, month: '202503', files: -1, bytes: -10, pending: -1, pendingBytes: -10, withdrawn: 1 }]);
  });

  /**
   * A file whose date moved is two keys, not one — subtracted from where it was
   * and added to where it now is. Nothing special is needed for it.
   */
  it('moves a file that changed month', () => {
    expect(deltasOf([{ venueId: 1, was: state(), now: state({ month: '202504' }) }]))
      .toEqual([
        { venueId: 1, month: '202503', files: -1, bytes: -10, pending: -1, pendingBytes: -10, withdrawn: 0 },
        { venueId: 1, month: '202504', files: 1,  bytes: 10,  pending: 1,  pendingBytes: 10,  withdrawn: 0 },
      ]);
  });

  /** A re-walk that finds everything unchanged must not write a row. */
  it('says nothing about a batch that changed nothing', () => {
    expect(deltasOf([{ venueId: 1, was: state(), now: state() }])).toEqual([]);
  });

  it('folds a batch into one row per venue-month', async () => {
    const many = Array.from({ length: 500 }, () => ({ venueId: 1, was: null, now: state() }));

    expect(deltasOf(many)).toHaveLength(1);
    expect(deltasOf(many)[0]).toMatchObject({ files: 500, bytes: 5_000, pending: 500 });
  });
});

describe('what the write paths maintain', () => {
  const seed = async () => {
    putVenue(db, 'binance', 'https://x', '');
    await putFiles(db, [file('spot/a-2025-03.zip'), file('spot/b-2025-03.zip')]);
  };

  it('counts files as a survey records them', async () => {
    await seed();

    expect(months(db, 1)).toEqual([
      { venueId: 1, month: '202503', files: 2, bytes: 20, pending: 2, pendingBytes: 20, withdrawn: 0 },
    ]);
  });

  it('does not double count a re-walk', async () => {
    await seed();
    await seed();

    expect(months(db, 1)[0]).toMatchObject({ files: 2, pending: 2 });
  });

  it('follows a download', async () => {
    await seed();
    markDownloaded(db, [{ venueId: 1, path: 'spot/a-2025-03.zip' }], 'D1');

    expect(months(db, 1)[0]).toMatchObject({ files: 2, pending: 1 });
  });

  /** Reporting the same file twice must not take it out of pending twice. */
  it('ignores a download reported again', async () => {
    await seed();
    markDownloaded(db, [{ venueId: 1, path: 'spot/a-2025-03.zip' }], 'D1');
    markDownloaded(db, [{ venueId: 1, path: 'spot/a-2025-03.zip' }], 'D2');

    expect(months(db, 1)[0]).toMatchObject({ pending: 1 });
    expect(db.prepare(`SELECT downloaded_at FROM file WHERE path = 'spot/a-2025-03.zip'`).get())
      .toMatchObject({ downloaded_at: 'D1' });
  });

  it('follows a withdrawal', async () => {
    await seed();
    await putFiles(db, [file('spot/a-2025-03.zip', { seenAt: 'T2' })]);
    markWithdrawn(db, 1, 'spot/', 'spot0', 'T2');

    expect(months(db, 1)[0]).toMatchObject({ files: 1, pending: 1, withdrawn: 1 });
  });

  /** A changed file is owed again, and the rollup has to say so. */
  it('puts a changed file back into pending', async () => {
    await seed();
    markDownloaded(db, [{ venueId: 1, path: 'spot/a-2025-03.zip' }, { venueId: 1, path: 'spot/b-2025-03.zip' }], 'D1');

    expect(months(db, 1)[0]).toMatchObject({ pending: 0 });

    await putFiles(db, [file('spot/a-2025-03.zip', { seenAt: 'T2', size: 99, etag: 'v2' })]);

    expect(months(db, 1)[0]).toMatchObject({ files: 2, bytes: 109, pending: 1 });
  });
});

/**
 * Every counter moves in the same transaction as its row, but a call site nobody
 * wired is silent — so the only honest answer is to be able to check.
 */
describe('proving the cache still matches the rows', () => {
  it('finds nothing to report when the writes were wired', async () => {
    putVenue(db, 'binance', 'https://x', '');
    await putFiles(db, [file('spot/a-2025-03.zip'), file('spot/b-2025-04.zip', { date: '20250401' })]);
    markDownloaded(db, [{ venueId: 1, path: 'spot/a-2025-03.zip' }], 'D1');

    expect(drift(db)).toEqual([]);
  });

  it('reports both figures when they disagree', async () => {
    putVenue(db, 'binance', 'https://x', '');
    await putFiles(db, [file('spot/a-2025-03.zip')]);

    db.prepare('UPDATE month SET files = 99').run();

    expect(drift(db)).toMatchObject([{ month: '202503', files: 1, cachedFiles: 99 }]);
  });

  it('rebuilds what was never maintained', async () => {
    putVenue(db, 'binance', 'https://x', '');
    await putFiles(db, [file('spot/a-2025-03.zip'), file('spot/b-2025-03.zip')]);

    // A catalog written before the rollup existed looks exactly like this.
    db.prepare('DELETE FROM month').run();
    expect(drift(db)).toHaveLength(1);

    rebuild(db);

    expect(drift(db)).toEqual([]);
    expect(months(db, 1)[0]).toMatchObject({ files: 2, bytes: 20, pending: 2 });
  });
});
