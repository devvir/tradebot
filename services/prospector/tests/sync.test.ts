import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { countUnsettled, putFiles, putVenue, recordSeries } from '../src/catalog';
import { openCatalog } from '../src/database';
import { fetchHead } from '../src/http';
import { html } from '../src/scanners/html';
import {
  _test_EVERY_HOURS, _test_PROBE_EMPTY_MS, _test_passFor, _test_probing, _test_settle, dueAfter,
} from '../src/sync';
import type { DatabaseSync } from 'node:sqlite';
import { walkEvery, walkOn } from '../src/adapters/recurrence';
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
  base:    'https://indexes.example',
  keyRoot: '',
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
 * Which pass runs.
 *
 * **A venue that has not said how it recurs behaves exactly as before:** walk
 * until the first walk is behind it, update for ever after. Saying `'walk'`
 * changes only what follows a completed pass, and never strands one in
 * progress.
 */
describe('which pass runs', () => {
  const walker: Adapter = { ...indexed, recurs: 'walk' };
  const blind:  Adapter = { ...indexed, listable: false };

  /** How long since the last walk began, and when the pass is being decided. */
  const DAYS = 86_400;
  const said = (days = Infinity) => days * DAYS;
  const NOW  = new Date('2026-09-30T12:00:00Z');

  it('walks until the first walk is behind a venue', () => {
    for (const phase of ['not run', 'planned', 'running', 'complete'] as const) {
      expect(_test_passFor(indexed, 'full', phase, false, said(), NOW)).toBe('full');
      expect(_test_passFor(walker, 'full', phase, false, said(), NOW)).toBe('full');
    }
  });

  it('updates after that by default', () => {
    expect(_test_passFor(indexed, 'full', 'updating', false, said(), NOW)).toBe('partial');
    expect(_test_passFor({ ...indexed, recurs: 'update' }, 'full', 'updating', false, said(), NOW))
      .toBe('partial');
  });

  it('walks again where the venue recurs by walking', () => {
    expect(_test_passFor(walker, 'full', 'updating', false, said(), NOW)).toBe('full');
  });

  /** Its rows are its progress, and only reconciliation ends it. */
  it('finishes an update already open before walking again', () => {
    expect(_test_passFor(walker, 'full', 'updating', true, said(), NOW)).toBe('partial');
  });

  it('runs an update asked for by name, whatever the venue recurs by', () => {
    expect(_test_passFor(walker, 'partial', 'updating', false, said(), NOW)).toBe('partial');
    expect(_test_passFor(walker, 'partial', 'running', false, said(), NOW)).toBe('partial');
  });

  it('only ever updates a venue that cannot be listed', () => {
    for (const phase of ['not run', 'running', 'updating'] as const)
      expect(_test_passFor(blind, 'full', phase, false, said(), NOW)).toBe('partial');
  });

  /**
   * **A venue that wants it both ways.** Updating finds no shape that did not
   * exist before, so a venue cheapest to update still needs its index re-read on
   * a cadence — and how often is a fact about what a walk of that archive costs.
   */
  describe('where the venue decides per pass', () => {
    const weekly: Adapter = { ...indexed, recurs: walkEvery(7) };

    it('updates while the last walk is recent enough', () => {
      expect(_test_passFor(weekly, 'full', 'updating', false, said(5), NOW))
        .toBe('partial');
    });

    it('walks once the cadence has elapsed', () => {
      expect(_test_passFor(weekly, 'full', 'updating', false, said(7), NOW))
        .toBe('full');
    });

    /**
     * **`Infinity`, and no special case for it.** A venue that has never walked
     * is overdue by any cadence, so the same comparison answers it.
     */
    it('walks a venue that has never walked', () => {
      expect(_test_passFor(weekly, 'full', 'updating', false, Infinity, NOW)).toBe('full');
    });

    /**
     * **The listing rule comes first.** A venue with nothing to walk cannot
     * strand itself by answering `'walk'`, whatever it was told.
     */
    it('overrules a venue that cannot be listed', () => {
      const wrong: Adapter = { ...blind, recurs: () => 'walk' };

      expect(_test_passFor(wrong, 'full', 'updating', false, said(), NOW)).toBe('partial');
    });

    /** The boundary is the cadence itself, so a walk exactly that old is due. */
    it('walks on the day the cadence falls, not after it', () => {
      expect(_test_passFor(weekly, 'full', 'updating', false, said(6.99), NOW)).toBe('partial');
      expect(_test_passFor(weekly, 'full', 'updating', false, said(7), NOW)).toBe('full');
    });
  });

  /**
   * **A walking update on one weekday.** Two venues given different days never
   * walk the same night, however their passes drift — which an interval counted
   * from each venue's own last walk cannot promise.
   */
  describe('where the venue walks on a day of the week', () => {
    const mondays: Adapter = { ...indexed, recurs: walkOn('monday') };

    const MONDAY  = new Date('2026-09-28T03:00:00Z');
    const TUESDAY = new Date('2026-09-29T03:00:00Z');

    it('walks on its day', () => {
      expect(_test_passFor(mondays, 'full', 'updating', false, said(7), MONDAY)).toBe('full');
    });

    it('probes on every other day, however long ago the last walk was', () => {
      expect(_test_passFor(mondays, 'full', 'updating', false, said(30), TUESDAY)).toBe('partial');
    });

    /**
     * **A day is not a pass.** A second pass on the same Monday, or a walk that
     * ran into the next one, is kept from walking again by the gap.
     */
    it('does not walk twice within three days, even on its day', () => {
      expect(_test_passFor(mondays, 'full', 'updating', false, said(3), MONDAY)).toBe('partial');
      expect(_test_passFor(mondays, 'full', 'updating', false, said(3.01), MONDAY)).toBe('full');
    });

    /** The day is the UTC one, like every other clock here. */
    it('reads the day in UTC', () => {
      const sundayEvening = new Date('2026-09-27T23:30:00Z');

      expect(_test_passFor(mondays, 'full', 'updating', false, said(7), sundayEvening)).toBe('partial');
    });
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
