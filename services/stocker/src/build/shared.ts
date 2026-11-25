import { mkdir, rename, rm } from 'node:fs/promises';
import { join } from 'node:path';
import type { DuckDBConnection } from '@duckdb/node-api';
import { hasContent } from '../containers';
import { q } from '../db';
import { formatOf } from '../formats';
import { marginOf } from '../schema/margin';
import { seriesFor } from '../schema/series';
import { MARGIN, fieldsOf } from '../schema/tables';
import { STAGED } from '../vault';
import type { Format } from '../formats/types';
import type { DiskFile, Series, Spent, VaultKey } from '../types';

/**
 * Row group size, in rows rather than bytes.
 *
 * Small enough that a time-range filter can skip most of a month, large enough
 * that the per-group footer is not the dominant cost. An instrument's rows are
 * written in `ts` order, which is what makes the group statistics worth having.
 */
const ROW_GROUP = 100_000;

/** How every staged file is written. */
export const PARQUET = `(FORMAT PARQUET, COMPRESSION ZSTD, ROW_GROUP_SIZE ${ROW_GROUP})`;

/** What a batch written as one file is named by, in place of an instrument: nothing a venue calls one begins so. */
export const WHOLE = '@batch.';

/** What a partition is refused for when a row of a series that names instruments names none. */
export const UNNAMED = 'an input has rows that name no instrument';

/** The next number of a sequence for temp tables and files, unique within the process. */
export const nextSequence = (): number => ++sequence;

let sequence = 0;

/** Where one instrument's file is written while its partition is being built. */
export const stagedOf = (staging: string, symbol: string): string => join(staging, `${symbol}${STAGED}`);

/** A clock that adds the time since it was last read to one of a partition's counts; nothing where none is kept. */
export const lapsInto = (spent?: Spent): ((into: keyof Spent) => void) => {
  let since = Date.now();

  return (into) => {
    const now = Date.now();

    if (spent) spent[into] += now - since;

    since = now;
  };
};

/**
 * What an input's files are read as, after the files a venue published empty
 * are dropped — see `hasContent`. One of them defines the schema for the whole
 * file set if it is left in, so this is what lets a month survive a delisting
 * day.
 *
 * `bySeries` gathers every kept file under the series it is read as, in the
 * inputs' order; `kept` is each input's kept files, in the same order as
 * `opened`.
 */
export const inspect = async (
  opened: readonly { input: DiskFile; unpacked: { paths: string[] } }[],
): Promise<{ bySeries: Map<Series, string[]>; kept: string[][] }> => {
  const bySeries = new Map<Series, string[]>();
  const kept: string[][] = [];

  for (const { input, unpacked } of opened) {
    const series = seriesFor(input.file);

    if (! series) throw new Error(`No series reads ${input.file.key}`);

    const content = await Promise.all(unpacked.paths.map(hasContent));
    const paths   = unpacked.paths.filter((_, at) => content[at]);

    kept.push(paths);

    for (const path of paths) {
      const read = asWritten(series, await formatOf(series.format, path));

      if (! bySeries.has(read)) bySeries.set(read, []);

      bySeries.get(read)!.push(path);
    }
  }

  return { bySeries, kept };
};

/**
 * A series as one of its files is written: itself, or itself read as the other
 * kind of table where the file turned out to be that. One object per series
 * and format, so files of one kind gather under one key.
 */
export const asWritten = (series: Series, format: string): Series => {
  if (format === series.format) return series;

  const known = written.get(series) ?? new Map<string, Series>();

  if (! known.has(format)) known.set(format, { ...series, format });

  written.set(series, known);

  return known.get(format)!;
};

const written = new WeakMap<Series, Map<string, Series>>();

/**
 * Write each instrument's rows of a temporary table into its own file in
 * `staging`, and say how many rows and files that made.
 *
 * `column` is what names a row's instrument in the table, `exclude` the table's
 * own columns that are not written, and `distinct` what `repeats` says of the
 * formats read.
 */
export const writeEach = async (
  conn:        DuckDBConnection,
  key:         VaultKey,
  table:       string,
  staging:     string,
  instruments: readonly string[],
  of:          { column: string; exclude: string; distinct: string },
): Promise<{ rows: number; files: number }> => {
  let rows  = 0;
  let files = 0;

  for (const instrument of instruments) {
    const out  = stagedOf(staging, instrument);
    const temp = `${out}.${nextSequence()}.tmp`;

    await mkdir(staging, { recursive: true });

    await conn.run(
      `COPY (SELECT ${of.distinct}${q(instrument)} AS symbol, * EXCLUDE (${of.exclude})${marginColumn(key, instrument)} FROM ${table}
             WHERE ${of.column} = ${q(instrument)} ORDER BY ${orderOf(key)})
       TO ${q(temp)} ${PARQUET}`,
    );

    const written = await settleFile(conn, temp, out, key, instrument);

    rows  += written;
    files += written > 0 ? 1 : 0;
  }

  return { rows, files };
};

/**
 * Check a written file and move it to its name, or drop it when it holds no
 * rows — an instrument with nothing in the month has no file.
 */
export const settleFile = async (
  conn:   DuckDBConnection,
  temp:   string,
  out:    string,
  key:    VaultKey,
  symbol: string,
): Promise<number> => {
  try {
    const reader = await conn.runAndReadAll(
      `SELECT count(*), min(ts), max(ts) FROM read_parquet(${q(temp)})`);
    const [count, lo, hi] = reader.getRows()[0]! as [unknown, unknown, unknown];
    const rows = Number(count);

    if (rows === 0) {
      await rm(temp, { force: true });

      return 0;
    }

    plausible(key, symbol, Number(lo), Number(hi));

    await rename(temp, out);

    return rows;
  } catch (err) {
    await rm(temp, { force: true });

    throw err;
  }
};

/** 2015-01-01 and 2035-01-01 in microseconds — generous, but off by 1000× is not. */
const EARLIEST = 1_420_070_400_000_000;
const LATEST   = 2_051_222_400_000_000;

/**
 * Refuse rows whose timestamps are not plausibly timestamps. Inference removes
 * the whole-file-1000×-off mistake; this catches the one it cannot — a `ts`
 * naming the wrong column, where values parse and mean nothing.
 */
export const plausible = (key: VaultKey, symbol: string, lo: number, hi: number): void => {
  if (lo < EARLIEST || hi > LATEST)
    throw new Error(
      `Implausible timestamps in ${labelFor(key, symbol)}: ${lo}..${hi} µs is outside 2015–2035. ` +
      `The series' 'ts' almost certainly names the wrong column.`,
    );
};

/**
 * Refuse an instrument, named by a row's own cell, that cannot be a file name.
 *
 * Its file is named by it, in staging and then in the vault, beside the other
 * instruments of the month. Empty, `.` or `..`, or holding a path separator or
 * NUL, the name would put the file somewhere else; opening with `@`, it would
 * stand where a month stored as one file does. Anything else a venue names an
 * instrument with — `_`, `-`, digits, any case — is a file name as it is.
 */
export const assertInstrumentName = (key: VaultKey, symbol: string, name: string): void => {
  if (name === '' || name === '.' || name === '..' || /[/\\\0]/.test(name) || name.startsWith('@'))
    throw new Error(`${labelFor(key, symbol)}: an input names an instrument that cannot be a file name: ${JSON.stringify(name)}`);
};

/**
 * `DISTINCT ` where any of the formats read repeats whole rows (`repeatsRows`),
 * so exact repeats are written once; nothing otherwise.
 */
export const repeats = (series: Series[]): string => (series.some(one => one.repeatsRows) ? 'DISTINCT ' : '');

/** The margining column, where the table carries one: a constant for the instrument. */
export const marginColumn = (key: VaultKey, symbol: string): string => {
  if (! fieldsOf(key.table).some(field => field.name === MARGIN.name)) return '';

  const margin = marginOf(key.venue, key.market, symbol);

  return `, CAST(${margin ? q(margin) : 'NULL'} AS VARCHAR) AS ${MARGIN.name}`;
};

/** How a build names a partition and one of its symbols in what it says. */
export const labelFor = (key: VaultKey, symbol: string): string =>
  [key.venue, key.market, symbol, key.table,
    key.interval ?? key.kind ?? (key.aggregated === 'true' ? 'aggregated' : ''), key.depth, key.month]
    .filter(Boolean).join('|');

/**
 * What a file's rows are sorted by: time, and where a table carries the
 * venue's own sequence, that within one time — a book's changes are stamped
 * coarsely enough that several share an instant, and their order is the book.
 */
export const orderOf = (key: VaultKey): string =>
  (fieldsOf(key.table).some(field => field.name === 'sequence') ? 'ts, sequence' : 'ts');

/**
 * Refuse a file wider than the series describes, naming it.
 *
 * A positional map is a claim about what each column *is*. When a venue serves
 * a file of a different shape — Gate published truncated copies of its spot
 * files among its futures trades for 2021-07, and spot carries an extra `side`
 * column — the first N columns still parse, so the build succeeds and writes
 * data that means something other than what it says. A loud failure names the
 * file so it can be looked at.
 */
export const assertDeclaredWidth = async (
  conn:   DuckDBConnection,
  format: Format,
  paths:  string[],
  series: Series,
  key:    VaultKey,
  symbol: string,
): Promise<void> => {
  const query = format.overflow?.(paths, series);

  if (! query) return;

  const wider = (await conn.runAndReadAll(query)).getRows().map(row => String(row[0]));

  if (wider.length === 0) return;

  throw new Error(
    `${labelFor(key, symbol)}: ${wider.length} input file${wider.length === 1 ? '' : 's'} ` +
    `have more columns than the series declares, so reading them by position ` +
    `would mean something other than what the map says. First: ${wider[0]}`,
  );
};

/**
 * Turn a failed build into a statement about the file, where the file is why.
 *
 * **Runs only after something has already gone wrong**: a malformed file cannot
 * produce wrong data, only no data, so nothing has to be caught before the
 * write. Silent when it finds nothing, and silent when the diagnosis itself
 * fails: an error raised while explaining an error would replace the only
 * account anybody has of what actually broke.
 */
export const explainMalformed = async (
  conn:   DuckDBConnection,
  format: Format,
  paths:  string[],
  series: Series,
  key:    VaultKey,
  symbol: string,
  cause:  Error,
): Promise<void> => {
  const query = format.malformed?.(paths, series);

  if (! query) return;

  let bad: string[] = [];

  try {
    bad = (await conn.runAndReadAll(query)).getRows().map(row => String(row[0]));
  } catch {
    return;
  }

  if (bad.length === 0) return;

  throw new Error(
    `${labelFor(key, symbol)}: ${bad.length} of ${paths.length} input file` +
    `${paths.length === 1 ? '' : 's'} do not parse into columns — their rows are ` +
    `narrower than their own header, so the venue published them malformed. ` +
    `First: ${bad[0]}. (${cause.message.split('\n')[0]})`,
  );
};
