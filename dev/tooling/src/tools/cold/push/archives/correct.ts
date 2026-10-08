import fs from 'node:fs';
import path from 'node:path';
import { membersOf, run } from '../../shared/tar';
import type { SourceFile } from '../../shared/types';

/**
 * What to take out of a tar and what to put in, to bring one partition in it to
 * what the catalog says now — or null where that cannot be done from what is at
 * hand.
 *
 * **Whole from disk where the disk has it whole**: everything the tar holds of
 * the partition comes out, and the partition goes in as it is on disk.
 *
 * **From the two together where the disk has only part.** A partition taken off
 * the disk after it was stored comes back only in the files that changed, since
 * only those are downloaded again. Then what is on disk goes in, replacing any
 * member of the same name, and the rest of what the tar holds of the partition
 * stays where it is. That is taken as the partition only where it adds up to
 * exactly what the catalog says: as many files, weighing as much. Anything else
 * — a file the venue withdrew, a download still on its way — is not guessed at.
 */
export const correctionOf = (
  inTar:  readonly SourceFile[],
  onDisk: readonly SourceFile[],
  next:   { files: number; bytes: number },
): { remove: string[]; add: string[] } | null => {
  const weigh = (files: readonly SourceFile[]): number => files.reduce((sum, one) => sum + one.bytes, 0);
  const add   = onDisk.map(one => one.path);

  if (onDisk.length === next.files && weigh(onDisk) === next.bytes)
    return { remove: inTar.map(one => one.path), add };

  const here = new Set(add);
  const kept = inTar.filter(one => ! here.has(one.path));

  if (onDisk.length === 0 || kept.length + onDisk.length !== next.files || weigh(kept) + weigh(onDisk) !== next.bytes)
    return null;

  return { remove: inTar.filter(one => here.has(one.path)).map(one => one.path), add };
};

/**
 * Correct a tar in place: take some members out, put others in, and prove it.
 *
 * **For a tar brought back because part of what it holds changed.** The rest of
 * it is not on this disk any more and is never read: only what is taken out and
 * what is put in is touched, and only what is put in is compared against the
 * source tree. What must hold afterwards is that the tar lists exactly what it
 * listed before, less what was removed, plus what was added.
 *
 * Done on a copy and renamed over the original, so a run stopped partway leaves
 * the tar as it was brought back.
 */
export const replaceMembers = async (
  sourceRoot: string,
  local:      string,
  remove:     string[],
  add:        string[],
): Promise<void> => {
  const temporary = `${local}.tmp`;
  const list      = `${local}.list`;
  const before    = await membersOf(local);

  await fs.promises.copyFile(local, temporary);

  try {
    if (remove.length > 0) {
      await fs.promises.writeFile(list, remove.join('\n') + '\n');
      await run('tar', ['--delete', '-f', temporary, '-T', list]);
    }

    if (add.length > 0) {
      await fs.promises.writeFile(list, add.join('\n') + '\n');
      await run('tar', ['-rf', temporary, '-C', sourceRoot, '-T', list]);
      await run('tar', ['-df', temporary, '-C', sourceRoot, '-T', list]);
    }

    const gone     = new Set(remove);
    const expected = [...before.filter(member => ! gone.has(member)), ...add].sort();
    const after    = (await membersOf(temporary)).sort();

    if (after.length !== expected.length || after.some((member, at) => member !== expected[at]))
      throw new Error(`${path.basename(local)} does not list what it should after being corrected`);

    await fs.promises.rename(temporary, local);
  } finally {
    await fs.promises.rm(list, { force: true });
    await fs.promises.rm(temporary, { force: true });
  }
};
