import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { logger } from '@devvir/service-kit';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { openJob, putVenue, venueIds } from '../src/catalog';
import { openCatalog } from '../src/database';
import { Refused } from '../src/http';
import { REFUSALS_BEFORE_BLOCK, _test_paces, paceFor } from '../src/pace';
import { asSeries } from '../src/paths';
import { _test_SPLIT_MS, _test_retryWait as retryWait, surveyVenue } from '../src/survey';
import type { Adapter, Config, Level, Page, Scanner } from '../src/types';
import type { DatabaseSync } from 'node:sqlite';

/**
 * What a survey does when splitting a partition, or walking one, goes wrong.
 *
 * **Whatever fails, the survey answers only once nothing is walking**, and a
 * partition it stopped is either split, walked on whole, or left with its
 * cursor for the next pass — never walked twice, and never lost.
 */

let dir: string;
let db:  DatabaseSync;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'survey-failures-'));
  db  = openCatalog(join(dir, 'catalog.db'), { seedData: false });

  putVenue(db, 'fake', 'https://x', '');
  retryWait(async () => {});

  vi.mocked(logger.info).mockClear();
  vi.mocked(logger.warn).mockClear();
});

afterEach(() => {
  vi.useRealTimers();
  vi.mocked(logger.info).mockReset();
  retryWait(null);
  _test_paces.clear();
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

const lanes = (concurrency: number): Config => ({
  catalogDir: '', token: '', port: 0, venues: [], concurrency,
});

/** Every page the scanner was asked for, as `scope@cursor`, in order. */
let asks: string[];

/** Every level the scanner was asked to read. */
let levels: string[];

/**
 * Scopes of a given number of pages, one dated file each, mapped as `scopes` or
 * as all of them. `level` decides how a split goes, `fails` whether a page
 * request fails, and `delayMs` how long a page takes — long enough, where it
 * matters, for idle lanes to try a split.
 */
const venue = (opts: {
  pages:    Record<string, number>;
  scopes?:  string[];
  level?:   (scope: string) => Promise<Level>;
  fails?:   (scope: string, cursor: string | null) => Error | null;
  delayMs?: number;
}): Adapter => {
  asks   = [];
  levels = [];

  const scanner: Scanner<unknown> = {
    name: 'fake',

    scopes: async () => opts.scopes ?? Object.keys(opts.pages),

    ...(opts.level ? {
      level: async (_context: unknown, scope: string): Promise<Level> => {
        levels.push(scope);

        return opts.level!(scope);
      },
    } : {}),

    page: async (_context, scope, cursor): Promise<Page> => {
      asks.push(`${scope}@${cursor ?? ''}`);

      if (opts.delayMs) await new Promise(resolve => setTimeout(resolve, opts.delayMs));

      const failure = opts.fails?.(scope, cursor);

      if (failure) throw failure;

      const at   = cursor ? Number(cursor.split('#')[1]) : 0;
      const next = at + 1;

      return {
        listed: [{ key: `${scope}A-2025-01-${String(next).padStart(2, '0')}.zip`, size: 1, etag: 'e', modified: null }],
        cursor: next < opts.pages[scope]! ? `${scope}#${next}` : null,
      };
    },

    confirm: async () => null,
  };

  return {
    name: 'fake', scanner, base: 'https://x', keyRoot: '',
    getContext: async () => null,
    dateOf: (path) => /(\d{4})-(\d{2})-(\d{2})\.zip$/.exec(path)?.slice(1, 4).join('') ?? null,
    inspectUrl: (path) => {
      const at = /(\d{4})-(\d{2})-(\d{2})\.zip$/.exec(path);

      return at
        ? asSeries(path, { market: 'perp', dataset: 'trades', symbol: 'A', date: at.slice(1, 4).join('') })
        : { of: 'unknown', date: null };
    },
  };
};

/** Each scope's run as it stands: closed or not, and where its cursor is. */
const runs = (): Record<string, { closed: boolean; cursor: string | null }> => {
  const [id] = venueIds(db, 'fake');
  const rows = db.prepare(`SELECT scope, cursor, completed FROM run WHERE venue_id = ? AND scope <> ''`)
    .all(id) as { scope: string; cursor: string | null; completed: string | null }[];

  return Object.fromEntries(rows.map(row => [row.scope, { closed: row.completed !== null, cursor: row.cursor }]));
};

/** Whether any page was asked for more than once. */
const repeated = (): string[] => asks.filter((one, at) => asks.indexOf(one) !== at);

/** A refusal from a CDN that names no key, with the venue's gate already latched by a run of them. */
const latchedRefusal = (adapter: Adapter, url: string): Refused => {
  const headers = new Headers({ server: 'CloudFront', 'x-cache': 'Error from cloudfront' });
  const gate    = paceFor(adapter, url);

  for (let i = 0; i < REFUSALS_BEFORE_BLOCK; i++) gate.block(403, url, headers);

  return new Refused(403, headers, url);
};

/** The fields of the survey's closing warning, where it gave one. */
const incomplete = (): Record<string, unknown> | undefined =>
  vi.mocked(logger.warn).mock.calls
    .find(call => call[1] === 'Survey incomplete; the next pass resumes it')?.[0] as Record<string, unknown> | undefined;

/** Long enough for anything still walking to have asked for another page. */
const settle = (): Promise<void> => new Promise(resolve => setTimeout(resolve, 40));

describe('a split whose level cannot be read', () => {
  it('walks the partition on whole, once, and the survey answers', async () => {
    const adapter = venue({
      pages:   { 'a/': 10, 'b/': 10 },
      delayMs: 2,
      level:   async () => {
        await new Promise(resolve => setTimeout(resolve, 5));

        throw new Error('level read failed');
      },
    });

    const summary = await surveyVenue(db, adapter, lanes(3), 'full');
    const asked   = asks.length;

    await settle();

    expect(summary).toMatchObject({ failed: 0, blocked: false, generated: true });
    expect(runs()).toEqual({ 'a/': { closed: true, cursor: null }, 'b/': { closed: true, cursor: null } });
    expect(repeated()).toEqual([]);
    expect(asks).toHaveLength(20);

    // A scope whose level failed is not offered for splitting again.
    expect(new Set(levels).size).toBe(levels.length);

    // Nothing was still walking when it answered.
    expect(asks.length).toBe(asked);
  });

  /** A level refused with the gate latched is a block like any other: the pass stops, with nothing lost. */
  it('stops the pass when the venue is blocking us', async () => {
    let adapter: Adapter;

    adapter = venue({
      pages:   { 'a/': 10, 'b/': 10 },
      delayMs: 2,
      level:   async (scope) => { throw latchedRefusal(adapter, `https://x/${scope}`); },
    });

    const summary = await surveyVenue(db, adapter, lanes(3), 'full');

    expect(summary).toMatchObject({ blocked: true });
    expect(summary.generated).toBeUndefined();
    expect(openJob(db, venueIds(db, 'fake')[0]!, 'walk')).not.toBeNull();
    expect(Object.values(runs()).every(run => ! run.closed)).toBe(true);
    expect(repeated()).toEqual([]);
  });
});

describe('a split that does not answer', () => {
  it('is abandoned after its time, and the partition resumes whole', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] });

    const adapter = venue({ pages: { 'fat/': 6 }, level: () => new Promise<Level>(() => {}) });
    const surveying = surveyVenue(db, adapter, lanes(2), 'full');

    // The split is only timed once it has been asked for.
    while (levels.length === 0) await new Promise(resolve => setImmediate(resolve));

    await vi.advanceTimersByTimeAsync(_test_SPLIT_MS);

    const summary = await surveying;

    expect(summary).toMatchObject({ failed: 0, generated: true });
    expect(runs()).toEqual({ 'fat/': { closed: true, cursor: null } });
    expect(levels).toEqual(['fat/']);
    expect(repeated()).toEqual([]);
    expect(asks).toHaveLength(6);
  });
});

describe('a split whose children are all behind the cursor', () => {
  /** `!` sorts before the cursor's `#`, so every child is already read and splitting would only close the parent. */
  it('leaves the parent to walk on, rather than closing it', async () => {
    const adapter = venue({
      pages: { 'fat/': 6 },
      level: async scope => ({ children: scope === 'fat/' ? ['fat/!/'] : [], files: false }),
    });

    const summary = await surveyVenue(db, adapter, lanes(2), 'full');

    expect(summary).toMatchObject({ failed: 0, generated: true });
    expect(runs()).toEqual({ 'fat/': { closed: true, cursor: null } });
    expect(levels).toEqual(['fat/']);
    expect(asks).toHaveLength(6);
  });
});

describe('a pause during a page retry wait', () => {
  it('leaves without asking again, the cursor where it was', async () => {
    let pausing = false;

    retryWait(async () => { pausing = true; });

    const adapter = venue({
      pages: { 'deep/': 5 },
      fails: (_scope, cursor) => (cursor === 'deep/#2' ? new TypeError('fetch failed') : null),
    });

    const summary = await surveyVenue(db, adapter, lanes(1), 'full', () => pausing);

    expect(summary).toMatchObject({ paused: true, failed: 0 });
    expect(asks).toEqual(['deep/@', 'deep/@deep/#1', 'deep/@deep/#2']);
    expect(runs()).toEqual({ 'deep/': { closed: false, cursor: 'deep/#2' } });
  });
});

describe('a lane that fails outside any partition', () => {
  it('answers only once every other lane has stopped walking', async () => {
    let thrown = false;

    vi.mocked(logger.info).mockImplementation(((_fields: unknown, message?: string) => {
      if (message === 'Partitions walked' && ! thrown) {
        thrown = true;

        throw new Error('lane broke');
      }
    }) as typeof logger.info);

    const adapter = venue({ pages: { 'fast/': 1, 'slow/': 500 }, delayMs: 1 });

    await expect(surveyVenue(db, adapter, lanes(2), 'full')).rejects.toThrow('lane broke');

    const asked = asks.length;

    await settle();

    expect(asks.length).toBe(asked);
    expect(runs()['slow/']).toMatchObject({ closed: false });
    expect(repeated()).toEqual([]);
  });
});

describe('a mapping that is refused', () => {
  it('reports a latched block as one, without walking', async () => {
    let adapter: Adapter;

    adapter = venue({ pages: {} });
    adapter = {
      ...adapter,
      scanner: { ...adapter.scanner, scopes: async () => { throw latchedRefusal(adapter, 'https://x/'); } },
    };

    expect(await surveyVenue(db, adapter, lanes(2), 'full')).toMatchObject({ blocked: true, failed: 1 });
    expect(asks).toEqual([]);
  });

  it('throws a lone refusal, for the caller to retry like any failure', async () => {
    let adapter = venue({ pages: {} });

    adapter = {
      ...adapter,
      scanner: {
        ...adapter.scanner,
        scopes: async () => { throw new Refused(403, new Headers({ server: 'CloudFront' }), 'https://x/'); },
      },
    };

    await expect(surveyVenue(db, adapter, lanes(2), 'full')).rejects.toThrow(/Refused 403/);
  });
});

describe('what a pass reports', () => {
  /** Partitions a block left unasked are left on purpose, and said to be. */
  it('counts what a block left as left for the next pass, not as unexplained', async () => {
    let adapter: Adapter;

    adapter = venue({
      pages: { 'a/': 2, 'b/': 2, 'c/': 2 },
      fails: scope => (scope === 'a/' ? latchedRefusal(adapter, 'https://x/a/') : null),
    });

    const summary = await surveyVenue(db, adapter, lanes(1), 'full');

    expect(summary).toMatchObject({ blocked: true, failed: 1 });
    expect(asks).toEqual(['a/@']);
    expect(incomplete()).toMatchObject({ leftForNextPass: 2 });
    expect(incomplete()).not.toHaveProperty('openWithoutAFailure');
  });

  /** A partition stopped to be split is not one walked: only the runs that closed are counted. */
  it('does not count a split partition as settled', async () => {
    const adapter = venue({
      pages:  { 'fat/': 6, 'fat/a/': 1, 'fat/b/': 1 },
      scopes: ['fat/'],
      level: async scope => ({ children: scope === 'fat/' ? ['fat/a/', 'fat/b/'] : [], files: false }),
    });

    await surveyVenue(db, adapter, lanes(3), 'full');

    const progress = vi.mocked(logger.info).mock.calls
      .filter(call => call[1] === 'Partitions walked')
      .map(call => (call[0] as { progress: string }).progress);

    expect(Object.keys(runs()).sort()).toEqual(['fat/', 'fat/a/', 'fat/b/']);
    expect(progress.at(-1)).toBe('2/2');
  });
});
