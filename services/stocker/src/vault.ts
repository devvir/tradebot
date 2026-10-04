import { createHash } from 'node:crypto';
import { mkdir, readdir, rename, rm, statfs, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import config from './config';
import { SCRATCH } from './containers';
import { fieldsOf } from './schema/tables';
import type { Edge, Partition, Series, SliceIndex, Stocked, VaultKey } from './types';

/**
 * The vault's layout, and how a stocked partition is recorded in it.
 *
 *     <vault>/venue=…/market=…/dataset=…[/interval=…][/kind=…]/@/<YYYYMM>.<revision>.parquet
 *     <vault>/venue=…/market=…/dataset=…[/interval=…][/kind=…]/<symbol>/<YYYYMM>.<revision>.parquet
 *
 * **A month of a slice is stored one of two ways.** A small one is a single
 * file holding every instrument, under `@`. A large one is a file per
 * instrument, each under its symbol — so one instrument's share of a month that
 * weighs hundreds of gigabytes can be moved on its own. Which one is decided by
 * the weight of the archive files it was built from (`splitGb`). Every file
 * carries the symbol as a column, so the two read as one table.
 *
 * **The revision is the record.** It is a digest of everything the partition
 * was built from, so a month whose revision is in the vault is current, and one
 * whose inputs changed anywhere computes a revision that is not there yet.
 * Nothing else is kept: no ledger, no list of files.
 *
 * Hive-style `key=value` directories are read back as columns by a query engine
 * and pruned on. `@`, the symbol directories and the file names are **bare**:
 * devices for handling the files, not facts about the data.
 */

/** `…/dataset=…[/interval=…][/kind=…]`: where every month of a slice sits. */
export const sliceDirOf = (key: VaultKey): string => join(config.vaultDir, ...levelsOf(key));

/** The one file of a month stored whole. */
export const bundleOf = (key: VaultKey, revision: string): string =>
  join(sliceDirOf(key), BUNDLE, `${monthOf(key)}.${revision}.parquet`);

/** One instrument's file of a month stored per instrument. */
export const fileOf = (key: VaultKey, revision: string, symbol: string): string =>
  join(sliceDirOf(key), symbol, `${monthOf(key)}.${revision}.parquet`);

/** How a vault partition is named in a log line. */
export const labelOf = (key: VaultKey): string =>
  [key.venue, key.market, key.table, ...extrasOf(key), key.month].join('|');

/** `YYYYMM`, as file names write a partition's month. */
export const monthOf = (key: VaultKey): string => key.month.replace('-', '');

/**
 * The revision a partition would be stocked at from these inputs.
 *
 * Folded in, in order: a revision of the build itself, bumped by hand when its
 * output changes for every partition alike; the canonical table; every series
 * that can read the dataset; the catalog's version of the partition, and of any
 * neighbouring month it reads the edge of; and the symbol filter, so a partly
 * stocked partition can never pass for a whole one.
 */
export const revisionOf = (
  key:       VaultKey,
  partition: Partition,
  series:    Series[],
  edges:     Edge[],
): string => {
  const hash = createHash('sha256');

  hash.update(`${BUILD}\n`);
  hash.update(JSON.stringify(fieldsOf(key.table)));
  hash.update(JSON.stringify(series));
  hash.update(`${partition.id}\n${partition.version}\n`);

  for (const edge of edges) hash.update(`${edge.partition.id}\n${edge.side}\n${edge.partition.version}\n`);

  hash.update(config.symbols.join(','));

  return hash.digest('hex').slice(0, 12);
};

/** Where a partition is built before it is published. */
export const stagingOf = (key: VaultKey, revision: string): string =>
  join(config.vaultDir, SCRATCH, 'stage', `${labelOf(key).replace(/[|/]/g, '_')}.${revision}`);

/**
 * What the vault holds of each slice, read once per sweep.
 *
 * A slice stored per instrument is a directory per symbol, so asking it about
 * one month means listing every one of them — and a sweep asks about every
 * month. Reading the slice once answers them all.
 */
export class Slices {
  private readonly known = new Map<string, Promise<SliceIndex>>();

  of(key: VaultKey): Promise<SliceIndex> {
    const dir = sliceDirOf(key);

    let read = this.known.get(dir);

    if (! read) {
      read = indexOf(dir);
      this.known.set(dir, read);
    }

    return read;
  }

  /** After something was written to a slice: what was read of it is no longer what is there. */
  forget(key: VaultKey): void {
    this.known.delete(sliceDirOf(key));
  }
}

/**
 * Whether a revision is in the vault whole: one file under `@`, or files under
 * the symbols with nothing left saying they were still arriving.
 */
export const isWhole = (stocked: Stocked | undefined): boolean =>
  !! stocked && ! stocked.publishing && (stocked.bundle || stocked.symbols.length > 0);

/**
 * Put a month built as one file in place. The rename is the publish: one file
 * moves, on the same volume, so a reader sees it whole or not at all.
 */
export const publishBundle = async (key: VaultKey, revision: string, built: string): Promise<void> => {
  const out = bundleOf(key, revision);

  await mkdir(join(sliceDirOf(key), BUNDLE), { recursive: true });
  await rename(built, out);
};

/**
 * Put a month built as a file per instrument in place, each under its symbol.
 *
 * **Many renames cannot be one**, so a marker under `@` says the month is still
 * arriving: written before the first file moves and removed after the last. A
 * revision with its marker still there was interrupted, is not counted as
 * stocked, and is put in place again from the start.
 */
export const publishSplit = async (key: VaultKey, revision: string, staging: string): Promise<number> => {
  const marker = join(sliceDirOf(key), BUNDLE, `${monthOf(key)}.${revision}${PUBLISHING}`);
  const built  = (await readdir(staging)).filter(name => name.endsWith(STAGED));

  await mkdir(join(sliceDirOf(key), BUNDLE), { recursive: true });
  await writeFile(marker, '');

  for (const name of built) {
    const symbol = name.slice(0, -STAGED.length);

    await mkdir(join(sliceDirOf(key), symbol), { recursive: true });
    await rename(join(staging, name), fileOf(key, revision, symbol));
  }

  await rm(marker);

  return built.length;
};

/**
 * Remove every revision of a month but this one, wherever each is stored.
 *
 * A crash between a publish and this leaves two revisions; the next sweep finds
 * the current one and removes the rest.
 */
export const prune = async (key: VaultKey, keep: string, held: Map<string, Stocked>): Promise<void> => {
  for (const [revision, stocked] of held) {
    if (revision === keep) continue;

    await rm(bundleOf(key, revision), { force: true });
    await rm(join(sliceDirOf(key), BUNDLE, `${monthOf(key)}.${revision}${PUBLISHING}`), { force: true });

    for (const symbol of stocked.symbols) await rm(fileOf(key, revision, symbol), { force: true });
  }
};

/** Free space on the vault's volume, in GB. */
export const freeGb = async (): Promise<number> => {
  const info = await statfs(config.vaultDir);

  return (info.bavail * info.bsize) / 1024 ** 3;
};

/** What a file built for one instrument is called while it is still in staging. */
export const STAGED = '.parquet';

// ── Internals ─────────────────────────────────────────────────────────────────

/**
 * Bumped by hand when what the build writes changes for every partition alike —
 * a column added to every table, a change to how timestamps are read — so the
 * whole vault is restocked. A change to one series needs no bump: the series is
 * part of its own partitions' revision.
 */
const BUILD = 2;

/** The directory of the months stored whole, where a symbol's would be. */
const BUNDLE = '@';

/** What marks a month stored per instrument as still being put in place. */
const PUBLISHING = '.publishing';

/** `YYYYMM.<revision>.parquet`, or the same ending in the publishing marker. */
const NAME = /^(\d{6})\.([0-9a-f]{12})(\.parquet|\.publishing)$/;

/** Everything a slice's directory holds, by month and revision. */
const indexOf = async (dir: string): Promise<SliceIndex> => {
  const index: SliceIndex = new Map();

  const at = (month: string, revision: string): Stocked => {
    const revisions = index.get(month) ?? new Map<string, Stocked>();
    const stocked   = revisions.get(revision) ?? { bundle: false, symbols: [], publishing: false };

    revisions.set(revision, stocked);
    index.set(month, revisions);

    return stocked;
  };

  const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);

  for (const entry of entries) {
    if (! entry.isDirectory()) continue;

    for (const name of await readdir(join(dir, entry.name)).catch(() => [] as string[])) {
      const match = NAME.exec(name);

      if (! match) continue;

      const [, month, revision, kind] = match as unknown as [string, string, string, string];
      const stocked = at(month, revision);

      if (kind === PUBLISHING) stocked.publishing = true;
      else if (entry.name === BUNDLE) stocked.bundle = true;
      else stocked.symbols.push(entry.name);
    }
  }

  return index;
};

const levelsOf = (key: VaultKey): string[] => [
  `venue=${key.venue}`,
  `market=${key.market}`,
  `dataset=${key.table}`,
  ...(key.interval ? [`interval=${key.interval}`] : []),
  ...(key.kind ? [`kind=${key.kind}`] : []),
];

const extrasOf = (key: VaultKey): string[] =>
  [key.interval, key.kind].filter((x): x is string => !! x);
