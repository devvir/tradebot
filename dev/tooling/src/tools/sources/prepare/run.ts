import fs from 'node:fs';
import { Writable } from 'node:stream';
import { createWriter } from '@devvir/zipper';
import { closeDebugLog, setupDebugLog } from '../log';
import { resolveSourceFiles } from '../discover';
import { concurrency, isDryRun } from '../options';
import { runOrchestrator } from './orchestrator';
import { createSourceActor } from './source-actor';
import { dedup } from './tasks/deduper';
import { writeOutputHeader } from './tasks/header';
import { merge } from './tasks/merger';
import { write } from './tasks/writer';
import { discoverGroups } from './utils/discover';
import { preflight } from './utils/preflight';
import {
  createStatsCollector,
  recordGroupFailure,
  recordGroupResult,
  reportNoSourcesFound,
  reportPreFlight,
  reportProcessing,
  reportRunSummary,
} from './utils/report';
import type { PrepareGroup, StatsCollector } from './types';

/**
 * `sources prepare` entry point. With `-C >= 2`, short-circuits to the
 * subprocess orchestrator. With `-C 1`, runs the READ → SORT → MERGE →
 * DEDUP → WRITE pipeline sequentially over each discovered group.
 */
export async function runPrepare(root: string): Promise<void> {
  const files = resolveSourceFiles(root);

  if (files.length === 0) {
    reportNoSourcesFound(root);

    return;
  }

  if (concurrency() > 1) {
    await runOrchestrator(files);

    return;
  }

  setupDebugLog();
  reportPreFlight();

  const groups = discoverGroups(files);

  let processed = 0;
  let skipped   = 0;
  let failed    = 0;

  try {
    for (const group of groups) {
      const result = await processGroup(group);

      if      (result === 'processed') processed++;
      else if (result === 'failed')    failed++;
      else                              skipped++;
    }

    reportRunSummary({ processed, skipped, failed });
  } finally {
    await closeDebugLog();
  }

  if (failed > 0) process.exit(1);
}

// ── One group at a time ──────────────────────────────────────────────────────

async function processGroup(group: PrepareGroup): Promise<'processed' | 'skipped' | 'failed'> {
  const decision = preflight(group);

  if ('outcome' in decision) return decision.outcome;

  const { tmpPath, finalPath, inputBytes } = decision.proceed;

  reportProcessing(group, inputBytes);

  const stats = createStatsCollector(group);

  try {
    const { written } = await runPipeline(group, stats, tmpPath, finalPath);

    recordGroupResult(group, stats, finalPath, written);

    return 'processed';
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);

    recordGroupFailure(group, stats, errMsg);

    return 'failed';
  }
}

// ── Pipeline composition ─────────────────────────────────────────────────────

async function runPipeline(
  group:     PrepareGroup,
  stats:     StatsCollector,
  tmpPath:   string,
  finalPath: string,
): Promise<{ written: number }> {
  const dryRun = isDryRun();

  if (! dryRun) fs.mkdirSync(group.outputDir, { recursive: true });

  const writer = dryRun ? null : createWriter(tmpPath);
  const stream = writer
    ? writer.stream()
    : new Writable({ write(_, __, cb) { cb(); } });

  writeOutputHeader(stream, group.tableName, group.day);

  /** One source actor per file — all sources read from disk concurrently. */
  const sources = group.paths.map((sourcePath, i) =>
    createSourceActor(group.tableName, sourcePath, stats.onIssue, count => stats.recordRead(i, count)),
  );

  try {
    const result = await write(
      dedup(merge(sources, group.tableName, stats.recordMergeContribs), group.tableName, stats.onDrop),
      stream,
    );

    if (writer) {
      await writer.close();
      fs.renameSync(tmpPath, finalPath);
    }

    return result;
  } catch (err) {
    if (writer) try { fs.unlinkSync(tmpPath); } catch { /* best effort */ }
    throw err;
  }
}
