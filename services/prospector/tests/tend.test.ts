import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { putVenue, reconcile } from '../src/catalog';
import { openCatalog } from '../src/database';
import { REFUSALS_BEFORE_BLOCK, _test_paces, paceFor } from '../src/pace';
import { surveyVenue } from '../src/survey';
import { _test_FLOOR_MS, _test_onePass, _test_tend } from '../src/sync';
import type { DatabaseSync } from 'node:sqlite';
import type { Adapter, Config, Survey } from '../src/types';

vi.mock('../src/survey', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/survey')>()),
  surveyVenue: vi.fn(),
}));

vi.mock('../src/catalog', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/catalog')>();

  return { ...actual, reconcile: vi.fn(actual.reconcile) };
});

/**
 * How long the survey loop waits after a pass that reported a block.
 *
 * **The gate decides, not the pass.** A pass says it was blocked when a refusal
 * it met had latched the venue's gate; the loop then waits out what the gate
 * still holds. A gate with nothing left to hold gives no reason to wait less
 * than any other unfinished pass does.
 */

const adapter: Adapter = {
  name:    'gated',
  scanner: { name: 'fake', scopes: async () => [], page: async () => ({ listed: [], cursor: null }) },
  base:    'https://gated.example',
  keyRoot: '',
  pacing:  { standDownMs: 5_000, ceilingMs: 10_000 },
  dateOf:  () => null,
};

const config: Config = { catalogDir: '', token: '', port: 0, venues: [], concurrency: 1 };

const pass = (more: Partial<Survey>): Survey => ({
  venue: 'gated', partitions: 1, requests: 0, found: 0, failed: 0, blocked: false, paused: false, ...more,
});

let dir: string;
let db:  DatabaseSync;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'tend-'));
  db  = openCatalog(join(dir, 'catalog.db'), { seedData: false });

  putVenue(db, adapter.name, adapter.base, adapter.keyRoot);

  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] });

  vi.mocked(surveyVenue)
    .mockResolvedValueOnce(pass({ blocked: true, failed: 1 }))
    .mockResolvedValue(pass({ generated: true }));
});

afterEach(() => {
  vi.useRealTimers();
  vi.mocked(surveyVenue).mockReset();
  vi.mocked(reconcile).mockClear();
  _test_paces.clear();
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

/** How many passes the loop has started once `ms` have gone by. */
const passesAfter = async (ms: number): Promise<number> => {
  await vi.advanceTimersByTimeAsync(ms);

  return vi.mocked(surveyVenue).mock.calls.length;
};

describe('after a pass that was blocked', () => {
  it('waits out what the gate still holds', async () => {
    const gate = paceFor(adapter, adapter.base);

    for (let i = 0; i < REFUSALS_BEFORE_BLOCK; i++)
      gate.block(403, adapter.base, new Headers({ server: 'CloudFront' }));

    const held = gate.blockedFor();

    const tending = _test_tend(db, adapter, config, 'full', () => false);

    expect(await passesAfter(0)).toBe(1);
    expect(await passesAfter(held + 1_000)).toBe(2);

    await expect(tending).resolves.toBe(true);
    expect(held).toBeLessThan(_test_FLOOR_MS);
  });

  /** Nothing latched: the pass did not finish, and the loop waits as it does for any such pass. */
  it('takes the ordinary floor when the gate holds nothing', async () => {
    const tending = _test_tend(db, adapter, config, 'full', () => false);

    expect(await passesAfter(0)).toBe(1);
    expect(await passesAfter(_test_FLOOR_MS - 1_000)).toBe(1);
    expect(await passesAfter(2_000)).toBe(2);

    await expect(tending).resolves.toBe(true);
  });

  /** A pass stopped while it waits out a block has not finished, so nothing is reconciled. */
  it('does not reconcile a pass that ends while it waits', async () => {
    const gate = paceFor(adapter, adapter.base);

    for (let i = 0; i < REFUSALS_BEFORE_BLOCK; i++)
      gate.block(403, adapter.base, new Headers({ server: 'CloudFront' }));

    let paused = false;

    const passing = _test_onePass(db, adapter, config, 'full', () => paused);

    expect(await passesAfter(0)).toBe(1);

    paused = true;
    await vi.advanceTimersByTimeAsync(1_000);

    await expect(passing).resolves.toBeUndefined();
    expect(vi.mocked(surveyVenue).mock.calls.length).toBe(1);
    expect(reconcile).not.toHaveBeenCalled();
  });
});

describe('after a pass that threw', () => {
  /** Whatever the survey managed is committed; the next turn continues from its cursors. */
  it('tries again after the floor', async () => {
    vi.mocked(surveyVenue).mockReset()
      .mockRejectedValueOnce(new Error('listing failed 503'))
      .mockResolvedValue(pass({ generated: true }));

    const tending = _test_tend(db, adapter, config, 'full', () => false);

    expect(await passesAfter(0)).toBe(1);
    expect(await passesAfter(_test_FLOOR_MS - 1_000)).toBe(1);
    expect(await passesAfter(2_000)).toBe(2);

    await expect(tending).resolves.toBe(true);
  });
});
