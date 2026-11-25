import { basename, join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { logger } from '@devvir/service-kit';
import { sizeOf } from '@tradebot/utils';
import { DiskError, discard, etagAgrees, isDigest, md5, measure, replace, touch, writePartial } from './store';
import { backAt, delivered, faltered, hostFor, mainOf, refused } from './hosts';
import { hold, taken } from './held';
import { get } from './http';
import config from './config';
import type { Written } from './store';
import type { Haulable, Hauled, Host, Pacing } from './types';

/**
 * Bring one file to `<archives>/<key>` — the key starts with the venue — and say
 * what happened to it.
 *
 * **The size and the ETag come with the listing**, so every file hauler holds
 * is checked against what the catalog says it should be:
 *
 * | the file | matches | |
 * |---|---|---|
 * | already there | yes | **touched**, and reported as downloaded |
 * | already there | no  | **fetched again**, and left where it is until the new one matches |
 * | just fetched  | yes | downloaded — whatever was at its path **moved aside** as `.bak` |
 * | just fetched  | no  | **reported as a mismatch**, with the size and MD5 it came as, and held in scratch |
 *
 * **The first row is what adopts an archive already on disk** with no seeding:
 * a file present and correct is confirmed whatever the catalog believed, and
 * its new date says this pass accounted for it — see `touch`. The second and
 * third keep whatever disagreed for somebody to read, and only once a file that
 * agrees is in hand to take its place: a download that fails, or does not
 * match either, leaves it where it was. See `replace`. The last never settles
 * itself: the catalog asks the venue and rules — and where it rules for what
 * was fetched, that download is the file, and is not fetched twice; where it
 * rules for the file on disk, the download is dropped. See `held.ts`.
 *
 * **What is stored is the bytes as served**, never decoded — see `http.ts` —
 * and **a body shorter than was promised is a transfer that failed**: shorter
 * than its own `content-length`, or empty where the catalog says the file is
 * not.
 *
 * **Only the venue's own answer makes a file `failed`** — `404` or `410` at once,
 * and a `403` from the listed address on every attempt made of it: a `403` is
 * as often a venue refusing *us* as a bucket hiding a file it lacks, so it is
 * tried again first, and reported for the catalog to rule on only where the
 * listed address answered nothing else. A connection that never opened, a
 * lookup that failed, a `5xx` or a `429` say nothing about the file, only about
 * the way to it: those are tried again, and if they persist the file is
 * `unreached`, left out of the report, and listed again on the next walk.
 *
 * **A server can answer at several addresses** — its bucket, a CDN in front of
 * it — and each attempt asks one of them, chosen by how each has been doing;
 * see `hosts.ts`. A file is gone only where the listed address and every other
 * in rotation answer `404`; where the listed one could not be asked, the file is
 * `unreached`. Any other failure of an address that is not the listed one marks
 * it down and the file is asked elsewhere. **A refusal takes the
 * address that refused out of rotation**, not the file's chances.
 *
 * **What the disk will not do leaves the file owed**, at once, and holds
 * nothing against the address: a download that cannot be written, a file that
 * cannot be read, moved aside or given its place is `unreached` without being
 * asked for a second time, and comes round again. One present and correct
 * whose date cannot be set is present all the same.
 * **A key is hauled once at a time**: asked for again while it is in hand, it is
 * `unreached` at once.
 *
 * **Its waits are the caller's to pace.** Waiting for an address to come back,
 * or between attempts, it asks nothing of the venue, and runs each wait through
 * `pacing.pause` so that whoever asked can lend out what the file holds
 * meanwhile. A wait wakes within a second of `pacing.stopped`, or at once when
 * downloads are given up, and the file is then `unreached`: nothing more is
 * asked for it.
 */
export const haul = async (file: Haulable, pacing: Pacing = {}): Promise<Hauled> => {
  // The same key twice at once would write one partial from two downloads.
  if (inHand.has(file.key)) {
    logger.warn({ key: file.key }, 'Already being hauled — stays owed');

    return { outcome: 'unreached' };
  }

  inHand.add(file.key);

  try {
    const path = join(config.archivesDir, file.key);

    let settled: Hauled | null;

    try {
      settled = await fromDisk(file, path);
    } catch (err) {
      logger.error({ key: file.key, err }, 'Could not set what is on disk against the catalog — stays owed');

      return { outcome: 'unreached' };
    }

    return settled ?? await retrieve(file, path, pacing);
  } finally {
    inHand.delete(file.key);
  }
};

/**
 * Give up every download in flight, now, and every wait for an address or
 * between attempts. Each is left owed and its partial removed: for a stop that
 * has waited as long as it is going to.
 */
export const abandon = (): void => {
  given.abort();

  for (const one of flying) one.abort();
};

/** Take downloads up again after they were given up. For tests: a service that gave up is one that is ending. */
export const _test_resume = (): void => { given = new AbortController(); };

/**
 * From this size a file is a large one: announced as it starts, not only when
 * it ends, and fetched a few at a time — see `walkVenue`.
 */
export const LARGE_BYTES = 50 * 1024 ** 2;

// ── Internals ─────────────────────────────────────────────────────────────────

const ATTEMPTS = 3;
const BASE_MS  = 5_000;
const MAX_MS   = 30_000;

/** The statuses that say the file is not there to have, at once. */
const GONE = new Set([404, 410]);

/**
 * The status that may say the file is not there, or may say we are refused —
 * held to be the first only where the listed address answers it on every
 * attempt made of it.
 */
const HIDDEN = 403;

/** Whether downloads have been given up: nothing is begun once they have. */
let given = new AbortController();

/**
 * What each request in flight is tied to, so all of them can be given up at
 * once. One of its own for each, held only while it is in flight: a signal
 * shared by every request keeps something of each for as long as it lives,
 * which for a service is for ever.
 */
const flying = new Set<AbortController>();

/** The keys being hauled right now. */
const inHand = new Set<string>();

/**
 * What the disk already settles of a file, before anything is fetched: the file
 * present and correct, or a download held from before that the catalog agrees
 * with now. Null where it must be fetched; whatever disagreed is out of its way.
 */
const fromDisk = async (file: Haulable, path: string): Promise<Hauled | null> => {
  const held = await measure(path);

  if (held !== null) {
    if (await agrees(file, path, held)) {
      // Its date is what says this pass saw it; a file that keeps the old one is present all the same.
      await touch(path).catch((err: unknown) =>
        logger.warn({ key: file.key, err }, 'Present and verified, but its date could not be set'));

      logger.info({ key: file.key, size: sizeOf(held) }, 'Already downloaded and current');

      // A download held for it is not the file: the catalog has ruled for the one on disk.
      if (taken(file)) await discard(path);

      return { outcome: 'present' };
    }

    logger.warn({ key: file.key, size: held, expected: file.size },
      'Differs from the catalog — fetching again; the file stays until a verified replacement is in hand');
  }

  /**
   * Fetched before, when the catalog said something else of it: if what the
   * catalog says now is what was fetched then, that is the file.
   */
  const kept = taken(file);

  if (kept) {
    if (settles(file, kept.bytes, kept.digest)) {
      const aside = await placed(path, kept.digest);

      logger.info({ key: file.key, size: sizeOf(kept.bytes), ...movedAside(aside) },
        'Downloaded — fetched earlier, and the catalog agrees now');

      return { outcome: 'downloaded' };
    }

    await discard(path);
  }

  return null;
};

/** Give a verified partial its path, with `replace`; a partial that could not be is dropped. */
const placed = async (path: string, digest: string): Promise<string | null> => {
  try {
    return await replace(path, digest);
  } catch (err) {
    await discard(path);

    throw err;
  }
};

/** What was moved aside for a file, for its log line. */
const movedAside = (aside: string | null): { aside?: string } => aside === null ? {} : { aside: basename(aside) };

const retrieve = async (file: Haulable, path: string, pacing: Pacing): Promise<Hauled> => {
  const { pause = wait => wait(), stopped = () => false } = pacing;

  const tried  = new Set<Host>();
  const halted = (): boolean => given.signal.aborted || stopped();

  /** Whether the listed address has been asked for the file, and has answered nothing but `403` when it was. */
  let askedMain        = false;
  let hiddenThroughout = true;

  /**
   * Wait so long through `pause`, waking within a second once halted — at once
   * where downloads are given up. Whether the file may be asked for again.
   */
  const waited = async (ms: number): Promise<boolean> => {
    if (ms > 0) await pause(async () => {
      const until = Date.now() + ms;

      while (! halted() && Date.now() < until) await sleep(Math.min(until - Date.now(), WAKE_MS));
    });

    return ! halted();
  };

  if (! mainOf(file.venue, file.server)) {
    logger.error({ key: file.key, venue: file.venue, server: file.server }, 'No address is known for this file\'s server');

    return { outcome: 'unreached' };
  }

  for (let attempt = 1; attempt <= ATTEMPTS; attempt++) {
    const host = await hostToAsk(file, tried, waited);

    // Given up, or stopped while waiting for an address: not asked, and left owed.
    if (! host) return { outcome: 'unreached' };

    const url   = `${host.base}${file.path}`;
    const began = Date.now();

    // A large file is minutes with nothing else said of it, so its start is said.
    if (attempt === 1 && (file.size ?? 0) >= LARGE_BYTES)
      logger.info({ key: file.key, size: sizeOf(file.size!), host: host.base }, 'Downloading a large file');

    if (host.main) askedMain = true;

    const own = new AbortController();

    flying.add(own);

    let written: Written;

    try {
      const res = await get(url, own.signal);

      const status = res.statusCode ?? 0;

      if (status < 200 || status >= 300) {
        res.resume();

        const wait = retryAfter(res.headers['retry-after']);

        if (REFUSED.has(status) || wait !== null) refused(host, status, wait);
        else faltered(host);

        if (host.main && status !== HIDDEN) hiddenThroughout = false;

        /**
         * **A file is gone only where the listed address and every other in
         * rotation say so.** One address not having it is asked no more for it,
         * and the next is asked at once; a withdrawal is rare, and an edge that
         * has lost a file the bucket still holds is not one. Where the listed
         * address is out of rotation and was never asked, nothing has spoken
         * for the venue: the file stays owed.
         */
        if (GONE.has(status)) {
          tried.add(host);

          if (hostFor(file.venue, file.server, tried)) {
            attempt--;

            continue;
          }

          if (! askedMain) {
            logger.warn({ key: file.key, status, url }, 'Not at an edge, and the listed address could not be asked — stays owed');

            return { outcome: 'unreached' };
          }

          logger.warn({ key: file.key, status, url }, 'Gone at the venue');

          return { outcome: 'failed' };
        }

        /**
         * **Past that, only the listed address speaks for the venue.** Another
         * that will not serve the file is an address doing badly: it is marked
         * down, and the file is asked of one not tried yet — at once, since
         * nothing said to wait.
         */
        if (! host.main) {
          tried.add(host);

          continue;
        }

        if (attempt === ATTEMPTS && status === HIDDEN && hiddenThroughout) {
          logger.warn({ key: file.key, status, url }, 'Refused throughout — reported for the catalog to rule');

          return { outcome: 'failed' };
        }

        if (attempt === ATTEMPTS) {
          logger.warn({ key: file.key, status, url }, 'Unreachable — stays owed');

          return { outcome: 'unreached' };
        }

        if (! await waited(delayFor(attempt))) return { outcome: 'unreached' };

        continue;
      }

      written = await writePartial(path, res);

      const promised = Number(res.headers['content-length'] ?? Number.NaN);

      /**
       * **Less than was promised is a transfer that failed**, and not a file
       * that differs: fewer bytes than the response's own `content-length`, or
       * nothing where the catalog says there is something — an address now and
       * then answers `200` with an empty body, several requests at the same
       * instant, for files it serves whole a moment later. So it is handled as
       * any reply that is not the file — the address marked down, the file
       * asked for again, and left owed where every attempt comes back short. It
       * is never reported: there is nothing to tell the catalog about the file.
       */
      if (written.bytes < promised || (written.bytes === 0 && (file.size ?? 0) > 0)) {
        await discard(path);

        faltered(host);

        if (! host.main) {
          tried.add(host);

          continue;
        }

        hiddenThroughout = false;

        if (attempt === ATTEMPTS) {
          logger.warn({ key: file.key, size: written.bytes, ...(Number.isNaN(promised) ? {} : { promised }), expected: file.size, url },
            'Served short — stays owed');

          return { outcome: 'unreached' };
        }

        if (! await waited(delayFor(attempt))) return { outcome: 'unreached' };

        continue;
      }
    } catch (err) {
      await discard(path);

      // Given up, not failed: nothing is held against the address, and nothing is tried again.
      if (given.signal.aborted) return { outcome: 'unreached' };

      // The disk's doing: the address served, and asking it again would come to the same.
      if (err instanceof DiskError) {
        logger.error({ key: file.key, path, code: err.code, err: err.message }, 'The disk would not take the download — stays owed');

        return { outcome: 'unreached' };
      }

      faltered(host);

      if (host.main) hiddenThroughout = false;
      else tried.add(host);

      if (attempt === ATTEMPTS) {
        logger.warn({ key: file.key, err: reason(err), url }, 'Unreachable — stays owed');

        return { outcome: 'unreached' };
      }

      if (! await waited(delayFor(attempt))) return { outcome: 'unreached' };

      continue;
    } finally {
      flying.delete(own);
    }

    delivered(host, written.bytes, Date.now() - began);

    return await verified(file, path, written, url);
  }

  return { outcome: 'unreached' };
};

/**
 * Set a download against the catalog, once it is whole: given its place where
 * it agrees, and held for the catalog to rule where it does not. Whatever goes
 * wrong here is the disk's, and leaves the file owed.
 */
const verified = async (file: Haulable, path: string, { bytes, digest }: Written, url: string): Promise<Hauled> => {
  if (! settles(file, bytes, digest)) {
    // Likely the venue's newer file: kept until the catalog has asked, and not fetched again if so.
    hold(file, path, bytes, digest);

    logger.error({ key: file.key, size: bytes, expected: file.size, url }, 'Served differs from the catalog — held until it has asked the venue');

    return { outcome: 'mismatched', size: bytes, etag: digest };
  }

  try {
    const aside = await placed(path, digest);

    logger.info({ key: file.key, size: sizeOf(bytes), ...movedAside(aside) }, 'Downloaded');

    return { outcome: 'downloaded' };
  } catch (err) {
    logger.error({ key: file.key, path, code: (err as { code?: unknown }).code, err },
      'Downloaded, but could not be given its place — stays owed');

    return { outcome: 'unreached' };
  }
};

/**
 * The address to ask next for a file: any in rotation not yet tried for it, by
 * weight — and where none is, the listed one, waited for with `waited` while it
 * is out of rotation. An address already tried for the file is not asked again
 * for it: only the listed address speaks for the venue. An address that turned
 * us away is out until it said, or for the default, and every request sent to
 * it meanwhile would be turned away too. Null where the file is to be asked of
 * none: downloads were given up, or the wait was cut short.
 */
const hostToAsk = async (
  file: Haulable, tried: ReadonlySet<Host>, waited: (ms: number) => Promise<boolean>,
): Promise<Host | null> => {
  for (;;) {
    if (given.signal.aborted) return null;

    const main = mainOf(file.venue, file.server);
    const host = hostFor(file.venue, file.server, tried) ?? (main && backAt(main) <= Date.now() ? main : null);

    if (host) return host;

    if (! main || ! await waited(Math.max(backAt(main) - Date.now(), 100))) return null;
  }
};

/**
 * The statuses a venue turns *us* away with, rather than answering about a
 * file: `429` says so outright, and a `403` is as often a CDN refusing an
 * address as a bucket hiding what it lacks.
 */
const REFUSED = new Set([403, 429]);

/** `Retry-After` in milliseconds, given as seconds or as a date; null where absent or unreadable. */
const retryAfter = (header: string | undefined): number | null => {
  const said = header?.trim();

  if (! said) return null;

  const seconds = Number(said);

  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);

  const at = Date.parse(said);

  return Number.isNaN(at) ? null : Math.max(0, at - Date.now());
};

/** Whether the bytes at a path are the file the catalog described. */
const agrees = async (file: Haulable, path: string, bytes: number): Promise<boolean> => {
  if (file.size !== undefined && file.size !== bytes) return false;

  if (! isDigest(file.etag)) return true;

  return etagAgrees(file.etag, await md5(path));
};

/** The same, of a file whose size and MD5 are already known. */
const settles = (file: Haulable, bytes: number, digest: string): boolean =>
  (file.size === undefined || file.size === bytes) && (! isDigest(file.etag) || etagAgrees(file.etag, digest));

/** Exponential with full jitter, so retries across files do not synchronise. */
const delayFor = (attempt: number): number =>
  Math.floor(Math.random() * Math.min(BASE_MS * 2 ** (attempt - 1), MAX_MS));

/** How long a wait sleeps at most before it looks again at whether it is to stop. */
const WAKE_MS = 1_000;

/** Sleep so long, or until downloads are given up: whichever `given` is current when it begins. */
const sleep = (ms: number): Promise<void> => delay(ms, undefined, { signal: given.signal }).catch(() => undefined);

/** What went wrong with a request, without its stack: the cause where one is given, which names more than the error itself. */
const reason = (err: unknown): string => {
  const cause = (err as { cause?: { message?: string; code?: string } })?.cause;

  return cause?.message ?? cause?.code ?? (err instanceof Error ? err.message : String(err));
};

// ── Test access ───────────────────────────────────────────────────────────────

export const _test_agrees   = agrees;
export const _test_delayFor = delayFor;
export const _test_retryAfter = retryAfter;
