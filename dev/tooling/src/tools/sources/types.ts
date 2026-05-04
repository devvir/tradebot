export interface TableConfig {
  timestampCol:   string | null;
  gapThresholdMs: number | null;
}

/**
 * Describes the CSV schema used to read and write a sources file.
 * Records read from `csv-parse` are keyed by column name, so no column indices
 * are stored — lookups go through the known column names (`_date_`, `_action_`,
 * and optionally `timestamp`).
 */
export interface Header {
  /** Column names in file order — used to serialize output rows. */
  columns: string[];

  /** True if the `timestamp` column is present in this file's schema. */
  hasTimestamp: boolean;
}

/**
 * A single BitMEX WS message parsed from a sources CSV file.
 *
 * A message is one or more parsed records. The first record (`rows[0]`) carries
 * the non-empty `_date_` and `_action_` values; subsequent continuation records
 * (if any) have empty `_date_` and hold overflow row data for multi-row actions
 * such as `insert` of a multi-row snapshot.
 */
export interface Message {
  /** One or more CSV records parsed for this message (first row is the message-start row). */
  rows: Record<string, string>[];

  /** Value of the `_date_` column on the message-start row. */
  date: string;

  /** Value of the `_action_` column on the message-start row. */
  action: string;

  /** Value of the `timestamp` column on the message-start row. Empty when the column is absent. */
  timestamp: string;
}
