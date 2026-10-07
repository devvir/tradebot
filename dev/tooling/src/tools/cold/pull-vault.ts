import fs from 'node:fs';
import path from 'node:path';
import { GB, POLL_MS, loadConfig } from './config';
import { onExit } from './cleanup';
import { acquire } from './lock';
import * as mega from './mega';
import { meter } from './progress';
import { trusted } from './push-vault';
import { agreed } from './options';
import * as record from './record';
import { meansToPull } from './select';
import { locate, remoteOf, stockedIn } from './vault';
import { fmtBytes } from '../../shared/utils/format';
import { error, info, spacer, success, warn } from '../../shared/ui/logger';
import type { DatabaseSync } from 'node:sqlite';
import type { ColdConfig, Fetching, Selection, StoredFile, VaultOptions } from './types';
import { byKey } from './order';

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

/**
 * Ask Mega for every file and wait until each is back. Returns how many never
 * came.
 *
 * All of them are asked for at once: Mega keeps its own queue, which outlives
 * this command, so a run stopped here leaves them coming and the next run finds
 * them arrived. A file Mega drops without delivering is asked for again, up to
 * `ATTEMPTS` times.
 */
const fetch = async (
  db:      DatabaseSync,
  config:  ColdConfig,
  wanted:  readonly StoredFile[],
  remote:  Fetching,
  pollMs = POLL_MS,
): Promise<number> => {
  const local   = (file: StoredFile): string => path.join(config.vaultRoot, file.path);
  const arrived = (file: StoredFile): boolean => {
    try {
      return fs.statSync(local(file)).size === file.bytes;
    } catch {
      return false;
    }
  };

  const tries   = new Map<StoredFile, number>();
  let   pending = [...wanted];
  let   failed  = 0;

  const show = (): void => {
    if (! process.stdout.isTTY) return;

    const done = wanted.length - pending.length - failed;

    process.stdout.write(`\r\x1b[K  ${meter((done / wanted.length) * 100)} ${done}/${wanted.length} files back`);
  };

  for (;;) {
    const coming = await remote.downloadingPaths();
    const still: StoredFile[] = [];
    const back:  StoredFile[] = [];

    for (const file of pending) {
      if (coming.has(local(file))) {
        still.push(file);

        continue;
      }

      if (arrived(file)) {
        back.push(file);

        continue;
      }

      const asked = tries.get(file) ?? 0;

      if (asked >= ATTEMPTS) {
        failed++;

        continue;
      }

      fs.mkdirSync(path.dirname(local(file)), { recursive: true });

      // Whatever is there is not the file: a download cut short, or something else's.
      fs.rmSync(local(file), { force: true });

      await remote.queueDownload(`${config.megaRoot}/${remoteOf(file)}`, path.dirname(local(file)));

      tries.set(file, asked + 1);
      still.push(file);
    }

    record.noteVaultMoves(db, back, 'restored');

    pending = still;

    show();

    if (pending.length === 0) break;

    await new Promise(resolve => setTimeout(resolve, pollMs));
  }

  if (process.stdout.isTTY) process.stdout.write('\r\x1b[K');

  return failed;
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

/** Times a file is asked for before it is given up on for this run. */
const ATTEMPTS = 3;

/** Free space left on the vault's volume after everything asked for is back, at the least. */
const RESERVE_GB = 5;

// ── Test access ───────────────────────────────────────────────────────────────

export const _test_pullable = pullable;
export const _test_fetch    = fetch;
