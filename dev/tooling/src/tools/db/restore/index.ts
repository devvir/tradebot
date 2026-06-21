import fs from 'node:fs';
import path from 'node:path';
import { section, info, success, warn, spacer } from '../../../shared/ui/logger';
import { fmtBytes } from '../../../shared/utils/format';
import { C } from '../../../shared/utils/colors';
import { getEnv } from '../../../shared/utils/env';
import { parseArgs, resolveCollections, buildPairs } from '../utils/args';
import { connectDbTool } from '../utils/connect';
import { discoverTargets, findOverlaps } from './discover';
import {
  printRestorePlan,
  printSizeMismatches,
  hasSizeMismatch,
  confirmRestore,
  confirmDownloadOnly,
  confirmCleanup,
  printOverlaps,
} from './prompt';
import { downloadMissing } from './download';
import { executeRestore } from './import';
import { parseDumpLog } from './dumplog';
import { appendRestoreLog } from './log';
import { neededDownloadBytes, computeSpaceMode, getAvailableBytes } from './space';
import { listLocalCollections } from '../utils/sync';
import { listMegaCollections } from '../utils/mega';
import type { RestoreTarget } from './types';

const DEFAULT_DUMP_DIR = './db-dump';

/**
 * Restore mongodump archives back into MongoDB.
 *
 * Same arg parser as dump/purge: collection names and date filters
 * (YYYY/YYYYMM/YYYYMMDD with optional dashes), plus the `all` keyword.
 *
 * Lookup is EXACT, never partial. A pair with a date matches that single
 * filename; a bare collection expands to every archive found in that
 * collection's local or Mega dir. After discovery, the targets are checked
 * for coarser/narrower overlaps within each collection (year × month, year ×
 * day, month × day, `all` × anything) — overlaps abort the run before any
 * work is done.
 *
 * Execution:
 *   1. Download from Mega anything not present locally (sequential).
 *   2. mongorestore each archive in parallel (default 4, override via
 *      `DB_RESTORE_CONCURRENCY`). Local copy is always preferred; duplicate
 *      `_id` errors are ignored (mongorestore default).
 *   3. On success, offer to delete the restored local archives (default N).
 */
export async function runRestore(args: string[]): Promise<void> {
  section('DB Restore');
  spacer();

  const outDir = getEnv('DB_DUMP_DIR') ?? DEFAULT_DUMP_DIR;

  // Optional `--database`/`-D <name>` retargets the restore into a different
  // database (e.g. a side db for comparison), via mongorestore's `--nsTo`.
  const { value: targetDb, rest } = extractValueFlag(args, ['--database', '-D']);

  if (targetDb) info(`Target database override: ${C.yellow}${targetDb}${C.reset} (restoring into a side database)`);

  const { dates, rawCollections, useAll } = parseArgs(rest);

  // Discover collections from local + mega (not from mongo — restore creates
  // collections, so they need not exist in the live DB yet). A collection
  // present only on Mega is still valid: the union below keeps it from being
  // rejected as "unknown" before discovery runs.
  const megaBase         = getEnv('DB_DUMP_MEGA_DIR') ?? null;
  const localCollections = listLocalCollections(outDir);
  const megaCollections  = megaBase ? await listMegaCollections(megaBase) : [];
  const allCollections   = [...new Set([...localCollections, ...megaCollections])].sort();
  const collections      = resolveCollections(rawCollections, useAll, dates, allCollections);
  const pairs            = buildPairs(collections, dates);

  if (pairs.length === 0) {
    warn('No collections to restore.');
    return;
  }

  info('Discovering archives in local + Mega…');
  const targets = await discoverTargets(pairs, outDir);

  if (targets.length === 0) {
    warn('No matching archives found.');
    return;
  }

  const overlaps = findOverlaps(targets);

  if (overlaps.length > 0) {
    spacer();
    printOverlaps(overlaps);
    return;
  }

  spacer();
  printRestorePlan(targets);
  printSizeMismatches(targets);

  // Disk-space pre-flight against the bytes we'd pull from Mega.
  const downloadBytes  = neededDownloadBytes(targets);
  const availableBytes = getAvailableBytes(outDir);
  const spaceMode      = computeSpaceMode(downloadBytes, availableBytes);

  let downloadOnly = false;

  if (spaceMode === 'reject') {
    spacer();
    warn(`Not enough disk space: ${fmtBytes(availableBytes)} available vs ${fmtBytes(downloadBytes)} to download. Aborting.`);
    return;
  }

  if (spaceMode === 'download-only-offer') {
    spacer();
    warn(`Disk space too tight to import: ${fmtBytes(availableBytes)} available vs ${fmtBytes(downloadBytes)} to download. No headroom for the restore step.`);

    if (! await confirmDownloadOnly()) {
      info('Aborted.');
      return;
    }

    downloadOnly = true;
  } else {
    if (spaceMode === 'warn-then-proceed') {
      spacer();
      warn(`Disk space may be tight: ${fmtBytes(availableBytes)} available vs ${fmtBytes(downloadBytes)} to download. Restore could fail if mongo data grows past free space.`);
    }

    const defaultYes = spaceMode === 'proceed' && ! hasSizeMismatch(targets);

    if (! await confirmRestore(targets, defaultYes)) {
      info('Aborted.');
      return;
    }
  }

  spacer();
  await downloadMissing(targets, outDir);

  if (downloadOnly) {
    spacer();
    info('Download-only mode: skipping import. Re-run restore once you have freed space.');
    appendRestoreLog(outDir, args, targets, [], []);
    return;
  }

  spacer();
  // Quick connectivity sanity check before kicking off mongorestore workers.
  // Also yields the source database name, needed to build the namespace remap.
  const { client, db } = await connectDbTool();
  const sourceDb = db.databaseName;
  await client.close();

  const remap = targetDb && targetDb !== sourceDb
    ? { nsFrom: `${sourceDb}.*`, nsTo: `${targetDb}.*` }
    : {};

  // Accurate progress denominators: the uncompressed size each archive's dump
  // recorded in dump.log (last occurrence wins). Missing entries fall back to a
  // generic ratio in executeRestore.
  const dumpStats = parseDumpLog(path.join(outDir, 'dump.log'));

  spacer();
  const outcomes = await executeRestore(targets, { ...remap, dumpStats });

  spacer();
  const okCount  = outcomes.filter(o => ! o.error).length;
  const errCount = outcomes.length - okCount;

  if (errCount === 0) success(`Restore complete — ${okCount} archive${okCount === 1 ? '' : 's'} imported`);
  else                warn(`Restore: ${okCount} ok, ${errCount} failed — see ${outDir}/restore.log`);

  // Offer cleanup only for files that have a verified-identical Mega copy.
  // Skipping local-only files (no backup) and size-mismatched files (user
  // chose local over a different Mega copy — deleting would discard their
  // choice).
  const successKeys = new Set(outcomes.filter(o => ! o.error).map(o => `${o.collection}|${o.key}`));
  const succeeded   = targets.filter(t => t.local && successKeys.has(`${t.collection}|${t.key}`));
  const cleanable   = succeeded.filter(t => t.mega && t.local!.size === t.mega.size);
  const heldBack    = succeeded.filter(t => ! cleanable.includes(t));

  if (heldBack.length > 0) {
    spacer();
    warn(`Holding back ${heldBack.length} file${heldBack.length === 1 ? '' : 's'} from cleanup — no verified Mega backup:`);

    for (const t of heldBack) {
      console.log(`  ${t.collection}/${t.filename}  ${C.dim}(${heldBackReason(t)})${C.reset}`);
    }
  }

  let removed: string[] = [];

  if (cleanable.length > 0 && await confirmCleanup(cleanable.map(t => t.local!.path))) {
    for (const t of cleanable) {
      try {
        fs.unlinkSync(t.local!.path);
        removed.push(t.local!.path);
      } catch (err) {
        warn(`Could not remove ${t.local!.path}: ${(err as Error).message}`);
      }
    }

    success(`Removed ${removed.length}/${cleanable.length} local archive${removed.length === 1 ? '' : 's'}`);
  }

  appendRestoreLog(outDir, args, targets, outcomes, removed);
}

function heldBackReason(t: RestoreTarget): string {
  if (! t.mega) return 'local only';

  return `size mismatch (local ${fmtBytes(t.local!.size)}, mega ${fmtBytes(t.mega.size)})`;
}

/**
 * Pull a single value flag (`--name value`, `--name=value`, or any of its aliases)
 * out of the arg list, returning the value and the remaining args. Unmatched args
 * pass through untouched so the date/collection parser sees only what it expects.
 */
function extractValueFlag(args: string[], names: string[]): { value?: string; rest: string[] } {
  const rest: string[] = [];
  let value: string | undefined;

  for (let i = 0; i < args.length; i++) {
    const arg    = args[i]!;
    const inline = names.find(n => arg.startsWith(`${n}=`));

    if (inline) {
      value = arg.slice(inline.length + 1);
    } else if (names.includes(arg)) {
      value = args[++i];
    } else {
      rest.push(arg);
    }
  }

  return { value, rest };
}
