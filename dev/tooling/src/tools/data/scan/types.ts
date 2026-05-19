import { TableOrigin } from './tables';

// ── Configuration ─────────────────────────────────────────────────────────────

export interface RemoteConfig {
  name: string;
  user: string;
  host: string;
  path: string;
}

export interface ScanConfig {
  localBase: string;
  remotes:   RemoteConfig[];
  megaVault: string;
  megaRaw:   string;
}

// ── State ─────────────────────────────────────────────────────────────────────

/**
 * Per-(table, day) state. Days with no data in any location are absent from
 * the parent table's `days` map.
 *
 * `.tmp` variants live next to their finalized counterparts: a complete
 * `localSuffixes` value coexists with the same suffix in `localTmpSuffixes`
 * only if a download was relaunched on top of an existing file (unusual).
 */
export interface DayState {
  day: string;                                  // YYYYMMDD

  /** WS source files present locally (no `.tmp`). */
  localSuffixes: string[];

  /** WS source files being downloaded locally (`.tmp`). */
  localTmpSuffixes: string[];

  /** WS source files present on each remote, keyed by remote name. */
  remoteSuffixes: Record<string, string[]>;

  /** WS source files being downloaded on each remote (`.tmp`). */
  remoteTmpSuffixes: Record<string, string[]>;

  /** WS source files present in `SOURCES_MEGA_RAW`. */
  megaSources: string[];

  /** True when a finalised local bucket exists for this day. */
  localBucket: boolean;

  /** Local bucket is `.tmp` (download in progress) — applies only to REST. */
  localBucketTmp: boolean;

  /** Bucket exists in `SOURCES_MEGA_VAULT`. */
  megaBucket: boolean;

  /**
   * Mongo import status, sourced from farmer's `farm:<table>:<date>` Redis key:
   *   - `done`    — farmer has confirmed every message of the bucket is stored
   *   - `partial` — farmer is mid-import (numeric counter present in Redis)
   *   - `absent`  — no Redis key (not imported, or never started)
   */
  database: 'done' | 'partial' | 'absent';
}

export interface TableState {
  name:     string;
  origin:   TableOrigin;
  days:     Map<string, DayState>;             // YYYYMMDD → DayState

  /** Years stored as `<table>/YYYY.tar` in Mega. Implies all days that year are archived. */
  megaTars: number[];
}

export interface VaultState {
  config:    ScanConfig;
  tables:    TableState[];
  scannedAt: Date;
}
