import { readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { logger } from '@devvir/service-kit';
import { sizeOf } from '@tradebot/utils';
import type { DuckDBConnection } from '@duckdb/node-api';
import { buildBatch, buildGroup, bundleStaged } from './build';
import { listPartitions } from './catalog';
import config from './config';
import { q } from './db';
import { Instruments, edgeFilesOf, filesOf, matches } from './disk';
import { idOf, neighbourOf } from './keys';
import { SERIES, extrasOf, seriesOf } from './schema/series';
import { MISSING, mark, partitionOf, read as readLedger, record, repair } from './ledger';
import { Prefetch } from './prepare';
import { reachOf } from './spill';
import {
  BUNDLE, STAGED, Slices, bundleOf, clear, freeGb, isWhole, labelOf, monthOf, publishBundle, publishSplit, revisionOf, sliceDirOf,
  stagingOf,
} from './vault';
import type {
  DiskFile, Edge, Entry, Grain, Group, InstrumentDirs, Job, Partition, Pass, Series, Side, Stocked, Summary, Sweeping, Target, Task,
  VaultKey,
} from './types';

/**
 * One pass: ask the catalog what every partition holds, and stock the ones the
 * vault does not hold at their current revision.
 *
 * The catalog is asked only for what can be acted on: partitions with nothing
 * left to download that it takes as settled — so nothing a run is still adding
 * to. For each of those, in order:
 *
 * 1. **With or without its neighbour** — a spilling dataset reads the edge of
 *    the month beside it. Where that month is in the answer its edge is read;
 *    where it is not, the partition is stocked without those hours and says so.
 * 2. **Not already stocked** — its revision, computed from the catalog's
 *    version of every partition it is built from, is not in the ledger.
 * 3. **Only its neighbour new?** — a month stocked without a side, whose
 *    neighbour is here now, has that side built and nothing else.
 * 4. **On disk as the catalog says** — the same count and the same bytes.
 * 5. **Stocked**, into staging: its own rows, and each side, apart.
 * 6. **Put in place**, as one file or as a file per instrument with each side
 *    beside it, over whatever of the month was there — the ledger saying so
 *    before the first file moves, and what it holds after the last.
 *
 * Nothing is checked again afterwards. A partition that changed while it was
 * being stocked has a new version in the catalog, so the next sweep computes a
 * revision the vault does not hold and stocks it again.
 *
 * Several renderings of the same data — a monthly and a daily grain, a market
 * bundle and per-instrument files — are several partitions of the archives
 * that land in one partition of the vault. Whichever of them the vault already
 * holds is current; otherwise one is chosen, by `PREFERENCE`.
 */
export const sweep = async (conns: DuckDBConnection[]): Promise<Summary> => {
  // A partition the last sweep was stopped half way through putting in place is put right before anything is read.
  await repair();

  const summary: Summary = {
    considered: 0, current: 0, built: 0, empty: 0, waiting: 0, partial: 0, completed: 0, missing: 0,
    unmapped: 0, failed: 0, rows: 0, files: 0, stopped: false,
  };

  const instruments = new Instruments();
  const slices      = new Slices();
  const sweeping    = { instruments, slices, ledger: await readLedger() };

  const upcoming = jobsOf(sweeping, summary);

  /** Decided and not yet stocked: its extraction is under way, and is given up if the sweep ends first. */
  let ahead: Job | null = null;

  /**
   * **The partition after this one is decided while this one is stocked.**
   * Deciding it is what starts its archives being extracted, so that by the
   * time the engine is free they are there to be read — see `Prefetch`.
   */
  const following = (): Promise<IteratorResult<Job, void>> => {
    const asked = upcoming.next().then((one) => {
      ahead = one.done ? null : one.value;

      return one;
    });

    // Awaited once the partition in hand is stocked; until then a refusal is nobody's to handle.
    asked.catch(() => {});

    return asked;
  };

  try {
    let next = await following();

    while (! next.done) {
      const job   = next.value;
      const after = following();

      await stock(conns, job, sweeping, summary);

      next = await after;
    }
  } catch (err) {
    if (! (err instanceof LowSpace)) throw err;

    summary.stopped = true;

    logger.warn({ freeGb: err.free, minFreeGb: config.minFreeGb }, 'Vault volume is low on space — stopping this sweep');
  } finally {
    (ahead as Job | null)?.prefetch.release();
  }

  return finish(summary);
};

/**
 * What a finished sweep means, said plainly. A sweep that builds nothing looks
 * identical to a stalled one in a log that only reports work, so whether it is
 * caught up or waiting is stated rather than inferred.
 */
export const report = (summary: Summary, scanMinutes: number): void => {
  const counts = { ...summary, minutes: scanMinutes };

  if (summary.stopped) {
    logger.warn(counts, `Stopped for want of space — rescanning in ${scanMinutes} minutes`);

    return;
  }

  if (summary.failed > 0) {
    logger.warn(counts, `${summary.failed} partition${summary.failed === 1 ? '' : 's'} failed — rescanning in ${scanMinutes} minutes`);

    return;
  }

  if (summary.built > 0) {
    logger.info(counts, `Stocked ${summary.built} partition${summary.built === 1 ? '' : 's'} — rescanning in ${scanMinutes} minutes`);

    return;
  }

  if (summary.partial + summary.missing > 0) {
    logger.info(counts, `Caught up — ${summary.partial} partition${summary.partial === 1 ? '' : 's'} without a neighbouring month's hours, ` +
      `${summary.missing} not on disk as catalogued; rescanning in ${scanMinutes} minutes`);

    return;
  }

  logger.info(counts, `Caught up — every partition in scope is stocked; rescanning in ${scanMinutes} minutes`);
};

/**
 * Minutes between sweeps.
 *
 * A sweep with nothing to stock costs a request to the catalog per venue and a
 * read of the ledger: the archives are looked at only for a partition about to
 * be stocked. So it is run often, and how often is nothing a deployment has a
 * reason to change.
 */
export const SCAN_MINUTES = 5;

// ── Internals ─────────────────────────────────────────────────────────────────

/** Why a sweep stops early: the vault's volume is below the configured floor. */
class LowSpace extends Error {
  constructor(readonly free: number) {
    super(`vault volume has ${free.toFixed(1)} GB free`);
  }
}

/**
 * Which rendering a vault partition is built from, when several are complete:
 * per-instrument files before a market bundle, then the coarsest grain — the
 * fewest files to read for the same rows.
 */
const PREFERENCE: Grain[] = ['monthly', 'daily', 'hourly', 'minutely'];

/**
 * An instrument this big (compressed input) is read on its own; anything
 * smaller joins a batch. A month of a busy symbol's trades is well above it, a
 * month of anything's candles well below.
 */
const DIRECT_BYTES = 32 * 1024 ** 2;

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

/** Where a batch closes: input bytes, or instruments. */
const BATCH_BYTES       = 64 * 1024 ** 2;
const BATCH_INSTRUMENTS = 256;

const finish = (summary: Summary): Summary => {
  logger.info({ ...summary }, 'Sweep complete');

  return summary;
};

/** Every venue the series map knows, or the configured ones — alphabetically either way. */
const venuesInScope = (): string[] =>
  (config.venues.length ? [...config.venues] : [...new Set(SERIES.map(s => s.venue))]).sort();

/** The datasets of a venue the series map reads. */
const datasetsOf = (venue: string): string[] =>
  [...new Set(SERIES.filter(series => series.venue === venue).map(series => series.dataset))].sort();

/** Partitions grouped by where they land in the vault, oldest month first. */
const targetsOf = (partitions: Map<string, Partition>): Target[] => {
  const targets = new Map<string, Target>();

  for (const partition of partitions.values()) {
    if (! wantedMonth(partition.key.month)) continue;

    const series = seriesOf(partition.key);

    if (series.length === 0) continue;

    const first = series[0]!;

    const key: VaultKey = {
      table:  first.table,
      venue:  partition.key.venue,
      market: partition.key.market,
      ...extrasOf(first, partition.key.variant),
      month:  partition.key.month,
    };

    const id = labelOf(key);
    const target = targets.get(id) ?? { key, series, candidates: [] };

    target.candidates.push(partition);
    targets.set(id, target);
  }

  return [...targets.values()].sort((a, b) =>
    a.key.month < b.key.month ? -1 : a.key.month > b.key.month ? 1 :
    labelOf(a.key) < labelOf(b.key) ? -1 : 1);
};

/**
 * The partitions to stock, in the order they are stocked, each decided only
 * when it is asked for: venue by venue, the catalog asked once for each.
 */
const jobsOf = async function* (
  sweeping: Sweeping,
  summary:  Summary,
): AsyncGenerator<Job, void> {
  for (const venue of venuesInScope()) {
    const datasets = datasetsOf(venue);

    if (datasets.length === 0) continue;

    // Below the floor nothing can be stocked, so the catalog is not asked either.
    const free = await freeGb();

    if (free < config.minFreeGb) throw new LowSpace(free);

    const partitions = await listPartitions(venue, datasets);

    for (const target of targetsOf(partitions)) {
      summary.considered++;

      const job = await decide(target, partitions, sweeping, summary);

      if (job) yield job;
    }
  }
};

/**
 * Decide one vault partition: nothing to do, or what to stock it from — with
 * its archives' extraction started.
 */
const decide = async (
  target:     Target,
  partitions: Map<string, Partition>,
  sweeping:   Sweeping,
  summary:    Summary,
): Promise<Job | null> => {
  const { key, series } = target;
  const spill = series[0]!.spill;

  const ready = target.candidates
    .filter(candidate => candidate.files > 0)
    .map(candidate => {
      const reach = reachFor(candidate, spill, partitions);

      return { candidate, ...reach, revision: revisionOf(key, candidate, series, reach.edges, reach.missing) };
    });

  /**
   * **The ledger answers, and without looking at the vault.** A partition it
   * holds at a revision one of these renderings computes is current — whether
   * or not its files are there, since a partition moved out of the vault is
   * still a partition stocked.
   */
  const partition = partitionOf(key);
  const entry     = sweeping.ledger.get(partition);
  const stocked   = entry ? ready.find(one => one.revision === entry.revision) : undefined;

  if (stocked) {
    summary.current++;

    if (stocked.missing.length > 0) summary.partial++;

    return null;
  }

  if (ready.length === 0) {
    summary.waiting++;

    return null;
  }

  /**
   * The preferred rendering that is on disk as the catalog says — the next one
   * if it is not, so a month whose monthly files are gone but whose dailies are
   * here still stocks.
   */
  for (const one of ready.sort((x, y) => rank(x.candidate) - rank(y.candidate))) {
    /**
     * **A month already stocked, whose neighbour has arrived, is not stocked
     * again.** Its own rows are in the vault and have not changed; what is new
     * is the hours the neighbour holds of it. So only those are built, from the
     * neighbour's files, and the month's own archives are not needed — they may
     * have left the disk long ago.
     */
    const arrived = entry ? arrivedFor(entry, key, one, series) : [];
    const before  = arrived.length > 0 ? (await sweeping.slices.of(key)).get(monthOf(key)) : undefined;

    if (entry && arrived.length > 0 && isWhole(before)) {
      const donated = await edgesOnDisk(arrived, sweeping.instruments);

      if (! donated) continue;

      if (await freeGb() < config.minFreeGb) throw new LowSpace(await freeGb());

      const symbols = before!.bundle ? null : new Set(before!.symbols);
      const built   = arrived.map(edge => tasksOf(sideGroupsOf(donated.get(edge.end) ?? [], symbols)));
      const tasks   = built.flat();

      return {
        key, partition: one.candidate, revision: one.revision, edges: one.edges, missing: one.missing, tasks,
        passes: built.flatMap((own, at) => own.map(() => arrived[at]!.end)),
        files: [...donated.values()].flat().length, prefetch: new Prefetch(tasks),
        completes: { revision: entry.revision, sides: arrived.map(edge => edge.end) },
      };
    }

    const files = await filesOf(one.candidate.key, sweeping.instruments);

    if (! matches(files, one.candidate)) continue;

    const donated = await edgesOnDisk(one.edges, sweeping.instruments);

    if (! donated) continue;

    if (await freeGb() < config.minFreeGb) throw new LowSpace(await freeGb());

    const own     = groupsOf(files);
    const symbols = new Set(own.map(group => group.symbol));
    const sides   = one.edges.map(edge => tasksOf(sideGroupsOf(donated.get(edge.end) ?? [], symbols)));
    const tasks   = [...tasksOf(own), ...sides.flat()];

    return {
      key, partition: one.candidate, revision: one.revision, edges: one.edges, missing: one.missing, tasks,
      passes: [...tasksOf(own).map((): Pass => 'own'), ...sides.flatMap((side, at) => side.map(() => one.edges[at]!.end))],
      files: files.length, prefetch: new Prefetch(tasks), completes: null,
    };
  }

  summary.missing++;

  logger.info({ partition: labelOf(key), renderings: ready.map(one => one.candidate.id) },
    'Not on disk as catalogued — skipped');

  return null;
};

/**
 * The sides a stocked month was missing that are there to be read now — where
 * that is the only thing that has changed.
 *
 * The ledger line has to be of this very rendering at this very version, and
 * the revision it names has to be the one this rendering would have computed
 * with those sides missing. Anything else — a file of the month changed, a
 * series edited, a neighbour replaced — is a month to stock again from its own
 * archives, and answers with nothing here.
 */
const arrivedFor = (
  entry:  Entry,
  key:    VaultKey,
  one:    { candidate: Partition; edges: Edge[]; missing: Side[] },
  series: Series[],
): Edge[] => {
  const source = one.candidate.key;

  if (entry.grain !== source.grain || entry.bundle !== source.bundle || entry.version !== one.candidate.version) return [];

  const was: Side[] = [];

  if (entry.preVersion === MISSING)  was.push('pre');
  if (entry.postVersion === MISSING) was.push('post');

  const arrived = one.edges.filter(edge => was.includes(edge.end));

  if (arrived.length === 0) return [];

  const then = revisionOf(key, one.candidate, series, one.edges.filter(edge => ! was.includes(edge.end)), was);

  return then === entry.revision ? arrived : [];
};

/**
 * The neighbours' edge files, side by side — or null unless every neighbour is
 * on disk as the catalog says. The neighbour is checked whole, since that is
 * what the catalog counts; only its edge is read.
 */
const edgesOnDisk = async (edges: readonly Edge[], instruments: InstrumentDirs): Promise<Map<Side, DiskFile[]> | null> => {
  const donated = new Map<Side, DiskFile[]>();

  for (const edge of edges) {
    if (! matches(await filesOf(edge.partition.key, instruments), edge.partition)) return null;

    donated.set(edge.end, await edgeFilesOf(edge.partition.key, edge.side, instruments));
  }

  return donated;
};

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
 * between, the month still says `updating` and is put right before it is read
 * again — see `repair`.
 */
const stock = async (
  conns:    DuckDBConnection[],
  job:      Job,
  sweeping: Sweeping,
  summary:  Summary,
): Promise<void> => {
  const { key, partition, revision, edges, missing, tasks, passes, prefetch, completes } = job;
  const { ledger, slices } = sweeping;

  const staging = stagingOf(key, revision);
  const dirOf   = (pass: Pass): string => join(staging, pass);
  const started = Date.now();

  /** What the vault holds of the month as this starts: what a completion adds to, and what anything else replaces. */
  const before  = (await slices.of(key)).get(monthOf(key));
  const split   = completes ? ! before?.bundle : partition.bytes > splitBytes;

  logger.info({ partition: labelOf(key), from: partition.id, revision, files: job.files,
    size: sizeOf(partition.bytes), as: split ? 'a file per instrument' : 'one file',
    ...(completes ? { completing: completes.revision } : {}),
    ...(missing.length > 0 ? { without: missing } : {}) },
  completes ? 'Completing partition' : 'Stocking partition');

  await rm(staging, { recursive: true, force: true });

  let cursor    = 0;
  let rows      = 0;
  let written   = 0;
  let failure: Error | null = null;

  const worker = async (conn: DuckDBConnection): Promise<void> => {
    for (let at = cursor++; at < tasks.length && ! failure; at = cursor++) {
      const next = tasks[at]!;
      const into = dirOf(passes[at]!);

      try {
        // Extracted ahead where there was time; the build removes it when it has read it.
        const prepared = await prefetch.take(at);

        const done = next.length === 1 && bytesOf(next[0]!) >= DIRECT_BYTES
          ? await buildGroup(conn, key, next[0]!.symbol, next[0]!.inputs, into, prepared)
          : await buildBatch(conn, key, next, into, prepared);

        rows += done.rows;

        if (passes[at] === 'own') written += done.files;
      } catch (err) {
        failure ??= err as Error;
      }
    }
  };

  await Promise.all(conns.map(worker));

  // Whatever was extracted for a task no build reached — after a failure — is removed.
  prefetch.release();

  /** Whether the vault has been told the month is changing: from then on a failure leaves it to be put right. */
  let marked = false;

  try {
    if (failure) throw failure;

    if (completes && ! isWhole(before)) throw new Error('The month it completes is no longer in the vault');

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
     * How the month is stored: as it already is where a side is arriving, and
     * otherwise by its weight. A partition with nothing in it is one file
     * whatever it weighed: a file per instrument of no instruments would be
     * nothing at all, and nothing is what an unstocked partition looks like.
     */
    const bundle = completes ? before!.bundle : ! (split && written > 0);

    // Everything the engine has to write is written before the vault is touched.
    const whole  = bundle && ! completes ? await bundleStaged(conns[0]!, key, dirOf('own')) : null;
    const beside = new Map<Side, string>();

    if (bundle)
      for (const side of sides)
        if ((await stagedIn(dirOf(side))).size > 0) beside.set(side, await bundleStaged(conns[0]!, key, dirOf(side)));

    /**
     * A month the vault has never held has nothing to be caught half way
     * between: until its line is written it is not stocked, whatever of it is
     * in place. One that is there, or that the ledger holds, says it is
     * changing before any file of it does.
     */
    if (before || ledger.has(partitionOf(key))) {
      await mark(key, partition, edges, missing, ! bundle);

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
    summary.failed++;

    logger.error({ err, partition: labelOf(key), from: partition.id }, 'Stocking failed');

    // Stopped with the month half in place: put right now, not left for the next sweep to find.
    if (marked) await repair().catch(fault => logger.error({ err: fault, partition: labelOf(key) }, 'Could not put the partition right'));

    return;
  } finally {
    slices.forget(key);

    await rm(staging, { recursive: true, force: true });
  }

  if (completes) summary.completed++;
  else {
    if (written === 0) summary.empty++;

    summary.built++;
    summary.files += written;
  }

  if (missing.length > 0) summary.partial++;

  summary.rows += rows;

  logger.info({ partition: labelOf(key), revision, instruments: written, rows,
    seconds: Math.round((Date.now() - started) / 100) / 10 }, completes ? 'Partition completed' : 'Partition stocked');
};

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

/** One group per catalog symbol, of its own files. The bundle `@` is one group like any other. */
const groupsOf = (files: DiskFile[]): Group[] => {
  const bySymbol = new Map<string, DiskFile[]>();

  for (const one of files) bySymbol.set(one.file.symbol, [...bySymbol.get(one.file.symbol) ?? [], one]);

  return [...bySymbol].map(([symbol, inputs]) => ({ symbol, inputs }));
};

/**
 * One group per catalog symbol, of a neighbour's edge files — for the symbols
 * the month itself holds, where those are known by name. A neighbour's edge
 * belongs to a symbol this month also holds; a symbol that only appears in the
 * neighbour has nothing of this month to complete.
 */
const sideGroupsOf = (donated: DiskFile[], symbols: ReadonlySet<string> | null): Group[] =>
  groupsOf(donated.filter(one => ! symbols || symbols.has(one.file.symbol)));

/**
 * The neighbouring months a candidate reads the edge of: those that are in the
 * catalog's answer, and the sides whose neighbour is not. A partition that does
 * not spill has neither.
 */
const reachFor = (
  candidate:  Partition,
  spill:      Series['spill'],
  partitions: Map<string, Partition>,
): { edges: Edge[]; missing: Side[] } => {
  const edges: Edge[]   = [];
  const missing: Side[] = [];

  for (const { by, side } of reachOf(spill)) {
    const neighbour = partitions.get(idOf(neighbourOf(candidate.key, by)));
    const end: Side = by > 0 ? 'post' : 'pre';

    if (! neighbour || neighbour.files === 0) missing.push(end);
    else edges.push({ partition: neighbour, side, end });
  }

  return { edges, missing };
};

/**
 * The work a partition is split into: an instrument big enough to be read on
 * its own, or a batch of small ones read together (see `buildBatch`). A batch
 * closes at `BATCH_BYTES` of input or `BATCH_INSTRUMENTS` instruments, so one
 * read's temporary table stays bounded.
 */
const tasksOf = (groups: Group[]): Task[] => {
  const tasks: Task[] = [];
  let batch: Group[]  = [];
  let bytes           = 0;

  for (const group of groups) {
    const size = bytesOf(group);

    if (size >= DIRECT_BYTES) {
      tasks.push([group]);

      continue;
    }

    batch.push(group);
    bytes += size;

    if (bytes >= BATCH_BYTES || batch.length >= BATCH_INSTRUMENTS) {
      tasks.push(batch);
      batch = [];
      bytes = 0;
    }
  }

  if (batch.length) tasks.push(batch);

  return tasks;
};

const bytesOf = (group: Group): number => group.inputs.reduce((total, one) => total + one.size, 0);

const rank = (partition: Partition): number =>
  (partition.key.bundle === 'instrument' ? 0 : 10) + PREFERENCE.indexOf(partition.key.grain);

/**
 * **Never the running month**: its files are still arriving, so a partition
 * stocked from it would be restocked every day.
 */
const wantedMonth = (month: string): boolean => month <= lastClosedMonth();

/** `YYYY-MM` of the month before this one, in UTC. */
const lastClosedMonth = (): string => {
  const now = new Date();

  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1)).toISOString().slice(0, 7);
};

// ── Test access ───────────────────────────────────────────────────────────────

export const _test_wantedMonth = wantedMonth;

/** Stock as if a month split at this weight, or at the real one again. */
export const _test_splitAt = (bytes: number | null): void => { splitBytes = bytes ?? SPLIT_GB * 1024 ** 3; };
export const _test_groupsOf    = groupsOf;
export const _test_sideGroupsOf = sideGroupsOf;
export const _test_rank        = rank;
export const _test_tasksOf     = tasksOf;
