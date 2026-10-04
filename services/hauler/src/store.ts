import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, readdir, rename, rm, stat, statfs, unlink, utimes } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import config from './config';

/**
 * The disk, and the one rule that makes an interrupted hauler safe to restart.
 *
 * **Nothing appears at its final path until it has been checked.** Every
 * download lands as a partial and is renamed only once its size and etag agree
 * with what the catalog said. Verifying after the rename would leave a
 * truncated file sitting at the real path, where every later pass would see it
 * present and skip it — permanently, and silently.
 *
 * **Every partial lives in one directory**, `.hauler-tmp` at the archives'
 * root — the same volume, so the rename that makes it a file is still one
 * step. What an interrupted hauler leaves behind is then one directory to
 * delete, where partials beside their files meant walking millions of
 * directories to find them.
 */

/** What is at a path, or `null` where nothing is. */
export const measure = async (path: string): Promise<number | null> => {
  try {
    const info = await stat(path);

    return info.isFile() ? info.size : null;
  } catch {
    return null;
  }
};

/** Free space on the volume a directory is on, in GB. */
export const freeGb = async (dir: string): Promise<number> => {
  const info = await statfs(dir);

  return (info.bavail * info.bsize) / 1024 ** 3;
};

/**
 * Where the file bound for a path is written until it is verified: named by a
 * digest of that path, so two files never share one and a path always finds
 * its own.
 */
export const partialOf = (path: string): string =>
  join(config.archivesDir, SCRATCH, `${createHash('sha1').update(path).digest('hex')}.part`);

/** Stream a response body to the path's partial and answer what it weighed. */
export const writePartial = async (path: string, body: ReadableStream<Uint8Array>): Promise<number> => {
  const partial = partialOf(path);

  await mkdir(dirname(partial), { recursive: true });

  await pipeline(Readable.fromWeb(body as never), createWriteStream(partial));

  const { size } = await stat(partial);

  return size;
};

/** Give a verified partial its real name. The last step, always. */
export const commit = async (path: string): Promise<void> => {
  await mkdir(dirname(path), { recursive: true });
  await rename(partialOf(path), path);
};

export const discard = async (path: string): Promise<void> => {
  await unlink(partialOf(path)).catch(() => undefined);
};

/**
 * Delete every unfinished download, and answer how many there were.
 *
 * **Run once, before anything is fetched.** A partial is never a file — it only
 * becomes one by being verified and renamed — so whatever is left of one is a
 * download that did not finish: a stop that outlived its grace period, a crash,
 * a pulled plug. Nothing reads it and the next walk fetches the file again.
 * `.bak` files are not touched: they are whole files that disagreed, kept for a
 * person to read.
 */
export const sweepPartials = async (): Promise<number> => {
  const scratch = join(config.archivesDir, SCRATCH);
  const left    = await readdir(scratch).catch(() => [] as string[]);

  await rm(scratch, { recursive: true, force: true });

  return left.length;
};

/**
 * Mark a file as seen by this pass: its modification time becomes now.
 *
 * **Deliberately overwriting what was there.** After a pass, every file the
 * catalog accounts for carries that pass's date, so a file still showing an
 * older one is a file nothing listed — misfiled, withdrawn, or junk — and finds
 * itself by its date alone.
 */
export const touch = async (path: string): Promise<void> => {
  const now = new Date();

  await utimes(path, now, now);
};

/**
 * Move a file that disagrees with the catalog out of the way, to
 * `<name>.bak` — or `.bak.2`, `.bak.3` where that is taken — beside it.
 *
 * **Kept, never deleted**: a file that differs is either a real update at the
 * venue, which is rare, or a mistake of ours, and either is worth reading before
 * anything is thrown away.
 */
export const backup = async (path: string): Promise<string> => {
  for (let n = 1; ; n++) {
    const aside = n === 1 ? `${path}.bak` : `${path}.bak.${n}`;

    if (await measure(aside) === null) {
      await rename(path, aside);

      return aside;
    }
  }
};

/**
 * A file's MD5, which is what an etag is at every venue in the catalog that
 * publishes one.
 *
 * Streamed rather than read: these files run to hundreds of megabytes and
 * several are in flight per venue at once.
 */
export const md5 = async (path: string): Promise<string> => {
  const hash = createHash('md5');

  await pipeline(createReadStream(path), hash);

  return hash.digest('hex');
};

/**
 * Whether an etag the venue served describes the same bytes as one we computed.
 *
 * **Compared case-blind and unquoted.** The quotes are HTTP's and the case is
 * the server's — okx serves the same digest in opposite cases from its two
 * clouds — so neither is a fact about the file. A multipart etag carries a
 * `-partcount` suffix and is not a digest of the whole object at all, which is
 * why an etag that does not look like one is no evidence either way rather than
 * evidence against.
 */
export const etagAgrees = (declared: string, digest: string): boolean =>
  cleaned(declared) === digest;

/**
 * Whether an etag is a digest of the whole object, and so worth computing one
 * to compare against.
 *
 * A multipart upload's etag carries a `-partcount` suffix and digests the list
 * of parts rather than the bytes; several venues publish none at all. Neither
 * is evidence against a file — only an absence of evidence for it.
 */
export const isDigest = (declared: string | undefined): declared is string =>
  declared !== undefined && /^[0-9a-f]{32}$/.test(cleaned(declared));

// ── Internals ─────────────────────────────────────────────────────────────────

/** The directory of unverified downloads, at the archives' root. */
const SCRATCH = '.hauler-tmp';

/** The quotes are HTTP's and the case is the server's; neither is the file's. */
const cleaned = (etag: string): string => etag.replace(/^"|"$/g, '').toLowerCase();
