import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { putVenue, venueIds } from '../src/catalog';
import { openCatalog } from '../src/database';
import { Refused } from '../src/http';
import { _test_retryWait as retryWait, surveyVenue } from '../src/survey';
import type { Adapter, Config, Page, Scanner } from '../src/types';
import type { DatabaseSync } from 'node:sqlite';

/**
 * A page that fails is asked again where it is, and its prefix is only left for
 * the next pass once asking again has stopped being worth it.
 */

let dir: string;
let db:  DatabaseSync;

/** The waits a survey asked for between attempts, none of which is actually waited. */
let waits: number[];

beforeEach(() => {
  dir   = mkdtempSync(join(tmpdir(), 'retry-'));
  db    = openCatalog(join(dir, 'catalog.db'), { seedData: false });
  waits = [];

  putVenue(db, 'fake', 'https://x', '');
  retryWait(async (ms) => { waits.push(ms); });
});

afterEach(() => {
  retryWait(null);
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

const config: Config = {
  catalogDir: '', token: '', port: 0, venues: [],
  concurrency: 1,
};

/** How often each page was asked for, by the page's number. */
let asked: Map<number, number>;

/** One scope, five pages, one dated file each — and a say in whether each request for a page fails. */
const venue = (fails: (page: number, attempt: number) => Error | null): Adapter => {
  asked = new Map();

  const scanner: Scanner<unknown> = {
    name: 'fake',

    scopes: async () => ['deep/'],

    page: async (_context, scope, cursor): Promise<Page> => {
      const at      = cursor ? Number(cursor.split('#')[1]) : 0;
      const attempt = (asked.get(at) ?? 0) + 1;

      asked.set(at, attempt);

      const failure = fails(at, attempt);

      if (failure) throw failure;

      return {
        listed: [{ key: `${scope}A-2025-01-${String(at + 1).padStart(2, '0')}.zip`, size: 1, etag: 'e', modified: null }],
        cursor: at + 1 < 5 ? `${scope}#${at + 1}` : null,
      };
    },
  };

  return {
    name: 'fake', scanner, base: 'https://x', keyRoot: '',
    getContext: async () => null,
    dateOf: (path) => /(\d{4})-(\d{2})-(\d{2})\.zip$/.exec(path)?.slice(1, 4).join('') ?? null,
  };
};

const open = (): { scope: string; cursor: string | null }[] => {
  const [id] = venueIds(db, 'fake');

  return db.prepare(`SELECT scope, cursor FROM run WHERE venue_id = ? AND scope <> '' AND completed IS NULL`)
    .all(id) as { scope: string; cursor: string | null }[];
};

describe('a page that fails', () => {
  it('is asked again from the same cursor, and the survey carries on as if it had not', async () => {
    const summary = await surveyVenue(db, venue((page, attempt) =>
      (page === 2 && attempt <= 3 ? new TypeError('fetch failed') : null)), config, 'full');

    expect(summary).toMatchObject({ failed: 0, requests: 5 });
    expect(asked.get(2)).toBe(4);
    expect(open()).toEqual([]);
  });

  it('waits longer each time, up to a minute', async () => {
    await surveyVenue(db, venue((page, attempt) =>
      (page === 0 && attempt <= 7 ? new Error('database is locked') : null)), config, 'full');

    expect(waits).toEqual([2_000, 4_000, 8_000, 16_000, 32_000, 60_000, 60_000]);
  });

  /** Waiting does not mend it, so the prefix keeps its cursor and the next pass takes it up. */
  it('leaves its prefix for the next pass after twelve attempts, where it stopped', async () => {
    let broken = true;

    const adapter = venue(page => (page === 3 && broken ? new TypeError('fetch failed') : null));
    const summary = await surveyVenue(db, adapter, config, 'full');

    expect(summary).toMatchObject({ failed: 1 });
    expect(asked.get(3)).toBe(12);
    expect(open()).toEqual([{ scope: 'deep/', cursor: 'deep/#3' }]);

    broken = false;

    expect(await surveyVenue(db, adapter, config, 'full')).toMatchObject({ failed: 0, requests: 2 });
    expect(open()).toEqual([]);
  });

  /** A refusal is the venue's answer, and asking again is another request against it. */
  it('does not ask again for a page the venue refused', async () => {
    const summary = await surveyVenue(db, venue(page =>
      (page === 1 ? new Refused(404, new Headers(), 'https://x/deep/') : null)), config, 'full');

    expect(summary.failed).toBe(1);
    expect(asked.get(1)).toBe(1);
    expect(waits).toEqual([]);
  });
});
