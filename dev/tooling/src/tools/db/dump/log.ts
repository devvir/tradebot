import fs from 'node:fs';
import path from 'node:path';
import { warn } from '../../../shared/ui/logger';
import { formatPlanLines } from '../utils/plan';
import { pairFilename, pairKey } from '../types';
import type { Pair, PlanRow, ExistingStatus } from '../types';

const LOG_FILENAME = 'dump.log';

// ── Exports ──────────────────────────────────────────────────────────────────

/**
 * Append a single entry to `<outDir>/dump.log` recording: the run's timestamp,
 * the raw CLI args, the output dir, any skipped pairs (with where they were
 * found), and the final plan table.
 *
 * Plain ASCII, append-only — safe to `tail -f`. Called once per run, just
 * after the user confirms the proceed prompt.
 */
export function appendDumpLog(
  outDir:   string,
  args:     string[],
  rows:     PlanRow[],
  skipped:  Pair[],
  existing: Map<string, ExistingStatus>,
): void {
  const lines: string[] = [];

  lines.push('═'.repeat(72));
  lines.push(`${timestamp()}  —  dump  —  args: ${args.join(' ') || '(none)'}`);
  lines.push(`output: ${outDir}`);

  if (skipped.length > 0) {
    lines.push('');
    lines.push(`skipped (${skipped.length}):`);

    for (const pair of skipped) {
      const where = whereExists(existing.get(pairKey(pair)));

      lines.push(`  ${pair.collection}/${pairFilename(pair)}  (${where})`);
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

  lines.push('');

  try {
    fs.mkdirSync(outDir, { recursive: true });
    fs.appendFileSync(path.join(outDir, LOG_FILENAME), lines.join('\n') + '\n');
  } catch (err) {
    warn(`Could not write dump.log: ${(err as Error).message}`);
  }
}

// ── Internals ────────────────────────────────────────────────────────────────

function timestamp(): string {
  // 2026-05-23 10:42:15Z — fixed-width, sortable, grep-friendly
  return new Date().toISOString().replace('T', ' ').replace(/\.\d{3}Z$/, 'Z');
}

function whereExists(status: ExistingStatus | undefined): string {
  if (! status) return '';

  return [status.local && 'local', status.mega && 'mega'].filter(Boolean).join(' + ');
}
