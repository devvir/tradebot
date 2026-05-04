import path from 'node:path';
import { debug } from '../../../../shared/ui/logger';
import { read } from './reader';
import type { PreparedMessage, ReadIssue } from '../types';

const plog = (msg: string): void => { debug(`[${new Date().toISOString()}] ${msg}`); };

/**
 * SORT — minute-bucket accumulator with single-pass compound sorting, plus
 * the actor wiring that drives a single source through READ → SORT → MERGE.
 *
 * ## Sort key
 *
 * Bucket key (minute resolution): `msg.ts.slice(0, 16)`.
 * Sort key inside the bucket    : `msg.ts + msg.date`.
 *
 * `ts` is `(timestamp || _date_).slice(0, 23)` — already computed by READ.
 * For non-timestamped tables `ts === date`, so the sort key reduces to
 * `date + date`. For timestamped tables (instrument, orderBookL2) the key
 * gives exchange-time-primary ordering with `_date_` (reception time) as
 * a stable tiebreaker for messages at the exact same exchange millisecond.
 * One pass replaces what used to be two (sort by `_date_` then re-sort by
 * `ts`).
 *
 * ## Message-count eviction
 *
 * The sorter buffers up to `maxMessages` (default `MAX_SORT_MESSAGES`) total
 * messages across all in-flight buckets. When the threshold is exceeded, the
 * oldest minute-bucket is sorted and returned for downstream consumption.
 * For small tables the entire day fits in memory; for large tables (e.g.
 * orderBookL2) the effective sort window is on the order of minutes — fine
 * for BitMEX data which is near-perfectly ordered within a single source.
 */

export const MAX_SORT_MESSAGES = 50_000;

export interface Sorter {
  /** Push a batch of messages; returns any minute-buckets evicted by the size limit, in eviction order. */
  push(messages: PreparedMessage[]): PreparedMessage[][];
  /** Drain all remaining buckets in chronological key order. */
  flush(): PreparedMessage[][];
  /** Total messages currently buffered across all buckets. */
  size(): number;
}

export function createSorter(maxMessages: number = MAX_SORT_MESSAGES): Sorter {
  const buckets: Map<string, PreparedMessage[]> = new Map();
  const order:   string[]                       = [];
  let totalSize: number                         = 0;

  const sortBucket = (bucket: PreparedMessage[]): PreparedMessage[] => {
    bucket.sort((a, b) => {
      const ka = a.ts + a.date;
      const kb = b.ts + b.date;

      return ka < kb ? -1 : ka > kb ? 1 : 0;
    });

    return bucket;
  };

  const evictBucket = (key: string): PreparedMessage[] => {
    const bucket = buckets.get(key) ?? [];

    buckets.delete(key);
    totalSize -= bucket.length;

    return sortBucket(bucket);
  };

  return {
    push(messages: PreparedMessage[]): PreparedMessage[][] {
      for (const msg of messages) {
        const key = msg.ts.slice(0, 16);

        let bucket = buckets.get(key);

        if (! bucket) {
          bucket = [];
          buckets.set(key, bucket);
          order.push(key);
        }

        bucket.push(msg);
        totalSize++;
      }

      const evicted: PreparedMessage[][] = [];

      while (totalSize > maxMessages && order.length > 0) {
        const oldest = order.shift()!;
        const bucket = evictBucket(oldest);

        if (bucket.length > 0) {
          evicted.push(bucket);
        }
      }

      return evicted;
    },

    flush(): PreparedMessage[][] {
      const out: PreparedMessage[][] = [];

      for (const key of [...order].sort()) {
        const bucket = evictBucket(key);

        if (bucket.length > 0) {
          out.push(bucket);
        }
      }

      order.length = 0;

      return out;
    },

    size(): number {
      return totalSize;
    },
  };
}

// ── BoundedQueue ─────────────────────────────────────────────────────────────

/**
 * A bounded async queue with separate producer/consumer suspension.
 *
 * Producers `push()` items; if the size (measured by `sizeOf` — defaults to
 * one per item) is at or above `capacity`, the producer awaits until a
 * consumer takes enough to drop below capacity. Consumers `take()` items;
 * if the queue is empty (and not closed) they await until a producer pushes.
 *
 * `close()` signals end-of-stream — taking from a closed empty queue resolves
 * to `null`; pending takers wake immediately. Calling `fail(err)` records an
 * error that any subsequent `take()` will throw before draining.
 *
 * Designed for exactly one producer and one consumer. The single-waiter
 * pattern (one `wakePush` / one `wakeTake`) is sufficient and avoids
 * array bookkeeping.
 */
export class BoundedQueue<T> {
  private readonly items:    T[]   = [];
  private          size:     number = 0;
  private          closed:   boolean = false;
  private          error:    Error | null = null;
  private          wakePush: (() => void) | null = null;
  private          wakeTake: (() => void) | null = null;

  constructor(
    private readonly capacity: number,
    private readonly sizeOf:   (item: T) => number = () => 1,
  ) {}

  async push(item: T): Promise<void> {
    while (this.size >= this.capacity && ! this.closed) {
      await new Promise<void>(r => { this.wakePush = r; });
    }

    if (this.closed) return; // dropped — caller decides whether to error

    this.items.push(item);
    this.size += this.sizeOf(item);

    const r = this.wakeTake;

    if (r) {
      this.wakeTake = null;
      r();
    }
  }

  async take(): Promise<T | null> {
    while (this.items.length === 0) {
      if (this.error)  throw this.error;
      if (this.closed) return null;

      await new Promise<void>(r => { this.wakeTake = r; });
    }

    const item = this.items.shift()!;

    this.size -= this.sizeOf(item);

    const r = this.wakePush;

    if (r) {
      this.wakePush = null;
      r();
    }

    return item;
  }

  close(): void {
    this.closed = true;

    const t = this.wakeTake;
    if (t) { this.wakeTake = null; t(); }

    const p = this.wakePush;
    if (p) { this.wakePush = null; p(); }
  }

  fail(err: Error): void {
    this.error = err;
    this.close();
  }
}

// ── Source actor ─────────────────────────────────────────────────────────────

/**
 * READ inbound queue capacity (high-water): when the READ actor has produced
 * this many messages without the SORT actor consuming them, READ pauses until
 * the inbound queue drains.
 */
export const READ_INBOUND_CAPACITY = 30_000;

/**
 * SORT outbound queue capacity (high-water): when SORT has evicted this many
 * messages worth of buckets without MERGE consuming them, SORT pauses. This
 * is the backpressure signal that propagates upstream — SORT pauses → READ
 * inbound fills → READ pauses → OS reads stop.
 */
export const SORT_OUTBOUND_CAPACITY = 25_000;

/**
 * Spin up the READ + SORT actor pair for one source and return an
 * `AsyncGenerator` over its sorted-bucket outbound queue.
 *
 * Both actors run as detached async tasks — the JS event loop drives them
 * whenever it is otherwise idle, while libuv handles the underlying file
 * I/O and gunzip work on OS threads. With one source actor per file, all
 * sources read concurrently from disk.
 *
 * Each yielded value is one sorted minute-bucket from this source. MERGE
 * consumes from these generators across all sources and interleaves them
 * into the final sorted output.
 *
 * Errors from either READ or SORT propagate via the outbound queue: the
 * consumer's first `next()` after the failure throws the captured error.
 */
export function createSourceActor(
  tableName: string,
  sourcePath: string,
  onIssue:   (issue: ReadIssue) => void,
): AsyncGenerator<PreparedMessage[]> {
  const name     = path.basename(sourcePath);
  const inbound  = new BoundedQueue<PreparedMessage[]>(READ_INBOUND_CAPACITY,  b => b.length);
  const outbound = new BoundedQueue<PreparedMessage[]>(SORT_OUTBOUND_CAPACITY, b => b.length);

  // READ actor: pulls batches from `read()` and pushes them to the inbound
  // queue. Backpressure is automatic — `inbound.push()` awaits when the queue
  // is at capacity.
  void (async () => {
    try {
      for await (const batch of read(tableName, sourcePath, onIssue)) {
        plog(`[READ→inbound] ${name}: ${batch.length} msgs → inbound`);
        await inbound.push(batch);
      }

      plog(`[READ→inbound] ${name}: done`);
      inbound.close();
    } catch (err) {
      inbound.fail(err instanceof Error ? err : new Error(String(err)));
    }
  })();

  // SORT actor: consumes the inbound queue, runs the bucket-and-evict logic,
  // and pushes evicted sorted buckets to the outbound queue. On end-of-input
  // (or error from inbound), flushes any remaining buckets and closes
  // outbound.
  void (async () => {
    const sorter = createSorter();

    try {
      while (true) {
        const batch = await inbound.take();

        if (batch === null) break;

        const evicted = sorter.push(batch);

        plog(`[SORT] ${name}: inbound ${batch.length} msgs | buffer: ${sorter.size()} | evicting: ${evicted.reduce((s, b) => s + b.length, 0)} msgs in ${evicted.length} buckets`);

        for (const bucket of evicted) {
          await outbound.push(bucket);
        }
      }

      const flushed     = sorter.flush();
      const flushedMsgs = flushed.reduce((s, b) => s + b.length, 0);

      plog(`[SORT:flush] ${name}: ${flushed.length} buckets, ${flushedMsgs} msgs → outbound`);

      for (const bucket of flushed) {
        await outbound.push(bucket);
      }

      plog(`[SORT] ${name}: done`);
      outbound.close();
    } catch (err) {
      outbound.fail(err instanceof Error ? err : new Error(String(err)));
    }
  })();

  return drain(outbound);
}

async function* drain(queue: BoundedQueue<PreparedMessage[]>): AsyncGenerator<PreparedMessage[]> {
  while (true) {
    const batch = await queue.take();

    if (batch === null) return;

    yield batch;
  }
}

// ── Test exports ──────────────────────────────────────────────────────────────

export const _test_MAX_SORT_MESSAGES = MAX_SORT_MESSAGES;
