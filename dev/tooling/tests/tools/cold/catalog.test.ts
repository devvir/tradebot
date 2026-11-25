import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { _test_answerWithin as answerWithin, _test_pause as pauseWith, once, venues } from '../../../src/tools/cold/shared/catalog';
import type { ColdConfig } from '../../../src/tools/cold/types';

/** A catalog that is not there is waited for: a command left running is not ended by it. */

const config = { catalogUrl: 'http://catalog.test', catalogToken: '' } as ColdConfig;

afterEach(() => {
  pauseWith(null);
  answerWithin(null);
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

  /** A catalog that takes the connection and never answers is one that is not answering. */
  it('fails at once, within the time it is given, where it is not to be waited for', async () => {
    const server = http.createServer(() => {});

    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));

    answerWithin({ patient: 60_000, impatient: 100 });

    try {
      const started = Date.now();
      const silent  = { ...config, catalogUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}` };

      await expect(once(() => venues(silent))).rejects.toThrow(/not answering/);
      expect(Date.now() - started).toBeLessThan(2_000);
    } finally {
      server.closeAllConnections();
      await new Promise(resolve => server.close(resolve));
    }
  });

  /** Only what is asked within `once` is not waited for: a question asked beside it is, as ever. */
  it('waits for a question asked beside one that is not to be waited for', async () => {
    let down = true;

    pauseWith(async () => { down = false; });

    vi.stubGlobal('fetch', vi.fn(async () => down ? new Response('busy', { status: 503 }) : ok()));

    const waited = venues(config);
    const looked = once(() => venues(config));

    await expect(looked).rejects.toThrow(/not answering/);
    expect(await waited).toEqual(['gate']);
  });
});
