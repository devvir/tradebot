import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  anyUnsettled, countUnsettled, dropWip, markWithdrawn, parkKeys, putFiles, putVenue,
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

/** What the venue rollup holds for venue 1, month by month. */
const rollup = () =>
  db.prepare(
    `SELECT month, files, bytes, pending, pending_bytes AS pendingBytes, withdrawn
       FROM rollup_venue WHERE venue_id = 1 ORDER BY month`,
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
    expect(rollup()[0]).toMatchObject({ files: 1, pending: 1 });
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

    markWithdrawn(db, 1, 'p/', 'p0', 'T9');

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
    // Everything under `x/` that nothing has seen since, which is this one file.
    markWithdrawn(db, 1, 'x/', 'x0', 'T9');

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
