import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { everyNonOverlapping } from '../src/schedule';

const HOUR = 60 * 60 * 1000;

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

/**
 * The guard is the only thing preventing two sweeps running over the same
 * cursors — a backfill runs far longer than the rescan interval, so ticks
 * landing mid-sweep are the normal case, not the edge case.
 */
describe('everyNonOverlapping', () => {
  it('skips ticks that land while a run is still in flight', async () => {
    let starts = 0;
    let release: () => void = () => {};

    const timer = everyNonOverlapping(HOUR, () => {
      starts++;

      return new Promise<void>(resolve => { release = resolve; });
    });

    await vi.advanceTimersByTimeAsync(HOUR);

    expect(starts).toBe(1);

    // Three more ticks pass while the first run is still going.
    await vi.advanceTimersByTimeAsync(3 * HOUR);

    expect(starts).toBe(1);

    release();
    await vi.advanceTimersByTimeAsync(0);

    // Only once it has finished does the next tick start a run.
    await vi.advanceTimersByTimeAsync(HOUR);

    expect(starts).toBe(2);

    clearInterval(timer);
  });

  /**
   * A run that throws must clear the guard *and* have its rejection handled.
   * An unhandled rejection takes the process down under Node's default policy,
   * so a single bad pass would end rescanning for the life of the service —
   * and `retryAbsences` can reject on ledger I/O, so this is reachable.
   */
  it('keeps rescanning after a run rejects, without floating the rejection', async () => {
    let starts = 0;
    const unhandled: unknown[] = [];

    process.on('unhandledRejection', (err) => unhandled.push(err));

    const timer = everyNonOverlapping(HOUR, async () => {
      starts++;

      throw new Error('sweep blew up');
    });

    await vi.advanceTimersByTimeAsync(HOUR);
    await vi.advanceTimersByTimeAsync(HOUR);

    expect(starts).toBe(2);
    expect(unhandled).toEqual([]);

    process.removeAllListeners('unhandledRejection');
    clearInterval(timer);
  });

  it('does not run the job before the first interval elapses', async () => {
    let starts = 0;

    const timer = everyNonOverlapping(HOUR, async () => { starts++; });

    await vi.advanceTimersByTimeAsync(HOUR - 1);

    expect(starts).toBe(0);

    clearInterval(timer);
  });
});
