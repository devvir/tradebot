import { appendFile, readFile, stat } from 'node:fs/promises';
import { basename, dirname, join, relative } from 'node:path';
import { logger } from '@devvir/service-kit';
import config from './config';
import { Slices, bundleOf, fileOf, isWhole, monthOf, sliceDirOf } from './vault';
import type { Edge, Entry, Evicted, Partition, Stocked, VaultKey } from './types';

/**
 * The vault's own account of what it holds: one line per partition stocked.
 *
 *     <vault>/ledger.csv    written here, a line appended as each partition is stocked
 *     <vault>/evicted.csv   written by whoever moves partitions out of the vault; read here
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
 * **Fields are separated by `|`**, since the catalog's own names carry commas
 * (`klines,1h`). No field may hold one, or a line break; a value that does is
 * refused, never escaped.
 *
 * `evicted.csv` answers one thing: whether a partition's files are meant to be
 * absent. It is read here and never written; who writes it keeps the history of
 * what it moved and when.
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

  for (const fields of await linesOf(LEDGER, COLUMNS.length)) {
    const entry = Object.fromEntries(COLUMNS.map((name, at) => [name, fields[at]!])) as unknown as Record<keyof Entry, string>;

    entries.set(entry.partition, {
      ...entry,
      size:  Number(entry.size),
      count: Number(entry.count),
    } as Entry);
  }

  for (const [partition, revision] of distrusted)
    if (entries.get(partition)?.revision === revision) entries.delete(partition);

  return entries;
};

/** Which partitions are meant to be absent from the vault: the last line for each. */
export const readEvicted = async (): Promise<Map<string, Evicted>> => {
  const evicted = new Map<string, Evicted>();

  for (const [partition, revision, flag, date] of await linesOf(EVICTED, 4))
    evicted.set(partition!, { partition: partition!, revision: revision!, evicted: flag === 'true', date: date! });

  return evicted;
};

/**
 * Write down a partition that is in the vault whole: what it was stocked from,
 * and what its files weigh.
 *
 * Used when a partition has just been stocked, and when one is found in the
 * vault that the ledger has no line for — one stocked before there was a
 * ledger, or published a moment before a crash. Both are the same statement.
 */
export const record = async (
  key:       VaultKey,
  source:    Partition,
  edges:     readonly Edge[],
  revision:  string,
  stocked:   Stocked,
): Promise<Entry> => {
  const files = stocked.bundle
    ? [bundleOf(key, revision)]
    : stocked.symbols.map(symbol => fileOf(key, revision, symbol));

  let size = 0;

  for (const file of files) size += (await stat(file)).size;

  const entry: Entry = {
    partition:   partitionOf(key),
    venue:       source.key.venue,
    market:      source.key.market,
    dataset:     source.key.dataset,
    variant:     source.key.variant,
    grain:       source.key.grain,
    bundle:      source.key.bundle,
    month:       source.key.month.replace('-', ''),
    mode:        stocked.bundle ? 'bundle' : 'split',
    version:     source.version,
    preVersion:  edges.find(edge => edge.partition.key.month < source.key.month)?.partition.version ?? '',
    postVersion: edges.find(edge => edge.partition.key.month > source.key.month)?.partition.version ?? '',
    revision,
    size,
    count:       files.length,
    stockedAt:   new Date().toISOString(),
  };

  const fields = COLUMNS.map(name => String(entry[name]));
  const bad    = fields.find(field => /[|\r\n]/.test(field));

  if (bad !== undefined) throw new Error(`A ledger field may not hold '|' or a line break: ${JSON.stringify(bad)}`);

  await appendFile(join(config.vaultDir, LEDGER), `${await headed(LEDGER, COLUMNS)}${fields.join('|')}\n`);

  // Stocked again, so whatever was wrong with it before is no longer what is there.
  distrusted.delete(entry.partition);

  return entry;
};

/**
 * Set the ledger against the vault, once, as the service starts.
 *
 * **A partition the ledger holds and the vault does not is a loss**, unless it
 * is meant to be absent. It is written to `ERROR.log` — a file, so that it is
 * still there when nobody was watching the log — and from then on the partition
 * is taken as not stocked, so the next sweep stocks it again. The service
 * carries on: one partition gone is no reason to stop stocking the rest, and
 * every reason to find out why.
 *
 * A bundle is checked for its file and its size; a partition stored per
 * instrument for how many files it has. Returns how many were found wrong.
 */
export const validate = async (): Promise<number> => {
  const entries = await read();
  const evicted = await readEvicted();
  const slices  = new Slices();
  const wrong: string[] = [];

  for (const entry of entries.values()) {
    const away = evicted.get(entry.partition);

    if (away?.evicted && away.revision === entry.revision) continue;

    const dir   = join(config.vaultDir, dirname(entry.partition));
    const month = basename(entry.partition);
    const held  = (await slices.at(dir)).get(month)?.get(entry.revision);

    let problem: string | null = null;

    if (! isWhole(held)) problem = 'its files are not in the vault';
    else if (entry.mode === 'bundle') {
      const size = (await stat(join(dir, '@', `${month}.${entry.revision}.parquet`))).size;

      if (size !== entry.size) problem = `its file weighs ${size} bytes where the ledger says ${entry.size}`;
    }
    else if (held!.symbols.length !== entry.count)
      problem = `it has ${held!.symbols.length} files where the ledger says ${entry.count}`;

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

/** What the vault's files are called. */
export const LEDGER  = 'ledger.csv';
export const EVICTED = 'evicted.csv';
export const ERRORS  = 'ERROR.log';

// ── Internals ─────────────────────────────────────────────────────────────────

/** The ledger's columns, in the order a line holds them. */
const COLUMNS = [
  'partition', 'venue', 'market', 'dataset', 'variant', 'grain', 'bundle', 'month', 'mode',
  'version', 'preVersion', 'postVersion', 'revision', 'size', 'count', 'stockedAt',
] as const satisfies readonly (keyof Entry)[];

/** Partitions whose line the vault was found not to bear out, by the revision that line names. */
const distrusted = new Map<string, string>();

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
