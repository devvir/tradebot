import { basename, join } from 'node:path';
import { logger } from '@devvir/service-kit';
import { sizeOf } from '@tradebot/utils';
import { backup, commit, discard, etagAgrees, isDigest, md5, measure, partialOf, touch, writePartial } from './store';
import config from './config';
import type { Haulable, Hauled } from './types';

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
 * | just fetched  | no  | **reported as a mismatch**, nothing kept |
 *
 * **The first row is what adopts an archive already on disk** with no seeding:
 * a file present and correct is confirmed whatever the catalog believed, and
 * its new date says this pass accounted for it — see `touch`. The second keeps
 * whatever disagreed for somebody to read; see `backup`. The last never settles
 * itself: the catalog asks the venue and rules.
 *
 * **Only the venue's own answer makes a file `failed`** — `404` or `410` at once,
 * and a `403` that persists through every attempt: a `403` is as often a venue
 * refusing *us* as a bucket hiding a file it lacks, so it is tried again first,
 * and reported for the catalog to rule on only once it holds. A connection that
 * never opened, a lookup that failed, a `5xx` or a `429` say nothing about the
 * file, only about the way to it: those are tried again, and if they persist the
 * file is `unreached`, left out of the report, and listed again on the next walk.
 *
 * **A refusal stands the whole venue down**, not just the file — see
 * `standDown`.
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

  return await retrieve(file, path);
};

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
  for (let attempt = 1; attempt <= ATTEMPTS; attempt++) {
    await standingDown(file.venue);

    try {
      const res = await fetch(file.url);

      if (! res.ok || ! res.body) {
        await res.body?.cancel().catch(() => undefined);

        standDown(file.venue, res.status, res.headers);

        if (GONE.has(res.status)) {
          logger.warn({ key: file.key, status: res.status, url: file.url }, 'Gone at the venue');

          return { outcome: 'failed' };
        }

        if (attempt === ATTEMPTS && res.status === HIDDEN) {
          logger.warn({ key: file.key, status: res.status, url: file.url }, 'Refused throughout — reported for the catalog to rule');

          return { outcome: 'failed' };
        }

        if (attempt === ATTEMPTS) {
          logger.warn({ key: file.key, status: res.status, url: file.url }, 'Unreachable — stays owed');

          return { outcome: 'unreached' };
        }

        await sleep(delayFor(attempt));

        continue;
      }

      const bytes = await writePartial(path, res.body);

      if (! await agrees(file, partialOf(path), bytes)) {
        await discard(path);

        logger.error({ key: file.key, size: bytes, expected: file.size, url: file.url }, 'Served differs from the catalog');

        return { outcome: 'mismatched', size: bytes };
      }

      await commit(path);

      logger.info({ key: file.key, size: sizeOf(bytes) }, 'Downloaded');

      return { outcome: 'downloaded' };
    } catch (err) {
      await discard(path);

      if (attempt === ATTEMPTS) {
        logger.warn({ key: file.key, err: reason(err), url: file.url }, 'Unreachable — stays owed');

        return { outcome: 'unreached' };
      }

      await sleep(delayFor(attempt));
    }
  }

  return { outcome: 'unreached' };
};

/**
 * The statuses a venue turns *us* away with, rather than answering about a
 * file: `429` says so outright, and a `403` is as often a CDN refusing an
 * address as a bucket hiding what it lacks.
 */
const REFUSED = new Set([403, 429]);

/** How long a venue that turned us away is left alone, where it does not say. */
const STAND_DOWN_MS = 2 * 60_000;

/** Until when each venue is left alone. */
const standing = new Map<string, number>();

/**
 * Leave a venue alone after it refused us, or after it said how long to wait.
 *
 * **The whole venue, because a refusal is aimed at the address**, and every
 * request sent through it meanwhile is refused too — some venues keep refusing
 * for minutes after the burst that tripped them. The wait is the venue's own
 * `Retry-After` where it gives one, and `STAND_DOWN_MS` otherwise. Logged once
 * per stand-down, however many fetches ran into it.
 */
const standDown = (venue: string, status: number, headers: Headers): void => {
  const said = retryAfter(headers);

  if (! REFUSED.has(status) && said === null) return;

  const was   = standing.get(venue) ?? 0;
  const until = Date.now() + (said ?? STAND_DOWN_MS);

  if (until <= was) return;

  standing.set(venue, until);

  if (was <= Date.now()) logger.warn({ venue, status, seconds: Math.round((until - Date.now()) / 1000) }, 'Turned away — standing the venue down');
};

/** Wait out a venue's stand-down, however often it is extended meanwhile. */
const standingDown = async (venue: string): Promise<void> => {
  for (let until = standing.get(venue) ?? 0; until > Date.now(); until = standing.get(venue) ?? 0)
    await sleep(until - Date.now());
};

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
