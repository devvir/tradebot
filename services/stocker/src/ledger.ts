import { appendFile, readFile, stat } from 'node:fs/promises';
import { basename, dirname, join, relative } from 'node:path';
import { logger } from '@devvir/service-kit';
import config from './config';
import { Slices, clear, filesAt, filesOf, isWhole, monthOf, sliceDirOf } from './vault';
import type { Edge, Entry, Partition, Side, Stocked, VaultKey } from './types';

/**
 * The vault's own account of what it holds: one line per partition stocked.
 *
 *     <vault>/ledger.csv    written here, a line appended as each partition is stocked
 *     <vault>/backedup.csv  written by whoever keeps a copy of the vault elsewhere; read here
 *     <vault>/ERROR.log     written here, when the vault is not what the ledger says
 *
 * **The ledger says what was stocked, from what, and what it weighed.** Whether
 * a partition is current is then a lookup and not a walk over its slice's
 * directories — and it stays answerable when the files are not there, which is
 * what lets a partition be moved out of the vault without being stocked again.
 *
 * **A line is never changed.** A partition stocked again gets another line, and
 * the last line for a partition is the one that counts — so the file is only
 * ever appended to, and can be read while it is.
 *
 * **A partition whose files are being changed says so first.** The vault's files
 * carry no mark of which build wrote them, so the ledger is the only thing that
 * can tell a month whole from one caught half way. Before the first file of a
 * stocked month is touched a line is written for it with `updating` where its
 * revision goes, and the line that says what it now holds follows the last file.
 * A partition whose last line says `updating` is not stocked, to anyone reading:
 * its files are some of one build and some of another. See `repair`.
 *
 * **A side a neighbouring month holds is said three ways**: nothing, where the
 * month has no such side; the neighbour's version, where its hours were read;
 * and `missing`, where the neighbour was not there. A month with a side missing
 * is stocked and partial, and its line says exactly what it lacks.
 *
 * **Fields are separated by `|`**, since the catalog's own names carry commas
 * (`klines,1h`). No field may hold one, or a line break; a value that does is
 * refused, never escaped.
 *
 * `backedup.csv` answers one thing: which partitions have a safe copy
 * somewhere else, at which revision. A partition that has one is nothing to
 * worry about here whatever of it is in the vault — all of it, some of its
 * files, or none: whoever holds the copy moves files out and brings them back
 * as space allows, and that is theirs to keep track of. It is read here and
 * never written.
 */

/** A vault partition as both files name it: its slice's directory below the vault, then its month. */
export const partitionOf = (key: VaultKey): string =>
  `${relative(config.vaultDir, sliceDirOf(key))}/${monthOf(key)}`;

/**
 * The ledger as it is now: the last line for each partition, less any the
 * vault was found not to hold.
 */
export const read = async (): Promise<Map<string, Entry>> => {
  const entries = new Map<string, Entry>();

  for (const entry of await entriesOf()) {
    if (entry.revision === UPDATING) entries.delete(entry.partition);
    else entries.set(entry.partition, entry);
  }

  for (const [partition, revision] of distrusted)
    if (entries.get(partition)?.revision === revision) entries.delete(partition);

  return entries;
};

/** The partitions that have a safe copy elsewhere, each by the revisions that do. */
export const readBackedUp = async (): Promise<Map<string, Set<string>>> => {
  const safe = new Map<string, Set<string>>();

  for (const [partition, revision] of await linesOf(BACKEDUP, 2))
    safe.set(partition!, (safe.get(partition!) ?? new Set()).add(revision!));

  return safe;
};

/**
 * Write down a partition that is in the vault whole: what it was stocked from,
 * and what its files weigh.
 */
export const record = async (
  key:       VaultKey,
  source:    Partition,
  edges:     readonly Edge[],
  missing:   readonly Side[],
  revision:  string,
  stocked:   Stocked,
): Promise<Entry> => {
  const files = filesOf(key, stocked);

  let size = 0;

  for (const file of files) size += (await stat(file)).size;

  const entry = { ...lineOf(key, source, edges, missing, ! stocked.bundle), revision, size, count: files.length };

  await append(entry);

  // Stocked again, so whatever was wrong with it before is no longer what is there.
  distrusted.delete(entry.partition);

  return entry;
};

/**
 * Say that a partition's files are about to be changed, before any of them is.
 *
 * The line holds what the partition is being stocked from, so that what was
 * being done to it can be read back: see `repair`.
 */
export const mark = async (
  key:     VaultKey,
  source:  Partition,
  edges:   readonly Edge[],
  missing: readonly Side[],
  split:   boolean,
): Promise<void> =>
  append({ ...lineOf(key, source, edges, missing, split), revision: UPDATING, size: 0, count: 0 });

/**
 * Put right every partition that was being changed when something stopped it.
 *
 * Run before anything reads the vault: as the service starts, and before each
 * sweep — nothing else writes here, so a partition still saying `updating` then
 * is one nobody is updating.
 *
 * **A month that was only being given a neighbour's hours goes back to what it
 * was.** Its own files were never touched, so the sides being added are removed
 * and the line it had before is written again: stocked, and still without them.
 * That is told from the two lines — the same rendering at the same version,
 * with a side that was `missing` and no longer is.
 *
 * **Any other is no longer stocked.** Some of its files are of the month that
 * was there and some of the one arriving, and neither can be told from the
 * other, so all of them are removed and the next sweep stocks it from its
 * archives. Its `updating` line stays the last, which is what says so.
 *
 * Returns how many partitions were put right.
 */
export const repair = async (): Promise<number> => {
  const last   = new Map<string, Entry>();
  const before = new Map<string, Entry>();

  for (const entry of await entriesOf()) {
    if (entry.revision !== UPDATING) before.set(entry.partition, entry);

    last.set(entry.partition, entry);
  }

  const slices = new Slices();
  let repaired = 0;

  for (const entry of last.values()) {
    if (entry.revision !== UPDATING) continue;

    const dir   = join(config.vaultDir, dirname(entry.partition));
    const month = basename(entry.partition);
    const held  = (await slices.at(dir)).get(month);
    const was   = before.get(entry.partition);
    const added = was ? sidesAdded(was, entry) : [];

    if (was && added.length > 0) {
      await clear(dir, month, held, added);
      await append(was);

      logger.warn({ partition: entry.partition, sides: added },
        'A partition was stopped while a neighbouring month\'s hours were added to it — they will be added again');
    }
    // Nothing of it in the vault means it was put right before, and is waiting to be stocked.
    else if (held) {
      await clear(dir, month, held);

      logger.warn({ partition: entry.partition },
        'A partition was stopped while its files were replaced — what was left of it is removed, and it will be stocked again');
    }
    else continue;

    repaired++;
  }

  return repaired;
};

/**
 * Set the ledger against the vault, once, as the service starts.
 *
 * Whatever was caught half way is put right first — see `repair` — so what is
 * left to find is a partition nothing here was doing anything to.
 *
 * **A partition the ledger holds and the vault does not is a loss**, unless a
 * safe copy of it exists. It is written to `ERROR.log` — a file, so that it is
 * still there when nobody was watching the log — and from then on the partition
 * is taken as not stocked, so the next sweep stocks it again. The service
 * carries on: one partition gone is no reason to stop stocking the rest, and
 * every reason to find out why.
 *
 * A bundle is checked for its file and its size; a partition stored per
 * instrument for how many files it has. **A partition with a safe copy at its
 * revision is not looked at**: whatever of it is here, nothing is lost. Returns
 * how many were found wrong.
 */
export const validate = async (): Promise<number> => {
  await repair();

  const entries = await read();
  const safe    = await readBackedUp();
  const slices  = new Slices();
  const wrong: string[] = [];

  for (const entry of entries.values()) {
    if (safe.get(entry.partition)?.has(entry.revision)) continue;

    const dir   = join(config.vaultDir, dirname(entry.partition));
    const month = basename(entry.partition);
    const held  = (await slices.at(dir)).get(month);

    let problem: string | null = null;

    const count = held ? (held.bundle ? 1 : held.symbols.length) + held.sides.length : 0;

    if (! isWhole(held)) problem = 'its files are not in the vault';
    else if (count !== entry.count) problem = `it has ${count} files where the ledger says ${entry.count}`;
    else if (entry.mode === 'bundle') {
      // Few files, so each is weighed: its own, and one for each side a neighbour held of it.
      let size = 0;

      for (const file of filesAt(dir, month, held!)) size += (await stat(file)).size;

      if (size !== entry.size) problem = `its files weigh ${size} bytes where the ledger says ${entry.size}`;
    }

    if (! problem) continue;

    distrusted.set(entry.partition, entry.revision);
    wrong.push(`${entry.partition}|${entry.revision}|${problem}`);
  }

  if (wrong.length === 0) return 0;

  const known = new Set((await readFile(join(config.vaultDir, ERRORS), 'utf8').catch(() => ''))
    .split('\n').map(line => line.slice(line.indexOf('|') + 1)));
  const fresh = wrong.filter(line => ! known.has(line));
  const at    = new Date().toISOString();

  if (fresh.length > 0)
    await appendFile(join(config.vaultDir, ERRORS), fresh.map(line => `${at}|${line}\n`).join(''));

  logger.error({ partitions: wrong.length, first: wrong[0], log: join(config.vaultDir, ERRORS) },
    'The vault does not hold what its ledger says — those partitions will be stocked again');

  return wrong.length;
};

/** Whether the vault was found not to hold what the ledger says of a partition; it is then stocked again, never taken on trust. */
export const distrusts = (partition: string): boolean => distrusted.has(partition);

/** What a side's version says where the neighbour holding that side was not there to be read. */
export const MISSING = 'missing';

/** What a line says in place of a revision while its partition's files are being changed. */
export const UPDATING = 'updating';

/** What the vault's files are called. */
export const LEDGER  = 'ledger.csv';
export const BACKEDUP = 'backedup.csv';
export const ERRORS  = 'ERROR.log';

// ── Internals ─────────────────────────────────────────────────────────────────

/** The ledger's columns, in the order a line holds them. */
const COLUMNS = [
  'partition', 'venue', 'market', 'dataset', 'variant', 'grain', 'bundle', 'month', 'mode',
  'version', 'preVersion', 'postVersion', 'revision', 'size', 'count', 'stockedAt',
] as const satisfies readonly (keyof Entry)[];

/** Partitions whose line the vault was found not to bear out, by the revision that line names. */
const distrusted = new Map<string, string>();

/** A line for a partition stocked from these, less what is only known once its files are in place. */
const lineOf = (
  key:     VaultKey,
  source:  Partition,
  edges:   readonly Edge[],
  missing: readonly Side[],
  split:   boolean,
): Omit<Entry, 'revision' | 'size' | 'count'> => {
  /** A side's version: the neighbour's that was read, `missing` where there was none to read, nothing where the month has no such side. */
  const sideOf = (side: Side): string =>
    edges.find(edge => edge.end === side)?.partition.version ?? (missing.includes(side) ? MISSING : '');

  return {
    partition:   partitionOf(key),
    venue:       source.key.venue,
    market:      source.key.market,
    dataset:     source.key.dataset,
    variant:     source.key.variant,
    grain:       source.key.grain,
    bundle:      source.key.bundle,
    month:       source.key.month.replace('-', ''),
    mode:        split ? 'split' : 'bundle',
    version:     source.version,
    preVersion:  sideOf('pre'),
    postVersion: sideOf('post'),
    stockedAt:   new Date().toISOString(),
  };
};

/** Add a line to the ledger. */
const append = async (entry: Entry): Promise<void> => {
  const fields = COLUMNS.map(name => String(entry[name]));
  const bad    = fields.find(field => /[|\r\n]/.test(field));

  if (bad !== undefined) throw new Error(`A ledger field may not hold '|' or a line break: ${JSON.stringify(bad)}`);

  await appendFile(join(config.vaultDir, LEDGER), `${await headed(LEDGER, COLUMNS)}${fields.join('|')}\n`);
};

/** Every line of the ledger, in the order they were written. */
const entriesOf = async (): Promise<Entry[]> =>
  (await linesOf(LEDGER, COLUMNS.length)).map((fields) => {
    const entry = Object.fromEntries(COLUMNS.map((name, at) => [name, fields[at]!])) as unknown as Record<keyof Entry, string>;

    return { ...entry, size: Number(entry.size), count: Number(entry.count) } as Entry;
  });

/**
 * The sides a line says a month has that the line before it said were missing —
 * where that is all that differs between them, so the month's own files are the
 * same under both.
 */
const sidesAdded = (was: Entry, now: Entry): Side[] => {
  const same = was.grain === now.grain && was.bundle === now.bundle && was.version === now.version;

  if (! same) return [];

  const ends: [Side, string, string][] = [['pre', was.preVersion, now.preVersion], ['post', was.postVersion, now.postVersion]];

  if (ends.some(([, then, at]) => then !== at && then !== MISSING)) return [];

  return ends.filter(([, then, at]) => then === MISSING && at !== MISSING).map(([side]) => side);
};

/** A file's lines as fields, without its heading; nothing where there is no file. Short lines are left out. */
const linesOf = async (name: string, width: number): Promise<string[][]> => {
  const text = await readFile(join(config.vaultDir, name), 'utf8').catch(() => '');

  return text.split('\n').slice(1)
    .filter(line => line !== '')
    .map(line => line.split('|'))
    .filter(fields => fields.length >= width);
};

/** The heading line, where the file does not exist yet and this write starts it. */
const headed = async (name: string, columns: readonly string[]): Promise<string> =>
  (await stat(join(config.vaultDir, name)).then(() => true, () => false)) ? '' : `${columns.join('|')}\n`;
