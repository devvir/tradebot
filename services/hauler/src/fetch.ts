import { basename, join } from 'node:path';
import { logger } from '@devvir/service-kit';
import { sizeOf } from '@tradebot/utils';
import { backup, commit, discard, etagAgrees, isDigest, md5, measure, touch, writePartial } from './store';
import config from './config';
import type { Haulable, Hauled } from './types';

/**
 * Bring one file to `<archives>/<venue>/<key>`, and say what happened to it.
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
 */
export const haul = async (file: Haulable): Promise<Hauled> => {
  const path = join(config.archivesDir, file.venue, file.key);
  const held = await measure(path);

  if (held !== null) {
    if (await agrees(file, path, held)) {
      await touch(path);

      return { outcome: 'present' };
    }

    const aside = await backup(path);

    logger.warn({ venue: file.venue, key: file.key, held, expected: file.size, aside: basename(aside) },
      'A file on disk disagrees with the catalog — moved aside, fetching it again');
  }

  return await retrieve(file, path);
};

// ── Internals ─────────────────────────────────────────────────────────────────

const ATTEMPTS = 3;
const BASE_MS  = 1_000;
const MAX_MS   = 30_000;

const retrieve = async (file: Haulable, path: string): Promise<Hauled> => {
  for (let attempt = 1; attempt <= ATTEMPTS; attempt++) {
    try {
      const res = await fetch(file.url);

      if (! res.ok || ! res.body) {
        await res.body?.cancel().catch(() => undefined);

        if (attempt === ATTEMPTS) {
          logger.warn({ venue: file.venue, status: res.status, url: file.url }, 'Would not download');

          return { outcome: 'failed' };
        }

        await sleep(delayFor(attempt));

        continue;
      }

      const bytes = await writePartial(path, res.body);

      if (! await agrees(file, `${path}.part`, bytes)) {
        await discard(path);

        logger.error({ venue: file.venue, url: file.url, got: bytes, expected: file.size },
          'What the venue served does not match what the catalog says it is');

        return { outcome: 'mismatched', size: bytes };
      }

      await commit(path);

      logger.info({ venue: file.venue, size: sizeOf(bytes) }, `Hauled ${basename(path)}`);

      return { outcome: 'downloaded' };
    } catch (err) {
      await discard(path);

      if (attempt === ATTEMPTS) {
        logger.warn({ err, venue: file.venue, url: file.url }, 'Download failed');

        return { outcome: 'failed' };
      }

      await sleep(delayFor(attempt));
    }
  }

  return { outcome: 'failed' };
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

// ── Test access ───────────────────────────────────────────────────────────────

export const _test_agrees   = agrees;
export const _test_delayFor = delayFor;
