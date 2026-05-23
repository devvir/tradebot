import { section, info, success, warn, spacer } from '../../../shared/ui/logger';
import { getEnv } from '../../../shared/utils/env';
import { connectDbTool } from '../utils/connect';
import { parseArgs, resolveCollections, buildPairs } from '../utils/args';
import { checkExisting } from '../utils/existing';
import { gatherRows, printPlan, confirmProceed } from '../utils/plan';
import { C } from '../../../shared/utils/colors';
import { pairKey } from '../types';
import { promptSkipExisting } from './prompt';
import { executeDump } from './write';
import { maybeUploadToMega } from './upload';
import { appendDumpLog } from './log';
import type { DumpOptions } from './types';

const DEFAULT_DUMP_DIR = './db-dump';

/**
 * Dump MongoDB collections to mongodump archives for cold storage.
 *
 * Args are a mix of:
 *   - date filters (YYYY, YYYYMM, YYYYMMDD; dashes optional) — each becomes an
 *     `_id` range query via `startOfDayMongoId`
 *   - collection names — restrict the dump to those collections
 *   - the keyword "all" — expand to every collection in the database
 *
 * Layout: `<out>/<collection>/<date-key>.archive.gz`, or `<collection>/all.archive.gz`
 * when no date filter is given. In-flight dumps land as `.archive.gz.tmp`
 * and rename atomically on success.
 *
 * After the mongo phase (whether anything was dumped, skipped, or aborted),
 * the upload phase always runs — it scans `outDir` for sealed archives, diffs
 * against Mega, and offers to upload anything missing. Picks up files from
 * previous runs where the user skipped the upload prompt.
 */
export async function runDump(args: string[], options: DumpOptions = {}): Promise<void> {
  section('DB Dump');
  spacer();

  const outDir = options.out ?? getEnv('DB_DUMP_DIR') ?? DEFAULT_DUMP_DIR;

  const { dates, rawCollections, useAll } = parseArgs(args);

  const { client, db } = await connectDbTool();

  try {
    const allNames    = (await db.listCollections().toArray()).map(c => c.name).sort();
    const collections = resolveCollections(rawCollections, useAll, dates, allNames);
    const allPairs    = buildPairs(collections, dates);

    if (allPairs.length === 0) {
      warn('No collections to dump.');
    } else {
      await runMongoPhase(db, args, outDir, allPairs);
    }
  } finally {
    await client.close();
  }

  // Upload phase runs even when the mongo phase did nothing — picks up local
  // archives left behind by a previous run where the user skipped the upload.
  try {
    await maybeUploadToMega(outDir);
  } catch (err) {
    warn(`Upload phase failed: ${(err as Error).message}`);
  }
}

// ── Internals ────────────────────────────────────────────────────────────────

async function runMongoPhase(
  db:       import('mongodb').Db,
  args:     string[],
  outDir:   string,
  allPairs: ReturnType<typeof buildPairs>,
): Promise<void> {
  spacer();
  info('Checking for existing dumps…');
  const existing = await checkExisting(allPairs, outDir);

  spacer();
  const pairs = await promptSkipExisting(allPairs, existing);

  if (pairs.length === 0) {
    spacer();
    info('Nothing to dump after skipping.');
    return;
  }

  spacer();
  const rows = await gatherRows(db, pairs);

  spacer();
  printPlan(rows, `Output: ${C.cyan}${outDir}${C.reset}`);
  spacer();

  const proceed = await confirmProceed('Proceed with dump?', true);

  if (! proceed) {
    info('Aborted.');
    return;
  }

  const survivingKeys = new Set(pairs.map(pairKey));
  const skippedPairs  = allPairs.filter(p => ! survivingKeys.has(pairKey(p)));

  appendDumpLog(outDir, args, rows, skippedPairs, existing);

  spacer();
  await executeDump(db, rows, outDir);
  spacer();
  success(`Dump complete → ${outDir}`);
}
