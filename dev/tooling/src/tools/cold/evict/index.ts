import { loadConfig } from '../config';
import { acquire } from '../lock';
import { onExit } from '../cleanup';
import { evictArchives } from './archives';
import { evictVault } from './vault';
import * as db from '../db';
import type { Origin, VaultFilter } from '../types';

/**
 * Reclaim local disk once cold storage provably holds what is being deleted.
 *
 * **The safe order is collect, normalise, back both up, then evict.** Eviction
 * is the one irreversible step, so it comes last and only where every earlier
 * step is provably finished. Get that order right and a mistake anywhere else is
 * recoverable from Mega.
 *
 * The two trees answer to different rules and share only the deleting, so this
 * resolves the environment, takes the lock and opens the database — all of which
 * are the same whatever is being evicted — and hands over:
 *
 * - [archives](archives.ts) judge a **venue-month as a whole**, and additionally
 *   require that every file in it reached a vault partition. That is not a
 *   safety property but an alignment one: raw exists to become parquet.
 * - [vault](vault.ts) judges a **partition at a time**, against a selection, and
 *   asks only whether Mega holds it. A partition is the end of the line, so
 *   there is no downstream to be aligned with.
 *
 * **The lock is per origin and per command**, so evicting one tree never blocks
 * pushing it. Nothing is gained by serialising them: evict deletes only what an
 * *uploaded* part records, and push plans only what no part records at the same
 * size and mtime, so the two sets are disjoint by construction rather than by
 * scheduling.
 */
export const runEvict = async (
  origin: Origin,
  venues: string[],
  filter: Omit<VaultFilter, 'venues'>,
  purge:  boolean,
): Promise<void> => {
  const config  = loadConfig(origin);
  const release = await acquire(config.coldRoot, origin, 'evict');

  try {
    const handle = db.open(config.dbPath);

    onExit(() => db.close(handle));

    try {
      /**
       * The venue argument is the same word to a person and a different thing
       * to each tree: archives name a directory, which is matched as written,
       * while the vault names a `venue=` attribute, which is matched lowercased
       * along with the rest of the filter.
       */
      if (origin === 'vault')
        await evictVault(handle, config,
          { ...filter, venues: venues.map(venue => venue.toLowerCase()) }, purge);
      else await evictArchives(handle, config, venues, purge);
    } finally {
      db.close(handle);
    }
  } finally {
    release();
  }
};
