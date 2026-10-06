import fs from 'node:fs';
import path from 'node:path';
import type { Bundle, Grain, Stocked, VaultFile } from './types';

/**
 * The vault's own account of itself, as `cold` reads it.
 *
 *     <vault>/ledger.csv    a line per partition stocked, the last one for a partition counting
 *     <vault>/backedup.csv  which partitions cold storage holds, and at which revision
 *     <vault>/ERROR.log     written when the vault was found not to hold what its ledger says
 *
 * All three are the vault's. The first and the last are written by whatever
 * stocks it and only read here. `backedup.csv` is cold's to write, a line when a
 * partition is stored: it is what tells whoever stocks the vault that a safe
 * copy exists, so that whatever of the partition is on disk — all of it, some
 * of its files, none — is no loss. Which files are away at any moment is not
 * written into the vault at all; that is cold's own record.
 *
 * **A file of the vault is named for what it holds and never for which build
 * wrote it**, so a partition stocked again is the same paths with other
 * contents, and the ledger's revision is the only thing that says so.
 *
 * Fields are separated by `|`, and columns are found by their heading, so a
 * column added to either file is not a change here.
 */

/**
 * Every partition the ledger says is stocked: the last line for each. Null
 * where the vault has no ledger.
 *
 * A partition whose last line says `updating` in place of a revision is having
 * its files changed, or was when something stopped it. It is not stocked, and
 * is not answered here.
 */
export const stockedIn = (vaultRoot: string): Stocked[] | null => {
  const rows = rowsOf(path.join(vaultRoot, LEDGER));

  if (! rows) return null;

  const last = new Map<string, Stocked>();

  for (const row of rows) {
    if (row['revision'] === UPDATING) {
      last.delete(row['partition']!);

      continue;
    }

    last.set(row['partition']!, {
      partition: row['partition']!,
      source: {
        venue: row['venue']!, market: row['market']!, dataset: row['dataset']!, variant: row['variant'] ?? '',
        grain: row['grain'] as Grain, bundle: row['bundle'] as Bundle, month: row['month']!,
      },
      version:     row['version']!,
      preVersion:  row['preVersion'] ?? '',
      postVersion: row['postVersion'] ?? '',
      revision:    row['revision']!,
      mode:        row['mode'] === 'split' ? 'split' : 'bundle',
      size:        Number(row['size'] ?? 0),
      count:       Number(row['count'] ?? 0),
    });
  }

  return [...last.values()];
};

/** The partitions `backedup.csv` says cold storage holds, each by the revisions it holds. */
export const backedUpIn = (vaultRoot: string): Map<string, Set<string>> => {
  const safe = new Map<string, Set<string>>();

  for (const row of rowsOf(path.join(vaultRoot, BACKEDUP)) ?? [])
    safe.set(row['partition']!, (safe.get(row['partition']!) ?? new Set()).add(row['revision']!));

  return safe;
};

/**
 * Say that cold storage holds a partition at a revision.
 *
 * A line appended; the file is never rewritten. This is the one thing cold
 * writes into the vault.
 */
export const noteBackedUp = (vaultRoot: string, partition: string, revision: string): void => {
  const file = path.join(vaultRoot, BACKEDUP);
  const head = fs.existsSync(file) ? '' : 'partition|revision|date\n';

  fs.appendFileSync(file, `${head}${partition}|${revision}|${new Date().toISOString()}\n`);
};

/**
 * Where a vault file is in cold storage, below the vault's root there:
 *
 *     venue/market/dataset[,variant…]/<@ or instrument>/<month>[.pre|.post].parquet
 *
 * **The values, without the names.** In the vault a directory is `interval=1h`
 * because a query engine reads it back as a column; in cold storage nothing
 * reads it, and the names are only noise. The variants are joined to the
 * dataset, so every file sits at the same depth whatever its dataset has —
 * which is how the archives are laid out there too.
 */
export const remoteOf = (file: Pick<VaultFile, 'partition' | 'instrument' | 'path'>): string => {
  const { levels } = locate(file.partition);
  const { venue, market, dataset, ...variants } = levels;

  return [venue, market, [dataset, ...Object.values(variants)].join(','), file.instrument, path.basename(file.path)].join('/');
};

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

/** The files an instrument can have of a month: its own, and what the month before and after held of it. */
const SIDES = ['', 'pre', 'post'] as const;

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

/** What the vault was found not to hold, as it was written down; nothing where it was found whole. */
export const errorsIn = (vaultRoot: string): string[] => {
  try {
    return fs.readFileSync(path.join(vaultRoot, ERRORS), 'utf8').split('\n').filter(line => line.trim() !== '');
  } catch {
    return [];
  }
};

/** What a ledger line says in place of a revision while its partition's files are being changed. */
const UPDATING = 'updating';

/** What a ledger line says of a side a neighbouring month holds, where that month was not there to be read. */
export const MISSING = 'missing';

export const LEDGER  = 'ledger.csv';
export const BACKEDUP = 'backedup.csv';
export const ERRORS  = 'ERROR.log';

// ── Internals ─────────────────────────────────────────────────────────────────

/** A file's lines as records keyed by its heading; null where there is no file. */
const rowsOf = (file: string): Record<string, string>[] | null => {
  let text: string;

  try {
    text = fs.readFileSync(file, 'utf8');
  } catch {
    return null;
  }

  const [heading, ...lines] = text.split('\n');
  const columns = (heading ?? '').split('|');

  return lines
    .filter(line => line !== '')
    .map(line => line.split('|'))
    .filter(fields => fields.length >= columns.length)
    .map(fields => Object.fromEntries(columns.map((name, at) => [name, fields[at]!])));
};
