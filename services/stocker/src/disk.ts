import { readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import config from './config';
import { datasetDirOf, edgesOf, parseKey } from './keys';
import type { DiskFile, EdgeStats, PartitionKey, PartitionStats } from './types';

/**
 * A partition's files as they are on disk, under the archives' canonical
 * layout:
 *
 *     <archives>/venue/market/dataset[,variant]/FL/symbol/YYYYMM/<name>
 *     <archives>/venue/market/dataset[,variant]/@/YYYYMM/<name>
 *
 * A month of a dataset is not one directory — it is the `YYYYMM` directory
 * under every instrument — so a partition is gathered by visiting each
 * instrument of the dataset. The instruments are read once per dataset per
 * sweep (`Instruments`) and the month directories as each partition is asked
 * for.
 *
 * Only canonical names count. A download in progress, a backup, anything a
 * name does not parse as is not a file of the partition.
 */
export const filesOf = async (key: PartitionKey, instruments: Instruments): Promise<DiskFile[]> => {
  const root = join(config.archivesDir, datasetDirOf(key));
  const yyyymm = key.month.replace('-', '');

  const dirs = key.bundle === 'market'
    ? [join(root, '@', yyyymm)]
    : (await instruments.of(root)).map(instrument => join(root, instrument, yyyymm));

  const found: DiskFile[] = [];

  for (const dir of dirs) {
    const names = await readdir(dir).catch(() => [] as string[]);

    for (const name of names) {
      const file = parseKey(name);

      if (! file || file.grain !== key.grain || file.month !== key.month) continue;

      const absolute = join(dir, name);
      const info     = await stat(absolute).catch(() => null);

      if (! info?.isFile()) continue;

      found.push({ absolute, file: { ...file, key: relativeKey(absolute) }, size: info.size, mtimeMs: info.mtimeMs });
    }
  }

  return found.sort((a, b) => (a.file.key < b.file.key ? -1 : a.file.key > b.file.key ? 1 : 0));
};

/** A partition's files in the first or last period of its month. */
export const edgeFilesOf = async (
  key:         PartitionKey,
  side:        'first' | 'last',
  instruments: Instruments,
): Promise<DiskFile[]> =>
  (await filesOf(key, instruments)).filter(found => edgesOf(found.file)[side]);

/**
 * Whether what is on disk is what the catalog lists — by count, and by total
 * size where the catalog knows every size.
 *
 * Names are not compared one by one: the disk holds only canonical names under
 * the partition's own directories, so the count and the bytes agreeing is the
 * same answer for a fraction of the work.
 */
export const matches = (found: DiskFile[], stats: PartitionStats | EdgeStats): boolean => {
  if (found.length !== stats.files) return false;

  if (stats.bytes === null) return true;

  return found.reduce((total, one) => total + one.size, 0) === stats.bytes;
};

/**
 * Whether the files are still exactly as they were — after a build, so nothing
 * that changed while it ran goes unnoticed.
 */
export const unchanged = async (files: DiskFile[]): Promise<boolean> => {
  for (const one of files) {
    const info = await stat(one.absolute).catch(() => null);

    if (! info || info.size !== one.size || info.mtimeMs !== one.mtimeMs) return false;
  }

  return true;
};

/**
 * The instrument directories of each dataset, read once per sweep.
 *
 * A dataset can hold thousands of instruments and a sweep asks about it once
 * per month, so listing them each time would be most of the cost.
 */
export class Instruments {
  private readonly known = new Map<string, Promise<string[]>>();

  of(root: string): Promise<string[]> {
    let listed = this.known.get(root);

    if (! listed) {
      listed = listInstruments(root);
      this.known.set(root, listed);
    }

    return listed;
  }
}

// ── Internals ─────────────────────────────────────────────────────────────────

/** `FL/symbol` for every instrument of a dataset; the `@` bundle is not one. */
const listInstruments = async (root: string): Promise<string[]> => {
  const letters = await readdir(root, { withFileTypes: true }).catch(() => []);
  const found: string[] = [];

  for (const letter of letters) {
    if (! letter.isDirectory() || letter.name === '@') continue;

    const symbols = await readdir(join(root, letter.name), { withFileTypes: true }).catch(() => []);

    for (const symbol of symbols)
      if (symbol.isDirectory()) found.push(join(letter.name, symbol.name));
  }

  return found;
};

/** The key a file on disk is stored at, which is its path under the archives. */
const relativeKey = (absolute: string): string =>
  absolute.slice(config.archivesDir.replace(/\/$/, '').length + 1);
