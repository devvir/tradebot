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
});
