import { Db } from 'mongodb';
import { parseMongoId, startOfDayMongoId } from '@tradebot/utils';
import type { DateRange, CountOptions } from '../types';

const COUNT_CONCURRENCY        = 100;
const BIG_COLLECTION_THRESHOLD = 1_000_000;  // docs

// Bin tables (tradeBin1m, quoteBin5m, …) are _id-sparse: each bin row carries
// the `_id` of one constituent source trade/quote, not its own position. So the
// dense per-day count (max `_id` → decoded `position`) yields the SOURCE row
// count for the day, not the bin count. We exploit that: the dense sum is the
// total source rows, which a single sampled bins-per-source ratio scales down
// to an estimated bin count.
const SPARSE_COLLECTION_RE = /(?:trade|quote)Bin\d+[mhd]$/;

// ── Exports ──────────────────────────────────────────────────────────────────

/**
 * Count documents in a collection that fall within a date range.
 *
 * Default (approximate) strategy depends on collection size (cheap metadata
 * read via estimatedDocumentCount):
 *
 *   - **Small collections** (< BIG_COLLECTION_THRESHOLD docs) → one
 *     `countDocuments({_id: range})`. A single bounded index scan is faster
 *     than hundreds of separate PK seeks when the index is small enough to
 *     fit in cache. Smaller bin collections land here and are counted exactly.
 *
 *   - **Large collections** (≥ BIG_COLLECTION_THRESHOLD docs) → exploit the
 *     vault `_id` encoding so we never scan the whole range:
 *       1. Bracket with two parallel PK seeks to find the first and last
 *          `_id` actually present in the range. Empty range → return 0 in
 *          2 queries.
 *       2. For each day in the active span, two PK seeks fetch the lowest and
 *          highest `_id` of the day; the count is `lastPosition -
 *          firstPosition + 1` under dense slot packing. A full day starts at
 *          position 1, so this is just the highest position; a head-first
 *          purge that has eaten the low slots raises the first position, so the
 *          span reflects what actually remains. Day lookups run
 *          COUNT_CONCURRENCY-wide.
 *
 *     For bin tables this dense sum is the source-row count, not the bin
 *     count; it is then scaled by a once-sampled bins-per-source ratio (see
 *     `sampleBinScale`) so a year of fine-grained bins never gets fully
 *     scanned just to size a dump.
 *
 * With `exact: true` we skip every fast path and always run
 * `countDocuments({_id: range})` — slow on large collections but accurate
 * even when slot packing is sparse.
 *
 * Caveat (approximate path): assumes a single dense run of slots per day. True
 * for append-only vault writers and for head-first purges (which the
 * first/last span tracks correctly); would over-count only if records were
 * deleted from the middle, leaving an interior gap.
 */
export async function estimateRangeCount(
  db:         Db,
  collection: string,
  date:       DateRange,
  options:    CountOptions = {},
): Promise<number> {
  const rangeFilter: Record<string, unknown> = { _id: { $gte: date.startId, $lt: date.endId } };

  if (options.exact) {
    return db.collection(collection).countDocuments(rangeFilter);
  }

  const total = await db.collection(collection).estimatedDocumentCount();

  if (total === 0) return 0;

  if (total < BIG_COLLECTION_THRESHOLD) {
    return db.collection(collection).countDocuments(rangeFilter);
  }

  const [firstDoc, lastDoc] = await Promise.all([
    db.collection(collection).find(rangeFilter).project({ _id: 1 }).sort({ _id:  1 }).limit(1).next(),
    db.collection(collection).find(rangeFilter).project({ _id: 1 }).sort({ _id: -1 }).limit(1).next(),
  ]);

  if (! firstDoc || ! lastDoc) return 0;

  const firstYmd = parseMongoId(firstDoc._id as number).date.replace(/-/g, '');
  const lastYmd  = parseMongoId(lastDoc._id  as number).date.replace(/-/g, '');

  const days   = enumerateDaysBetween(firstYmd, lastYmd);
  const perDay = await mapConcurrent(days, COUNT_CONCURRENCY, ymd =>
    countDay(db, collection, ymd)
  );

  const sum = perDay.reduce((acc, n) => acc + n, 0);

  if (! SPARSE_COLLECTION_RE.test(collection)) return sum;

  // Bins: `sum` is the source-row count. Scale it by one sampled day's
  // exact-bins / source-rows ratio to estimate the bin count.
  const scale = await sampleBinScale(db, collection, days, perDay);

  return Math.round(sum * scale);
}

// ── Internals ────────────────────────────────────────────────────────────────

/**
 * Bins-per-source-row ratio, sampled from a single representative day so the
 * caller can scale a dense source-row sum into an estimated bin count.
 *
 * Picks the middle populated day of the span (≈ mid-period: ~Jun 30 for a
 * year, ~the 15th for a month, the day itself for a day range) and counts that
 * one day's bins EXACTLY — cheap, since a single day of bins is small even when
 * the collection spans years. The denominator (the day's source-row count) is
 * the dense `countDay` value already computed for that day, so the base side
 * costs no extra query.
 */
async function sampleBinScale(
  db:         Db,
  collection: string,
  days:       string[],
  perDay:     number[],
): Promise<number> {
  const idx = middlePopulatedIdx(perDay);

  if (idx < 0) return 1;

  const day       = days[idx];
  const baseCount = perDay[idx];

  const dayFilter: Record<string, unknown> = {
    _id: { $gte: startOfDayMongoId(day), $lt: startOfDayMongoId(nextDayYmd(day)) },
  };

  const binCount = await db.collection(collection).countDocuments(dayFilter);

  return binCount / baseCount;
}

/** Index of the populated day (count > 0) nearest the middle of the span; -1 if none. */
function middlePopulatedIdx(perDay: number[]): number {
  const mid = Math.floor(perDay.length / 2);

  for (let d = 0; d < perDay.length; d++) {
    const lo = mid - d;
    const hi = mid + d;

    if (lo >= 0 && perDay[lo] > 0) return lo;
    if (hi < perDay.length && perDay[hi] > 0) return hi;
  }

  return -1;
}

async function countDay(db: Db, collection: string, ymd: string): Promise<number> {
  const dayStart = startOfDayMongoId(ymd);
  const dayEnd   = startOfDayMongoId(nextDayYmd(ymd));

  const filter: Record<string, unknown> = { _id: { $gte: dayStart, $lt: dayEnd } };

  // Bracket the day with its lowest and highest present `_id`. Under dense slot
  // packing the count is `lastPosition - firstPosition + 1`: for a full day the
  // first position is 1, recovering `lastPosition`; once a head-first purge has
  // eaten the low slots, the first position rises and the span tracks what
  // actually remains (the deleted slots are gone, not double-counted).
  const [firstDoc, lastDoc] = await Promise.all([
    db.collection(collection).find(filter).project({ _id: 1 }).sort({ _id:  1 }).limit(1).next(),
    db.collection(collection).find(filter).project({ _id: 1 }).sort({ _id: -1 }).limit(1).next(),
  ]);

  if (! firstDoc || ! lastDoc) return 0;

  const firstPos = parseMongoId(firstDoc._id as number).position;
  const lastPos  = parseMongoId(lastDoc._id  as number).position;

  return lastPos - firstPos + 1;
}

function enumerateDaysBetween(startYmd: string, endYmd: string): string[] {
  const days: string[] = [];
  let cur = startYmd;

  while (cur <= endYmd) {
    days.push(cur);
    cur = nextDayYmd(cur);
  }

  return days;
}

function nextDayYmd(ymd: string): string {
  const y = parseInt(ymd.slice(0, 4), 10);
  const m = parseInt(ymd.slice(4, 6), 10);
  const d = parseInt(ymd.slice(6, 8), 10);
  const next = new Date(Date.UTC(y, m - 1, d + 1));

  return `${next.getUTCFullYear()}${pad2(next.getUTCMonth() + 1)}${pad2(next.getUTCDate())}`;
}

function pad2(n: number): string {
  return String(n).padStart(2, '0');
}

async function mapConcurrent<T, R>(
  items:       T[],
  concurrency: number,
  fn:          (item: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;

  async function worker(): Promise<void> {
    while (next < items.length) {
      const idx = next++;
      results[idx] = await fn(items[idx]);
    }
  }

  const workerCount = Math.min(concurrency, items.length);

  await Promise.all(Array.from({ length: workerCount }, () => worker()));

  return results;
}
