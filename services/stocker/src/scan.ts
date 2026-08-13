import { stat } from 'node:fs/promises';
import { logger } from '@devvir/service-kit';
import type { DuckDBConnection } from '@duckdb/node-api';
import { buildPartition } from './build';
import config from './config';
import { grouper } from './group';
import * as ledger from './ledger';
import * as milestones from './milestones';
import { flag } from './mutations';
import { labelOf } from './partition';
import { donatedMonths, requiredThrough } from './spill';
import { sources } from './sources';
import type { Milestones } from './milestones';
import type { Built, Candidate, Group, RawFile, Summary } from './types';

/**
 * One pass over every origin: discover raw, group it into partitions, and build
 * the partitions that are not already done.
 *
 * Partitions are built **as the walk passes them**, not after a full scan. The
 * only thing a partition needs is every file that belongs to it, and since the
 * walk is depth-first and sorted, those files are contiguous — so a partition
 * is complete the moment the walk moves on to the next one. Collecting the
 * whole tree first would mean no output until a million entries had been read,
 * memory proportional to the tree, and one venue's files waiting behind
 * another's for no reason.
 *
 * Complete partitions go to a **bounded pool**, one connection per build, so an
 * extraction can overlap another partition's sort instead of the service doing
 * one thing at a time. The walk itself stays sequential and backpressured: when
 * every connection is busy it waits, so discovery can never run ahead and pile
 * up unboundedly.
 */
export const sweep = async (conns: DuckDBConnection[]): Promise<Summary> => {
  const summary: Summary =
    { discovered: 0, partitions: 0, built: 0, skipped: 0, pending: 0, empty: 0,
      contested: 0, failed: 0, rows: 0 };

  const built     = await ledger.load();
  const collected = await milestones.load();

  logger.info({ known: built.size, through: lastClosedMonth() }, 'Scanning raw');

  const idle     = [...conns];
  const inFlight = new Set<Promise<void>>();

  /**
   * Venue-months held back because the collector has not finished them.
   *
   * Counted in months rather than files: "3 months waiting" is what somebody
   * reading the log can act on, where "41,000 files" only says the venue is
   * busy.
   */
  const waiting = new Set<string>();

  const dispatch = async (group: Group): Promise<void> => {
    /**
     * Refused rather than built — see `finish` in `group.ts`. Reported at error
     * level because it means the raw tree holds two answers for one month, which
     * only a change to what is collected can settle.
     */
    if (group.contested) {
      summary.contested++;

      logger.error({
        partition: labelOf(group.key),
        inputs:    group.inputs.length,
        first:     group.inputs[0]?.path,
      }, 'Partition assembled from two places — not built; the raw tree holds two renderings of it');

      return;
    }

    while (idle.length === 0) await Promise.race(inFlight);

    const conn = idle.pop()!;

    // `settle` never throws — a failed build is counted and already logged.
    const task: Promise<void> = settle(conn, group, built, collected, summary)
      .finally(() => {
        idle.push(conn);
        inFlight.delete(task);
      });

    inFlight.add(task);
  };

  /**
   * **An open month is never processed, whether or not raw for it exists.**
   *
   * Raw on disk is not a claim that a month is finished — early symbol-major
   * walks left files behind for months no collector has ever closed, and a
   * venue's tree can hold anything anybody ever fetched. Only the collector
   * knows, so its answer is asked here, at discovery, and such a file is never
   * grouped, never built and never reported on.
   *
   * It used to be asked much later, inside `settle`, which let those files be
   * walked and grouped first — so a grouping fault in a month nobody could build
   * was reported as an error per file, and the one partition that reached the
   * build was refused by a gate three steps further on. Asking first makes both
   * disappear.
   */
  const buildable = (file: Candidate): boolean =>
    wanted(file) && collected.covers(file.series.venue)
    && collected.ready(file.series.venue, requiredThrough(file.series, file.month));

  for (const source of sources()) {
    const groups = grouper(buildable);

    for await (const candidate of source.walk()) {
      // Filters run before the `stat`, so a scoped run costs one syscall per
      // kept file rather than one per file in the tree. A file wanted by
      // nobody — not for its own month, not as a donor to a neighbour —
      // never costs one at all.
      const kept = buildable(candidate);

      if (! kept && ! donatedMonths(candidate).some(month => buildable({ ...candidate, month }))) {
        if (wanted(candidate)) waiting.add(`${candidate.series.venue}/${candidate.month}`);

        continue;
      }

      const info = await stat(candidate.absolute).catch(() => null);

      if (! info?.isFile()) continue;

      if (kept) summary.discovered++;

      for (const group of groups.feed({ ...candidate, size: info.size }))
        await dispatch(group);
    }

    for (const group of groups.end()) await dispatch(group);
  }

  await Promise.all(inFlight);

  summary.pending = waiting.size;

  logger.info({ ...summary }, 'Sweep complete');

  return summary;
};

/**
 * What a finished sweep means, said plainly.
 *
 * A sweep that builds nothing looks identical to a stalled one in a log that
 * only reports work — the last line is a partition built minutes ago and
 * nothing since. Whether that is "caught up" or "wedged" is exactly what
 * someone watching needs to know, so it is stated rather than inferred.
 *
 * "Caught up" is a real milestone here, not a pleasantry: every raw file the
 * collectors have published as finished is normalised, which is the condition
 * that makes its raw safe to reclaim.
 */
export const report = (summary: Summary, scanMinutes: number): void => {
  if (summary.failed > 0) {
    logger.warn({ ...summary, minutes: scanMinutes },
      `${summary.failed} partition${summary.failed === 1 ? '' : 's'} failed — rescanning shortly`);

    return;
  }

  if (summary.built > 0) {
    logger.info({ built: summary.built, rows: summary.rows, pending: summary.pending, minutes: scanMinutes },
      `Built ${summary.built} partition${summary.built === 1 ? '' : 's'} — rescanning in ${scanMinutes} minutes`);

    return;
  }

  // Nothing built. Either everything available is done, or what is left is
  // waiting on the collectors — a different situation with a different fix.
  if (summary.pending > 0) {
    logger.info({ pending: summary.pending, minutes: scanMinutes },
      `Caught up — ${summary.pending} partition${summary.pending === 1 ? '' : 's'} waiting on months the collectors have not closed yet; rescanning in ${scanMinutes} minutes`);

    return;
  }

  logger.info({ partitions: summary.partitions, minutes: scanMinutes },
    `Caught up — every partition available is built; rescanning in ${scanMinutes} minutes`);
};

// ── Internals ─────────────────────────────────────────────────────────────────

/**
 * Decide what to do with one complete partition.
 *
 * Three outcomes matter and only one of them writes anything.
 */
const settle = async (
  conn:      DuckDBConnection,
  group:     Group,
  known:     Map<string, Built>,
  collected: Milestones,
  summary:   Summary,
): Promise<void> => {
  const { key, id, inputs } = group;

  summary.partitions++;

  const record = known.get(id);
  const closed = collected.closedAt(key.venue, key.month);

  if (record && ! changed(record, inputs) && ! reopened(record, closed)) {
    summary.skipped++;

    return;
  }

  // A partition is built only once its month is published as finished, so a
  // built record whose inputs no longer match means settled data moved under
  // us. The rebuild below handles it; this is about the month possibly being
  // in cold storage already, which is a person's problem rather than a
  // collector's.
  if (record) await flag(record, inputs);

  /**
   * Whether the partition is still on local disk is deliberately not consulted.
   *
   * A rebuild reads raw and nothing else — the previous Parquet is never an
   * input — and raw is evicted a whole month at a time, so finding *any* raw
   * for a partition means none of that month has been reclaimed. The files in
   * hand are therefore always a superset of the ones the last build recorded,
   * and a rebuild can only ever be more complete than what it replaces. When a
   * month's raw is gone the walk yields no candidates for it at all and this
   * never runs.
   */
  // Announced before the work rather than only after it. A month of a busy
  // symbol takes minutes, and without this the log says nothing at all while it
  // runs — so a slow partition is indistinguishable from a stalled one. The
  // input size is the part that predicts the wait.
  const bytes = inputs.reduce((total, input) => total + input.size, 0);

  logger.info({ partition: labelOf(key), inputs: inputs.length, size: sizeOf(bytes) },
    'Building partition');

  const started = Date.now();

  try {
    const manifest = await buildPartition(conn, key, inputs, collected.closedAt(key.venue, key.month));

    // Every input decoded to nothing — the venue published the files and left
    // them empty. Nothing is written and nothing is recorded, so the month
    // simply has no partition, which is what "it published nothing" means. The
    // next sweep reaches the same conclusion for the same cost.
    if (! manifest) {
      summary.empty++;

      logger.info({ partition: labelOf(key), inputs: inputs.length },
        'Nothing to build — every published file for this month is empty');

      return;
    }

    await ledger.record(manifest);

    summary.built++;
    summary.rows += manifest.rows;

    logger.info({
      partition: labelOf(key),
      rows:      manifest.rows,
      inputs:    inputs.length,
      seconds:   round((Date.now() - started) / 1000),
    }, 'Partition built');
  } catch {
    summary.failed++;   // already logged with its cause in buildPartition
  }
};

/**
 * Whether a partition's inputs differ from what it was built from.
 *
 * **Only new or altered input counts — never missing input.** Raw is backed up
 * and deleted once processed, so a recorded file that has gone from disk must
 * read as "already done". Any other rule would turn reclaiming disk into a
 * silent rebuild of everything.
 */
/**
 * Whether the month was closed again after this partition was built.
 *
 * The collector re-closes a month when something it believed turns out to have
 * been wrong — a symbol universe missing its delisted names, a dataset never
 * collected, a filename shape nobody knew about — and the new closing time is
 * how that repair reaches everything downstream. A partition built against the
 * older time was built from a month that has since been re-collected, whatever
 * its own files look like now.
 *
 * That matters because comparing files is not enough on its own: a repair adds
 * *new* symbols, whose files belong to partitions this one never had, so the
 * inputs of an existing partition can be untouched while the month around it
 * changed completely.
 *
 * A record written before closing times existed carries none, and is left
 * alone — it would otherwise rebuild the entire vault once, to no end.
 */
const reopened = (record: Built, closedAt: string | null): boolean =>
  !! record.closedAt && !! closedAt && record.closedAt !== closedAt;

const changed = (record: Built, inputs: RawFile[]): boolean => {
  const known = new Map(record.inputs.map(i => [i.path, i.size] as const));

  return inputs.some(input => known.get(input.path) !== input.size);
};

/** One decimal place — these are for reading, not for arithmetic. */
const round = (n: number): number => Math.round(n * 10) / 10;

const UNITS = ['B', 'KB', 'MB', 'GB', 'TB'] as const;

/**
 * A byte count at a scale a person can read: `912 B`, `18.1 MB`, `2.4 GB`.
 *
 * Fixing on one unit makes most lines useless — a month of a thin symbol
 * rounds to `0 MB` while a busy one runs to four figures. Binary steps rather
 * than decimal, so the number matches what `ls -lah` says about the same file.
 */
const sizeOf = (bytes: number): string => {
  let scaled = bytes;
  let unit   = 0;

  while (scaled >= 1024 && unit < UNITS.length - 1) {
    scaled /= 1024;
    unit++;
  }

  return `${unit === 0 ? scaled : round(scaled)} ${UNITS[unit]}`;
};

/** `YYYY-MM` of the month before this one, in UTC. */
const lastClosedMonth = (): string => {
  const now = new Date();
  const d   = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1));

  return d.toISOString().slice(0, 7);
};

/**
 * Config filters, applied at discovery so nothing unwanted is even grouped.
 *
 * **The running month is never processed.** Its raw is still arriving, so a
 * partition built from it would be rewritten on every scan and would be wrong
 * the moment it was backed up. Waiting for the month to close makes a partition
 * write-once and immutable, which is what makes eviction to cold storage safe.
 * Late raw for a closed month still triggers a rebuild through `changed`.
 */
const wanted = (file: Candidate): boolean => {
  const { tables, symbols, startMonth, endMonth } = config;

  if (file.month > lastClosedMonth())        return false;
  if (startMonth && file.month < startMonth) return false;
  if (endMonth   && file.month > endMonth)   return false;

  if (tables.length  && ! tables.includes(file.series.table)) return false;
  if (symbols.length && ! symbols.some(t => file.rawSymbol.toUpperCase().includes(t.toUpperCase())))
    return false;

  return true;
};

// ── Test access ───────────────────────────────────────────────────────────────

export const _test_wanted           = wanted;
export const _test_changed          = changed;
export const _test_reopened         = reopened;
export const _test_lastClosedMonth  = lastClosedMonth;
export const _test_sizeOf           = sizeOf;
