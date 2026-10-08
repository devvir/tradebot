import fs from 'node:fs';
import path from 'node:path';
import type { Stocked, VaultFile } from '../types';

/**
 * Where a vault file is in cold storage, below the vault's root there:
 *
 *     venue/market/dataset[,variant…]/<@ or instrument>/<month>[.pre|.post].parquet
 *
 * **The catalog's own variants, without the names.** In the vault a directory is
 * `interval=1h` because a query engine reads it back as a column; in cold
 * storage nothing reads it, and the names are only noise — see `variantsOf`. The variants are joined to the
 * dataset, so every file sits at the same depth whatever its dataset has —
 * which is how the archives are laid out there too.
 */
export const remoteOf = (file: Pick<VaultFile, 'partition' | 'instrument' | 'path'>): string => {
  const { levels } = locate(file.partition);

  return [levels['venue'], levels['market'], [levels['dataset'], ...variantsOf(levels)].join(','), file.instrument,
    path.basename(file.path)].join('/');
};

/**
 * A partition as a person reads it: `htx: perp/klines,1d/202010`. The venue,
 * then what of it — the values its path in the vault carries, without the names
 * a query engine needs and a reader does not.
 */
export const labelOf = (partition: string): string => {
  const { month, levels } = locate(partition);

  return `${levels['venue']}: ${[levels['market'], [levels['dataset'], ...variantsOf(levels)].join(','), month].join('/')}`;
};

/**
 * A file of the vault as a person reads it, from its path: its partition, and
 * the instrument where the file is one instrument's. How a month is stored and
 * what its files are called say nothing to a reader, and are left out.
 */
export const fileLabelOf = (file: string): string => {
  const [name, instrument, ...dir] = file.split('/').reverse() as [string, string, ...string[]];
  const [month, side] = name.split('.');

  return labelOf(`${dir.reverse().join('/')}/${month}`)
    + (instrument === BUNDLE ? '' : ` ${instrument}`)
    + (side === 'pre' || side === 'post' ? ` (${side})` : '');
};

/**
 * A partition's variants as the catalog names them, read off the levels its
 * path carries beyond venue, market and dataset: a kline's interval, funding's
 * kind — and, for trades, `aggregated` where the path says `aggregated=true`
 * and nothing where it says `false`, trades with no variant being every trade.
 */
export const variantsOf = (levels: Record<string, string>): string[] =>
  Object.entries(levels)
    .filter(([name]) => ! ['venue', 'market', 'dataset'].includes(name))
    .flatMap(([name, value]) => (name !== 'aggregated' ? [value] : value === 'false' ? [] : [value === 'true' ? 'aggregated' : value]));

/**
 * A stocked partition's files as they are on disk, or null where the vault does
 * not hold what the ledger says: the file of a partition stored whole, or one
 * per instrument.
 */
export const filesOf = (vaultRoot: string, stocked: Stocked): VaultFile[] | null => {
  const { dir, month } = locate(stocked.partition);

  /** An instrument's files of the month: its own, and one for each side a neighbouring month held of it. */
  const sized = (instrument: string): VaultFile[] => SIDES.flatMap((side) => {
    const file = path.join(dir, instrument, `${month}${side ? `.${side}` : ''}.parquet`);

    try {
      return [{ partition: stocked.partition, revision: stocked.revision, instrument, side, path: file,
        bytes: fs.statSync(path.join(vaultRoot, file)).size }];
    } catch {
      return [];
    }
  });

  let instruments = [BUNDLE];

  if (stocked.mode === 'split') {
    try {
      instruments = fs.readdirSync(path.join(vaultRoot, dir), { withFileTypes: true })
        .filter(entry => entry.isDirectory() && entry.name !== BUNDLE)
        .map(entry => entry.name)
        .sort();
    } catch {
      return null;
    }
  }

  const found = instruments.flatMap(sized);

  // A month's own file has to be there for each instrument counted; the ledger counts every file.
  return found.length === stocked.count && found.some(one => one.side === '') ? found : null;
};

/**
 * A partition's slice directory and month, and what its directory says of it:
 * `venue=htx/market=spot/dataset=klines/interval=1h/202010` is the slice
 * `venue=htx/…/interval=1h`, the month `202010`, and those four facts.
 */
export const locate = (partition: string): { dir: string; month: string; levels: Record<string, string> } => {
  const at     = partition.lastIndexOf('/');
  const dir    = partition.slice(0, at);
  const levels = Object.fromEntries(dir.split('/').map(level => {
    const cut = level.indexOf('=');

    return [level.slice(0, cut), level.slice(cut + 1)];
  }));

  return { dir, month: partition.slice(at + 1), levels };
};

/** The directory of a partition stored whole, and the instrument its one file is filed under. */
export const BUNDLE = '@';

// ── Internals ─────────────────────────────────────────────────────────────────

/** The files an instrument can have of a month: its own, and what the month before and after held of it. */
const SIDES = ['', 'pre', 'post'] as const;
