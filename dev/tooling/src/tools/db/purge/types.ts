// ─────────────────────────────────────────────────────────────────────────────
// db/purge/types.ts — every type and interface for the purge subcommand.
// ─────────────────────────────────────────────────────────────────────────────

export type PurgeOutcome = {
  collection: string;
  period:     string;
  deleted:    number;
  elapsedMs:  number;
  error?:     string;
};
