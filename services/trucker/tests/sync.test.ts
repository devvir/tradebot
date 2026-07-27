import { describe, expect, it, vi } from 'vitest';
import {
  _test_runPool as runPool,
  _test_settledThrough as settledThrough, syncVenue,
} from '../src/sync';
import { venueFor } from '../src/venues';
import type { ArchiveFile, DownloadResult, Period } from '../src/types';

// config.ts validates TRUCKER_VENUES against VENUE_NAMES at import, so the
// mock must still export the real names.
vi.mock('../src/venues', () => ({
  venueFor:    vi.fn(),
  VENUE_NAMES: ['binance', 'bitget', 'bybit', 'gate', 'htx', 'kucoin', 'okx'],
}));

const file = (date: string, period: Period = 'daily'): ArchiveFile =>
  ({ url: `u/${date}`, path: `p/${date}`, date, symbol: 'BTCUSDT', period });

const outcomes = (...pairs: [string, DownloadResult['status']][]) =>
  new Map(pairs.map(([d, s]) => [`u/${d}`, s]));

const old = '20200101';
const older = '20200102';

describe('settledThrough', () => {
  it('advances across a contiguous run that landed', () => {
    const files = [file(old), file(older)];

    expect(settledThrough(files, outcomes([old, 'downloaded'], [older, 'skipped']))).toBe(older);
  });

  // A failure is retryable, so the cursor must not step past it — otherwise the
  // gap is never revisited and the history has a silent hole.
  it('stops at a failure', () => {
    const files = [file(old), file(older)];

    expect(settledThrough(files, outcomes([old, 'downloaded'], [older, 'failed']))).toBe(old);
  });

  it('returns null when the first file failed', () => {
    expect(settledThrough([file(old)], outcomes([old, 'failed']))).toBeNull();
  });

  // Old absences are permanent (symbol not listed yet, market didn't trade),
  // so the cursor moves past them rather than re-probing dead dates forever.
  it('advances past an old absence', () => {
    const files = [file(old), file(older)];

    expect(settledThrough(files, outcomes([old, 'absent'], [older, 'downloaded']))).toBe(older);
  });

  // But a recent absence is "not published yet" and must be retried.
  it('stops at an absence inside the trailing-edge window', () => {
    const today = new Date().toISOString().slice(0, 10).replace(/-/g, '');
    const files = [file(old), file(today)];

    expect(settledThrough(files, outcomes([old, 'downloaded'], [today, 'absent']))).toBe(old);
  });

  /**
   * Gate splits a day of order-book deltas into 24 hourly files that all carry
   * the same date. Judging the date on whichever file happened to land first
   * would mark the day done with 23 hours still missing.
   */
  it('settles a date only when every file covering it has landed', () => {
    const hours = Array.from({ length: 24 }, (_, h) =>
      ({ ...file(old), url: `u/${old}-${h}`, path: `p/${old}-${h}` }));

    const all  = new Map(hours.map(f => [f.url, 'downloaded' as const]));
    const gap  = new Map(all); gap.set(`u/${old}-5`, 'failed');

    expect(settledThrough(hours, all)).toBe(old);
    expect(settledThrough(hours, gap)).toBeNull();
  });

  /** A later date must not settle just because an earlier one did. */
  it('stops at the first date with a hole, leaving later dates unsettled', () => {
    const day1 = [{ ...file(old),   url: `u/${old}-0` },   { ...file(old),   url: `u/${old}-1` }];
    const day2 = [{ ...file(older), url: `u/${older}-0` }, { ...file(older), url: `u/${older}-1` }];

    const outcome = new Map<string, DownloadResult['status']>([
      [`u/${old}-0`, 'downloaded'], [`u/${old}-1`, 'downloaded'],
      [`u/${older}-0`, 'downloaded'], [`u/${older}-1`, 'failed'],
    ]);

    expect(settledThrough([...day1, ...day2], outcome)).toBe(old);
  });

  /**
   * A month publishes only once it has ended, and sometimes days later — Gate's
   * `202607` was still absent on 28 July. A window sized for daily files would
   * let the cursor step over it and lose the month for good.
   */
  it('waits longer for a monthly period than a daily one', () => {
    const now      = new Date('2026-08-05T00:00:00Z');
    const july     = '20260731';
    const files    = [file(old), file(july, 'monthly')];
    const asDaily  = [file(old), file(july, 'daily')];
    const results  = outcomes([old, 'downloaded'], [july, 'absent']);

    expect(settledThrough(files,   results, now)).toBe(old);    // still plausibly unpublished
    expect(settledThrough(asDaily, results, now)).toBe(july);   // a day that late is simply gone
  });
});

describe('syncVenue', () => {
  /**
   * One dataset's metadata fault — a symbols listing down, an instruments API
   * blip — must not abandon every dataset after it for the whole sweep.
   */
  it('continues with the remaining datasets when one fails', async () => {
    // The test dir sits on a small partition; the real floor would trip here.
    const config = (await import('../src/config')).default;

    config.minFreeGb = 0;

    const symbolsA = vi.fn(async () => { throw new Error('listing down'); });
    const symbolsB = vi.fn(async () => [] as string[]);

    vi.mocked(venueFor).mockReturnValue({
      name: 'fake',
      // Without a floor the walk has no month to start from; every venue
      // declares its own, so a fixture must too.
      floor: '202001',
      datasets: [
        { id: 'a', kind: 'trades', market: 'spot', path: 'a' },
        { id: 'b', kind: 'trades', market: 'spot', path: 'b' },
      ],
      symbols: vi.fn()
        .mockImplementationOnce(symbolsA)
        .mockImplementationOnce(symbolsB),
      files: async () => [],
    });

    const stats = await syncVenue('fake');

    expect(symbolsA).toHaveBeenCalled();
    expect(symbolsB).toHaveBeenCalled();   // dataset b still ran
    expect(stats.failed).toBe(0);
  });
});

describe('runPool', () => {
  it('processes every item', async () => {
    const seen: number[] = [];

    await runPool([1, 2, 3, 4, 5], 2, async (n) => { seen.push(n); });

    expect(seen.sort()).toEqual([1, 2, 3, 4, 5]);
  });

  it('never exceeds the concurrency limit', async () => {
    let inFlight = 0, peak = 0;

    await runPool(Array.from({ length: 20 }, (_, i) => i), 3, async () => {
      peak = Math.max(peak, ++inFlight);
      await new Promise(r => setTimeout(r, 1));
      inFlight--;
    });

    expect(peak).toBeLessThanOrEqual(3);
  });

  it('handles an empty list', async () => {
    await expect(runPool([], 4, async () => {})).resolves.toBeUndefined();
  });
});
