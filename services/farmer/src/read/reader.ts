/**
 * Per-task NDJSON streamer.
 *
 * Streams a bucket from vault and pushes one `Item` per line into the
 * shared reader queue. Each item carries the same `Task` reference and a
 * 1-based `position` (first message of the file is position 1).
 *
 * On stream completion, sets the task's total message count — the signal
 * that lets the Task finalize itself once the writer catches up.
 */

import { logger } from '@devvir/service-kit';
import { recordRead } from '../metrics';
import { streamBucket } from './vault';
import type { Task } from '../orchestration';
import type { BoundedBuffer, Item } from '../types';

export const readBucket = async (
  task:        Task,
  vaultUrl:    string,
  readerQueue: BoundedBuffer<Item>,
): Promise<void> => {
  /**
   * Skip is captured once at the start. `task.messages` reflects the
   * resume point at construction time; the writer side will start
   * bumping it as soon as inserts confirm, so we must not read it again
   * here.
   */
  const skip = task.messages;

  logger.info(`Reading bucket ${task.table}/${task.date} (${skip ? `from message ${skip + 1}` : 'from the start'})`);

  const totalMessages = await streamBucket(vaultUrl, task.table, task.date, async (line, position) => {
    /** `size` is the bytes the item contributes to the wire body. For REST it's
     *  the line itself; the WS path overwrites it in assemble.ts once the
     *  template-spliced envelope replaces `content`. */
    const item: Item = { task, position, content: line, size: line.length };

    await readerQueue.push(item);

    recordRead();
  }, skip);

  task.setTotalMessages(totalMessages);

  logger.debug({ table: task.table, date: task.date, totalMessages }, 'Bucket read complete');
};
