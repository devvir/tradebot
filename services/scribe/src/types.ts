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
}
