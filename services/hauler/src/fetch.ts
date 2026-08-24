import { basename } from 'node:path';
import { logger } from '@devvir/service-kit';
import { commit, discard, etagAgrees, isDigest, md5, measure, remove, writePartial } from './store';
import { pathOf } from './naming';
import config from './config';
import type { Named, Offered, Outcome } from './types';

/**
 * Bring one file to its canonical path, and say what happened to it.
 *
 * **The size and the etag come with the URL**, so every file hauler holds can be
 * checked against what the catalog says it should be. That one cheap signal is
 * what makes the whole arrangement self-correcting, and there are only four
 * outcomes:
 *
 * | the file | matches | |
 * |---|---|---|
 * | just fetched  | yes | it downloaded, and that is all |
 * | already there | yes | **it downloaded** — the self-healing case |
 * | already there | no  | discard it and treat it as never downloaded |
 * | just fetched  | no  | **report the discrepancy**, keep nothing, leave the partition open |
 *
 * **The second row is why nothing ever needs repairing by hand.** A file present
 * and correct is confirmed whatever the catalog previously believed, so a
 * download recorded and then lost — or performed and then forgotten — resolves
 * itself the next time its partition is listed. No migration, no reconciliation
 * script, no separate fixing of the database. It is also what lets a machine
 * whose archive is already on disk be adopted with no seeding step at all.
 *
 * **The fourth row never resolves itself and must not pretend to.** Nothing is
 * kept, nothing is stated, and the partition stays open until the two services
 * agree.
 */
export const haul = async (file: Offered, named: Named): Promise<Outcome> => {
  const path = pathOf(config.archivesDir, named);

  const held = await measure(path);

  if (held !== null) return await settle(file, path, held);

  return await retrieve(file, path);
};

// ── Internals ─────────────────────────────────────────────────────────────────

const ATTEMPTS = 3;
const BASE_MS  = 1_000;
const MAX_MS   = 30_000;

/**
 * What to do about a file that is already there.
 *
 * Confirmed where it matches, removed where it does not — because a file whose
 * bytes disagree with the catalog is not a file, and leaving it in place would
 * mean every later pass skipping it for ever.
 */
const settle = async (file: Offered, path: string, held: number): Promise<Outcome> => {
  if (! await agrees(file, path, held)) {
    logger.warn({ venue: file.venue, path, held, expected: file.size },
      'A file already on disk does not match the catalog — removing it');

    await remove(path);

    return await retrieve(file, path);
  }

  logger.debug({ venue: file.venue, path }, 'Already on disk and correct');

  return 'present';
};

/**
 * Fetch, verify, and only then give the file its name.
 *
 * **Three attempts, and after that it is not hauler's problem to solve alone.**
 * A key that will not deliver is reported, and prospector goes and asks the
 * venue whether it is really there. Retrying harder here would only make hauler
 * more confident about something it cannot check.
 */
const retrieve = async (file: Offered, path: string): Promise<Outcome> => {
  for (let attempt = 1; attempt <= ATTEMPTS; attempt++) {
    try {
      const res = await fetch(file.url);

      if (! res.ok || ! res.body) {
        if (attempt === ATTEMPTS) {
          logger.warn({ venue: file.venue, status: res.status, url: file.url },
            'Would not download');

          return 'failed';
        }

        await sleep(delayFor(attempt));

        continue;
      }

      const bytes = await writePartial(path, res.body);

      if (! await agrees(file, `${path}.part`, bytes)) {
        await discard(path);

        logger.error({ venue: file.venue, url: file.url, got: bytes, expected: file.size },
          'What the venue served does not match what the catalog says it is');

        return 'mismatched';
      }

      await commit(path);

      logger.info({ venue: file.venue, mb: round(bytes / 1e6) },
        `Hauled ${basename(path)}`);

      return 'downloaded';
    } catch (err) {
      await discard(path);

      if (attempt === ATTEMPTS) {
        logger.warn({ err, venue: file.venue, url: file.url }, 'Download failed');

        return 'failed';
      }

      await sleep(delayFor(attempt));
    }
  }

  return 'failed';
};

/**
 * Whether bytes on disk are the bytes the catalog described.
 *
 * The size is checked first because it costs a `stat` and rules out almost
 * every disagreement there is. The digest is only computed when the size agrees
 * and an etag is actually a digest — hashing hundreds of megabytes to confirm
 * what a mismatched length has already denied would be pure waste.
 *
 * **A catalog that states neither is taken at its word.** There is nothing to
 * check against, and refusing files for want of metadata the venue never
 * published would refuse whole venues.
 */
const agrees = async (file: Offered, path: string, bytes: number): Promise<boolean> => {
  if (file.size !== undefined && file.size !== bytes) return false;

  if (! isDigest(file.etag)) return true;

  return etagAgrees(file.etag, await md5(path));
};

/** Exponential with full jitter — synchronised retries are their own hazard. */
const delayFor = (attempt: number): number =>
  Math.floor(Math.random() * Math.min(BASE_MS * 2 ** (attempt - 1), MAX_MS));

const round = (value: number): number => Math.round(value * 10) / 10;

const sleep = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms));

// ── Test access ───────────────────────────────────────────────────────────────

export const _test_agrees   = agrees;
export const _test_delayFor = delayFor;
