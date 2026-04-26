import { hasNext, peek } from './buffer';
import { TABLE_HANDLERS } from '../tables';
import type { BitmexTable, State, TableBuffer } from '../types';

/**
 * The k-way merge across all active table buffers — the heart of replay
 * ordering. Always picks the next message with the globally smallest
 * timestamp, so consumers see one chronological stream regardless of each
 * table's own data rate.
 */

export interface NextCandidate {
  table:     BitmexTable;
  buffer:    TableBuffer;
  timestamp: number;
}

// ── Public API ────────────────────────────────────────────────────────────────

/** Return the head of whichever buffer has the smallest timestamp, or null. */
export const pickNext = (state: State): NextCandidate | null => {
  let best: NextCandidate | null = null;

  for (const [table, buffer] of state.buffers) {
    const candidate = candidateFrom(table as BitmexTable, buffer);

    if (! candidate) continue;

    if (best === null || candidate.timestamp < best.timestamp) {
      best = candidate;
    }
  }

  return best;
};

/** True when every subscribed buffer is empty AND has no more data upstream. */
export const allExhausted = (state: State): boolean => {
  for (const [table, buffer] of state.buffers) {
    if (! state.subscriptions.has(table)) continue;

    if (! buffer.exhausted || buffer.entries.length > 0) return false;
  }

  return true;
};

// ── Internal ──────────────────────────────────────────────────────────────────

const candidateFrom = (table: BitmexTable, buffer: TableBuffer): NextCandidate | null => {
  if (! hasNext(buffer)) return null;

  const handler = TABLE_HANDLERS[table];

  if (! handler) return null;

  const head = peek(buffer)!;

  return {
    table,
    buffer,
    timestamp: handler.getTimestamp(head),
  };
};
