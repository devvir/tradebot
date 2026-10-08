import { matches } from '../../shared/disk';
import * as record from '../../shared/record';
import { tarSize } from '../../shared/tar';
import { count, found } from '../finding';
import { fmtBytes } from '../../../../shared/utils/format';
import type { Held, SourceFile } from '../../shared/types';
import type { Tar } from '../../types';
import type { Check } from '../types';

/**
 * What each stored tar weighs, against what the partitions it is said to hold
 * imply.
 *
 * **A tar's size follows exactly from the names and sizes of its members** —
 * see `tarSize` — so a tar that cannot be opened can still be weighed: one that
 * holds a partition more or less than the record says, or other files of it,
 * is not the size those partitions make.
 *
 * - **Where every partition of a tar is on disk as it was stored**, its members
 *   are known and the size is checked to the byte.
 * - **Where one is not** — taken off the disk since — only how many files it
 *   was and what they weighed is known, which bounds the size and does not fix
 *   it: each file adds a header, up to a block of padding, and a second header
 *   where its name is long. A tar outside those bounds is wrong; one inside
 *   them is not proved right.
 */
export const byWeight: Check = async ({ db, origin, archives }) => {
  if (origin !== 'archives') return [];

  const exact: { tar: Tar; should: number }[] = [];
  const loose: { tar: Tar; least: number; most: number }[] = [];

  for (const tar of record.tarsOf(db, origin)) {
    if (tar.state !== 'stored' || tar.bytes === null) continue;

    const held = record.heldIn(db, tar.id);

    // What the catalog has made of a partition since is not what the tar holds: it is weighed as it was stored.
    const members: SourceFile[] = [];
    let known = true;

    for (const one of held) {
      const files = known ? await archives.filesOf(one) : [];

      if (matches(files, one)) members.push(...files);
      else known = false;
    }

    if (known) {
      if (tarSize(members) !== tar.bytes) exact.push({ tar, should: tarSize(members) });

      continue;
    }

    const { least, most } = boundsOf(held);

    if (tar.bytes < least || tar.bytes > most) loose.push({ tar, least, most });
  }

  return [
    found(`${count(exact.length, 'stored tar')} ${exact.length === 1 ? 'is' : 'are'} not the size the files of ${exact.length === 1 ? 'its' : 'their'} partitions make`,
      exact.map(one => `${one.tar.remote}: ${fmtBytes(one.tar.bytes ?? 0)} stored, ${fmtBytes(one.should)} from what is on disk (${(one.should - (one.tar.bytes ?? 0)).toLocaleString('en-US')} bytes apart)`), [{
        label: 'Write them down as not stored, so the next push packs and sends them again',
        apply: () => { for (const one of exact) record.move(db, one.tar.id, 'planned'); },
      }], 'Their partitions are on disk as they were stored, so what they should weigh is known to the byte.'),
    found(`${count(loose.length, 'stored tar')} ${loose.length === 1 ? 'is' : 'are'} outside the size ${loose.length === 1 ? 'its' : 'their'} partitions allow`,
      loose.map(one => `${one.tar.remote}: ${fmtBytes(one.tar.bytes ?? 0)} stored, between ${fmtBytes(one.least)} and ${fmtBytes(one.most)} expected`), [],
      'Some of their partitions are no longer on disk, so there is nothing to pack them again from: bring the tar back and look.'),
  ].flat();
};

// ── Internals ─────────────────────────────────────────────────────────────────

/**
 * The least and the most a tar of these partitions can weigh, from how many
 * files each was and what they weighed together: a header a file, its content
 * padded by up to a block, and a second header of two blocks where its name is
 * past a hundred bytes.
 */
const boundsOf = (held: readonly Held[]): { least: number; most: number } => {
  const files = held.reduce((sum, one) => sum + one.files, 0);
  const bytes = held.reduce((sum, one) => sum + one.bytes, 0);
  const least = bytes + files * 512 + 1024;

  return { least, most: Math.ceil((least + files * (511 + 1024)) / 10240) * 10240 };
};
