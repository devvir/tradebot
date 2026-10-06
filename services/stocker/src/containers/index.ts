import { createReadStream } from 'node:fs';
import { mkdir, mkdtemp, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { createGunzip } from 'node:zlib';
import config from '../config';
import { needsExtracting } from './extract';
import { Pool } from './pool';
import type { UnpackedAll, Wrapped } from './types';

/**
 * Threads that extract archives beside the builds. Two keep extraction ahead of
 * the engine without taking the machine from everything else running on it.
 */
const UNPACK_WORKERS = 2;

/** The one transient directory, inside the volume stocker owns. */
export const SCRATCH = '.stocker-tmp';

/**
 * Whether a decoded file holds a single byte.
 *
 * Venues publish genuinely empty archives: Bybit wrote one for every symbol
 * that delisted on 2022-12-12, Gate for a symbol that listed and never traded.
 * They are valid files — a 42-byte gzip that inflates to nothing — and they
 * break a header-mapped series two ways. Alone, the reader finds no header and
 * names the one column it invents `column0`, so every projected column fails to
 * bind. Mixed into a month, the sniffer takes that invented schema as the
 * file set's schema and rejects the real files against it.
 *
 * Filtering them out answers both, so no reader option or per-venue exception
 * is needed.
 *
 * **Decoded, never inferred.** A gzip records its uncompressed size in the last
 * four bytes, which is tempting and wrong: for a *concatenated* gzip it
 * describes only the final member, so a file of real data followed by an empty
 * member reads as empty and the whole month would be silently dropped. Pulling
 * one byte through the decompressor cannot make that mistake, and costs the
 * first block of a file the build is about to read in full anyway.
 *
 * **A zero-length file is empty whatever its extension**, and that check comes
 * first. Both shapes exist on disk: Bybit's are valid 42-byte gzips with an
 * empty payload, Gate's are files of no bytes at all, which are not gzips and
 * would otherwise fail to inflate. Neither can be hiding data. A file that has
 * bytes but will not inflate is the opposite case — something is there and
 * cannot be read — so that still throws.
 */
export const hasContent = async (path: string): Promise<boolean> => {
  if ((await stat(path)).size === 0) return false;

  if (! path.endsWith('.gz')) return true;

  return new Promise<boolean>((resolve, reject) => {
    const source = createReadStream(path);
    const gunzip = createGunzip();

    let settled = false;

    const done = (content: boolean): void => {
      if (settled) return;

      settled = true;

      source.destroy();
      gunzip.destroy();
      resolve(content);
    };

    gunzip.once('data', () => done(true));
    gunzip.once('end',  () => done(false));

    // A truncated or corrupt member is not an emptiness question — let the
    // build fail on it loudly rather than quietly skipping the file.
    gunzip.once('error', err => { if (! settled) reject(err); });
    source.once('error', err => { if (! settled) reject(err); });

    source.pipe(gunzip);
  });
};

/**
 * Present raw archives as paths the engine can read, extracting only when it
 * has to. The raw files are never modified or moved.
 *
 * **One directory for all of them, removed at once.** A build reads thousands
 * of archives at a time, and a directory made and removed per archive was a
 * measurable share of what stocking a month of small files cost. Each archive
 * writes under a tag of its own, so two holding a member of the same name do
 * not meet.
 *
 * **A few at a time, and the loop is handed back as they go.** A small zip is
 * extracted without waiting on anything — see `zip` — so thousands in a row
 * would otherwise hold the thread for as long as they take, and whatever else
 * the service is doing with it.
 *
 * Extraction lands beside the vault, **never in the system temp directory**.
 * These archives are not small — a Binance monthly is hundreds of MB and a Gate
 * order-book month is around 23 GB — and in a container `os.tmpdir()` is the
 * overlay filesystem. Filling it presents as a corrupt build rather than as the
 * full disk it actually is. The vault volume is the one sized for this data.
 */
export const unpackAll = async (inputs: readonly Wrapped[]): Promise<UnpackedAll> => {
  if (! needsExtracting(inputs))
    return { paths: inputs.map(input => [input.absolute]), bytes: 0, dispose: async () => {} };

  const scratch = join(config.vaultDir, SCRATCH);

  await mkdir(scratch, { recursive: true });

  const dir     = await mkdtemp(join(scratch, 'unpack-'));
  const dispose = async (): Promise<void> => { await rm(dir, { recursive: true, force: true }); };

  try {
    return { ...await pool.extract(inputs, dir), dispose };
  } catch (err) {
    await dispose();

    throw err;
  }
};

/** The threads extraction runs on — see `Pool`. */
export const pool = new Pool(UNPACK_WORKERS);

export { containerFor } from './registry';
export { needsExtracting } from './extract';
export type { Container, UnpackedAll, Wrapped } from './types';
