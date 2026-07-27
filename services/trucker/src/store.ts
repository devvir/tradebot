import { createWriteStream } from 'node:fs';
import { mkdir, readdir, rename, stat, statfs, unlink } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import config from './config';

/**
 * The filesystem is the source of truth for what has been downloaded: a file
 * exists at exactly one path per remote URL, so resuming is a `stat`, not
 * bookkeeping that could disagree with the disk.
 *
 * Archives land under `<dataDir>/<venue>/<the venue's own path>` — the venue
 * layout is preserved verbatim, since renaming loses provenance and these files
 * are re-verifiable against source only under their real names.
 */
export const pathFor = (venue: string, relative: string): string =>
  join(config.dataDir, venue, relative);

export const exists = async (absolute: string): Promise<boolean> => {
  try {
    const info = await stat(absolute);

    return info.isFile() && info.size > 0;
  } catch {
    return false;
  }
};

/**
 * Stream a response body to disk as a `.part` file and leave it there. The
 * caller verifies the partial — length, checksum — and only `commit` renames it
 * to the final path. An interrupted or corrupt download therefore never looks
 * finished: nothing `exists` would accept appears on disk until verification
 * has passed.
 */
export const writePartial = async (absolute: string, body: ReadableStream<Uint8Array>): Promise<number> => {
  const partial = `${absolute}.part`;

  await mkdir(dirname(absolute), { recursive: true });

  await pipeline(Readable.fromWeb(body as never), createWriteStream(partial));

  const { size } = await stat(partial);

  return size;
};

/** Promote a verified `.part` file to its final name — the last step, always. */
export const commit = async (absolute: string): Promise<void> => {
  await rename(`${absolute}.part`, absolute);
};

/**
 * Free space on the volume holding the archives, in GB. A full backfill across
 * these venues is measured in terabytes, so running out of disk is the expected
 * failure mode, not an unlikely one — trucker stops before it fills the volume
 * rather than leaving a wedged host behind.
 */
export const freeGb = async (): Promise<number> => {
  const fs = await statfs(config.dataDir);

  return (fs.bavail * fs.bsize) / 1e9;
};

/**
 * Delete leftover `.part` files. A hard kill (SIGKILL, power loss) leaves the
 * in-flight write behind: harmless, since a retry truncates it and `exists`
 * never counts it as done, but it accumulates if that file is not fetched again
 * — so the sweep runs once at startup, when nothing can be in flight.
 */
export const sweepPartials = async (dir: string): Promise<number> => {
  let removed = 0;

  const walk = async (path: string): Promise<void> => {
    const entries = await readdir(path, { withFileTypes: true }).catch(() => []);

    for (const entry of entries) {
      const full = join(path, entry.name);

      if (entry.isDirectory()) await walk(full);
      else if (entry.name.endsWith('.part')) {
        await unlink(full).catch(() => { /** raced with something else; fine */ });
        removed++;
      }
    }
  };

  await walk(dir);

  return removed;
};

export const discard = async (absolute: string): Promise<void> => {
  await unlink(`${absolute}.part`).catch(() => { /** nothing to clean up */ });
};
