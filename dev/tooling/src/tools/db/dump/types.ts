// ─────────────────────────────────────────────────────────────────────────────
// db/dump/types.ts — every type and interface for the dump subcommand.
// Logic files import from here; never declare types inline in logic files.
// ─────────────────────────────────────────────────────────────────────────────

// ── runDump entry point ──────────────────────────────────────────────────────

export type DumpOptions = {
  out?: string;
};

// ── executeDump (write.ts) ───────────────────────────────────────────────────

export type ExecuteDumpOptions = {
  concurrency?: number;
};

// ── mongodump wrapper (mongodump.ts) ─────────────────────────────────────────

export type MongodumpProgress = {
  done: number;
};

export type MongodumpOptions = {
  uri:         string;
  database:    string;
  collection:  string;
  query?:      Record<string, unknown>;  // omit for whole collection
  archivePath: string;
  onProgress?: (p: MongodumpProgress) => void;
};

export type MongodumpResult = {
  documents: number;
  elapsedMs: number;
  bytes:     number;
};

// ── upload (upload.ts) ───────────────────────────────────────────────────────

export type PendingUpload = {
  collection: string;
  file:       string;       // sealed name, e.g. "2024.archive.gz"
  localPath:  string;       // absolute path
};

/** A successfully-uploaded archive whose local size doesn't match Mega's. */
export type UploadMismatch = {
  item:  PendingUpload;
  local: number;
  mega:  number | null;     // null = the file isn't on Mega at all (vanished post-upload)
};

/** Result of post-upload size verification against Mega. */
export type UploadVerification = {
  verified:   PendingUpload[];
  mismatched: UploadMismatch[];
};

