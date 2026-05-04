/**
 * Types for the `sources prepare` pipeline.
 *
 * READ is the boundary where untyped CSV bytes become typed `PreparedMessage`
 * objects. Everything downstream relies on these types without defensive
 * casts — no `any`, no `unknown`.
 */

export type Action = 'partial' | 'insert' | 'update' | 'delete';

export const ACTIONS: ReadonlySet<Action> = new Set<Action>([
  'partial',
  'insert',
  'update',
  'delete',
]);

/**
 * One BitMEX WS message after parsing, validation, and pipeline annotation.
 *
 * `rows[0]` is the message-start row (`_date_` non-empty); subsequent entries
 * are continuation rows (multi-row payloads such as `insert` of a snapshot).
 *
 * Computed fields (set once by READ, never recomputed downstream):
 *  - `ts`   : canonical sort key — `timestamp.slice(0,23)` if non-empty, else
 *             `date.slice(0,23)`. Length-23 absorbs legacy 8-or-9-digit
 *             precision; SORT and DEDUP compare strings, no Date calls.
 *  - `tsMs` : `ts` as epoch ms, computed once via `Date.UTC()`. Used only by
 *             MERGE for gap arithmetic.
 */
export interface PreparedMessage {
  rows:      Record<string, string>[];
  date:      string;
  action:    Action;
  timestamp: string;

  ts:   string;
  tsMs: number;
}

// ── Prepare discovery ─────────────────────────────────────────────────────────

export interface PrepareGroup {
  day:        string;       // YYYYMMDD
  folder:     string;       // raw source folder
  tableName:  string;
  paths:      string[];     // raw source files in priority (alphabetical) order
  outputDir:  string;       // <folder>/prepared
  outputName: string;       // <day>.csv.gz
}

/**
 * Per-group log file. One file per processed day, written next to the output
 * (or under `--log <dir>` if specified).
 *
 * Contents are intentionally a flat plaintext format — this file is read by
 * humans reviewing a prepare run, not by other tools.
 */
export interface GroupLogData {
  written:       number;
  overflowed:    number;
  overflowByDay: Map<string, number>;
  dedupDrops:    number;
  issues:        ReadIssue[];
  error?:        string;
}

/** Sanity-check failure reason — emitted by READ when discarding a message. */
export interface ReadIssue {
  reason: string;
  date:   string;   // best-effort; '' when the row that failed had no parseable date
}
