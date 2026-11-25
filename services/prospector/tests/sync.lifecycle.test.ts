import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { logger } from '@devvir/service-kit';
import { openJob, putVenue, reconcile, recordSeries, updateStarted } from '../src/catalog';
import { openCatalog } from '../src/database';
import { fetchHead } from '../src/http';
import { _test_paces } from '../src/pace';
import { s3 } from '../src/scanners/s3';
import { _test_FLOOR_MS, _test_onePass, inPass, syncVenue } from '../src/sync';
import type { DatabaseSync } from 'node:sqlite';
import type { Adapter, Config, Page, Scanner } from '../src/types';

vi.mock('../src/http', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/http')>()),
  fetchHead: vi.fn(),
}));

vi.mock('../src/catalog', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/catalog')>();

  return { ...actual, reconcile: vi.fn(actual.reconcile) };
});

/**
 * A pass from beginning to end, and the loop that runs one after another.
 *
 * **What ends a pass is the rule under test**: a pass that generated what it
 * owed and drained what that produced reconciles and closes; anything short of
 * that leaves its rows for the next pass to continue from. And the loop around
 * passes never ends on its own — not on a pass that finished, and not on one
 * that threw.
 */

let dir: string;
let db:  DatabaseSync;
let id:  number;

const config: Config = { catalogDir: '', token: '', port: 0, venues: [], concurrency: 4 };

/** Fast enough that a few hundred probes take no time. */
const pacing = { perSecond: 10_000, concurrency: 4, standDownMs: 20, ceilingMs: 40 };

/** A venue whose series are declared: every pass of it generates keys and probes them. */
const declared = (more: Partial<Adapter> = {}): Adapter => ({
  name:       'fake',
  scanner:    s3,
  base:       'https://x',
  keyRoot:    '',
  pacing,
  getContext: async () => ({}),
  dateOf:     (path) => /(\d{8})/.exec(path)?.[1] ?? null,
  ...more,
});

/** A venue that is walked: one scope, three pages, one dated file each, every one left to probe. */
const walked = (): Adapter => {
  const scanner: Scanner<unknown> = {
    name: 'fake',

    scopes: async () => ['deep/'],

    page: async (_context, scope, cursor): Promise<Page> => {
      const at = cursor ? Number(cursor.split('#')[1]) : 0;

      return {
        listed: [{ key: `${scope}A-2025-01-${String(at + 1).padStart(2, '0')}.zip`,
          size: null, etag: null, modified: null }],
        cursor: at + 1 < 3 ? `${scope}#${at + 1}` : null,
      };
    },
  };

  return {
    name: 'fake', scanner, base: 'https://x', keyRoot: '', probes: true, pacing,
    getContext: async () => null,
    dateOf:     (path) => /(\d{4})-(\d{2})-(\d{2})\.zip$/.exec(path)?.slice(1, 4).join('') ?? null,
    inspectUrl: (path) => ({
      of:    'series',
      date:  /(\d{4})-(\d{2})-(\d{2})\.zip$/.exec(path)!.slice(1, 4).join(''),
      found: { market: 'spot', dataset: 'trades', symbol: 'A', pattern: 'deep/{SYMBOL}-{YYYY}-{MM}-{DD}.zip' },
    }),
  };
};

/** A week ago, so an update has a few days of keys to generate and probe. */
const lastWeek = (): string =>
  new Date(Date.now() - 7 * 86_400_000).toISOString().slice(0, 10).replaceAll('-', '');

const found = () => ({ status: 200, headers: new Headers({ etag: '"abc"', 'content-length': '1024' }) });

/** Whether the service said this, at any level. */
const said = (message: string): boolean =>
  [logger.info, logger.warn, logger.error].some(level =>
    vi.mocked(level).mock.calls.some(call => call[1] === message));

/**
 * Moves the clock a second at a time until `check` holds.
 *
 * **The clock is the test's.** A pass's probe starts beside its generator and,
 * finding nothing yet, waits half a minute before asking again; on a real clock
 * every test here would be that half minute long.
 */
const eventually = async (check: () => boolean, limitMs = 10 * 60_000): Promise<void> => {
  for (let spent = 0; ! check(); spent += 1_000) {
    if (spent > limitMs) throw new Error('never happened');

    await vi.advanceTimersByTimeAsync(1_000);
  }
};

/** Runs a promise to its end on the test's clock. */
const driven = async <T>(running: Promise<T>): Promise<T> => {
  let done = false;

  running.then(() => { done = true; }, () => { done = true; });

  await eventually(() => done);

  return running;
};

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'lifecycle-'));
  db  = openCatalog(join(dir, 'catalog.db'), { seedData: false });
  id  = putVenue(db, 'fake', 'https://x', '');

  for (const symbol of ['AAA', 'BBB'])
    recordSeries(db, id, { market: 'spot', dataset: 'trades', symbol, pattern: 'x/{YYYY}{MM}{DD}/{SYMBOL}.zip' },
      { tip: lastWeek(), first: '20240101' });

  vi.mocked(fetchHead).mockResolvedValue(found());

  /**
   * **Everything but `setImmediate`**, which the catalog's writer yields with
   * between slices — faking it stops a write ever completing.
   */
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] });
});

afterEach(() => {
  vi.useRealTimers();
  vi.mocked(fetchHead).mockReset();
  vi.mocked(reconcile).mockClear();
  vi.mocked(logger.info).mockClear();
  vi.mocked(logger.warn).mockClear();
  vi.mocked(logger.error).mockClear();
  _test_paces.clear();
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('one pass', () => {
  it('reconciles a finished update, then clears its rows', async () => {
    await driven(_test_onePass(db, declared(), config, 'partial', () => false));

    expect(reconcile).toHaveBeenCalledTimes(1);
    expect(updateStarted(db, id)).toBeNull();
    expect(said('Update finished')).toBe(true);
  });

  /** A pause is not an ending: the rows are the progress the next pass continues from. */
  it('neither reconciles nor clears when paused part-way', async () => {
    let paused = false;

    vi.mocked(fetchHead).mockImplementation(async () => {
      paused = true;

      return found();
    });

    await driven(_test_onePass(db, declared(), config, 'partial', () => paused));

    expect(reconcile).not.toHaveBeenCalled();
    expect(updateStarted(db, id)).not.toBeNull();
    expect(said('Update finished')).toBe(false);
  });

  /** The listing is read; what it found is still owed, and so is the walk. */
  it('keeps a walk open until its probe has drained, then closes it', async () => {
    let release = (): void => {};
    const held  = new Promise<void>(resolve => { release = resolve; });

    vi.mocked(fetchHead).mockImplementation(async () => {
      await held;

      return found();
    });

    const passing = _test_onePass(db, walked(), config, 'full', () => false);

    await eventually(() => vi.mocked(fetchHead).mock.calls.length > 0);

    expect(openJob(db, id, 'walk')).not.toBeNull();

    release();
    await driven(passing);

    expect(openJob(db, id, 'walk')).toBeNull();
    expect(said('Walk finished')).toBe(true);
  });
});

describe('the loop between passes', () => {
  /**
   * The pass that just finished is made to have begun `ago` earlier, the way a
   * resumed pass did, and the loop is stopped once it has said when the next is
   * due. Answers that moment, as an offset from when it was said.
   */
  const nextAfter = async (ago: number): Promise<number> => {
    let paused = false;
    let next   = NaN;

    vi.mocked(logger.info).mockImplementation(((fields: Record<string, unknown>, message: string) => {
      if (message === 'Walk finished')
        db.prepare('UPDATE run SET started = ? WHERE venue_id = ?')
          .run(new Date(Date.now() - ago).toISOString(), id);

      if (message === 'Survey finished') {
        next   = Date.parse(fields['nextRun'] as string) - Date.now();
        paused = true;
      }
    }) as never);

    await driven(syncVenue(db, walked(), config, 'full', () => paused));

    vi.mocked(logger.info).mockReset();

    return next;
  };

  /** Measured from the start of a pass, so a pass that outran the interval goes straight round. */
  it('starts the next pass at once when the last began more than a day ago', async () => {
    expect(await nextAfter(26 * 3_600_000)).toBeLessThan(1_000);
  });

  it('waits out the rest of the day when the last began an hour ago', async () => {
    const next = await nextAfter(3_600_000);

    expect(next).toBeGreaterThan(23 * 3_600_000 - 60_000);
    expect(next).toBeLessThanOrEqual(23 * 3_600_000);
  });

  it('answers a pause during the wait within a beat', async () => {
    let paused = false;

    const looping = syncVenue(db, declared(), config, 'partial', () => paused);

    let done = false;

    void looping.then(() => { done = true; });

    await eventually(() => said('Survey finished'));
    await vi.advanceTimersByTimeAsync(60_000);

    expect(done).toBe(false);

    paused = true;
    await vi.advanceTimersByTimeAsync(1_000);

    expect(done).toBe(true);
  });

  /** What tells a pass still in its preamble from a venue asleep between passes. */
  it('reports the venue in a pass during the preamble, and not once it is over', async () => {
    let during: boolean | null = null;
    let paused = false;

    const adapter = declared({
      instruments: async () => {
        during = inPass('fake');

        return [];
      },
    });

    const looping = syncVenue(db, adapter, config, 'partial', () => paused);

    await eventually(() => said('Survey finished'));

    expect(during).toBe(true);
    expect(inPass('fake')).toBe(false);

    paused = true;
    await driven(looping);
  });
});

describe('a pass that throws', () => {
  it('is retried after a wait rather than ending the loop', async () => {
    let asked  = 0;
    let paused = false;

    const adapter = declared({
      instruments: async () => {
        if (++asked === 1) throw new Error('metadata failed 503');

        paused = true;

        return [];
      },
    });

    const looping = syncVenue(db, adapter, config, 'partial', () => paused);

    await vi.advanceTimersByTimeAsync(0);

    expect(asked).toBe(1);
    expect(said('Pass failed; retrying')).toBe(true);

    await vi.advanceTimersByTimeAsync(_test_FLOOR_MS - 1_000);
    expect(asked).toBe(1);

    await vi.advanceTimersByTimeAsync(2_000);
    expect(asked).toBe(2);

    await expect(looping).resolves.toBeUndefined();
  });

  it('backs off further on each failure in a row', async () => {
    let asked  = 0;
    let paused = false;

    const looping = syncVenue(db, declared({
      instruments: async () => {
        asked++;
        throw new Error('metadata failed 503');
      },
    }), config, 'partial', () => paused);

    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(_test_FLOOR_MS);
    expect(asked).toBe(2);

    // The second wait is twice the first.
    await vi.advanceTimersByTimeAsync(_test_FLOOR_MS);
    expect(asked).toBe(2);

    await vi.advanceTimersByTimeAsync(_test_FLOOR_MS);
    expect(asked).toBe(3);

    paused = true;
    await vi.advanceTimersByTimeAsync(1_000);
    await looping;
  });

  it('ends on a pause during the wait', async () => {
    let asked  = 0;
    let paused = false;

    const looping = syncVenue(db, declared({
      instruments: async () => {
        asked++;
        throw new Error('metadata failed 503');
      },
    }), config, 'partial', () => paused);

    await vi.advanceTimersByTimeAsync(0);

    paused = true;

    await vi.advanceTimersByTimeAsync(1_000);
    await expect(looping).resolves.toBeUndefined();
    expect(asked).toBe(1);
  });
});
