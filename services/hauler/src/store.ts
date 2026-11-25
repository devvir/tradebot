import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, open, readdir, rename, rm, stat, statfs, unlink, utimes } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { pipeline } from 'node:stream/promises';
import config from './config';
import type { Readable } from 'node:stream';

/**
 * The disk, and the one rule that makes an interrupted hauler safe to restart.
 *
 * **Nothing appears at its final path until it has been checked.** Every
 * download lands as a partial and is renamed only once its size and etag agree
 * with what the catalog said. Verifying after the rename would leave a
 * truncated file sitting at the real path, where every later pass would see it
 * present and skip it — permanently, and silently.
 *
 * **What is given its path is on the disk when `commit` returns.** A partial is
 * flushed before it is answered for, and the directory a file is renamed into —
 * with every directory made for it — once it is there. So a file at its path
 * is one a power cut does not take back.
 *
 * **What the disk refuses is said to be the disk's**: a write that fails throws
 * a `DiskError`, and one refused for want of room is noted — see `roomRefusedAt`.
 *
 * **Every partial lives in one directory**, `.hauler-tmp` at the archives'
 * root — the same volume, so the rename that makes it a file is still one
 * step. What an interrupted hauler leaves behind is then one directory to
 * delete, with no search of the archive.
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

/** What room is left on the volume a directory is on: free space in GB, and inodes free of all there are. */
export const roomOn = async (dir: string): Promise<Room> => {
  const info = await statfs(dir);

  return { gb: (info.bavail * info.bsize) / 1024 ** 3, inodes: { free: info.ffree, all: info.files } };
};

export interface Room {
  gb:     number;

  /** A volume that does not count them says it has none at all. */
  inodes: { free: number; all: number };
}

/**
 * When a write was last refused for want of room, as a `Date.now()`; 0 where
 * none has been. `ENOSPC` is a volume out of space or inodes, `EDQUOT` a quota
 * spent — which nothing that looks at the volume sees.
 */
export const roomRefusedAt = (): number => refusedAt;

/** A write to the disk that failed: the disk's doing, whatever was being written. */
export class DiskError extends Error {
  readonly code: string | undefined;

  constructor(cause: unknown) {
    super(cause instanceof Error ? cause.message : String(cause), { cause });

    const code = (cause as { code?: unknown } | null)?.code;

    this.name = 'DiskError';
    this.code = typeof code === 'string' ? code : undefined;
  }
}

/**
 * Where the file bound for a path is written until it is verified: named by a
 * digest of that path, so two files never share one and a path always finds
 * its own.
 */
export const partialOf = (path: string): string =>
  join(config.archivesDir, SCRATCH, `${createHash('sha1').update(path).digest('hex')}.part`);

/** What a download came to: how many bytes, and their MD5. */
export interface Written {
  bytes:  number;
  digest: string;
}

/**
 * Stream a body to the path's partial, byte for byte, and answer what it
 * weighed and hashed to — hashed as it is written, so it is never read back.
 * Flushed to the disk before it is answered for.
 *
 * **What fails is told apart**: the disk failing to take a byte throws a
 * `DiskError`; the body failing to give one throws whatever it threw.
 */
export const writePartial = async (path: string, body: Readable): Promise<Written> => {
  const partial = partialOf(path);
  const hash    = createHash('md5');

  let bytes = 0;

  const file = await disk(async () => {
    await mkdir(dirname(partial), { recursive: true });

    return await open(partial, 'w');
  }).catch((err: unknown) => {
    body.destroy();

    throw err;
  });

  let failure: unknown = null;

  try {
    for await (const chunk of body as AsyncIterable<Buffer>) {
      hash.update(chunk);
      bytes += chunk.length;

      for (let from = 0; from < chunk.length;) from += (await disk(() => file.write(chunk, from))).bytesWritten;
    }
  } catch (err) {
    failure = err;
  }

  if (failure === null) await disk(() => file.sync()).catch((err: unknown) => { failure = err; });

  await disk(() => file.close()).catch((err: unknown) => { failure ??= err; });

  if (failure !== null) throw failure;

  return { bytes, digest: hash.digest('hex') };
};

/**
 * Give a verified partial its real name. The last step, always — and on the
 * disk once it returns: the directory it is renamed into is flushed, and so is
 * every directory made for it, up to the one that was there already.
 */
export const commit = async (path: string): Promise<void> => {
  const dir = dirname(path);

  await disk(async () => {
    const made = await mkdir(dir, { recursive: true });

    await rename(partialOf(path), path);

    const top = made === undefined ? dir : dirname(made);

    for (let at = dir; ; at = dirname(at)) {
      await syncDir(at);

      if (at === top || at === dirname(at)) break;
    }
  });
};

/**
 * Give a verified partial its path, keeping whatever is there: answer where
 * that went, or null where nothing was moved.
 *
 * **For a partial already verified**: whatever is at the path stays there
 * until a replacement is in hand. Where nothing is at the path, the partial is
 * committed. Where the same bytes are there already — the
 * same size and MD5 — the partial is dropped and the file touched, so nothing
 * is kept twice. Anything else there goes aside with `backup`, and the partial
 * takes its place.
 */
export const replace = async (path: string, digest: string): Promise<string | null> => {
  const there = await measure(path);

  if (there !== null && there === await measure(partialOf(path)) && await md5(path) === digest) {
    await discard(path);

    // Its date says it was confirmed; the file is no less there for keeping the old one.
    await touch(path).catch(() => undefined);

    return null;
  }

  const aside = there === null ? null : await backup(path);

  await commit(path);

  return aside;
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
 * Mark a file found already on disk and correct: its modification time becomes
 * now.
 *
 * Only files still listed as owed are checked, so a file downloaded and
 * reported earlier is not listed again and keeps the time it was downloaded. A
 * file's date says when hauler last wrote or confirmed it, not whether the
 * catalog accounts for it.
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
      await disk(() => rename(path, aside));

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
 * clouds — so neither is a fact about the file. Only meaningful for an etag
 * that `isDigest`.
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

let refusedAt = 0;

/** What the disk threw, as a `DiskError`, noting a refusal for want of room. */
const refused = (err: unknown): DiskError => {
  const failed = err instanceof DiskError ? err : new DiskError(err);

  if (failed.code === 'ENOSPC' || failed.code === 'EDQUOT') refusedAt = Date.now();

  return failed;
};

/** Run a step that only the disk takes part in: whatever it throws, the disk threw. */
const disk = async <T>(step: () => Promise<T>): Promise<T> => {
  try {
    return await step();
  } catch (err) {
    throw refused(err);
  }
};

/** Flush a directory, so the names in it are on the disk. */
const syncDir = async (dir: string): Promise<void> => {
  const handle = await open(dir, 'r');

  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
};

// ── Test access ───────────────────────────────────────────────────────────────

/** Forget a refusal for want of room, where a test has just caused one. */
export const _test_forgetRefusal = (): void => { refusedAt = 0; };
