import dns from 'node:dns';
import { describe, expect, it, vi } from 'vitest';
import { cacheLookups } from '../src/lookup';

/**
 * A burst of connections asks for one host's address thousands of times, and
 * each ask was a lookup of its own. See `lookup.ts`.
 */
describe('looking a host up', () => {
  it('asks once for a burst, and answers everyone', async () => {
    const asked: string[] = [];
    const original = dns.lookup;

    (dns as { lookup: unknown }).lookup = (host: string, _options: unknown, done: (...args: unknown[]) => void) => {
      asked.push(host);
      setTimeout(() => done(null, [{ address: '10.0.0.1', family: 4 }, { address: '10.0.0.2', family: 4 }]), 10);
    };

    cacheLookups();

    const one = (): Promise<string> =>
      new Promise((ok, fail) => dns.lookup('venue.example', { family: 0 }, (err, address) => (err ? fail(err) : ok(address))));

    const answers = await Promise.all(Array.from({ length: 100 }, one));

    expect(asked).toEqual(['venue.example']);

    /** Handed out in turn, so connections spread over every address. */
    expect(new Set(answers)).toEqual(new Set(['10.0.0.1', '10.0.0.2']));

    (dns as { lookup: unknown }).lookup = original;
  });

  /** kucoin's host answers one IPv4 address and eight IPv6 ones; the container has no IPv6 route. */
  it('hands out only the family the resolver put first', async () => {
    const original = dns.lookup;

    (dns as { lookup: unknown }).lookup = (_host: string, _options: unknown, done: (...args: unknown[]) => void) =>
      done(null, [{ address: '10.0.0.9', family: 4 }, { address: '2001:db8::1', family: 6 }, { address: '2001:db8::2', family: 6 }]);

    vi.resetModules();

    const { cacheLookups: fresh } = await import('../src/lookup');

    fresh();

    const families = await Promise.all(Array.from({ length: 6 }, () =>
      new Promise<number>(ok => dns.lookup('mixed.example', { family: 0 }, (_err, _address, family) => ok(family)))));

    expect(new Set(families)).toEqual(new Set([4]));

    (dns as { lookup: unknown }).lookup = original;
  });

  /** A host never answered for has nothing to fall back on. */
  it('passes on the failure of a first lookup', async () => {
    const original = dns.lookup;
    const refused  = Object.assign(new Error('getaddrinfo ENOTFOUND'), { code: 'ENOTFOUND' });

    (dns as { lookup: unknown }).lookup = (_host: string, _options: unknown, done: (...args: unknown[]) => void) =>
      setImmediate(() => done(refused));

    vi.resetModules();

    const { cacheLookups: fresh } = await import('../src/lookup');

    fresh();

    const err = await new Promise<unknown>(ok => dns.lookup('nowhere.example', { family: 0 }, failed => ok(failed)));

    expect(err).toBe(refused);

    (dns as { lookup: unknown }).lookup = original;
  });

  /**
   * **A failed refresh keeps the last answer**, and the host is asked again only
   * once the retry interval has passed rather than on every connection.
   */
  it('serves the last answer while a refresh fails, asking again only after a while', async () => {
    const original = dns.lookup;

    let asked   = 0;
    let failing = false;

    (dns as { lookup: unknown }).lookup = (_host: string, _options: unknown, done: (...args: unknown[]) => void) => {
      asked++;

      // Answered on a later turn, as the resolver does.
      setImmediate(() => {
        if (failing) done(Object.assign(new Error('getaddrinfo EAI_AGAIN'), { code: 'EAI_AGAIN' }));
        else done(null, [{ address: '10.0.0.7', family: 4 }]);
      });
    };

    vi.useFakeTimers({ toFake: ['Date'] });

    const later = (ms: number): void => { vi.setSystemTime(Date.now() + ms); };

    try {
      vi.resetModules();

      const { cacheLookups: fresh } = await import('../src/lookup');

      fresh();

      const one = (): Promise<string> =>
        new Promise((ok, fail) => dns.lookup('flaky.example', { family: 0 }, (err, address) => (err ? fail(err) : ok(address))));

      expect(await one()).toBe('10.0.0.7');
      expect(asked).toBe(1);

      // Kept for a minute: nothing is asked inside it.
      later(59_000);

      expect(await one()).toBe('10.0.0.7');
      expect(asked).toBe(1);

      // Past it, the refresh fails and the last answer is served.
      failing = true;
      later(1_001);

      expect(await one()).toBe('10.0.0.7');
      expect(asked).toBe(2);

      later(4_000);

      expect(await one()).toBe('10.0.0.7');
      expect(asked).toBe(2);

      later(1_001);

      expect(await one()).toBe('10.0.0.7');
      expect(asked).toBe(3);

      // And once the host answers again, its fresh answer is the one kept.
      failing = false;
      later(5_001);

      expect(await one()).toBe('10.0.0.7');
      expect(asked).toBe(4);
    } finally {
      vi.useRealTimers();
      (dns as { lookup: unknown }).lookup = original;
    }
  });

  /** Asked for every address, a caller gets the family the resolver put first, and only that. */
  it('answers a request for every address with the preferred family', async () => {
    const original = dns.lookup;

    (dns as { lookup: unknown }).lookup = (_host: string, _options: unknown, done: (...args: unknown[]) => void) =>
      done(null, [{ address: '10.0.0.9', family: 4 }, { address: '2001:db8::1', family: 6 }, { address: '10.0.0.10', family: 4 }]);

    vi.resetModules();

    const { cacheLookups: fresh } = await import('../src/lookup');

    fresh();

    const all = await new Promise<unknown>(ok => dns.lookup('mixed.example', { all: true }, (_err, addresses) => ok(addresses)));

    expect(all).toEqual([{ address: '10.0.0.9', family: 4 }, { address: '10.0.0.10', family: 4 }]);

    (dns as { lookup: unknown }).lookup = original;
  });
});
