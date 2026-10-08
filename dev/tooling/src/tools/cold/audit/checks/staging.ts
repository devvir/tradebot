import fs from 'node:fs';
import path from 'node:path';
import { localPath } from '../../config';
import { busy } from '../../lock';
import { matches } from '../../shared/disk';
import { idOf, partitionOf } from '../../shared/keys';
import * as record from '../../shared/record';
import { sizedMembersOf } from '../../shared/tar';
import { are, count, found } from '../finding';
import { fmtBytes } from '../../../../shared/utils/format';
import type { SourceFile } from '../../shared/types';
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
 * that command's, half way through.
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
      const why = await differs(file, record.heldIn(db, tar.id));

      if (why) wrong.push({ file, tar, why });
    }
  }

  const weight = (files: readonly string[]): string => fmtBytes(files.reduce((sum, file) => sum + fs.statSync(file).size, 0));
  const below  = (file: string): string => path.relative(config.coldRoot, file);
  const remove = (files: readonly string[]) => (): void => { for (const file of files) fs.rmSync(file, { force: true }); };

  return [
    found(`${count(wrong.length, 'tar')} in staging ${wrong.length === 1 ? 'does' : 'do'} not hold what the record says`,
      wrong.map(one => `${below(one.file)}: ${one.why}`), [{
        label: 'Remove them and write them down as not packed, so the next push packs them again',
        apply: () => {
          for (const one of wrong) {
            fs.rmSync(one.file, { force: true });
            record.move(db, one.tar.id, 'planned');
          }
        },
      }], 'Their partitions are still on disk: a tar is only ever packed from there, and nothing is evicted before its tar is stored.'),
    found(`${count(stored.length, 'tar')} in staging ${are(stored)} already stored in Mega (${weight(stored)})`, stored.map(below), [
      { label: 'Remove them from staging', apply: remove(stored) },
    ], 'A tar leaves staging when it is stored. These stayed: a run stopped between the two.'),
    found(`${count(unknown.length, 'tar')} in staging ${are(unknown)} not in the record (${weight(unknown)})`, unknown.map(below), [
      { label: 'Remove them from staging', destructive: true, apply: remove(unknown) },
    ], 'A plan was redrawn after they were packed, most likely. Nothing says what they hold.'),
  ].flat();
};

/** Why a tar does not hold what the record says of it, or null where it does. */
const differs = async (file: string, held: readonly ReturnType<typeof record.heldIn>[number][]): Promise<string | null> => {
  const inside = new Map<string, SourceFile[]>();

  for (const member of await sizedMembersOf(file)) {
    const key = partitionOf(member.path);
    const id  = key ? idOf(key) : '(not a file of any partition)';

    inside.set(id, [...inside.get(id) ?? [], member]);
  }

  for (const one of held) {
    const files = inside.get(idOf(one)) ?? [];

    if (! matches(files, one))
      return `${idOf(one)} is ${one.files} file${one.files === 1 ? '' : 's'} in the record and ${files.length} in the tar`;

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
    { label: 'Remove them', apply: () => fs.rmSync(dir, { recursive: true, force: true }) },
  ], 'A tar on its way back, or what was being taken out of one. A pull asks Mega for it again.');
};
