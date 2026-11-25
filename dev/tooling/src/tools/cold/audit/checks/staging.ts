import fs from 'node:fs';
import path from 'node:path';
import { localPath } from '../../config';
import { busy } from '../../lock';
import { matches } from '../../shared/disk';
import { idOf, partitionOf } from '../../shared/keys';
import { groupBy } from '../../shared/group';
import * as record from '../../shared/record';
import { sizedMembersOf } from '../../shared/tar';
import { asFound, othersAtWork } from '../again';
import { are, found } from '../finding';
import { count } from '../../shared/count';
import { fmtBytes } from '../../../../shared/utils/format';
import type { Content, Held } from '../../shared/types';
import type { Tar } from '../../types';
import type { Check, Finding, Looking } from '../types';

/**
 * What cold keeps on disk for its own work, against the record: the tars in
 * staging, and what a pull left behind.
 *
 * **Staging is where a tar waits between being packed and being stored**, and a
 * tar is removed from it the moment Mega has it. So what is found there is a
 * tar on its way, or something a run left behind — and a tar on its way can be
 * opened, which a stored one cannot without bringing it back: this is the one
 * place where what a tar holds is set against what the record says it holds.
 *
 * Nothing is looked at while another command is running: what is there then is
 * that command's, half way through. Nor is anything removed: a fix that finds
 * one started since it was found leaves it all as it is.
 */
export const inStaging: Check = async (looking) => {
  if (looking.origin !== 'archives' || busy(looking.config.coldRoot)) return [];

  return [...await tars(looking), ...leftBehind(looking)];
};

// ── Internals ─────────────────────────────────────────────────────────────────

/** Every file below a directory, absolute. */
const filesBelow = (dir: string): string[] => {
  const entries = fs.existsSync(dir) ? fs.readdirSync(dir, { withFileTypes: true }) : [];

  return entries.flatMap(entry => (entry.isDirectory() ? filesBelow(path.join(dir, entry.name)) : [path.join(dir, entry.name)]));
};

/** The tars in staging: whose they are, and whether each holds what the record says. */
const tars = async ({ db, config, origin }: Looking): Promise<Finding[]> => {
  const byPath = new Map(record.tarsOf(db, origin).map(tar => [localPath(config, origin, tar), tar]));
  const staged = filesBelow(path.join(config.coldRoot, origin)).filter(file => file.endsWith('.tar'));

  const stored:  string[] = [];
  const unknown: string[] = [];
  const wrong:   { file: string; tar: Tar; why: string }[] = [];

  for (const file of staged) {
    const tar = byPath.get(file);

    if (! tar) unknown.push(file);
    else if (tar.state === 'stored') stored.push(file);
    else if (tar.state === 'packed' || tar.state === 'queued') {
      const why = await differs(file, tar, record.heldIn(db, tar.id));

      if (why) wrong.push({ file, tar, why });
    }
  }

  const weight = (files: readonly string[]): string => fmtBytes(files.reduce((sum, file) => sum + fs.statSync(file).size, 0));
  const below  = (file: string): string => path.relative(config.coldRoot, file);
  const remove = (files: readonly string[]) => (): boolean => {
    if (othersAtWork(config.coldRoot)) return false;

    for (const file of files) fs.rmSync(file, { force: true });

    return true;
  };

  return [
    found(`${count(wrong.length, 'tar')} in staging ${wrong.length === 1 ? 'does' : 'do'} not hold what the record says`,
      wrong.map(one => `${below(one.file)}: ${one.why}`), [{
        label: 'Remove them, so the next push makes them again: packed from the disk, or brought back from Mega and corrected where Mega holds one',
        apply: () => {
          if (othersAtWork(config.coldRoot)) return false;

          const still = asFound(db, wrong.map(one => one.tar));

          // What Mega holds of a tar is what it is corrected from: one it holds goes back to being corrected, as a lost one does in a push.
          for (const tar of still) {
            fs.rmSync(localPath(config, origin, tar), { force: true });
            record.move(db, tar.id, tar.handle ? 'stale' : 'planned');
          }

          return still.length > 0;
        },
      }], wrongNote(db, origin, wrong.map(one => one.tar))),
    found(`${count(stored.length, 'tar')} in staging ${are(stored)} already stored in Mega (${weight(stored)})`, stored.map(below), [
      { label: 'Remove them from staging', apply: remove(stored) },
    ], 'A tar leaves staging when it is stored. These stayed: a run stopped between the two.'),
    found(`${count(unknown.length, 'tar')} in staging ${are(unknown)} not in the record (${weight(unknown)})`, unknown.map(below), [
      { label: 'Remove them from staging', destructive: true, apply: remove(unknown) },
    ], 'A plan was redrawn after they were packed, most likely. Nothing says what they hold.'),
  ].flat();
};

/**
 * What can be said of the partitions of tars that are to be made again: on
 * disk, where none was ever stored; otherwise how many Mega holds an older tar
 * of, and how many have been taken off the disk since.
 */
const wrongNote = (db: Looking['db'], origin: Looking['origin'], list: readonly Tar[]): string | undefined => {
  if (list.length === 0) return undefined;

  const evicted = new Set(record.evictionsOf(db, origin).map(idOf));
  const inMega  = list.filter(tar => tar.handle !== null).length;
  const away    = list.flatMap(tar => record.heldIn(db, tar.id)).filter(one => evicted.has(idOf(one))).length;

  if (inMega === 0 && away === 0)
    return 'None of them was stored before, so their partitions are on disk: a tar is packed from there, and nothing is evicted before its tar is stored.';

  return [
    ...(inMega > 0 ? [`${inMega} of them ${inMega === 1 ? 'replaces a tar' : 'replace tars'} Mega holds: brought back and corrected again.`] : []),
    ...(away > 0 ? [`${away} of their partitions ${away === 1 ? 'has' : 'have'} been taken off the disk: what Mega holds of ${away === 1 ? 'it' : 'them'} is the copy there is.`] : []),
  ].join(' ');
};

/** What a tar was made with of a partition: what was written down as it was packed, or, where nothing was, the change it was corrected to. */
const madeWith = (tar: Tar, one: Held): Content => one.packed ?? (tar.handle !== null && one.next ? one.next : one);

/** How many files a partition is, and what they weigh. */
const sizeOf = (files: number, bytes: number): string =>
  `${count(files, 'file')} of ${bytes.toLocaleString('en-US')} byte${bytes === 1 ? '' : 's'}`;

/** Why a tar does not hold what the record says it was made with, or null where it does. */
const differs = async (file: string, tar: Tar, held: readonly Held[]): Promise<string | null> => {
  const inside = groupBy(await sizedMembersOf(file), (member) => {
    const key = partitionOf(member.path);

    return key ? idOf(key) : '(not a file of any partition)';
  });

  for (const one of held) {
    const files = inside.get(idOf(one)) ?? [];
    const made  = madeWith(tar, one);

    if (! matches(files, made))
      return `${idOf(one)} is ${sizeOf(made.files, made.bytes)} in the record and ${sizeOf(files.length, files.reduce((sum, member) => sum + member.bytes, 0))} in the tar`;

    inside.delete(idOf(one));
  }

  const [extra] = inside.keys();

  return extra ? `it holds ${extra}, which the record does not say` : null;
};

/** What a pull that stopped left behind: tars on their way back, and what was being taken out of them. */
const leftBehind = ({ config, origin }: Looking): Finding[] => {
  const dir   = path.join(config.coldRoot, 'pulling', origin);
  const files = filesBelow(dir);

  return found(`${count(files.length, 'file')} ${are(files)} left from a pull that stopped`, files.map(file => path.relative(config.coldRoot, file)), [
    {
      label: 'Remove them',
      apply: () => {
        if (othersAtWork(config.coldRoot)) return false;

        fs.rmSync(dir, { recursive: true, force: true });

        return true;
      },
    },
  ], 'A tar on its way back, or what was being taken out of one. A pull asks Mega for it again.');
};
