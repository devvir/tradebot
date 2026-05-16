// ── Abnormal flag (shared by all tasks) ───────────────────────────────────────

/**
 * Any task can be flagged as abnormal. When set:
 *   - A warning is printed before the prompt.
 *   - The prompt defaults to N instead of Y.
 *   - The task is skipped (with a warning) when `-y` / `--yes` is active.
 */
export interface AbnormalFlag {
  isAbnormal:      boolean;
  abnormalWarning: string;   // shown to the user; ignored when isAbnormal is false
}

// ── Clean rsync temps ─────────────────────────────────────────────────────────

export interface RsyncTemp {
  table:    string;
  year:     string;
  absPath:  string;
  filename: string;
}

export interface CleanRsyncTempsTask extends AbnormalFlag {
  kind:  'clean-rsync-temps';
  files: RsyncTemp[];
}

// ── Pull ──────────────────────────────────────────────────────────────────────

export interface PullFile {
  table:      string;
  year:       string;
  day:        string;
  suffix:     string;
  remotePath: string;             // <user>@<host>:<path>/<table>/<year>/<file>
  localPath:  string;
}

export interface PullTask extends AbnormalFlag {
  kind:   'pull';
  remote: string;                 // remote name (e.g. "mtav")
  user:   string;
  host:   string;
  files:  PullFile[];
}

// ── Prepare ───────────────────────────────────────────────────────────────────

export interface PrepareGroup {
  table:        string;
  year:         string;
  days:         string[];          // YYYYMMDD, sorted
  abnormalDays: string[];          // days missing at least one expected source suffix
}

export interface PrepareTask extends AbnormalFlag {
  kind:   'prepare';
  groups: PrepareGroup[];
}

// ── Backup ────────────────────────────────────────────────────────────────────

export interface BackupSourceFile {
  table:     string;
  year:      string;
  day:       string;
  suffix:    string;
  localPath: string;
  megaPath:  string;
  /** True when the file isn't local yet — it'll arrive via the pull task. */
  fromPull:  boolean;
}

export interface BackupBucketFile {
  table:     string;
  year:      string;
  day:       string;
  localPath: string;
  megaPath:  string;
  /** True when the bucket doesn't exist yet — it'll be created by the prepare task. */
  fromPrepare: boolean;
}

export interface BackupSourceTask extends AbnormalFlag {
  kind:  'backup-source';
  files: BackupSourceFile[];
}

export interface BackupBucketTask extends AbnormalFlag {
  kind:  'backup-bucket';
  files: BackupBucketFile[];
}

// ── Cleanup ───────────────────────────────────────────────────────────────────

export interface CleanupLocalFile {
  location: 'local';
  table:    string;
  year:     string;
  day:      string;
  suffix:   string;
  absPath:  string;
}

export interface CleanupRemoteFile {
  location:   'remote';
  remote:     string;       // remote name
  user:       string;
  host:       string;
  table:      string;
  year:       string;
  day:        string;
  suffix:     string;
  remotePath: string;       // absolute path on remote
  remoteBase: string;       // remote vault root — used to derive .trash path
  /** Absolute local path of the pulled counterpart, or null when not on disk. */
  localPath:  string | null;
}

export type CleanupFile = CleanupLocalFile | CleanupRemoteFile;

export interface CleanupTask extends AbnormalFlag {
  kind:  'cleanup';
  files: CleanupFile[];
}

// ── Delete local buckets ──────────────────────────────────────────────────────

export interface DeleteLocalBucketsRange {
  table: string;
  year:  string;
  days:  string[];   // YYYYMMDD, sorted
}

/**
 * A range that has a local bucket AND a Mega bucket — the local copy can
 * be deleted. Never auto-run under -y; always requires per-range confirmation.
 */
export interface DeleteLocalBucketsTask extends AbnormalFlag {
  kind:   'delete-local-buckets';
  ranges: DeleteLocalBucketsRange[];
}

// ── Union ─────────────────────────────────────────────────────────────────────

export type Task =
  | CleanRsyncTempsTask
  | PullTask
  | PrepareTask
  | BackupSourceTask
  | BackupBucketTask
  | CleanupTask
  | DeleteLocalBucketsTask;
