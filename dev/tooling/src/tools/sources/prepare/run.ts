import fs from 'node:fs';
import path from 'node:path';
import { error, info, success, section, spacer, warn, openDebugLog, closeDebugLog } from '../log';
import { collectLeafFolders } from '../discover';
import { isDryRun, fromDay, logPath } from '../options';
import { createGzipWriter } from '../writer';
import { createOverflow, type Overflow } from './overflow';
import { dedup } from './tasks/deduper';
import { writeOutputHeader } from './tasks/header';
import { merge } from './tasks/merger';
import { createSourceActor } from './tasks/sorter';
import { write } from './tasks/writer';
import { discoverGroups } from './utils/discover';
import { writeGroupLog } from './utils/log';
import type { PrepareGroup, ReadIssue } from './types';

/**
 * `sources prepare` orchestrator.
 *
 * Composes the per-table pipeline declared in `config.ts` over the groups
 * returned by `discover.ts`, then writes outputs and logs. Every other file
 * in this directory is independently testable; this one wires them together.
 */
export async function runPrepare(root: string): Promise<void> {
  if (! fs.existsSync(root)) {
    error(`Path does not exist: ${root}`);
    process.exit(1);
  }

  const leafFolders = collectLeafFolders(root);

  if (leafFolders.length === 0) {
    warn(`No .csv.gz files found under: ${root}`);

    return;
  }

  const logDir = logPath();

  if (logDir && process.env.LOG_LEVEL === 'debug') {
    fs.mkdirSync(logDir, { recursive: true });
    openDebugLog(path.join(logDir, 'debug.log'));
  }

  if (isDryRun())  { section('Dry-run plan'); spacer(); }
  if (fromDay())   { info(`From: ${fromDay()} (days before this are skipped)`); spacer(); }

  let processed = 0;
  let skipped   = 0;
  let failed    = 0;

  try {
    for (const leaf of leafFolders) {
      const groups = discoverGroups(leaf);

      if (groups.length === 0) {
        continue;
      }

      if (leafFolders.length > 1) {
        section(leaf);
        spacer();
      }

      for (const group of groups) {
        const result = await processGroup(group);

        if (result === 'processed') processed++;
        else if (result === 'failed') failed++;
        else                          skipped++;
      }
    }

    spacer();

    if (failed > 0) {
      error(`Done. Processed: ${processed}. Skipped: ${skipped}. Failed: ${failed}.`);
    } else {
      info(`Done. Processed: ${processed}. Skipped: ${skipped}.`);
    }
  } finally {
    await closeDebugLog();
  }
}

// ── One group at a time ──────────────────────────────────────────────────────

async function processGroup(
  group: PrepareGroup,
): Promise<'processed' | 'skipped' | 'failed'> {
  section(`${group.day}  (${group.tableName})`);
  spacer();

  const finalPath = path.join(group.outputDir, group.outputName);
  const tmpPath   = `${finalPath}.tmp`;

  if (fs.existsSync(finalPath)) {
    info(`Skipped (already prepared): ${finalPath}`);
    spacer();

    return 'skipped';
  }

  if (fs.existsSync(tmpPath)) {
    warn(`Skipped (in-progress or crashed): ${tmpPath}`);
    spacer();

    return 'skipped';
  }

  info(`Sources (${group.paths.length}):`);

  for (const p of group.paths) {
    info(`  ${path.basename(p)}`);
  }

  spacer();

  if (isDryRun()) {
    info(`Would write: ${finalPath}`);
    spacer();

    return 'processed';
  }

  const overflow = createOverflow();
  const issues:    ReadIssue[]            = [];
  const dropped    = { count: 0 };

  try {
    const stats          = await runPipeline(group, overflow, issues, dropped, tmpPath, finalPath);
    const overflowResult = await overflow.flush(group.folder, group.day, group.tableName);

    reportResult(finalPath, stats, dropped.count, issues.length, overflowResult.byDay);

    writeGroupLog(group, {
      written:       stats.written,
      overflowed:    stats.overflowed,
      overflowByDay: overflowResult.byDay,
      dedupDrops:    dropped.count,
      issues,
    });

    spacer();

    return 'processed';
  } catch (err) {
    const errMsg = (err instanceof Error ? err.message : String(err));

    error(`FAILED ${group.day} (${group.tableName}): ${errMsg}`);

    writeGroupLog(group, {
      written:       0,
      overflowed:    0,
      overflowByDay: new Map(),
      dedupDrops:    dropped.count,
      issues,
      error:         errMsg,
    });

    spacer();

    return 'failed';
  }
}

// ── Pipeline composition ─────────────────────────────────────────────────────

async function runPipeline(
  group:    PrepareGroup,
  overflow: Overflow,
  issues:   ReadIssue[],
  dropped:  { count: number },
  tmpPath:  string,
  finalPath: string,
): Promise<{ written: number; overflowed: number }> {
  fs.mkdirSync(group.outputDir, { recursive: true });

  const writer = createGzipWriter(tmpPath);

  writeOutputHeader(writer, group.tableName, group.day);

  const onIssue = (i: ReadIssue): void => { issues.push(i); };
  const onDrop  = ():            void => { dropped.count++; };

  // One source actor per file. Each actor spins up READ + SORT in the
  // background, fed and drained through bounded queues. All sources read
  // concurrently from disk via libuv, which is the primary throughput win
  // over the previous lazy pull pipeline.
  const sources = group.paths.map(sourcePath =>
    createSourceActor(group.tableName, sourcePath, onIssue),
  );

  try {
    const stats = await write(
      dedup(merge(sources, group.tableName), group.tableName, onDrop),
      group.day,
      writer,
      overflow,
    );

    await writer.close();
    fs.renameSync(tmpPath, finalPath);

    return stats;
  } catch (err) {
    safeUnlink(tmpPath);
    throw err;
  }
}

// ── Reporting ────────────────────────────────────────────────────────────────

function reportResult(
  outputPath:    string,
  stats:         { written: number; overflowed: number },
  dedupDrops:    number,
  validation:    number,
  overflowByDay: Map<string, number>,
): void {
  success(`Written: ${stats.written.toLocaleString()} → ${outputPath}`);

  if (stats.overflowed > 0) {
    info(`Overflow (${stats.overflowed.toLocaleString()} messages):`);

    for (const [day, count] of overflowByDay) {
      info(`  ${day}: ${count.toLocaleString()}`);
    }
  }

  if (dedupDrops > 0)  info(`Dedup drops: ${dedupDrops.toLocaleString()}`);
  if (validation > 0)  warn(`Validation drops: ${validation.toLocaleString()} (logged)`);
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function safeUnlink(p: string): void {
  try { fs.unlinkSync(p); } catch { /* best effort */ }
}

