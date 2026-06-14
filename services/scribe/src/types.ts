import type { RedisClient } from '@devvir/service-kit';
import type { Row } from './bitmex/types';

// ── Configuration ─────────────────────────────────────────────────────────────

export interface Config {
  bitmexRestUrl:  string;
  vaultUrl:       string;
  startDate:      string | null;
  indexTickOnly:  boolean;
  tables:         string[];
  [key: string]: unknown;
}

/**
 * Resolves a table's per-symbol subtasks. Present → the runner fans the table
 * out into one subtask per returned symbol; absent → a single default task with
 * no symbol filter. The symbol list is computed at runtime (fetched from BitMEX,
 * stable-ordered), which is why this is a function rather than a static list.
 */
export type SymbolResolver = (cache: RedisClient, baseUrl: string) => Promise<string[]>;

/** Post-fetch row predicate: keep the row when true, drop it when false. */
export type RowFilter = (row: Row) => boolean;

export interface TableConfig {
  name:     string;
  path:     string;
  maxStart: number | null;
  count: number;
  filter?:  Record<string, unknown>;
  /**
   * Per-symbol subtask resolver (see {@link SymbolResolver}). Tables without it
   * run as a single task over all symbols.
   */
  symbols?: SymbolResolver;
  /**
   * Post-fetch row filter for conditions BitMEX can't express server-side (e.g.
   * `size != 0` to drop referential trades). Applied per row as it streams.
   */
  keep?:    RowFilter;
  /**
   * Hard lower bound (yyyymmdd) on the first date to collect, combined with the
   * global `startDate`. Floors the initial position only — once progress passes
   * it, the saved cursor resumes forward. Used to start a table partway through
   * history (e.g. trade/quote from 2026-04-01, with earlier days owned by S3).
   */
  from?:    string;
  /**
   * The field BitMEX sorts and filters startTime/endTime on for this table —
   * `logged` (insertion time) for tables that set it, unset (→ `timestamp`)
   * otherwise. Pagination, the block re-anchor and the day cut all key off it;
   * any other time field is inert metadata.
   */
  tsField?: string;
}
