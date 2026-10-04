import { createHash } from 'node:crypto';
import { mkdir, readdir, rename, rm, statfs } from 'node:fs/promises';
import { join } from 'node:path';
import config from './config';
import { SCRATCH } from './containers';
import { fieldsOf } from './schema/tables';
import type { Partition, Series, VaultKey } from './types';

/**
 * The vault's layout, and how a stocked partition is recorded in it.
 *
 *     <vault>/venue=…/market=…/dataset=…[/interval=…][/kind=…]/YYYYMM/<version>/{FL}/symbol=…/<file>.parquet
 *
 * **A partition is one directory**, `…/YYYYMM/<version>/`, so it is written,
 * replaced, backed up and evicted as one thing. Inside it, one file per
 * instrument.
 *
 * **The version is the record.** It is a digest of everything the partition
 * was built from — the catalog's identity of every input, the series that read
 * them, the table it became — so a partition whose version directory exists is
 * current, and one whose inputs changed anywhere computes a version that is not
 * there yet. Nothing else is kept: no ledger, no list of files.
 *
 * Hive-style `key=value` directories are read back as columns by a query engine
 * and pruned on. The month, the version and the letter bucket are **bare**
 * segments: devices for handling the files, not facts about the data, so a
 * query engine ignores them and nothing can filter on them.
 */

/** `…/dataset=…[/interval=…][/kind=…]/YYYYMM`: where every version of a partition sits. */
export const monthDirOf = (key: VaultKey): string =>
  join(config.vaultDir, ...levelsOf(key), key.month.replace('-', ''));

/** One instrument's file, relative to its partition's version directory. */
export const fileOf = (key: VaultKey, symbol: string): string =>
  join(bucket(symbol), `symbol=${symbol}`, fileNameOf(key, symbol));

/**
 * The flattened name, because a file that leaves the tree travels alone: an
 * upload queue or a transfer log shows the name and not the path.
 */
export const fileNameOf = (key: VaultKey, symbol: string): string =>
  [key.table, key.venue, key.market, symbol, ...extrasOf(key), key.month.replace('-', '')]
    .join('.') + '.parquet';

/** How a vault partition is named in a log line. */
export const labelOf = (key: VaultKey): string =>
  [key.venue, key.market, key.table, ...extrasOf(key), key.month].join('|');

/** Every version of a partition present in the vault. */
export const versionsOf = async (key: VaultKey): Promise<string[]> =>
  (await readdir(monthDirOf(key)).catch(() => [] as string[])).filter(name => VERSION.test(name));

/**
 * The version a partition would be stocked at from these inputs.
 *
 * Folded in, in order: a revision of the build itself, bumped by hand when its
 * output changes for every partition alike; the canonical table; every series
 * that can read the dataset; the catalog's digest of the partition, and of any
 * neighbour's edge it spills into; and the symbol filter, so a partly stocked
 * partition can never pass for a whole one.
 */
export const versionOf = (
  key:       VaultKey,
  partition: Partition,
  series:    Series[],
  edges:     string[],
): string => {
  const hash = createHash('sha256');

  hash.update(`${REVISION}\n`);
  hash.update(JSON.stringify(fieldsOf(key.table)));
  hash.update(JSON.stringify(series));
  hash.update(`${partition.id}\n${partition.stats.digest}\n`);

  for (const edge of edges) hash.update(`${edge}\n`);

  hash.update(config.symbols.join(','));

  return hash.digest('hex').slice(0, 12);
};

/** Where a partition is built before it is published. */
export const stagingOf = (key: VaultKey, version: string): string =>
  join(config.vaultDir, SCRATCH, 'stage', `${labelOf(key).replace(/[|/]/g, '_')}.${version}`);

/**
 * Put a built partition in place, then remove every other version of it.
 *
 * The rename is the publish: one directory moves, on the same volume, so a
 * reader sees the old version or the new one and never half of either. A crash
 * between the rename and the removal leaves two versions; the next sweep finds
 * the current one and removes the rest.
 */
export const publish = async (key: VaultKey, version: string, staging: string): Promise<void> => {
  const month = monthDirOf(key);

  await mkdir(month, { recursive: true });
  await rm(join(month, version), { recursive: true, force: true });
  await rename(staging, join(month, version));
  await prune(key, version);
};

/** Remove every version of a partition but this one. */
export const prune = async (key: VaultKey, keep: string): Promise<void> => {
  for (const version of await versionsOf(key))
    if (version !== keep) await rm(join(monthDirOf(key), version), { recursive: true, force: true });
};

/** Free space on the vault's volume, in GB. */
export const freeGb = async (): Promise<number> => {
  const info = await statfs(config.vaultDir);

  return (info.bavail * info.bsize) / 1024 ** 3;
};

// ── Internals ─────────────────────────────────────────────────────────────────

/**
 * Bumped by hand when what the build writes changes for every partition alike —
 * a column added to every table, a change to how timestamps are read — so the
 * whole vault is restocked. A change to one series needs no bump: the series is
 * part of its own partitions' version.
 */
const REVISION = 1;

const VERSION = /^[0-9a-f]{12}$/;

const levelsOf = (key: VaultKey): string[] => [
  `venue=${key.venue}`,
  `market=${key.market}`,
  `dataset=${key.table}`,
  ...(key.interval ? [`interval=${key.interval}`] : []),
  ...(key.kind ? [`kind=${key.kind}`] : []),
];

const extrasOf = (key: VaultKey): string[] =>
  [key.interval, key.kind].filter((x): x is string => !! x);

/**
 * The letter a symbol is filed under, so a partition holds a few dozen entries
 * per letter instead of thousands of symbol directories side by side.
 * Anything that is not a letter goes to `_`.
 */
const bucket = (symbol: string): string => {
  const first = symbol.slice(0, 1).toUpperCase();

  return first >= 'A' && first <= 'Z' ? first : '_';
};
