/**
 * Pops from the writer queue and routes each item into its batch, keyed by
 * routing identity: base table + target database (`secondary`). The flusher
 * (`flush.ts`) drains those batches periodically.
 *
 * Dispatch is intentionally trivial — it doesn't allocate, doesn't decide,
 * doesn't talk to mongo. Keeping it small makes the pipeline shape obvious
 * and isolates the per-table state to the flusher.
 */

import type { Batch, BoundedBuffer, Item, TableBatches } from '../types';

const BATCH_MAX = 10_000;

export const startDispatch = async (
  writerQueue: BoundedBuffer<Item>,
  batches:     TableBatches,
): Promise<void> => {
  while (true) {
    const items = await writerQueue.pop(BATCH_MAX);

    if (! items) return;

    for (const item of items) {
      const table = item.task.base;
      const key   = item.secondary ? `${table}:p2` : table;

      let batch: Batch | undefined = batches.get(key);

      if (! batch) {
        batch = { table, secondary: item.secondary, items: [] };
        batches.set(key, batch);
      }

      batch.items.push(item);
    }
  }
};
