import path from 'node:path';
import { recordOf, save } from '../../shared/backup';
import * as catalog from '../../shared/catalog';
import { loadConfig, WATCH_MS } from '../../config';
import { onExit } from '../../cleanup';
import { Archives } from '../../shared/disk';
import { acquire } from '../../lock';
import { agreed, isWatch } from '../../options';
import * as record from '../../shared/record';
import { ERRORS, errorsIn, LEDGER, stockedIn } from '../../shared/vault/ledger';
import { fmtBytes } from '../../../../shared/utils/format';
import { error, info, spacer, success } from '../../../../shared/ui/logger';
import { survey } from './survey';
import { remove } from './remove';
import type { DatabaseSync } from 'node:sqlite';
import type { Evictable, EvictOptions, Run } from '../types';
import type { Origin } from '../../types';

/**
 * Take off the local disk what no longer has to be there.
 *
 * **A partition of the archives can go once two things hold it**: cold storage,
 * at the version the catalog has, and the vault, stocked from it. The archives
 * exist to be stocked and to be kept; once both are done the copy on disk is a
 * third.
 *
 * What is asked of each settled partition the catalog says is downloaded:
 *
 * - **It is in cold storage at the catalog's version.** That it was checked
 *   against the disk and proven inside its tar is what storing it meant, so
 *   nothing is compared again here — **and nothing on disk is looked at**.
 *   Whatever the archives hold of such a partition goes: the same files, older
 *   ones, or some of them. No answer the disk could give changes that, so it is
 *   not asked, and deciding what can go costs no walk over the tree.
 * - **It is stocked** — it, or any other rendering of the same data: another
 *   grain, or the market's bundle. Which rendering the vault was built from is
 *   the vault's business; what matters is that none is needed any more. The
 *   vault's ledger says so, and says it only while the versions it was stocked
 *   from are still the catalog's — and only while what was stocked is still
 *   held somewhere: in cold storage, as the record says, or on disk in the
 *   vault.
 * - **No neighbouring month still needs it.** Where a venue cuts its days away
 *   from UTC midnight, a month's first or last hours sit in a file of the month
 *   next door, and the vault stocks them from there. A month's own ledger line
 *   says whether its dataset does that, and which way: a side it names — with
 *   the neighbour's version, or as `missing` — is a side a neighbour's files
 *   hold. A month whose last hours are in the next month's files has files
 *   that hold the last hours of the month before; so they stay until the month
 *   before has them, which its own line says. A month whose line names no side
 *   is in nobody's way.
 *
 * **A month stocked without a neighbour's hours is stocked.** Its own files
 * have given the vault everything they hold, and what it lacks is in the
 * neighbour's.
 *
 * **Only a month the catalog holds is waited for.** A neighbour the venue
 * published nothing in will never need anything. The one exception is a month
 * whose files hold the first hours of the month after, where that month is not
 * in the catalog yet and has not had its time: a month can be settled
 * `SETTLE_DAYS` after it ends, so until then not published is not ended.
 *
 * **What is removed goes to the host's trash**, never straight to nothing.
 * Every check above has to be right for a removal to be safe, and the one thing
 * none of them covers is a mistake in the checks. The trash is on the same
 * volume, so it is a rename; it frees no space until it is emptied, which is
 * the chance to look at what was taken. A trash that fails is never retried as
 * a delete. `purge` removes outright, for when that is what is wanted.
 *
 * **What was evicted and is on disk again is not looked for, unless asked.**
 * The record says a partition went, at the version it has now, and it is not
 * offered again — files brought back since, pulled from cold storage to be read
 * or fetched some other way, are nobody's to remove. `cleanup` looks: for every
 * partition that went and could still go by every rule above, it reads the
 * disk, and whatever of the partition is there goes again. Cold storage holds
 * the version the catalog has, so what is on disk is spare whatever it is — the
 * same files, older ones, or half of them. It is a look taken on purpose and
 * once: never while watching, where it would take files as they are pulled.
 *
 * **Nothing is evicted while the vault reports a loss.** `ERROR.log` in the
 * vault means its ledger said something its disk did not bear out — and the
 * ledger is what this trusts.
 */
export const runEvict = async (origin: Origin, options: EvictOptions): Promise<void> => {
  if (options.cleanup && isWatch()) {
    error('--cleanup looks at the disk once and removes what it finds; it does not run with --watch');

    process.exitCode = 1;

    return;
  }

  const config  = loadConfig(origin);
  const release = await acquire(config.coldRoot, origin, 'evict');

  try {
    const db = record.open(config.dbPath);

    onExit(() => record.close(db));

    try {
      const venues   = options.venues.length > 0 ? options.venues : await catalog.venues(config);
      const archives = new Archives(config.sourceRoot);
      const run: Run = { config, origin, venues, archives, options, agreed: false, waiting: false };

      /**
       * **Watching, the same is asked again at intervals.** What can go changes
       * as partitions are stored and stocked, so a run left going removes each
       * as it becomes removable. It asks before the first removal and not
       * again: the answer was to the kind of thing being removed, and that does
       * not change between one look and the next.
       */
      for (let first = true; ; first = false) {
        if (! await pass(db, run, first)) return;

        if (! isWatch()) return;

        await save(config, [recordOf(config)]);

        await new Promise(resolve => setTimeout(resolve, WATCH_MS));
      }
    } finally {
      record.close(db);
    }
  } finally {
    release();
  }
};

// ── Internals ─────────────────────────────────────────────────────────────────

/**
 * Look once at what can go, and remove it. Says whether the run goes on: false
 * where it was refused, could not be answered, or was told no.
 *
 * **The first look says everything it finds; a later one only what it has to
 * do.** A run that is watching and finds nothing says so once, and then stays
 * quiet until there is something.
 */
const pass = async (db: DatabaseSync, run: Run, first: boolean): Promise<boolean> => {
  const { config, origin, venues, options } = run;

  // Read on every look: the vault is stocked while this runs, and may report a loss while it does.
  const lost = errorsIn(config.vaultRoot);

  if (lost.length > 0) {
    error(`The vault reports ${lost.length} problem${lost.length === 1 ? '' : 's'} in ${path.join(config.vaultRoot, ERRORS)} — `
      + 'nothing is evicted until that is understood and the file is gone');

    for (const line of lost.slice(0, 5)) info(`  ${line}`);

    process.exitCode = 1;

    return false;
  }

  const stocked = stockedIn(config.vaultRoot);

  if (! stocked) {
    error(`No ${LEDGER} in ${config.vaultRoot} — without the vault's ledger nothing can be said to be stocked. Is DATA_VAULT_DIR right?`);

    process.exitCode = 1;

    return false;
  }

  const found: Evictable[] = [];

  if (first) info('Asking what in the archives is stored and stocked');

  try {
    for (const venue of venues) {
      const one = await survey(db, config, origin, venue, stocked, Date.now(), options.cleanup ? run.archives : undefined);

      found.push(one);

      if (first) info(`  ${venue.padEnd(8)} ${said(one)}`);
    }
  } catch (err) {
    // A catalog that does not answer ends a single look, and costs a watching run only this one.
    if (first || ! isWatch()) throw err;

    info(`Could not ask the catalog: ${(err as Error).message}`);

    return true;
  }

  const ready = found.flatMap(one => one.ready);

  if (ready.length === 0) {
    if (! isWatch()) success('Nothing in the archives can be evicted');
    else if (! run.waiting) info('Watch mode - Waiting for new partitions to evict');

    run.waiting = true;

    return true;
  }

  run.waiting = false;

  if (! first)
    for (const one of found)
      if (one.ready.length > 0) info(`  ${one.venue.padEnd(8)} ${said(one)}`);

  spacer();
  info(loadOf(ready));
  spacer();

  if (options.dryRun) return true;

  const purge = options.purge ?? false;

  if (! run.agreed && ! await agreed(purge ? 'Delete them from disk?' : 'Move them to the trash?', true)) return false;

  run.agreed = true;

  let bytes = 0;

  for (const one of found) {
    if (one.ready.length === 0) continue;

    const removed = await remove(db, config, origin, one, run.archives, purge);

    bytes += removed.bytes;

    info(`  ${one.venue.padEnd(8)} ${removed.files.toLocaleString('en-US')} files ${purge ? 'deleted' : 'moved to the trash'} · ${fmtBytes(removed.bytes)}`);
  }

  spacer();
  success('Evicted. What was removed is in cold storage and in the vault.');

  if (! purge) info(`${fmtBytes(bytes)} is reclaimed once the trash is emptied — nothing is freed until then`);

  // Done for now, and said: the next look is half an hour away.
  if (isWatch()) {
    info('Watch mode - Waiting for new partitions to evict');

    run.waiting = true;
  }

  return true;
};

/** One venue's answer in a line: what can go. What stays, and why, is counted and not said. */
const said = (found: Evictable): string => [
  found.ready.length > 0 ? loadOf(found.ready) : 'nothing to evict',
  ...(found.returned > 0 ? [`${found.returned.toLocaleString('en-US')} of them evicted before and on disk again`] : []),
  ...(found.gone > 0 ? [`${found.gone.toLocaleString('en-US')} already evicted`] : []),
].join(' · ');

/** What these partitions come to, in the catalog's own counts. */
const loadOf = (ready: Evictable['ready']): string => {
  const files = ready.reduce((sum, one) => sum + one.files, 0);
  const bytes = ready.reduce((sum, one) => sum + one.bytes, 0);

  return `${ready.length.toLocaleString('en-US')} partition${ready.length === 1 ? '' : 's'} evictable `
    + `(${files.toLocaleString('en-US')} file${files === 1 ? '' : 's'} · ${fmtBytes(bytes)})`;
};
