import { debug } from '../../../../shared/ui/logger';
import type { PreparedMessage, SortBucket, Sorter } from '../types';

const plog = (msg: string): void => { debug(`[${new Date().toISOString()}] ${msg}`); };

/**
 * Minute-bucket sorter with lazy sorting. Buckets are `msg.ts.slice(0, 16)`;
 * each bucket tracks whether its inputs arrived already sorted and skips the
 * sort call on eviction when so. Eviction is triggered when the total buffered
 * message count crosses `maxMessages`. Stable sort within a bucket preserves
 * insertion order on `ts` ties, which carries `_date_` order through.
 */

export const MAX_SORT_MESSAGES = 50_000;

export function createSorter(maxMessages: number = MAX_SORT_MESSAGES): Sorter {
  const buckets: Map<string, SortBucket> = new Map();
  const order:   string[]            = [];
  let totalSize: number              = 0;

  const evictBucket = (key: string): PreparedMessage[] => {
    const bucket = buckets.get(key);

    if (! bucket) return [];

    buckets.delete(key);
    totalSize -= bucket.items.length;

    if (! bucket.isSorted) {
      bucket.items.sort((a, b) => a.ts < b.ts ? -1 : a.ts > b.ts ? 1 : 0);
    }

    return bucket.items;
  };

  return {
    push(messages: PreparedMessage[]): PreparedMessage[][] {
      for (const msg of messages) {
        const key = msg.ts.slice(0, 16);

        let bucket = buckets.get(key);

        if (! bucket) {
          bucket = { items: [], isSorted: true, lastTs: '' };
          buckets.set(key, bucket);
          order.push(key);
        }

        if (bucket.isSorted) {
          if (msg.ts < bucket.lastTs) {
            bucket.isSorted = false;
            plog(`[SORT] out-of-order: ts=${msg.ts} action=${msg.action} (prev: ${bucket.lastTs})`);
          }

          bucket.lastTs = msg.ts;
        }

        bucket.items.push(msg);
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

// ── Test exports ──────────────────────────────────────────────────────────────

export const _test_MAX_SORT_MESSAGES = MAX_SORT_MESSAGES;
