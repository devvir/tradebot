import { rm } from 'node:fs/promises';
import { logger } from '@devvir/service-kit';
import { sizeOf } from '@tradebot/utils';
import type { DuckDBConnection } from '@duckdb/node-api';
import { buildBatch, buildGroup, bundleStaged } from './build';
import { listPartitions } from './catalog';
import config from './config';
import { Instruments, edgeFilesOf, filesOf, matches } from './disk';
import { idOf, neighbourOf } from './keys';
import { SERIES, extrasOf, seriesOf } from './schema/series';
import { reachOf } from './spill';
import { Slices, freeGb, isWhole, labelOf, monthOf, prune, publishBundle, publishSplit, revisionOf, stagingOf } from './vault';
import type {
  DiskFile, Edge, Grain, Group, InstrumentDirs, Partition, Series, Stocked, Summary, Sweeping, Target, Task, VaultKey,
} from './types';

/**
 * One pass: ask the catalog what every partition holds, and stock the ones the
 * vault does not hold at their current revision.
 *
 * The catalog is asked only for what can be acted on: partitions with nothing
 * left to download that it has not seen change for `coolHours` — so nothing a
 * run is still adding to. For each of those, in order:
 *
 * 1. **With its neighbour** — a spilling dataset reads the edge of the month
 *    beside it, which has to be ready too.
 * 2. **Not already stocked** — its revision, computed from the catalog's
 *    version of every partition it is built from, is not in the vault.
 * 3. **On disk as the catalog says** — the same count and the same bytes.
 * 4. **Stocked**, into a staging directory, one file per instrument.
 * 5. **Published**, as one file or as a file per instrument, and every other
 *    revision removed.
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
  const summary: Summary = {
    considered: 0, current: 0, built: 0, empty: 0, waiting: 0, missing: 0,
    unmapped: 0, failed: 0, rows: 0, files: 0, stopped: false,
  };

  const instruments = new Instruments();
  const slices      = new Slices();

  /** Changed in the catalog after this, and a partition is not taken as settled. */
  const settledBefore = new Date(Date.now() - config.coolHours * 3_600_000).toISOString();

  for (const venue of venuesInScope()) {
    const datasets = datasetsOf(venue);

    if (datasets.length === 0) continue;

    // Below the floor nothing can be stocked, so the catalog is not asked either.
    const free = await freeGb();

    if (free < config.minFreeGb) {
      summary.stopped = true;

      logger.warn({ freeGb: free, minFreeGb: config.minFreeGb }, 'Vault volume is low on space — stopping this sweep');

      return finish(summary);
    }

    const partitions = await listPartitions(venue, datasets, settledBefore);
    const targets    = targetsOf(partitions);

    for (const target of targets) {
      summary.considered++;

      try {
        await settle(conns, target, partitions, { instruments, slices }, summary);
      } catch (err) {
        if (err instanceof LowSpace) {
          summary.stopped = true;

          logger.warn({ freeGb: err.free, minFreeGb: config.minFreeGb },
            'Vault volume is low on space — stopping this sweep');

          return finish(summary);
        }

        throw err;
      }
    }
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

  if (summary.waiting + summary.missing > 0) {
    logger.info(counts, `Caught up — ${summary.waiting} partition${summary.waiting === 1 ? '' : 's'} waiting on a neighbouring month, ` +
      `${summary.missing} not on disk as catalogued; rescanning in ${scanMinutes} minutes`);

    return;
  }

  logger.info(counts, `Caught up — every partition in scope is stocked; rescanning in ${scanMinutes} minutes`);
};

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

/** Where a batch closes: input bytes, or instruments. */
const BATCH_BYTES       = 64 * 1024 ** 2;
const BATCH_INSTRUMENTS = 256;

const finish = (summary: Summary): Summary => {
  logger.info({ ...summary }, 'Sweep complete');

  return summary;
};

/** Every venue the series map knows, or the configured ones. */
const venuesInScope = (): string[] =>
  config.venues.length ? [...config.venues] : [...new Set(SERIES.map(s => s.venue))].sort();

/** The datasets of a venue the series map reads, within the configured tables. */
const datasetsOf = (venue: string): string[] =>
  [...new Set(SERIES
    .filter(series => series.venue === venue
      && (! config.tables.length || config.tables.includes(series.table)))
    .map(series => series.dataset))].sort();

/** Partitions grouped by where they land in the vault, oldest month first. */
const targetsOf = (partitions: Map<string, Partition>): Target[] => {
  const targets = new Map<string, Target>();

  for (const partition of partitions.values()) {
    if (! wantedMonth(partition.key.month)) continue;

    const series = seriesOf(partition.key);

    if (series.length === 0) continue;

    const first = series[0]!;

    if (config.tables.length && ! config.tables.includes(first.table)) continue;

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

/** Decide one vault partition, and stock it where it needs stocking. */
const settle = async (
  conns:      DuckDBConnection[],
  target:     Target,
  partitions: Map<string, Partition>,
  sweeping:   Sweeping,
  summary:    Summary,
): Promise<void> => {
  const { key, series } = target;
  const spill = series[0]!.spill;

  const ready = target.candidates
    .filter(candidate => candidate.files > 0)
    .map(candidate => ({ candidate, edges: edgesFor(candidate, spill, partitions) }))
    .filter(({ edges }) => edges !== null)
    .map(({ candidate, edges }) => ({
      candidate,
      edges:    edges!,
      revision: revisionOf(key, candidate, series, edges!),
    }));

  const held    = (await sweeping.slices.of(key)).get(monthOf(key)) ?? new Map<string, Stocked>();
  const current = ready.find(one => isWhole(held.get(one.revision)));

  if (current) {
    summary.current++;

    if (held.size > 1) {
      await prune(key, current.revision, held);
      sweeping.slices.forget(key);
    }

    return;
  }

  if (ready.length === 0) {
    summary.waiting++;

    return;
  }

  /**
   * The preferred rendering that is on disk as the catalog says — the next one
   * if it is not, so a month whose monthly files are gone but whose dailies are
   * here still stocks.
   */
  for (const one of ready.sort((x, y) => rank(x.candidate) - rank(y.candidate))) {
    const inputs = await onDisk(one.candidate, one.edges, sweeping.instruments);

    if (! inputs) continue;

    if (await freeGb() < config.minFreeGb) throw new LowSpace(await freeGb());

    await stock(conns, key, one.candidate, one.revision, inputs.files, inputs.donated, held, summary);
    sweeping.slices.forget(key);

    return;
  }

  summary.missing++;

  logger.info({ partition: labelOf(key), renderings: ready.map(one => one.candidate.id) },
    'Not on disk as catalogued — skipped');
};

/**
 * A rendering's files and its neighbours' edge files, or null unless every
 * partition they come from is on disk as the catalog says.
 */
const onDisk = async (
  candidate:   Partition,
  edges:       Edge[],
  instruments: InstrumentDirs,
): Promise<{ files: DiskFile[]; donated: DiskFile[] } | null> => {
  const files = await filesOf(candidate.key, instruments);

  if (! matches(files, candidate)) return null;

  const donated: DiskFile[] = [];

  for (const edge of edges) {
    // The neighbour is checked whole, since that is what the catalog counts; only its edge is read.
    if (! matches(await filesOf(edge.partition.key, instruments), edge.partition)) return null;

    donated.push(...await edgeFilesOf(edge.partition.key, edge.side, instruments));
  }

  return { files, donated };
};

/**
 * Build a partition into staging, one instrument per connection at a time,
 * then publish it: as one file, or — where the archive files it came from
 * weigh more than `splitGb` — as a file per instrument.
 */
const stock = async (
  conns:     DuckDBConnection[],
  key:       VaultKey,
  partition: Partition,
  revision:  string,
  files:     DiskFile[],
  donated:   DiskFile[],
  held:      Map<string, Stocked>,
  summary:   Summary,
): Promise<void> => {
  const staging = stagingOf(key, revision);
  const started = Date.now();
  const split   = partition.bytes > config.splitGb * 1024 ** 3;

  logger.info({ partition: labelOf(key), from: partition.id, revision, files: files.length,
    size: sizeOf(partition.bytes), as: split ? 'a file per instrument' : 'one file' }, 'Stocking partition');

  await rm(staging, { recursive: true, force: true });

  const queue   = tasksOf(groupsOf(files, donated));
  let rows      = 0;
  let written   = 0;
  let failure: Error | null = null;

  const worker = async (conn: DuckDBConnection): Promise<void> => {
    for (let next = queue.shift(); next && ! failure; next = queue.shift()) {
      try {
        const done = next.length === 1 && bytesOf(next[0]!) >= DIRECT_BYTES
          ? await buildGroup(conn, key, next[0]!.symbol, next[0]!.inputs, staging)
          : await buildBatch(conn, key, next, staging);

        rows    += done.rows;
        written += done.files;
      } catch (err) {
        failure ??= err as Error;
      }
    }
  };

  await Promise.all(conns.map(worker));

  try {
    if (failure) throw failure;

    /**
     * A partition with nothing in it is stored as one file whatever it weighed:
     * a file per instrument of no instruments would be nothing at all, and
     * nothing is what an unstocked partition looks like.
     */
    if (split && written > 0) await publishSplit(key, revision, staging);
    else await publishBundle(key, revision, await bundleStaged(conns[0]!, key, staging));

    await prune(key, revision, held);
  } catch (err) {
    summary.failed++;

    logger.error({ err, partition: labelOf(key), from: partition.id }, 'Stocking failed');

    return;
  } finally {
    await rm(staging, { recursive: true, force: true });
  }

  if (written === 0) summary.empty++;

  summary.built++;
  summary.rows  += rows;
  summary.files += written;

  logger.info({ partition: labelOf(key), revision, instruments: written, rows,
    seconds: Math.round((Date.now() - started) / 100) / 10 }, 'Partition stocked');
};

/**
 * One group per catalog symbol — its own files, and what a neighbour's edge
 * donates to it. The bundle `@` is one group like any other.
 */
const groupsOf = (files: DiskFile[], donated: DiskFile[]): Group[] => {
  const bySymbol = new Map<string, DiskFile[]>();

  for (const one of files) bySymbol.set(one.file.symbol, [...bySymbol.get(one.file.symbol) ?? [], one]);

  // A neighbour's edge belongs to a symbol this month also holds; a symbol that
  // only appears in the neighbour has nothing of this month to complete.
  for (const one of donated) {
    const own = bySymbol.get(one.file.symbol);

    if (own) own.push(one);
  }

  return [...bySymbol].map(([symbol, inputs]) => ({ symbol, inputs }));
};

/**
 * The neighbouring months a candidate reads the edge of, or null when one is
 * not among the ready partitions. A partition that does not spill needs none.
 */
const edgesFor = (
  candidate:  Partition,
  spill:      Series['spill'],
  partitions: Map<string, Partition>,
): Edge[] | null => {
  const edges: Edge[] = [];

  for (const { by, side } of reachOf(spill)) {
    const neighbour = partitions.get(idOf(neighbourOf(candidate.key, by)));

    if (! neighbour || neighbour.files === 0) return null;

    edges.push({ partition: neighbour, side });
  }

  return edges;
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
 * Config bounds, and **never the running month**: its files are still
 * arriving, so a partition stocked from it would be restocked every day.
 */
const wantedMonth = (month: string): boolean => {
  const { startMonth, endMonth } = config;

  if (month > lastClosedMonth())             return false;
  if (startMonth && month < startMonth)      return false;
  if (endMonth   && month > endMonth)        return false;

  return true;
};

/** `YYYY-MM` of the month before this one, in UTC. */
const lastClosedMonth = (): string => {
  const now = new Date();

  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1)).toISOString().slice(0, 7);
};

// ── Test access ───────────────────────────────────────────────────────────────

export const _test_wantedMonth = wantedMonth;
export const _test_groupsOf    = groupsOf;
export const _test_rank        = rank;
export const _test_tasksOf     = tasksOf;
