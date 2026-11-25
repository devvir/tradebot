import { logger } from '@devvir/service-kit';
import type { DuckDBConnection } from '@duckdb/node-api';
import { listPartitions } from './catalog';
import config from './config';
import { capSpill } from './db';
import { LowSpace, decide } from './decide';
import { Instruments } from './disk';
import { SERIES, extrasOf, seriesOf } from './schema/series';
import { read as readLedger, repair } from './ledger';
import { stock } from './stock';
import { Slices, freeGb, labelOf } from './vault';
import type { Job, Partition, Summary, Sweeping, Target, VaultKey } from './types';

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
 *    version of every partition it is built from, is not in the ledger. One
 *    the ledger holds at another revision is marked outdated there, and stays
 *    so until it is stocked again.
 * 3. **Only its neighbour new?** — a month stocked without a side, whose
 *    neighbour is here now, has that side built and nothing else; it waits
 *    while any file of its own is out of the vault.
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
 *
 * **A failure is the partition's, or the venue's, and not the sweep's.** A
 * venue the catalog cannot list, or a partition that cannot be decided or
 * stocked, is logged and counted as failed, and the sweep goes on with the
 * rest. Only the vault's volume falling below its floor stops it.
 *
 * **Told to stop, it starts nothing more.** Once `stop` is aborted no other
 * partition is decided or stocked; the ones being stocked go on to their end,
 * and the sweep returns when they are there, saying it was drained.
 */
export const sweep = async (conns: DuckDBConnection[], stop?: AbortSignal): Promise<Summary> => {
  // A partition the last sweep was stopped half way through putting in place is put right before anything is read.
  await repair();

  // Nothing is spilled between sweeps, so the cap is set again from the volume as it is now.
  await capSpill(conns[0]!);

  const summary: Summary = {
    considered: 0, current: 0, outdated: 0, built: 0, empty: 0, waiting: 0, partial: 0, completed: 0, missing: 0,
    noRoom: 0, failed: 0, rows: 0, files: 0, stopped: false, drained: false,
  };

  const instruments = new Instruments();
  const slices      = new Slices();
  const sweeping    = { instruments, slices, ledger: await readLedger() };

  const upcoming = jobsOf(sweeping, summary, stop);

  /**
   * **Partitions are decided ahead of the one being stocked**, and wait here.
   * Deciding is what starts a partition's archives being extracted — see
   * `Prefetch` — and it is light work that is mostly waiting on the disk: a
   * stretch of months that turn out not to be there is walked through while
   * the engine is busy, and not while it stands idle. How far ahead is bounded
   * in partitions and in what their archives weigh; what is extracted of them
   * is bounded again, by the disk, where it is done.
   */
  const ready: Job[] = [];
  const stirred: (() => void)[] = [];

  let ended    = false;
  let stopping = false;
  let refused: unknown = null;

  const stir  = (): void => { for (const wake of stirred.splice(0)) wake(); };
  const moved = (): Promise<void> => new Promise(resolve => { stirred.push(resolve); });
  const full  = (): boolean =>
    ready.length >= AHEAD_JOBS || ready.reduce((total, job) => total + job.partition.bytes, 0) >= AHEAD_BYTES;

  const halt = (): void => {
    stopping = summary.drained = true;
    stir();
  };

  if (stop?.aborted) halt();
  else stop?.addEventListener('abort', halt, { once: true });

  const deciding = (async (): Promise<void> => {
    try {
      for await (const job of upcoming) {
        ready.push(job);
        stir();

        while (full() && ! stopping) await moved();

        if (stopping) break;
      }
    } catch (err) {
      // The sweep's to handle, once what was decided before it has been stocked.
      refused = err;
    } finally {
      ended = true;
      stir();
    }
  })();

  /** The next partition to stock, or null when there are no more or the sweep is told to stop. */
  const following = async (): Promise<Job | null> => {
    while (ready.length === 0 && ! ended && ! stopping) await moved();

    if (stopping) return null;

    const job = ready.shift() ?? null;

    stir();

    if (! job && refused) throw refused;

    return job;
  };

  /**
   * **One pool of connections, shared by partitions.** A light partition takes
   * one connection and works through its tasks on it, so as many of those are
   * stocked side by side as there are connections; a heavy one takes them all,
   * and is stocked alone with its tasks side by side. Most months are the
   * first kind, and built one after another they would leave every connection
   * but one idle. Weight, not the number of tasks, is what tells them apart: a
   * month of a few hundred kilobytes over five hundred instruments is two
   * tasks and still nothing.
   */
  const idle    = [...conns];
  const running = new Set<Promise<void>>();

  const freed = async (wanted: number): Promise<DuckDBConnection[]> => {
    while (idle.length < wanted) await Promise.race(running);

    return idle.splice(0, wanted);
  };

  try {
    for (let job = await following(); job; job = await following()) {
      const mine = await freed(job.partition.bytes >= aloneBytes ? conns.length : 1);

      // Told to stop while waiting for connections: the partition goes back with the others never stocked.
      if (stopping) {
        idle.push(...mine);
        ready.unshift(job);

        break;
      }

      const { key, partition, prefetch } = job;

      /**
       * What `stock` does not catch itself fails this partition alone, as it
       * happens; and whatever was extracted for it and never read is given up,
       * however it ended.
       */
      const run: Promise<void> = stock(mine, job, sweeping, summary)
        .catch((err: unknown) => {
          summary.failed++;

          logger.error({ err, partition: labelOf(key), from: partition.id }, 'Stocking failed');
        })
        .finally(() => {
          prefetch.release();
          idle.push(...mine);
          running.delete(run);
        });

      running.add(run);
    }
  } catch (err) {
    if (! (err instanceof LowSpace)) throw err;

    summary.stopped = true;

    logger.warn({ freeGb: err.free, minFreeGb: config.minFreeGb }, 'Vault volume is low on space — stopping this sweep');
  } finally {
    await Promise.allSettled(running);

    stopping = true;
    stir();

    await deciding;

    // Decided and never stocked: what was extracted for them is given up.
    for (const job of ready) job.prefetch.release();

    stop?.removeEventListener('abort', halt);
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

  if (summary.drained) {
    logger.info(counts, `Drained — stocked ${summary.built} partition${summary.built === 1 ? '' : 's'} and started nothing more`);

    return;
  }

  if (summary.stopped) {
    logger.warn(counts, `Stopped for want of space — rescanning in ${scanMinutes} minutes`);

    return;
  }

  if (summary.failed > 0) {
    logger.warn(counts, `${summary.failed} partition${summary.failed === 1 ? '' : 's'} failed — rescanning in ${scanMinutes} minutes`);

    return;
  }

  if (summary.noRoom > 0) {
    logger.warn(counts, `${summary.noRoom} partition${summary.noRoom === 1 ? '' : 's'} waiting for room to extract — ` +
      `rescanning in ${scanMinutes} minutes`);

    return;
  }

  if (summary.built > 0) {
    logger.info(counts, `Stocked ${summary.built} partition${summary.built === 1 ? '' : 's'} — rescanning in ${scanMinutes} minutes`);

    return;
  }

  if (summary.partial + summary.missing > 0) {
    logger.info(counts, `Caught up — ${summary.partial} partition${summary.partial === 1 ? '' : 's'} without a neighbouring month's hours, ` +
      `${summary.missing} not on disk as catalogued` + (summary.outdated > 0 ? ` (${summary.outdated} of them stocked and outdated)` : '') +
      `; rescanning in ${scanMinutes} minutes`);

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

/** How many partitions are decided ahead of the one being stocked, and how much archive they may weigh together. */
const AHEAD_JOBS  = 16;
const AHEAD_BYTES = 2 * 1024 ** 3;

/**
 * A partition whose archives weigh this much has the engine to itself; a
 * lighter one shares it with others. The weight of one batch: below it a month
 * is a batch or two of small instruments, and nothing in it is worth a second
 * connection.
 */
const ALONE_BYTES = 64 * 1024 ** 2;

let aloneBytes = ALONE_BYTES;

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
 *
 * A venue the catalog does not list, and a partition that cannot be decided,
 * are counted as failed and passed over. `LowSpace` ends this early, and so
 * does `stop`, before the next venue or partition.
 */
const jobsOf = async function* (
  sweeping: Sweeping,
  summary:  Summary,
  stop?:    AbortSignal,
): AsyncGenerator<Job, void> {
  for (const venue of venuesInScope()) {
    if (stop?.aborted) return;

    const datasets = datasetsOf(venue);

    if (datasets.length === 0) continue;

    // Below the floor nothing can be stocked, so the catalog is not asked either.
    const free = await freeGb();

    if (free < config.minFreeGb) throw new LowSpace(free);

    let partitions: Map<string, Partition>;

    try {
      partitions = await listPartitions(venue, datasets);
    } catch (err) {
      summary.failed++;

      logger.error({ err, venue }, 'Catalog listing failed — venue skipped this sweep');

      continue;
    }

    for (const target of targetsOf(partitions)) {
      if (stop?.aborted) return;

      summary.considered++;

      let job: Job | null;

      try {
        job = await decide(target, partitions, sweeping, summary);
      } catch (err) {
        if (err instanceof LowSpace) throw err;

        summary.failed++;

        logger.error({ err, partition: labelOf(target.key) }, 'Deciding failed — partition skipped');

        continue;
      }

      if (job) yield job;
    }
  }
};

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

/** Give a partition the engine to itself from this weight, or from the real one again. */
export const _test_aloneAt = (bytes: number | null): void => { aloneBytes = bytes ?? ALONE_BYTES; };
