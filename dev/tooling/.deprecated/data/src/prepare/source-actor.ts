import path from 'node:path';
import { debug } from '../../../shared/ui/logger';
import { read } from './tasks/reader';
import { createSorter } from './tasks/sorter';
import { BoundedQueue } from './utils/bounded-queue';
import type { PreparedMessage, ReadIssue } from './types';

const plog = (msg: string): void => { debug(`[${new Date().toISOString()}] ${msg}`); };

// High-water marks for the inter-actor queues. SORT pausing on outbound
// propagates upstream through inbound, eventually stalling OS reads.
export const READ_INBOUND_CAPACITY  = 30_000;
export const SORT_OUTBOUND_CAPACITY = 25_000;

/**
 * Spin up the READ + SORT actor pair for one source and yield sorted
 * minute-buckets via an `AsyncGenerator`. Errors from either actor surface
 * on the next consumer `next()` call.
 */
export function createSourceActor(
  tableName:      string,
  sourcePath:     string,
  onIssue:        (issue: ReadIssue) => void,
  onReadComplete: (count: number) => void = () => { /* no-op */ },
): AsyncGenerator<PreparedMessage[]> {
  const name     = path.basename(sourcePath);
  const inbound  = new BoundedQueue<PreparedMessage[]>(READ_INBOUND_CAPACITY,  b => b.length);
  const outbound = new BoundedQueue<PreparedMessage[]>(SORT_OUTBOUND_CAPACITY, b => b.length);

  // READ actor.
  void (async () => {
    try {
      let totalRead = 0;

      for await (const batch of read(tableName, sourcePath, onIssue)) {
        totalRead += batch.length;
        plog(`[READ→inbound] ${name}: ${batch.length} msgs → inbound`);
        await inbound.push(batch);
      }

      onReadComplete(totalRead);
      plog(`[READ→inbound] ${name}: done`);
      inbound.close();
    } catch (err) {
      inbound.fail(err instanceof Error ? err : new Error(String(err)));
    }
  })();

  // SORT actor.
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
