import path from 'node:path';
import { createGzipWriter } from '../writer';
import { writeOutputHeader } from './tasks/header';
import type { PreparedMessage } from './types';

/**
 * OVERFLOW — collect messages whose `_date_` does not match the source group
 * day, then write them to per-target-day output files.
 *
 * Filename: `<targetDay>.overflow-<sourceDay>.csv.gz`
 *
 * The target-day prefix means the discovery step automatically picks these
 * files up as sources for the right day on a subsequent prepare run. The
 * `-<sourceDay>` suffix guarantees uniqueness — two runs producing overflow
 * into the same target day generate two distinct files (no collision, no
 * implicit append).
 *
 * No SORT, no MERGE, no DEDUP. Messages arrive already in `ts` order from
 * the upstream pipeline and are written directly to disk.
 */
export interface Overflow {
  add:   (msg: PreparedMessage) => void;
  flush: (
    folder:    string,
    sourceDay: string,
    tableName: string,
  ) => Promise<OverflowFlushResult>;
  totals: () => Map<string, number>;
}

export interface OverflowFlushResult {
  /** Map of <targetDay> → number of messages written to that day's overflow file. */
  byDay: Map<string, number>;
  /** Output paths created (empty when there was nothing to flush). */
  paths: string[];
}

export function createOverflow(): Overflow {
  const partitions: Map<string, PreparedMessage[]> = new Map();

  return {
    add(msg) {
      const targetDay = msg.date.slice(0, 10).replace(/-/g, '');

      let bucket = partitions.get(targetDay);

      if (! bucket) {
        bucket = [];
        partitions.set(targetDay, bucket);
      }

      bucket.push(msg);
    },

    totals() {
      const out = new Map<string, number>();

      for (const [day, msgs] of partitions) {
        out.set(day, msgs.length);
      }

      return out;
    },

    async flush(folder, sourceDay, tableName) {
      const byDay = new Map<string, number>();
      const paths: string[] = [];

      for (const [targetDay, messages] of partitions) {
        const filename = `${targetDay}.overflow-${sourceDay}.csv.gz`;
        const fullPath = path.join(folder, filename);

        const writer = createGzipWriter(fullPath);

        writeOutputHeader(writer, tableName, targetDay);

        for (const msg of messages) {
          await writer.writeMessage({
            rows:      msg.rows,
            date:      msg.date,
            action:    msg.action,
            timestamp: msg.timestamp,
          });
        }

        await writer.close();

        byDay.set(targetDay, messages.length);
        paths.push(fullPath);
      }

      partitions.clear();

      return { byDay, paths };
    },
  };
}
