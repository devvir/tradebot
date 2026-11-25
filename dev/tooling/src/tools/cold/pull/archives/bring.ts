import fs from 'node:fs';
import path from 'node:path';
import { ARCHIVES_RESERVE_GB, GB, POLL_MS, remotePath } from '../../config';
import { matches } from '../../shared/disk';
import { idOf, partitionOf } from '../../shared/keys';
import * as record from '../../shared/record';
import { Progress } from '../../shared/progress';
import { follow } from '../../shared/progress-mega';
import { extractMembers, sizedMembersOf } from '../../shared/tar';
import { fmtBytes } from '../../../../shared/utils/format';
import { warn } from '../../../../shared/ui/logger';
import { freeBytes, moveFile, sameVolume } from '../../shared/fs';
import { count } from '../../shared/count';
import type { DatabaseSync } from 'node:sqlite';
import type { ColdConfig, Origin, Tar } from '../../types';
import type { Pullable } from '../types';
import type { Fetching } from '../../shared/types';
import type { SourceFile } from '../../shared/types';

/**
 * Bring each tar back, take out of it what was asked for, and drop it. One at
 * a time, so no more than one tar and what comes out of it is ever on disk
 * beside the archives. Returns how many tars never came.
 *
 * `scratch` names the run's own folder under `<cold>/pulling`, where its tars
 * come and are taken apart: the origin's, unless the run keeps its own.
 */
export const bring = async (
  db:      DatabaseSync,
  config:  ColdConfig,
  origin:  Origin,
  tars:    readonly Tar[],
  wanted:  readonly Pullable[],
  remote:  Fetching,
  pollMs  = POLL_MS,
  reserve = ARCHIVES_RESERVE_GB * GB,
  scratch: string = origin,
): Promise<number> => {
  const progress = new Progress();
  const heavy    = tars.reduce((sum, tar) => sum + (tar.bytes ?? 0), 0);

  let failed = 0;
  let back   = 0;

  try {
    for (const [at, tar] of tars.entries()) {
      const local = path.join(config.coldRoot, PULLING, scratch, tar.local);
      const mine  = wanted.filter(one => one.held.tarId === tar.id);
      const label = `${path.basename(tar.local)} (${at + 1}/${tars.length})`;

      await room(config, pollMs, reserve, mine.filter(one => one.state !== 'old').reduce((sum, one) => sum + one.held.bytes, 0));

      // Two lines: all of the tars together, and the one on its way.
      if (tars.length > 1) progress.set(ALL, { label: `${count(tars.length, 'tar')}`, done: back, total: heavy, unit: 'bytes' });

      const unfollow = remote.transfers
        ? follow(progress, { id: ONE, queue: 'downloads', mine: to => to === local, label: () => label, idle: `${label} · waiting for Mega`, mark: '↓', rank: 1, read: remote.transfers })
        : null;

      const came = await fetched(config, tar, local, remote, pollMs);

      unfollow?.();

      if (! came) {
        failed++;

        progress.log(`${label} did not come back`, warn);

        continue;
      }

      const files = await unpack(config, origin, local, mine);

      for (const one of mine) if (one.state !== 'old') record.noteReturn(db, origin, one.held);

      await fs.promises.rm(local, { force: true });

      back += tar.bytes ?? 0;

      progress.log(`Pulled ${label} · ${fmtBytes(tar.bytes ?? 0)} · ${count(mine.length, 'partition')} taken out of it · ${count(files, 'file')}`);
    }
  } finally {
    progress.stop();
  }

  return failed;
};

/** Where partitions of a version the catalog has moved on from are put. */
export const asideRoot = (config: ColdConfig, origin: Origin): string => path.join(config.coldRoot, PULLED, origin);

/** The tars these partitions are in, oldest month first. */
export const tarsOf = (db: DatabaseSync, wanted: readonly Pullable[]): Tar[] =>
  [...new Set(wanted.map(one => one.held.tarId))]
    .map(id => record.tarById(db, id))
    .sort((a, b) => (a.local < b.local ? -1 : a.local > b.local ? 1 : 0));

// ── Internals ─────────────────────────────────────────────────────────────────

/**
 * Wait until cold's own volume has `reserve` free, saying so once. Where the
 * archives are on another volume, what comes back into them (`back` bytes) is
 * not on cold's, so theirs is waited on too: for that much and `reserve` more.
 */
const room = async (config: ColdConfig, pollMs: number, reserve: number, back: number): Promise<void> => {
  const apart = ! sameVolume(config.coldRoot, config.sourceRoot);
  const short = (): string | null => {
    if (freeBytes(config.coldRoot) < reserve) return `Less than ${fmtBytes(reserve)} free (${fmtBytes(freeBytes(config.coldRoot))})`;

    if (apart && freeBytes(config.sourceRoot) < back + reserve)
      return `Less than ${fmtBytes(back + reserve)} free in the archives (${fmtBytes(freeBytes(config.sourceRoot))})`;

    return null;
  };

  let said = false;

  for (let why = short(); why; why = short()) {
    if (! said) warn(`${why} — waiting for room before the next tar`);

    said = true;

    await new Promise(resolve => setTimeout(resolve, pollMs));
  }
};

/**
 * Ask Mega for a tar and wait until it is here: at the size it was stored at,
 * and no longer being written. One already here at that size was brought by a
 * run that stopped, and is used. Asked again where Mega drops it: `ATTEMPTS`
 * times at the most in all, the first time included.
 */
const fetched = async (config: ColdConfig, tar: Tar, local: string, remote: Fetching, pollMs: number): Promise<boolean> => {
  const whole = (): boolean => fs.existsSync(local) && fs.statSync(local).size === tar.bytes;

  for (let asked = 0; ;) {
    const coming = (await remote.downloadingPaths()).has(local);

    if (! coming && whole()) return true;

    if (! coming) {
      if (asked >= ATTEMPTS) return false;

      await fs.promises.mkdir(path.dirname(local), { recursive: true });
      await fs.promises.rm(local, { force: true });
      await remote.queueDownload(remotePath(config, tar), path.dirname(local));

      asked++;
    }

    await new Promise(resolve => setTimeout(resolve, pollMs));
  }
};

/**
 * Take the files of these partitions out of a tar: into the archives, by way
 * of a directory beside the tar, or — for a version the catalog has moved on
 * from — into `PULLED` and no further. Returns how many files came out.
 *
 * Each file is moved from that directory into the archives: a rename on one
 * volume, a copy where the archives are on another — see `moveFile`.
 *
 * A partition the tar does not hold as the record says is still taken out, and
 * said: what is there is what there is to have.
 */
const unpack = async (config: ColdConfig, origin: Origin, local: string, wanted: readonly Pullable[]): Promise<number> => {
  const byId    = new Map(wanted.map(one => [idOf(one.held), one]));
  const members = new Map<Pullable, SourceFile[]>(wanted.map(one => [one, []]));

  for (const member of await sizedMembersOf(local)) {
    const key = partitionOf(member.path);
    const one = key ? byId.get(idOf(key)) : undefined;

    if (one) members.get(one)!.push(member);
  }

  for (const [one, files] of members)
    if (! matches(files, one.held))
      warn(`  ${idOf(one.held)}: the tar holds ${count(files.length, 'file')} of it where the record says ${one.held.files}`);

  const pathsOf = (old: boolean): string[] =>
    [...members].filter(([one]) => (one.state === 'old') === old).flatMap(([, files]) => files.map(file => file.path));

  const aside = pathsOf(true);
  const back  = pathsOf(false);
  const stage = `${local}.out`;

  if (aside.length > 0) await extractMembers(local, asideRoot(config, origin), aside);

  if (back.length > 0) {
    await fs.promises.rm(stage, { recursive: true, force: true });
    await extractMembers(local, stage, back);

    for (const member of back) {
      const target = path.join(config.sourceRoot, member);

      await fs.promises.mkdir(path.dirname(target), { recursive: true });
      await moveFile(path.join(stage, member), target);
    }

    await fs.promises.rm(stage, { recursive: true, force: true });
  }

  return aside.length + back.length;
};

/** Below cold's own directory: tars on their way back, and what an older version is taken out to. */
const PULLING = 'pulling';
const PULLED  = 'pulled';

/** The block's two lines: every tar together, and the one on its way. */
const ALL = 'all';
const ONE = 'one';

/** Times a tar is asked for in all, the first time included, before it is given up on for this run. */
const ATTEMPTS = 3;
