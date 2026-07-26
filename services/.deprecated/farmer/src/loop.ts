/**
 * Worker pool. Each worker pulls one Task at a time from `nextTask()`,
 * streams its bucket via the reader, and loops. When `nextTask()` returns
 * `undefined` (orchestration's shutdown signal), the worker exits.
 *
 * Discovery, ordering, resume points and shutdown handling all live in
 * `orchestration/`. This module is just the pool that consumes from it.
 */

import { logger } from '@devvir/service-kit';
import { nextTask, releaseTask } from './orchestration';
import { readBucket } from './read/reader';
import type { BoundedBuffer, Config, Item } from './types';

export const runWorkers = async (
  config:      Config,
  readerQueue: BoundedBuffer<Item>,
): Promise<void> => {
  const workers = Array.from({ length: config.fileConcurrency }, () => worker(config, readerQueue));

  await Promise.all(workers);
};

const worker = async (
  config:      Config,
  readerQueue: BoundedBuffer<Item>,
): Promise<void> => {
  while (true) {
    const task = await nextTask();

    if (! task) return;

    try {
      await readBucket(task, config.vaultUrl, readerQueue);
    } catch (err) {
      /** Release the in-flight slot so the next refresh can hand this bucket
       *  back out. Success paths clear it via `trackCompletion`. */
      releaseTask(task);

      logger.error({ err, table: task.table, date: task.date }, 'Bucket read failed — will retry next refresh');
    }
  }
};
