import fs from 'node:fs';
import path from 'node:path';
import { GB, POLL_MS, remotePath } from '../../config';
import { matches } from '../../shared/disk';
import { idOf, partitionOf } from '../../shared/keys';
import * as record from '../../shared/record';
import { extractMembers, sizedMembersOf } from '../../shared/tar';
import { fmtBytes } from '../../../../shared/utils/format';
import { info, warn } from '../../../../shared/ui/logger';
import { asideRoot, count, freeBytes } from '.';
import type { DatabaseSync } from 'node:sqlite';
import type { ColdConfig, Origin, Tar } from '../../types';
import type { Fetching, Pullable } from '../types';
import type { SourceFile } from '../../shared/types';

/**
 * Bring each tar back, take out of it what was asked for, and drop it. One at
 * a time, so no more than one tar and what comes out of it is ever on disk
 * beside the archives. Returns how many tars never came.
 */
export const bring = async (
  db:      DatabaseSync,
  config:  ColdConfig,
  origin:  Origin,
  tars:    readonly Tar[],
  wanted:  readonly Pullable[],
  remote:  Fetching,
  pollMs  = POLL_MS,
  reserve = RESERVE_GB * GB,
): Promise<number> => {
  let failed = 0;

  for (const [at, tar] of tars.entries()) {
    const local = path.join(config.coldRoot, PULLING, origin, tar.local);
    const mine  = wanted.filter(one => one.held.tarId === tar.id);
    const label = `${path.basename(tar.local)} (${at + 1}/${tars.length})`;

    await room(config, pollMs, reserve);

    info(`Downloading ${label} · ${fmtBytes(tar.bytes ?? 0)}`);

    if (! await fetched(config, tar, local, remote, pollMs)) {
      failed++;

      warn(`${label} did not come back`);

      continue;
    }

    const files = await unpack(config, origin, local, mine);

    for (const one of mine) if (one.state !== 'old') record.noteReturn(db, origin, one.held);

    await fs.promises.rm(local, { force: true });

    info(`  ${count(mine.length, 'partition')} taken out of it · ${count(files, 'file')}`);
  }

  return failed;
};

/** Free space below which no further tar is asked for. */
export const RESERVE_GB = 25;

// ── Internals ─────────────────────────────────────────────────────────────────

/** Wait until the volume has this much free, saying so once. */
const room = async (config: ColdConfig, pollMs: number, reserve: number): Promise<void> => {
  let said = false;

  while (freeBytes(config.coldRoot) < reserve) {
    if (! said) warn(`Less than ${fmtBytes(reserve)} free (${fmtBytes(freeBytes(config.coldRoot))}) — waiting for room before the next tar`);

    said = true;

    await new Promise(resolve => setTimeout(resolve, pollMs));
  }
};

/**
 * Ask Mega for a tar and wait until it is here: at the size it was stored at,
 * and no longer being written. One already here at that size was brought by a
 * run that stopped, and is used. Asked again where Mega drops it, up to
 * `ATTEMPTS` times.
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
 * of a directory beside them, or — for a version the catalog has moved on from
 * — into `PULLED` and no further. Returns how many files came out.
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
      await fs.promises.rename(path.join(stage, member), target);
    }

    await fs.promises.rm(stage, { recursive: true, force: true });
  }

  return aside.length + back.length;
};

/** Below cold's own directory: tars on their way back, and what an older version is taken out to. */
const PULLING = 'pulling';

/** Times a tar is asked for before it is given up on for this run. */
const ATTEMPTS = 3;

// ── Test access ───────────────────────────────────────────────────────────────

export const _test_bring  = bring;
