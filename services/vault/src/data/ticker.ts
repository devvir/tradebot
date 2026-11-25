// Periodic flush.
//
// On every TICK_MS interval, pulls the ready batches from buffers and writes
// each one through `writeLines`. Batches are independent: one that fails is
// logged, counted toward storage health, and its rows are dropped, while the
// other batches of the same tick are written as usual.

import { logger } from '@devvir/service-kit';
import { buffers } from './buffers';
import { writeLines } from './bucket';
import { recordFailure } from '../fs/health';

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
  for (const { table, filename, lines } of buffers.flushReady()) {
    writeLines(table, filename, lines).catch((err: Error) => {
      logger.error({ err, table, filename, rowsDropped: lines.length }, 'Batch write failed, rows dropped');

      recordFailure(`batch write failed for ${table}/${filename}: ${err.message}`);
    });
  }
};

// ── Test helpers ──────────────────────────────────────────────────────────────

export const _test_tick = tick;
