/**
 * Throughput counters and the 5s log loop. The routes call back into the two
 * counters returned here; nothing else in the service knows about timing.
 */

import { logger } from '@devvir/service-kit';
import type { InsertCounter, ReadCounter } from './types';

const METRICS_MS = 5_000;

export interface MetricsHandle {
  writeCounter: InsertCounter;
  readCounter:  ReadCounter;
  stop:         () => void;
}

export const startMetrics = (): MetricsHandle => {
  let writeTotal = 0;
  let readTotal  = 0;
  let lastAt     = Date.now();
  let lastWrites = 0;
  let lastReads  = 0;

  const writeCounter: InsertCounter = (n) => { writeTotal += n; };
  const readCounter:  ReadCounter   = (n) => { readTotal  += n; };

  const timer = setInterval(() => {
    const now        = Date.now();
    const elapsed    = (now - lastAt) / 1000;
    const writeDelta = writeTotal - lastWrites;
    const readDelta  = readTotal  - lastReads;

    logger.info({
      writes: { total: writeTotal, delta: writeDelta, rate: Math.round(writeDelta / elapsed) },
      reads:  { total: readTotal,  delta: readDelta,  rate: Math.round(readDelta  / elapsed) },
    }, 'Librarian metrics');

    lastAt     = now;
    lastWrites = writeTotal;
    lastReads  = readTotal;
  }, METRICS_MS);

  timer.unref();

  return { writeCounter, readCounter, stop: () => clearInterval(timer) };
};
