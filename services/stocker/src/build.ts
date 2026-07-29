import { mkdir, rename, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { logger } from '@devvir/service-kit';
import type { DuckDBConnection } from '@duckdb/node-api';
import config from './config';
import { SCRATCH, hasContent, unpack } from './containers';
import { q } from './db';
import { formatFor } from './formats';
import { dirOf, idOf, labelOf, pathOf } from './partition';
import { selectFor } from './schema/project';
import { clipFor } from './spill';
import type { Format } from './formats/types';
import type { Built, PartitionKey, RawFile, Series } from './types';

/**
 * Row group size, in rows rather than bytes.
 *
 * Small enough that a time-range filter can skip most of a month, large enough
 * that the per-group footer is not the dominant cost. Rows are written in `ts`
 * order, which is what makes the group statistics worth having: unsorted, every
 * group spans the whole month and no range filter can skip anything.
 */
const ROW_GROUP = 100_000;

/**
 * Build one partition from its raw inputs.
 *
 * The whole partition is rewritten every time, never appended to: Parquet is
 * immutable, and a partial rewrite is the one way to end up with a file nobody
 * can reason about. The write lands in scratch and is renamed into place, so a
 * crash mid-build leaves the previous partition intact rather than a truncated
 * one.
 *
 * Nothing is written beside the partition. The record of the build goes to the
 * ledger under `@meta/`, so reclaiming space is deleting `.parquet` files —
 * by file, by directory, or by whole subtree — and stocker still knows the work
 * was done.
 */
export const buildPartition = async (
  conn:     DuckDBConnection,
  key:      PartitionKey,
  inputs:   RawFile[],
  closedAt: string | null,
): Promise<Built | null> => {
  const dir = dirOf(key);
  const out = pathOf(key);

  // Everything transient lives in one directory, so cleanup is a single
  // recursive delete rather than a hunt through the vault for stray files.
  const temp = join(scratch(), `${idOf(key).replace(/[|/]/g, '_')}.parquet`);

  await mkdir(dir, { recursive: true });
  await mkdir(scratch(), { recursive: true });

  const opened = await Promise.all(
    inputs.map(async file => ({
      file,
      unpacked: await unpack(file.absolute, file.series.container),
    })),
  );

  try {
    const series = inputs[0]!.series;
    const format = formatFor(series.format);

    for (const extension of format.extensions ?? []) {
      await conn.run(`INSTALL ${extension}`);
      await conn.run(`LOAD ${extension}`);
    }

    /**
     * **One** relation over every file, not one per file unioned together.
     *
     * Each file in a partition is the same series by construction — same table,
     * venue, market and symbol — so thirty files are thirty copies of one
     * projection differing only in the path. Handing the reader the whole list
     * lets it scan them as a single operator with buffers it manages; a
     * thirty-way `UNION ALL` instead starts thirty readers, each decompressing
     * and buffering on its own, and that is what exhausted a 4 GB limit on a
     * month of a busy symbol while a single day of the same data sorted
     * comfortably under 300 MB.
     */
    /**
     * Files a venue published empty are dropped before the reader sees them —
     * see `hasContent`. One of them defines the schema for the whole file set
     * if it is left in, so this is what lets a month survive a delisting day.
     */
    const decoded = opened.flatMap(({ unpacked }) => unpacked.paths);
    const content = await Promise.all(decoded.map(hasContent));
    const paths   = decoded.filter((_, at) => content[at]);

    // Nothing but empty files: the venue published for this month and published
    // nothing in it. There is no schema to write and no rows to write under it,
    // so the partition does not exist rather than existing empty.
    if (paths.length === 0) return null;

    await assertDeclaredWidth(conn, format, paths, series, key);

    // A row whose timestamp resolved to nothing is not a row: it is a header
    // line from a file that grew one partway through its history, or a trailing
    // fragment. Dropping them here is what lets one series span a format change
    // without a boundary date written down anywhere.
    //
    // The clip bounds a spilling series to its own month — its inputs include a
    // neighbouring bucket precisely so the month is whole, and without the clip
    // the neighbour's rows would land in two partitions. Empty for everyone
    // else.
    try {
      await conn.run(
        `COPY (SELECT * FROM (${selectFor(series, format.relation(paths, series))})
               WHERE ts IS NOT NULL${clipFor(series, key.month)} ORDER BY ts)
         TO ${q(temp)}
         (FORMAT PARQUET, COMPRESSION ZSTD, ROW_GROUP_SIZE ${ROW_GROUP})`,
      );
    } catch (err) {
      await explainMalformed(conn, format, paths, series, key, err as Error);

      throw err;
    }

    await assertPlausibleTimes(conn, temp, key);
    await rename(temp, out);

    const built: Built = {
      id:      idOf(key),
      key,
      inputs:  inputs.map(i => ({ path: i.path, size: i.size })),
      rows:    await rowsIn(conn, out),
      builtAt: new Date().toISOString(),

      // What the collector said when it closed this month. A month can be
      // closed again after a repair, and a partition built from the older
      // closing is stale even when every file it read is still there.
      closedAt,
    };

    return built;
  } catch (err) {
    await rm(temp, { force: true });

    // The id rather than the directory: the directory omits the month, so a
    // failure named nothing that could be looked up or retried.
    logger.error({ err, partition: labelOf(key), inputs: inputs.length }, 'Partition build failed');

    throw err;
  } finally {
    await Promise.all(opened.map(o => o.unpacked.dispose()));
  }
};

// ── Internals ─────────────────────────────────────────────────────────────────

/** 2015-01-01 and 2035-01-01 in microseconds — generous, but off by 1000× is not. */
const EARLIEST = 1_420_070_400_000_000;
const LATEST   = 2_051_222_400_000_000;

/**
 * Refuse to publish a partition whose timestamps are not plausibly timestamps.
 *
 * The unit is inferred from each value rather than declared, which removes the
 * mistake this guard was written for — a whole partition landing exactly 1000×
 * off — but not the need for it. It now catches the case the inference cannot:
 * a `ts` pointing at the wrong *column* altogether, where the values parse
 * cleanly and mean nothing.
 *
 * Reading min/max comes from the row-group statistics rather than a scan, so
 * the guard costs nothing on a file that has just been written.
 */
const assertPlausibleTimes = async (
  conn: DuckDBConnection,
  path: string,
  key:  PartitionKey,
): Promise<void> => {
  const reader = await conn.runAndReadAll(
    `SELECT min(ts), max(ts) FROM read_parquet(${q(path)})`);
  const [lo, hi] = reader.getRows()[0]! as [unknown, unknown];

  if (lo === null || hi === null) return;   // an empty partition has nothing to check

  const low  = Number(lo);
  const high = Number(hi);

  if (low < EARLIEST || high > LATEST)
    throw new Error(
      `Implausible timestamps in ${labelOf(key)}: ${low}..${high} µs is outside 2015–2035. ` +
      `The series' 'ts' almost certainly names the wrong column.`,
    );
};

/**
 * Refuse a file wider than the series describes, naming it.
 *
 * A positional map is a claim about what each column *is*. When a venue serves
 * a file of a different shape at the same path — Gate published truncated
 * copies of its spot files under `futures_usdt/trades/202107`, and spot carries
 * an extra `side` column — the first N columns still parse, so the build
 * succeeds and writes data that means something other than what it says.
 *
 * Failing is the right answer rather than adapting: the wider file is not the
 * series, and guessing which of its columns correspond is how the wrong guess
 * becomes permanent. A loud failure names the file so it can be looked at.
 */
const assertDeclaredWidth = async (
  conn:   DuckDBConnection,
  format: Format,
  paths:  string[],
  series: Series,
  key:    PartitionKey,
): Promise<void> => {
  const query = format.overflow?.(paths, series);

  if (! query) return;

  const wider = (await conn.runAndReadAll(query)).getRows().map(row => String(row[0]));

  if (wider.length === 0) return;

  throw new Error(
    `${labelOf(key)}: ${wider.length} input file${wider.length === 1 ? '' : 's'} ` +
    `have more columns than the series declares, so reading them by position ` +
    `would mean something other than what the map says. First: ${wider[0]}`,
  );
};

/**
 * Turn a failed build into a statement about the file, where the file is why.
 *
 * **Runs only after something has already gone wrong**, which is the whole
 * design: a malformed file cannot produce wrong data, only no data, so nothing
 * has to be caught before the write — unlike `overflow`, which guards a file
 * that reads *successfully* and means the wrong thing. The happy path never
 * pays for this.
 *
 * Throws in place of the original error when it finds something, because the
 * original is actively misleading — DuckDB names a column that is visibly there
 * in the file and suggests it as its own correction.
 *
 * Silent when it finds nothing, and silent when the diagnosis itself fails: an
 * error raised while explaining an error would replace the only account anybody
 * has of what actually broke.
 */
const explainMalformed = async (
  conn:   DuckDBConnection,
  format: Format,
  paths:  string[],
  series: Series,
  key:    PartitionKey,
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
    `${labelOf(key)}: ${bad.length} of ${paths.length} input file` +
    `${paths.length === 1 ? '' : 's'} do not parse into columns — their rows are ` +
    `narrower than their own header, so the venue published them malformed. ` +
    `First: ${bad[0]}. (${cause.message.split('\n')[0]})`,
  );
};

/** Straight from the Parquet footer — no data scan. */
const rowsIn = async (conn: DuckDBConnection, path: string): Promise<number> => {
  const reader = await conn.runAndReadAll(`SELECT count(*) AS n FROM read_parquet(${q(path)})`);

  return Number(reader.getRows()[0]![0]);
};

/** The one directory holding anything transient — extractions and part-written files. */
const scratch = (): string => join(config.vaultDir, SCRATCH);

/**
 * Clear what a hard kill leaves behind.
 *
 * Normal operation leaves nothing: extractions are disposed of in a `finally`
 * and a failed build removes its own temp file. This is only for a process that
 * died between the two, and because everything transient lives in one place it
 * is a single delete rather than a walk over a vault of millions of files.
 */
export const sweepScratch = async (): Promise<void> => {
  await rm(scratch(), { recursive: true, force: true }).catch(() => {});
};
