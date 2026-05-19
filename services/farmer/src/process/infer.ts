/**
 * Routes items from the reader queue based on their task's type:
 *
 *   - WS  → assembler queue (parse + reconstruct)
 *   - REST → writer queue (passed through with `raw` still set; the
 *            flusher parses on the way to mongo)
 *
 * Admission to the writer queue goes through the inflight gate; the
 * assembler queue is unbounded relative to inflight because assembly
 * always pushes to the writer queue itself (where the gate is checked).
 */

import { admit } from '../write/inflight';
import type { BoundedBuffer, Item } from '../types';

const BATCH_MAX = 10_000;

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
        await admit(1);
        item.task.admit();
        await writerQueue.push(item);
      }
    }
  }
};
