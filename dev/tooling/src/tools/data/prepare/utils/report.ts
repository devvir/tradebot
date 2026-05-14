import path from 'node:path';
import fs from 'node:fs';
import { getActiveBackend } from '@devvir/zipper';
import { error, info, log, logLines, section, spacer, success, warn, writeBucketLog } from '../../log';
import { fromDay, isDryRun } from '../../options';
import type { CommandLogData, GroupLogData, PrepareGroup, ReadIssue, StatsCollector } from '../types';

const ISSUE_SAMPLE_LIMIT = 50;

// ── Stats collector ──────────────────────────────────────────────────────────

export function createStatsCollector(group: PrepareGroup): StatsCollector {
  const issues:        ReadIssue[]         = [];
  const dropped                            = { count: 0 };
  const dropsByAction: Map<string, number> = new Map();
  const readCounts:    number[]            = group.paths.map(() => 0);
  const mergeContribs: number[]            = group.paths.map(() => 0);

  return {
    issues,
    dropped,
    dropsByAction,
    readCounts,
    mergeContribs,

    onIssue: (issue) => { issues.push(issue); },

    onDrop: (msg) => {
      dropped.count++;
      dropsByAction.set(msg.action, (dropsByAction.get(msg.action) ?? 0) + 1);
    },

    recordRead: (i, count) => { readCounts[i] = count; },

    recordMergeContribs: (contribs) => {
      contribs.forEach((n, i) => { mergeContribs[i] = n; });
    },
  };
}

// ── Run-level reports ────────────────────────────────────────────────────────

export function reportNoSourcesFound(root: string): void {
  warn(`No .csv.gz files found under: ${root}`);
}

/**
 * One-time startup banners for the run (dry-run plan, "from" cutoff). Shown
 * before any group is processed.
 */
export function reportPreFlight(): void {
  const backend = getActiveBackend();

  info(`Compression: ${backend}`);
  log(`Compression: ${backend}`);

  if (isDryRun()) {
    section('Dry-run plan');
    spacer();
  }

  if (fromDay()) {
    info(`From: ${fromDay()} (days before this are skipped)`);
    spacer();
  }
}

export function reportRunSummary(totals: { processed: number; skipped: number; failed: number }): void {
  spacer();

  if (totals.failed > 0) {
    error(`Done. Processed: ${totals.processed}. Skipped: ${totals.skipped}. Failed: ${totals.failed}.`);
  } else {
    info(`Done. Processed: ${totals.processed}. Skipped: ${totals.skipped}.`);
  }
}

// ── Group-level reports ──────────────────────────────────────────────────────

export function reportGroupStart(group: PrepareGroup): void {
  section(`${group.day}  (${group.tableName})`);
  spacer();
}

export function reportSources(group: PrepareGroup): void {
  info(`Sources (${group.paths.length}):`);

  for (const p of group.paths) {
    info(`  ${path.basename(p)}`);
  }

  spacer();
}

export function reportSkippedAlready(finalPath: string): void {
  info(`Skipped (already prepared): ${finalPath}`);
  spacer();
}

export function reportSkippedInProgress(tmpPath: string): void {
  warn(`Skipped (in-progress or crashed): ${tmpPath}`);
  spacer();
}

export function reportDryRunTarget(finalPath: string): void {
  info(`Would write: ${finalPath}`);
  spacer();
}

export function reportProcessing(group: PrepareGroup, inputBytes: number): void {
  log(`Processing ${group.tableName}/${group.day} (${formatBytes(inputBytes)})...`);
}

// ── Group outcome reports (terminal + log files combined) ────────────────────

/**
 * Success path: terminal "Written: N → path" plus dedup/validation drop
 * counts, plus the per-group log file and global command-log entry.
 */
export function recordGroupResult(
  group:     PrepareGroup,
  stats:     StatsCollector,
  finalPath: string,
  written:   number,
): void {
  success(`Written: ${written.toLocaleString()} → ${finalPath}`);

  if (stats.dropped.count > 0) info(`Dedup drops: ${stats.dropped.count.toLocaleString()}`);
  if (stats.issues.length > 0) warn(`Validation drops: ${stats.issues.length.toLocaleString()} (logged)`);

  writeGroupLog(group, {
    written,
    dedupDrops: stats.dropped.count,
    issues:     stats.issues,
  });

  writeCommandLog(group, {
    readCounts:    stats.readCounts,
    mergeContribs: stats.mergeContribs,
    dedupDrops:    stats.dropped.count,
    dropsByAction: stats.dropsByAction,
    outputBytes:   fs.existsSync(finalPath) ? fs.statSync(finalPath).size : 0,
    issues:        stats.issues,
  });

  spacer();
}

/**
 * Failure path: terminal `FAILED <day> (<table>): <msg>`, plus per-group log
 * and global command-log entry both annotated with the error.
 */
export function recordGroupFailure(
  group:  PrepareGroup,
  stats:  StatsCollector,
  errMsg: string,
): void {
  error(`FAILED ${group.day} (${group.tableName}): ${errMsg}`);

  writeGroupLog(group, {
    written:    0,
    dedupDrops: stats.dropped.count,
    issues:     stats.issues,
    error:      errMsg,
  });

  writeCommandLog(group, {
    readCounts:    stats.readCounts,
    mergeContribs: stats.mergeContribs,
    dedupDrops:    stats.dropped.count,
    dropsByAction: stats.dropsByAction,
    outputBytes:   0,
    issues:        stats.issues,
    error:         errMsg,
  });

  spacer();
}

// ── Internal: log file writers ───────────────────────────────────────────────

/**
 * Per-group log file `<day>.log` written next to the prepared output.
 * Sources, written count, dedup drops, and a sample of validation drops.
 */
function writeGroupLog(group: PrepareGroup, data: GroupLogData): string | null {
  const lines: string[] = [
    `Day:    ${group.day}`,
    `Table:  ${group.tableName}`,
    `Folder: ${group.folder}`,
    '',
    'Sources:',
    ...group.paths.map(p => `  ${p}`),
    '',
  ];

  if (data.error) {
    lines.push(`FAILED: ${data.error}`, '');
  }

  lines.push(
    `Written:     ${data.written.toLocaleString()}`,
    `Dedup drops: ${data.dedupDrops.toLocaleString()}`,
  );

  if (data.issues.length > 0) {
    lines.push('', `Validation drops (${data.issues.length}):`);

    for (const issue of data.issues.slice(0, ISSUE_SAMPLE_LIMIT)) {
      lines.push(`  [${issue.date || '(no date)'}] ${issue.reason}`);
    }

    if (data.issues.length > ISSUE_SAMPLE_LIMIT) {
      lines.push(`  … ${(data.issues.length - ISSUE_SAMPLE_LIMIT).toLocaleString()} more`);
    }
  }

  return writeBucketLog(`${group.day}.log`, group.outputDir, lines);
}

/**
 * Per-group section appended to the global `prepare.log`. Per-source read
 * counts, merge contributions, dedup drops by action, and any READ
 * validation issues.
 */
function writeCommandLog(group: PrepareGroup, data: CommandLogData): void {
  const lines: string[] = [
    `=== ${group.day}  (${group.tableName}) ===`,
    '',
  ];

  if (data.error) {
    lines.push(`FAILED: ${data.error}`, '');
  }

  lines.push(`Output: ${(data.outputBytes / 1_048_576).toFixed(2)} MB`, '');

  // Per-source reads
  lines.push('Sources read:');

  for (let i = 0; i < group.paths.length; i++) {
    const name  = path.basename(group.paths[i]!);
    const count = (data.readCounts[i] ?? 0).toLocaleString();

    lines.push(`  ${name}: ${count}`);
  }

  lines.push('');

  // Per-source merge contributions (only meaningful with >1 source)
  if (group.paths.length > 1) {
    lines.push('Merge contributions:');

    for (let i = 0; i < group.paths.length; i++) {
      const name  = path.basename(group.paths[i]!);
      const count = (data.mergeContribs[i] ?? 0).toLocaleString();

      lines.push(`  ${name}: ${count}`);
    }

    lines.push('');
  }

  // Dedup drops by action
  if (data.dedupDrops > 0) {
    lines.push(`Dedup drops: ${data.dedupDrops.toLocaleString()}`);

    for (const action of ['partial', 'insert', 'update', 'delete'] as const) {
      const n = data.dropsByAction.get(action);

      if (n) lines.push(`  ${action}: ${n.toLocaleString()}`);
    }

    lines.push('');
  }

  // All malformatted rows
  if (data.issues.length > 0) {
    lines.push(`Malformatted rows dropped (${data.issues.length.toLocaleString()}):`);

    for (const issue of data.issues) {
      lines.push(`  [${issue.date || '(no date)'}] ${issue.reason}`);
    }

    lines.push('');
  }

  logLines(lines);
}

// ── Internal: formatters ─────────────────────────────────────────────────────

function formatBytes(bytes: number): string {
  if (bytes < 1_024)             return `${bytes} B`;
  if (bytes < 1_048_576)         return `${(bytes / 1_024).toFixed(1)} KB`;
  if (bytes < 1_073_741_824)     return `${(bytes / 1_048_576).toFixed(1)} MB`;

  return `${(bytes / 1_073_741_824).toFixed(2)} GB`;
}
