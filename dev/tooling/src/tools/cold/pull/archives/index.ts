import { onExit } from '../../cleanup';
import { ARCHIVES_RESERVE_GB, GB, loadConfig } from '../../config';
import { Archives } from '../../shared/disk';
import { descriptorOf } from '../../shared/keys';
import { freeBytes, sameVolume } from '../../shared/fs';
import { acquire } from '../../lock';
import * as mega from '../../shared/mega';
import { agreed } from '../../options';
import * as record from '../../shared/record';
import { fmtBytes } from '../../../../shared/utils/format';
import { error, info, spacer, success, warn } from '../../../../shared/ui/logger';
import { survey } from './survey';
import { asideRoot, bring, tarsOf } from './bring';
import { count } from '../../shared/count';
import type { Origin } from '../../types';
import type { Pullable, PullOptions, PullState } from '../types';

/**
 * Bring partitions of the archives back from cold storage.
 *
 * **Asked for by what they are, not by what happened to them**: a venue, and a
 * dataset or a partition of it — see `../filter.ts`. Whatever cold storage holds of
 * that is what is meant, whether it was ever taken off the disk or not.
 *
 * **Where the same data is stored in more than one rendering**, every one of
 * them is meant unless one is preferred — see `Preference`.
 *
 * **What is done with each depends on how it stands** — see `PullState`:
 *
 * - *away*: nothing of it is on disk. It is brought back, and nothing is asked.
 * - *differs*: on disk, at another count or size than was stored. Asked once
 *   for all of them, and yes unless told otherwise.
 * - *same*: on disk exactly as stored. Asked once for all of them, and no
 *   unless told otherwise: bringing it back changes nothing.
 * - *old*: cold storage holds a version the catalog has moved on from. It is
 *   brought back beside the archives and never into them — to `PULLED`, under
 *   cold's own directory — since an older version is something to look at and
 *   nothing to stock from.
 *
 * `--yes` takes each question's own answer; `--force` brings back everything
 * that is on disk already, asking nothing.
 *
 * **A tar comes back whole and is used in part.** It holds the partitions that
 * were packed together, and Mega gives all of it or none: what was asked for
 * is taken out and the rest is dropped with the tar.
 *
 * **Taken out beside the archives, then moved in**, file by file over whatever
 * is there. Nothing in the archives is removed: a file there that the tar does
 * not hold stays where it is.
 *
 * **What comes back into the archives is written down as pulled**, beside its
 * return: it is on disk because it was asked for, and the record says so.
 *
 * **Space is watched, not promised.** What the tars weigh is said against what
 * is free before anything starts, and a tar is not asked for while less than
 * `ARCHIVES_RESERVE_GB` is free — the run waits there until there is room.
 */
export const runPull = async (origin: Origin, options: PullOptions): Promise<void> => {
  const config  = loadConfig(origin);
  const release = await acquire(config.coldRoot, origin, 'pull');

  try {
    const db = record.open(config.dbPath);

    onExit(() => record.close(db));

    try {
      const archives = new Archives(config.sourceRoot);
      const found: Pullable[] = [];

      info('Asking what cold storage holds of that');

      for (const venue of options.venues) {
        const here = await survey(db, config, origin, venue, options, archives);

        info(`  ${venue.padEnd(8)} ${said(here)}`);

        found.push(...here);
      }

      spacer();

      if (found.length === 0) {
        warn('Cold storage holds nothing of that');

        return;
      }

      if (options.dryRun) return;

      const wanted = await chosen(found, options.force ?? false);

      if (wanted.length === 0) {
        success('Nothing to bring back');

        return;
      }

      const tars  = tarsOf(db, wanted);
      const heavy = tars.reduce((sum, tar) => sum + (tar.bytes ?? 0), 0);
      const free  = freeBytes(config.coldRoot);

      info(`${count(wanted.length, 'partition')} in ${count(tars.length, 'tar')} to download (${fmtBytes(heavy)})`);

      // On one volume, the tars and what comes out of them share its room; on two, the archives need their own.
      const apart = ! sameVolume(config.coldRoot, config.sourceRoot);
      const back  = bytesOf(wanted.filter(one => one.state !== 'old'));
      const here  = apart ? heavy + bytesOf(wanted) - back : heavy + bytesOf(wanted);

      if (here + ARCHIVES_RESERVE_GB * GB > free)
        warn(`${fmtBytes(free)} is free: not enough for all of it and ${ARCHIVES_RESERVE_GB}GB spare — it will wait wherever it runs short`);

      if (apart && back + ARCHIVES_RESERVE_GB * GB > freeBytes(config.sourceRoot))
        warn(`${fmtBytes(freeBytes(config.sourceRoot))} is free in the archives: not enough for what comes back and ${ARCHIVES_RESERVE_GB}GB spare — it will wait wherever it runs short`);

      if (! await mega.available()) {
        error('mega-cmd is not available — is the session logged in?');
        process.exitCode = 1;

        return;
      }

      spacer();

      const failed = await bring(db, config, origin, tars, wanted, mega);
      const aside  = wanted.filter(one => one.state === 'old');

      spacer();

      if (aside.length > 0)
        info(`${count(aside.length, 'partition')} of a version the catalog has moved on from ${aside.length === 1 ? 'is' : 'are'} in ${asideRoot(config, origin)}`);

      if (failed > 0) warn(`${count(failed, 'tar')} did not come back — run it again to ask once more`);
      else success('Pulled.');
    } finally {
      record.close(db);
    }
  } finally {
    release();
  }
};

// ── Internals ─────────────────────────────────────────────────────────────────

/**
 * Which of what was found is brought back: what is away and what is old, and
 * of what is on disk already whatever the answers say — one question for each
 * way of being there, however many partitions it is about.
 */
const chosen = async (found: readonly Pullable[], force: boolean): Promise<Pullable[]> => {
  const of = (state: PullState): Pullable[] => found.filter(one => one.state === state);

  const same    = of('same');
  const differs = of('differs');

  const again = same.length > 0 && (force || await agreed(
    `${count(same.length, 'partition')} ${same.length === 1 ? 'is' : 'are'} on disk exactly as stored — same version, count and size. Pull anyway?`, false));

  const over = differs.length > 0 && (force || await agreed(
    `${count(differs.length, 'partition')} ${differs.length === 1 ? 'is' : 'are'} on disk at another count or size than was stored. Pull over ${differs.length === 1 ? 'it' : 'them'}?`, true));

  return [...of('away'), ...of('old'), ...(again ? same : []), ...(over ? differs : [])];
};

const bytesOf = (found: readonly Pullable[]): number => found.reduce((sum, one) => sum + one.held.bytes, 0);

/** What was found of a venue, in a line: how many partitions stand each way. */
const said = (found: readonly Pullable[]): string => {
  if (found.length === 0) return 'nothing stored';

  const of = (state: PullState): Pullable[] => found.filter(one => one.state === state);

  const parts = ([
    ['away', 'not on disk'], ['differs', 'on disk, differing'], ['same', 'on disk as stored'], ['old', 'of an older version'],
  ] as const).filter(([state]) => of(state).length > 0).map(([state, words]) => `${of(state).length.toLocaleString('en-US')} ${words}`);

  const datasets = new Set(found.map(one => `${one.held.market}/${descriptorOf(one.held)}`)).size;

  return `${count(found.length, 'partition')} of ${count(datasets, 'dataset')} (${fmtBytes(bytesOf(found))}) — ${parts.join(', ')}`;
};

// ── Test access ───────────────────────────────────────────────────────────────

export const _test_chosen = chosen;
