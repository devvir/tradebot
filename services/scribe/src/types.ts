// ── Configuration ─────────────────────────────────────────────────────────────

export interface Config {
  bitmexRestUrl: string;
  vaultUrl:      string;
  registryUrl:   string;
  startDate:     string | null;
  [key: string]: unknown;
}

export interface TableConfig {
  name:     string;
  path:     string;
  maxStart: number | null;
}
