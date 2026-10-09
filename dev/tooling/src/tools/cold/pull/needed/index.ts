import { recordOf, save } from '../../shared/backup';
import { onExit } from '../../cleanup';
import { GB, WATCH_MS, loadConfig } from '../../config';
import { acquire } from '../../lock';
import * as mega from '../../shared/mega';
import { agreed, isWatch } from '../../options';
import * as record from '../../shared/record';
import { fetch } from '../../shared/vault/fetch';
import { neededOf } from '../../shared/vault/needed';
import { RESERVE_GB, bring } from '../archives/bring';
import { count, freeBytes, tarsOf } from '../archives';
import { fmtBytes } from '../../../../shared/utils/format';
import { error, info, spacer, success, warn } from '../../../../shared/ui/logger';
import type { DatabaseSync } from 'node:sqlite';
import type { Needed, StoredFile } from '../../shared/types';
import type { Tar } from '../../types';

/**
 * Bring back from cold storage whatever the vault waits for — see
 * `shared/vault/needed.ts`: the archives an outdated partition is stocked
 * again from, and the vault files a neighbouring month's hours are added
 * beside.
 *
 * **Asked for by what it is for, and by nothing else.** There is no venue and
 * no dataset to name: what comes back is what a partition is stuck without,
 * and whoever stocks the vault does the rest as it finds the files there.
 *
 * **What it would bring is said first, with what it weighs, and then asked.**
 * A tar comes back whole, so the archives weigh what their tars do.
 *
 * **No more than there is room for.** Tars are taken oldest first for as long
 * as they and what comes out of them leave `RESERVE_GB` free; the rest is said
 * and left for a later run, when what was brought has been stocked and has gone
 * again.
 *
 * **Watching, it looks again at intervals** and brings what has come to be
 * waited for since. It asks before the first time and not again.
 */
export const runPullNeeded = async (options: { dryRun?: boolean }): Promise<void> => {
  const config   = loadConfig('archives');
  const releases = [await acquire(config.coldRoot, 'archives', 'pull'), await acquire(config.coldRoot, 'vault', 'pull')];

  try {
    const db = record.open(config.dbPath);

    onExit(() => record.close(db));

    try {
      for (let asked = false; ; ) {
        const needed = await neededOf(db);
        const tars   = tarsOf(db, needed.archives);

        say(needed, tars);

        const wanted = fitting(needed, tars, freeBytes(config.coldRoot));

        if (wanted.left > 0)
          warn(`${count(wanted.left, 'tar')} more than there is room for (${fmtBytes(freeBytes(config.coldRoot))} free, ${RESERVE_GB}GB kept) — brought by a later run, once what is brought now has been stocked and evicted`);

        if (! options.dryRun && wanted.tars.length + wanted.vault.length > 0) {
          if (! await mega.available()) {
            error('mega-cmd is not available — is the session logged in?');

            return;
          }

          if (! asked && ! await agreed('Bring them back?', true)) return;

          asked = true;

          await brought(db, wanted.vault, wanted.tars, needed);
        }

        if (options.dryRun || ! isWatch()) return;

        await save(config, [recordOf(config)]);

        await new Promise(resolve => setTimeout(resolve, WATCH_MS));
      }
    } finally {
      record.close(db);
    }
  } finally {
    for (const release of releases) release();
  }
};

/**
 * What of it there is room for: the vault's files, which are small and wait on
 * nothing, then tars in order for as long as each, and what comes out of it,
 * leaves the reserve free. `left` is how many tars do not fit.
 */
export const fitting = (
  needed:  Needed,
  tars:    readonly Tar[],
  free:    number,
  reserve = RESERVE_GB * GB,
): { vault: StoredFile[]; tars: Tar[]; left: number } => {
  let room = free - reserve;

  const vault = needed.vault.reduce((sum, file) => sum + file.bytes, 0) <= room ? needed.vault : [];

  room -= vault.reduce((sum, file) => sum + file.bytes, 0);

  const taken: Tar[] = [];

  for (const tar of tars) {
    // A tar and what is taken out of it are both on disk for a moment; what stays is what is taken out.
    const out = needed.archives.filter(one => one.held.tarId === tar.id).reduce((sum, one) => sum + one.held.bytes, 0);

    if ((tar.bytes ?? 0) + out > room) break;

    room -= out;

    taken.push(tar);
  }

  return { vault: [...vault], tars: taken, left: tars.length - taken.length };
};

// ── Internals ─────────────────────────────────────────────────────────────────

/** Bring the vault's files, then each tar, and say how it went. */
const brought = async (db: DatabaseSync, files: readonly StoredFile[], tars: readonly Tar[], needed: Needed): Promise<void> => {
  spacer();

  const lost    = files.length > 0 ? await fetch(db, loadConfig('vault'), files, mega) : 0;
  const mine    = new Set(tars.map(tar => tar.id));
  const missing = tars.length > 0
    ? await bring(db, loadConfig('archives'), 'archives', tars, needed.archives.filter(one => mine.has(one.held.tarId)), mega)
    : 0;

  spacer();

  if (lost + missing > 0) warn(`${count(lost, 'vault file')} and ${count(missing, 'tar')} did not come back — asked for again by the next run`);
  else success('Pulled. What the vault waited for is on disk.');
};

/** What the vault waits for, in a few lines. */
const say = (needed: Needed, tars: readonly Tar[]): void => {
  if (needed.archives.length + needed.vault.length + needed.unstored.length === 0) {
    success('The vault waits for nothing that is in cold storage');

    return;
  }

  info(`${count(needed.partitions, 'vault partition')} cannot be completed without files that are not on disk`);

  if (needed.archives.length > 0)
    info(`  to stock again     ${count(needed.archives.length, 'partition')} of the archives, in ${count(tars.length, 'tar')} `
      + `(${fmtBytes(tars.reduce((sum, tar) => sum + (tar.bytes ?? 0), 0))} to download)`);

  if (needed.vault.length > 0)
    info(`  to add a neighbour's hours   ${count(needed.vault.length, 'vault file')} (${fmtBytes(needed.vault.reduce((sum, file) => sum + file.bytes, 0))})`);

  if (needed.unstored.length > 0) {
    warn(`  ${count(needed.unstored.length, 'partition')} of the archives ${needed.unstored.length === 1 ? 'is' : 'are'} not in cold storage as the catalog has ${needed.unstored.length === 1 ? 'it' : 'them'} — `
      + 'to be downloaded from the venue, not brought back');

    for (const one of needed.unstored.slice(0, 5)) info(`    ${one}`);
  }

  spacer();
};
