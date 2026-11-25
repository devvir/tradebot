import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  advanceRun, beginJob, closeRun, closeWalk, correctFile, enrol, lastRun, markDownloaded, openJob, openPartitions,
  pauseSurvey, producedSoFar, putFiles, putVenue, recordSeries, resetRuns, standingOf, venueIds, venueTotals,
} from '../src/catalog';
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
    expect(db.prepare('SELECT pending, pending_bytes AS pendingBytes, bytes FROM partition').get())
      .toEqual({ pending: 1, pendingBytes: 99, bytes: 99 });
  });

  it('says so when there is no such file', async () => {
    await seed();

    expect(correctFile(db, 1, 'nope.zip', { size: 1, etag: 'x', modified: null }, 'T2', true))
      .toBe(false);
  });
});

/**
 * Whether a venue is still being backfilled, which is the one thing a reader
 * wants that `kind` cannot say: a first pass reads everything and takes hours,
 * every pass after it reads the recent edge, and either can be a walk.
 *
 * **A venue, not a host.** Bybit publishes from two servers, and the distinction
 * only ever goes wrong there — which is why these are the tests that exist.
 */
describe('whether a pass is the venue\'s first', () => {
  /** Bybit's shape: one name, two servers, each with its own runs. */
  const twoHosts = () => [
    putVenue(db, 'bybit', 'https://a', '', 'primary'),
    putVenue(db, 'bybit', 'https://b', '', 'secondary'),
  ];

  const ran = (venueId: number, started: string, completed: string | null) =>
    db.prepare(
      `INSERT INTO run (venue_id, kind, scope, cursor, requests, found, started, completed)
            VALUES (?, 'walk', '', NULL, 0, 0, ?, ?)`,
    ).run(venueId, started, completed);

  it('calls a venue that has never finished anything a first pass', () => {
    const [a, b] = twoHosts();

    ran(a!, 'T1', null);
    ran(b!, 'T2', null);

    expect(lastRun(db, venueIds(db, 'bybit')).first).toBe(true);
  });

  /**
   * **The bug this replaced.** `first` used to mean "no pass started before this
   * one", so the host that started second reported its own backfill as a top-up
   * — on a fresh catalog, where both were minutes into their first walk.
   */
  it('does not call the later-starting host a top-up', () => {
    const [a, b] = twoHosts();

    ran(a!, '2026-09-25T14:49:40Z', null);
    ran(b!, '2026-09-25T14:50:39Z', null);

    const seen = lastRun(db, venueIds(db, 'bybit'));

    expect(seen.ongoing).toBe(true);
    expect(seen.first).toBe(true);
  });

  /** One host finishing says nothing while the other has never read itself through. */
  it('keeps backfilling while either host has never completed', () => {
    const [a, b] = twoHosts();

    ran(a!, 'T1', 'T3');
    ran(b!, 'T2', null);

    expect(lastRun(db, venueIds(db, 'bybit')).first).toBe(true);
  });

  it('is a top-up once every host has completed one', () => {
    const [a, b] = twoHosts();

    ran(a!, 'T1', 'T3');
    ran(b!, 'T2', 'T4');
    ran(b!, 'T5', null);

    expect(lastRun(db, venueIds(db, 'bybit')).first).toBe(false);
  });

  /** While a pass runs, the newest one that finished is what the venue last achieved. */
  it('names the newest finished pass while another runs', () => {
    const one = putVenue(db, 'solo', 'https://x', '');

    ran(one, 'T1', null);
    expect(lastRun(db, venueIds(db, 'solo')).previous).toBeNull();

    db.exec(`UPDATE run SET completed = 'T2' WHERE venue_id = ${one}`);
    expect(lastRun(db, venueIds(db, 'solo')).previous).toBeNull();

    ran(one, 'T3', null);
    expect(lastRun(db, venueIds(db, 'solo')).previous).toEqual({ at: 'T2', startedAt: 'T1', first: true });

    db.exec(`UPDATE run SET completed = 'T4' WHERE started = 'T3'`);
    ran(one, 'T5', null);
    expect(lastRun(db, venueIds(db, 'solo')).previous).toEqual({ at: 'T4', startedAt: 'T3', first: false });
  });

  /** The backfill ends when the last host first finishes, so what finished by then was part of it. */
  it('counts a pass as the backfill until every host has finished one', () => {
    const [a, b] = twoHosts();

    ran(a!, 'T1', 'T3');
    ran(b!, 'T2', null);
    expect(lastRun(db, venueIds(db, 'bybit')).previous).toEqual({ at: 'T3', startedAt: 'T1', first: true });

    db.exec(`UPDATE run SET completed = 'T4' WHERE started = 'T2'`);
    ran(a!, 'T5', 'T6');
    ran(b!, 'T7', null);
    expect(lastRun(db, venueIds(db, 'bybit')).previous).toEqual({ at: 'T6', startedAt: 'T5', first: false });
  });

  /** A venue with one server is the ordinary case and behaves as it always did. */
  it('reads a single-host venue the same way', () => {
    const one = putVenue(db, 'solo', 'https://x', '');

    ran(one, 'T1', null);
    expect(lastRun(db, venueIds(db, 'solo')).first).toBe(true);

    db.exec(`UPDATE run SET completed = 'T2' WHERE venue_id = ${one}`);
    ran(one, 'T3', null);

    expect(lastRun(db, venueIds(db, 'solo')).first).toBe(false);
  });
});

/** Where a venue stands, read off its enrolment and its runs. */
describe('a venue\'s standing', () => {
  const DAY = 86_400_000;

  const standing = (venue: string) => standingOf(db, venue, venueIds(db, venue), DAY);

  it('has not started where nobody enrolled it, whatever its runs say', () => {
    const id = putVenue(db, 'solo', 'https://x', '');

    beginJob(db, id, 'walk', ['a/']);

    expect(standing('solo')).toEqual({ state: 'not started', enrolledAt: null, since: null, during: null, nextRun: null });
  });

  it('is walking from the start of an open walk', () => {
    const id = putVenue(db, 'solo', 'https://x', '');

    enrol(db, 'solo', 'T0');

    const job = beginJob(db, id, 'walk', ['a/']);

    expect(standing('solo')).toEqual({ state: 'walking', enrolledAt: 'T0', since: job.started, during: null, nextRun: null });
  });

  /** One host still walking makes the venue walking, even beside a host that is updating. */
  it('walks while any host walks', () => {
    const [a, b] = [putVenue(db, 'bybit', 'https://a', '', 'one'), putVenue(db, 'bybit', 'https://b', '', 'two')];

    enrol(db, 'bybit', 'T0');
    beginJob(db, a!, 'update', ['1']);
    beginJob(db, b!, 'walk', ['a/']);

    expect(standing('bybit').state).toBe('walking');
  });

  it('is updating while only an update is open', () => {
    const id = putVenue(db, 'solo', 'https://x', '');

    enrol(db, 'solo', 'T0');
    beginJob(db, id, 'update', ['1']);

    expect(standing('solo').state).toBe('updating');
  });

  /** The interval runs from the start of the last pass, not its end. */
  it('waits between passes, due an interval after the last one began', () => {
    const id = putVenue(db, 'solo', 'https://x', '');

    enrol(db, 'solo', 'T0');

    const job = beginJob(db, id, 'walk', ['a/']);

    closeRun(db, openPartitions(db, id, 'walk')[0]!.id);
    closeWalk(db, id);

    expect(standing('solo')).toEqual({
      state: 'waiting', enrolledAt: 'T0', since: null, during: null,
      nextRun: new Date(Date.parse(job.started) + DAY).toISOString(),
    });
  });

  it('is paused since the pause, naming what it would go back to', () => {
    const id = putVenue(db, 'solo', 'https://x', '');

    enrol(db, 'solo', 'T0');
    beginJob(db, id, 'walk', ['a/']);
    pauseSurvey(db, 'solo', 'T5');

    expect(standing('solo')).toMatchObject({ state: 'paused', since: 'T5', during: 'walking', nextRun: null });
  });
});

/** What the open job has produced, which a probe's progress is read against. */
describe('what a job has produced so far', () => {
  it('is nothing to report where no job is open', () => {
    const id = putVenue(db, 'solo', 'https://x', '');

    expect(producedSoFar(db, id, 'update')).toBeNull();
  });

  it('sums what every partition of the open job found', () => {
    const id = putVenue(db, 'solo', 'https://x', '');

    beginJob(db, id, 'update', ['1', '2']);

    const [one, two] = openPartitions(db, id, 'update');

    advanceRun(db, one!.id, 'c', 1, 30);
    advanceRun(db, two!.id, 'c', 1, 12);
    closeRun(db, two!.id);

    expect(producedSoFar(db, id, 'update')).toBe(42);
    expect(producedSoFar(db, id, 'walk')).toBeNull();
  });

  /** A finished job's partitions stay on record, and are not what is being watched. */
  it('counts only the open job, not one before it', async () => {
    const id = putVenue(db, 'solo', 'https://x', '');

    beginJob(db, id, 'update', ['1']);
    advanceRun(db, openPartitions(db, id, 'update')[0]!.id, 'c', 1, 99);
    closeRun(db, openPartitions(db, id, 'update')[0]!.id);
    closeRun(db, openJob(db, id, 'update')!.id);

    await new Promise(r => setTimeout(r, 5));

    beginJob(db, id, 'update', ['1']);
    advanceRun(db, openPartitions(db, id, 'update')[0]!.id, 'c', 1, 7);

    expect(producedSoFar(db, id, 'update')).toBe(7);
  });
});

/** Throwing a venue's progress away, which is the step before a survey that starts from nothing. */
describe('resetting a venue\'s runs', () => {
  it('drops every run of the venue and no other, and says how many', () => {
    const id    = putVenue(db, 'solo', 'https://x', '');
    const other = putVenue(db, 'other', 'https://y', '');

    beginJob(db, id, 'walk', ['a/', 'b/']);
    beginJob(db, other, 'walk', ['a/']);

    expect(resetRuns(db, id)).toBe(3);
    expect(openJob(db, id, 'walk')).toBeNull();
    expect(openJob(db, other, 'walk')).not.toBeNull();
  });

  /** What a venue published is a measurement and stays true; only how far it was read goes. */
  it('leaves series and files where they are', async () => {
    const id = putVenue(db, 'binance', 'https://x', '');

    await putFiles(db, [file('p/a.zip', { venueId: id })]);
    beginJob(db, id, 'walk', ['p/']);
    resetRuns(db, id);

    expect(db.prepare('SELECT count(*) n FROM file').get()).toMatchObject({ n: 1 });
    expect(db.prepare('SELECT count(*) n FROM series').get()).toMatchObject({ n: 1 });
  });
});
