// Periodic flush orchestrator.
//
// On every TICK_MS interval: pulls ready batches from buffers, prepends a
// header line if the on-disk file is not yet initialised, and hands each
// batch to `fs/writer.appendBatch`. The single path through which buffered
// rows reach disk for streaming writes (the other being `closeBucket` and
// the shutdown drain in `index.ts`).

import { logger } from '@devvir/service-kit';
import { buffers } from './buffers';
import { headersFor } from './headers';
import { appendBatch, isInitialized } from '../fs/writer';

const TICK_MS = 200;

let timer: ReturnType<typeof setInterval> | null = null;

export const startTicker = (): void => {
  if (timer) return;

  timer = setInterval(() => tick(), TICK_MS);
};

export const stopTicker = (): void => {
  if (! timer) return;

  clearInterval(timer);
  timer = null;
};

const tick = (): void => {
  const ready = buffers.flushReady();

  for (const { table, filename, lines } of ready) {
    // The init check and appendBatch call are both synchronous — the event
    // loop cannot yield between them, so no race is possible on header
    // prepending across concurrent batches for the same file.
    const finalLines = isInitialized(table, filename)
      ? lines
      : [headerLine(table), ...lines];

    appendBatch(table, filename, finalLines).catch((err) => {
      logger.error({ err, table, filename }, 'appendBatch failed');
    });
  }
};

const headerLine = (table: string): string => {
  const cols = headersFor(table);

  if (! cols) throw new Error(`No header definition for table '${table}'`);

  return cols.join(',');
};

// ── Test helpers ──────────────────────────────────────────────────────────────

export const _test_tick    = tick;
export const _test_TICK_MS = TICK_MS;
