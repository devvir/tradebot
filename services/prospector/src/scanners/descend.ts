import { logger } from '@devvir/service-kit';
import { isExcluded } from '../exclusions';
import { relative } from '../paths';
import type { Limits, ListingContext, ReadLevel } from '../types';

/**
 * Carve a venue into enough partitions to start walking, and no more.
 *
 * **Begins at the root and splits until there is work for every lane.** Nothing
 * here decides what a level *means* — no rule about symbols, months or
 * intervals, all of which differ per venue and none of which predicts size. A
 * prefix is expanded because there are still idle lanes to fill, and that is the
 * whole of it.
 *
 * **It only has to be roughly right.** A partition that turns out to hold a
 * disproportionate share of the archive is split again while the survey runs —
 * see `refine` in `survey.ts` — so a bad first guess costs a few listings rather
 * than the whole pass. That is what let the old rules go: `FANOUT` guessed where
 * the symbol level was from the width of a directory, and `FRONTIER` capped a
 * frontier that was being built for the wrong reason. Binance's spot klines is
 * both wide *and* branching, so the guess put 29,150 pages behind one worker.
 *
 * **Every prefix not yet read is read at once**, up to the room left before
 * there is enough work, rather than one after another. A wide archive reaches
 * its partitions one symbol directory at a time — each read once, to learn it
 * holds files and stays whole — and asked in turn that was 600 round trips
 * end to end: measured 2026-10-01, gate took 9.5 minutes to map and binance
 * more than 17, while every request still passes the venue's own gate.
 */
export const descend = async (
  context: ListingContext,
  limits:  Limits,
  read:    ReadLevel,
): Promise<string[]> => {
  const scopes = [context.keyRoot];

  /**
   * Every prefix is expanded at most once, which is what makes this terminate
   * rather than merely tend to. A venue that answered with a child equal to its
   * parent — a stray trailing slash, an index linking to itself — would
   * otherwise be split into itself for ever, and the loop below has no other
   * bound: it stops when there is enough work or when nothing is left to split,
   * and "nothing left" has to be a fact rather than a hope.
   */
  const seen = new Set<string>();

  while (scopes.length < limits.concurrency) {
    const unread = scopes.filter(scope => ! seen.has(scope)).slice(0, limits.concurrency - scopes.length);

    // Nothing left that can be split. Fewer partitions than lanes is the honest
    // outcome for a shallow archive, not a reason to keep asking.
    if (unread.length === 0) break;

    for (const prefix of unread) seen.add(prefix);

    const levels = await Promise.all(unread.map(prefix => read(context, prefix)));

    unread.forEach((prefix, i) => {
      const { children, files } = levels[i]!;

      /**
       * **A prefix holding a file of its own is never split.** A partition walks
       * with no delimiter and so covers every key beneath it; its children cover
       * only their own subtrees, and a key sitting directly here would belong to
       * none of them. "Catalogable" is load-bearing: a bucket root serves
       * `index.html` and `favicon.ico`, and counting those would make the entire
       * bucket one serial partition.
       */
      if (files || children.length === 0) return;

      /**
       * **Split in order, and only while there is room.** Read together, the
       * whole batch would otherwise be split together, each adding every child
       * it has — kucoin came out at 9,217 partitions where one at a time it made
       * 852. Stopping at the target keeps the overshoot to one directory's width;
       * a prefix read but left whole is a partition like any other.
       */
      if (scopes.length >= limits.concurrency) return;

      scopes.splice(scopes.indexOf(prefix), 1, ...children.filter(child => child !== prefix));
    });
  }

  logger.info({ venue: context.name, scopes: scopes.length }, 'Mapped the archive');

  return scopes;
};

/**
 * Whether a key would become a row — the same two questions the recording step
 * asks, so descent and recording cannot disagree about what counts as a file.
 */
export const catalogable = (context: ListingContext, key: string): boolean =>
  accepted(context, key) && context.dateOf(relative(context, key)) !== null;

/**
 * Whether the venue will have anything to do with this key **or prefix**.
 *
 * Asked of a directory as well as a file, which is why an adapter's patterns
 * have to hold for both — see the note on `accepts` in `types.ts`. A refused
 * directory is ignored as though it were not there rather than walked and
 * discarded key by key: filtering only at the recording step is correct but
 * still pays for the whole walk, and binance's `data2/data/spot/klines/` alone
 * is 655 pages that store nothing.
 *
 * The enumerated exclusions are consulted first, and only ever match a whole
 * key — a directory is never in that list, so this stays a question about files
 * even when it is asked about a prefix.
 */
export const accepted = (context: ListingContext, key: string): boolean => {
  const path = relative(context, key);

  if (isExcluded(context.name, path)) return false;

  return ! context.accepts || context.accepts(path);
};
