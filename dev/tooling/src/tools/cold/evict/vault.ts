import fs from 'node:fs';
import { Archives } from '../shared/disk';
import { completable } from '../shared/vault/spill';
import path from 'node:path';
import { loadConfig, WATCH_MS } from '../config';
import { onExit } from '../cleanup';
import { recordOf, save } from '../shared/backup';
import { discard } from './discard';
import { acquire } from '../lock';
import { Progress } from '../shared/progress';
import { trusted } from '../shared/vault/trusted';
import { agreed, isWatch } from '../options';
import * as record from '../shared/record';
import { meansToEvict } from '../shared/vault/select';
import { LEDGER, stockedIn } from '../shared/vault/ledger';
import { byVenue, bytesOf, loadOf } from '../shared/vault/files';
import { groupBy } from '../shared/group';
import { fmtBytes } from '../../../shared/utils/format';
import { info, spacer, success } from '../../../shared/ui/logger';
import { notice } from '../shared/vault/needed';
import type { DatabaseSync } from 'node:sqlite';
import type { ColdConfig, Selection } from '../types';
import type { Stocked, StoredFile, VaultOptions } from '../shared/types';

/**
 * Take vault files off the local disk, to make room.
 *
 * **What leaves is what was asked for**: a selection by venue, market, dataset,
 * variant, months and instruments — or, with nothing to narrow it, everything
 * cold storage holds. This is ordinary housekeeping on a machine smaller than
 * its data. While nothing is reading the vault, all of it can go and make room
 * for more to be stocked; once something is, what is being worked on stays and
 * the rest goes; and `pull` brings any of it back.
 *
 * **A file can go once its partition is in cold storage at the revision the
 * ledger has.** A partition is stored whole or not at all, so a file of a
 * stored partition is in cold storage itself — and one of a partition still on
 * its way, or stocked again since it was stored, stays. The ledger is looked at
 * again as each partition's turn comes, and read again wherever it has changed:
 * a file's path does not say which revision it is of, so one stocked again in
 * the meantime is only told by that.
 *
 * **A push of the vault may be running meanwhile**, and is not kept out: each
 * command takes a lock of its own (`lock.ts`). Push stores only what the record
 * does not hold at the ledger's revision, which is never what goes here.
 *
 * **A file is the unit here, where a partition is the unit that is stored.** A
 * small month is one file and goes whole. A large month is a file per
 * instrument, and any of them can go while the others stay.
 *
 * Nothing is written into the vault. That a partition has a safe copy was said
 * when it was stored (`backedup.csv`), and from then on what is on disk of it
 * is nobody's concern but this record's.
 */
export const runEvictVault = async (selection: Selection, options: VaultOptions): Promise<void> => {
  const config  = loadConfig('vault');
  const release = await acquire(config.coldRoot, 'vault', 'evict');

  try {
    const db = record.open(config.dbPath);

    onExit(() => record.close(db));

    try {
      const run: Run = { agreed: false, waiting: false };

      /**
       * **Watching, the same is asked again at intervals.** What can go changes
       * as partitions are stored, so a run left going removes each file as it
       * becomes removable. It asks before the first removal and not again: the
       * answer was to the kind of thing being removed, and that does not change
       * between one look and the next.
       */
      for (let first = true; ; first = false) {
        if (! await pass(db, config, selection, options, run, first)) return;

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

/** What one run carries from one look to the next. */
interface Run {
  /** Whether removing was agreed to: asked before the first removal of a run, and not again. */
  agreed:  boolean;

  /** Whether a watching run has said that it is waiting, since it last had something to do. */
  waiting: boolean;
}

/**
 * Look once at what can go, and remove it. Says whether the run goes on: false
 * where the vault's account cannot be gone by and nobody is watching, or where
 * removing was refused.
 *
 * **The first look says everything it finds; a later one only what it has to
 * do.** A run that is watching and finds nothing says so once, and then stays
 * quiet until there is something.
 */
const pass = async (
  db:        DatabaseSync,
  config:    ColdConfig,
  selection: Selection,
  options:   VaultOptions,
  run:       Run,
  first:     boolean,
): Promise<boolean> => {
  // Read on every look: the vault is stocked while this runs, and may report a loss while it does. Left watching, it looks again later.
  const trust = trusted(config, { watching: isWatch() });

  if (! trust.ok) return trust.retry;

  const { stocked } = trust;

  if (first) await notice(db);

  /**
   * **A partition that is about to be completed stays.** It was stocked
   * without the hours a neighbouring month holds of it, and that month's
   * archives are on disk now: whoever stocks the vault adds those hours
   * beside the partition's own files, and needs them here to do it.
   */
  const waiting = new Set((await completable(config, new Archives(loadConfig('archives').sourceRoot), stocked)).map(one => one.partition));

  const { going, kept } = leaving(evictable(db, config, selection, stocked), waiting);

  if (kept > 0 && (first || going.length > 0))
    info(`${kept.toLocaleString('en-US')} partition${kept === 1 ? ' stays' : 's stay'}: the month beside ${kept === 1 ? 'it' : 'them'} is on disk, and stocker needs ${kept === 1 ? 'its' : 'their'} main file to add the spill`);

  if (going.length === 0) {
    if (! isWatch()) success('Nothing of that is on disk and in cold storage — nothing to evict');
    else if (! run.waiting) info('Watch mode - Waiting for vault files to evict');

    run.waiting = true;

    return true;
  }

  run.waiting = false;

  info('What of the vault can leave the disk');

  for (const [venue, files] of byVenue(going)) info(`  ${venue.padEnd(8)} ${loadOf(files, EVICTABLE)}`);

  spacer();
  info(loadOf(going, EVICTABLE));
  spacer();

  if (options.dryRun) return true;

  const purge = options.purge ?? false;

  if (! run.agreed && ! await agreed(purge ? 'Delete them from disk?' : 'Move them to the trash?', true)) return false;

  run.agreed = true;

  for (const [venue, files] of byVenue(going)) {
    await remove(db, config, venue, files, purge);

    info(`  ${venue.padEnd(8)} ${files.length.toLocaleString('en-US')} files ${purge ? 'deleted' : 'moved to the trash'} · ${fmtBytes(bytesOf(files))}`);
  }

  spacer();
  success('Evicted. What was removed is in cold storage, and `cold pull vault` brings it back.');

  if (! purge) info(`${fmtBytes(bytesOf(going))} is reclaimed once the trash is emptied — nothing is freed until then`);

  // Done for now, and said: the next look is half an hour away.
  if (isWatch()) {
    info('Watch mode - Waiting for vault files to evict');

    run.waiting = true;
  }

  return true;
};

/**
 * The files a selection means that can go: of a partition cold storage holds at
 * the revision the ledger has (`stocked`, as read), and not already away.
 *
 * Decided from the ledger and the record. The disk is not asked.
 */
const evictable = (
  db:        DatabaseSync,
  config:    ColdConfig,
  selection: Selection,
  stocked:   readonly Stocked[] = stockedIn(config.vaultRoot) ?? [],
): StoredFile[] => {
  const current = new Map(stocked.map(one => [one.partition, one.revision]));
  const stored  = record.vaultStored(db);

  return record.vaultFiles(db).filter(file =>
    current.get(file.partition) === file.revision
    && (stored.get(file.partition)?.has(file.revision) ?? false)
    && file.evictedAt === null
    && meansToEvict(selection, file.partition, file.instrument));
};

/** Of the files that can go, those that do, and how many partitions stay because they are `waiting` to be completed. */
const leaving = (files: readonly StoredFile[], waiting: ReadonlySet<string>): { going: StoredFile[]; kept: number } => ({
  going: files.filter(file => ! waiting.has(file.partition)),
  kept:  new Set(files.filter(file => waiting.has(file.partition)).map(file => file.partition)).size,
});

/** Remove one venue's files, a partition at a time, and write down each as it goes. */
const remove = async (
  db:     DatabaseSync,
  config: ColdConfig,
  venue:  string,
  files:  readonly StoredFile[],
  purge:  boolean,
): Promise<void> => {
  const partitions = groupBy(files, file => file.partition);
  const revisionOf = ledgerNow(config.vaultRoot);

  let done = 0;

  const progress = new Progress();

  const show = (): void => progress.set(venue, { label: venue.padEnd(8), done, total: partitions.size, unit: 'count', of: 'partitions' });

  show();

  for (const [partition, own] of partitions) {
    // Stocked again, or being stocked, since it was listed: what is at those paths is not what cold storage holds.
    if (revisionOf(partition) !== own[0]!.revision) {
      done++;
      show();

      continue;
    }

    await discard(own.map(file => path.join(config.vaultRoot, file.path)), purge);

    // An instrument's directory, where this month was all it held.
    for (const file of own) {
      if (path.basename(path.dirname(file.path)) === '@') continue;

      try {
        fs.rmdirSync(path.join(config.vaultRoot, path.dirname(file.path)));
      } catch {
        // Other months of the instrument are still in it.
      }
    }

    record.noteVaultMoves(db, own, 'evicted');

    done++;
    show();
  }

  progress.stop();
};

/**
 * The revision the ledger has of a partition now — asked as each partition's
 * turn comes. The ledger is read again only where it has changed since it was
 * last read (its inode, size and modification time), so a run over thousands
 * of partitions reads it once while nothing stocks the vault. Where there is no
 * ledger, no partition has a revision.
 */
const ledgerNow = (vaultRoot: string): ((partition: string) => string | undefined) => {
  let seen: string | null = null;
  let now = new Map<string, string>();

  return (partition) => {
    const stats = fs.statSync(path.join(vaultRoot, LEDGER), { throwIfNoEntry: false });
    const at    = stats ? `${stats.ino}|${stats.size}|${stats.mtimeMs}` : '';

    if (at !== seen) {
      now  = new Map((stats ? stockedIn(vaultRoot) ?? [] : []).map(one => [one.partition, one.revision]));
      seen = at;
    }

    return now.get(partition);
  };
};

/** How a file that can go stands, in a line about it. */
const EVICTABLE = 'evictable';

// ── Test access ───────────────────────────────────────────────────────────────

export const _test_evictable = evictable;

export const _test_byVenue   = byVenue;

export const _test_leaving   = leaving;

export const _test_remove    = remove;
