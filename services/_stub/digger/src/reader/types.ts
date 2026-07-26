import type { BitmexTable } from '@tradebot/types';
import type { StreamItem } from '../core/types';

/**
 * Per-table warm buffer of ready-to-emit messages (all with `ts >= clock` at
 * activation; catch-up deltas before the clock are folded into the accumulator,
 * never buffered). Filled by paging the provider; drained by the merge.
 */
export interface TableBuffer {
  table:      BitmexTable;
  entries:    StreamItem[];
  /** Opaque provider cursor for the next page, or null when exhausted/none. */
  cursor:     number | null;
  isFetching: boolean;
  exhausted:  boolean;
}

/** The head candidate chosen by the k-way merge. */
export interface NextCandidate {
  table:  BitmexTable;
  buffer: TableBuffer;
  ts:     number;
}
