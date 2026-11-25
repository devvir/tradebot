import { logger } from '@devvir/service-kit';
import { exclusionsFor } from './catalog';
import { labelOf } from './pace';
import type { Adapter } from './types';
import type { DatabaseSync } from 'node:sqlite';

/**
 * The known-bad files, held in memory per server.
 *
 * **This is the half of exclusion that can only be listed.** A rule that holds
 * for keys nobody has published yet belongs in an adapter's `accepts`, where it
 * is code and gets reviewed; a list of specific files a venue serves wrongly
 * grows as more are found, and should cost a row rather than a rebuild and a
 * redeploy. So this reads the table and never writes it — how a row got there is
 * somebody else's business.
 *
 * **Keyed by server, as the rows are.** An exclusion row belongs to one `venue`
 * row, and a venue served from several hosts has one such row per host. Each
 * server's set is loaded from its own rows and stored under its own label, so
 * loading one server never replaces or clears another's.
 *
 * Kept in a module rather than threaded through descent: the question is asked
 * once per key, in two places several call layers deep, and passing a set
 * through every frame to answer it would put the plumbing in front of the point.
 *
 * A miss is the overwhelmingly common case — the sets are tiny and usually
 * empty — so it is a `Set` lookup on the path the catalog would store.
 */
export const loadExclusions = (db: DatabaseSync, server: Server, venueId: number): void => {
  const paths = exclusionsFor(db, venueId);
  const label = labelOf(server);

  excluded.set(label, new Set(paths));

  if (paths.length > 0)
    logger.info({ venue: label, excluded: paths.length }, 'Loaded excluded files');
};

/** Whether this server serves this path, but it is not historical data. */
export const isExcluded = (server: Server, path: string): boolean =>
  excluded.get(labelOf(server))?.has(path) ?? false;

// ── Internals ─────────────────────────────────────────────────────────────────

/** What names a server: an adapter, or the listing context built from one. */
type Server = Pick<Adapter, 'name' | 'host'>;

/**
 * Loaded when a job starts, so a row added by hand takes effect on the next job
 * rather than on the next deploy — and a job keeps one consistent list for its
 * whole run, however many days that takes.
 */
const excluded = new Map<string, Set<string>>();

// ── Test access ───────────────────────────────────────────────────────────────

export const _test_reset = (): void => excluded.clear();

export const _test_seed = (server: Server, paths: string[]): void => {
  excluded.set(labelOf(server), new Set(paths));
};
