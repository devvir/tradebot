import type { Db }   from 'mongodb';
import { logger }     from '@devvir/service-kit';

import type { Partition, BoundaryProbe, SourceTable } from './types';

/**
 * Partition discovery — split a `(table, day)` into the `_id` ranges the Reader
 * streams independently.
 *
 * The clustered proxy tables are stored symbol-major: each cluster's whole day is
 * one contiguous `_id` run, runs concatenated. Read as a single `_id` stream the
 * late runs' early-hour rows are dropped, so each run must be read as its own
 * partition. Every other table is time-ordered — one whole-day partition.
 *
 * The clustering key is **per table** (`CLUSTER_FIELD`). `trade`/`quote` cluster by
 * `symbol`. `compositeIndex` clusters by **`indexSymbol`**, not `symbol`: BitMEX's
 * REST `?symbol=` filter on compositeIndex actually matches `indexSymbol`, so
 * scribe's per-symbol fetch returns one contiguous block per `indexSymbol` with the
 * constituents' `symbol` values churning inside it. Keying on `symbol` shreds a
 * basket index into tens of thousands of runs; keying on `indexSymbol` is clean.
 *
 * Run boundaries are found **index-less**, using only the existing `_id` index: no
 * `{field, _id}` index (dozens of GB on `quote`/`compositeIndex`) and no full-day
 * scan. The search runs entirely within the day's *actual used* `_id` range — never
 * the sparse 38-bit slot space — and is bounded so it always finishes fast.
 */

/** The field each clustered table is stored contiguously by. A table absent here is
 *  time-ordered and uses one whole-day partition. */
const CLUSTER_FIELD: Partial<Record<SourceTable, string>> = {
  compositeIndex: 'indexSymbol',
  quote:          'symbol',
  trade:          'symbol',
};

/**
 * Run-count ceiling that doubles as the clustered/time-ordered classifier. A real
 * clustered day has one run per cluster value — a few hundred at most. Time-ordered
 * data switches value on nearly every adjacent document, so the boundary search
 * would find runs without end; crossing this ceiling means "not clustered" and the
 * day collapses to a single whole-day partition. Far above any real cluster count,
 * far below the millions a time-ordered day would yield.
 */
const MAX_RUNS = 4_000;

/** Hard ceiling on probe queries, so discovery terminates quickly no matter what. */
const MAX_PROBES = 200_000;

/**
 * The partitions to read `table` by for the day `[dayLo, dayHi)`. `day` is the
 * `YYYY-MM-DD` label, for logging only.
 *
 * Time-ordered tables return one whole-day partition with no queries. A clustered
 * table resolves its real `_id` endpoints, finds the per-cluster run boundaries by
 * binary search on its `CLUSTER_FIELD`, and returns one partition per run — or, if
 * the data proves time-ordered (boundaries without end), a single whole-day
 * partition.
 */
export async function discoverPartitions(
  db: Db, table: SourceTable, day: string, dayLo: number, dayHi: number,
): Promise<Partition[]> {
  return discover(db, table, day, dayLo, dayHi, MAX_RUNS, MAX_PROBES);
}

/* ------------------------------------------------------------------ */
/*  Internals                                                          */
/* ------------------------------------------------------------------ */

/** `discoverPartitions` with the budgets injected, so tests can drive the
 *  classifier with tiny dimensions instead of a 4 000-cluster fixture. */
async function discover(
  db: Db, table: SourceTable, day: string,
  dayLo: number, dayHi: number, maxRuns: number, maxProbes: number,
): Promise<Partition[]> {
  const field = CLUSTER_FIELD[table];

  if (! field) return [{ lo: dayLo, hiExcl: dayHi }];

  const started = Date.now();
  const ends    = await endpoints(db, table, field, dayLo, dayHi);

  if (! ends) return [];

  const { min, max } = ends;

  // One cluster (or one document) all day: a single run, no boundary search.
  if (min.sym === max.sym) {
    logger.info({ table, day, layout: 'single', partitions: 1, probes: 0 }, 'Instrument distiller: partitions');

    return [{ lo: min.id, hiExcl: max.id + 1 }];
  }

  const starts = new Set<number>();
  const budget = { probes: 0, maxProbes, maxRuns };
  const ok     = await findBoundaries(db, table, field, min, max, starts, budget);

  if (! ok) {
    logger.info(
      { table, day, layout: 'time-ordered', probes: budget.probes, ms: Date.now() - started },
      'Instrument distiller: partitions',
    );

    return [{ lo: min.id, hiExcl: max.id + 1 }];
  }

  // Run starts plus the global bounds give the tiling cut points; the runs between
  // them are disjoint and cover every document from `min.id` to `max.id`.
  const cuts  = [min.id, ...[...starts].sort((a, b) => a - b), max.id + 1];
  const parts: Partition[] = [];

  for (let i = 0; i < cuts.length - 1; i++) parts.push({ lo: cuts[i]!, hiExcl: cuts[i + 1]! });

  logger.info(
    { table, day, layout: 'clustered', partitions: parts.length, probes: budget.probes, ms: Date.now() - started },
    'Instrument distiller: partitions',
  );

  return parts;
}

/**
 * The day's *actual* lowest and highest `_id` (with their cluster-field values) —
 * two indexed `findOne`s, not the sparse 38-bit day bounds. Everything downstream
 * searches only within `[min.id, max.id]`, so no probe ever lands in the empty slot
 * space.
 */
async function endpoints(db: Db, table: SourceTable, field: string, dayLo: number, dayHi: number): Promise<{ min: BoundaryProbe; max: BoundaryProbe } | null> {
  const coll  = db.collection<{ _id: number; [k: string]: unknown }>(table);
  const range = { _id: { $gte: dayLo, $lt: dayHi } };
  const proj  = { projection: { [field]: 1 } };

  const lo = await coll.find(range, proj).sort({ _id:  1 }).limit(1).next();

  if (! lo) return null;

  const hi = await coll.find(range, proj).sort({ _id: -1 }).limit(1).next();

  return { min: { id: lo._id, sym: String(lo[field]) }, max: { id: hi!._id, sym: String(hi![field]) } };
}

/**
 * Collect every run-start `_id` strictly between `lo` and `hi` (exclusive of `lo`;
 * `hi.id` itself is a run start when it differs from its predecessor). Divide and
 * conquer on the `_id` value:
 *
 * - Identical endpoint cluster values ⇒ the whole segment is one contiguous run (the
 *   symbol-major guarantee), so there is no boundary inside it — return without a
 *   query.
 * - Otherwise probe one document nearest the midpoint, strictly inside `(lo, hi)`,
 *   and recurse on both halves. Each probe is a single indexed point read and
 *   strictly shrinks the interval, so the search always terminates.
 * - No document strictly between two differing endpoints ⇒ they are adjacent and
 *   `hi` begins a new run — an exact boundary, no assumption.
 *
 * Returns `false` (and stops early) when the run count or probe count exceeds its
 * budget: the signature of time-ordered data, which the caller reads as one
 * partition.
 */
async function findBoundaries(
  db: Db, table: SourceTable, field: string, lo: BoundaryProbe, hi: BoundaryProbe,
  starts: Set<number>, budget: { probes: number; maxProbes: number; maxRuns: number },
): Promise<boolean> {
  if (lo.sym === hi.sym) return true;

  if (starts.size >= budget.maxRuns || ++budget.probes > budget.maxProbes) return false;

  const mid = await probeBetween(db, table, field, lo.id, hi.id);

  if (! mid) {
    starts.add(hi.id);

    return true;
  }

  return (await findBoundaries(db, table, field, lo, mid, starts, budget))
      && findBoundaries(db, table, field, mid, hi, starts, budget);
}

/**
 * The document nearest the `_id` midpoint of `(loId, hiId)`, strictly inside the
 * open interval — one indexed point read (a second only when the upper half is
 * empty). `null` when no document lies strictly between, i.e. `loId` and `hiId` are
 * adjacent.
 */
async function probeBetween(db: Db, table: SourceTable, field: string, loId: number, hiId: number): Promise<BoundaryProbe | null> {
  const coll = db.collection<{ _id: number; [k: string]: unknown }>(table);
  const proj = { projection: { [field]: 1 } };
  const mid  = loId + Math.floor((hiId - loId) / 2);

  // Nearest at or above the midpoint; `$gt: loId` keeps it strict when `mid === loId`.
  let d = await coll.find({ _id: { $gt: loId, $gte: mid, $lt: hiId } }, proj).sort({ _id: 1 }).limit(1).next();

  if (! d) {
    d = await coll.find({ _id: { $gt: loId, $lt: mid } }, proj).sort({ _id: -1 }).limit(1).next();
  }

  return d ? { id: d._id, sym: String(d[field]) } : null;
}

/* ── Test-only exports ──────────────────────────────────────────────────────── */

export const _test_discover = discover;
