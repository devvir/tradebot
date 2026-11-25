import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { countUnsettled, putFiles, putVenue, recordSeries } from '../src/catalog';
import { openCatalog } from '../src/database';
import { listing } from '../src/context';
import { fetchHead } from '../src/http';
import { html } from '../src/scanners/html';
import {
  _test_EVERY_HOURS, _test_PROBE_EMPTY_MS, _test_passFor, _test_settle, dueAfter,
} from '../src/sync';
import { probing } from '../src/survey';
import type { DatabaseSync } from 'node:sqlite';
import { applySchedule } from '../src/schedule';
import type { Adapter } from '../src/types';

vi.mock('../src/http', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/http')>()),
  fetchHead: vi.fn(),
}));

/**
 * When a probe is finished.
 *
 * **A probe is the second half of a walk, not a daemon.** It has to keep asking
 * while the walk is still finding rows — an empty backlog then means *not yet* —
 * and it has to stop once the walk is done and the backlog is gone, or the venue
 * is never announced as synced and every later survey request stacks another
 * loop against the same host. Both halves are the rule below, and the second is
 * the one that was missing.
 */

/** A venue whose walk states nothing about a file, which is what a probe is for. */
const indexed: Adapter = {
  name:    'indexed',
  scanner: html,
  base:    'https://indexes.example',
  keyRoot: '',
  probes:  true,
  getContext: async () => listing(indexed),
  pacing:  { perSecond: 1000, concurrency: 4, standDownMs: 20, ceilingMs: 40 },
  dateOf:  (path) => /(\d{4})-(\d{2})-(\d{2})/.exec(path)?.slice(1).join('') ?? null,
};

let dir: string;
let db:  DatabaseSync;
let venueId: number;

beforeEach(async () => {
  dir     = mkdtempSync(join(tmpdir(), 'sync-'));
  db      = openCatalog(join(dir, 'catalog.db'), { seedData: false });
  venueId = putVenue(db, indexed.name, indexed.base, indexed.keyRoot);
});

afterEach(() => {
  vi.useRealTimers();
  db.close();
  rmSync(dir, { recursive: true, force: true });
  vi.mocked(fetchHead).mockReset();
});

/** A series for the venue to hang rows on; these tests are not about series. */
const seriesOn = (id: number): number =>
  recordSeries(db, id, {
    market: 'perp', dataset: 'klines', symbol: 'BTCUSDT',
    pattern: 'p/{YYYY}{MM}/{SYMBOL}.zip',
  }).id!;

/** A row as a walk leaves it: a path and a date, and nothing else established. */
const owed = async (path: string, date = '20250301'): Promise<void> => {
  await putFiles(db, [{
    venueId, path, date, size: null, etag: null, modified: null,
    existence: 'confirmed', seenAt: 'T1', seriesId: seriesOn(venueId),
  }]);
};

const answers = (status: number, headers: Record<string, string> = {}) =>
  ({ status, headers: new Headers(headers) });

const found = () =>
  answers(200, { etag: '"abc"', 'content-length': '1024' });

/** Draining: the walk is over, so an empty backlog is the end rather than a pause. */
const draining = () => false;

describe('draining after a walk', () => {
  it('settles what is owed and then stops', async () => {
    await owed('orderbook/BTCUSDT/2025-03-01.data.zip');
    vi.mocked(fetchHead).mockResolvedValue(found());

    await _test_settle(db, indexed, draining);

    expect(countUnsettled(db, venueId)).toBe(0);
  });

  /**
   * **A constructed key that is not there leaves the backlog by being retired,
   * not by settling.** Counting only settlements would read a pass that gave up
   * on ten thousand dead candidates as having achieved nothing, and stop the
   * drain one round into it.
   */
  it('counts a key it gave up on as progress', async () => {
    await owed('orderbook/GONE/2025-03-01.data.zip');
    vi.mocked(fetchHead).mockResolvedValue(answers(404));

    await _test_settle(db, { ...indexed, ruleOnFailure: () => 'drop' }, draining);

    expect(countUnsettled(db, venueId)).toBe(0);
  });

  /**
   * **A venue that will not settle a row is a pass that does not finish**, and
   * that is the intended shape rather than a gap. There is no rule here that
   * turns "the venue answered with something that is not an answer" into
   * absence, so the drain keeps asking and says so — which means nothing is
   * reconciled and this venue stops moving on until somebody looks at it.
   *
   * Every venue here is S3, OSS or a known CDN in front of one. One that behaves
   * this way is a venue to go and fix, not one to design around.
   */
  it('never finishes while a row insists on being unsettled', async () => {
    await owed('orderbook/STUCK/2025-03-01.data.zip');
    vi.mocked(fetchHead).mockResolvedValue(answers(500));

    const running = _test_settle(db, indexed, draining);
    const raced   = await Promise.race([
      running.then(() => 'finished'),
      new Promise(resolve => setTimeout(() => resolve('still asking'), 250)),
    ]);

    expect(raced).toBe('still asking');
    expect(countUnsettled(db, venueId)).toBe(1);
  });

  /**
   * **The one thing that does stop it short of an empty backlog.**
   *
   * The drain's only other exit is `left === 0`, so a venue with rows still owed
   * could not be paused at all: the flag was set, nothing in the loop read it,
   * and the survey went on reporting itself as both running and stopping — which
   * is what a paused venue looked like for as long as anybody watched it.
   *
   * It answers `false`, because nothing was drained, and that is what keeps the
   * caller from reconciling over a pass that did not finish.
   */
  it('stops on a pause with rows still owed, and says it did not drain', async () => {
    await owed('orderbook/STUCK/2025-03-01.data.zip');
    vi.mocked(fetchHead).mockResolvedValue(answers(500));

    let paused = false;

    const running = _test_settle(db, indexed, draining, () => paused);

    paused = true;

    expect(await running).toBe(false);
    expect(countUnsettled(db, venueId)).toBe(1);
  });
});

describe('while the walk is still running', () => {
  /**
   * The case an early exit would break: both loops start together, so the probe
   * asks before the walk has written a row. Stopping there would settle nothing
   * a venue publishes and report it as done.
   */
  it('waits for rows rather than treating an empty backlog as finished', async () => {
    /**
     * **Everything but `setImmediate`.** These tests drive the probe loop's own
     * wait; the catalog's writer yields with `setImmediate` between slices, and
     * faking that stops a write ever completing — see `slice` in `queries.ts`.
     */
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] });

    let indexing = true;
    let done     = false;

    vi.mocked(fetchHead).mockResolvedValue(found());

    const probing = _test_settle(db, indexed, () => indexing)
      .then(() => { done = true; });

    // Two idle rounds with nothing to do, and it is still there.
    await vi.advanceTimersByTimeAsync(_test_PROBE_EMPTY_MS * 2);
    expect(done).toBe(false);

    // The walk finds one, then finishes: the next round settles it and stops.
    await owed('orderbook/LATE/2025-03-01.data.zip');
    indexing = false;

    await vi.advanceTimersByTimeAsync(_test_PROBE_EMPTY_MS);
    await probing;

    expect(done).toBe(true);
    expect(countUnsettled(db, venueId)).toBe(0);
  });

  /**
   * **Probing is not a second lifecycle running beside the walk.** It follows the
   * walk's output, so a backlog is a reason to carry straight on rather than to
   * sleep — waiting a quarter of an hour on rows already written turned probing
   * into bursts against a walk that never stopped producing.
   */
  it('goes straight round again while the backlog still has rows', async () => {
    /**
     * **Everything but `setImmediate`.** These tests drive the probe loop's own
     * wait; the catalog's writer yields with `setImmediate` between slices, and
     * faking that stops a write ever completing — see `slice` in `queries.ts`.
     */
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] });

    let indexing = true;

    // More rows than one pass will take, so the backlog is never empty.
    for (let at = 0; at < 3; at++) await owed(`orderbook/MANY/2025-03-0${at + 1}.data.zip`);

    vi.mocked(fetchHead).mockResolvedValue(found());

    const probing = _test_settle(db, indexed, () => indexing);

    // No clock advanced at all: with work in hand it must not be waiting on one.
    await vi.advanceTimersByTimeAsync(0);

    expect(countUnsettled(db, venueId)).toBe(0);

    indexing = false;
    await vi.advanceTimersByTimeAsync(_test_PROBE_EMPTY_MS);
    await probing;
  });
});

/**
 * Whether a pass has a probing half.
 *
 * **The pass decides, not the adapter.** An update generates its keys rather
 * than reading them, so nothing it emits is established until it is asked about
 * — whatever the venue is. Read off `adapter.probes` alone, the completion log
 * announced "Survey complete" for every update on a listing venue the moment
 * generation ended: binance said it with 8,312 rows still in `wip` and went on
 * probing for twenty-seven minutes.
 */
describe('when a pass still owes a probe', () => {
  const listing: Adapter = { ...indexed, probes: false };

  it('says so for an update on a listing venue', () => {
    expect(probing(listing, 'partial')).toBe(true);
  });

  it('says so for a venue that probes, whatever the pass', () => {
    expect(probing(indexed, 'full')).toBe(true);
    expect(probing(indexed, 'partial')).toBe(true);
  });

  /** The one case that is genuinely finished when its keyspace has been read. */
  it('does not for a walk of a listing venue', () => {
    expect(probing(listing, 'full')).toBe(false);
  });
});

/**
 * Which pass runs.
 *
 * **Walk until the first walk is behind a venue, update after** — and walk again
 * when one of the days its schedule sets has come round since the last walk
 * began. The schedule never strands a pass in progress.
 */
describe('which pass runs', () => {
  const blind: Adapter = { ...indexed, listable: false };

  /** How long since the last walk began, and when the pass is being decided. */
  const DAYS = 86_400;
  const said = (days = Infinity) => days * DAYS;
  const NOW  = new Date('2026-09-30T12:00:00Z');

  /** The venue walks on these days of the month, or never. */
  const on = (...days: number[]): void => applySchedule(new Map([[indexed.name, days]]));

  beforeEach(() => on(15));

  it('walks until the first walk is behind a venue', () => {
    for (const phase of ['not run', 'planned', 'running', 'complete'] as const)
      expect(_test_passFor(indexed, 'full', phase, false, said(), NOW)).toBe('full');
  });

  it('updates after that, while no scheduled day has come round since the last walk', () => {
    // Walked on the 20th; the 15th before today is behind that walk.
    expect(_test_passFor(indexed, 'full', 'updating', false, said(10.5), NOW)).toBe('partial');
  });

  it('walks again once a scheduled day has come round since the last walk began', () => {
    // Walked on the 10th; the 15th has passed since.
    expect(_test_passFor(indexed, 'full', 'updating', false, said(20.5), NOW)).toBe('full');
  });

  it('never walks for an update where the schedule gives the venue no day', () => {
    on();

    expect(_test_passFor(indexed, 'full', 'updating', false, said(400), NOW)).toBe('partial');
  });

  /** Its rows are its progress, and only reconciliation ends it. */
  it('finishes an update already open before walking again', () => {
    expect(_test_passFor(indexed, 'full', 'updating', true, said(20.5), NOW)).toBe('partial');
  });

  it('runs an update asked for by name, whatever the schedule says', () => {
    expect(_test_passFor(indexed, 'partial', 'updating', false, said(20.5), NOW)).toBe('partial');
    expect(_test_passFor(indexed, 'partial', 'running', false, said(20.5), NOW)).toBe('partial');
  });

  it('only ever updates a venue that cannot be listed', () => {
    for (const phase of ['not run', 'running', 'updating'] as const)
      expect(_test_passFor(blind, 'full', phase, false, said(), NOW)).toBe('partial');
  });
});

/**
 * When the next pass falls due.
 *
 * **Measured from the start of a pass, not its end**, so a venue whose walk runs
 * longer than the interval does not drift a day later on every turn. The catch
 * is *which* start: a pass this process resumed began before this process did.
 */
describe('when the next pass is due', () => {
  const HOURS = _test_EVERY_HOURS * 3_600_000;

  /** `dueAfter` reads the same rule from the same field, for the startup path. */
  it('answers the same thing on startup as the loop does between passes', () => {
    expect(dueAfter('2026-08-30T09:44:00.000Z'))
      .toBe(Date.parse('2026-08-30T09:44:00.000Z') + HOURS);
  });
});
