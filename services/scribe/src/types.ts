// ── Configuration ─────────────────────────────────────────────────────────────

export interface Config {
  bitmexRestUrl:  string;
  vaultUrl:       string;
  registryUrl:    string;
  startDate:      string | null;
  indexTickOnly:  boolean;
  [key: string]: unknown;
}

export interface TableConfig {
  name:     string;
  path:     string;
  maxStart: number | null;
}
