/**
 * Bucket progress tracking for the customs pipeline.
 *
 * Registrar is the ground truth for what has been safely stored in MongoDB.
 * Other parts of the service call:
 *
 *   - `record(table, date, msgIndex)` after a successful insert
 *   - `recordControl(msg)` when clerk publishes a `control` message
 *
 * Neither caller knows or cares about Redis — this module owns when, how, and
 * why progress is persisted. On a periodic tick it dumps the in-memory state
 * to `customs:<table>:<date>`:
 *
 *   - if the bucket has reached its goal (clerk said `highestIndex: N` and
 *     registrar has confirmed msgIndex N stored), write `'done:<count>'` —
 *     where `count = highestIndex + 1` is the total number of messages in
 *     the bucket — and drop the bucket from memory
 *   - otherwise, write the current counter (highest stored msgIndex)
 *
 * The counter is strictly increase-only. Re-deliveries of already-seen
 * msgIndices are no-ops. Clerk guarantees no gaps within a bucket, so the
 * counter doubles as "everything up to and including this index is stored."
 */

import type { RedisClient, ControlMessage, BucketState } from './types';

const buckets = new Map<string, BucketState>();

let redis:    RedisClient   | null = null;
let timer:    NodeJS.Timeout | null = null;
let flushing: boolean              = false;

// ── Public API ───────────────────────────────────────────────────────────────

/** Record that a message at `msgIndex` has been safely stored for this bucket. */
export const record = (table: string, date: string, msgIndex: number): void => {
  const bucket = getOrCreate(table, date);

  if (msgIndex > bucket.counter) bucket.counter = msgIndex;
};

/** Set the bucket's goal — the highest msgIndex clerk will ever publish for it. */
export const recordControl = (msg: ControlMessage): void => {
  const bucket = getOrCreate(msg.table, msg.date);

  bucket.goal = msg.highestIndex;
};

/** Begin periodic Redis dumps. Call once at service startup. */
export const start = (client: RedisClient, intervalMs: number): void => {
  redis = client;
  timer = setInterval(flush, intervalMs);
  timer.unref();
};

/** Stop the periodic timer. Call on service shutdown. */
export const stop = (): void => {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
};

// ── Internals ────────────────────────────────────────────────────────────────

const bucketKey = (table: string, date: string): string => `${table}:${date}`;

const redisKey = (bucket: BucketState): string => `customs:${bucket.table}:${bucket.date}`;

const getOrCreate = (table: string, date: string): BucketState => {
  const k = bucketKey(table, date);

  let bucket = buckets.get(k);

  if (! bucket) {
    bucket = { table, date, counter: -1, goal: null };
    buckets.set(k, bucket);
  }

  return bucket;
};

/**
 * Dump every active bucket's state to Redis. Buckets that have reached their
 * goal are written as `'done:<count>'` (count = `highestIndex + 1`) and
 * dropped; the rest get their current counter written as a numeric string.
 *
 * Before writing, every bucket's existing Redis value is read in one MGET.
 * If a bucket is already marked done, the write is skipped and the in-memory
 * state is dropped — done buckets are immutable, so late or repeated messages
 * (which would otherwise resurrect a fresh `BucketState` with `goal === null`
 * and trigger a counter overwrite) cannot regress a completed bucket.
 *
 * Reentrancy-guarded so a slow Redis can't stack overlapping flushes.
 */
const flush = async (): Promise<void> => {
  if (! redis || flushing) return;

  flushing = true;

  try {
    if (buckets.size === 0) return;

    const entries = [ ...buckets.entries() ];
    const keys    = entries.map(([ , b ]) => redisKey(b));
    const current = await redis.mGet(keys);

    const work: Promise<unknown>[] = [];

    for (let i = 0; i < entries.length; i++) {
      const [ k, bucket ] = entries[i]!;
      const existing      = current[i];

      if (existing !== null && existing.startsWith('done')) {
        buckets.delete(k);
        continue;
      }

      if (bucket.goal !== null && bucket.counter === bucket.goal) {
        work.push(redis.set(redisKey(bucket), `done:${bucket.goal + 1}`));
        buckets.delete(k);
      } else {
        work.push(redis.set(redisKey(bucket), String(bucket.counter)));
      }
    }

    await Promise.all(work);
  } finally {
    flushing = false;
  }
};

// ── Test exports ─────────────────────────────────────────────────────────────

export const _test_buckets = buckets;
export const _test_flush   = flush;
export const _test_reset   = (): void => {
  buckets.clear();
  redis    = null;
  flushing = false;

  if (timer) {
    clearInterval(timer);
    timer = null;
  }
};
