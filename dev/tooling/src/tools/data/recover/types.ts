/** Tallies from a message-level sanitize pass over a recovered CSV. */
export interface SanitizeStats {
  msgKept:     number;
  msgDropped:  number;
  rowsKept:    number;
  rowsDropped: number;
}

/**
 * Resolved per-table row layout used to validate a recovered row: exact column
 * count, the `_date_` column index (ISO on a message's first row, empty on
 * continuations), and the `timestamp` column index (`-1` when the table has
 * none) which must hold an ISO value on every row.
 */
export interface RowSpec {
  cols:    number;
  dateIdx: number;
  tsIdx:   number;
}

/** Outcome of recovering one corrupt file. */
export interface RecoverOutcome {
  outPath: string;
  mode:    'sanitized' | 'pruned' | 'no-timestamp';
  stats?:  SanitizeStats;
}
