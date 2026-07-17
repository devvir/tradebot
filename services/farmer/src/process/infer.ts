/**
 * Routes items from the reader queue based on their task's type:
 *
 *   - WS  → assembler queue (parse + reconstruct)
 *   - REST → writer queue (passed through with `raw` still set; the
 *            flusher parses on the way to mongo)
 *
 * REST records of pooled tables are tagged `secondary` here (substring scan
 * for `pool=Secondary`) so dispatch routes them to the secondary database.
 *
 * Admission to the writer queue goes through the staging byte gate; the
 * assembler queue is not gated here because assembly always pushes to the
 * writer queue itself (where the gate is checked).
 */

import { admit } from '../write/staging';
import type { BoundedBuffer, Item } from '../types';

const BATCH_MAX = 10_000;

/**
 * Secondary-pool marker for record-origin lines. Pooled tables' records carry
 * an explicit per-row `pool`, and their fields are numeric/enum (no free text),
 * so a plain substring scan is exact — no JSON.parse on the hot path.
 */
const SECONDARY_MARK = '"pool":"Secondary"';

export const startInfer = async (
  readerQueue:    BoundedBuffer<Item>,
  assemblerQueue: BoundedBuffer<Item>,
  writerQueue:    BoundedBuffer<Item>,
): Promise<void> => {
  while (true) {
    const items = await readerQueue.pop(BATCH_MAX);

    if (! items) return;

    for (const item of items) {
      if (item.task.type === 'ws') {
        await assemblerQueue.push(item);
      } else {
        if (item.task.pooled)
          item.secondary = item.content.includes(SECONDARY_MARK);

        await admit(item.size);
        item.task.admit();
        await writerQueue.push(item);
      }
    }
  }
};
