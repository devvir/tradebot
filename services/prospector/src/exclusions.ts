import { logger } from '@devvir/service-kit';
import { exclusionsFor } from './catalog';
import type { DatabaseSync } from 'node:sqlite';

/**
 * The known-bad files, held in memory per venue.
 *
 * **This is the half of exclusion that can only be listed.** A rule that holds
 * for keys nobody has published yet belongs in an adapter's `accepts`, where it
 * is code and gets reviewed; a list of specific files a venue serves wrongly
 * grows as more are found, and should cost a row rather than a rebuild and a
 * redeploy. So this reads the table and never writes it — how a row got there is
 * somebody else's business.
 *
 * Kept in a module rather than threaded through descent: the question is asked
 * once per key, in two places several call layers deep, and passing a set
 * through every frame to answer it would put the plumbing in front of the point.
 *
 * A miss is the overwhelmingly common case — the sets are tiny and usually
 * empty — so it is a `Set` lookup on the path the catalog would store.
 */
export const loadExclusions = (db: DatabaseSync, venue: string, venueId: number): void => {
  const paths = exclusionsFor(db, venueId);

  excluded.set(venue, new Set(paths));

  if (paths.length > 0)
    logger.info({ venue, excluded: paths.length }, 'Loaded excluded files');
};

/** Whether this venue serves this path, but it is not historical data. */
export const isExcluded = (venue: string, path: string): boolean =>
  excluded.get(venue)?.has(path) ?? false;

// ── Internals ─────────────────────────────────────────────────────────────────

/**
 * Loaded when a job starts, so a row added by hand takes effect on the next job
 * rather than on the next deploy — and a job keeps one consistent list for its
 * whole run, however many days that takes.
 */
const excluded = new Map<string, Set<string>>();

// ── Test access ───────────────────────────────────────────────────────────────

export const _test_reset = (): void => excluded.clear();

export const _test_seed = (venue: string, paths: string[]): void => {
  excluded.set(venue, new Set(paths));
};
