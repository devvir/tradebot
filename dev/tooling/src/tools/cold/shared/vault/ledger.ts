import fs from 'node:fs';
import path from 'node:path';
import type { Bundle, Grain, Stocked } from '../types';

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
 * its files changed, or was when something stopped it; one whose last line says
 * `outdated` holds files of an older making, waiting to be stocked again.
 * Neither is stocked, and neither is answered here.
 */
export const stockedIn = (vaultRoot: string): Stocked[] | null => {
  const rows = rowsOf(path.join(vaultRoot, LEDGER));

  if (! rows) return null;

  const last = new Map<string, Stocked>();

  for (const row of rows) {
    if (row['revision'] === UPDATING || row['revision'] === OUTDATED) last.delete(row['partition']!);
    else last.set(row['partition']!, lineOf(row));
  }

  return [...last.values()];
};

/**
 * Every partition whose last line says `outdated`: stocked, at a revision that
 * is no longer what would be stocked, and waiting to be stocked again. What
 * each was stocked from is what its line says; its revision is not one.
 */
export const outdatedIn = (vaultRoot: string): Stocked[] => {
  const last = new Map<string, Stocked>();

  for (const row of rowsOf(path.join(vaultRoot, LEDGER)) ?? []) {
    if (row['revision'] === OUTDATED) last.set(row['partition']!, lineOf(row));
    else last.delete(row['partition']!);
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

/** What the vault was found not to hold, as it was written down; nothing where it was found whole. */
export const errorsIn = (vaultRoot: string): string[] => {
  try {
    return fs.readFileSync(path.join(vaultRoot, ERRORS), 'utf8').split('\n').filter(line => line.trim() !== '');
  } catch {
    return [];
  }
};

/** What a ledger line says of a side a neighbouring month holds, where that month was not there to be read. */
export const MISSING = 'missing';

export const LEDGER  = 'ledger.csv';

export const BACKEDUP = 'backedup.csv';

export const ERRORS  = 'ERROR.log';

// ── Internals ─────────────────────────────────────────────────────────────────

/** What a ledger line says in place of a revision while its partition's files are being changed. */
const UPDATING = 'updating';

const OUTDATED = 'outdated';

/** A ledger line, as what it says of a partition. */
const lineOf = (row: Record<string, string>): Stocked => ({
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
