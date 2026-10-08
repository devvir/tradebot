import { afterEach, describe, expect, it, vi } from 'vitest';
import { _test_pause as pauseWith, venues } from '../../../src/tools/cold/shared/catalog';
import type { ColdConfig } from '../../../src/tools/cold/types';

/** A catalog that is not there is waited for: a command left running is not ended by it. */

const config = { catalogUrl: 'http://catalog.test', catalogToken: '' } as ColdConfig;

afterEach(() => {
  pauseWith(null);
  vi.unstubAllGlobals();
});

/** The catalog, answering each request in turn with one of these. */
const catalog = (...answers: (Error | Response)[]) => {
  const waits: number[] = [];

  pauseWith(async (ms) => { waits.push(ms); });

  vi.stubGlobal('fetch', vi.fn(async () => {
    const next = answers.shift()!;

    if (next instanceof Error) throw next;

    return next;
  }));

  return waits;
};

const ok = () => new Response(JSON.stringify({ items: [{ venue: 'gate' }] }), { status: 200 });

describe('a question to the catalog', () => {
  it('is asked again, longer apart each time, until the catalog answers', async () => {
    const waits = catalog(new TypeError('fetch failed'), new TypeError('fetch failed'), new Response('busy', { status: 503 }), ok());

    expect(await venues(config)).toEqual(['gate']);
    expect(waits).toEqual([5_000, 10_000, 20_000]);
  });

  /** The catalog was there and said no: asking again changes nothing. */
  it('fails at once on an answer that is the catalog\'s own', async () => {
    const waits = catalog(new Response('no such venue', { status: 404 }));

    await expect(venues(config)).rejects.toThrow(/answered 404/);
    expect(waits).toEqual([]);
  });
});
