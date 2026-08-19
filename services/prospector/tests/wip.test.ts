import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { markWithdrawn, putFiles, putVenue, recordSeries, settleFiles, unsettled } from '../src/catalog';
import { openCatalog } from '../src/database';
import { months } from '../src/catalog/cache/months';
import type { CatalogFile } from '../src/types';
import type { DatabaseSync } from 'node:sqlite';

/**
 * A finding lands wherever it is ready for. What matters is that `file` ends up
 * holding exactly one kind of row — so nothing downstream has to know that a
 * walk of an index says less than a walk of a bucket.
 */

let dir: string;
let db:  DatabaseSync;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'wip-'));
  db  = openCatalog(join(dir, 'catalog.db'), { seedData: false });
  putVenue(db, 'bybit', 'https://x', '');
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

/** What a listing venue offers: everything stated. */
const stated = (path: string, over: Partial<CatalogFile> = {}): CatalogFile => ({
  venueId: 1, path, date: '20250301', size: 10, etag: 'e',
  modified: null, existence: 'confirmed', seenAt: 'T1',
  seriesId: seriesOn(over.venueId ?? 1), ...over,
});

/** What an index venue offers: a name. */
const bare = (path: string, over: Partial<CatalogFile> = {}): CatalogFile =>
  stated(path, { size: null, etag: null, modified: null, ...over });

const count = (table: string): number =>
  (db.prepare(`SELECT count(*) n FROM ${table}`).get() as { n: number }).n;

describe('where a finding lands', () => {
  it('catalogues one that arrived complete', async () => {
    await putFiles(db, [stated('spot/a.zip')]);

    expect(count('file')).toBe(1);
    expect(count('wip')).toBe(0);
  });

  it('parks one that stated nothing', async () => {
    await putFiles(db, [bare('orderbook/a.zip')]);

    expect(count('file')).toBe(0);
    expect(count('wip')).toBe(1);
  });

  /**
   * Half is not enough: `bytes` is a real total only if every row has a size,
   * and a downloader can check what it received only against a checksum.
   */
  it('parks one that stated only a size', async () => {
    await putFiles(db, [bare('orderbook/a.zip', { size: 99 })]);

    expect(count('file')).toBe(0);
    expect(db.prepare('SELECT size FROM wip').get()).toMatchObject({ size: 99 });
  });

  /** Nothing parked is counted, so a venue mid-probe reads as zero rather than wrong. */
  it('counts nothing while it is parked', async () => {
    await putFiles(db, [bare('orderbook/a.zip')]);

    expect(months(db, 1)).toEqual([]);
  });
});

/**
 * The rule that would cost the most to get wrong: an index venue re-offers the
 * same bare names on every walk, so routing on the sighting alone would drag
 * every settled file back into the queue, once per refresh, for ever.
 */
describe('ready stays ready', () => {
  const settled = async () => {
    await putFiles(db, [bare('orderbook/a.zip')]);
    settleFiles(db, [{
      venueId: 1, path: 'orderbook/a.zip', size: 10, etag: 'e', modified: null, seenAt: 'T2',
    }]);
  };

  it('does not send a catalogued file back to the queue', async () => {
    await settled();
    expect(count('file')).toBe(1);

    // The next walk offers the same name, saying nothing about it again.
    await putFiles(db, [bare('orderbook/a.zip', { seenAt: 'T3' })]);

    expect(count('file')).toBe(1);
    expect(count('wip')).toBe(0);
    expect(unsettled(db, 1, 0, 10)).toHaveLength(0);
  });

  it('still notes that the venue offered it', async () => {
    await settled();
    await putFiles(db, [bare('orderbook/a.zip', { seenAt: 'T3' })]);

    expect(db.prepare('SELECT last_seen FROM file').get()).toMatchObject({ last_seen: 'T3' });
  });

  /** A venue that starts stating metadata promotes the file without a probe. */
  it('unparks one the venue finally described', async () => {
    await putFiles(db, [bare('orderbook/a.zip')]);
    await putFiles(db, [stated('orderbook/a.zip', { seenAt: 'T2' })]);

    expect(count('wip')).toBe(0);
    expect(count('file')).toBe(1);
    expect(months(db, 1)[0]).toMatchObject({ files: 1, pending: 1 });
  });
});

describe('arriving', () => {
  it('keeps first discovery from when it was found, not when it was settled', async () => {
    await putFiles(db, [bare('orderbook/a.zip', { seenAt: 'T1' })]);
    settleFiles(db, [{
      venueId: 1, path: 'orderbook/a.zip', size: 10, etag: 'e', modified: null, seenAt: 'T9',
    }]);

    expect(db.prepare('SELECT seen_at, last_seen FROM file').get())
      .toMatchObject({ seen_at: 'T1', last_seen: 'T9' });
  });

  it('starts owed, and counted', async () => {
    await putFiles(db, [bare('orderbook/a.zip')]);
    settleFiles(db, [{
      venueId: 1, path: 'orderbook/a.zip', size: 64, etag: 'e', modified: null, seenAt: 'T2',
    }]);

    expect(db.prepare('SELECT downloaded_at FROM file').get())
      .toMatchObject({ downloaded_at: null });
    expect(months(db, 1)[0]).toMatchObject({ files: 1, bytes: 64, pending: 1, pendingBytes: 64 });
  });

  /** A HEAD that answered without a checksum is progress, not an arrival. */
  it('stays parked when a settlement still says too little', async () => {
    await putFiles(db, [bare('orderbook/a.zip')]);

    const moved = settleFiles(db, [{
      venueId: 1, path: 'orderbook/a.zip', size: 64, etag: null, modified: null, seenAt: 'T2',
    }]);

    expect(moved).toBe(0);
    expect(count('wip')).toBe(1);
    expect(db.prepare('SELECT size FROM wip').get()).toMatchObject({ size: 64 });
  });
});

/**
 * A file the venue dropped before anyone probed it would otherwise sit in the
 * queue for ever, asking about a key that is no longer served.
 */
describe('withdrawal', () => {
  it('reaches what was never catalogued', async () => {
    await putFiles(db, [bare('orderbook/a.zip', { seenAt: 'T1' })]);
    await putFiles(db, [bare('orderbook/b.zip', { seenAt: 'T2' })]);

    markWithdrawn(db, 1, 'orderbook/', 'orderbook0', 'T2');

    expect(count('wip')).toBe(1);
    expect(unsettled(db, 1, 0, 10).map(row => row.path)).toEqual(['orderbook/b.zip']);
  });
});
