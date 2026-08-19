import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { putVenue, venueIds } from '../src/catalog';
import { openCatalog } from '../src/database';
import { surveyVenue } from '../src/survey';
import type { Adapter, Config, Inspection, Page, Scanner } from '../src/types';
import type { DatabaseSync } from 'node:sqlite';

/**
 * Stopping a survey where it is.
 *
 * **A pause is not a cancellation**, and everything worth testing here is that
 * claim: the page in flight is committed, every partition keeps its cursor, the
 * job stays open, and starting again continues rather than restarts.
 */

let dir: string;
let db:  DatabaseSync;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'pause-'));
  db  = openCatalog(join(dir, 'catalog.db'), { seedData: false });

  /**
   * **The venue row is a constant, not something a survey writes.** A real one
   * arrives with the `venues` migration; this venue is invented for the test, so
   * the test provides it.
   */
  putVenue(db, 'fake', 'https://x', '');
});

afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

const config: Config = {
  catalogDir: '', token: '', port: 0, venues: [],
  concurrency: 1,
};

/** Counts the pages it served, so "stopped early" is a number rather than a feeling. */
let served: number;

/** One scope, twenty pages, one dated file each. */
const venue = (): Adapter => {
  served = 0;

  const scanner: Scanner<unknown> = {
    name: 'fake',

    scopes: async () => ['deep/'],

    page: async (_context, scope, cursor): Promise<Page> => {
      const at   = cursor ? Number(cursor.split('#')[1]) : 0;
      const next = at + 1;

      served++;

      return {
        listed: [{ key: `${scope}A-2025-01-${String(next).padStart(2, '0')}.zip`,
          size: 1, etag: 'e', modified: null }],
        cursor: next < 20 ? `${scope}#${next}` : null,
      };
    },
  };

  return {
    name: 'fake', scanner, list: 'https://x', base: 'https://x', root: '',
    getContext: async () => null,
    dateOf: (path) => /(\d{4})-(\d{2})-(\d{2})\.zip$/.exec(path)?.slice(1, 4).join('') ?? null,
  };
};

const partitions = () => {
  const [id] = venueIds(db, 'fake');

  return db.prepare(
    'SELECT scope, cursor, completed FROM run WHERE venue_id = ? AND scope != \'\'',
  ).all(id) as { scope: string; cursor: string | null; completed: string | null }[];
};

describe('pausing a walk', () => {
  /**
   * The flag is read between pages, so the walk finishes the one it is on. Three
   * pages in, the answer is "three pages of progress kept" — not two, and not
   * the whole scope.
   */
  it('stops after the page it is on and keeps the cursor', async () => {
    const summary = await surveyVenue(db, venue(), config, 'full', () => served >= 3);

    expect(summary.paused).toBe(true);
    expect(served).toBe(3);

    const [scope] = partitions();

    expect(scope!.cursor).toBe('deep/#3');
    expect(scope!.completed).toBeNull();
  });

  /**
   * **The job stays open, which is what makes it a pause.** A closed job over a
   * partition nobody finished would read as an established venue, and the
   * keyspace above the cursor would never be walked by anything.
   */
  it('leaves the job open so nothing reads as established', async () => {
    await surveyVenue(db, venue(), config, 'full', () => served >= 3);

    const [id] = venueIds(db, 'fake');
    const job  = db.prepare(
      'SELECT completed FROM run WHERE venue_id = ? AND scope = \'\'',
    ).get(id) as { completed: string | null };

    expect(job.completed).toBeNull();
  });

  /** Starting again is resuming: the pages already served are not served twice. */
  it('continues from where it stopped rather than starting over', async () => {
    const first = venue();

    await surveyVenue(db, first, config, 'full', () => served >= 3);

    // A second pass over the same catalog, with nothing asking it to stop.
    const again   = venue();
    const summary = await surveyVenue(db, again, config, 'full');

    expect(summary.paused).toBe(false);

    // Seventeen of twenty, because three were already read and their cursor kept.
    expect(served).toBe(17);
    expect(partitions()[0]!.completed).not.toBeNull();
  });

  /** Nothing asks it to stop, so nothing does. */
  it('runs to the end when no stop is asked for', async () => {
    const summary = await surveyVenue(db, venue(), config, 'full');

    expect(summary.paused).toBe(false);
    expect(served).toBe(20);
  });
});

/**
 * What happens to a path no adapter can place.
 *
 * **It is written down, and the survey carries on.** A shape nobody anticipated
 * is a series nobody tracks — its tip never advances and updating stops
 * extending it — so it has to be visible; but stopping the run on it would mean
 * finding one surprise per pass, where a venue's whole inventory of them is what
 * is actually wanted.
 */
describe('a path the adapter cannot place', () => {
  const strict = (of: Inspection['of']): Adapter => ({
    ...venue(),
    inspectUrl: (): Inspection => (of === 'series'
      ? { of: 'series', date: '20250101',
        found: { market: 'm', dataset: 'd', symbol: 'A', pattern: 'deep/{SYMBOL}-{YYYY}-{MM}-{DD}.zip' } }
      : { of }),
  });

  const recorded = () => {
    const [id] = venueIds(db, 'fake');

    return db.prepare('SELECT path, reason, seen FROM unreadable WHERE venue_id = ?')
      .all(id) as { path: string; reason: string; seen: number }[];
  };

  it('records the shape rather than stopping', async () => {
    const summary = await surveyVenue(db, strict('unknown'), config, 'full');

    expect(summary.failed).toBe(0);
    expect(recorded()).toHaveLength(20);
    expect(recorded()[0]).toMatchObject({ reason: 'unread', seen: 1 });
  });

  /**
   * The reader placed it, so the catalog knows what it is — and knows its date,
   * since placing a path means finding one. `dateOf` is not asked, so it cannot
   * disagree.
   */
  it('dates a placed path from the reader that placed it, not from dateOf', async () => {
    const undated: Adapter = { ...strict('series'), dateOf: () => null };

    await surveyVenue(db, undated, config, 'full');

    /**
     * `inspectUrl` cannot place a path without finding its date, so `dateOf` is
     * never consulted and cannot contradict it. The file is catalogued on the
     * reader's own date, and there is no disagreement left to record.
     */
    expect(recorded()).toEqual([]);
  });

  /** Met again on a later pass, a shape counts rather than repeats. */
  it('counts a shape met twice rather than listing it twice', async () => {
    await surveyVenue(db, strict('unknown'), config, 'full');
    await surveyVenue(db, strict('unknown'), config, 'full');

    const rows = recorded();

    expect(rows).toHaveLength(20);
    expect(rows.every(one => one.seen === 2)).toBe(true);
  });

  /** A venue whose reader places its keys writes nothing here. */
  it('says nothing about a venue whose keys it can place', async () => {
    const summary = await surveyVenue(db, strict('series'), config, 'full');

    expect(summary.failed).toBe(0);
    expect(recorded()).toHaveLength(0);
  });
});
