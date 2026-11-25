import { logger } from '@devvir/service-kit';
import { catchUp, lensNamed, lenses } from '@tradebot/lenses';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { _test_settleMs as settleMs, keepLensesCurrent, lensesChanged } from '../src/lenses';
import type { DatabaseSync } from 'node:sqlite';

/**
 * How rounds of bringing the lenses up to date follow one another: what a save
 * during a round leads to, and what a round that fails leaves behind. The
 * lenses themselves are stood in for, since what is measured here is how many
 * rounds run and not what any of them works out.
 */

vi.mock('@tradebot/lenses', () => ({ catchUp: vi.fn(), lensNamed: vi.fn(), lenses: vi.fn() }));

const db = {} as DatabaseSync;

/** Ends the background rounds, started by each test as the service starts them. */
let stop: () => void = () => {};

beforeEach(() => {
  vi.mocked(lenses).mockReturnValue([{ slug: 'one' }] as never);
  vi.mocked(lensNamed).mockImplementation((_db, slug) => ({ slug }) as never);
  vi.mocked(logger.warn).mockClear();
  settleMs(5);
});

afterEach(() => {
  stop();
  settleMs(null);
  vi.mocked(catchUp).mockReset();
  vi.mocked(lenses).mockReset();
  vi.mocked(lensNamed).mockReset();
});

const passes = (): number => vi.mocked(lenses).mock.calls.length;

const pause = (ms: number) => new Promise(done => setTimeout(done, ms));

describe('rounds of bringing the lenses up to date', () => {
  /**
   * **Saves during a round are taken up once, by the next pass.** A pass reads
   * the list as it begins, so whatever was saved after that is left for the
   * pass that follows — and however many saves there were, one pass covers
   * them all.
   */
  it('runs exactly one more pass for the saves that arrived during one', async () => {
    const begun = Date.now();

    let saved = 0;

    // The first pass keeps stepping for a while, and is saved over twice as it does.
    vi.mocked(catchUp).mockImplementation(() => {
      if (passes() > 1) return false;

      const elapsed = Date.now() - begun;

      if (saved === 0 || (saved === 1 && elapsed >= 15)) { saved++; lensesChanged(); }

      return elapsed < 40;
    });

    stop = keepLensesCurrent(db);

    await vi.waitFor(() => expect(passes()).toBe(2));
    await pause(40);

    expect(saved).toBe(2);
    expect(passes()).toBe(2);
  });

  /** A lens that throws says so once, and the next round runs as if it had not. */
  it('logs a lens that failed, and runs the next round', async () => {
    vi.mocked(catchUp)
      .mockImplementationOnce(() => { throw new Error('boom'); })
      .mockReturnValue(false);

    stop = keepLensesCurrent(db);

    await vi.waitFor(() => expect(logger.warn).toHaveBeenCalledTimes(1));

    lensesChanged();

    await vi.waitFor(() => expect(passes()).toBe(2));

    expect(vi.mocked(catchUp).mock.calls).toHaveLength(2);
    expect(logger.warn).toHaveBeenCalledTimes(1);
  });

  /** A lens that cannot be brought up to date is reported by its slug, and the lenses after it still are. */
  it('goes on to the next lens past one that throws', async () => {
    vi.mocked(lenses).mockReturnValue([{ slug: 'bad' }, { slug: 'good' }] as never);
    vi.mocked(catchUp).mockImplementation((_db, lens) => {
      if (lens.slug === 'bad') throw new Error('boom');

      return false;
    });

    stop = keepLensesCurrent(db);

    await vi.waitFor(() => expect(vi.mocked(catchUp).mock.calls.map(([, lens]) => lens.slug)).toEqual(['bad', 'good']));

    expect(logger.warn).toHaveBeenCalledTimes(1);
    expect(vi.mocked(logger.warn).mock.calls[0]?.[0]).toMatchObject({ lens: 'bad' });
  });
});
