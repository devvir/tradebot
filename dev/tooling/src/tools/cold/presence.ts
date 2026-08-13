import { idOf, idsByMonth, openFacts } from './ledger';
import { scanVault } from './scan';
import * as db from './db';
import type { DatabaseSync } from 'node:sqlite';
import type { ColdConfig, Presence } from './types';

/**
 * What stocker says it built, against what actually exists.
 *
 * **Two commands ask this and both were getting it subtly wrong**, so it is
 * written once. `cold audit` reports the difference as a problem; `cold push`
 * withholds any month with a difference from the plan. Same three steps, same
 * ordering requirement, and there is no version of either that wants a different
 * answer.
 *
 * **The order is the correctness, not an implementation detail.** Stocker
 * renames a partition into its final path and states the fact milliseconds
 * later, so a fact implies its file — but only from the moment the fact exists.
 * Reading the facts *after* walking the tree meant every partition built while
 * the walk was running had a fact this then read and a file the walk had already
 * gone past. It reads as built-and-vanished, and the window is wide: a vault
 * walk is minutes, and stocker writes several partitions a second, symbol by
 * symbol across every month that symbol holds — so a few seconds of its work
 * surfaced as "15 partitions across 12 months", and `push` refused to pack any
 * of them.
 *
 * Taking the facts first inverts it into the harmless direction. A partition
 * built during the walk is in neither set, so nothing is claimed about it and
 * the next run picks it up; everything in `claimed` existed before the walk
 * began, so the walk was always going to reach it.
 *
 * That is why this returns both halves from one call rather than offering two
 * functions a caller could invoke in either order.
 */
export const surveyVault = async (
  handle: DatabaseSync,
  config: ColdConfig,
  wanted: (venue: string) => boolean = () => true,
): Promise<Presence> => {
  const claimed = claims(config, wanted);

  /**
   * The whole tree is walked whatever the venue filter says. `venue=` is the top
   * level today and may not be tomorrow, and the walk is cheap next to the
   * per-file comparison a caller does with the result.
   */
  const files = (await scanVault(config.sourceRoot)).filter(file => wanted(file.venue));

  /**
   * **A partition already in cold storage is present.** It was evicted from disk
   * on purpose, and treating that as a hole would make `cold evict vault`
   * incompatible with every check built on this.
   */
  const uploaded = db.uploaded(handle, 'vault').filter(row => wanted(row.venue));
  const present  = new Set<string>();

  for (const file of files) present.add(idOf(file));
  for (const row of uploaded) present.add(idOf(row));

  return { claimed, present, files, uploaded };
};

/** Everything `claimed` holds for one venue, flattened out of its months. */
export const idsFor = (claimed: Presence['claimed'], venue: string): string[] =>
  [...claimed.get(venue)?.values() ?? []].flatMap(ids => [...ids]);

// ── Internals ─────────────────────────────────────────────────────────────────

/**
 * What stocker says it built, by venue and month.
 *
 * **One query per venue, not one per venue-month.** The facts store answers the
 * whole venue at once and the months fall out of the rows, so asking per month
 * would fetch the same rows repeatedly to group them differently.
 *
 * Read as `tooling`, which owns nothing and needs to own nothing: reads are
 * unowned by design, and a consumer needs no permission to find out where a
 * producer has got to.
 */
const claims = (
  config: ColdConfig,
  wanted: (venue: string) => boolean,
): Presence['claimed'] => {
  const facts   = openFacts(config);
  const claimed = new Map<string, Map<string, Set<string>>>();

  try {
    for (const venue of facts.distinct('venue', { topic: 'vault' }))
      if (wanted(venue)) claimed.set(venue, idsByMonth(facts, venue));
  } finally {
    facts.close();
  }

  return claimed;
};
