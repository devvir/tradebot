import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, rename, stat, unlink } from 'node:fs/promises';
import { dirname } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

/**
 * The disk, and the one rule that makes an interrupted hauler safe to restart.
 *
 * **Nothing appears at its final path until it has been checked.** Every
 * download lands as a `.part` file and is renamed only once its size and etag
 * agree with what the catalog said. Verifying after the rename would leave a
 * truncated file sitting at the real path, where every later pass would see it
 * present and skip it — permanently, and silently.
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

/** Stream a response body to `<path>.part` and answer what it weighed. */
export const writePartial = async (path: string, body: ReadableStream<Uint8Array>): Promise<number> => {
  await mkdir(dirname(path), { recursive: true });

  await pipeline(Readable.fromWeb(body as never), createWriteStream(`${path}.part`));

  const { size } = await stat(`${path}.part`);

  return size;
};

/** Give a verified partial its real name. The last step, always. */
export const commit = async (path: string): Promise<void> => {
  await rename(`${path}.part`, path);
};

export const discard = async (path: string): Promise<void> => {
  await unlink(`${path}.part`).catch(() => undefined);
};

/** Remove a committed file that turned out not to be what it claimed to be. */
export const remove = async (path: string): Promise<void> => {
  await unlink(path).catch(() => undefined);
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

/** The quotes are HTTP's and the case is the server's; neither is the file's. */
const cleaned = (etag: string): string => etag.replace(/^"|"$/g, '').toLowerCase();
