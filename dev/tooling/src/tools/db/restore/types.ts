// ─────────────────────────────────────────────────────────────────────────────
// db/restore/types.ts — every type and interface for the restore subcommand.
// ─────────────────────────────────────────────────────────────────────────────

// ── Discovery ────────────────────────────────────────────────────────────────

import type { FileMeta } from '../types';

/**
 * One restorable archive. Discovery resolves args + collection-level listing
 * into a flat list of targets; each has the same `<key>.archive.gz` filename
 * with whichever sources are present.
 */
export type RestoreTarget = {
  collection: string;
  key:        string;             // "2024", "202403", "20240315", or "all"
  filename:   string;             // e.g. "2024.archive.gz"
  local:      FileMeta | null;
  mega:       FileMeta | null;
};

/**
 * A coarser-than-finer overlap inside one collection — e.g. `2024` coexisting
 * with `202403`. Discovered before execution; aborts the restore on detection.
 */
export type OverlapConflict = {
  collection: string;
  broader:    string;   // "2024" or "all"
  narrower:   string;   // "202403", "20240315", etc.
};

// ── mongorestore ─────────────────────────────────────────────────────────────

export type MongoRestoreProgress = {
  done: number;
};

export type MongoRestoreOptions = {
  uri:         string;
  archivePath: string;
  nsFrom?:     string;   // remap source namespace, e.g. "tradebot.*"
  nsTo?:       string;   // remap destination namespace, e.g. "tradebot_oldrun.*"
  onProgress?: (p: MongoRestoreProgress) => void;
  logPath?:    string;   // where to write mongorestore's non-progress stderr
};

export type MongoRestoreResult = {
  documents: number;
  elapsedMs: number;
};

// ── Disk space pre-flight ────────────────────────────────────────────────────

/**
 * Result of comparing free disk space at the destination against the bytes
 * we'd need to download from Mega. Values:
 *
 *   - `reject`              — ratio < 1, can't even hold the downloads
 *   - `download-only-offer` — ratio < 2, no headroom for the restore step;
 *                             offer to download only and stop
 *   - `warn-then-proceed`   — ratio < 3, might be tight; warn and continue
 *   - `proceed`             — ratio ≥ 3 (or nothing to download); go ahead
 */
export type SpaceMode = 'reject' | 'download-only-offer' | 'warn-then-proceed' | 'proceed';

// ── dump.log stats ───────────────────────────────────────────────────────────

/**
 * Per-archive figures recovered from `dump.log` (the plan table the dump step
 * appends per run). `bytes` is the uncompressed BSON size (`docs × avgObjSize`),
 * which is exactly the unit mongorestore reports as progress — so it serves as
 * an accurate restore-progress denominator without scanning the archive.
 */
export type DumpStat = {
  docs:  number;
  bytes: number;
};

// ── Execution ────────────────────────────────────────────────────────────────

export type ExecuteRestoreOptions = {
  concurrency?: number;
  nsFrom?:      string;   // namespace remap applied to every restored archive
  nsTo?:        string;
  dumpStats?:   Map<string, DumpStat>;   // keyed `${collection}|${key}` (dashless period)
};

export type RestoreOutcome = {
  collection: string;
  key:        string;
  documents?: number;
  elapsedMs:  number;
  error?:     string;
};
