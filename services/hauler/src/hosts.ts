import { logger } from '@devvir/service-kit';
import type { Host } from './types';

/**
 * Which address each file is fetched from, where a venue's server answers at
 * more than one.
 *
 * A venue's files can be had from its bucket and from a CDN in front of it, the
 * same files under the same paths. Which is faster depends on where this runs,
 * on what the CDN has cached, and on the hour — so it is not decided ahead, it
 * is measured: every address is used, and the better it does the more it gets.
 *
 * **An address is scored by what it delivers while it is delivering**: bytes
 * per second of the time its requests were in flight, less its share of
 * requests that failed. That says nothing about how often it was chosen, so an
 * address given little work is not marked down for doing little.
 *
 * **Weights move once a minute, and half way.** A slow minute is not a slow
 * host; each look blends what the last minute measured into what was known —
 * or, the first time, into the server's average — so it takes several agreeing
 * minutes to turn the choice round. What does not
 * wait is a refusal: an address that says "too many" or keeps saying "no" is
 * taken out at once, for a while, and the rest carry on.
 *
 * **No address is ever left out for good.** One that falls to the floor is
 * still chosen now and then, and after half an hour down there it is given a
 * tenth of the work for a few minutes, its old score forgotten, to show what it
 * does today. One that was taken out comes back the same way.
 */

/** Tell hauler where a venue's servers answer: each server's addresses, the listed one first. */
export const setHosts = (venue: string, servers: Record<string, string[]>): void => {
  for (const [name, bases] of Object.entries(servers)) {
    const hosts = bases.map((base, at): Host => ({
      venue, server: name, base, main: at === 0, weight: 1 / bases.length, score: null,
      bytes: 0, ms: 0, ok: 0, errors: 0, refusals: 0, outUntil: 0, strikes: 0, lowSince: null, trialUntil: 0,
    }));

    known.set(keyOf(venue, name), hosts);
  }

  if (! ticking) ticking = setInterval(() => { for (const hosts of known.values()) reweigh(hosts); }, LOOK_MS).unref();
};

/**
 * An address to ask for a file of this server: one of those in rotation and
 * not tried for the file yet, by weight. Null where there is none to ask right
 * now.
 */
export const hostFor = (venue: string, server: string, tried: ReadonlySet<Host> = NONE): Host | null => {
  const now  = Date.now();
  const open = (known.get(keyOf(venue, server)) ?? []).filter(host => host.outUntil <= now && ! tried.has(host));

  if (open.length === 0) return null;

  const total = open.reduce((sum, host) => sum + host.weight, 0);

  let at = Math.random() * total;

  for (const host of open) {
    at -= host.weight;

    if (at < 0) return host;
  }

  return open[open.length - 1]!;
};

/** The address the catalog lists and probes: the one whose word on a file is the venue's. */
export const mainOf = (venue: string, server: string): Host | null =>
  (known.get(keyOf(venue, server)) ?? []).find(host => host.main) ?? null;

/** A file delivered: so many bytes in so long. */
export const delivered = (host: Host, bytes: number, ms: number): void => {
  host.bytes += bytes;
  host.ms    += ms;
  host.ok++;
  host.refusals = 0;
};

/** A request that came to nothing — no answer, a server error, a file the address should have had. */
export const faltered = (host: Host): void => {
  host.errors++;
};

/**
 * A request turned away. Told to wait (`429`, or any answer naming how long),
 * the address is out at once for that long, or for `OUT_MS`. Turned away with
 * no more said, it is counted, and out once it has happened `RECURRING` times
 * running — one `403` is as often a file an edge will not serve as a block.
 */
export const refused = (host: Host, status: number, wait: number | null): void => {
  host.errors++;
  host.refusals++;

  if (status !== 429 && wait === null && host.refusals < RECURRING) return;

  const until = Date.now() + (wait ?? Math.min(OUT_MS * 2 ** host.strikes, LONGEST_OUT_MS));

  if (until <= host.outUntil) return;

  const fresh = host.outUntil <= Date.now();

  host.outUntil   = until;
  host.trialUntil = until + TRIAL_MS;
  host.score      = null;
  host.refusals   = 0;

  if (fresh) {
    host.strikes++;

    logger.warn({ venue: host.venue, host: host.base, status, seconds: Math.round((until - Date.now()) / 1000) },
      'Turned away — out of rotation');
  }

  reweigh(known.get(keyOf(host.venue, host.server)) ?? []);
};

/** When an address is back in rotation, in epoch milliseconds: now or earlier where it is in it. */
export const backAt = (host: Host): number => host.outUntil;

// ── Internals ─────────────────────────────────────────────────────────────────

/** How often the weights are looked at again. */
const LOOK_MS = 60_000;

/** Requests an address must have answered since the last look for that minute to say anything about it. */
const ENOUGH = 20;

/** How much of a fresh measurement goes into the score at each look. */
const BLEND = 0.5;

/** The least chance any address in rotation has of being chosen. */
const FLOOR = 0.01;

/** How long at the floor before an address is given a trial, the share it is tried at, and for how long. */
const LOW_MS   = 30 * 60_000;
const TRIAL    = 0.1;
const TRIAL_MS = 5 * 60_000;

/** How long an address that turned us away is left alone where it does not say, doubling while it keeps on, to a limit. */
const OUT_MS         = 3 * 60_000;
const LONGEST_OUT_MS = 30 * 60_000;

/** Refusals in a row, nothing delivered between them, that make a block of what could have been a file. */
const RECURRING = 5;

const NONE: ReadonlySet<Host> = new Set();

const known = new Map<string, Host[]>();

let ticking: NodeJS.Timeout | null = null;

const keyOf = (venue: string, server: string): string => `${venue}|${server}`;

/**
 * Look again at one server's addresses: fold the last minute into each score,
 * and share the work out by score.
 */
const reweigh = (hosts: Host[]): void => {
  if (hosts.length === 0) return;

  const now    = Date.now();
  const before = hosts.map(host => host.weight);

  const measured = hosts.filter(host => host.ok + host.errors >= ENOUGH).map(host => ({
    host, fresh: (host.ms > 0 ? (host.bytes / host.ms) * 1000 : 0) * (host.ok / (host.ok + host.errors)),
  }));

  // What an address is taken for before it has a score: the server's average this minute, so a first look moves half way too.
  const prior = measured.length > 0 ? measured.reduce((sum, one) => sum + one.fresh, 0) / measured.length : 0;

  for (const { host, fresh } of measured) {
    host.score = (host.score ?? prior) * (1 - BLEND) + fresh * BLEND;

    if (host.errors === 0) host.strikes = 0;

    host.bytes = host.ms = host.ok = host.errors = 0;
  }

  // An address nothing is known of yet is taken for average, so it is tried as much as the rest.
  const scored  = hosts.filter(host => host.score !== null).map(host => host.score!);
  const average = scored.length > 0 ? scored.reduce((sum, one) => sum + one, 0) / scored.length : 1;
  const raw     = hosts.map(host => Math.max(host.score ?? average, 0));
  const total   = raw.reduce((sum, one) => sum + one, 0) || 1;

  hosts.forEach((host, at) => {
    let weight = raw[at]! / total;

    if (weight < FLOOR) {
      weight = FLOOR;
      host.lowSince ??= now;

      if (now - host.lowSince >= LOW_MS) {
        host.trialUntil = now + TRIAL_MS;
        host.score      = null;
        host.lowSince   = null;
      }
    } else {
      host.lowSince = null;
    }

    host.weight = weight;
  });

  // On trial an address has a tenth of the work until it has been measured, and no less than that after.
  const onTrial = hosts.filter(host => host.trialUntil > now);

  for (const host of onTrial) host.weight = host.score === null ? TRIAL : Math.max(host.weight, TRIAL);

  const others = hosts.filter(host => ! onTrial.includes(host));
  const held   = onTrial.reduce((all, host) => all + host.weight, 0);
  const rest   = others.reduce((all, host) => all + host.weight, 0);

  if (others.length > 0 && rest > 0 && held < 1) for (const host of others) host.weight *= (1 - held) / rest;

  const sum = hosts.reduce((all, host) => all + host.weight, 0);

  for (const host of hosts) host.weight /= sum;

  if (hosts.length > 1 && hosts.some((host, at) => Math.abs(host.weight - before[at]!) >= 0.05))
    logger.info({
      venue: hosts[0]!.venue,
      hosts: hosts.map(host => ({
        host: host.base, share: Number(host.weight.toFixed(2)),
        kbPerSecond: host.score === null ? null : Math.round(host.score / 1024),
        ...(host.outUntil > now ? { outForSeconds: Math.round((host.outUntil - now) / 1000) } : {}),
      })),
    }, 'Hosts reweighed');
};

// ── Test access ───────────────────────────────────────────────────────────────

export const _test_reweigh = (venue: string, server: string): void => reweigh(known.get(keyOf(venue, server)) ?? []);
export const _test_hostsOf = (venue: string, server: string): Host[] => known.get(keyOf(venue, server)) ?? [];
export const _test_forget  = (): void => { known.clear(); };
