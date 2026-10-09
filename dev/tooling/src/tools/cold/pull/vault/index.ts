import fs from 'node:fs';
import { GB, loadConfig } from '../../config';
import { onExit } from '../../cleanup';
import { acquire } from '../../lock';
import * as mega from '../../shared/mega';
import { trusted } from '../../shared/vault/trusted';
import { agreed } from '../../options';
import * as record from '../../shared/record';
import { meansToPull } from '../../shared/vault/select';
import { locate } from '../../shared/vault/layout';
import { stockedIn } from '../../shared/vault/ledger';
import { fmtBytes } from '../../../../shared/utils/format';
import { error, info, spacer, success, warn } from '../../../../shared/ui/logger';
import { byKey } from '../../order';
import { fetch } from '../../shared/vault/fetch';
import { notice } from '../../shared/vault/needed';
import type { DatabaseSync } from 'node:sqlite';
import type { ColdConfig, Selection } from '../../types';
import type { StoredFile, VaultOptions } from '../../shared/types';

/**
 * Bring vault files back from cold storage to the local disk.
 *
 * **The other half of `evict`, and selected the same way**: by venue, market,
 * dataset, variant, months and instruments. What comes back is the files of
 * that selection that are away, each to the place in the vault it was taken
 * from — so the vault reads afterwards exactly as it did before they left.
 *
 * **Down to one instrument, where the month allows it.** A large month is a
 * file per instrument and only the ones asked for come back. A small month is
 * one file holding every instrument, so asking for one instrument of it brings
 * that file: the rows are nowhere else.
 *
 * **Only what the ledger still holds.** A file of a revision the vault has
 * since restocked is not brought back: the vault has the newer one.
 *
 * **Confirmed from the disk, never from an exit code.** A file is back when it
 * is there at the size it was stored at and Mega is no longer writing it. A
 * file already there at that size was put back by an earlier run, and is
 * simply written down as back.
 */
export const runPullVault = async (selection: Selection, options: VaultOptions): Promise<void> => {
  const config  = loadConfig('vault');
  const release = await acquire(config.coldRoot, 'vault', 'pull');

  try {
    if (! trusted(config)) return;

    const db = record.open(config.dbPath);

    onExit(() => record.close(db));

    try {
      await notice(db);

      const wanted = pullable(db, config, selection);

      if (wanted.length === 0) {
        success('Nothing of that is away — everything it means is on disk');

        return;
      }

      info('What of the vault can be brought back');

      for (const [venue, files] of byVenue(wanted)) info(`  ${venue.padEnd(8)} ${loadOf(files)}`);

      spacer();
      info(loadOf(wanted));
      spacer();

      if (options.dryRun) return;

      const free = freeBytes(config.vaultRoot);

      if (bytesOf(wanted) + RESERVE_GB * GB > free) {
        error(`That is ${fmtBytes(bytesOf(wanted))}, and the vault's volume has ${fmtBytes(free)} free — `
          + `not enough to bring it back and leave ${RESERVE_GB}GB spare`);

        process.exitCode = 1;

        return;
      }

      if (! await mega.available()) {
        error('mega-cmd is not available — is the session logged in?');

        return;
      }

      if (! await agreed('Bring them back?', true)) return;

      const failed = await fetch(db, config, wanted, mega);

      spacer();

      if (failed > 0) warn(`${failed} file${failed === 1 ? '' : 's'} did not come back — run it again to ask for ${failed === 1 ? 'it' : 'them'} once more`);
      else success('Pulled. The vault holds everything that was asked for.');
    } finally {
      record.close(db);
    }
  } finally {
    release();
  }
};

// ── Internals ─────────────────────────────────────────────────────────────────

/**
 * The files a selection means that are away and can come back: of the revision
 * the ledger has now, in cold storage, and taken off the disk.
 */
const pullable = (db: DatabaseSync, config: ColdConfig, selection: Selection): StoredFile[] => {
  const current = new Map((stockedIn(config.vaultRoot) ?? []).map(one => [one.partition, one.revision]));

  return record.vaultFiles(db).filter(file =>
    current.get(file.partition) === file.revision
    && file.state === 'stored'
    && file.evictedAt !== null
    && meansToPull(selection, file.partition, file.instrument));
};

const freeBytes = (dir: string): number => {
  const info = fs.statfsSync(dir);

  return info.bavail * info.bsize;
};

const byVenue = (files: readonly StoredFile[]): Map<string, StoredFile[]> => {
  const venues = new Map<string, StoredFile[]>();

  for (const file of files) {
    const venue = locate(file.partition).levels['venue'] ?? '';

    venues.set(venue, [...venues.get(venue) ?? [], file]);
  }

  return new Map([...venues].sort(byKey));
};

const bytesOf = (files: readonly StoredFile[]): number => files.reduce((sum, file) => sum + file.bytes, 0);

const loadOf = (files: readonly StoredFile[]): string => {
  const partitions = new Set(files.map(file => file.partition)).size;

  return `${files.length.toLocaleString('en-US')} file${files.length === 1 ? '' : 's'} away `
    + `in ${partitions.toLocaleString('en-US')} partition${partitions === 1 ? '' : 's'} (${fmtBytes(bytesOf(files))})`;
};

/** Free space left on the vault's volume after everything asked for is back, at the least. */
const RESERVE_GB = 5;

// ── Test access ───────────────────────────────────────────────────────────────

export const _test_pullable = pullable;
