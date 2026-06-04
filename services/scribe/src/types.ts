// ── Configuration ─────────────────────────────────────────────────────────────

export interface Config {
  bitmexRestUrl:  string;
  vaultUrl:       string;
  startDate:      string | null;
  indexTickOnly:  boolean;
  tables:         string[];
  [key: string]: unknown;
}

export interface TableConfig {
  name:     string;
  path:     string;
  maxStart: number | null;
  count: number;
  filter?:  Record<string, unknown>;
  /**
   * The field BitMEX sorts and filters startTime/endTime on for this table —
   * `logged` (insertion time) for compositeIndex, unset (→ `timestamp`)
   * otherwise. Pagination, the block re-anchor and the day cut all key off it;
   * any other time field is inert metadata.
   */
  tsField?: string;
}
