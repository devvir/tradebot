import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { listPartitions } from '../src/catalog';

/** A fetch failing as undici fails it, over a connection that could not be made. */
const unreachable = (): Promise<Response> => Promise.reject(new TypeError('fetch failed'));

const listing = (): Promise<Response> =>
  Promise.resolve(new Response(JSON.stringify({ items: [] }), { status: 200 }));

/** Run `listing` to its end, letting every wait between attempts pass. */
const settled = async <T>(listing: Promise<T>): Promise<PromiseSettledResult<T>> => {
  const outcome = Promise.allSettled([listing]);

  await vi.runAllTimersAsync();

  return (await outcome)[0];
};

describe('asking the catalog', () => {
  let calls: number[];

  /** Each call to the catalog answers as the next of `answers` does, and is timed. */
  const answering = (...answers: (() => Promise<Response>)[]): void => {
    vi.stubGlobal('fetch', () => {
      calls.push(Date.now());

      return answers[Math.min(calls.length, answers.length) - 1]();
    });
  };

  beforeEach(() => {
    calls = [];
    vi.useFakeTimers({ now: 0 });
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('tries a connection that failed again, waiting 2 s and then twice as long each time', async () => {
    answering(unreachable, unreachable, unreachable, listing);

    const outcome = await settled(listPartitions('binance', ['trades']));

    expect(outcome.status).toBe('fulfilled');
    expect(calls).toEqual([0, 2_000, 6_000, 14_000]);
  });

  it('gives up after four attempts with the last failure', async () => {
    answering(unreachable);

    const outcome = await settled(listPartitions('binance', ['trades']));

    expect(outcome).toMatchObject({ status: 'rejected', reason: expect.any(TypeError) });
    expect(calls).toHaveLength(4);
  });

  it('takes an answer, of any status, as the catalog\'s verdict, asked once', async () => {
    answering(() => Promise.resolve(new Response('no', { status: 500 })));

    const outcome = await settled(listPartitions('binance', ['trades']));

    expect(outcome).toMatchObject({ status: 'rejected', reason: { message: expect.stringContaining('Catalog answered 500') } });
    expect(calls).toHaveLength(1);
  });
});
