export interface TableConfig {
  timestampCol:   string | null;
  gapThresholdMs: number | null;
}

/**
 * A single BitMEX WS message parsed from a sources CSV file.
 *
 * A message is one or more parsed records. The first record (`rows[0]`) carries
 * the non-empty `_date_` and `_action_` values; subsequent continuation records
 * (if any) have empty `_date_` and hold overflow row data for multi-row actions
 * such as `insert` of a multi-row snapshot.
 *
 * Rows are pre-ordered string arrays matching the table's column order exactly
 * as read from disk. Column identity is positional: `_date_` is always index 0,
 * `_action_` always index 1. The order is an invariant — nothing in the pipeline
 * reorders values within a row.
 */
export interface Message {
  /** One or more CSV rows for this message, each a complete pre-normalized CSV line. */
  rows: string[];

  /** Value of the `_date_` column on the message-start row. */
  date: string;

  /** Value of the `_action_` column on the message-start row. */
  action: string;

  /** Value of the `timestamp` column on the message-start row. Empty when the column is absent. */
  timestamp: string;
}
