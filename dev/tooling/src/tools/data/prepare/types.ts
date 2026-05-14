export type Action = 'partial' | 'insert' | 'update' | 'delete' | `partial:${string}`;

export const ACTIONS: ReadonlySet<string> = new Set([
  'partial',
  'insert',
  'update',
  'delete',
]);

/** True for plain `partial` and filtered `partial:<symbol>` actions. */
export function isPartialAction(action: string): boolean {
  return action === 'partial' || action.startsWith('partial:');
}

/**
 * One BitMEX WS message after parsing and validation. `rows[0]` is the
 * message-start row (non-empty `_date_`); later entries are continuation
 * rows. `ts` is the canonical sort key: `(timestamp || _date_).slice(0, 23)`.
 * `tsMs` is `ts` as epoch ms.
 */
export interface PreparedMessage {
  rows:      string[];
  date:      string;
  action:    Action;
  timestamp: string | null;

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

export interface GroupLogData {
  written:    number;
  dedupDrops: number;
  issues:     ReadIssue[];
  error?:     string;
}

/** Sanity-check failure emitted by READ when discarding a message. */
export interface ReadIssue {
  reason: string;
  date:   string;   // best-effort; '' when the row had no parseable date
}

export interface CommandLogData {
  readCounts:    number[];
  mergeContribs: number[];
  dedupDrops:    number;
  dropsByAction: Map<string, number>;
  outputBytes:   number;
  issues:        ReadIssue[];
  error?:        string;
}

export interface DedupStore {
  /** Returns true if `msg` is a duplicate and should be dropped. */
  isDuplicate(msg: PreparedMessage): boolean;
}

export interface DedupConfig {
  updateWindow: number | null;   // ms time constraint for updates; null = no constraint
  globalLimit:  number;          // insert/delete store size; Infinity = unbounded
  updateLimit?: number;          // update store size; defaults to globalLimit when omitted
}

export interface DedupHandler {
  isDuplicate(msg: PreparedMessage): boolean;
}

export interface KeyStore {
  /** Record `key` (and its `ts`) as seen. */
  store(key: string, ts: number): void;
  /** True if `key` was seen and, if `minTs` is provided, its stored ts >= minTs. */
  check(key: string, minTs?: number): boolean;
}

// ── Sorter ────────────────────────────────────────────────────────────────────

export interface Sorter {
  /** Push a batch; returns any minute-buckets evicted by the size limit, in eviction order. */
  push(messages: PreparedMessage[]): PreparedMessage[][];
  /** Drain all remaining buckets in chronological key order. */
  flush(): PreparedMessage[][];
  /** Total messages currently buffered across all buckets. */
  size(): number;
}

export interface SortBucket {
  items:    PreparedMessage[];
  isSorted: boolean;
  lastTs:   string;
}

// ── Reader ────────────────────────────────────────────────────────────────────

export type RecordResult =
  | { ok: true;  line: string }
  | { ok: false; isStart: boolean; issue: ReadIssue };

// ── Stats / orchestration ─────────────────────────────────────────────────────

export interface StatsCollector {
  readonly issues:        ReadIssue[];
  readonly dropped:       { count: number };
  readonly dropsByAction: Map<string, number>;
  readonly readCounts:    number[];
  readonly mergeContribs: number[];

  onIssue:             (issue: ReadIssue) => void;
  onDrop:              (msg: PreparedMessage) => void;
  recordRead:          (sourceIndex: number, count: number) => void;
  recordMergeContribs: (contribs: number[]) => void;
}

export type PreflightDecision =
  | { outcome: 'processed' | 'skipped' }
  | { proceed: { tmpPath: string; finalPath: string; inputBytes: number } };
