import fs from 'node:fs';
import path from 'node:path';
import { warn } from '../../../shared/ui/logger';
import { formatPlanLines } from '../utils/plan';
import { pairFilename } from '../types';
import type { Pair, PlanRow } from '../types';
import type { PurgeOutcome } from './types';

const LOG_FILENAME = 'purge.log';

// ── Exports ──────────────────────────────────────────────────────────────────

/**
 * Append a single entry to `<outDir>/purge.log` after the user confirms
 * deletion. Records: timestamp, args, any pairs skipped (not on Mega),
 * whether the user accepted deleting unbacked-up data, and the plan table.
 *
 * Per-pair deletion outcomes are appended once execution completes via
 * `appendPurgeOutcomes`.
 */
export function appendPurgePlan(
  outDir:          string,
  args:            string[],
  rows:            PlanRow[],
  skippedUnbacked: Pair[],
  deletingUnbacked: Pair[],
): void {
  const lines: string[] = [];

  lines.push('═'.repeat(72));
  lines.push(`${timestamp()}  —  purge  —  args: ${args.join(' ') || '(none)'}`);

  if (skippedUnbacked.length > 0) {
    lines.push('');
    lines.push(`skipped — not on Mega (${skippedUnbacked.length}):`);
    for (const pair of skippedUnbacked) {
      lines.push(`  ${pair.collection}/${pairFilename(pair)}`);
    }
  }

  if (deletingUnbacked.length > 0) {
    lines.push('');
    lines.push(`⚠ deleting WITHOUT Mega backup (${deletingUnbacked.length}):`);
    for (const pair of deletingUnbacked) {
      lines.push(`  ${pair.collection}/${pairFilename(pair)}`);
    }
  }

  if (rows.length > 0) {
    const p = formatPlanLines(rows);

    lines.push('');
    lines.push(p.header);
    lines.push(p.sep);
    lines.push(...p.rows);
    lines.push(p.sep);
    lines.push(p.total);
  }

  writeLog(outDir, lines);
}

export function appendPurgeOutcomes(outDir: string, outcomes: PurgeOutcome[]): void {
  if (outcomes.length === 0) return;

  const lines: string[] = [''];

  lines.push('results:');

  let okCount = 0;
  let errCount = 0;

  for (const o of outcomes) {
    if (o.error) {
      lines.push(`  ✗ ${o.collection}/${o.period}  FAILED: ${o.error}`);
      errCount++;
    } else {
      const seconds = (o.elapsedMs / 1000).toFixed(1);

      lines.push(`  ✓ ${o.collection}/${o.period}  deleted ${o.deleted} docs in ${seconds}s`);
      okCount++;
    }
  }

  lines.push(`  total: ${okCount} ok, ${errCount} failed`);
  lines.push('');

  writeLog(outDir, lines);
}

// ── Internals ────────────────────────────────────────────────────────────────

function writeLog(outDir: string, lines: string[]): void {
  try {
    fs.mkdirSync(outDir, { recursive: true });
    fs.appendFileSync(path.join(outDir, LOG_FILENAME), lines.join('\n') + '\n');
  } catch (err) {
    warn(`Could not write purge.log: ${(err as Error).message}`);
  }
}

function timestamp(): string {
  return new Date().toISOString().replace('T', ' ').replace(/\.\d{3}Z$/, 'Z');
}
