import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { poll } from '../web/api';

/** `poll`, on fake timers, against an `ask` that answers when told to. */

beforeEach(() => { vi.useFakeTimers(); });
afterEach(() => { vi.useRealTimers(); });

/** An `ask` that answers at once, counting its requests and the ones cancelled. */
const counting = () => {
  const seen = { asked: 0, aborted: 0 };
  const ask = (signal: AbortSignal): Promise<number> => {
    seen.asked += 1;
    signal.addEventListener('abort', () => { seen.aborted += 1; });

    return Promise.resolve(seen.asked);
  };

  return { seen, ask };
};

describe('poll', () => {
  it('reads the interval at each wait: a change neither cancels nor asks early, and the next wait uses it', async () => {
    const { seen, ask } = counting();
    let every = 10_000;
    const polling = poll(ask, () => every, { data: () => undefined });

    await vi.advanceTimersByTimeAsync(0);
    expect(seen.asked).toBe(1);

    // The first wait was set at 10 s; quickening the pace now changes the wait after it.
    every = 2_000;
    await vi.advanceTimersByTimeAsync(9_999);
    expect(seen).toEqual({ asked: 1, aborted: 0 });

    await vi.advanceTimersByTimeAsync(1);
    expect(seen.asked).toBe(2);

    await vi.advanceTimersByTimeAsync(2_000);
    expect(seen.asked).toBe(3);

    every = 10_000;
    await vi.advanceTimersByTimeAsync(2_000);
    expect(seen.asked).toBe(4);

    await vi.advanceTimersByTimeAsync(9_999);
    expect(seen).toEqual({ asked: 4, aborted: 0 });

    polling.stop();
  });

  it('takes a fixed interval as before', async () => {
    const { seen, ask } = counting();
    const polling = poll(ask, 5_000, { data: () => undefined });

    await vi.advanceTimersByTimeAsync(5_000);
    expect(seen.asked).toBe(2);

    polling.stop();
    await vi.advanceTimersByTimeAsync(50_000);
    expect(seen.asked).toBe(2);
  });

  it('hands a failure to `error` and keeps asking', async () => {
    const failures: string[] = [];
    let calls = 0;
    const polling = poll(
      async () => { calls += 1; throw new Error('502 — down'); },
      1_000,
      { data: () => undefined, error: err => failures.push(err.message) },
    );

    await vi.advanceTimersByTimeAsync(1_000);

    expect(calls).toBe(2);
    expect(failures).toEqual(['502 — down', '502 — down']);

    polling.stop();
  });
});
