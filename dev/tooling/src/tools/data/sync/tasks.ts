import fs from 'node:fs';
import path from 'node:path';
import { ALL_TABLES } from '../scan/tables';
import { DayState, VaultState } from '../scan/types';
import {
  BackupBucketFile,
  BackupBucketTask,
  BackupSourceFile,
  BackupSourceTask,
  CleanRsyncTempsTask,
  CleanupFile,
  CleanupTask,
  PrepareGroup,
  PrepareTask,
  PullFile,
  PullTask,
  RsyncTemp,
  Task,
} from './types';

/** Days before this cutoff are already handled; the update command ignores them. */
const CUTOFF = '20260101';

/**
 * Whether to derive tasks against the *current* state (`live`) or the
 * predicted post-pipeline state (`planned`).
 *
 *   - `planned` — used once at startup to print the summary. Includes
 *     fromPull / fromPrepare files, treats `preparedDays` as already done.
 *     Counts reflect "if everything you're about to run succeeds".
 *   - `live` — used right before showing each task in the interactive loop
 *     (after a fresh local re-scan). No predictions: a file is in the task
 *     only if it actually exists on disk now. Skipped or stubbed prior tasks
 *     correctly drop their phantom outputs.
 */
export type DerivationMode = 'planned' | 'live';

/**
 * Derives the ordered task list from a `VaultState`.
 *
 * Pipeline order:
 *   1. pull           — fetch missing source files from each remote
 *   2. backup-source  — push local WS sources not yet in SOURCES_MEGA_RAW
 *   3. prepare        — sort/dedup local sources that have no bucket anywhere
 *   4. backup-bucket  — push local buckets not yet in SOURCES_MEGA_VAULT
 *   5. cleanup        — move completed sources to .trash
 *
 * Only days from 2026-01-01 onward are considered — earlier data is already
 * fully handled outside this script.
 */
export function deriveTasks(state: VaultState, mode: DerivationMode = 'live'): Task[] {
  const tasks: Task[] = [];

  for (const t of pullTasks(state))  tasks.push(t);

  const backupSource = backupSourceTask(state, mode);

  if (backupSource) tasks.push(backupSource);

  // Derive prepare first so backup-bucket can predict the buckets it'll get.
  const prepare      = prepareTask(state, mode);
  const preparedDays = mode === 'planned' ? collectPreparedDays(prepare) : new Set<string>();

  if (prepare) tasks.push(prepare);

  const backupBucket = backupBucketTask(state, preparedDays);

  if (backupBucket) tasks.push(backupBucket);

  const cleanup = cleanupTask(state, preparedDays);

  if (cleanup) tasks.push(cleanup);

  return tasks;
}

function collectPreparedDays(prepare: PrepareTask | null): Set<string> {
  const set = new Set<string>();

  if (! prepare) return set;

  for (const g of prepare.groups) {
    for (const d of g.days) set.add(`${g.table}/${d}`);
  }

  return set;
}

// ── Pull ──────────────────────────────────────────────────────────────────────

function pullTasks(state: VaultState): PullTask[] {
  const byRemote = new Map<string, PullFile[]>();
  const bucketedDaysByRemote = new Map<string, Set<string>>();   // remote → days with a local bucket

  for (const remote of state.config.remotes) {
    byRemote.set(remote.name, []);
    bucketedDaysByRemote.set(remote.name, new Set());
  }

  for (const table of state.tables) {
    if (table.origin !== 'ws') continue;

    for (const day of table.days.values()) {
      if (before(day))    continue;
      if (day.megaBucket) continue;

      for (const [remoteName, suffixes] of Object.entries(day.remoteSuffixes)) {
        const cfg = state.config.remotes.find(r => r.name === remoteName);

        if (! cfg) continue;

        for (const suffix of suffixes) {
          if (day.localSuffixes.includes(suffix)) continue;

          const year     = day.day.slice(0, 4);
          const filename = `${day.day}.${suffix}.csv.gz`;

          byRemote.get(remoteName)!.push({
            table:      table.name,
            year,
            day:        day.day,
            suffix,
            remotePath: `${cfg.user}@${cfg.host}:${cfg.path}/${table.name}/${year}/${filename}`,
            localPath:  path.join(state.config.localBase, table.name, year, filename),
          });

          // Flag if this day already has a local bucket — sources should have
          // been cleaned up or the bucket was created without this remote's data.
          if (day.localBucket) {
            bucketedDaysByRemote.get(remoteName)!.add(`${table.name}/${day.day}`);
          }
        }
      }
    }
  }

  const tasks: PullTask[] = [];

  for (const [remoteName, files] of byRemote) {
    if (files.length === 0) continue;

    const cfg         = state.config.remotes.find(r => r.name === remoteName)!;
    const bucketedN   = bucketedDaysByRemote.get(remoteName)!.size;
    const isAbnormal  = bucketedN > 0;
    const abnormalWarning = isAbnormal
      ? `${bucketedN} day${bucketedN === 1 ? '' : 's'} already have a local bucket — sources may not have been included when preparing, or cleanup was not completed`
      : '';

    files.sort(byTableThenDay);
    tasks.push({ kind: 'pull', remote: remoteName, user: cfg.user, host: cfg.host, files, isAbnormal, abnormalWarning });
  }

  return tasks;
}

// ── Backup sources ────────────────────────────────────────────────────────────

function backupSourceTask(state: VaultState, mode: DerivationMode): BackupSourceTask | null {
  const files: BackupSourceFile[] = [];
  const seen  = new Set<string>();

  for (const table of state.tables) {
    if (table.origin !== 'ws') continue;

    for (const day of table.days.values()) {
      if (before(day)) continue;

      const year     = day.day.slice(0, 4);
      const localSet = new Set(day.localSuffixes);

      // planned: include both current local + suffixes that pull will fetch.
      // live:    only what's actually on disk now.
      const candidates = mode === 'planned'
        ? new Set([...day.localSuffixes, ...Object.values(day.remoteSuffixes).flat()])
        : localSet;

      for (const suffix of candidates) {
        if (day.megaSources.includes(suffix)) continue;

        const key = `${table.name}/${day.day}/${suffix}`;

        if (seen.has(key)) continue;

        seen.add(key);

        const filename = `${day.day}.${suffix}.csv.gz`;
        const fromPull = mode === 'planned' && ! localSet.has(suffix);

        files.push({
          table:     table.name,
          year,
          day:       day.day,
          suffix,
          localPath: path.join(state.config.localBase, table.name, year, filename),
          megaPath:  `${state.config.megaRaw}/${table.name}/${year}/${filename}`,
          fromPull,
        });
      }
    }
  }

  if (files.length === 0) return null;

  files.sort(byTableThenDay);

  return { kind: 'backup-source', files, isAbnormal: false, abnormalWarning: '' };
}

// ── Prepare ───────────────────────────────────────────────────────────────────

function prepareTask(state: VaultState, mode: DerivationMode): PrepareTask | null {
  const expectedSuffixes = ['local', ...state.config.remotes.map(r => r.name)];
  const byTableYear = new Map<string, PrepareGroup>();

  for (const table of state.tables) {
    if (table.origin !== 'ws') continue;

    for (const day of table.days.values()) {
      if (before(day))        continue;
      if (day.localBucket)    continue;
      if (day.localBucketTmp) continue;   // bucket is actively being written
      if (day.megaBucket)     continue;

      // planned: count days that *will* have local sources after pull.
      // live:    only days with sources actually on disk now.
      const hasSources = mode === 'planned'
        ? day.localSuffixes.length > 0 || Object.values(day.remoteSuffixes).some(s => s.length > 0)
        : day.localSuffixes.length > 0;

      if (! hasSources) continue;

      const year = day.day.slice(0, 4);
      const key  = `${table.name}/${year}`;

      let group = byTableYear.get(key);

      if (! group) {
        group = { table: table.name, year, days: [], abnormalDays: [] };
        byTableYear.set(key, group);
      }

      if (! isSourceComplete(day, expectedSuffixes)) {
        group.abnormalDays.push(day.day);
      }

      group.days.push(day.day);
    }
  }

  if (byTableYear.size === 0) return null;

  const groups = [...byTableYear.values()];

  for (const g of groups) {
    g.days.sort();
    g.abnormalDays.sort();
  }

  groups.sort((a, b) => (
    a.table === b.table ? a.year.localeCompare(b.year) : a.table.localeCompare(b.table)
  ));

  const abnormalCount = groups.reduce((n, g) => n + g.abnormalDays.length, 0);
  const isAbnormal    = abnormalCount > 0;
  const abnormalWarning = isAbnormal
    ? `${abnormalCount} day${abnormalCount === 1 ? '' : 's'} are missing sources from one or more expected collectors — bucket may be incomplete`
    : '';

  return { kind: 'prepare', groups, isAbnormal, abnormalWarning };
}

/**
 * A day is source-complete when every expected suffix (local collector + each
 * configured remote) is present somewhere: already local, in a remote, or
 * already backed up in Mega raw.
 */
function isSourceComplete(day: DayState, expectedSuffixes: string[]): boolean {
  const available = new Set([
    ...day.localSuffixes,
    ...day.megaSources,
    ...Object.values(day.remoteSuffixes).flat(),
  ]);

  return expectedSuffixes.every(s => available.has(s));
}

// ── Backup buckets ────────────────────────────────────────────────────────────

function backupBucketTask(
  state:        VaultState,
  preparedDays: Set<string>,
): BackupBucketTask | null {
  const files: BackupBucketFile[] = [];

  for (const table of state.tables) {
    for (const day of table.days.values()) {
      if (before(day))        continue;
      if (day.megaBucket)     continue;
      if (day.localBucketTmp) continue;   // bucket is actively being written

      const hasLocalBucket = day.localBucket;
      const willBePrepared = preparedDays.has(`${table.name}/${day.day}`);

      if (! hasLocalBucket && ! willBePrepared) continue;

      const fromPrepare = willBePrepared && ! hasLocalBucket;
      const year        = day.day.slice(0, 4);
      const filename    = `${day.day}.csv.gz`;

      files.push({
        table:     table.name,
        year,
        day:       day.day,
        localPath: path.join(state.config.localBase, table.name, year, filename),
        megaPath:  `${state.config.megaVault}/${table.name}/${year}/${filename}`,
        fromPrepare,
      });
    }
  }

  if (files.length === 0) return null;

  files.sort(byTableThenDay);

  return { kind: 'backup-bucket', files, isAbnormal: false, abnormalWarning: '' };
}

// ── Cleanup ───────────────────────────────────────────────────────────────────

/**
 * Cleans up source files (local + remote) that have completed their journey.
 *
 * Eligibility uses **predicted post-pipeline state**: a day's bucket counts
 * as present if it's currently in local/Mega OR will be produced by the
 * prepare task. Files that aren't actually on disk at execution time are
 * skipped gracefully.
 *
 * - **Local sources** to trash: any suffix that will be local after pull
 *   (`localSuffixes ∪ remoteSuffixes[*]`) for a day whose bucket exists in
 *   local, Mega, or will be prepared.
 * - **Remote sources** to trash: every suffix on every configured remote —
 *   after the pipeline, the remote source is either already in local
 *   (pulled) or its bucket is in Mega.
 *
 * **Abnormal pattern** (uses current state, not predicted):
 * a remote source `(table, day, suffix)` is flagged when:
 *   1. A bucket already exists for `(table, day)` in local or Mega, AND
 *   2. Local has at least one source for this day, AND
 *   3. This remote's suffix is **not** among them.
 *
 * That asymmetry suggests the bucket was prepared without this remote's
 * contribution (or a partial cleanup ran earlier). The whole task is then
 * marked abnormal → warning, default N, skipped under `-y`.
 */
function cleanupTask(state: VaultState, preparedDays: Set<string>): CleanupTask | null {
  const files: CleanupFile[] = [];
  let abnormalCount = 0;

  // When called in 'planned' mode `preparedDays` has the days prepare will
  // produce; in 'live' mode the caller passes an empty set, which naturally
  // disables the post-prepare predictions below.
  const isPlanned = preparedDays.size > 0;

  for (const table of state.tables) {
    if (table.origin !== 'ws') continue;     // REST has no sources to clean up

    for (const day of table.days.values()) {
      if (before(day)) continue;

      const dayKey         = `${table.name}/${day.day}`;
      const bucketNow      = day.localBucket || day.megaBucket;
      const willHaveBucket = bucketNow || preparedDays.has(dayKey);

      if (! willHaveBucket) continue;        // no bucket → can't safely trash sources

      const year = day.day.slice(0, 4);

      // Local sources eligible to trash. planned: current local + pulled-from-remote.
      // live: only what's actually on disk now.
      const localSuffixes = isPlanned
        ? new Set([...day.localSuffixes, ...Object.values(day.remoteSuffixes).flat()])
        : new Set(day.localSuffixes);

      for (const suffix of localSuffixes) {
        const filename = `${day.day}.${suffix}.csv.gz`;

        files.push({
          location: 'local',
          table:    table.name,
          year,
          day:      day.day,
          suffix,
          absPath:  path.join(state.config.localBase, table.name, year, filename),
        });
      }

      // Remote sources to trash + abnormal detection.
      // planned: every remote source is fair game (post-pipeline either it'll
      // be pulled to local, or its bucket will be in Mega).
      // live: only remote sources whose corresponding local copy exists now
      // OR whose bucket already exists somewhere now.
      for (const [remoteName, suffixes] of Object.entries(day.remoteSuffixes)) {
        const cfg = state.config.remotes.find(r => r.name === remoteName);

        if (! cfg) continue;

        for (const suffix of suffixes) {
          const eligible = isPlanned
            || bucketNow
            || day.localSuffixes.includes(suffix);

          if (! eligible) continue;

          const filename  = `${day.day}.${suffix}.csv.gz`;
          const localPath = day.localSuffixes.includes(suffix)
            ? path.join(state.config.localBase, table.name, year, filename)
            : null;

          files.push({
            location:   'remote',
            remote:     remoteName,
            user:       cfg.user,
            host:       cfg.host,
            table:      table.name,
            year,
            day:        day.day,
            suffix,
            remotePath: `${cfg.path}/${table.name}/${year}/${filename}`,
            remoteBase: cfg.path,
            localPath,
          });

          // Abnormal pattern uses *current* state regardless of derivation mode.
          const localHasAnySource = day.localSuffixes.length > 0;

          if (bucketNow && localHasAnySource && ! day.localSuffixes.includes(suffix)) {
            abnormalCount++;
          }
        }
      }
    }
  }

  if (files.length === 0) return null;

  files.sort(byCleanupOrder);

  const isAbnormal      = abnormalCount > 0;
  const abnormalWarning = isAbnormal
    ? `${abnormalCount} remote source${abnormalCount === 1 ? '' : 's'} would be trashed while a bucket already exists and the matching local copy is missing — the bucket may have been prepared without this contribution`
    : '';

  return { kind: 'cleanup', files, isAbnormal, abnormalWarning };
}

function byCleanupOrder(a: CleanupFile, b: CleanupFile): number {
  if (a.location !== b.location) return a.location === 'local' ? -1 : 1;
  if (a.table    !== b.table)    return a.table.localeCompare(b.table);
  if (a.day      !== b.day)      return a.day.localeCompare(b.day);

  return a.suffix.localeCompare(b.suffix);
}

// ── Rsync temp detection ──────────────────────────────────────────────────────

/**
 * Rsync pattern: `.ORIGINAL_FILENAME.XXXXXX` (leading dot, random alphanum suffix).
 * Example: `.20260512.mtav.csv.gz.TSAnTK`
 */
const RSYNC_TEMP_RE = /^\.\d{8}(?:\.[A-Za-z0-9_-]+)?\.csv\.gz\.[A-Za-z0-9]+$/;

/**
 * Walks the local vault and returns a task to delete any leftover rsync temp
 * files. These are created when rsync is interrupted mid-transfer. Returns
 * `null` when there are none.
 */
export function findRsyncTemps(localBase: string): CleanRsyncTempsTask | null {
  const files: RsyncTemp[] = [];

  for (const { name: table } of ALL_TABLES) {
    const tableDir = path.join(localBase, table);

    if (! dirExists(tableDir)) continue;

    for (const year of listYearDirs(tableDir)) {
      const yearDir = path.join(tableDir, year);

      for (const filename of fs.readdirSync(yearDir)) {
        if (! RSYNC_TEMP_RE.test(filename)) continue;

        files.push({ table, year, absPath: path.join(yearDir, filename), filename });
      }
    }
  }

  if (files.length === 0) return null;

  return { kind: 'clean-rsync-temps', files, isAbnormal: false, abnormalWarning: '' };
}

function dirExists(p: string): boolean {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}

function listYearDirs(tableDir: string): string[] {
  return fs.readdirSync(tableDir, { withFileTypes: true })
    .filter(e => e.isDirectory() && /^\d{4}$/.test(e.name))
    .map(e => e.name);
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function before(day: DayState): boolean {
  return day.day < CUTOFF;
}

function byTableThenDay(
  a: { table: string; day: string },
  b: { table: string; day: string },
): number {
  return a.table === b.table ? a.day.localeCompare(b.day) : a.table.localeCompare(b.table);
}
