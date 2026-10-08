import { basename, join } from 'node:path';
import { logger } from '@devvir/service-kit';
import { sizeOf } from '@tradebot/utils';
import { backup, commit, discard, etagAgrees, isDigest, md5, measure, partialOf, touch, writePartial } from './store';
import { backAt, delivered, faltered, hostFor, mainOf, refused } from './hosts';
import { hold, taken } from './held';
import config from './config';
import type { Haulable, Hauled, Host } from './types';

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
 * | already there | no  | **moved aside** as `.bak`, then fetched again |
 * | just fetched  | yes | downloaded |
 * | just fetched  | no  | **reported as a mismatch**, and held in scratch |
 *
 * **The first row is what adopts an archive already on disk** with no seeding:
 * a file present and correct is confirmed whatever the catalog believed, and
 * its new date says this pass accounted for it — see `touch`. The second keeps
 * whatever disagreed for somebody to read; see `backup`. The last never settles
 * itself: the catalog asks the venue and rules — and where it rules for what
 * was fetched, that download is the file, and is not fetched twice. See
 * `held.ts`.
 *
 * **Only the venue's own answer makes a file `failed`** — `404` or `410` at once,
 * and a `403` that persists through every attempt: a `403` is as often a venue
 * refusing *us* as a bucket hiding a file it lacks, so it is tried again first,
 * and reported for the catalog to rule on only once it holds. A connection that
 * never opened, a lookup that failed, a `5xx` or a `429` say nothing about the
 * file, only about the way to it: those are tried again, and if they persist the
 * file is `unreached`, left out of the report, and listed again on the next walk.
 *
 * **A server can answer at several addresses** — its bucket, a CDN in front of
 * it — and each attempt asks one of them, chosen by how each has been doing;
 * see `hosts.ts`. A file is gone only where every address in rotation answers
 * `404`; any other failure of an address that is not the listed one marks it
 * down and the file is asked elsewhere. **A refusal takes the
 * address that refused out of rotation**, not the file's chances.
 */
export const haul = async (file: Haulable): Promise<Hauled> => {
  const path = join(config.archivesDir, file.key);
  const held = await measure(path);

  if (held !== null) {
    if (await agrees(file, path, held)) {
      await touch(path);

      logger.info({ key: file.key, size: sizeOf(held) }, 'Already downloaded and current');

      return { outcome: 'present' };
    }

    const aside = await backup(path);

    logger.warn({ key: file.key, size: held, expected: file.size, aside: basename(aside) },
      'Differs from the catalog — moved aside, fetching again');
  }

  /**
   * Fetched before, when the catalog said something else of it: if what the
   * catalog says now is what was fetched then, that is the file.
   */
  const kept = taken(file);

  if (kept) {
    if (settles(file, kept.bytes, kept.digest)) {
      await commit(path);

      logger.info({ key: file.key, size: sizeOf(kept.bytes) }, 'Downloaded — fetched earlier, and the catalog agrees now');

      return { outcome: 'downloaded' };
    }

    await discard(path);
  }

  return await retrieve(file, path);
};

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
 * held to be the first only where every attempt answers it.
 */
const HIDDEN = 403;

const retrieve = async (file: Haulable, path: string): Promise<Hauled> => {
  const tried = new Set<Host>();

  for (let attempt = 1; attempt <= ATTEMPTS; attempt++) {
    const host = await hostToAsk(file, tried);

    if (! host) {
      logger.error({ key: file.key, venue: file.venue, server: file.server }, 'No address is known for this file\'s server');

      return { outcome: 'unreached' };
    }

    const url   = `${host.base}${file.path}`;
    const began = Date.now();

    // A large file is minutes with nothing else said of it, so its start is said.
    if (attempt === 1 && (file.size ?? 0) >= LARGE_BYTES)
      logger.info({ key: file.key, size: sizeOf(file.size!), host: host.base }, 'Downloading a large file');

    try {
      const res = await fetch(url);

      if (! res.ok || ! res.body) {
        await res.body?.cancel().catch(() => undefined);

        const wait = retryAfter(res.headers);

        if (REFUSED.has(res.status) || wait !== null) refused(host, res.status, wait);
        else faltered(host);

        /**
         * **A file is gone only where every address in rotation says so.** One
         * address not having it is asked no more for it, and the next is asked
         * at once; a withdrawal is rare, and an edge that has lost a file the
         * bucket still holds is not one.
         */
        if (GONE.has(res.status)) {
          tried.add(host);

          if (hostFor(file.venue, file.server, tried)) {
            attempt--;

            continue;
          }

          logger.warn({ key: file.key, status: res.status, url }, 'Gone at the venue');

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

        if (attempt === ATTEMPTS && res.status === HIDDEN) {
          logger.warn({ key: file.key, status: res.status, url }, 'Refused throughout — reported for the catalog to rule');

          return { outcome: 'failed' };
        }

        if (attempt === ATTEMPTS) {
          logger.warn({ key: file.key, status: res.status, url }, 'Unreachable — stays owed');

          return { outcome: 'unreached' };
        }

        await sleep(delayFor(attempt));

        continue;
      }

      const bytes = await writePartial(path, res.body);

      /**
       * **Nothing, where the catalog says there is something, is a transfer
       * that failed** and not a file that differs: an address now and then
       * answers `200` with an empty body, several requests at the same instant,
       * for files it serves whole a moment later. So it is handled as any reply
       * that is not the file — the address marked down, the file asked for
       * again, and left owed where every attempt comes back empty. It is never
       * reported: there is nothing to tell the catalog about the file.
       */
      if (bytes === 0 && (file.size ?? 0) > 0) {
        await discard(path);

        faltered(host);

        if (! host.main) {
          tried.add(host);

          continue;
        }

        if (attempt === ATTEMPTS) {
          logger.warn({ key: file.key, expected: file.size, url }, 'Served empty — stays owed');

          return { outcome: 'unreached' };
        }

        await sleep(delayFor(attempt));

        continue;
      }

      delivered(host, bytes, Date.now() - began);

      const digest = isDigest(file.etag) || file.size !== bytes ? await md5(partialOf(path)) : '';

      if (! settles(file, bytes, digest)) {
        // Likely the venue's newer file: kept until the catalog has asked, and not fetched again if so.
        hold(file, path, bytes, digest);

        logger.error({ key: file.key, size: bytes, expected: file.size, url }, 'Served differs from the catalog — held until it has asked the venue');

        return { outcome: 'mismatched', size: bytes };
      }

      await commit(path);

      logger.info({ key: file.key, size: sizeOf(bytes) }, 'Downloaded');

      return { outcome: 'downloaded' };
    } catch (err) {
      await discard(path);

      faltered(host);

      if (! host.main) tried.add(host);

      if (attempt === ATTEMPTS) {
        logger.warn({ key: file.key, err: reason(err), url }, 'Unreachable — stays owed');

        return { outcome: 'unreached' };
      }

      await sleep(delayFor(attempt));
    }
  }

  return { outcome: 'unreached' };
};

/**
 * The address to ask next for a file: any in rotation not yet tried for it, by
 * weight — and where none is, the listed one, once it is back. An address that
 * turned us away is left alone until it said, or for the default, and a server
 * whose every address did is waited for: every request sent meanwhile would be
 * turned away too.
 */
const hostToAsk = async (file: Haulable, tried: ReadonlySet<Host>): Promise<Host | null> => {
  for (;;) {
    const host = hostFor(file.venue, file.server, tried) ?? hostFor(file.venue, file.server);

    if (host) return host;

    const main = mainOf(file.venue, file.server);

    if (! main) return null;

    await sleep(Math.max(backAt(main) - Date.now(), 100));
  }
};

/**
 * The statuses a venue turns *us* away with, rather than answering about a
 * file: `429` says so outright, and a `403` is as often a CDN refusing an
 * address as a bucket hiding what it lacks.
 */
const REFUSED = new Set([403, 429]);

/** `Retry-After` in milliseconds, given as seconds or as a date; null where absent or unreadable. */
const retryAfter = (headers: Headers): number | null => {
  const said = headers.get('retry-after')?.trim();

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

const sleep = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms));

/** What undici says went wrong, without its stack: `fetch failed` alone names nothing. */
const reason = (err: unknown): string => {
  const cause = (err as { cause?: { message?: string; code?: string } })?.cause;

  return cause?.message ?? cause?.code ?? (err instanceof Error ? err.message : String(err));
};

// ── Test access ───────────────────────────────────────────────────────────────

export const _test_agrees   = agrees;
export const _test_delayFor = delayFor;
export const _test_retryAfter = retryAfter;
