import type { BitmexTable } from '@tradebot/types';
import { peek, hasNext } from './buffer';
import type { TableBuffer, NextCandidate } from './types';

/**
 * The k-way merge across active table buffers — pick the buffer whose head has
 * the globally smallest timestamp, so consumers see one chronological stream
 * regardless of each table's own rate.
 */
export const pickNext = (buffers: Map<BitmexTable, TableBuffer>): NextCandidate | null => {
  let best: NextCandidate | null = null;

  for (const [table, buffer] of buffers) {
    if (! hasNext(buffer)) continue;

    const ts = peek(buffer)!.ts;

    if (best === null || ts < best.ts) best = { table, buffer, ts };
  }

  return best;
};

/** True when every active buffer is drained and has no more upstream. */
export const allExhausted = (buffers: Map<BitmexTable, TableBuffer>): boolean => {
  for (const buffer of buffers.values()) {
    if (! buffer.exhausted || buffer.entries.length > 0) return false;
  }

  return true;
};
