import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { backoffDelay, retry } from '../src/retry';

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe('backoffDelay', () => {
  it('doubles from baseMs without jitter, up to maxMs', () => {
    const delays = [1, 2, 3, 4, 5].map(n => backoffDelay(n, { baseMs: 100, maxMs: 1_000, jitter: 'none' }));

    expect(delays).toEqual([100, 200, 400, 800, 1_000]);
  });

  it('spreads a full-jitter wait over [0, exponential), and caps it', () => {
    vi.spyOn(Math, 'random').mockReturnValue(0);
    expect(backoffDelay(3, { baseMs: 100 })).toBe(0);

    vi.spyOn(Math, 'random').mockReturnValue(0.999999);
    expect(backoffDelay(3, { baseMs: 100 })).toBe(399);
    expect(backoffDelay(10, { baseMs: 100, maxMs: 1_000 })).toBe(999);
  });

  it('spreads a fractional-jitter wait over ±fraction, never above maxMs', () => {
    vi.spyOn(Math, 'random').mockReturnValue(0);
    expect(backoffDelay(1, { baseMs: 1_000, jitter: 0.2 })).toBe(800);

    vi.spyOn(Math, 'random').mockReturnValue(1);
    expect(backoffDelay(1, { baseMs: 1_000, jitter: 0.2 })).toBe(1_200);
    expect(backoffDelay(10, { baseMs: 1_000, maxMs: 15_000, jitter: 0.2 })).toBe(15_000);
  });

  it('stays within its bounds for any random draw', () => {
    for (let i = 0; i < 200; i++) {
      const full = backoffDelay(4, { baseMs: 50, maxMs: 300 });
      const spread = backoffDelay(2, { baseMs: 1_000, jitter: 0.5 });

      expect(full).toBeGreaterThanOrEqual(0);
      expect(full).toBeLessThan(300);
      expect(spread).toBeGreaterThanOrEqual(1_000);
      expect(spread).toBeLessThanOrEqual(3_000);
    }
  });

  it('refuses a jitter fraction outside [0, 1]', () => {
    expect(() => backoffDelay(1, { baseMs: 100, jitter: 1.5 })).toThrow(RangeError);
  });
});

describe('retry', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  const failing = (times: number, result = 'ok') => {
    let calls = 0;

    return vi.fn(async (_attempt: number) => {
      if (++calls <= times) throw new Error(`fail ${calls}`);
      return result;
    });
  };

  it('resolves with the first success, waiting the back-off between calls', async () => {
    const fn = failing(2);
    const done = retry(fn, { attempts: 5, baseMs: 100, jitter: 'none' });

    await vi.advanceTimersByTimeAsync(0);
    expect(fn).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(99);
    expect(fn).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(fn).toHaveBeenCalledTimes(2);

    await vi.advanceTimersByTimeAsync(199);
    expect(fn).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1);

    await expect(done).resolves.toBe('ok');
    expect(fn).toHaveBeenCalledTimes(3);
    expect(fn.mock.calls.map(([attempt]) => attempt)).toEqual([1, 2, 3]);
  });

  it('rejects with the last failure once the attempts are spent', async () => {
    const fn = failing(10);
    const done = retry(fn, { attempts: 3, baseMs: 10 });
    const settled = expect(done).rejects.toThrow('fail 3');

    await vi.runAllTimersAsync();
    await settled;
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it('makes a single call with one attempt', async () => {
    const fn = failing(1);

    await expect(retry(fn, { attempts: 1, baseMs: 10 })).rejects.toThrow('fail 1');
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('rejects at once with a failure the predicate declines', async () => {
    const fn = failing(10);
    const shouldRetry = vi.fn((err: unknown, _attempt: number) => (err as Error).message !== 'fail 2');
    const done = retry(fn, { attempts: 5, baseMs: 10, shouldRetry });
    const settled = expect(done).rejects.toThrow('fail 2');

    await vi.runAllTimersAsync();
    await settled;
    expect(fn).toHaveBeenCalledTimes(2);
    expect(shouldRetry.mock.calls.map(([, attempt]) => attempt)).toEqual([1, 2]);
  });

  it('reports each wait before it begins', async () => {
    const onRetry = vi.fn();
    const done = retry(failing(2), { attempts: 3, baseMs: 100, jitter: 'none', onRetry });

    await vi.runAllTimersAsync();
    await done;
    expect(onRetry.mock.calls.map(([err, attempt, ms]) => [(err as Error).message, attempt, ms]))
      .toEqual([['fail 1', 1, 100], ['fail 2', 2, 200]]);
  });

  it('ends a pending wait when the signal aborts, rejecting with its reason', async () => {
    const controller = new AbortController();
    const fn = failing(10);
    const done = retry(fn, { attempts: 5, baseMs: 10_000, jitter: 'none', signal: controller.signal });
    const settled = expect(done).rejects.toBe('stop');

    await vi.advanceTimersByTimeAsync(1_000);
    controller.abort('stop');
    await settled;
    expect(fn).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('makes no call once the signal has aborted, and passes the signal to each call', async () => {
    const controller = new AbortController();
    controller.abort('gone');
    const fn = vi.fn(async () => 'ok');

    await expect(retry(fn, { attempts: 3, baseMs: 10, signal: controller.signal })).rejects.toBe('gone');
    expect(fn).not.toHaveBeenCalled();

    const live = new AbortController();
    await retry(fn, { attempts: 3, baseMs: 10, signal: live.signal });
    expect(fn).toHaveBeenCalledWith(1, live.signal);
  });

  it('does not retry a failure that comes after the signal aborted', async () => {
    const controller = new AbortController();
    const fn = vi.fn(async () => {
      controller.abort('stop');
      throw new Error('aborted work');
    });

    await expect(retry(fn, { attempts: 5, baseMs: 10, signal: controller.signal })).rejects.toBe('stop');
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('refuses an attempt count that is not a positive integer', async () => {
    await expect(retry(async () => 1, { attempts: 0, baseMs: 10 })).rejects.toThrow(RangeError);
    await expect(retry(async () => 1, { attempts: 1.5, baseMs: 10 })).rejects.toThrow(RangeError);
  });
});
