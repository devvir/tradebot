import dns from 'node:dns';
import type { LookupAddress } from 'node:dns';
import type { Resolved } from './types';

/**
 * Answer this thread's name lookups from memory: one real lookup per host at a
 * time, kept for `KEEP_MS`.
 *
 * **Because a lookup is not free here, and a burst asks thousands at once.**
 * Node resolves a name for every new connection, on a pool of four threads,
 * and inside the container each answer comes from Docker's resolver. Measured
 * 2026-10-01: 40 lookups at once took 0.3 s, 1,000 took 5.4 s — and a burst of
 * connections, at a start or after the network gate lets go of everything it
 * held, is thousands, every one of them on a deadline that counts the lookup.
 * Prospector talks to about ten hosts, so a burst is ten lookups once this is
 * in place.
 *
 * **Installed where Node itself looks names up**, so every client in the
 * thread — `fetch`, the HTTP/1.1 agents, HTTP/2, a bare TLS connection — goes
 * through it without being handed anything. Once per thread.
 *
 * A host's addresses are handed out in turn, so connections spread over them as
 * fresh lookups would — those of the family the resolver put first, which is
 * the one a single lookup would have returned. kucoin's host answers one IPv4
 * address and eight IPv6 ones, and the container has no IPv6 route.
 *
 * **A failed refresh keeps the last answer.** Many connections wait on one
 * lookup, so a sporadic failure would otherwise fail all of them at once; the
 * address that worked a minute ago is served while the host is asked again
 * after `RETRY_MS`. A host never answered for has nothing to fall back on, and
 * its failure is passed on.
 */
export const cacheLookups = (): void => {
  if (installed) return;

  installed = true;

  const original = dns.lookup;

  const resolve = (hostname: string, family: number): Promise<Resolved> => {
    const key   = `${hostname}|${family}`;
    const known = KNOWN.get(key);

    if (known && known.until > Date.now()) return Promise.resolve(known);

    const asking = ASKING.get(key);

    if (asking) return asking;

    const fresh = new Promise<Resolved>((done, fail) => {
      original(hostname, { all: true, family }, (err, addresses) => {
        ASKING.delete(key);

        if (err) {
          if (! known) {
            fail(err);

            return;
          }

          known.until = Date.now() + RETRY_MS;
          done(known);

          return;
        }

        const preferred = addresses.filter(one => one.family === addresses[0]!.family);
        const resolved: Resolved = { addresses: preferred, next: 0, until: Date.now() + KEEP_MS };

        KNOWN.set(key, resolved);
        done(resolved);
      });
    });

    ASKING.set(key, fresh);

    return fresh;
  };

  (dns as { lookup: unknown }).lookup = (
    hostname: string,
    options:  number | dns.LookupOptions | ((...args: unknown[]) => void),
    callback?: (...args: unknown[]) => void,
  ): void => {
    const done   = (typeof options === 'function' ? options : callback)!;
    const asked  = typeof options === 'object' ? options : { family: typeof options === 'number' ? options : 0 };
    const family = Number(asked.family ?? 0) || 0;

    resolve(hostname, family).then(
      resolved => {
        if (asked.all) {
          done(null, resolved.addresses);

          return;
        }

        const one: LookupAddress = resolved.addresses[resolved.next++ % resolved.addresses.length]!;

        done(null, one.address, one.family);
      },
      err => done(err),
    );
  };
};

// ── Internals ─────────────────────────────────────────────────────────────────

/** How long an answer is used before the host is asked again. */
const KEEP_MS = 60_000;

/** How long a kept answer is served after a refresh failed, before asking again. */
const RETRY_MS = 5_000;

const KNOWN  = new Map<string, Resolved>();
const ASKING = new Map<string, Promise<Resolved>>();

let installed = false;
