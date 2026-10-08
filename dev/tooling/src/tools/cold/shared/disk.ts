import fs from 'node:fs';
import path from 'node:path';
import { descriptorOf, idOf, partitionOf } from './keys';
import type { PartitionKey, SourceFile } from './types';

/**
 * A partition's files as they are on disk, under the archives' layout:
 *
 *     <root>/venue/market/dataset[,variant]/FL/symbol/YYYYMM/<name>
 *     <root>/venue/market/dataset[,variant]/@/YYYYMM/<name>
 *
 * A month of a dataset is not one directory — it is the `YYYYMM` directory
 * under every instrument — so a partition is gathered by visiting each
 * instrument of the dataset. Those are listed once per dataset per run, since a
 * dataset holds thousands and a run asks about it once per month.
 *
 * Only canonical names count, and only those of the partition asked for: a
 * dataset's directory holds every grain of it side by side.
 *
 * **Gathering hands the thread back as it goes.** A partition can be hundreds of
 * thousands of files, each one looked at, and done in one stretch that is
 * minutes in which nothing else runs — not the display, and not the handler
 * that answers a Ctrl-C. So the walk stops every few milliseconds to let them.
 */
export class Archives {
  constructor(private readonly root: string) {}

  private readonly instruments = new Map<string, string[]>();

  /**
   * The directories a partition's files are in, each with everything it holds
   * — named and not measured. For when the files are to be removed and nothing
   * is asked of them: a listing each, and no look at any file.
   *
   * **Everything, not only the partition's.** A month's directory holds every
   * rendering of the data side by side, and whoever removes a partition needs
   * to know whether the directory is all its own to take.
   */
  async monthDirsOf(key: PartitionKey): Promise<{ dir: string; names: string[] }[]> {
    const dataset = path.join(key.venue, key.market, descriptorOf(key));
    const breath  = breather();

    const dirs = key.bundle === 'market'
      ? [path.join(dataset, '@', key.month)]
      : (await this.instrumentsOf(dataset, breath)).map(instrument => path.join(dataset, instrument, key.month));

    const found: { dir: string; names: string[] }[] = [];

    for (const dir of dirs) {
      const held = names(path.join(this.root, dir));

      if (held.length > 0) found.push({ dir, names: held });

      await breath();
    }

    return found;
  }

  /** A partition's files, in path order, relative to the root. */
  async filesOf(key: PartitionKey): Promise<SourceFile[]> {
    const dataset = path.join(key.venue, key.market, descriptorOf(key));
    const wanted  = idOf(key);
    const breath  = breather();

    const dirs = key.bundle === 'market'
      ? [path.join(dataset, '@', key.month)]
      : (await this.instrumentsOf(dataset, breath)).map(instrument => path.join(dataset, instrument, key.month));

    const found: SourceFile[] = [];

    for (const dir of dirs) {
      for (const name of names(path.join(this.root, dir))) {
        const held = partitionOf(name);

        if (! held || idOf(held) !== wanted) continue;

        const info = stat(path.join(this.root, dir, name));

        if (info?.isFile()) found.push({ path: path.join(dir, name), bytes: info.size });
      }

      await breath();
    }

    return found.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  }

  // ── Internals ───────────────────────────────────────────────────────────────

  /** `FL/symbol` for every instrument of a dataset; `@` is not one. */
  private async instrumentsOf(dataset: string, breath: () => Promise<void>): Promise<string[]> {
    let listed = this.instruments.get(dataset);

    if (! listed) {
      listed = [];

      for (const letter of entries(path.join(this.root, dataset))) {
        if (! letter.isDirectory() || letter.name === '@') continue;

        for (const symbol of entries(path.join(this.root, dataset, letter.name)))
          if (symbol.isDirectory()) listed.push(path.join(letter.name, symbol.name));

        await breath();
      }

      this.instruments.set(dataset, listed);
    }

    return listed;
  }
}

/**
 * Whether what is on disk is what the catalog says a partition holds — by count
 * and by total size. No file is opened: the catalog's version already stands
 * for every file's content, and this only asks that they are all here.
 */
export const matches = (found: readonly SourceFile[], expected: { files: number; bytes: number }): boolean =>
  found.length === expected.files
  && found.reduce((total, one) => total + one.bytes, 0) === expected.bytes;

// ── Internals ─────────────────────────────────────────────────────────────────

/**
 * Something to call between steps of a long walk: it hands the thread back
 * once `BREATH_MS` have gone by since it last did, and otherwise costs nothing.
 */
const breather = (): (() => Promise<void>) => {
  let last = Date.now();

  return async (): Promise<void> => {
    if (Date.now() - last < BREATH_MS) return;

    await new Promise(resolve => setImmediate(resolve));

    last = Date.now();
  };
};

/** How long a walk may hold the thread before handing it back. */
const BREATH_MS = 20;

const entries = (dir: string): fs.Dirent[] => {
  try {
    return fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
};

const names = (dir: string): string[] => {
  try {
    return fs.readdirSync(dir);
  } catch {
    return [];
  }
};

const stat = (absolute: string): fs.Stats | null => {
  try {
    return fs.statSync(absolute);
  } catch {
    return null;
  }
};
