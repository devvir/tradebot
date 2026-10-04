import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  correctFile, markDownloaded, putFiles, putVenue, recordSeries, settleFiles, withdrawFile,
} from '../src/catalog';
import { openCatalog } from '../src/database';
import { deltasOf, versionOf } from '../src/catalog/cache/partitions';
import type { CatalogFile, FileState } from '../src/types';
import type { DatabaseSync } from 'node:sqlite';

/**
 * A partition's counters are what make an aggregate affordable, and its version
 * is what tells a consumer its files moved — so the thing that matters is that
 * both say what the rows say. Two halves: the arithmetic, which needs no
 * database, and the wiring, which is checked against a recount of `file` — the
 * only thing that catches a call site nobody wired.
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
  ({ partitionId: 1, confirmed: true, downloaded: false, bytes: 10, etag: 'e', ...over });

/**
 * A series for the venue to hang files on. These tests are about `file` and
 * its partitions, not about series, so one stands in for all of them.
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

/** What the partitions hold, month by month. */
const held = () =>
  db.prepare(
    `SELECT month, files, bytes, pending, pending_bytes AS pendingBytes, withdrawn
       FROM partition ORDER BY month`,
  ).all();

/** The same figures counted from `file`, per partition. */
const recount = () =>
  db.prepare(
    `SELECT partition_id AS id,
            SUM(existence = 'confirmed') AS files,
            SUM(CASE WHEN existence = 'confirmed' THEN COALESCE(size, 0) ELSE 0 END) AS bytes,
            SUM(existence = 'confirmed' AND downloaded_at IS NULL) AS pending,
            SUM(CASE WHEN existence = 'confirmed' AND downloaded_at IS NULL THEN COALESCE(size, 0) ELSE 0 END) AS pendingBytes,
            SUM(existence <> 'confirmed') AS withdrawn
       FROM file GROUP BY partition_id ORDER BY 1`,
  ).all();

/** What the partitions hold, in the shape `recount` answers in. */
const counted = () =>
  db.prepare(
    `SELECT id, files, bytes, pending, pending_bytes AS pendingBytes, withdrawn
       FROM partition ORDER BY 1`,
  ).all();

const versions = (): string[] =>
  (db.prepare('SELECT version FROM partition ORDER BY month').all() as { version: string }[]).map(one => one.version);

const stamps = (): string[] =>
  (db.prepare('SELECT updated_at AS at FROM partition ORDER BY month').all() as { at: string }[]).map(one => one.at);

const EMPTY = '0000000000000000';

describe('the arithmetic', () => {
  it('counts a file nobody had seen', () => {
    expect(deltasOf([{ was: null, now: state() }]))
      .toMatchObject([{ partitionId: 1, files: 1, bytes: 10, pending: 1, pendingBytes: 10, withdrawn: 0 }]);
  });

  /** A download moves what is pending, and leaves the version where it was. */
  it('takes a file out of pending when it lands', () => {
    expect(deltasOf([{ was: state(), now: state({ downloaded: true }) }]))
      .toEqual([{ partitionId: 1, files: 0, bytes: 0, pending: -1, pendingBytes: -10, withdrawn: 0, version: 0n }]);
  });

  /** A withdrawn file stops counting as one and stops being owed. */
  it('moves a withdrawal out of files and out of pending', () => {
    expect(deltasOf([{ was: state(), now: state({ confirmed: false }) }]))
      .toMatchObject([{ partitionId: 1, files: -1, bytes: -10, pending: -1, pendingBytes: -10, withdrawn: 1 }]);
  });

  /**
   * A file whose date or series moved is two keys, not one — taken out of where
   * it was and added to where it now is. Nothing special is needed for it.
   */
  it('moves a file that changed partition', () => {
    const [from, to] = deltasOf([{ was: state(), now: state({ partitionId: 2 }) }]);

    expect(from).toMatchObject({ partitionId: 1, files: -1, bytes: -10, pending: -1, pendingBytes: -10, withdrawn: 0 });
    expect(to).toMatchObject({ partitionId: 2, files: 1, bytes: 10, pending: 1, pendingBytes: 10, withdrawn: 0 });
    expect(from!.version).toBe(-to!.version);
  });

  /** A re-walk that finds everything unchanged must not write a row. */
  it('says nothing about a batch that changed nothing', () => {
    expect(deltasOf([{ was: state(), now: state() }])).toEqual([]);
  });

  it('folds a batch into one row per partition', async () => {
    const many = Array.from({ length: 500 }, (_, at) => ({ was: null, now: state() }));

    expect(deltasOf(many)).toHaveLength(1);
    expect(deltasOf(many)[0]).toMatchObject({ files: 500, bytes: 5_000, pending: 500 });
  });
});

describe('a version', () => {
  const added = (over: Partial<FileState> = {}): bigint =>
    deltasOf([{ was: null, now: state(over) }])[0]!.version;

  /** The same files, whatever order they arrived in. */
  it('is the same in any order', () => {
    const a = state({ etag: 'a' }), b = state({ etag: 'b' });

    const one = deltasOf([{ was: null, now: a }, { was: null, now: b }]);
    const two = deltasOf([{ was: null, now: b }, { was: null, now: a }]);

    expect(one[0]!.version).toBe(two[0]!.version);
    expect(one[0]!.version).toBe(added({ etag: 'a' }) + added({ etag: 'b' }));
  });

  /** The ETag is the bytes, so it alone says which file this is. */
  it('tells two files apart by ETag, and by nothing else', () => {
    expect(added()).not.toBe(added({ etag: 'v2' }));
    expect(added()).toBe(added({ bytes: 11 }));
  });

  /** What a withdrawal takes out is exactly what the arrival put in. */
  it('returns to where it was when a file is withdrawn', () => {
    const gone = deltasOf([{ was: state(), now: state({ confirmed: false }) }])[0]!.version;

    expect(added() + gone).toBe(0n);
  });

  it('is sixteen hex digits, wrapped at 64 bits', () => {
    expect(versionOf(0n)).toBe(EMPTY);
    expect(versionOf(-1n)).toBe('ffffffffffffffff');
    expect(versionOf(2n ** 64n + 5n)).toBe('0000000000000005');
  });
});

describe('what the write paths maintain', () => {
  const seed = async () => {
    putVenue(db, 'binance', 'https://x', '');
    await putFiles(db, [file('spot/a-2025-03.zip'), file('spot/b-2025-03.zip')]);
  };

  it('counts files as a survey records them', async () => {
    await seed();

    expect(held()).toEqual([
      { month: '202503', files: 2, bytes: 20, pending: 2, pendingBytes: 20, withdrawn: 0 },
    ]);
  });

  it('does not double count a re-walk', async () => {
    await seed();

    const [before] = versions();

    await seed();

    expect(held()[0]).toMatchObject({ files: 2, pending: 2 });
    expect(versions()).toEqual([before]);
  });

  /** A download moves what is pending: neither the version nor when it last moved. */
  it('follows a download without moving the version', async () => {
    await seed();

    const [version] = versions();
    const [stamp]   = stamps();

    markDownloaded(db, [{ venueId: 1, path: 'spot/a-2025-03.zip' }], 'D1');

    expect(held()[0]).toMatchObject({ files: 2, pending: 1 });
    expect(versions()).toEqual([version]);
    expect(stamps()).toEqual([stamp]);
  });

  /** Reporting the same file twice must not take it out of pending twice. */
  it('ignores a download reported again', async () => {
    await seed();
    markDownloaded(db, [{ venueId: 1, path: 'spot/a-2025-03.zip' }], 'D1');
    markDownloaded(db, [{ venueId: 1, path: 'spot/a-2025-03.zip' }], 'D2');

    expect(held()[0]).toMatchObject({ pending: 1 });
    expect(db.prepare(`SELECT downloaded_at FROM file WHERE path = 'spot/a-2025-03.zip'`).get())
      .toMatchObject({ downloaded_at: 'D1' });
  });

  it('follows a withdrawal', async () => {
    await seed();

    const [before] = versions();

    await putFiles(db, [file('spot/a-2025-03.zip', { seenAt: 'T2' })], { venueId: 1, low: 'spot/', lowOpen: false, high: 'spot0', highOpen: true });

    expect(held()[0]).toMatchObject({ files: 1, pending: 1, withdrawn: 1 });
    expect(versions()).not.toEqual([before]);
  });

  /** A changed file is owed again, and is a different file to the version. */
  it('puts a changed file back into pending, at a new version', async () => {
    await seed();
    markDownloaded(db, [{ venueId: 1, path: 'spot/a-2025-03.zip' }, { venueId: 1, path: 'spot/b-2025-03.zip' }], 'D1');

    expect(held()[0]).toMatchObject({ pending: 0 });

    const [before] = versions();

    await putFiles(db, [file('spot/a-2025-03.zip', { seenAt: 'T2', size: 99, etag: 'v2' })]);

    expect(held()[0]).toMatchObject({ files: 2, bytes: 109, pending: 1 });
    expect(versions()).not.toEqual([before]);
  });

  /** A partition whose every file is withdrawn holds nothing, and says so. */
  it('is back at the empty version once every file is withdrawn', async () => {
    await seed();
    withdrawFile(db, 1, 'spot/a-2025-03.zip');
    withdrawFile(db, 1, 'spot/b-2025-03.zip');

    expect(held()[0]).toMatchObject({ files: 0, bytes: 0, withdrawn: 2 });
    expect(versions()).toEqual([EMPTY]);
  });

  /**
   * **A venue that moves a file has published nothing new.** The old path is
   * withdrawn and the new one arrives, and the partition holds what it held.
   */
  it('stays where it was when a file only changes its path', async () => {
    await seed();

    const [before] = versions();

    withdrawFile(db, 1, 'spot/a-2025-03.zip');
    await putFiles(db, [file('renamed/a-2025-03.zip')]);

    expect(held()[0]).toMatchObject({ files: 2, withdrawn: 1 });
    expect(versions()).toEqual([before]);
  });

  /** The same files reach the same version however they got there. */
  it('reaches one version by two roads', async () => {
    await seed();
    correctFile(db, 1, 'spot/a-2025-03.zip', { size: 99, etag: 'v2', modified: null }, 'T2', false);

    const [corrected] = versions();

    db.exec('DELETE FROM file; DELETE FROM partition');

    await putFiles(db, [file('spot/b-2025-03.zip'), file('spot/a-2025-03.zip', { size: 99, etag: 'v2' })]);

    expect(versions()).toEqual([corrected]);
  });

  /** A file is filed under the partition of its own month, one row a month. */
  it('gives each month of a slice a partition of its own', async () => {
    putVenue(db, 'binance', 'https://x', '');
    await putFiles(db, [file('spot/a-2025-03.zip'), file('spot/b-2025-04.zip', { date: '20250401' })]);

    expect(held()).toMatchObject([{ month: '202503', files: 1 }, { month: '202504', files: 1 }]);

    expect(db.prepare(
      `SELECT count(*) AS n FROM file f JOIN partition q ON q.id = f.partition_id
        WHERE q.month <> substr(f.date, 1, 6)`).get()).toEqual({ n: 0 });
  });

  /** A file whose date moved leaves one partition and joins another. */
  it('moves a file whose date changed month', async () => {
    await seed();
    await putFiles(db, [file('spot/a-2025-03.zip', { date: '20250401', seenAt: 'T2' })]);

    expect(held()).toMatchObject([{ month: '202503', files: 1 }, { month: '202504', files: 1 }]);
    expect(counted()).toEqual(recount());
  });
});

/**
 * Every counter moves in the same transaction as its row, but a call site nobody
 * wired is silent — so the only honest answer is to be able to check.
 */
describe('the partitions match the rows', () => {
  it('agrees with a recount after every kind of write', async () => {
    putVenue(db, 'binance', 'https://x', '');
    await putFiles(db, [file('spot/a-2025-03.zip'), file('spot/b-2025-04.zip', { date: '20250401' })]);
    markDownloaded(db, [{ venueId: 1, path: 'spot/a-2025-03.zip' }], 'D1');

    expect(counted()).toEqual(recount());
  });

  /**
   * **A probe can settle onto a row the catalog already holds**, and counting
   * that as an arrival is how the counters drift above the table they describe.
   * Measured on the real catalog before this was fixed: 1,937,264 files
   * over-counted, 0.59%.
   *
   * **The backlog row is written directly here, because parking now refuses
   * it.** `park` will not queue a key whose file the catalog already holds, so
   * the state this guards against is one the current writers no longer produce —
   * it is what every update produced before that check existed, and what any
   * relaxation of it would produce again. The accounting has to be right on its
   * own, not because one caller happens to be careful.
   */
  it('does not count a settlement onto a file it already had', async () => {
    putVenue(db, 'binance', 'https://x', '');

    const series = seriesOn(1);

    await putFiles(db, [file('spot/a-2025-03.zip')]);
    expect(held()[0]).toMatchObject({ files: 1 });

    db.prepare(
      `INSERT INTO wip (venue_id, path, date, series_id, existence, created_at)
            VALUES (1, 'spot/a-2025-03.zip', '20250301', ?, 'assumed', 'T1')`,
    ).run(series);

    settleFiles(db, [{
      venueId: 1, path: 'spot/a-2025-03.zip',
      size: 10, etag: 'e', modified: null, seenAt: 'T2',
    }]);

    expect(held()[0]).toMatchObject({ files: 1 });
    expect(counted()).toEqual(recount());
  });
});
