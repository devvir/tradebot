import { Db } from 'mongodb';
import { parseMongoId, startOfDayMongoId } from '@tradebot/utils';
import type { DateRange, CountOptions } from '../types';

const COUNT_CONCURRENCY        = 100;
const BIG_COLLECTION_THRESHOLD = 1_000_000;  // docs

// Bin tables (tradeBin1m, quoteBin5m, …) are sparse: each bin row carries the
// `_id` of its constituent source trade/quote for traceability, not its own
// position. Decoding `position` from a bin's max `_id` therefore returns the
// SOURCE row's position (millions), not the bin's count — wildly off. Force
// countDocuments for these; their indexes are small enough that it's fast.
const SPARSE_COLLECTION_RE = /Bin\d+[mhd]$/;

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
 *     fit in cache.
 *
 *   - **Large collections** (≥ BIG_COLLECTION_THRESHOLD docs) → exploit the
 *     vault `_id` encoding so we never scan the whole range:
 *       1. Bracket with two parallel PK seeks to find the first and last
 *          `_id` actually present in the range. Empty range → return 0 in
 *          2 queries.
 *       2. For each day in the active span, one PK seek fetches the highest
 *          `_id` of the day; decode its 1-based `position` field — equal to
 *          the doc count for that day under dense slot packing. Day lookups
 *          run COUNT_CONCURRENCY-wide.
 *
 * With `exact: true` we skip both fast paths and always run
 * `countDocuments({_id: range})` — slow on large collections but accurate
 * even when slot packing is sparse.
 *
 * Caveat (approximate path): assumes dense slot packing. True for
 * append-only vault writers; would over-count if records were deleted.
 */
export async function estimateRangeCount(
  db:         Db,
  collection: string,
  date:       DateRange,
  options:    CountOptions = {},
): Promise<number> {
  const rangeFilter: Record<string, unknown> = { _id: { $gte: date.startId, $lt: date.endId } };

  if (options.exact || SPARSE_COLLECTION_RE.test(collection)) {
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
  const counts = await mapConcurrent(days, COUNT_CONCURRENCY, ymd =>
    countDay(db, collection, ymd)
  );

  return counts.reduce((sum, n) => sum + n, 0);
}

// ── Internals ────────────────────────────────────────────────────────────────

async function countDay(db: Db, collection: string, ymd: string): Promise<number> {
  const dayEnd = startOfDayMongoId(nextDayYmd(ymd));

  // Upper bound only — fetch the highest _id strictly before the next day starts.
  // If the returned doc's encoded date isn't `ymd`, day is empty (count = 0).
  const filter: Record<string, unknown> = { _id: { $lt: dayEnd } };

  const doc = await db.collection(collection)
    .find(filter)
    .project({ _id: 1 })
    .sort({ _id: -1 })
    .limit(1)
    .next();

  if (! doc) return 0;

  const decoded = parseMongoId(doc._id as number);
  const docYmd  = decoded.date.replace(/-/g, '');

  return docYmd === ymd ? decoded.position : 0;
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
