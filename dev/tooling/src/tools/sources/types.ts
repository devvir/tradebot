export type RunMode = 'fix' | 'merge' | 'fix-dry' | 'merge-dry' | 'check' | 'check-dry';

export interface TableConfig {
  /** Column name used as the canonical per-message timestamp. Null means use `_date_`. */
  timestampCol: string | null;

  /**
   * Forward-jump threshold in ms above which the gap check fires.
   * Null means the gap check is disabled for this table.
   */
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

export interface SourceFile {
  basePath:  string;
  tableName: string;
}

export interface FileGroup {
  /** YYYYMMDD day key. */
  day: string;
  /** Input file paths sorted alphabetically — sort order determines priority (first = highest). */
  paths: string[];
  /** Output path: <folder>/YYYYMMDD.merged.csv.gz */
  outputPath: string;
  /** Table name derived from the containing folder path. */
  tableName: string;
}

export interface MergeResult {
  written: number;
  warnings: string[];
  /** Lines written per source, indexed in the same order as the input paths. */
  sourceCounts: number[];
}

export interface RunOptions {
  scope: string | null;
  mode: RunMode;
}
