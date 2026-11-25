import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { logger } from '@devvir/service-kit';
import { enrol, enrolled, putVenue, resetRuns } from '../src/catalog';
import { openCatalog } from '../src/database';
import { _test_begin, pause, running } from '../src/index';
import { syncVenue } from '../src/sync';
import type { DatabaseSync } from 'node:sqlite';
import type { Adapter } from '../src/types';

/** Importing the service's entry point must not start the service. */
vi.mock('../src/service', () => ({ default: { run: vi.fn() } }));

vi.mock('../src/sync', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/sync')>()),
  syncVenue: vi.fn(),
}));

vi.mock('../src/venues', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/venues')>()),
  adaptersForVenue: () => [{ name: 'fake' } as Adapter],
}));

vi.mock('../src/catalog', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/catalog')>();

  return { ...actual, resetRuns: vi.fn(actual.resetRuns) };
});

/**
 * Starting a venue while its loop is still running.
 *
 * **The latest request wins.** A refresh or a forced update stops the loop and
 * waits for it before starting again; anything asked in that wait overrules it.
 * Two refreshes discard the runs once, and a pause sent during the wait leaves
 * the venue paused with its runs where they were.
 */

let dir: string;
let db:  DatabaseSync;
let id:  number;

/** One per loop started, in order: what lets that loop end once it has been asked to stop. */
let loops: { release: () => void }[];

beforeEach(() => {
  dir   = mkdtempSync(join(tmpdir(), 'begin-'));
  db    = openCatalog(join(dir, 'catalog.db'), { seedData: false });
  id    = putVenue(db, 'fake', 'https://x', '');
  loops = [];

  /** A loop that runs until it is asked to stop, and then until the test lets it go. */
  vi.mocked(syncVenue).mockImplementation(async (_db, _adapter, _config, _occasion, paused = () => false) => {
    let release = (): void => {};
    const released = new Promise<void>(resolve => { release = resolve; });

    loops.push({ release });

    while (! paused()) await new Promise(resolve => setTimeout(resolve, 5));

    await released;
  });
});

afterEach(async () => {
  for (const loop of loops) loop.release();

  pause(db, 'fake');
  await stopped();

  vi.mocked(syncVenue).mockReset();
  vi.mocked(resetRuns).mockClear();
  vi.mocked(logger.error).mockClear();
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

/** A run row, as a walk in progress leaves it. */
const progress = (): void => {
  db.prepare(`INSERT INTO run (venue_id, kind, scope, started) VALUES (?, 'walk', 'deep/', ?)`)
    .run(id, new Date().toISOString());
};

const runs = (): number =>
  (db.prepare('SELECT COUNT(*) AS n FROM run WHERE venue_id = ?').get(id) as { n: number }).n;

/** Resolves once no loop is running for the venue. */
const stopped = async (): Promise<void> => {
  while (running('fake')) await new Promise(resolve => setTimeout(resolve, 10));
};

/** A venue enrolled and being surveyed, with progress on record. */
const surveying = async (): Promise<void> => {
  enrol(db, 'fake', new Date().toISOString());
  progress();

  await _test_begin(db, 'fake', 'full', false);

  expect(running('fake')).toBe(true);
};

describe('two refreshes in a row', () => {
  it('discards the runs once, and leaves nothing waiting', async () => {
    await surveying();

    const first  = _test_begin(db, 'fake', 'full', true);
    const second = _test_begin(db, 'fake', 'full', true);

    loops[0]!.release();

    await Promise.all([first, second]);

    expect(resetRuns).toHaveBeenCalledTimes(1);
    expect(loops).toHaveLength(2);
    expect(running('fake')).toBe(true);
  });

  /** What a request still waiting would do once the venue next stopped: lift the pause and reset. */
  it('leaves a later pause standing', async () => {
    await surveying();

    const first  = _test_begin(db, 'fake', 'full', true);
    const second = _test_begin(db, 'fake', 'full', true);

    loops[0]!.release();
    await Promise.all([first, second]);

    progress();

    expect(pause(db, 'fake')).toBe(true);

    loops[1]!.release();
    await stopped();
    await new Promise(resolve => setTimeout(resolve, 300));

    expect(enrolled(db, 'fake')?.pausedAt).not.toBeNull();
    expect(running('fake')).toBe(false);
    expect(runs()).toBe(1);
    expect(resetRuns).toHaveBeenCalledTimes(1);
  });
});

describe('a pause while a request waits for the loop to stop', () => {
  for (const [what, occasion, refresh] of [
    ['a refresh',       'full',    true],
    ['a forced update', 'partial', false],
  ] as const)
    it(`leaves the venue paused, after ${what}`, async () => {
      await surveying();

      const asked = _test_begin(db, 'fake', occasion, refresh);

      expect(pause(db, 'fake')).toBe(true);

      loops[0]!.release();
      await asked;

      expect(enrolled(db, 'fake')?.pausedAt).not.toBeNull();
      expect(running('fake')).toBe(false);
      expect(loops).toHaveLength(1);
      expect(runs()).toBe(1);
      expect(resetRuns).not.toHaveBeenCalled();
    });
});

describe('a loop that fails', () => {
  it('is reported, and the venue is no longer running', async () => {
    vi.mocked(syncVenue).mockRejectedValue(new Error('loop broke'));

    enrol(db, 'fake', new Date().toISOString());

    await _test_begin(db, 'fake', 'full', false);
    await stopped();

    expect(vi.mocked(logger.error).mock.calls.some(call => call[1] === 'Survey loop ended')).toBe(true);
  });
});
