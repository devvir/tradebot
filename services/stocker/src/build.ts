import { mkdir, readdir, rename, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { logger } from '@devvir/service-kit';
import type { DuckDBConnection } from '@duckdb/node-api';
import config from './config';
import { SCRATCH, hasContent, unpackAll } from './containers';
import { q } from './db';
import { formatFor, formatOf } from './formats';
import { marginOf } from './schema/margin';
import { selectFor } from './schema/project';
import { seriesFor } from './schema/series';
import { MARGIN, fieldsOf } from './schema/tables';
import { clipFor } from './spill';
import { STAGED } from './vault';
import type { UnpackedAll } from './containers';
import type { Format } from './formats/types';
import type { DiskFile, Series, VaultKey } from './types';

/**
 * Row group size, in rows rather than bytes.
 *
 * Small enough that a time-range filter can skip most of a month, large enough
 * that the per-group footer is not the dominant cost. Rows are written in `ts`
 * order, which is what makes the group statistics worth having.
 */
const ROW_GROUP = 100_000;

/**
 * Stock one instrument's files — or one bundle's — into the partition being
 * built in `staging`, and say how many rows and files it wrote.
 *
 * `inputs` are the files of one catalog symbol for the month, plus whatever a
 * neighbouring month's files carry into it. Each file is read by the series
 * that claims it, so one call can union two formats (two eras, or two
 * margining shapes) into one canonical relation.
 *
 * **One output file per instrument**, in `staging`, each carrying its symbol
 * as a column. Where the series names an instrument column — a market bundle, a
 * futures chain — the rows are split by it; otherwise the catalog symbol is the
 * instrument.
 *
 * Nothing is written outside `staging`; publishing it is the caller's.
 *
 * `prepared` is the inputs' archives already extracted, in the inputs' order,
 * where the caller had that done ahead; they are removed here either way.
 */
export const buildGroup = async (
  conn:    DuckDBConnection,
  key:     VaultKey,
  symbol:  string,
  inputs:  DiskFile[],
  staging: string,
  prepared?: UnpackedAll,
): Promise<{ rows: number; files: number }> => {
  const unpacked = prepared
    ?? await unpackAll(inputs.map(input => ({ absolute: input.absolute, container: input.file.container })));
  const opened   = inputs.map((input, at) => ({ input, unpacked: { paths: unpacked.paths[at]! } }));

  try {
    const bySeries = new Map<Series, string[]>();

    for (const { input, unpacked } of opened) {
      const series = seriesFor(input.file);

      if (! series) throw new Error(`No series reads ${input.file.key}`);

      /**
       * Files a venue published empty are dropped before the reader sees them —
       * see `hasContent`. One of them defines the schema for the whole file set
       * if it is left in, so this is what lets a month survive a delisting day.
       */
      const content = await Promise.all(unpacked.paths.map(hasContent));
      const paths   = unpacked.paths.filter((_, at) => content[at]);

      for (const path of paths) {
        const read = asWritten(series, await formatOf(series.format, path));

        if (! bySeries.has(read)) bySeries.set(read, []);

        bySeries.get(read)!.push(path);
      }
    }

    // Nothing but empty files: the venue published for this month and
    // published nothing in it, so this instrument has no file.
    if (bySeries.size === 0) return { rows: 0, files: 0 };

    const selects: string[] = [];
    const split = [...bySeries.keys()].map(series => series.instrument);

    if (new Set(split).size > 1)
      throw new Error(`${labelFor(key, symbol)}: its formats disagree on whether rows name their instrument`);

    for (const [series, paths] of bySeries) {
      const format = formatFor(series.format);

      for (const extension of format.extensions ?? []) {
        await conn.run(`INSTALL ${extension}`);
        await conn.run(`LOAD ${extension}`);
      }

      await assertDeclaredWidth(conn, format, paths, series, key, symbol);

      const extra = series.instrument ? [`CAST(${series.instrument} AS VARCHAR) AS _instrument`] : [];

      selects.push(`SELECT * FROM (${selectFor(series, format.relation(paths, series), extra)})`);
    }

    /**
     * A row whose timestamp resolved to nothing is not a row: it is a header
     * line from a file that grew one partway through its history, or a trailing
     * fragment. The clip bounds a spilling series to its own month — its inputs
     * include a neighbouring bucket precisely so the month is whole.
     */
    const anySeries = [...bySeries.keys()][0]!;
    const relation  = `(${selects.join(' UNION ALL ')}) WHERE ts IS NOT NULL${clipFor(anySeries, key.month)}`;

    const distinct = repeats([...bySeries.keys()]);

    try {
      return split[0]
        ? await writeSplit(conn, key, relation, staging, distinct)
        : await writeOne(conn, key, symbol, relation, staging, distinct);
    } catch (err) {
      for (const [series, paths] of bySeries)
        await explainMalformed(conn, formatFor(series.format), paths, series, key, symbol, err as Error);

      throw err;
    }
  } finally {
    await unpacked.dispose();
  }
};

/**
 * Stock many small instruments in **one read**, then write each from it.
 *
 * Per instrument, the fixed costs of a read — opening the files, setting up
 * the CSV reader, a width check of its own — dwarf the work on a small file: a
 * month of daily candles is a few dozen rows, and reading it alone cost ~86 ms
 * where its share of a batched read costs ~20 ms (measured on gate's `1d`
 * klines, 2026-10-04). So small instruments are read together into a temporary
 * table, the width check rides along in the same pass, and only the write is
 * done per instrument.
 *
 * Each row's instrument is its catalog symbol — known from the file it came
 * from — unless the series names an instrument column, which then wins.
 */
export const buildBatch = async (
  conn:    DuckDBConnection,
  key:     VaultKey,
  groups:  { symbol: string; inputs: DiskFile[] }[],
  staging: string,
  prepared?: UnpackedAll,
): Promise<{ rows: number; files: number }> => {
  const flat     = groups.flatMap(group => group.inputs.map(input => ({ symbol: group.symbol, input })));
  const unpacked = prepared
    ?? await unpackAll(flat.map(({ input }) => ({ absolute: input.absolute, container: input.file.container })));
  const opened   = flat.map((one, at) => ({ ...one, unpacked: { paths: unpacked.paths[at]! } }));

  const table = `batch_${process.pid}_${++sequence}`;

  try {
    const bySeries = new Map<Series, string[]>();
    const owners: string[] = [];

    for (const { symbol, input, unpacked } of opened) {
      const series = seriesFor(input.file);

      if (! series) throw new Error(`No series reads ${input.file.key}`);

      // Empty files are dropped before the reader sees them — see `hasContent`.
      const content = await Promise.all(unpacked.paths.map(hasContent));
      const paths   = unpacked.paths.filter((_, at) => content[at]);

      for (const path of paths) owners.push(`(${q(path)}, ${q(symbol)})`);

      for (const path of paths) {
        const read = asWritten(series, await formatOf(series.format, path));

        if (! bySeries.has(read)) bySeries.set(read, []);

        bySeries.get(read)!.push(path);
      }
    }

    if (bySeries.size === 0) return { rows: 0, files: 0 };

    const selects: string[] = [];

    for (const [series, paths] of bySeries) {
      const format = formatFor(series.format);

      for (const extension of format.extensions ?? []) {
        await conn.run(`INSTALL ${extension}`);
        await conn.run(`LOAD ${extension}`);
      }

      const extra = [
        'filename AS _file',
        series.instrument
          ? `CAST(${series.instrument} AS VARCHAR) AS _instrument`
          : 'CAST(NULL AS VARCHAR) AS _instrument',
        `${format.wide?.(series) ?? 'false'} AS _wide`,
      ];

      selects.push(`SELECT * FROM (${selectFor(series, format.relation(paths, series, true), extra)})`);
    }

    const anySeries = [...bySeries.keys()][0]!;

    try {
      await conn.run(
        `CREATE TEMP TABLE ${table} AS
         SELECT u.* EXCLUDE (_file), coalesce(u._instrument, m.sym) AS _sym, u._file
           FROM (${selects.join(' UNION ALL ')}) u
           JOIN (VALUES ${owners.join(', ')}) m(file, sym) ON u._file = m.file
          WHERE ts IS NOT NULL${clipFor(anySeries, key.month)}`,
      );
    } catch (err) {
      for (const [series, paths] of bySeries)
        await explainMalformed(conn, formatFor(series.format), paths, series, key, groups[0]!.symbol, err as Error);

      throw err;
    }

    /**
     * A file wider than a positional series describes reads successfully and
     * means something else — see `assertDeclaredWidth`, which this replaces in
     * a batch: the overflow column was read in the same pass.
     */
    const wide = (await conn.runAndReadAll(`SELECT _file FROM ${table} WHERE _wide LIMIT 1`)).getRows();

    if (wide.length)
      throw new Error(
        `${labelFor(key, groups[0]!.symbol)}: an input file has more columns than the series declares, ` +
        `so reading it by position would mean something other than what the map says: ${wide[0]![0]}`,
      );

    const reader      = await conn.runAndReadAll(`SELECT DISTINCT _sym FROM ${table} ORDER BY 1`);
    const instruments = reader.getRows().map(row => String(row[0]));

    let rows  = 0;
    let files = 0;

    for (const instrument of instruments) {
      const out  = stagedOf(staging, instrument);
      const temp = `${out}.${++sequence}.tmp`;

      await mkdir(staging, { recursive: true });

      await conn.run(
        `COPY (SELECT ${repeats([...bySeries.keys()])}${q(instrument)} AS symbol, * EXCLUDE (_instrument, _wide, _sym, _file)${marginColumn(key, instrument)} FROM ${table}
               WHERE _sym = ${q(instrument)} ORDER BY ${orderOf(key)})
         TO ${q(temp)} (FORMAT PARQUET, COMPRESSION ZSTD, ROW_GROUP_SIZE ${ROW_GROUP})`,
      );

      const written = await settleFile(conn, temp, out, key, instrument);

      rows  += written;
      files += written > 0 ? 1 : 0;
    }

    return { rows, files };
  } finally {
    await conn.run(`DROP TABLE IF EXISTS ${table}`).catch(() => {});
    await unpacked.dispose();
  }
};

/**
 * Join a staged partition's per-instrument files into the one file a small
 * month is stored as, and say where it is.
 *
 * **Appended, not sorted.** Each instrument's file is already in time order, so
 * reading them in symbol order and writing what is read gives a file ordered by
 * symbol and then by time — one instrument's rows together, which is how the
 * file is read — without holding a month in memory to sort it.
 *
 * A partition every input of which was empty still becomes a file, with the
 * table's columns and no rows, so it reads as stocked rather than being rebuilt
 * every sweep.
 */
export const bundleStaged = async (conn: DuckDBConnection, key: VaultKey, staging: string): Promise<string> => {
  await mkdir(staging, { recursive: true });

  const out    = join(staging, '@.bundle');
  const staged = (await readdir(staging))
    .filter(name => name.endsWith(STAGED))
    .map(name => name.slice(0, -STAGED.length))
    .sort()
    .map(symbol => q(stagedOf(staging, symbol)));

  const rows = staged.length
    ? `SELECT * FROM read_parquet([${staged.join(', ')}])`
    : `SELECT CAST(NULL AS VARCHAR) AS symbol, ${fieldsOf(key.table)
      .map(field => `CAST(NULL AS ${field.type}) AS ${field.name}`).join(', ')} WHERE false`;

  /**
   * Insertion order is what makes appending work, and it is off everywhere else
   * — see `open`. Nothing else is being built while a partition is joined, so
   * turning it on for this one statement costs nobody their memory.
   */
  await conn.run('SET preserve_insertion_order=true');

  try {
    await conn.run(`COPY (${rows}) TO ${q(out)} (FORMAT PARQUET, COMPRESSION ZSTD, ROW_GROUP_SIZE ${ROW_GROUP})`);
  } finally {
    await conn.run('SET preserve_insertion_order=false');
  }

  return out;
};

/**
 * Clear what a hard kill leaves behind: extractions, part-built partitions, the
 * engine's spill. Everything transient lives in one directory, so it is one
 * delete rather than a walk over the vault.
 */
export const sweepScratch = async (): Promise<void> => {
  await rm(join(config.vaultDir, SCRATCH), { recursive: true, force: true }).catch(() => {});
  logger.info('Scratch cleared');
};

// ── Internals ─────────────────────────────────────────────────────────────────

/** 2015-01-01 and 2035-01-01 in microseconds — generous, but off by 1000× is not. */
const EARLIEST = 1_420_070_400_000_000;
const LATEST   = 2_051_222_400_000_000;

/**
 * A series as one of its files is written: itself, or itself read as the other
 * kind of table where the file turned out to be that. One object per series
 * and format, so files of one kind gather under one key.
 */
const asWritten = (series: Series, format: string): Series => {
  if (format === series.format) return series;

  const known = written.get(series) ?? new Map<string, Series>();

  if (! known.has(format)) known.set(format, { ...series, format });

  written.set(series, known);

  return known.get(format)!;
};

const written = new WeakMap<Series, Map<string, Series>>();

/** Sequence for temp tables and files, unique within the process. */
let sequence = 0;

/** Where one instrument's file is written while its partition is being built. */
const stagedOf = (staging: string, symbol: string): string => join(staging, `${symbol}${STAGED}`);

/** One instrument, one file. */
const writeOne = async (
  conn:     DuckDBConnection,
  key:      VaultKey,
  symbol:   string,
  relation: string,
  staging:  string,
  distinct: string,
): Promise<{ rows: number; files: number }> => {
  const out  = stagedOf(staging, symbol);
  const temp = `${out}.${++sequence}.tmp`;

  await mkdir(staging, { recursive: true });

  await conn.run(
    `COPY (SELECT ${distinct}${q(symbol)} AS symbol, *${marginColumn(key, symbol)} FROM ${relation} ORDER BY ${orderOf(key)})
     TO ${q(temp)} (FORMAT PARQUET, COMPRESSION ZSTD, ROW_GROUP_SIZE ${ROW_GROUP})`,
  );

  const rows = await settleFile(conn, temp, out, key, symbol);

  return { rows, files: rows > 0 ? 1 : 0 };
};

/**
 * Rows naming their own instrument: gathered once into a temporary table, then
 * written one instrument at a time — reading the source files once rather than
 * once per instrument.
 */
const writeSplit = async (
  conn:     DuckDBConnection,
  key:      VaultKey,
  relation: string,
  staging:  string,
  distinct: string,
): Promise<{ rows: number; files: number }> => {
  const table = `split_${process.pid}_${++sequence}`;

  await conn.run(`CREATE TEMP TABLE ${table} AS SELECT * FROM ${relation}`);

  try {
    const reader = await conn.runAndReadAll(
      `SELECT DISTINCT _instrument FROM ${table} WHERE _instrument IS NOT NULL ORDER BY 1`);
    const instruments = reader.getRows().map(row => String(row[0]));

    let rows  = 0;
    let files = 0;

    for (const instrument of instruments) {
      const out  = stagedOf(staging, instrument);
      const temp = `${out}.${++sequence}.tmp`;

      await mkdir(staging, { recursive: true });

      await conn.run(
        `COPY (SELECT ${distinct}${q(instrument)} AS symbol, * EXCLUDE (_instrument)${marginColumn(key, instrument)} FROM ${table}
               WHERE _instrument = ${q(instrument)} ORDER BY ${orderOf(key)})
         TO ${q(temp)} (FORMAT PARQUET, COMPRESSION ZSTD, ROW_GROUP_SIZE ${ROW_GROUP})`,
      );

      const written = await settleFile(conn, temp, out, key, instrument);

      rows  += written;
      files += written > 0 ? 1 : 0;
    }

    return { rows, files };
  } finally {
    await conn.run(`DROP TABLE IF EXISTS ${table}`);
  }
};

/**
 * Check a written file and move it to its name, or drop it when it holds no
 * rows — an instrument with nothing in the month has no file.
 */
const settleFile = async (
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

    /**
     * Refuse a file whose timestamps are not plausibly timestamps. Inference
     * removes the whole-file-1000×-off mistake; this catches the one it cannot —
     * a `ts` naming the wrong column, where values parse and mean nothing.
     */
    if (Number(lo) < EARLIEST || Number(hi) > LATEST)
      throw new Error(
        `Implausible timestamps in ${labelFor(key, symbol)}: ${lo}..${hi} µs is outside 2015–2035. ` +
        `The series' 'ts' almost certainly names the wrong column.`,
      );

    await rename(temp, out);

    return rows;
  } catch (err) {
    await rm(temp, { force: true });

    throw err;
  }
};

/**
 * `DISTINCT ` where any of the formats read repeats whole rows (`repeatsRows`),
 * so exact repeats are written once; nothing otherwise.
 */
const repeats = (series: Series[]): string => (series.some(one => one.repeatsRows) ? 'DISTINCT ' : '');

/** The margining column, where the table carries one: a constant for the whole file. */
const marginColumn = (key: VaultKey, symbol: string): string => {
  if (! fieldsOf(key.table).some(field => field.name === MARGIN.name)) return '';

  const margin = marginOf(key.venue, key.market, symbol);

  return `, CAST(${margin ? q(margin) : 'NULL'} AS VARCHAR) AS ${MARGIN.name}`;
};

const labelFor = (key: VaultKey, symbol: string): string =>
  [key.venue, key.market, symbol, key.table, key.depth,
    key.interval ?? key.mode ?? key.kind ?? (key.aggregated === 'true' ? 'aggregated' : ''), key.month]
    .filter(Boolean).join('|');

/**
 * What a file's rows are sorted by: time, and where a table carries the
 * venue's own sequence, that within one time — a book's changes are stamped
 * coarsely enough that several share an instant, and their order is the book.
 */
const orderOf = (key: VaultKey): string =>
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
const assertDeclaredWidth = async (
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
const explainMalformed = async (
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
