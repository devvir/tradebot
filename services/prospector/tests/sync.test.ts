import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { countUnsettled, putFiles, putVenue, recordSeries } from '../src/catalog';
import { openCatalog } from '../src/database';
import { fetchHead } from '../src/http';
import { html } from '../src/scanners/html';
import {
  _test_EVERY_HOURS, _test_PROBE_EMPTY_MS, _test_probing, _test_settle, dueAfter,
} from '../src/sync';
import type { DatabaseSync } from 'node:sqlite';
import type { Adapter, Config } from '../src/types';

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
  list:    'https://indexes.example',
  base:    'https://indexes.example',
  root:    '',
  probes:  true,
  pacing:  { perSecond: 1000, concurrency: 4, standDownMs: 20, ceilingMs: 40 },
  dateOf:  (path) => /(\d{4})-(\d{2})-(\d{2})/.exec(path)?.slice(1).join('') ?? null,
};

const config: Config = {
  catalogDir: '/tmp', token: 'x', port: 0, venues: [], concurrency: 4,
};

let dir: string;
let db:  DatabaseSync;
let venueId: number;

beforeEach(async () => {
  dir     = mkdtempSync(join(tmpdir(), 'sync-'));
  db      = openCatalog(join(dir, 'catalog.db'), { seedData: false });
  venueId = putVenue(db, indexed.name, indexed.base, indexed.root);
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
 * A venue is never finished, only current.
 *
 * **The archives grow every day**, so reaching the end of one is not a state to
 * stop in — it is the point where the cheap half becomes possible. What is worth
 * pinning is the cadence: measured from the *start* of a pass, so a venue whose
 * walk outruns the interval does not drift a day later on every turn.
 */
describe('keeping a venue current', () => {
  it('waits out the rest of the day when a pass was quick', () => {
    const began = Date.now() - 3_600_000;
    const wait  = Math.max(0, began + _test_EVERY_HOURS * 3_600_000 - Date.now());

    expect(wait).toBeGreaterThan((_test_EVERY_HOURS - 2) * 3_600_000);
    expect(wait).toBeLessThanOrEqual((_test_EVERY_HOURS - 1) * 3_600_000);
  });

  /**
   * An index walk can run for days. Measuring from the end would push the next
   * update a whole interval past a pass that already took longer than one.
   */
  it('goes straight round again when a pass outran the interval', () => {
    const began = Date.now() - (_test_EVERY_HOURS + 6) * 3_600_000;

    expect(Math.max(0, began + _test_EVERY_HOURS * 3_600_000 - Date.now())).toBe(0);
  });

  it('updates daily', () => {
    expect(_test_EVERY_HOURS).toBe(24);
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
    expect(_test_probing(listing, 'partial')).toBe(true);
  });

  it('says so for a venue that probes, whatever the pass', () => {
    expect(_test_probing(indexed, 'full')).toBe(true);
    expect(_test_probing(indexed, 'partial')).toBe(true);
  });

  /** The one case that is genuinely finished when its keyspace has been read. */
  it('does not for a walk of a listing venue', () => {
    expect(_test_probing(listing, 'full')).toBe(false);
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

  /**
   * **Gate's case.** Its walk began 2026-08-30T09:44 and ran 26.6 hours, so the
   * next update fell due two hours before the walk finished. Timed from the
   * moment this process picked the walk up instead, it would have slept another
   * 22 — the same pass answering differently depending on whether a restart
   * happened to intervene, which is the one thing measuring from the start
   * exists to prevent.
   */
  it('is already past for a pass that outran the interval', () => {
    const began = Date.parse('2026-08-30T09:44:00.000Z');
    const ended = Date.parse('2026-08-31T12:20:00.000Z');

    expect(Math.max(0, began + HOURS - ended)).toBe(0);
  });

  /** And the reading a resumption would have given instead, which is the bug. */
  it('would not be, timed from when the process picked the pass up', () => {
    const resumed = Date.parse('2026-08-31T10:52:00.000Z');
    const ended   = Date.parse('2026-08-31T12:20:00.000Z');

    expect(Math.max(0, resumed + HOURS - ended)).toBeGreaterThan(22 * 3_600_000);
  });

  /** `dueAfter` reads the same rule from the same field, for the startup path. */
  it('answers the same thing on startup as the loop does between passes', () => {
    expect(dueAfter('2026-08-30T09:44:00.000Z'))
      .toBe(Date.parse('2026-08-30T09:44:00.000Z') + HOURS);
  });
});
