import type { Db }                          from 'mongodb';
import { startOfDayMongoId, parseMongoId }  from '@tradebot/utils';

import { recordDropped }       from './record';
import { discoverPartitions }  from './partitions';
import type { HourBuckets, ServedHour, SourceTable, Partition, PartitionCursor } from './types';

/**
 * Rows fetched per table per warm round, **divided across its partitions**. A
 * time-ordered table (1 partition) fetches the whole budget; a clustered table
 * split into hundreds of partitions fetches a small slice each, so one fetch can't
 * pull a whole cluster's day into memory. The effect of partitioning on read
 * volume is thus neutral — the table's total fetch stays ~one budget, not one
 * budget per cluster.
 */
const READ_BUDGET = 20_000;

/** Floor on a single partition's fetch, so a many-partition table still reads in
 *  useful chunks instead of thrashing on tiny queries. */
const MIN_PARTITION_BATCH = 500;

/** Buckets kept warm per table before the oldest is served, so it is complete. */
const MIN_BUCKET_BUFFER = 3;

const TABLES: SourceTable[] = ['instrument', 'compositeIndex', 'tick', 'quote', 'trade', 'funding', 'settlement'];

/** A source row — only the fields the Reader itself touches are typed. */
type RawRow = { _id: number; timestamp: string; [key: string]: unknown };

interface TableState {
  partitions: PartitionCursor[];
  buckets:    Map<string, RawRow[]>;
}

/**
 * Serves the seven source tables in hourly buckets. Streams each table by `_id`,
 * keeps `MIN_BUCKET_BUFFER` buckets warm so the oldest one is always complete
 * before it is served, and filters `instrument` to original (farmer) documents.
 *
 * The source data is read one day at a time, partitioned per `(table, day)`. A
 * symbol-major (clustered) proxy table — `compositeIndex`/`quote`/`trade` — is
 * split into one partition per symbol cluster; every other table is a single
 * whole-day partition. Each partition is read ahead independently to the same
 * warm horizon, so a last-sorted cluster's early-hour rows are read before serving
 * advances past them — the completeness guarantee a single `_id` stream silently
 * loses on symbol-major data.
 *
 * The data drives the schedule: the Reader serves whichever hour is oldest once
 * enough is buffered. `servedThrough` (the last hour handed out) begins empty on a
 * cold start, so nothing is "too old" until serving has actually begun.
 */
export class Reader {
  private readonly db: Db;
  private readonly state = new Map<SourceTable, TableState>();

  /** Per-table read budget, per-partition floor, and warm-buffer depth — overridable
   *  so tests can drive the real read loop with tiny dimensions. */
  private readonly budget:       number;
  private readonly minBatch:     number;
  private readonly bucketBuffer: number;

  /** The day currently being read, and its `_id` bounds `[dayLo, dayHi)`. */
  private currentDay: string;
  private dayLo:      number;
  private dayHi:      number;
  private discovered = false;

  /** The last hour handed to the Walker. Empty until the first hour is served. */
  private servedThrough: string;

  constructor(
    db: Db, fromId: number, servedThrough: string,
    budget: number = READ_BUDGET, bucketBuffer: number = MIN_BUCKET_BUFFER,
    minBatch: number = MIN_PARTITION_BATCH,
  ) {
    this.db            = db;
    this.servedThrough = servedThrough;
    this.budget        = budget;
    this.minBatch      = minBatch;
    this.bucketBuffer  = bucketBuffer;

    this.currentDay = parseMongoId(fromId).date;
    this.dayLo      = startOfDayMongoId(this.currentDay);
    this.dayHi      = startOfDayMongoId(nextDay(this.currentDay));

    for (const table of TABLES) {
      this.state.set(table, { partitions: [], buckets: new Map() });
    }
  }

  /**
   * Serve the oldest buffered hour across all tables, or `null` when every source
   * is drained. Reads ahead first so the served hour is complete; when the current
   * day empties, advances to the next day with data and reads on.
   */
  async pop(): Promise<ServedHour | null> {
    if (! this.discovered) {
      await this.discoverDay();
      this.discovered = true;
    }

    await this.warmAll();

    let hour = this.oldestHour();

    while (hour === null && await this.advanceDay()) {
      await this.warmAll();
      hour = this.oldestHour();
    }

    if (hour === null) return null;

    const take = (table: SourceTable): RawRow[] => {
      const st  = this.state.get(table)!;
      const out = st.buckets.get(hour!) ?? [];

      st.buckets.delete(hour!);

      return out;
    };

    const buckets: HourBuckets = {
      instrument:     take('instrument')     as unknown as HourBuckets['instrument'],
      compositeIndex: take('compositeIndex') as unknown as HourBuckets['compositeIndex'],
      tick:           take('tick')           as unknown as HourBuckets['tick'],
      quote:          take('quote')          as unknown as HourBuckets['quote'],
      trade:          take('trade')          as unknown as HourBuckets['trade'],
      funding:        take('funding')        as unknown as HourBuckets['funding'],
      settlement:     take('settlement')     as unknown as HourBuckets['settlement'],
    };

    this.servedThrough = hour;

    return { hour, buckets };
  }

  /* ---------------------------------------------------------------- */

  private warmAll(): Promise<void[]> {
    return Promise.all(TABLES.map(table => this.warmTable(table)));
  }

  /** The oldest hour buffered in any table, or `null` if none. */
  private oldestHour(): string | null {
    let oldest: string | null = null;

    for (const st of this.state.values()) {
      for (const key of st.buckets.keys()) {
        if (oldest === null || key < oldest) oldest = key;
      }
    }

    return oldest;
  }

  /** Resolve every table's partitions for the current day, as fresh read cursors. */
  private async discoverDay(): Promise<void> {
    await Promise.all(TABLES.map(async table => {
      const parts = await discoverPartitions(this.db, table, this.currentDay, this.dayLo, this.dayHi);

      this.state.get(table)!.partitions = parts.map(toCursor);
    }));
  }

  /**
   * Jump to the next day that holds any data, across all tables, and discover its
   * partitions. Returns `false` when no source has more — the run is drained.
   * Called only when the current day is fully served (all buckets empty), so it
   * never strands buffered rows.
   */
  private async advanceDay(): Promise<boolean> {
    let minId = Infinity;

    for (const table of TABLES) {
      const filter: Record<string, unknown> = { _id: { $gte: this.dayHi } };

      if (table === 'instrument') filter.$expr = { $eq: [{ $mod: ['$_id', 4] }, 0] };

      const doc = await this.db.collection<RawRow>(table).find(filter).sort({ _id: 1 }).limit(1).next();

      if (doc && doc._id < minId) minId = doc._id;
    }

    if (minId === Infinity) return false;

    this.currentDay = parseMongoId(minId).date;
    this.dayLo      = startOfDayMongoId(this.currentDay);
    this.dayHi      = startOfDayMongoId(nextDay(this.currentDay));

    await this.discoverDay();

    return true;
  }

  /**
   * Read every partition of `table` ahead to the warm horizon. Each partition is a
   * "subtask" running the same read-ahead rule as a whole table once did — read
   * until it is `bucketBuffer` hours past the serve frontier (or exhausted) — only
   * now per symbol cluster, accumulating into the shared buckets. When every
   * partition has read that far, the oldest bucket is complete across all of them.
   */
  private async warmTable(table: SourceTable): Promise<void> {
    const st = this.state.get(table)!;

    // Split the table's budget across its partitions, so a clustered table doesn't
    // fetch one whole budget per cluster. The floor keeps fetches useful when a
    // table has very many partitions.
    const limit = Math.max(this.minBatch, Math.floor(this.budget / Math.max(1, st.partitions.length)));

    for (const p of st.partitions) {
      while (! p.done && this.belowHorizon(p)) {
        const batch = await this.fetch(table, p.cursor, p.hiExcl, limit);

        if (batch.length < limit) p.done = true;

        for (const row of batch) {
          p.cursor = row._id;

          const key = row.timestamp.slice(0, 13);

          if (p.firstHour === '') p.firstHour = key;
          if (key > p.frontier)   p.frontier  = key;

          place(st, table, key, row, this.servedThrough);
        }
      }
    }
  }

  /**
   * Whether partition `p` still needs reading to stay `bucketBuffer` hours ahead.
   * Each partition reads until its frontier reaches the horizon, then the loop
   * moves to the next — so every cluster fills ~`bucketBuffer` hours and stops. A
   * small per-partition fetch keeps the overshoot past the horizon to one batch.
   * Before serving begins the depth is measured against the partition's own first
   * hour (no serve frontier exists yet); after, against `servedThrough`.
   */
  private belowHorizon(p: PartitionCursor): boolean {
    if (p.frontier === '') return true;

    if (this.servedThrough === '')
      return hoursBetween(p.firstHour, p.frontier) < this.bucketBuffer;

    return p.frontier <= addHours(this.servedThrough, this.bucketBuffer);
  }

  /** One `_id`-ordered batch of at most `limit` rows from `table` within `(cursor, hiExcl)`. */
  private async fetch(table: SourceTable, cursor: number, hiExcl: number, limit: number): Promise<RawRow[]> {
    const filter: Record<string, unknown> = { _id: { $gt: cursor, $lt: hiExcl } };

    // `instrument` holds the distiller's own output too — read only originals.
    if (table === 'instrument') {
      filter.$expr = { $eq: [{ $mod: ['$_id', 4] }, 0] };
    }

    return this.db.collection<RawRow>(table)
      .find(filter)
      .sort({ _id: 1 })
      .limit(limit)
      .toArray();
  }

  /** Test-only: total rows currently held in every table's hourly buckets — the
   *  Reader's live memory footprint, for asserting the warm horizon is bounded. */
  _test_bufferedRows(): number {
    let n = 0;

    for (const st of this.state.values())
      for (const rows of st.buckets.values()) n += rows.length;

    return n;
  }
}

/* ------------------------------------------------------------------ */
/*  Internals                                                          */
/* ------------------------------------------------------------------ */

/** Wrap a discovered partition range in fresh read state. `cursor` sits one below
 *  `lo` so the first fetch's `_id > cursor` includes `lo`. */
function toCursor(p: Partition): PartitionCursor {
  return { lo: p.lo, hiExcl: p.hiExcl, cursor: p.lo - 1, frontier: '', firstHour: '', done: false };
}

/**
 * Place one row into its hourly bucket.
 *
 * A row whose hour is after `servedThrough` hasn't been served yet, so it joins
 * (or opens) that hour's bucket — even one earlier than buckets already open.
 * Before any hour has been served `servedThrough` is empty, so every row buckets:
 * the data alone decides which hour is oldest.
 *
 * A row at or before `servedThrough` belongs to an hour already handed out, whose
 * bucket is gone and can never be popped again:
 *   - Proxy tables are synthesis inputs; a stale row is simply unused — drop it
 *     silently. (Partition reads stay ahead of serving, so this only happens when a
 *     re-run re-reads a day's already-served head.)
 *   - An `instrument` document is real data more than a bucket-buffer's worth out
 *     of order — drop it and count it (`recordDropped`) so the loss surfaces in the
 *     daily summary instead of per-row log spam. Reference (`.`-symbol) deltas are
 *     not special here: measured `_date_`↔`timestamp` skew is ≤ ~2 min, far under
 *     the warm horizon, so they never reach this branch in forward processing.
 */
function place(st: TableState, table: SourceTable, key: string, row: RawRow, servedThrough: string): void {
  if (key > servedThrough) {
    const bucket = st.buckets.get(key);

    if (bucket) {
      bucket.push(row);
    } else {
      st.buckets.set(key, [row]);
    }

    return;
  }

  if (table !== 'instrument') return;

  // A real document more than a bucket-buffer's worth out of order: its hour is
  // already sealed, so it can't be placed without disordering the stream. Drop it
  // and count it — the running tally (surfaced per day) is the signal that real
  // state may be at risk, without flooding the log one line per row.
  recordDropped(servedThrough.slice(0, 10));
}

/** The `YYYY-MM-DDTHH` key `n` hours after `hour`. */
function addHours(hour: string, n: number): string {
  const d = new Date(`${hour}:00:00.000Z`);

  d.setUTCHours(d.getUTCHours() + n);

  return d.toISOString().slice(0, 13);
}

/** Hour-key span `[a, b]` inclusive, in hours (1 when `a === b`). */
function hoursBetween(a: string, b: string): number {
  return (Date.parse(`${b}:00:00.000Z`) - Date.parse(`${a}:00:00.000Z`)) / 3_600_000 + 1;
}

/** The `YYYY-MM-DD` day after `date`. */
function nextDay(date: string): string {
  const d = new Date(`${date}T00:00:00.000Z`);

  d.setUTCDate(d.getUTCDate() + 1);

  return d.toISOString().slice(0, 10);
}

/* ── Test-only exports ──────────────────────────────────────────────────────── */

export const _test_place = place;
