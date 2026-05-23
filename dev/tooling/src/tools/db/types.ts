// ─────────────────────────────────────────────────────────────────────────────
// db/types.ts — every type and interface shared across db subcommands.
// Subcommand-specific types live in db/<subcommand>/types.ts; logic files
// import from one or the other (never declare types inline).
// `pairKey` / `pairFilename` live here because they're tightly coupled to
// the Pair type.
// ─────────────────────────────────────────────────────────────────────────────

// ── Date ranges ──────────────────────────────────────────────────────────────

export type DateRange = {
  label:   string;   // human form, e.g. "2026", "2025-04", "2024-03-15"
  key:     string;   // dashless form, e.g. "2026", "202504", "20240315" — used in filenames
  startId: number;   // inclusive _id lower bound
  endId:   number;   // exclusive _id upper bound
};

// ── Pairs (collection × date range) ──────────────────────────────────────────

/** A single (collection, date-range) target. `date: null` means no date filter. */
export type Pair = {
  collection: string;
  date:       DateRange | null;
};

/** A `Pair` after counting + avgObjSize lookup; what the plan table renders. */
export type PlanRow = Pair & {
  count:      number;
  avgObjSize: number;
};

/** Whether a pair's canonical file is present locally and/or on Mega. */
export type ExistingStatus = {
  local: boolean;
  mega:  boolean;
};

// ── File sync state (local ↔ Mega) ───────────────────────────────────────────

/** Location and size of a file on one side (local FS or Mega). */
export type FileMeta = {
  path: string;
  size: number;
};

/**
 * Sync state of a single archive file across local FS and Mega.
 * Built by `utils/sync.ts:syncStatesForCollections`. Either side can be null
 * when the file only exists on the other.
 */
export type SyncState = {
  collection: string;
  file:       string;            // full filename, e.g. "2024.archive.gz"
  local:      FileMeta | null;
  mega:       FileMeta | null;
};

// ── Arg parser ───────────────────────────────────────────────────────────────

export type ParsedArgs = {
  dates:          DateRange[];
  rawCollections: string[];
  useAll:         boolean;
};

// ── Counting ─────────────────────────────────────────────────────────────────

export type CountOptions = {
  /** Force an accurate `countDocuments` scan, skipping the size-based fast paths. */
  exact?: boolean;
};

// ── Plan rendering ───────────────────────────────────────────────────────────

export type GatherOptions = {
  /** Force accurate counts via `countDocuments` (no metadata or PK-seek shortcuts). */
  exact?: boolean;
};

export type PlanLines = {
  header: string;
  sep:    string;
  rows:   string[];
  total:  string;
};

// ── Stats ────────────────────────────────────────────────────────────────────

export type StatsOptions = {
  /** Force `countDocuments` everywhere instead of metadata/PK-seek approximations. */
  exact?: boolean;
};

export type CollectionInfo = {
  name:           string;
  count:          number;
  avgObjSize:     number;
  dataSize:       number;
  storageSize:    number;
  totalIndexSize: number;
  nindexes:       number;
};

export type CollectionInfoColumn = {
  header: string;
  align:  'left' | 'right';
  get:    (r: CollectionInfo) => string;
};

// ── Progress block (progress-block.ts internal state) ───────────────────────

export type ActiveEntry = {
  idx:   number;
  row:   PlanRow;
  done:  number;
  start: number;
};

// ── Helpers (functions, kept here because they're tightly coupled to types) ──

/** Stable string key for a `Pair` — use as Map/Set key. */
export function pairKey(pair: Pair): string {
  return `${pair.collection}|${pair.date?.key ?? 'all'}`;
}

/** Filename used both locally and on Mega for a pair. mongodump archive. */
export function pairFilename(pair: Pair): string {
  return `${pair.date?.key ?? 'all'}.archive.gz`;
}
