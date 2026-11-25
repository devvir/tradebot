import { mkdir, open } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';

/**
 * Writes that are on the disk before anything goes on from them.
 *
 * A write, a rename or a new file is in the kernel's cache when the call that
 * made it returns, and a power cut can take it back. What has to outlast one —
 * a file before the line that says it is there, a line before the next step
 * that counts on it — is flushed here first: a file's contents with its own
 * fsync, a name made, changed or removed with an fsync of the directory that
 * holds it.
 */

/** Flush a file's contents to the disk. */
export const syncFile = async (path: string): Promise<void> => {
  const handle = await open(path, 'r');

  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
};

/** Flush a directory's entries — the names made, renamed or removed in it — to the disk. */
export const syncDir = (dir: string): Promise<void> => syncFile(dir);

/**
 * Make a directory where there is none, and add to `touched` every directory
 * whose entries that changed: the one asked for, and the parent of each one
 * made on the way to it.
 */
export const makeDir = async (dir: string, touched: Set<string>): Promise<void> => {
  const path  = resolve(dir);
  const first = await mkdir(path, { recursive: true });

  touched.add(path);

  if (first === undefined) return;

  for (let at = path; at.length >= first.length; at = dirname(at)) touched.add(dirname(at));
};
