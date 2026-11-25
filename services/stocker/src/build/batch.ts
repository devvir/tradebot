import { mkdir, rename, rm } from 'node:fs/promises';
import { logger } from '@devvir/service-kit';
import type { DuckDBConnection } from '@duckdb/node-api';
import { unpackAll } from '../containers';
import { TAG } from '../containers/pack';
import { ensureExtensions, q } from '../db';
import { formatFor, isTable } from '../formats';
import { marginOf } from '../schema/margin';
import { selectFor } from '../schema/project';
import { seriesFor } from '../schema/series';
import { MARGIN, fieldsOf } from '../schema/tables';
import { clipFor } from '../spill';
import {
  PARQUET, UNNAMED, WHOLE, asWritten, assertInstrumentName, explainMalformed, inspect, labelFor, lapsInto, nextSequence, orderOf,
  plausible, repeats, stagedOf, writeEach,
} from './shared';
import type { Pack, UnpackedAll, Wrapped } from '../containers';
import type { DiskFile, Group, Series, Spent, VaultKey } from '../types';

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
 * from — unless the series names an instrument column, which then wins: a row
 * of such a series that names none is refused, as it is read alone.
 */
export const buildBatch = async (
  conn:    DuckDBConnection,
  key:     VaultKey,
  groups:  { symbol: string; inputs: DiskFile[] }[],
  staging: string,
  prepared?: UnpackedAll,
  whole    = false,
  spent?:  Spent,
): Promise<{ rows: number; files: number }> => {
  const { inputs, series: shapes } = wrappedFor(groups);

  const asTheyAre = (): Promise<UnpackedAll> =>
    unpackAll(inputs.map(({ absolute, container }) => ({ absolute, container })));

  const first = prepared ?? await asTheyAre();

  try {
    return await batchFrom(conn, key, groups, staging, first, shapes, whole, spent);
  } catch (err) {
    if (! first.packs.some(pack => pack !== null)) throw err;

    /**
     * A read of gathered files that fails says little about which archive is
     * why, and may have failed only for being gathered. Read as the archives
     * are, it either works or fails as it always did, naming the file.
     */
    logger.warn({ err, partition: labelFor(key, groups[0]!.symbol), instruments: groups.length },
      'A read of gathered files failed — reading its archives one by one');

    return await batchFrom(conn, key, groups, staging, await asTheyAre(), shapes, whole, spent);
  }
};

/**
 * A batch's archives as extraction is asked for them, and the series each
 * shape is read as.
 *
 * **Small files of a table are gathered** — see `Packer` — one file for each
 * series the batch's files are read as, since a series is a shape: its columns,
 * and whether a file opens with their names. A series that reshapes its rows,
 * or types them itself, or names each row's instrument, is read from its files
 * as they are.
 *
 * Asked for the same batch, it answers the same: it is how the build knows
 * which series a gathered file is, without being told.
 */
export const wrappedFor = (
  groups:    readonly Group[],
  gathering = true,
): { inputs: Wrapped[]; shapes: Pack[]; series: Series[] } => {
  const series: Series[] = [];

  const inputs = groups.flatMap(group => group.inputs.map((input): Wrapped => {
    const wrapped = { absolute: input.absolute, container: input.file.container };
    const read    = gathering ? seriesFor(input.file) : null;

    if (! read || ! isTable(read.format) || read.rows || read.fields || read.instrument) return wrapped;

    if (! series.includes(read)) series.push(read);

    return { ...wrapped, shape: series.indexOf(read) };
  }));

  return { inputs, shapes: series.map(one => ({ header: one.header })), series };
};

/** One read of a batch's archives as they were extracted, gathered or not, and its instruments written from it. */
const batchFrom = async (
  conn:     DuckDBConnection,
  key:      VaultKey,
  groups:   { symbol: string; inputs: DiskFile[] }[],
  staging:  string,
  unpacked: UnpackedAll,
  shapes:   Series[],
  whole:    boolean,
  spent?:   Spent,
): Promise<{ rows: number; files: number }> => {
  const lap    = lapsInto(spent);
  const flat   = groups.flatMap(group => group.inputs.map(input => ({ symbol: group.symbol, input })));
  const opened = flat.map((one, at) => ({ ...one, unpacked: { paths: unpacked.paths[at]! } }));

  const table = `batch_${process.pid}_${nextSequence()}`;

  try {
    const { bySeries, kept } = await inspect(opened);

    // Each kept file is its input's symbol's.
    const owners = opened.flatMap(({ symbol }, at) => kept[at]!.map(path => `(${q(path)}, ${q(symbol)})`));

    /** What was gathered: a file a shape, every line opening with the number of the archive it is from. */
    const gathered = unpacked.packs.flatMap((path, at) => {
      if (path === null) return [];

      if (! shapes[at]) throw new Error(`${labelFor(key, groups[0]!.symbol)}: a gathered file of no series the batch reads`);

      return [{ path, series: asWritten(shapes[at]!, 'csv') }];
    });

    if (gathered.length > 0) flat.forEach((one, at) => owners.push(`(${q(String(at))}, ${q(one.symbol)})`));

    lap('inspect');

    if (bySeries.size === 0 && gathered.length === 0) return { rows: 0, files: 0 };

    const selects: string[] = [];

    for (const { path, series } of gathered) {
      const format = formatFor(series.format);

      const extra = [
        `${TAG} AS _file`,
        'CAST(NULL AS VARCHAR) AS _instrument',
        'false AS _named',
        `${format.wide?.(series) ?? 'false'} AS _wide`,
      ];

      selects.push(`SELECT * FROM (${selectFor(series, format.packed!(path, series), extra)})`);
    }

    for (const [series, paths] of bySeries) {
      const format = formatFor(series.format);

      await ensureExtensions(conn, format.extensions ?? [], series.format);

      const extra = [
        'filename AS _file',
        series.instrument
          ? `CAST(${series.instrument} AS VARCHAR) AS _instrument`
          : 'CAST(NULL AS VARCHAR) AS _instrument',
        `${series.instrument ? 'true' : 'false'} AS _named`,
        `${format.wide?.(series) ?? 'false'} AS _wide`,
      ];

      selects.push(`SELECT * FROM (${selectFor(series, format.relation(paths, series, true), extra)})`);
    }

    const reading   = [...gathered.map(one => one.series), ...bySeries.keys()];
    const anySeries = reading[0]!;

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

    if (wide.length) {
      // A gathered line names its archive by number; the archive is what is worth naming.
      const named = String(wide[0]![0]);
      const file  = /^\d+$/.test(named) ? flat[Number(named)]!.input.absolute : named;

      throw new Error(
        `${labelFor(key, groups[0]!.symbol)}: an input file has more columns than the series declares, ` +
        `so reading it by position would mean something other than what the map says: ${file}`,
      );
    }

    /**
     * A row of a series that names each row's instrument is that instrument's,
     * and one that names none is refused, as it is read alone — see
     * `buildGroup`. The catalog symbol stands in only for series that name none.
     */
    const unnamed = (await conn.runAndReadAll(
      `SELECT _file FROM ${table} WHERE _named AND coalesce(_instrument, '') = '' LIMIT 1`)).getRows();

    if (unnamed.length) throw new Error(`${labelFor(key, groups[0]!.symbol)}: ${UNNAMED}: ${String(unnamed[0]![0])}`);

    for (const [name] of (await conn.runAndReadAll(`SELECT DISTINCT _instrument FROM ${table} WHERE _named`)).getRows())
      assertInstrumentName(key, groups[0]!.symbol, String(name));

    lap('read');

    if (whole) return await writeWhole(conn, key, table, staging, repeats(reading));

    const reader      = await conn.runAndReadAll(`SELECT DISTINCT _sym FROM ${table} ORDER BY 1`);
    const instruments = reader.getRows().map(row => String(row[0]));

    return await writeEach(conn, key, table, staging, instruments,
      { column: '_sym', exclude: '_instrument, _named, _wide, _sym, _file', distinct: repeats(reading) });
  } finally {
    await conn.run(`DROP TABLE IF EXISTS ${table}`).catch(() => {});

    lap('write');

    await unpacked.dispose();
  }
};

/**
 * A batch of small instruments as **one file**, ordered by symbol and then as
 * any instrument's file is — what joining their separate files would give,
 * without writing them.
 *
 * **For a month stored as one file, where the instruments' own files are only
 * a step.** A write is some ten milliseconds whatever it holds, and a month of
 * a few megabytes over five hundred instruments is five hundred of them and
 * then a read of all five hundred back: seconds, for a quarter of a second's
 * worth of rows.
 *
 * The checks a file gets are made on the table before anything is written:
 * each instrument's times have to be times.
 */
const writeWhole = async (
  conn:     DuckDBConnection,
  key:      VaultKey,
  table:    string,
  staging:  string,
  distinct: string,
): Promise<{ rows: number; files: number }> => {
  const found = (await conn.runAndReadAll(`SELECT _sym, min(ts), max(ts) FROM ${table} GROUP BY 1 ORDER BY 1`)).getRows()
    .map(row => ({ symbol: String(row[0]), lo: Number(row[1]), hi: Number(row[2]) }));

  if (found.length === 0) return { rows: 0, files: 0 };

  for (const one of found) plausible(key, one.symbol, one.lo, one.hi);

  const out  = stagedOf(staging, `${WHOLE}${process.pid}.${nextSequence()}`);
  const temp = `${out}.tmp`;

  const margins = fieldsOf(key.table).some(field => field.name === MARGIN.name);
  const side    = margins
    ? ` JOIN (VALUES ${found.map(one => { const margin = marginOf(key.venue, key.market, one.symbol);

      return `(${q(one.symbol)}, CAST(${margin ? q(margin) : 'NULL'} AS VARCHAR))`; }).join(', ')}) _m(_of, ${MARGIN.name}) ON _m._of = _sym`
    : '';

  await mkdir(staging, { recursive: true });

  try {
    await conn.run(
      `COPY (SELECT ${distinct}_sym AS symbol, * EXCLUDE (_instrument, _named, _wide, _sym, _file${margins ? ', _of' : ''})
               FROM ${table}${side} ORDER BY symbol, ${orderOf(key)})
       TO ${q(temp)} ${PARQUET}`,
    );

    const rows = Number((await conn.runAndReadAll(`SELECT count(*) FROM read_parquet(${q(temp)})`)).getRows()[0]![0]);

    await rename(temp, out);

    return { rows, files: found.length };
  } catch (err) {
    await rm(temp, { force: true });

    throw err;
  }
};
