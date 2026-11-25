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

/** An `ask` whose requests stay in flight until `answer` settles the oldest, recording each one's signal. */
const held = () => {
  const pending: { resolve: (n: number) => void; signal: AbortSignal }[] = [];
  let inFlight = 0, most = 0, asked = 0;

  const ask = (signal: AbortSignal): Promise<number> => new Promise(resolve => {
    asked += 1;
    inFlight += 1;
    most = Math.max(most, inFlight);
    pending.push({ signal, resolve: n => { inFlight -= 1; resolve(n); } });
  });

  return {
    ask,
    pending,
    counts: () => ({ asked, inFlight, most }),
    answer: async (n: number): Promise<void> => { pending.shift()?.resolve(n); await vi.advanceTimersByTimeAsync(0); },
  };
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

  it('takes a fixed interval', async () => {
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
  it('never has two requests in flight, however long one takes', async () => {
    const asking = held();
    const polling = poll(asking.ask, 1_000, { data: () => undefined });

    await vi.advanceTimersByTimeAsync(60_000);
    expect(asking.counts()).toEqual({ asked: 1, inFlight: 1, most: 1 });

    await asking.answer(1);
    await vi.advanceTimersByTimeAsync(999);
    expect(asking.counts().asked).toBe(1);

    await vi.advanceTimersByTimeAsync(1);
    expect(asking.counts()).toEqual({ asked: 2, inFlight: 1, most: 1 });

    polling.stop();
  });

  it('asks at once on now(), instead of waiting out the interval', async () => {
    const { seen, ask } = counting();
    const polling = poll(ask, 10_000, { data: () => undefined });

    await vi.advanceTimersByTimeAsync(0);
    polling.now();
    await vi.advanceTimersByTimeAsync(0);
    expect(seen.asked).toBe(2);

    // The wait starts over from that answer.
    await vi.advanceTimersByTimeAsync(9_999);
    expect(seen.asked).toBe(2);

    polling.stop();
  });

  it('asks once more after the request in flight on now(), however often it is called', async () => {
    const asking = held();
    const answers: number[] = [];
    const polling = poll(asking.ask, 10_000, { data: n => answers.push(n) });

    polling.now();
    polling.now();
    polling.now();
    expect(asking.counts()).toEqual({ asked: 1, inFlight: 1, most: 1 });

    await asking.answer(1);
    expect(asking.counts()).toEqual({ asked: 2, inFlight: 1, most: 1 });

    await asking.answer(2);
    await vi.advanceTimersByTimeAsync(9_999);
    expect(asking.counts().asked).toBe(2);
    expect(answers).toEqual([1, 2]);

    polling.stop();
  });

  it('cancels the request in flight on stop(), and drops its answer', async () => {
    const asking = held();
    const answers: number[] = [];
    const failures: Error[] = [];
    const polling = poll(asking.ask, 1_000, { data: n => answers.push(n), error: err => failures.push(err) });

    const inFlight = asking.pending[0]!;

    polling.stop();
    expect(inFlight.signal.aborted).toBe(true);

    await asking.answer(1);
    await vi.advanceTimersByTimeAsync(60_000);

    expect(answers).toEqual([]);
    expect(failures).toEqual([]);
    expect(asking.counts().asked).toBe(1);

    polling.now();
    expect(asking.counts().asked).toBe(1);
  });
});
