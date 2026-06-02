import { startOfDayMongoId } from '@tradebot/utils';
import { toMs } from './time';
import type { Librarian } from '../librarian';

/**
 * Map a timestamp to an `_id` cursor by binary search over the `_id` index —
 * `_id` and `timestamp` are monotonically correlated, so no timestamp index is
 * needed (one on trade/quote would cost ~0.5 TB).
 *
 * Returns the smallest `_id` whose stored doc has `timestamp >= ms`. When `ms`
 * falls after the day's last record the next-day floor is returned, so a forward
 * stream simply continues into later days. Used by cold-start seeks and the
 * latest-partial lookup — both rare control-plane paths, so a handful of indexed
 * `findOne` probes is free.
 */

const DAY_MS = 86_400_000;

/** Narrow the `_id` range to this span, then read it and scan for the boundary. */
const WINDOW = 50_000;

const isoDay = (ms: number): string =>
  new Date(ms).toISOString().slice(0, 10);

export const seekId = async (lib: Librarian, table: string, ms: number): Promise<number> => {
  let lo            = startOfDayMongoId(isoDay(ms));
  const nextDayId   = startOfDayMongoId(isoDay(ms + DAY_MS));
  let hi            = nextDayId;

  while (hi - lo > WINDOW) {
    const mid   = lo + Math.floor((hi - lo) / 2);
    const probe = await lib.latestBefore(table, mid);

    if (! probe || probe._id < lo) {
      lo = mid + 1;

      continue;
    }

    if (toMs(probe.timestamp as string) >= ms) hi = probe._id;
    else                                       lo = probe._id + 1;
  }

  const docs = await lib.read(table, { from: lo, before: hi - 1, order: 'asc', limit: WINDOW });
  const hit  = docs.find(d => toMs(d.timestamp as string) >= ms);

  return hit ? hit._id : nextDayId;
};
