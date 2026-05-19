/**
 * Pops from the writer queue and routes each item into its table's batch
 * buffer. The flusher (`flush.ts`) drains those buffers periodically.
 *
 * Dispatch is intentionally trivial — it doesn't allocate, doesn't decide,
 * doesn't talk to mongo. Keeping it small makes the pipeline shape obvious
 * and isolates the per-table state to the flusher.
 */

import type { BoundedBuffer, Item } from '../types';
import type { BitmexTable } from '@tradebot/types';

export type TableBatches = Map<BitmexTable, Item[]>;

const BATCH_MAX = 10_000;

export const startDispatch = async (
  writerQueue: BoundedBuffer<Item>,
  batches:     TableBatches,
): Promise<void> => {
  while (true) {
    const items = await writerQueue.pop(BATCH_MAX);

    if (! items) return;

    for (const item of items) {
      let list = batches.get(item.task.table);

      if (! list) {
        list = [];
        batches.set(item.task.table, list);
      }

      list.push(item);
    }
  }
};
