import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { publishedOptions, unsavedLens } from '../web/views/Lenses';

/** The lens page's own reads: what the venues publish, and the unsaved lens a browser kept. */

afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });

describe('publishedOptions', () => {
  /** Each test starts well clear of any reading an earlier one left behind. */
  let clock = Date.now();

  beforeEach(() => {
    vi.useFakeTimers();
    clock += 10 * 60_000;
    vi.setSystemTime(clock);
  });

  it('forgets a failed reading, so the next caller asks again; a good one is shared', async () => {
    const calls: string[] = [];
    let answer: () => Response = () => new Response('{"error":"down"}', { status: 502 });

    vi.stubGlobal('fetch', async (url: string) => { calls.push(url); return answer(); });

    await expect(publishedOptions()).rejects.toThrow('502 — down');

    const option = { venue: 'binance', market: 'spot', dataset: 'klines', variant: '1m' };

    answer = () => new Response(JSON.stringify({ items: [option] }), { status: 200 });

    expect(await publishedOptions()).toEqual([option]);
    expect(await publishedOptions()).toEqual([option]);
    expect(calls).toEqual(['/api/catalog/lenses/options', '/api/catalog/lenses/options']);
  });

  it('asks again once a reading is a minute old', async () => {
    let calls = 0;

    vi.stubGlobal('fetch', async () => { calls += 1; return new Response('{"items":[]}', { status: 200 }); });

    await publishedOptions();
    vi.setSystemTime(Date.now() + 30_000);
    await publishedOptions();
    expect(calls).toBe(1);

    vi.setSystemTime(Date.now() + 31_000);
    await publishedOptions();
    expect(calls).toBe(2);
  });
});

describe('unsavedLens', () => {
  const holding = (value: string | null): void => {
    vi.stubGlobal('localStorage', { getItem: () => value });
  };

  it('is none for something kept that is not shaped like a lens', () => {
    holding('{"foo":1}');
    expect(unsavedLens()).toBeNull();

    holding('{"slug":"x","definition":{"format":1}}');
    expect(unsavedLens()).toBeNull();

    holding('{"slug":"x","definition":{"venues":null}}');
    expect(unsavedLens()).toBeNull();

    holding('{"slug":3,"definition":{"venues":{}}}');
    expect(unsavedLens()).toBeNull();

    holding('not json');
    expect(unsavedLens()).toBeNull();
  });

  it('is none where nothing is kept', () => {
    holding(null);
    expect(unsavedLens()).toBeNull();
  });

  it('is the kept lens where it has an address and rules by venue', () => {
    const lens = { slug: 'cold', name: '', note: '', definition: { format: 1, venues: {} } };

    holding(JSON.stringify(lens));
    expect(unsavedLens()).toEqual(lens);
  });
});
