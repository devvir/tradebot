import { mkdir, readFile, readdir, rename, rm, rmdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { logger } from '@devvir/service-kit';
import type { DuckDBConnection } from '@duckdb/node-api';
import config from './config';
import { SCRATCH, hasContent, unpackAll } from './containers';
import { TAG } from './containers/pack';
import { q } from './db';
import { formatFor, formatOf, isTable } from './formats';
import { marginOf } from './schema/margin';
import { selectFor } from './schema/project';
import { seriesFor } from './schema/series';
import { MARGIN, fieldsOf } from './schema/tables';
import { clipFor } from './spill';
import { STAGED } from './vault';
import type { Pack, UnpackedAll, Wrapped } from './containers';
import type { Format } from './formats/types';
import type { DiskFile, Group, Series, Side, Spent, VaultKey } from './types';

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
    lap('inspect');

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
    lap('write');

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
        `${format.wide?.(series) ?? 'false'} AS _wide`,
      ];

      selects.push(`SELECT * FROM (${selectFor(series, format.packed!(path, series), extra)})`);
    }

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

    lap('read');

    if (whole) return await writeWhole(conn, key, table, staging, repeats(reading));

    const reader      = await conn.runAndReadAll(`SELECT DISTINCT _sym FROM ${table} ORDER BY 1`);
    const instruments = reader.getRows().map(row => String(row[0]));

    let rows  = 0;
    let files = 0;

    for (const instrument of instruments) {
      const out  = stagedOf(staging, instrument);
      const temp = `${out}.${++sequence}.tmp`;

      await mkdir(staging, { recursive: true });

      await conn.run(
        `COPY (SELECT ${repeats(reading)}${q(instrument)} AS symbol, * EXCLUDE (_instrument, _wide, _sym, _file)${marginColumn(key, instrument)} FROM ${table}
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

    lap('write');

    await unpacked.dispose();
  }
};

/**
 * Join a staged partition's files into the one file a small month is stored
 * as, and say where it is.
 *
 * **Appended, not sorted.** Each file is already in symbol and time order —
 * one instrument's, or a batch of them written together — so reading them in
 * symbol order and writing what is read gives a file ordered by symbol and then
 * by time, one instrument's rows together, which is how the file is read,
 * without holding a month in memory to sort it. A single file is the month
 * already, and is not rewritten. Only where two files hold symbols that
 * interleave — a big instrument read on its own, out of the middle of a batch —
 * is the join a sort.
 *
 * A partition every input of which was empty still becomes a file, with the
 * table's columns and no rows, so it reads as stocked rather than being rebuilt
 * every sweep.
 */
export const bundleStaged = async (conn: DuckDBConnection, key: VaultKey, staging: string): Promise<string> => {
  await mkdir(staging, { recursive: true });

  const out   = join(staging, '@.bundle');
  const names = (await readdir(staging)).filter(name => name.endsWith(STAGED)).map(name => name.slice(0, -STAGED.length));

  // One batch, written whole: it is the month's file as it stands.
  if (names.length === 1 && names[0]!.startsWith(WHOLE)) {
    await rename(stagedOf(staging, names[0]!), out);

    return out;
  }

  const spans  = names.some(name => name.startsWith(WHOLE)) ? await spansOf(conn, names.map(name => stagedOf(staging, name))) : null;
  const staged = spans ? spans.map(span => q(span.path)) : names.sort().map(symbol => q(stagedOf(staging, symbol)));
  const sorted = spans !== null && spans.some((span, at) => at > 0 && span.first <= spans[at - 1]!.last);

  const rows = staged.length
    ? `SELECT * FROM read_parquet([${staged.join(', ')}])${sorted ? ` ORDER BY symbol, ${orderOf(key)}` : ''}`
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
 * Join what was built a piece at a time into the files it would have been
 * built as whole: each instrument's rows, from every piece that has any, in
 * one file in `staging`.
 *
 * **A symbol whose archives inflate to more than scratch should hold at once is
 * built from a few of them at a time** — each piece extracted, written and
 * removed before the next — into `PIECES` under the staging directory, a
 * directory a symbol and a directory a piece within it. A piece is in time
 * order and the pieces need not follow one another, so this join sorts.
 *
 * The pieces are left where they are: they go with the staging directory once
 * the partition is in the vault, and until then a build that stops is taken up
 * from them — see `finishPiece`.
 *
 * `repeats` says whether a symbol's files repeat whole rows: a row repeated
 * across two pieces is then written once, as it is within one.
 */
export const joinPieces = async (
  conn:    DuckDBConnection,
  key:     VaultKey,
  staging: string,
  repeats: (of: string) => boolean,
): Promise<void> => {
  const root = join(staging, PIECES);

  for (const of of await readdir(root).catch(() => [] as string[])) {
    const parts = new Map<string, string[]>();

    for (const piece of await readdir(join(root, of)))
      for (const name of await readdir(join(root, of, piece)))
        if (name.endsWith(STAGED)) parts.set(name, [...parts.get(name) ?? [], join(root, of, piece, name)]);

    for (const [name, paths] of parts) {
      const out  = join(staging, name);
      const temp = `${out}.${++sequence}.tmp`;

      await conn.run(
        `COPY (SELECT ${repeats(of) ? 'DISTINCT ' : ''}* FROM read_parquet([${paths.map(q).join(', ')}]) ORDER BY ${orderOf(key)})
         TO ${q(temp)} (FORMAT PARQUET, COMPRESSION ZSTD, ROW_GROUP_SIZE ${ROW_GROUP})`,
      );

      await settleFile(conn, temp, out, key, name.slice(0, -STAGED.length));
    }
  }
};

/**
 * Say that a piece is built: what it was built from, and what came of it.
 *
 * **A partition built a piece at a time takes hours, and a piece that is built
 * is not built again.** Each leaves a note beside its files as it finishes, and
 * a build that starts over — the service restarted, a piece failed — skips the
 * pieces whose note names the very files it would build them from. A piece
 * that was stopped half way has no note, and is built again from nothing.
 *
 * The staging directory is named for the partition's revision, so pieces built
 * from other archives, or under versions that write otherwise, are never found.
 * What the note adds is which files the piece held: how a symbol's files are
 * cut into pieces is not part of the revision.
 */
export const finishPiece = async (dir: string, inputs: readonly DiskFile[], done: { rows: number; files: number }): Promise<void> => {
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, FINISHED), JSON.stringify({ inputs: inputs.map(input => input.file.key), ...done }));
};

/** What came of a piece built before from these very files, or null where it is still to build. */
export const finishedPiece = async (dir: string, inputs: readonly DiskFile[]): Promise<{ rows: number; files: number } | null> => {
  try {
    const note = JSON.parse(await readFile(join(dir, FINISHED), 'utf8')) as { inputs: string[]; rows: number; files: number };

    return note.inputs.join('\n') === inputs.map(input => input.file.key).join('\n') ? { rows: note.rows, files: note.files } : null;
  } catch {
    return null;
  }
};

/**
 * Clear a staging directory of everything but the pieces that are built, and
 * the directory itself where that leaves nothing in it.
 */
export const keepPieces = async (staging: string): Promise<void> => {
  for (const pass of await readdir(staging).catch(() => [] as string[])) {
    const pieces = join(staging, pass, PIECES);

    for (const name of await readdir(join(staging, pass)).catch(() => [] as string[]))
      if (name !== PIECES) await rm(join(staging, pass, name), { recursive: true, force: true });

    for (const of of await readdir(pieces).catch(() => [] as string[])) {
      for (const at of await readdir(join(pieces, of)).catch(() => [] as string[])) {
        const built = await readFile(join(pieces, of, at, FINISHED)).then(() => true, () => false);

        if (! built) await rm(join(pieces, of, at), { recursive: true, force: true });
      }

      await rmdir(join(pieces, of)).catch(() => {});
    }

    await rmdir(pieces).catch(() => {});
    await rmdir(join(staging, pass)).catch(() => {});
  }

  await rmdir(staging).catch(() => {});
};

/**
 * Take out of a side's staged files the rows the month's own files already
 * hold, and say how many went.
 *
 * **A bar is one row, in one file.** What a neighbouring month holds of this
 * one is meant to begin where the month's own rows end — and a venue's files
 * do not always cut that cleanly: a month's file can carry the first bar of the
 * next, which the next month's file carries too. Each instrument's side is held
 * to the times its own rows do not reach: after its last for `post`, before its
 * first for `pre`. The month's own files are what is in the vault and are never
 * rewritten for it; an instrument's side left with nothing has no file.
 *
 * `own` are the month's own files: one of every instrument, or a file each.
 */
export const dropOverlap = async (
  conn: DuckDBConnection,
  key:  VaultKey,
  dir:  string,
  side: Side,
  own:  readonly string[],
): Promise<number> => {
  const names = (await readdir(dir).catch(() => [] as string[])).filter(name => name.endsWith(STAGED));

  if (names.length === 0 || own.length === 0) return 0;

  const reach = new Map((await conn.runAndReadAll(
    `SELECT symbol, min(ts), max(ts) FROM read_parquet([${own.map(q).join(', ')}]) GROUP BY 1`,
  )).getRows().map(row => [String(row[0]), { first: String(row[1]), last: String(row[2]) }] as const));

  let dropped = 0;

  for (const name of names) {
    const held = reach.get(name.slice(0, -STAGED.length));

    if (! held) continue;

    const file  = join(dir, name);
    const clear = side === 'post' ? `ts > ${held.last}` : `ts < ${held.first}`;

    const [over, all] = (await conn.runAndReadAll(
      `SELECT count(*) FILTER (WHERE NOT (${clear})), count(*) FROM read_parquet(${q(file)})`,
    )).getRows()[0]!.map(Number) as [number, number];

    if (over === 0) continue;

    dropped += over;

    if (over === all) {
      await rm(file, { force: true });

      continue;
    }

    const temp = `${file}.${++sequence}.tmp`;

    await conn.run(
      `COPY (SELECT * FROM read_parquet(${q(file)}) WHERE ${clear} ORDER BY ${orderOf(key)})
       TO ${q(temp)} (FORMAT PARQUET, COMPRESSION ZSTD, ROW_GROUP_SIZE ${ROW_GROUP})`,
    );

    await rename(temp, file);
  }

  return dropped;
};

/** Under a staging directory: what is built a piece at a time, until it is joined. */
export const PIECES = '.pieces';

/** In a piece's directory: the note that it is built. */
const FINISHED = '.built';

/** Under scratch: where partitions are built before they are put in the vault. */
const STAGE = 'stage';

/**
 * Clear what a hard kill leaves behind: extractions, part-built partitions, the
 * engine's spill. Everything transient lives in one directory.
 *
 * **All of it goes but the pieces that are built** — see `finishPiece`: hours
 * of a partition that was being built a piece at a time, which the next build
 * of it takes up.
 */
export const sweepScratch = async (): Promise<void> => {
  const scratch = join(config.vaultDir, SCRATCH);

  for (const name of await readdir(scratch).catch(() => [] as string[]))
    if (name !== STAGE) await rm(join(scratch, name), { recursive: true, force: true }).catch(() => {});

  const kept = [];

  for (const name of await readdir(join(scratch, STAGE)).catch(() => [] as string[])) {
    await keepPieces(join(scratch, STAGE, name));

    if (await readdir(join(scratch, STAGE, name)).then(() => true, () => false)) kept.push(name);
  }

  if (kept.length > 0) logger.info({ partitions: kept }, 'Scratch cleared — pieces built before are kept, to be taken up');
  else logger.info('Scratch cleared');
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

/** A clock that adds the time since it was last read to one of a partition's counts; nothing where none is kept. */
const lapsInto = (spent?: Spent): ((into: keyof Spent) => void) => {
  let since = Date.now();

  return (into) => {
    const now = Date.now();

    if (spent) spent[into] += now - since;

    since = now;
  };
};

/** What a batch written as one file is named by, in place of an instrument: nothing a venue calls one begins so. */
const WHOLE = '@batch.';

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

  const out  = stagedOf(staging, `${WHOLE}${process.pid}.${++sequence}`);
  const temp = `${out}.tmp`;

  const margins = fieldsOf(key.table).some(field => field.name === MARGIN.name);
  const side    = margins
    ? ` JOIN (VALUES ${found.map(one => { const margin = marginOf(key.venue, key.market, one.symbol);

      return `(${q(one.symbol)}, CAST(${margin ? q(margin) : 'NULL'} AS VARCHAR))`; }).join(', ')}) _m(_of, ${MARGIN.name}) ON _m._of = _sym`
    : '';

  await mkdir(staging, { recursive: true });

  try {
    await conn.run(
      `COPY (SELECT ${distinct}_sym AS symbol, * EXCLUDE (_instrument, _wide, _sym, _file${margins ? ', _of' : ''})
               FROM ${table}${side} ORDER BY symbol, ${orderOf(key)})
       TO ${q(temp)} (FORMAT PARQUET, COMPRESSION ZSTD, ROW_GROUP_SIZE ${ROW_GROUP})`,
    );

    const rows = Number((await conn.runAndReadAll(`SELECT count(*) FROM read_parquet(${q(temp)})`)).getRows()[0]![0]);

    await rename(temp, out);

    return { rows, files: found.length };
  } catch (err) {
    await rm(temp, { force: true });

    throw err;
  }
};

/** The symbols each staged file holds, first and last, in the order of their first. */
const spansOf = async (
  conn:  DuckDBConnection,
  paths: string[],
): Promise<{ path: string; first: string; last: string }[]> =>
  (await conn.runAndReadAll(
    `SELECT filename, min(symbol), max(symbol) FROM read_parquet([${paths.map(q).join(', ')}], filename = true) GROUP BY 1`,
  )).getRows()
    .map(row => ({ path: String(row[0]), first: String(row[1]), last: String(row[2]) }))
    .sort((a, b) => (a.first < b.first ? -1 : a.first > b.first ? 1 : 0));

/**
 * Refuse rows whose timestamps are not plausibly timestamps. Inference removes
 * the whole-file-1000×-off mistake; this catches the one it cannot — a `ts`
 * naming the wrong column, where values parse and mean nothing.
 */
const plausible = (key: VaultKey, symbol: string, lo: number, hi: number): void => {
  if (lo < EARLIEST || hi > LATEST)
    throw new Error(
      `Implausible timestamps in ${labelFor(key, symbol)}: ${lo}..${hi} µs is outside 2015–2035. ` +
      `The series' 'ts' almost certainly names the wrong column.`,
    );
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

    plausible(key, symbol, Number(lo), Number(hi));

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
  [key.venue, key.market, symbol, key.table,
    key.interval ?? key.kind ?? (key.aggregated === 'true' ? 'aggregated' : ''), key.depth, key.month]
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
