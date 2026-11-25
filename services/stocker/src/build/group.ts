import { mkdir } from 'node:fs/promises';
import type { DuckDBConnection } from '@duckdb/node-api';
import { unpackAll } from '../containers';
import { ensureExtensions, q } from '../db';
import { formatFor } from '../formats';
import { selectFor } from '../schema/project';
import { clipFor } from '../spill';
import {
  PARQUET, UNNAMED, assertDeclaredWidth, assertInstrumentName, explainMalformed, inspect, labelFor, lapsInto, marginColumn,
  nextSequence, orderOf, repeats, settleFile, stagedOf, writeEach,
} from './shared';
import type { UnpackedAll } from '../containers';
import type { DiskFile, Spent, VaultKey } from '../types';

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
  spent?:  Spent,
): Promise<{ rows: number; files: number }> => {
  const lap      = lapsInto(spent);
  const unpacked = prepared
    ?? await unpackAll(inputs.map(input => ({ absolute: input.absolute, container: input.file.container })));
  const opened   = inputs.map((input, at) => ({ input, unpacked: { paths: unpacked.paths[at]! } }));

  try {
    // Nothing here reads a gathered file, so one handed in would be rows left out.
    if (unpacked.packs.some(pack => pack !== null))
      throw new Error(`${labelFor(key, symbol)}: its archives were gathered for a batch, and it is not built as one`);

    const { bySeries } = await inspect(opened);

    // Nothing but empty files: the venue published for this month and
    // published nothing in it, so this instrument has no file.
    lap('inspect');

    if (bySeries.size === 0) return { rows: 0, files: 0 };

    const selects: string[] = [];
    const split = [...bySeries.keys()].map(series => series.instrument);

    if (new Set(split).size > 1)
      throw new Error(`${labelFor(key, symbol)}: its formats disagree on whether rows name their instrument`);

    for (const [series, paths] of bySeries) {
      const format = formatFor(series.format);

      await ensureExtensions(conn, format.extensions ?? [], series.format);

      await assertDeclaredWidth(conn, format, paths, series, key, symbol);

      // Rows split by instrument carry their file, so a row that names none can be traced to it.
      const extra = series.instrument ? [`CAST(${series.instrument} AS VARCHAR) AS _instrument`, 'filename AS _file'] : [];

      selects.push(`SELECT * FROM (${selectFor(series, format.relation(paths, series, !! series.instrument), extra)})`);
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
        ? await writeSplit(conn, key, symbol, relation, staging, distinct)
        : await writeOne(conn, key, symbol, relation, staging, distinct);
    } catch (err) {
      for (const [series, paths] of bySeries)
        await explainMalformed(conn, formatFor(series.format), paths, series, key, symbol, err as Error);

      throw err;
    }
  } finally {
    lap('write');

    await unpacked.dispose();
  }
};

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
  const temp = `${out}.${nextSequence()}.tmp`;

  await mkdir(staging, { recursive: true });

  await conn.run(
    `COPY (SELECT ${distinct}${q(symbol)} AS symbol, *${marginColumn(key, symbol)} FROM ${relation} ORDER BY ${orderOf(key)})
     TO ${q(temp)} ${PARQUET}`,
  );

  const rows = await settleFile(conn, temp, out, key, symbol);

  return { rows, files: rows > 0 ? 1 : 0 };
};

/**
 * Rows naming their own instrument: gathered once into a temporary table, then
 * written one instrument at a time — reading the source files once rather than
 * once per instrument.
 *
 * **Every row names one**: a row whose instrument is NULL or empty belongs to
 * no file, and the partition is refused, naming the input it is in. So is an
 * instrument that cannot be a file name — see `assertInstrumentName`. Both are
 * found before anything is written.
 */
const writeSplit = async (
  conn:     DuckDBConnection,
  key:      VaultKey,
  symbol:   string,
  relation: string,
  staging:  string,
  distinct: string,
): Promise<{ rows: number; files: number }> => {
  const table = `split_${process.pid}_${nextSequence()}`;

  await conn.run(`CREATE TEMP TABLE ${table} AS SELECT * FROM ${relation}`);

  try {
    const unnamed = (await conn.runAndReadAll(
      `SELECT _file FROM ${table} WHERE coalesce(_instrument, '') = '' LIMIT 1`)).getRows();

    if (unnamed.length) throw new Error(`${labelFor(key, symbol)}: ${UNNAMED}: ${String(unnamed[0]![0])}`);

    const reader      = await conn.runAndReadAll(`SELECT DISTINCT _instrument FROM ${table} ORDER BY 1`);
    const instruments = reader.getRows().map(row => String(row[0]));

    for (const instrument of instruments) assertInstrumentName(key, symbol, instrument);

    return await writeEach(conn, key, table, staging, instruments, { column: '_instrument', exclude: '_instrument, _file', distinct });
  } finally {
    await conn.run(`DROP TABLE IF EXISTS ${table}`);
  }
};
