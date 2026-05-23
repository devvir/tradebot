import { Db } from 'mongodb';
import { info, success, warn } from '../../../shared/ui/logger';
import { C } from '../../../shared/utils/colors';
import { fmtNum, fmtElapsed } from '../utils/format';
import { writeStatus, clearStatus } from '../utils/progress';
import { filterFor } from '../utils/plan';
import type { PlanRow } from '../types';
import type { PurgeOutcome } from './types';

const ELAPSED_TICK_MS = 1000;

// ── Exports ──────────────────────────────────────────────────────────────────

/**
 * Run `deleteMany({_id: range})` for each row, one at a time. Each pair gets a
 * "Deleting…" announcement, a live "Xs elapsed" status line updated every
 * second, and a final "deleted N in Ys" success line.
 *
 * MongoDB's deleteMany has no streaming progress, so per-pair is the finest
 * granularity we can show without splitting the range into smaller chunks.
 */
export async function executePurge(db: Db, rows: PlanRow[]): Promise<PurgeOutcome[]> {
  const outcomes: PurgeOutcome[] = [];

  for (const [idx, row] of rows.entries()) {
    const period = row.date?.label ?? 'all';
    const head   = `[${idx + 1}/${rows.length}] ${row.collection} [${period}]`;

    info(`${head} deleting (~${fmtNum(row.count)} docs)…`);

    const start = Date.now();
    const tick  = setInterval(() => {
      writeStatus(`  ${C.dim}${fmtElapsed((Date.now() - start) / 1000)} elapsed…${C.reset}`);
    }, ELAPSED_TICK_MS);

    try {
      const result    = await db.collection(row.collection).deleteMany(filterFor(row));
      const elapsedMs = Date.now() - start;

      clearInterval(tick);
      clearStatus();

      success(`  deleted ${fmtNum(result.deletedCount)} in ${fmtElapsed(elapsedMs / 1000)}`);

      outcomes.push({
        collection: row.collection,
        period,
        deleted:    result.deletedCount,
        elapsedMs,
      });
    } catch (err) {
      clearInterval(tick);
      clearStatus();

      const message = (err as Error).message;

      warn(`  deleteMany failed: ${message}`);

      outcomes.push({
        collection: row.collection,
        period,
        deleted:    0,
        elapsedMs:  Date.now() - start,
        error:      message,
      });
    }
  }

  return outcomes;
}
