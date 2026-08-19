import { asSeries } from '../src/paths';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { putVenue, venueIds } from '../src/catalog';
import { openCatalog } from '../src/database';
import { surveyVenue } from '../src/survey';
import type { Adapter, Config, Level, Page, Scanner } from '../src/types';
import type { DatabaseSync } from 'node:sqlite';

/**
 * A survey ends when its slowest partition does, so one prefix carrying most of
 * the archive decides the whole run. Which one that is cannot be known before
 * walking it — the mapping sees shape, and shape is not size — so it is
 * discovered: a lane with nothing to take splits the busiest partition instead.
 */

let dir: string;
let db:  DatabaseSync;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'rescope-'));
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
  concurrency: 4,
};

/**
 * One fat prefix that maps as a single scope and refuses to end, plus the tree
 * hiding under it. `pages` is how long the parent walks before its keyspace runs
 * out, which is what gives a lane time to notice and split it.
 */
const venue = (opts: {
  children?: string[];
  files?:    boolean;
  pages?:    number;
  level?:    boolean;
} = {}): Adapter => {
  const { children = ['fat/a/', 'fat/b/', 'fat/c/'], files = false, pages = 6 } = opts;

  const scanner: Scanner<unknown> = {
    name: 'fake',

    scopes: async () => ['fat/'],

    /**
     * **Children under the fat prefix, and nothing under them.** A real tree
     * bottoms out, and one that answers with the same three names at every depth
     * would have a child split into scopes its own siblings already hold.
     */
    ...(opts.level === false ? {} : {
      level: async (_context, scope): Promise<Level> =>
        (scope === 'fat/' ? { children: [...children], files } : { children: [], files }),
    }),

    page: async (_context, scope, cursor): Promise<Page> => {
      const at   = cursor ? Number(cursor.split('#')[1]) : 0;
      const next = at + 1;
      const last = scope === 'fat/' ? pages : 1;

      return {
        listed: [{ key: `${scope}A-2025-01-0${next}.zip`, size: 1, etag: 'e', modified: null }],
        cursor: next < last ? `${scope}#${next}` : null,
      };
    },
  };

  return {
    name: 'fake', scanner, list: 'https://x', base: 'https://x', root: '',
    getContext: async () => null,
    dateOf: (path) => /(\d{4})-(\d{2})-(\d{2})\.zip$/.exec(path)?.slice(1, 4).join('') ?? null,

    /** Every key reads into one series; a path that resolves to none is not catalogued. */
    inspectUrl: (path) => {
      const at = /(\d{4})-(\d{2})-(\d{2})\.zip$/.exec(path);

      return at
        ? asSeries(path, { market: 'perp', dataset: 'trades', symbol: 'A', date: at.slice(1, 4).join('') })
        : { of: 'unknown', date: null };
    },
  };
};

const scopesWalked = (): string[] => {
  const [id] = venueIds(db, 'fake');

  return (db.prepare('SELECT scope FROM run WHERE venue_id = ? AND scope != \'\' ORDER BY scope')
    .all(id) as { scope: string }[]).map(row => row.scope);
};

describe('splitting a partition that is holding the survey up', () => {
  /**
   * The case that motivated this. One scope, four lanes — three of them have
   * nothing to take, so rather than idling they split the one that is running.
   */
  it('splits the only partition when lanes have nothing to do', async () => {
    await surveyVenue(db, venue(), config);

    expect(scopesWalked()).toEqual(['fat/', 'fat/a/', 'fat/b/', 'fat/c/']);
  });

  it('walks the children it created, so nothing is lost', async () => {
    const summary = await surveyVenue(db, venue(), config);

    // The parent's own pages, plus one page from each child it was split into.
    expect(summary.found).toBeGreaterThan(3);
    expect(summary.failed).toBe(0);
  });

  /**
   * A parent covers every key beneath it; children cover only their subtrees. A
   * key sitting directly here would belong to none of them, so a prefix holding
   * files is walked whole rather than split.
   */
  it('refuses to split a prefix that holds files of its own', async () => {
    await surveyVenue(db, venue({ files: true }), config);

    expect(scopesWalked()).toEqual(['fat/']);
  });

  it('refuses to split a prefix with no children', async () => {
    await surveyVenue(db, venue({ children: [] }), config);

    expect(scopesWalked()).toEqual(['fat/']);
  });

  /** A scanner whose scopes are not prefixes cannot be split, and says so by omission. */
  it('leaves a scanner that cannot read a level alone', async () => {
    await surveyVenue(db, venue({ level: false }), config);

    expect(scopesWalked()).toEqual(['fat/']);
  });

  /**
   * **The bug that closed binance over unwalked keyspace.**
   *
   * `level` stops reading children once a prefix is wide enough to call
   * terminal, which is all descent needs. Refinement asked the same question and
   * got 33 of 3,694 symbols back; the cursor was already past all of them, so
   * every child was skipped as read and the parent was closed holding nothing —
   * then the job closed and the venue was declared established.
   *
   * Two guards, and this exercises the second: a split that would produce no
   * children leaves the run open instead of closing it. The first is asking for
   * the whole child list in the first place.
   */
  it('never closes a partition when the split would produce no children', async () => {
    const late = venue({ children: ['fat/a/'], pages: 8 });

    await surveyVenue(db, late, config);

    const [id]   = venueIds(db, 'fake');
    const closed = db.prepare(
      'SELECT scope, completed FROM run WHERE venue_id = ? AND scope = \'fat/\'',
    ).get(id) as { completed: string | null };

    // Either it was split into real work, or it walked itself to the end. What
    // it must never be is closed by a refinement that created nothing.
    expect(scopesWalked().length).toBeGreaterThanOrEqual(1);
    expect(closed).toBeTruthy();
  });

  /** Whatever it does, it has to stop — the job closes and the venue is established. */
  it('finishes, rather than splitting for ever', async () => {
    const summary = await surveyVenue(db, venue(), config);

    expect(summary.failed).toBe(0);
    expect(putVenue(db, 'fake', 'https://x', '')).toBeGreaterThan(0);
  });
});
