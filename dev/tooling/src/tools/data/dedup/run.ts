import fs from 'node:fs';
import path from 'node:path';
import { Writable } from 'node:stream';
import { createWriter } from '@devvir/zipper';
import { resolveCsvGzFiles } from '../discover';
import { getVaultColumns, KNOWN_TABLES } from '../tables';
import { write } from '../tasks/writer';
import { isDryRun } from '../options';
import { info, section, success, warn } from '../../../shared/ui/logger';
import { read } from './reader';
import { prune } from './prune';
import type { PruneStats } from './types';

/** Tables for which ghost-subscription dedup is meaningful. */
const DEDUP_TABLES = new Set(['instrument', 'orderBookL2']);

export async function runDedup(root: string, thresholdMs: number): Promise<void> {
  const files = resolveCsvGzFiles(root)
    .filter(f => isDedupCandidate(f, fs.existsSync));

  if (files.length === 0) {
    warn('No instrument or orderBookL2 .csv.gz files found.');

    return;
  }

  section(`Dedup — ${files.length} file(s), threshold ${thresholdMs}ms`);

  let totalKept    = 0;
  let totalDropped = 0;

  for (const file of files) {
    const tableName = tableNameFromPath(file);
    const columns   = getVaultColumns(tableName);

    if (! columns) {
      warn(`Skipping ${path.basename(file)} — unknown table "${tableName}"`);
      continue;
    }

    const timestampIdx = columns.indexOf('timestamp');

    if (timestampIdx === -1) {
      warn(`Skipping ${path.basename(file)} — no timestamp column in "${tableName}"`);
      continue;
    }

    const outPath = dedupOutputPath(file);
    const stats: PruneStats = { kept: 0, dropped: 0 };

    info(`${tableName}  ${path.basename(file)}`);

    await processFile(file, outPath, columns, thresholdMs, timestampIdx, stats);

    const total = stats.kept + stats.dropped;
    const pct   = total > 0 ? ((stats.dropped / total) * 100).toFixed(1) : '0.0';

    success(`  kept ${stats.kept.toLocaleString()}, dropped ${stats.dropped.toLocaleString()} (${pct}%)  →  ${path.basename(outPath)}`);

    totalKept    += stats.kept;
    totalDropped += stats.dropped;
  }

  if (files.length > 1) {
    const grandTotal = totalKept + totalDropped;
    const grandPct   = grandTotal > 0 ? ((totalDropped / grandTotal) * 100).toFixed(1) : '0.0';

    section(`Total — kept ${totalKept.toLocaleString()}, dropped ${totalDropped.toLocaleString()} (${grandPct}%)`);
  }
}

// ── Per-file pipeline ─────────────────────────────────────────────────────────

async function processFile(
  filePath:     string,
  outPath:      string,
  columns:      string[],
  thresholdMs:  number,
  timestampIdx: number,
  stats:        PruneStats,
): Promise<void> {
  const dryRun  = isDryRun();
  const tmpPath = outPath + '.tmp';

  const writer = dryRun ? null : createWriter(tmpPath);
  const stream: Writable = writer
    ? writer.stream()
    : new Writable({ write(_, __, cb) { cb(); } });

  stream.write(columns.join(',') + '\n');

  try {
    await write(prune(read(filePath), thresholdMs, stats, timestampIdx), stream);

    if (writer) {
      await writer.close();
      fs.renameSync(tmpPath, outPath);
    }
  } catch (err) {
    if (writer) {
      try { fs.unlinkSync(tmpPath); } catch { /* best effort */ }
    }

    throw err;
  }
}

// ── File selection ────────────────────────────────────────────────────────────

/**
 * A `.csv.gz` file is a dedup candidate when it belongs to a dedup-eligible
 * table, is not itself a `.dedup.csv.gz` output, and has not already been
 * deduped (no sibling output exists). `exists` is injected for testing.
 */
function isDedupCandidate(filePath: string, exists: (p: string) => boolean): boolean {
  if (! DEDUP_TABLES.has(tableNameFromPath(filePath))) return false;
  if (filePath.endsWith('.dedup.csv.gz'))              return false;
  if (exists(dedupOutputPath(filePath)))               return false;

  return true;
}

// ── Path helpers ──────────────────────────────────────────────────────────────

function dedupOutputPath(filePath: string): string {
  return filePath.replace(/\.csv\.gz$/, '.dedup.csv.gz');
}

function tableNameFromPath(filePath: string): string {
  const parts = filePath.split(path.sep);

  for (let i = parts.length - 1; i >= 0; i--) {
    if (KNOWN_TABLES.has(parts[i]!)) return parts[i]!;
  }

  return path.basename(path.dirname(filePath));
}

// ── Test exports ──────────────────────────────────────────────────────────────

export const _test_isDedupCandidate = isDedupCandidate;
