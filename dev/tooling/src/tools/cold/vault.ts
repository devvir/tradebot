import fs from 'node:fs';
import path from 'node:path';
import type { Bundle, Grain, Stocked } from './types';

/**
 * The vault's own account of itself, as `cold` reads it.
 *
 *     <vault>/ledger.csv    a line per partition stocked, the last one for a partition counting
 *     <vault>/evicted.csv   whether a partition's files are meant to be absent
 *     <vault>/ERROR.log     written when the vault was found not to hold what its ledger says
 *
 * All three are the vault's. The first and the last are written by whatever
 * stocks it and only read here; `evicted.csv` is cold's to write, when it moves
 * vault partitions out and brings them back.
 *
 * Fields are separated by `|`, and columns are found by their heading, so a
 * column added to either file is not a change here.
 */

/** Every partition the ledger says is stocked: the last line for each. Null where the vault has no ledger. */
export const stockedIn = (vaultRoot: string): Stocked[] | null => {
  const rows = rowsOf(path.join(vaultRoot, LEDGER));

  if (! rows) return null;

  const last = new Map<string, Stocked>();

  for (const row of rows)
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
    });

  return [...last.values()];
};

/** The vault partitions meant to be absent, each by the revision that was moved out. */
export const evictedFrom = (vaultRoot: string): Map<string, string> => {
  const away = new Map<string, string>();

  for (const row of rowsOf(path.join(vaultRoot, EVICTED)) ?? [])
    if (row['evicted'] === 'true') away.set(row['partition']!, row['revision']!);
    else away.delete(row['partition']!);

  return away;
};

/** What the vault was found not to hold, as it was written down; nothing where it was found whole. */
export const errorsIn = (vaultRoot: string): string[] => {
  try {
    return fs.readFileSync(path.join(vaultRoot, ERRORS), 'utf8').split('\n').filter(line => line.trim() !== '');
  } catch {
    return [];
  }
};

export const LEDGER  = 'ledger.csv';
export const EVICTED = 'evicted.csv';
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
