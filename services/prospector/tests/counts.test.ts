import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { htx } from '../src/adapters/htx';
import { beginJob, closeRun, openJob, openPartitions, putVenue } from '../src/catalog';
import { openCatalog } from '../src/database';
import { fetchPage } from '../src/http';
import { _test_pending, countAsked, countSent, flushCounts } from '../src/counts';
import type { DatabaseSync } from 'node:sqlite';
import type { Adapter } from '../src/types';

/**
 * What a job needed, and what that actually sent.
 *
 * **`asked` is how walks and updates get compared**, so it counts one per
 * request the pass needs and is deaf to what the network made of it; `sent`
 * carries the retries. Both end up on the job they were for, including the
 * requests made before that job had a row.
 */

const primary:   Adapter = { ...htx, name: 'split', host: 'primary',   pacing: { perSecond: 1000 } };
const secondary: Adapter = { ...htx, name: 'split', host: 'secondary', pacing: { perSecond: 1000 } };

let dir: string;
let db:  DatabaseSync;
let one: number;
let two: number;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'sent-'));
  db  = openCatalog(join(dir, 'catalog.db'), { seedData: false });
  one = putVenue(db, 'split', 'https://one', '', 'primary');
  two = putVenue(db, 'split', 'https://two', '', 'secondary');
});

afterEach(() => {
  _test_pending.clear();
  vi.unstubAllGlobals();
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

const sent = (venueId: number, kind: 'walk' | 'update' = 'walk'): number =>
  openJob(db, venueId, kind)!.sent;

const asked = (venueId: number, kind: 'walk' | 'update' = 'walk'): number =>
  openJob(db, venueId, kind)!.asked;

describe('counting what goes out', () => {
  it('counts a retry as sent, but as one request asked for', async () => {
    const timeout = Object.assign(new Error('The operation was aborted due to timeout'), { name: 'TimeoutError' });

    vi.stubGlobal('fetch', vi.fn()
      .mockRejectedValueOnce(timeout)
      .mockResolvedValueOnce(new Response('<ListBucketResult/>')));

    beginJob(db, one, 'walk', ['spot/']);
    await fetchPage(primary, 'https://venue/?prefix=spot/', 's3');
    flushCounts(db);

    expect([asked(one), sent(one)]).toEqual([1, 2]);
  });

  it('keeps each host to its own job', () => {
    beginJob(db, one, 'walk', ['spot/']);
    beginJob(db, two, 'walk', ['spot/']);

    countSent(primary);
    countSent(primary);
    countSent(secondary);
    flushCounts(db);

    expect([sent(one), sent(two)]).toEqual([2, 1]);
  });
});

describe('writing it out', () => {
  it('adds to what the job already carries', () => {
    beginJob(db, one, 'walk', ['spot/']);

    countAsked(primary);
    countSent(primary);
    flushCounts(db);
    countSent(primary);
    countSent(primary);
    flushCounts(db);

    expect([asked(one), sent(one)]).toEqual([1, 3]);
  });

  it('leaves the partitions at zero', () => {
    beginJob(db, one, 'walk', ['spot/', 'futures/']);

    countAsked(primary);
    countSent(primary);
    flushCounts(db);

    expect(openPartitions(db, one, 'walk').map(run => [run.asked, run.sent]))
      .toEqual([[0, 0], [0, 0]]);
  });

  /** Mapping an archive is sent before the walk it plans has a row. */
  it('holds a count until there is a job to put it on', () => {
    countAsked(primary);
    countSent(primary);
    countSent(primary);

    expect(flushCounts(db)).toBe(0);

    beginJob(db, one, 'walk', ['spot/']);

    expect(flushCounts(db)).toBe(2);
    expect([asked(one), sent(one)]).toEqual([1, 2]);
    expect(flushCounts(db)).toBe(0);
  });

  it('does not write onto a job that has closed', () => {
    const job = beginJob(db, one, 'walk', ['spot/']);

    closeRun(db, job.id);
    countSent(primary);

    expect(flushCounts(db)).toBe(0);

    beginJob(db, one, 'update', ['series/1']);
    flushCounts(db);

    expect(sent(one, 'update')).toBe(1);
  });

  /** An update forced over an unfinished walk leaves both open. */
  it('goes to the newest job where two are open', () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-09-01T00:00:00Z'));
    beginJob(db, one, 'walk', ['spot/']);
    vi.setSystemTime(new Date('2026-09-02T00:00:00Z'));
    beginJob(db, one, 'update', ['series/1']);
    vi.useRealTimers();

    countSent(primary);
    flushCounts(db);

    expect([sent(one, 'walk'), sent(one, 'update')]).toEqual([0, 1]);
  });

  it('writes only the adapter it is asked about', () => {
    beginJob(db, one, 'walk', ['spot/']);
    beginJob(db, two, 'walk', ['spot/']);

    countSent(primary);
    countSent(secondary);
    flushCounts(db, primary);

    expect([sent(one), sent(two)]).toEqual([1, 0]);

    flushCounts(db);

    expect(sent(two)).toBe(1);
  });
});
