import { section, info, success, warn, spacer } from '../../../shared/ui/logger';
import { getEnv } from '../../../shared/utils/env';
import { C } from '../../../shared/utils/colors';
import { connectDbTool } from '../utils/connect';
import { parseArgs, resolveCollections, buildPairs } from '../utils/args';
import { checkExisting, pairsNotOnMega } from '../utils/existing';
import { gatherRows, printPlan } from '../utils/plan';
import { pairKey } from '../types';
import { promptSkipUnbacked, confirmPurge, confirmDeleteUnbacked } from './prompt';
import { executePurge } from './delete';
import { appendPurgePlan, appendPurgeOutcomes } from './log';

const DEFAULT_DUMP_DIR = './db-dump';

/**
 * Permanently delete MongoDB documents matching the given collection × date
 * filters. Same arg parser as `dump` (collections + dates + `all`).
 *
 * Safety:
 *   1. Scans Mega (`DB_DUMP_MEGA_DIR`) to see which pairs already have a
 *      backup. Pairs without a backup are flagged.
 *   2. Offers to skip unbacked-up pairs (default Y).
 *   3. If the user chooses to proceed with unbacked-up pairs, a second guard
 *      prompt is required.
 *   4. Final confirmation defaults to **N** (you must actively type `y`).
 *   5. Append-only log at `<DB_DUMP_DIR>/purge.log` records the plan and
 *      per-pair deletion results.
 */
export async function runPurge(args: string[]): Promise<void> {
  section('DB Purge');
  spacer();

  const outDir   = getEnv('DB_DUMP_DIR') ?? DEFAULT_DUMP_DIR;
  const megaBase = getEnv('DB_DUMP_MEGA_DIR');

  if (! megaBase) {
    warn('DB_DUMP_MEGA_DIR is not set — cannot verify Mega backups.');
    warn('Set it before purging, or accept proceeding without backup verification.');
    spacer();
  }

  const { dates, rawCollections, useAll } = parseArgs(args);

  const { client, db } = await connectDbTool();

  try {
    const allNames    = (await db.listCollections().toArray()).map(c => c.name).sort();
    const collections = resolveCollections(rawCollections, useAll, dates, allNames);
    const allPairs    = buildPairs(collections, dates);

    if (allPairs.length === 0) {
      warn('Nothing to purge.');
      return;
    }

    spacer();
    info('Scanning Mega for backups…');
    const existing = await checkExisting(allPairs, null);

    spacer();
    const { pairs, skippedUnbacked } = await promptSkipUnbacked(allPairs, existing);

    if (pairs.length === 0) {
      spacer();
      info('Nothing to purge after skipping unbacked-up pairs.');
      return;
    }

    // If skip was declined and there ARE unbacked pairs, require a second confirm.
    const stillUnbacked = pairsNotOnMega(pairs, existing);

    if (! skippedUnbacked && stillUnbacked.length > 0) {
      spacer();
      const yesAnyway = await confirmDeleteUnbacked(stillUnbacked.length);

      if (! yesAnyway) {
        info('Aborted.');
        return;
      }
    }

    spacer();
    const rows = await gatherRows(db, pairs);

    spacer();
    printPlan(rows, `${C.red}${C.bold}⚠ DESTRUCTIVE — will permanently delete from MongoDB${C.reset}`);
    spacer();

    const proceed = await confirmPurge(rows.length);

    if (! proceed) {
      info('Aborted.');
      return;
    }

    const survivingKeys  = new Set(pairs.map(pairKey));
    const skippedPairs   = allPairs.filter(p => ! survivingKeys.has(pairKey(p)));
    const deletingUnbacked = pairsNotOnMega(pairs, existing);

    appendPurgePlan(outDir, args, rows, skippedPairs, deletingUnbacked);

    spacer();
    const outcomes = await executePurge(db, rows);

    appendPurgeOutcomes(outDir, outcomes);

    spacer();
    const okCount  = outcomes.filter(o => ! o.error).length;
    const errCount = outcomes.length - okCount;

    if (errCount === 0) {
      success(`Purge complete — ${okCount} pair${okCount === 1 ? '' : 's'} deleted`);
    } else {
      warn(`Purge: ${okCount} ok, ${errCount} failed — see ${outDir}/purge.log`);
    }
  } finally {
    await client.close();
  }
}
