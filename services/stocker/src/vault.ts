import { createHash } from 'node:crypto';
import { mkdir, readdir, rename, rm, statfs } from 'node:fs/promises';
import { join } from 'node:path';
import config from './config';
import { SCRATCH } from './containers';
import { fieldsOf } from './schema/tables';
import type { Edge, Partition, Series, Side, SliceIndex, Stocked, VaultKey } from './types';

/**
 * The vault's layout, and how a partition is put in place in it.
 *
 *     <vault>/venue=…/market=…/dataset=…[/interval=…][/kind=…]/@/<YYYYMM>.parquet
 *     <vault>/venue=…/market=…/dataset=…[/interval=…][/kind=…]/<symbol>/<YYYYMM>.parquet
 *     …/<@ or symbol>/<YYYYMM>.pre.parquet    the month's first hours, from the month before
 *     …/<@ or symbol>/<YYYYMM>.post.parquet   the month's last hours, from the month after
 *
 * **A file's name says what it holds and never which build wrote it.** A month
 * stocked again is written over the month that was there, so a file is found at
 * the same path for as long as the vault holds it. What it was built from is
 * written in the vault's ledger, and nowhere else — see `ledger.ts`.
 *
 * **What a neighbouring month's files hold of this one is a file of its own.**
 * Where a venue cuts its days away from UTC midnight, a month's first or last
 * hours sit in a file of the month next door. They are stocked beside the
 * month's own rows and not into them — so a month is the same files whether its
 * neighbour was there when it was stocked or came later, and the neighbour
 * arriving adds a small file where it would otherwise rewrite a large one.
 *
 * **A month of a slice is stored one of two ways.** A small one is a single
 * file holding every instrument, under `@`. A large one is a file per
 * instrument, each under its symbol — so one instrument's share of a month that
 * weighs hundreds of gigabytes can be moved on its own. Which one is decided by
 * the weight of the archive files it was built from. Every file
 * carries the symbol as a column, so the two read as one table.
 *
 * **The revision names what a partition was built from.** It is a digest of
 * every input, so a month stocked at a revision is current while that is the
 * revision its inputs compute, and one whose inputs changed anywhere computes a
 * revision that has not been stocked.
 *
 * Hive-style `key=value` directories are read back as columns by a query engine
 * and pruned on. `@`, the symbol directories and the file names are **bare**:
 * devices for handling the files, not facts about the data.
 */

/** `…/dataset=…[/interval=…][/kind=…]`: where every month of a slice sits. */
export const sliceDirOf = (key: VaultKey): string => join(config.vaultDir, ...levelsOf(key));

/** The one file of a month stored whole — or, with a side, the file of what a neighbouring month held of it. */
export const bundleOf = (key: VaultKey, side?: Side): string =>
  fileOf(key, BUNDLE, side);

/** One instrument's file of a month stored per instrument, or its file of a side. */
export const fileOf = (key: VaultKey, symbol: string, side?: Side): string =>
  pathOf(sliceDirOf(key), monthOf(key), symbol, side);

/** The same, for a slice named by its directory and a month as file names write it. */
export const pathOf = (dir: string, month: string, symbol: string, side?: Side): string =>
  join(dir, symbol, `${month}${side ? `.${side}` : ''}.parquet`);

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
 * that can read the dataset; and the catalog's version of the partition, and of
 * any neighbouring month it reads the edge of.
 *
 * **A neighbour that is not there is part of it too**: a month stocked without
 * the hours a neighbouring month holds of it has a revision of its own, and
 * gets another when they arrive.
 */
export const revisionOf = (
  key:       VaultKey,
  partition: Partition,
  series:    Series[],
  edges:     Edge[],
  missing:   readonly Side[] = [],
): string => {
  const hash = createHash('sha256');

  hash.update(`${BUILD}\n`);
  hash.update(JSON.stringify(fieldsOf(key.table)));
  hash.update(JSON.stringify(series));
  hash.update(`${partition.id}\n${partition.version}\n`);

  // What a neighbour holds of the month is stored apart from it: a layout a revision without this does not have.
  if (edges.length + missing.length > 0) hash.update('apart\n');

  for (const edge of edges) hash.update(`${edge.partition.id}\n${edge.side}\n${edge.partition.version}\n`);
  for (const side of [...missing].sort()) hash.update(`${side}\nmissing\n`);

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
    return this.at(sliceDirOf(key));
  }

  /** The same, for a slice named by its directory. */
  at(dir: string): Promise<SliceIndex> {
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

/** Whether a month's own rows are in the vault: one file under `@`, or files under the symbols. */
export const isWhole = (stocked: Stocked | undefined): boolean =>
  !! stocked && (stocked.bundle || stocked.symbols.length > 0);

/** Every file of a stocked month, absolute: its own, then what its neighbours held of it. */
export const filesOf = (key: VaultKey, stocked: Stocked): string[] =>
  filesAt(sliceDirOf(key), monthOf(key), stocked);

/** The same, for a slice named by its directory and a month as file names write it. */
export const filesAt = (dir: string, month: string, stocked: Stocked): string[] => [
  ...(stocked.bundle ? [BUNDLE] : stocked.symbols).map(symbol => pathOf(dir, month, symbol)),
  ...stocked.sides.map(({ symbol, side }) => pathOf(dir, month, symbol, side)),
];

/**
 * Take a month's files out of the vault: all of them, or only what neighbouring
 * months held of it on these sides.
 *
 * The first half of putting a month in place where one already is. Nothing of
 * the month that was there is left beside the one that arrives — not an
 * instrument it no longer has, nor a side its neighbour no longer gives.
 */
export const clear = async (dir: string, month: string, held: Stocked | undefined, sides?: readonly Side[]): Promise<void> => {
  if (! held) return;

  const files = sides
    ? held.sides.filter(one => sides.includes(one.side)).map(({ symbol, side }) => pathOf(dir, month, symbol, side))
    : filesAt(dir, month, held);

  for (const file of files) await rm(file, { force: true });
};

/** Put a month built as one file in place — or, with a side, the file of what a neighbouring month held of it. */
export const publishBundle = async (key: VaultKey, built: string, side?: Side): Promise<void> => {
  await mkdir(join(sliceDirOf(key), BUNDLE), { recursive: true });
  await rename(built, bundleOf(key, side));
};

/**
 * Put a month built as a file per instrument in place, each under its symbol.
 *
 * `sides` are the staging directories of what neighbouring months held of this
 * one; with no staging directory of its own, only they are put in place. Returns the instruments the month has a file for, and the side files
 * that went with them.
 *
 * **Many renames cannot be one**, so a month is in neither state while they
 * run. That is the ledger's to say, before the first file moves — see `mark`.
 */
export const publishSplit = async (
  key:     VaultKey,
  staging: string | null,
  sides:   readonly { side: Side; staging: string }[] = [],
): Promise<Pick<Stocked, 'symbols' | 'sides'>> => {
  const staged = async (dir: string): Promise<string[]> =>
    (await readdir(dir).catch(() => [] as string[])).filter(name => name.endsWith(STAGED)).map(name => name.slice(0, -STAGED.length));

  const symbols = staging === null ? [] : await staged(staging);
  const beside: Stocked['sides'] = [];

  for (const symbol of symbols) {
    await mkdir(join(sliceDirOf(key), symbol), { recursive: true });
    await rename(join(staging!, `${symbol}${STAGED}`), fileOf(key, symbol));
  }

  for (const { side, staging: from } of sides)
    for (const symbol of await staged(from)) {
      await mkdir(join(sliceDirOf(key), symbol), { recursive: true });
      await rename(join(from, `${symbol}${STAGED}`), fileOf(key, symbol, side));

      beside.push({ symbol, side });
    }

  return { symbols, sides: beside };
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
export const BUNDLE = '@';

/** `YYYYMM[.pre|.post].parquet`. */
const NAME = /^(\d{6})(?:\.(pre|post))?\.parquet$/;

/** Everything a slice's directory holds, by month. */
const indexOf = async (dir: string): Promise<SliceIndex> => {
  const index: SliceIndex = new Map();

  const at = (month: string): Stocked => {
    const stocked = index.get(month) ?? { bundle: false, symbols: [], sides: [] };

    index.set(month, stocked);

    return stocked;
  };

  const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);

  for (const entry of entries) {
    if (! entry.isDirectory()) continue;

    for (const name of await readdir(join(dir, entry.name)).catch(() => [] as string[])) {
      const match = NAME.exec(name);

      if (! match) continue;

      const [, month, side] = match as unknown as [string, string, Side | undefined];
      const stocked = at(month);

      if (side) stocked.sides.push({ symbol: entry.name, side });
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
