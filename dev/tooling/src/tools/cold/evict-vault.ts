import fs from 'node:fs';
import path from 'node:path';
import { loadConfig } from './config';
import { onExit } from './cleanup';
import { discard } from './discard';
import { acquire } from './lock';
import { meter } from './progress';
import { trusted } from './push-vault';
import { agreed } from './options';
import * as record from './record';
import { meansToEvict } from './select';
import { locate, stockedIn } from './vault';
import { fmtBytes } from '../../shared/utils/format';
import { info, spacer, success } from '../../shared/ui/logger';
import type { DatabaseSync } from 'node:sqlite';
import type { ColdConfig, Selection, StoredFile, VaultOptions } from './types';

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
 * its way, or stocked again since it was stored, stays. The ledger is read
 * again as each partition's turn comes: a file's path does not say which
 * revision it is of, so one stocked again in the meantime is only told by that.
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
    if (! trusted(config)) return;

    const db = record.open(config.dbPath);

    onExit(() => record.close(db));

    try {
      const going = evictable(db, config, selection);

      if (going.length === 0) {
        success('Nothing of that is on disk and in cold storage — nothing to evict');

        return;
      }

      info('What of the vault can leave the disk');

      for (const [venue, files] of byVenue(going)) info(`  ${venue.padEnd(8)} ${loadOf(files)}`);

      spacer();
      info(loadOf(going));
      spacer();

      if (options.dryRun) return;

      const purge = options.purge ?? false;

      if (! await agreed(purge ? 'Delete them from disk?' : 'Move them to the trash?', false)) return;

      for (const [venue, files] of byVenue(going)) {
        await remove(db, config, venue, files, purge);

        info(`  ${venue.padEnd(8)} ${files.length.toLocaleString('en-US')} files ${purge ? 'deleted' : 'moved to the trash'} · ${fmtBytes(bytesOf(files))}`);
      }

      spacer();
      success('Evicted. What was removed is in cold storage, and `cold pull vault` brings it back.');

      if (! purge) info(`${fmtBytes(bytesOf(going))} is reclaimed once the trash is emptied — nothing is freed until then`);
    } finally {
      record.close(db);
    }
  } finally {
    release();
  }
};

// ── Internals ─────────────────────────────────────────────────────────────────

/**
 * The files a selection means that can go: of a partition cold storage holds at
 * the revision the ledger has now, and not already away.
 *
 * Decided from the ledger and the record. The disk is not asked.
 */
const evictable = (db: DatabaseSync, config: ColdConfig, selection: Selection): StoredFile[] => {
  const current = new Map((stockedIn(config.vaultRoot) ?? []).map(one => [one.partition, one.revision]));
  const stored  = record.vaultStored(db);

  return record.vaultFiles(db).filter(file =>
    current.get(file.partition) === file.revision
    && (stored.get(file.partition)?.has(file.revision) ?? false)
    && file.evictedAt === null
    && meansToEvict(selection, file.partition, file.instrument));
};

/** Remove one venue's files, a partition at a time, and write down each as it goes. */
const remove = async (
  db:     DatabaseSync,
  config: ColdConfig,
  venue:  string,
  files:  readonly StoredFile[],
  purge:  boolean,
): Promise<void> => {
  const partitions = [...new Set(files.map(file => file.partition))];

  let done = 0;

  const show = (): void => {
    if (! process.stdout.isTTY) return;

    process.stdout.write(`\r\x1b[K  ${venue.padEnd(8)} ${meter((done / partitions.length) * 100)} ${done}/${partitions.length} partitions`);
  };

  show();

  for (const partition of partitions) {
    const own = files.filter(file => file.partition === partition);
    const now = stockedIn(config.vaultRoot)?.find(one => one.partition === partition)?.revision;

    // Stocked again, or being stocked, since it was listed: what is at those paths is not what cold storage holds.
    if (now !== own[0]!.revision) {
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

  if (process.stdout.isTTY) process.stdout.write('\r\x1b[K');
};

const byVenue = (files: readonly StoredFile[]): Map<string, StoredFile[]> => {
  const venues = new Map<string, StoredFile[]>();

  for (const file of files) {
    const venue = locate(file.partition).levels['venue'] ?? '';

    venues.set(venue, [...venues.get(venue) ?? [], file]);
  }

  return new Map([...venues].sort());
};

const bytesOf = (files: readonly StoredFile[]): number => files.reduce((sum, file) => sum + file.bytes, 0);

const loadOf = (files: readonly StoredFile[]): string => {
  const partitions = new Set(files.map(file => file.partition)).size;

  return `${files.length.toLocaleString('en-US')} file${files.length === 1 ? '' : 's'} evictable `
    + `in ${partitions.toLocaleString('en-US')} partition${partitions === 1 ? '' : 's'} (${fmtBytes(bytesOf(files))})`;
};

// ── Test access ───────────────────────────────────────────────────────────────

export const _test_evictable = evictable;
export const _test_remove    = remove;
