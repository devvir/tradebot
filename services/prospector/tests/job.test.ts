import { asSeries } from '../src/paths';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  WITHDRAWALS_LOG, closeWalk, establishedAt, openJob, openPartitions, putVenue, unreadable,
} from '../src/catalog';
import { openCatalog } from '../src/database';
import { Refused } from '../src/http';
import { REFUSALS_BEFORE_BLOCK, _test_paces, paceFor } from '../src/pace';
import { _test_retryWait as retryWait, surveyVenue } from '../src/survey';
import type { DatabaseSync } from 'node:sqlite';
import { descend } from '../src/scanners/descend';
import type { Adapter, Config, Level, Limits, ListingContext, Page, Scanner } from '../src/types';

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

  // A page that fails is asked again after a wait; nothing here is about how long.
  retryWait(async () => {});

  /**
   * **The venue row is a constant, not something a survey writes.** A real one
   * arrives with the `venues` migration; this venue is invented for the test, so
   * the test provides it.
   */
  putVenue(db, 'fake', 'https://x', '');
});

afterEach(() => {
  retryWait(null);
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

      const keyAt = (page: number) => `${scope}A/A-2025-01-0${page}.zip`;

      // Covered the way an S3 page is: after the last key before it, through its own.
      return {
        listed: [{ key: keyAt(next), size: 1, etag: 'e', modified: null }],
        cursor: next < pages ? `${scope}#${next}` : null,
        covers: { after: at > 0 ? keyAt(at) : null, through: next < pages ? keyAt(next) : null },
      };
    },
  };

  return {
    name: 'fake', scanner, base: 'https://x', keyRoot: '',
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
 * **One lane maps the archive like any other count.** Descent splits the key
 * root itself, so the job opens over the root's children rather than over a
 * single partition at the root, which is the job's own scope.
 */
describe('a pass with a single lane', () => {
  it('opens a job over the root\'s children and walks it', async () => {
    const adapter = venue({ 'spot/': 1, 'futures/': 1 });
    const root    = { name: 'fake', base: 'https://x', keyRoot: '' } as unknown as ListingContext;

    const read = async (_context: ListingContext, prefix: string): Promise<Level> => prefix === ''
      ? { children: ['spot/', 'futures/'], files: false }
      : { children: [], files: true };

    const scanner = { ...adapter.scanner, scopes: (_context: unknown, limits: Limits) => descend(root, limits, read) };
    const id      = putVenue(db, 'fake', 'https://x', '');
    const summary = await surveyVenue(db, { ...adapter, scanner }, { ...config, concurrency: 1 });

    expect(summary).toMatchObject({ partitions: 2, failed: 0, found: 2 });
    expect(openJob(db, id, 'walk')).toBeNull();
  });
});

/**
 * **A walk that parks keys for a probe is not over when the listing is.**
 *
 * Its job is the only durable record that the backlog is owed. Closed at the end
 * of listing, the venue reports itself *waiting* with a full `wip`, schedules its
 * next pass from a pass that has not finished, and on a restart nothing resumes
 * the drain at all — `dueFor` reads open jobs, never the backlog. bybit's
 * secondary host sat with 137,066 unasked rows in exactly that state.
 */
describe('a walk whose venue probes', () => {
  const probed = (): Adapter => ({ ...venue({ 'spot/': 2 }), probes: true });

  it('leaves its job open when the listing ends', async () => {
    const summary = await surveyVenue(db, probed(), config);
    const id      = putVenue(db, 'fake', 'https://x', '');

    expect(summary).toMatchObject({ failed: 0, generated: true });
    expect(openJob(db, id, 'walk')).not.toBeNull();
  });

  it('closes it once the drain has returned', async () => {
    await surveyVenue(db, probed(), config);

    const id = putVenue(db, 'fake', 'https://x', '');

    closeWalk(db, id);

    expect(openJob(db, id, 'walk')).toBeNull();
    expect(establishedAt(db, id, '')).not.toBeNull();
  });

  /**
   * The one pass that genuinely ends with its listing: everything it found was
   * stated by the listing itself, so there is no backlog to hold the job open.
   */
  it('still closes at once where nothing will probe', async () => {
    const summary = await surveyVenue(db, venue({ 'spot/': 2 }), config);
    const id      = putVenue(db, 'fake', 'https://x', '');

    expect(summary).toMatchObject({ generated: true });
    expect(openJob(db, id, 'walk')).toBeNull();
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
     * The row already catalogued is left as it is. The venue still lists the
     * file, so the re-walk has no grounds to call it withdrawn — excluding it
     * keeps it from being written, not from being served.
     */
    expect(db.prepare(`SELECT existence FROM file WHERE path = 'spot/A/A-2025-01-01.zip'`).get())
      .toMatchObject({ existence: 'confirmed' });
    expect(existsSync(join(dir, WITHDRAWALS_LOG))).toBe(false);
  });
});

/**
 * **Withdrawal is judged against what the venue listed.** A file the catalog
 * can no longer place is still served, so a re-walk lists it as unreadable and
 * leaves its row alone rather than calling it withdrawn.
 */
describe('a catalogued file that can no longer be read', () => {
  it('stays catalogued and is listed as unreadable', async () => {
    const id = putVenue(db, 'fake', 'https://x', '');

    await surveyVenue(db, venue({ 'spot/': 2 }), config);

    const strange = 'spot/A/A-2025-01-01.zip';
    const before  = venue({ 'spot/': 2 });
    const after: Adapter = {
      ...before,
      inspectUrl: path => (path === strange ? { of: 'unknown', date: null } : before.inspectUrl!(path)),
    };

    await new Promise(r => setTimeout(r, 5));
    await surveyVenue(db, after, config);

    expect(db.prepare('SELECT existence FROM file WHERE path = ?').get(strange))
      .toMatchObject({ existence: 'confirmed' });
    expect(unreadable(db, id).map(one => one.path)).toEqual([strange]);
    expect(existsSync(join(dir, WITHDRAWALS_LOG))).toBe(false);
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
  /**
   * **What the venue's gate concluded before these pages were asked.** A block
   * is latched by the request layer after a run of refusals (see `Pace.block`);
   * these scanners throw without going through it, so the latch is set here.
   */
  beforeEach(() => {
    const gate = paceFor(venue({}), 'https://public.bybit.com/');

    for (let i = 0; i < REFUSALS_BEFORE_BLOCK; i++)
      gate.block(403, 'https://public.bybit.com/spot/', new Headers({ server: 'CloudFront' }));
  });

  afterEach(() => _test_paces.clear());

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

  /** Once the gate has latched, one refusal is the venue's answer for all of them, so the rest are not asked. */
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

/**
 * **One refusal that reads as a block is not one yet.** The gate stands a venue
 * down only after a run of them, so a lone CDN 403 fails the partition it was
 * asked for and the rest of the pass goes on.
 */
describe('a venue that refuses once', () => {
  afterEach(() => _test_paces.clear());

  it('fails that partition and walks the others', async () => {
    const asked: string[] = [];
    const adapter = venue({ 'spot/': 1, 'trading/': 1 });
    const scanner = {
      ...adapter.scanner,
      page: async (context: unknown, scope: string, cursor: string | null) => {
        asked.push(scope);

        if (scope === 'spot/')
          throw new Refused(403, new Headers({ server: 'CloudFront' }), 'https://public.bybit.com/spot/');

        return adapter.scanner.page(context, scope, cursor);
      },
    };

    const summary = await surveyVenue(db, { ...adapter, scanner }, { ...config, concurrency: 1 });

    expect(summary).toMatchObject({ blocked: false, failed: 1 });
    expect(asked).toEqual(['spot/', 'trading/']);
  });
});
