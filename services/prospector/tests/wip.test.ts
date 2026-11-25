import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  anyUnsettled, countUnsettled, dropWip, parkKeys, putFiles, putVenue,
  recordSeries, settleFiles, unsettled,
} from '../src/catalog';
import * as wip from '../src/catalog/wip';
import { openCatalog } from '../src/database';
import type { CatalogFile, Parking } from '../src/types';
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

/** What the partitions hold, month by month. */
const rollup = () =>
  db.prepare(
    `SELECT month, files, bytes, pending, pending_bytes AS pendingBytes, withdrawn
       FROM partition ORDER BY month`,
  ).all();

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

    expect(rollup()).toEqual([]);
  });
});

/**
 * The rule that would cost the most to get wrong: an index venue re-offers the
 * same bare names on every walk, so routing on the sighting alone would drag
 * every settled file back into the queue, once per refresh, for ever.
 */
/** `file` holds what a venue serves or withdrew; a key nobody has seen is never catalogued. */
it('refuses a page offering a ready file that is only assumed, writing none of it', async () => {
  await expect(putFiles(db, [stated('a.zip'), stated('b.zip', { existence: 'assumed' })]))
    .rejects.toThrow(/b\.zip/);

  expect(count('file')).toBe(0);
});

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

  /** The row already says more than a bare name does, so nothing is written. */
  it('writes nothing when the venue offers it again', async () => {
    await settled();

    const before = (db.prepare('SELECT total_changes() AS n').get() as { n: number }).n;

    await putFiles(db, [bare('orderbook/a.zip', { seenAt: 'T3' })]);

    expect((db.prepare('SELECT total_changes() AS n').get() as { n: number }).n).toBe(before);
  });

  /** A venue that starts stating metadata promotes the file without a probe. */
  it('unparks one the venue finally described', async () => {
    await putFiles(db, [bare('orderbook/a.zip')]);
    await putFiles(db, [stated('orderbook/a.zip', { seenAt: 'T2' })]);

    expect(count('wip')).toBe(0);
    expect(count('file')).toBe(1);
    expect(rollup()[0]).toMatchObject({ files: 1, pending: 1 });
  });
});

describe('arriving', () => {
  it('keeps first discovery from when it was found, not when it was settled', async () => {
    await putFiles(db, [bare('orderbook/a.zip', { seenAt: 'T1' })]);
    settleFiles(db, [{
      venueId: 1, path: 'orderbook/a.zip', size: 10, etag: 'e', modified: null, seenAt: 'T9',
    }]);

    expect(db.prepare('SELECT seen_at FROM file').get()).toMatchObject({ seen_at: 'T1' });
  });

  /** Offering a parked key again is not discovering it again. */
  it('keeps first discovery through a key offered again while parked', async () => {
    await putFiles(db, [bare('orderbook/a.zip', { seenAt: 'T1' })]);
    await putFiles(db, [bare('orderbook/a.zip', { seenAt: 'T5' })]);
    settleFiles(db, [{
      venueId: 1, path: 'orderbook/a.zip', size: 10, etag: 'e', modified: null, seenAt: 'T9',
    }]);

    expect(db.prepare('SELECT seen_at FROM file').get()).toMatchObject({ seen_at: 'T1' });
  });

  it('keeps first discovery when a later listing describes a parked key', async () => {
    await putFiles(db, [bare('orderbook/a.zip', { seenAt: 'T1' })]);
    await putFiles(db, [stated('orderbook/a.zip', { seenAt: 'T5' })]);

    expect(db.prepare('SELECT seen_at FROM file').get()).toMatchObject({ seen_at: 'T1' });
  });

  it('starts owed, and counted', async () => {
    await putFiles(db, [bare('orderbook/a.zip')]);
    settleFiles(db, [{
      venueId: 1, path: 'orderbook/a.zip', size: 64, etag: 'e', modified: null, seenAt: 'T2',
    }]);

    expect(db.prepare('SELECT downloaded_at FROM file').get())
      .toMatchObject({ downloaded_at: null });
    expect(rollup()[0]).toMatchObject({ files: 1, bytes: 64, pending: 1, pendingBytes: 64 });
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

  /**
   * **A batch arrives whole or not at all.** A settlement that fails part way
   * takes back the arrivals before it in the same batch, so the backlog, the
   * catalog and the figures that sum it all stay as they were.
   */
  it('leaves backlog, catalog and counts as they were where a settlement fails', async () => {
    await putFiles(db, [bare('orderbook/a.zip'), bare('orderbook/b.zip')]);

    expect(countUnsettled(db, 1)).toBe(2);

    expect(() => settleFiles(db, [
      { venueId: 1, path: 'orderbook/a.zip', size: 10, etag: 'e', modified: null, seenAt: 'T2' },
      { venueId: 1, path: 'orderbook/b.zip', size: 'big' as unknown as number, etag: 'e', modified: null, seenAt: 'T2' },
    ])).toThrow(/INTEGER/);

    expect(db.isTransaction).toBe(false);
    expect(count('file')).toBe(0);
    expect(count('wip')).toBe(2);
    expect(countUnsettled(db, 1)).toBe(2);
    expect(rollup()).toEqual([]);

    expect(settleFiles(db, [
      { venueId: 1, path: 'orderbook/a.zip', size: 10, etag: 'e', modified: null, seenAt: 'T2' },
      { venueId: 1, path: 'orderbook/b.zip', size: 20, etag: 'e', modified: null, seenAt: 'T2' },
    ])).toBe(2);

    expect(countUnsettled(db, 1)).toBe(0);
    expect(rollup()).toMatchObject([{ files: 2, bytes: 30 }]);
  });

  /**
   * **What fails after the commit fails as itself.** Each arrival moves its
   * series' bounds, and enough of them write the bounds out there and then; a
   * failure in that write is reported as it is, with the arrivals it followed
   * committed and counted.
   */
  it('reports a failure after the commit as itself, with the arrivals kept', () => {
    const rows = Array.from({ length: 1_000 }, (_, n) => ({
      venueId: 1, path: `x/${n}.zip`, date: '20250301', existence: 'assumed' as const, tries: 0,
      seriesId: recordSeries(db, 1, {
        market: 'perp', dataset: 'klines', symbol: `S${n}`, pattern: 'p/{YYYY}{MM}/{SYMBOL}.zip',
      }, { first: null }).id!,
    }));

    parkKeys(db, rows);

    db.exec(`CREATE TRIGGER series_boom BEFORE UPDATE ON series BEGIN SELECT RAISE(ABORT, 'boom'); END`);

    expect(() => settleFiles(db, rows.map(row => ({
      venueId: 1, path: row.path, size: 1, etag: 'e', modified: null, seenAt: 'T2',
    })))).toThrow(/^boom$/);

    expect(count('file')).toBe(1_000);
    expect(count('wip')).toBe(0);
    expect(countUnsettled(db, 1)).toBe(0);
    expect(db.isTransaction).toBe(false);
  });
});

/**
 * A file the venue dropped before anyone probed it would otherwise sit in the
 * queue for ever, asking about a key that is no longer served.
 */
describe('withdrawal', () => {
  /**
   * **A directory index states its own files and nothing below them.** A parked
   * key directly inside it that the page did not offer has gone; one inside a
   * subdirectory it still links is that subdirectory's page to judge.
   */
  it('drops a directory\'s own parked keys the page left out, and not its children\'s', async () => {
    await putFiles(db, [bare('d/own.zip'), bare('d/kept.zip'), bare('d/A/deep.zip')]);

    expect(countUnsettled(db, 1)).toBe(3);

    await putFiles(db, [bare('d/kept.zip')], { venueId: 1, directory: 'd/', children: ['d/A/'] });

    expect(unsettled(db, 1, 0, 10).map(row => row.path).sort()).toEqual(['d/A/deep.zip', 'd/kept.zip']);
    expect(countUnsettled(db, 1)).toBe(count('wip'));
  });

  it('reaches what was never catalogued', async () => {
    await putFiles(db, [bare('orderbook/a.zip', { seenAt: 'T1' })]);
    await putFiles(db, [bare('orderbook/b.zip', { seenAt: 'T2' })], { venueId: 1, low: 'orderbook/', lowOpen: false, high: 'orderbook0', highOpen: true });

    expect(count('wip')).toBe(1);
    expect(unsettled(db, 1, 0, 10).map(row => row.path)).toEqual(['orderbook/b.zip']);
  });
});


/**
 * The maintained count.
 *
 * **Its whole reason is that the honest answer is unaffordable.** `count(*)`
 * over a backlog of tens of millions takes nearly two seconds, and `node:sqlite`
 * is synchronous — so asking it on a status poll froze every venue in the
 * process. The count is therefore kept as rows move, which is only safe while
 * one module owns the table.
 *
 * What these check is the part that would fail silently: a figure that drifts
 * reads as a finished drain, because the drain stops when it reaches zero.
 */
describe('the backlog count', () => {
  it('matches the table as rows are parked and dropped', async () => {
    const venueId = 1;

    await putFiles(db, [bare('a.zip'), bare('b.zip'), bare('c.zip')]);

    expect(countUnsettled(db, venueId)).toBe(count('wip'));
    expect(countUnsettled(db, venueId)).toBe(3);

    dropWip(db, unsettled(db, venueId, 0, 2));

    expect(countUnsettled(db, venueId)).toBe(count('wip'));
    expect(countUnsettled(db, venueId)).toBe(1);
  });

  it('does not double-count a key the venue offers again', async () => {
    await putFiles(db, [bare('a.zip')]);
    await putFiles(db, [bare('a.zip')]);

    expect(countUnsettled(db, 1)).toBe(count('wip'));
    expect(countUnsettled(db, 1)).toBe(1);
  });

  it('follows a key out of the backlog when it is settled', async () => {
    await putFiles(db, [bare('a.zip')]);

    settleFiles(db, [{ venueId: 1, path: 'a.zip', size: 10, etag: 'e',
      modified: null, existence: 'confirmed', seenAt: 'T2' }]);

    expect(countUnsettled(db, 1)).toBe(count('wip'));
    expect(countUnsettled(db, 1)).toBe(0);
  });

  it('follows a withdrawal that empties a range', async () => {
    await putFiles(db, [bare('p/a.zip'), bare('p/b.zip')]);
    await putFiles(db, [], { venueId: 1, low: 'p/', lowOpen: false, high: 'p0', highOpen: true });

    expect(countUnsettled(db, 1)).toBe(count('wip'));
  });

  /**
   * The rule that makes the rest of it safe: a figure seeded from one catalog
   * must never be reported about another. Venue ids repeat across databases.
   */
  it('is held against the connection, not the venue id', async () => {
    await putFiles(db, [bare('a.zip'), bare('b.zip')]);

    expect(countUnsettled(db, 1)).toBe(2);

    const other = mkdtempSync(join(tmpdir(), 'wip-other-'));
    const second = openCatalog(join(other, 'catalog.db'), { seedData: false });

    putVenue(second, 'bybit', 'https://x', '');

    expect(countUnsettled(second, 1)).toBe(0);

    second.close();
    rmSync(other, { recursive: true, force: true });
  });

  /** Asked before anything moved, it still has to agree with the table. */
  it('reads the table when nothing has asked yet', async () => {
    await putFiles(db, [bare('a.zip'), bare('b.zip')]);

    wip.recount(db);

    expect(countUnsettled(db, 1)).toBe(2);
  });

  it('answers whether anything is left without counting', async () => {
    expect(wip.anyParked(db, 1)).toBe(false);

    await putFiles(db, [bare('a.zip')]);

    expect(wip.anyParked(db, 1)).toBe(true);

    dropWip(db, unsettled(db, 1, 0, 10));

    expect(wip.anyParked(db, 1)).toBe(false);
  });

  it('counts keys parked by an adapter rule the same way', async () => {
    const seriesId = seriesOn(1);

    parkKeys(db, [
      { venueId: 1, path: 'x/1.zip', date: '20250301', seriesId, existence: 'assumed', tries: 0 },
      { venueId: 1, path: 'x/2.zip', date: '20250302', seriesId, existence: 'assumed', tries: 0 },
      { venueId: 1, path: 'x/3.zip', date: '20250303', seriesId, existence: 'assumed', tries: 0 },
    ]);

    expect(countUnsettled(db, 1)).toBe(count('wip'));

    wip.dropAbove(db, 1, seriesId, '20250301');

    expect(countUnsettled(db, 1)).toBe(count('wip'));
    expect(countUnsettled(db, 1)).toBe(1);
  });
});


/**
 * Parking in batches.
 *
 * **An update generates nothing but backlog rows**, so its pages need neither
 * `file` nor the month rollup — and paying a slice of the shared write queue per
 * series, sixteen rows at a time, is what made generating slower than draining.
 * They wait for company instead.
 *
 * The invariant that matters is unchanged: the promise a caller awaits means
 * *committed*, because a cursor advances on it.
 */
/**
 * **Generation reads the tip and nothing else**, so an update re-emits every key
 * in the patience window whether or not its file arrived days ago. Probing those
 * again could not change anything either — settling only acts on parked rows —
 * so the question is asked once, here, where the row is still cheap to not
 * write.
 */
describe('a key the catalog already holds', () => {
  it('is not parked', async () => {
    const seriesId = seriesOn(1);

    await putFiles(db, [stated('x/1.zip', { seriesId })]);

    parkKeys(db, [
      { venueId: 1, path: 'x/1.zip', date: '20250301', seriesId, existence: 'assumed', tries: 0 },
      { venueId: 1, path: 'x/2.zip', date: '20250302', seriesId, existence: 'assumed', tries: 0 },
    ]);

    expect(unsettled(db, 1, 0, 10).map(one => one.path)).toEqual(['x/2.zip']);
  });

  /** The count follows, or the backlog reads as work nobody is doing. */
  it('leaves the backlog count where it was', async () => {
    const seriesId = seriesOn(1);

    await putFiles(db, [stated('x/1.zip', { seriesId })]);
    parkKeys(db, [
      { venueId: 1, path: 'x/1.zip', date: '20250301', seriesId, existence: 'assumed', tries: 0 },
    ]);

    expect(countUnsettled(db, 1)).toBe(0);
    expect(countUnsettled(db, 1)).toBe(count('wip'));
  });

  /**
   * **A file withdrawn is not a file held.** Its row stays as a record that the
   * venue once served it, and asking again is the only way to learn it is back.
   */
  it('is parked again once the venue has withdrawn it', async () => {
    const seriesId = seriesOn(1);

    await putFiles(db, [stated('x/1.zip', { seriesId })]);
    // A page over `x/` that no longer lists it.
    await putFiles(db, [], { venueId: 1, low: 'x/', lowOpen: false, high: 'x0', highOpen: true });

    parkKeys(db, [
      { venueId: 1, path: 'x/1.zip', date: '20250301', seriesId, existence: 'assumed', tries: 0 },
    ]);

    expect(countUnsettled(db, 1)).toBe(1);
  });
});

describe('parking in batches', () => {
  const keys = (n: number, from = 0): Parking[] => {
    const seriesId = seriesOn(1);

    return Array.from({ length: n }, (_, at) => ({
      venueId:   1,
      path:      `b/${from + at}.zip`,
      date:      '20250301',
      seriesId,
      existence: 'assumed' as const,
      tries:     0,
    }));
  };

  it('has written the rows by the time it resolves', async () => {
    await wip.parkSoon(db, keys(3));

    expect(count('wip')).toBe(3);
  });

  it('puts several callers into one batch', async () => {
    await Promise.all([
      wip.parkSoon(db, keys(2, 0)),
      wip.parkSoon(db, keys(2, 10)),
      wip.parkSoon(db, keys(2, 20)),
    ]);

    expect(count('wip')).toBe(6);
    expect(countUnsettled(db, 1)).toBe(6);
  });

  it('keeps the count exact across batches', async () => {
    await wip.parkSoon(db, keys(4));
    await wip.parkSoon(db, keys(4, 100));

    expect(countUnsettled(db, 1)).toBe(count('wip'));
    expect(countUnsettled(db, 1)).toBe(8);
  });

  it('does not count a key that was already parked', async () => {
    await wip.parkSoon(db, keys(2));
    await wip.parkSoon(db, keys(2));

    expect(countUnsettled(db, 1)).toBe(count('wip'));
    expect(countUnsettled(db, 1)).toBe(2);
  });

  it('resolves nothing to do without touching the table', async () => {
    expect(await wip.parkSoon(db, [])).toBe(0);
    expect(count('wip')).toBe(0);
  });

  /** The exit has no turn of the loop left to give, so this one is synchronous. */
  it('writes what is waiting when told to flush', () => {
    void wip.parkSoon(db, keys(5));

    expect(wip.flushParked(db)).toBe(5);
    expect(count('wip')).toBe(5);
    expect(countUnsettled(db, 1)).toBe(5);
  });

  it('has nothing to flush once a batch has gone down', async () => {
    await wip.parkSoon(db, keys(2));

    expect(wip.flushParked(db)).toBe(0);
  });

  /**
   * **Enough rows are a batch of their own**, written without waiting for the
   * timer; fewer wait for company until it fires. The timers are the test's,
   * so only the row count can have sent the first batch down.
   */
  it('writes a full batch at once, and a short one when its wait is up', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });

    try {
      await wip.parkSoon(db, keys(2_000));

      expect(count('wip')).toBe(2_000);

      let done = false;
      const short = wip.parkSoon(db, keys(5, 10_000)).then(n => { done = true; return n; });

      for (let turn = 0; turn < 5; turn++) await new Promise(resolve => setImmediate(resolve));

      expect(done).toBe(false);
      expect(count('wip')).toBe(2_000);

      vi.advanceTimersByTime(25);

      expect(await short).toBe(5);
      expect(count('wip')).toBe(2_005);
    } finally {
      vi.useRealTimers();
    }
  });

  /**
   * **A failed batch fails every caller in it**, since each was promised that
   * its rows were written — and none of them were. The next batch starts clean.
   */
  it('rejects every caller sharing a batch that failed', async () => {
    expect(countUnsettled(db, 1)).toBe(0);

    const orphan = keys(1, 50).map(row => ({ ...row, seriesId: 999_999 }));

    const outcomes = await Promise.allSettled([wip.parkSoon(db, orphan), wip.parkSoon(db, keys(2))]);

    expect(outcomes.map(one => one.status)).toEqual(['rejected', 'rejected']);
    expect(count('wip')).toBe(0);
    expect(countUnsettled(db, 1)).toBe(0);
    expect(db.isTransaction).toBe(false);

    expect(await wip.parkSoon(db, keys(2))).toBe(2);
    expect(countUnsettled(db, 1)).toBe(2);
  });

  /** At the exit a slice may be mid-write, so the flush joins it and commits or rolls back with it. */
  it('writes inside a transaction already open, leaving the outcome to its owner', async () => {
    const waiting = wip.parkSoon(db, keys(3));

    db.exec('BEGIN');

    expect(wip.flushParked(db)).toBe(3);
    expect(db.isTransaction).toBe(true);

    db.exec('ROLLBACK');

    expect(await waiting).toBe(3);
    expect(count('wip')).toBe(0);

    void wip.parkSoon(db, keys(3));

    db.exec('BEGIN');
    wip.flushParked(db);
    db.exec('COMMIT');

    expect(count('wip')).toBe(3);
  });
});

/**
 * The counter against the table, when both halves of a pass are running.
 *
 * **This is the shape that hung okx and bitget**, not an invented one: a probe
 * settles rows in the gap a slice leaves behind, and the count of what it
 * removed reaches the counter before the count of what put them there.
 */
describe('draining while the generator is still writing', () => {
  const keys = (n: number, from = 0): Parking[] => {
    const seriesId = seriesOn(1);

    return Array.from({ length: n }, (_, at) => ({
      venueId:   1,
      path:      `r/${from + at}.zip`,
      date:      '20250301',
      seriesId,
      existence: 'assumed' as const,
      tries:     0,
    }));
  };

  /** Empty the backlog exactly as a probe does: settle everything parked. */
  const drain = (): number => {
    const owed = unsettled(db, 1, 0, 1000);

    if (owed.length === 0) return 0;

    return dropWip(db, owed);
  };

  it('does not count rows that were drained before the batch finished', async () => {
    // The drain asks constantly, so in service the counter is always seeded.
    expect(countUnsettled(db, 1)).toBe(0);

    let done = false;

    const writing = wip.parkSoon(db, keys(40)).then(() => { done = true; });

    /**
     * **Drain whenever rows are visible, until the batch resolves** — which is
     * what a probe lane does, and it lands in the gap `slice` leaves between a
     * commit and its caller, where the rows are already there to take.
     */
    while (! done) {
      await new Promise(resolve => setImmediate(resolve));
      drain();
    }

    await writing;
    drain();

    expect(count('wip')).toBe(0);
    expect(countUnsettled(db, 1)).toBe(0);
  });

  it('never claims a backlog the table does not hold', async () => {
    await wip.parkSoon(db, keys(12, 500));
    drain();

    expect(count('wip')).toBe(0);
    expect(anyUnsettled(db, 1)).toBe(false);
  });

  /**
   * The guarantee the drain ends on: whatever the counter says, an empty table
   * answers no — and saying so repairs the counter rather than leaving it.
   */
  it('answers from the table and repairs a counter that disagrees', () => {
    wip.park(db, keys(3, 900));

    // Read first, so the counter is seeded and can then be left behind.
    expect(countUnsettled(db, 1)).toBe(3);

    db.exec('DELETE FROM wip');

    expect(countUnsettled(db, 1)).toBe(3);
    expect(anyUnsettled(db, 1)).toBe(false);
    expect(countUnsettled(db, 1)).toBe(0);
  });
});
