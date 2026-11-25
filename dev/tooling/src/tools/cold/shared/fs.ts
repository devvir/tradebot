import fs from 'node:fs';
import path from 'node:path';

/**
 * Move a file, across volumes where it has to.
 *
 * On one volume it is a rename. Across two, where a rename cannot be done, the
 * file is copied to `<to>.part` beside where it goes, renamed into place, and
 * only then removed from where it was: a move stopped partway leaves the
 * source whole and nothing at `to` that looks finished.
 */
export const moveFile = async (from: string, to: string): Promise<void> => {
  try {
    await fs.promises.rename(from, to);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'EXDEV') throw err;

    const part = `${to}.part`;

    await fs.promises.copyFile(from, part);
    await fs.promises.rename(part, to);
    await fs.promises.rm(from);
  }
};

/**
 * Whether two paths are on the same volume. A path that is not there yet is
 * taken at the nearest directory above it that is.
 */
export const sameVolume = (a: string, b: string): boolean =>
  fs.statSync(existing(a)).dev === fs.statSync(existing(b)).dev;

/** Bytes free to this process on the volume a path is on, or would be on. */
export const freeBytes = (dir: string): number => {
  const stats = fs.statfsSync(existing(dir));

  return stats.bavail * stats.bsize;
};

// ── Internals ─────────────────────────────────────────────────────────────────

/** The path itself, or the nearest directory above it that exists. */
const existing = (at: string): string => {
  let here = path.resolve(at);

  while (! fs.existsSync(here) && path.dirname(here) !== here) here = path.dirname(here);

  return here;
};
