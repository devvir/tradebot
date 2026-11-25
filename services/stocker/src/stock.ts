import { readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { logger } from '@devvir/service-kit';
import { sizeOf } from '@tradebot/utils';
import type { DuckDBConnection } from '@duckdb/node-api';
import { buildBatch, buildGroup, bundleStaged, dropOverlap, finishPiece, joinPieces, keepPieces, pieceDirOf } from './build';
import { q } from './db';
import { seriesFor } from './schema/series';
import { mark, partitionOf, record, repair } from './ledger';
import { NO_ROOM, NoRoom, roomIn } from './room';
import { direct } from './tasks';
import {
  BUNDLE, STAGED, bundleOf, clear, countOf, fileOf, isWhole, labelOf, monthOf, publishBundle, publishSplit, sliceDirOf, staleStagingOf,
  stagingOf,
} from './vault';
import type { Job, Pass, Side, Spent, Stocked, Summary, Sweeping, VaultKey } from './types';

/**
 * Build a partition into staging, one instrument per connection at a time,
 * then publish it: as one file, or — where the archive files it came from
 * weigh more than `SPLIT_GB` — as a file per instrument.
 *
 * **A month's own rows and what its neighbours hold of it are built apart**,
 * each into a staging directory of its own, and stay apart in the vault. So a
 * month whose neighbour is not there is stocked all the same, without that
 * side, and when the neighbour arrives only the side is built: the month's own
 * files stay as they are, and are not read.
 *
 * **Nothing in the vault is touched until everything is built.** Then the
 * ledger is told the month is being changed, what is there of it makes way, the
 * new files move in, and the ledger is told what it holds. Stopped anywhere in
 * between, the month still says `updating` (or `updating-sides`) and is put
 * right before it is read again — see `repair`.
 */
export const stock = async (
  conns:    DuckDBConnection[],
  job:      Job,
  sweeping: Sweeping,
  summary:  Summary,
): Promise<void> => {
  const { key, partition, revision, edges, missing, tasks, passes, built: finished, prefetch, completes } = job;
  const { ledger, slices } = sweeping;

  const staging = stagingOf(key, revision);
  const dirOf   = (pass: Pass): string => join(staging, pass);
  const started = Date.now();
  const spent: Spent = { extract: 0, inspect: 0, read: 0, write: 0, join: 0, queued: 0, place: 0 };

  /**
   * What the vault holds of the month: what a completion adds to, and what
   * anything else replaces. Read as this starts, and for a completion again as
   * it is put in place.
   */
  let before    = (await slices.of(key)).get(monthOf(key));
  const split   = completes ? ! before?.bundle : partition.bytes > splitBytes;

  logger.info({ partition: labelOf(key), from: partition.id, revision, files: job.files,
    size: sizeOf(partition.bytes), as: split ? 'a file per instrument' : 'one file', tasks: tasks.length, connections: conns.length,
    ...(completes ? { completing: completes.revision } : {}),
    ...(missing.length > 0 ? { without: missing } : {}) },
  completes ? 'Completing partition' : 'Stocking partition');

  // Whatever is there of the partition goes, but the pieces a build before this one finished — and those of any other revision of it.
  await keepPieces(staging);

  for (const stale of await staleStagingOf(key, revision)) await rm(stale, { recursive: true, force: true });

  /**
   * Whether a batch is written as one file and not a file per instrument: where
   * the month is stored as one file and is its own rows alone. With a
   * neighbour's hours beside it, or added to it, the instruments' own files are
   * what says which instruments the month has.
   */
  const asOne = ! split && ! completes && passes.every(pass => pass === 'own');

  let cursor    = 0;
  let rows      = 0;
  let written   = 0;
  let failure: Error | null = null;

  const worker = async (conn: DuckDBConnection): Promise<void> => {
    for (let at = cursor++; at < tasks.length && ! failure; at = cursor++) {
      const next  = tasks[at]!;
      const piece = next[0]!.piece;

      // A piece of a symbol is built where its other pieces are, apart from what is built whole.
      const into = piece ? pieceDirOf(dirOf(passes[at]!), piece) : dirOf(passes[at]!);

      // A piece a build before this one finished is not built again.
      const had = finished[at];

      if (had) {
        rows += had.rows;

        if (passes[at] === 'own') written += had.files;

        continue;
      }

      try {
        // Extracted ahead where there was time; the build removes it when it has read it.
        const asked    = Date.now();
        const prepared = await prefetch.take(at);

        spent.extract += Date.now() - asked;

        const done = direct(next)
          ? await buildGroup(conn, key, next[0]!.symbol, next[0]!.inputs, into, prepared, spent)
          : await buildBatch(conn, key, next, into, prepared, asOne, spent);

        if (piece) await finishPiece(into, next[0]!.inputs, done);

        rows += done.rows;

        if (passes[at] === 'own') written += done.files;
      } catch (err) {
        failure ??= err as Error;
      }
    }
  };

  await Promise.all(conns.map(worker));

  // What was built a piece at a time is made the files it would have been built as whole.
  for (const pass of new Set(passes)) {
    if (failure) break;

    const repeating = new Set(tasks
      .filter((task, at) => passes[at] === pass && task[0]!.piece && task[0]!.inputs.some(input => seriesFor(input.file)?.repeatsRows))
      .map(task => String(task[0]!.piece!.of)));

    await joinPieces(conns[0]!, key, dirOf(pass), of => repeating.has(of)).catch((err) => { failure = err as Error; });
  }

  // Whatever was extracted for a task no build reached — after a failure — is removed.
  prefetch.release();

  /**
   * **Put in place one partition at a time**, whatever else is being built.
   * Two things here are the vault's as a whole and not this partition's: the
   * ledger, whose lines say which months are mid-change; and the repair that
   * reads them, which would take another partition's month for abandoned while
   * it was only half moved.
   * It is the short end of a build — joins of small files, and renames.
   */
  const built = Date.now();

  const placed = await oneAtATime(async (): Promise<boolean> => {
    const entered = Date.now();

    spent.queued = entered - built;

    /** Whether the vault has been told the month is changing: from then on a failure leaves it to be put right. */
    let marked = false;

    try {
      if (failure) throw failure;

      /**
       * **A side is added only to a month wholly in the vault** — every file its
       * ledger line counts — for the same reason it is only decided on for one:
       * the side holds only the instruments the month's own files name. Files
       * can be moved out while the side is built, so the month is read again.
       */
      if (completes) {
        slices.forget(key);
        before = (await slices.of(key)).get(monthOf(key));

        if (! isWhole(before) || countOf(before) !== completes.count) throw new Error('The month it completes is not wholly in the vault');
      }

      const sides = [...new Set(passes.filter((pass): pass is Side => pass !== 'own'))];

      /**
       * **A side holds only instruments the month has.** One that appears in the
       * neighbour's first hours and nowhere in the month has nothing of this
       * month to add to — and a file the neighbour holds every instrument in
       * names many the month never saw.
       */
      const own = completes
        ? await instrumentsOf(conns[0]!, key, before!)
        : await stagedIn(dirOf('own'));

      for (const side of sides) await keepOnly(dirOf(side), own);

      /**
       * **A bar a neighbour's file repeats is kept once, in the month's own
       * file** — see `dropOverlap`. Held against the month's own rows as they
       * are in the vault, or as they were just built.
       */
      if (key.table === 'klines' && sides.length > 0) {
        const mine = completes
          ? (before!.bundle ? [bundleOf(key)] : before!.symbols.map(symbol => fileOf(key, symbol)))
          : [...own].map(symbol => join(dirOf('own'), `${symbol}${STAGED}`));

        for (const side of sides) {
          const dropped = await dropOverlap(conns[0]!, key, dirOf(side), side, mine);

          if (dropped > 0) logger.info({ partition: labelOf(key), side, rows: dropped }, 'Bars the month already holds left out of its side');
        }
      }

      /**
       * How the month is stored: as it already is where a side is arriving, and
       * otherwise by its weight. A partition with nothing in it is one file
       * whatever it weighed: a file per instrument of no instruments would be
       * nothing at all, and nothing is what an unstocked partition looks like.
       */
      const bundle = completes ? before!.bundle : ! (split && written > 0);

      // Everything the engine has to write is written before the vault is touched.
      const joining = Date.now();
      const whole   = bundle && ! completes ? await bundleStaged(conns[0]!, key, dirOf('own')) : null;
      const beside  = new Map<Side, string>();

      if (bundle)
        for (const side of sides)
          if ((await stagedIn(dirOf(side))).size > 0) beside.set(side, await bundleStaged(conns[0]!, key, dirOf(side)));

      spent.join = Date.now() - joining;

      /**
       * A month the vault has never held has nothing to be caught half way
       * between: until its line is written it is not stocked, whatever of it is
       * in place. One that is there, or that the ledger holds, says it is
       * changing before any file of it does — and whether only sides are
       * being added to it, which is what `repair` puts right accordingly.
       */
      if (before || ledger.has(partitionOf(key))) {
        await mark(key, partition, edges, missing, ! bundle, !! completes);

        marked = true;
        ledger.delete(partitionOf(key));
      }

      // What is there of the month makes way: all of it, or only the sides that are arriving.
      await clear(sliceDirOf(key), monthOf(key), before, completes?.sides);

      const stocked: Stocked = completes
        ? { ...before!, sides: before!.sides.filter(one => ! completes.sides.includes(one.side)) }
        : { bundle, symbols: [], sides: [] };

      if (bundle) {
        if (whole) await publishBundle(key, whole);

        for (const [side, built] of beside) {
          await publishBundle(key, built, side);

          stocked.sides.push({ symbol: BUNDLE, side });
        }
      }
      else {
        const placed = await publishSplit(key, completes ? null : dirOf('own'), sides.map(side => ({ side, staging: dirOf(side) })));

        if (! completes) stocked.symbols = placed.symbols;

        stocked.sides.push(...placed.sides);
      }

      // In the vault whole, so the ledger says what it holds.
      const entry = await record(key, partition, edges, missing, revision, stocked);

      ledger.set(entry.partition, entry);
    } catch (err) {
      failure ??= err as Error;

      // Not a failure: nothing was written, and it is stocked when there is room.
      if (err instanceof NoRoom) {
        summary.noRoom++;

        logger.warn({ partition: labelOf(key), ...roomIn(err.short) }, NO_ROOM);
      }
      else {
        summary.failed++;

        logger.error({ err, partition: labelOf(key), from: partition.id }, 'Stocking failed');
      }

      // Stopped with the month half in place: put right now, not left for the next sweep to find.
      if (marked) await repair().catch(fault => logger.error({ err: fault, partition: labelOf(key) }, 'Could not put the partition right'));

      return false;
    } finally {
      slices.forget(key);

      /**
       * In the vault, nothing of the build is kept; stopped short of it, the
       * pieces that are built are. Clearing staging never changes how the
       * partition went: what it leaves is scratch, cleared at the next start.
       */
      await (failure ? keepPieces(staging) : rm(staging, { recursive: true, force: true }))
        .catch((err: unknown) => logger.warn({ err, partition: labelOf(key) }, 'Could not clear staging'));

      spent.place = Date.now() - entered - spent.join;
    }

    return true;
  });

  if (! placed) return;

  if (completes) summary.completed++;
  else {
    if (written === 0) summary.empty++;

    summary.built++;
    summary.files += written;
  }

  if (missing.length > 0) summary.partial++;

  summary.rows += rows;

  logger.info({ partition: labelOf(key), revision, instruments: written, rows,
    seconds: Math.round((Date.now() - started) / 100) / 10, ms: spent }, completes ? 'Partition completed' : 'Partition stocked');
};

// ── Internals ─────────────────────────────────────────────────────────────────

/**
 * Run one thing at a time, in the order asked: each waits for the one before
 * it, however that one ended.
 */
const oneAtATime = <T>(work: () => Promise<T>): Promise<T> => {
  const mine = last.then(work, work);

  last = mine.catch(() => undefined);

  return mine;
};

let last: Promise<unknown> = Promise.resolve();

/**
 * A month whose archive files weigh more than this is stored as a file per
 * instrument, and a lighter one as one file for all of them.
 *
 * **One number for every deployment, so it is not a setting.** How a month is
 * stored is how it is found in cold storage, which every machine shares: two of
 * them splitting at different weights would store the same partition two ways.
 * Changing it is a change to the code, deployed everywhere at once.
 */
const SPLIT_GB = 1;

let splitBytes = SPLIT_GB * 1024 ** 3;

/** The instruments with a file built in a staging directory. */
const stagedIn = async (dir: string): Promise<Set<string>> =>
  new Set((await readdir(dir).catch(() => [] as string[]))
    .filter(name => name.endsWith(STAGED))
    .map(name => name.slice(0, -STAGED.length)));

/** Remove from a staging directory every instrument's file that is not one of these. */
const keepOnly = async (dir: string, instruments: ReadonlySet<string>): Promise<void> => {
  for (const symbol of await stagedIn(dir))
    if (! instruments.has(symbol)) await rm(join(dir, `${symbol}${STAGED}`), { force: true });
};

/**
 * The instruments a stocked month holds: its directories where it is a file per
 * instrument, and what its one file says where it is not.
 */
const instrumentsOf = async (
  conn:    DuckDBConnection,
  key:     VaultKey,
  stocked: Stocked,
): Promise<Set<string>> => {
  if (! stocked.bundle) return new Set(stocked.symbols);

  const reader = await conn.runAndReadAll(`SELECT DISTINCT symbol FROM read_parquet(${q(bundleOf(key))})`);

  return new Set(reader.getRows().map(row => String(row[0])));
};

// ── Test access ───────────────────────────────────────────────────────────────

/** Stock as if a month split at this weight, or at the real one again. */
export const _test_splitAt = (bytes: number | null): void => { splitBytes = bytes ?? SPLIT_GB * 1024 ** 3; };
