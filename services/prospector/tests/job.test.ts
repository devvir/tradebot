import { asSeries } from '../src/paths';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { establishedAt, openJob, openPartitions, putVenue } from '../src/catalog';
import { openCatalog } from '../src/database';
import { Refused } from '../src/http';
import { surveyVenue } from '../src/survey';
import type { DatabaseSync } from 'node:sqlite';
import type { Adapter, Config, Page, Scanner } from '../src/types';

/**
 * What a survey does to the catalog's bookkeeping, which is the part that
 * decides whether anything downstream is told the truth.
 *
 * A survey is one job: build the partitions, walk them to the end, close the job
 * when every one of them closed. A first pass, a refresh and a resume of either
 * are the same flow reached two ways, so these exercise the flow rather than the
 * three names for it.
 */

let dir: string;
let db:  DatabaseSync;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'prospector-'));
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
  catalogDir: dir, venues: [], concurrency: 4,
};

/** How many pages each scope serves before it is exhausted, keyed by prefix. */
type Archive = Record<string, number>;

/**
 * A venue that answers from a fixed shape, and refuses named scopes so a
 * partition can be made to fail on demand.
 */
const venue = (archive: Archive, breaks: string[] = []): Adapter => {
  const scanner: Scanner<unknown> = {
    name: 'fake',

    scopes: async () => Object.keys(archive),

    page: async (_context, scope, cursor): Promise<Page> => {
      if (breaks.includes(scope)) throw new Error(`listing failed: ${scope}`);

      const pages = archive[scope]!;
      const at    = cursor ? Number(cursor.split('#')[1]) : 0;
      const next  = at + 1;

      return {
        listed: [{ key: `${scope}A/A-2025-01-0${next}.zip`, size: 1, etag: 'e', modified: null }],
        cursor: next < pages ? `${scope}#${next}` : null,
      };
    },
  };

  return {
    name: 'fake', scanner, list: 'https://x', base: 'https://x', root: '',
    getContext: async () => null,
    dateOf: (path) => /(\d{4})-(\d{2})-(\d{2})\.zip$/.exec(path)?.slice(1, 4).join('') ?? null,

    /**
     * Every key reads into one series. These tests are about partitions and
     * cursors, and a path that resolves to no series is not catalogued at all.
     */
    inspectUrl: (path) => {
      const at = /(\d{4})-(\d{2})-(\d{2})\.zip$/.exec(path);

      return at
        ? asSeries(path, { market: 'perp', dataset: 'trades', symbol: 'A', date: at.slice(1, 4).join('') })
        : { of: 'unknown', date: null };
    },
  };
};

describe('one clean pass', () => {
  it('closes the job and establishes the venue', async () => {
    const summary = await surveyVenue(db, venue({ 'spot/': 2, 'futures/': 1 }), config);
    const id      = putVenue(db, 'fake', 'https://x', '');

    expect(summary).toMatchObject({ partitions: 2, failed: 0, found: 3 });
    expect(openJob(db, id, 'walk')).toBeNull();
    expect(establishedAt(db, id, '')).not.toBeNull();
  });

  it('records what every partition found', async () => {
    await surveyVenue(db, venue({ 'spot/': 3 }), config);

    expect(db.prepare('SELECT count(*) n FROM file').get()).toMatchObject({ n: 3 });
  });
});

/**
 * The defect this file exists for. A partition that throws still has keyspace
 * nobody has read, so the job must stay open — the job sits at the empty scope,
 * every prefix's first ancestor, and closing it around a failure would tell
 * every consumer the whole venue was established.
 */
describe('a partition that fails', () => {
  it('leaves the job open rather than establishing the venue', async () => {
    const summary = await surveyVenue(db, venue({ 'spot/': 1, 'futures/': 1 }, ['futures/']), config);
    const id      = putVenue(db, 'fake', 'https://x', '');

    expect(summary.failed).toBe(1);
    expect(openJob(db, id, 'walk')).not.toBeNull();
    expect(establishedAt(db, id, '')).toBeNull();
  });

  /** Its siblings still finish, and still answer for themselves. */
  it('does not hold back the partitions that succeeded', async () => {
    const id = putVenue(db, 'fake', 'https://x', '');

    await surveyVenue(db, venue({ 'spot/': 1, 'futures/': 1 }, ['futures/']), config);

    expect(establishedAt(db, id, 'spot/')).not.toBeNull();
    expect(establishedAt(db, id, 'futures/')).toBeNull();
  });

  /**
   * And the next pass retries only what is left. This is what makes the log line
   * true: the failure is picked up on the next attempt, not in a month.
   */
  it('retries only the failed partition on the next pass', async () => {
    const id = putVenue(db, 'fake', 'https://x', '');

    await surveyVenue(db, venue({ 'spot/': 1, 'futures/': 1 }, ['futures/']), config);

    expect(openPartitions(db, id, 'walk').map(p => p.scope)).toEqual(['futures/']);

    const second = await surveyVenue(db, venue({ 'spot/': 1, 'futures/': 1 }), config);

    expect(second.partitions).toBe(1);
    expect(openJob(db, id, 'walk')).toBeNull();
    expect(establishedAt(db, id, '')).not.toBeNull();
  });
});

describe('resuming', () => {
  /**
   * A resumed job does not re-map the archive: the partitions are read back from
   * the catalog, so what the venue looks like now cannot change a job already
   * under way. The extra scope here is ignored until the next job.
   */
  it('continues the open job rather than re-partitioning', async () => {
    const id = putVenue(db, 'fake', 'https://x', '');

    await surveyVenue(db, venue({ 'spot/': 1, 'futures/': 1 }, ['futures/']), config);

    const grown = await surveyVenue(
      db, venue({ 'spot/': 1, 'futures/': 1, 'option/': 1 }, ['futures/']), config,
    );

    expect(grown.partitions).toBe(1);
    expect(db.prepare(`SELECT count(*) n FROM run WHERE scope = 'option/'`).get())
      .toMatchObject({ n: 0 });
    expect(openJob(db, id, 'walk')).not.toBeNull();
  });

  /** A partition picks up from its cursor rather than from the beginning. */
  it('carries the cursor across an interruption', async () => {
    const id = putVenue(db, 'fake', 'https://x', '');

    await surveyVenue(db, venue({ 'spot/': 4 }, ['spot/']), config);

    // Nothing was read, so the cursor is still null and all four pages remain.
    expect(openPartitions(db, id, 'walk')[0]!.cursor).toBeNull();

    await surveyVenue(db, venue({ 'spot/': 4 }), config);

    expect(db.prepare('SELECT count(*) n FROM file').get()).toMatchObject({ n: 4 });
  });
});

/**
 * Read at the start of every job, so a file excluded by hand takes effect on the
 * next job rather than the next deploy.
 */
describe('the exclusion list', () => {
  const exclude = (venueId: number, path: string) =>
    db.prepare('INSERT INTO exclusion (venue_id, path, reason) VALUES (?, ?, ?)')
      .run(venueId, path, 'not historical data');

  it('keeps an excluded file out of the catalog', async () => {
    const id = putVenue(db, 'fake', 'https://x', '');

    exclude(id, 'spot/A/A-2025-01-01.zip');

    await surveyVenue(db, venue({ 'spot/': 2 }), config);

    expect(db.prepare('SELECT path FROM file').all().map((r: any) => r.path))
      .toEqual(['spot/A/A-2025-01-02.zip']);
  });

  /** And a row added between jobs is honoured by the next one without a restart. */
  it('picks up a file excluded after the previous job finished', async () => {
    const id = putVenue(db, 'fake', 'https://x', '');

    await surveyVenue(db, venue({ 'spot/': 2 }), config);

    expect(db.prepare('SELECT count(*) n FROM file').get()).toMatchObject({ n: 2 });

    exclude(id, 'spot/A/A-2025-01-01.zip');

    await new Promise(r => setTimeout(r, 5));
    await surveyVenue(db, venue({ 'spot/': 2 }), config);

    /**
     * The row already catalogued is not deleted — nothing here ever deletes. It
     * simply stops being offered, so the re-walk marks it withdrawn like any
     * file the venue stopped serving.
     */
    expect(db.prepare(`SELECT existence FROM file WHERE path = 'spot/A/A-2025-01-01.zip'`).get())
      .toMatchObject({ existence: 'absent' });
  });
});

describe('a second job over the same venue', () => {
  /**
   * A refresh is a new job over freshly built partitions, walking everything
   * again — new keys are appended within each symbol group rather than globally,
   * so no cursor finds them.
   */
  it('re-partitions and walks every scope again', async () => {
    const id = putVenue(db, 'fake', 'https://x', '');

    await surveyVenue(db, venue({ 'spot/': 1, 'futures/': 1 }), config);

    const first = establishedAt(db, id, '');

    await new Promise(r => setTimeout(r, 5));
    await surveyVenue(db, venue({ 'spot/': 1, 'futures/': 1 }), config);

    expect(establishedAt(db, id, '')).not.toBe(first);
    expect(db.prepare(`SELECT count(*) n FROM run WHERE scope = 'spot/'`).get())
      .toMatchObject({ n: 2 });
  });

  /** A file the venue stopped offering is marked, never deleted. */
  it('marks what the venue no longer offers', async () => {
    await surveyVenue(db, venue({ 'spot/': 2 }), config);

    await new Promise(r => setTimeout(r, 5));
    await surveyVenue(db, venue({ 'spot/': 1 }), config);

    expect(db.prepare(`SELECT count(*) n FROM file WHERE existence = 'absent'`).get())
      .toMatchObject({ n: 1 });
    expect(db.prepare('SELECT count(*) n FROM file').get()).toMatchObject({ n: 2 });
  });
});

/**
 * A walk that is refused because the *address* is blocked must not be retried on
 * the ordinary floor: a ban lapses only while nothing is asking, so knocking every
 * thirty seconds with twenty partitions is how a ten-minute rule becomes a lasting
 * one. The job still stays open and the cursors are still kept.
 */
describe('a venue that blocks us mid-walk', () => {
  const refusing = (): Adapter => ({
    ...venue({ 'spot/': 1, 'trading/': 1 }),
    scanner: {
      name: 'blocked',
      scopes: async () => ['spot/', 'trading/'],
      page:   async () => {
        throw new Refused(403, new Headers({ server: 'CloudFront', 'x-cache': 'Error from cloudfront' }),
          'https://public.bybit.com/spot/');
      },
    },
  });

  it('reports the venue as blocking rather than merely failing', async () => {
    const summary = await surveyVenue(db, refusing(), config);

    expect(summary.blocked).toBe(true);
    expect(summary.failed).toBeGreaterThan(0);
  });

  /** One refusal is the venue's answer for all of them, so the rest are not asked. */
  it('stops asking the moment it is refused', async () => {
    const asked: string[] = [];
    const adapter = refusing();
    const scanner = {
      ...adapter.scanner,
      page: async (_a: Adapter, scope: string) => {
        asked.push(scope);

        throw new Refused(403, new Headers({ server: 'CloudFront' }), 'https://public.bybit.com/');
      },
    };

    await surveyVenue(db, { ...adapter, scanner }, { ...config, concurrency: 1 });

    expect(asked).toHaveLength(1);
  });

  /** A key the bucket declines is an answer about that key, not about us. */
  it('does not call a bucket policy a block', async () => {
    const adapter = refusing();
    const scanner = {
      ...adapter.scanner,
      page: async () => {
        throw new Refused(403, new Headers({ server: 'AmazonS3', 'x-amz-error-code': 'AccessDenied' }),
          'https://x/y');
      },
    };

    const summary = await surveyVenue(db, { ...adapter, scanner }, config);

    expect(summary.blocked).toBe(false);
    expect(summary.failed).toBe(2);
  });

  /** And the job is left open either way, so nothing is lost. */
  it('leaves the job open with its partitions', async () => {
    const id = putVenue(db, 'fake', 'https://x', '');

    await surveyVenue(db, refusing(), config);

    expect(openJob(db, id, 'walk')).not.toBeNull();
    expect(openPartitions(db, id, 'walk').length).toBeGreaterThan(0);
  });
});
