/** A canonical table. One table is one schema and one queryable dataset root. */
export type Table =
  | 'trades' | 'quotes' | 'orderBook' | 'depthBands' | 'klines'
  | 'markPrice' | 'indexPrice' | 'premiumIndex'
  | 'funding' | 'borrowing' | 'openInterest' | 'liquidations' | 'settlement';

/**
 * Contract shape, deliberately excluding margining. Binance splits futures into
 * `um`/`cm`, Gate into `futures_usdt`/`futures_btc`, Bybit into linear/inverse —
 * three vocabularies for one idea. Keeping only the shape here means
 * `market=perp` means the same thing on every venue.
 */
export type Market = 'spot' | 'perp' | 'future' | 'option' | 'index';

/** One column of a headerless file, in published order. */
export interface Column {
  /** Canonical name, or null for a column that exists and is dropped. */
  as: string | null;
}

/**
 * How to read one series a source publishes, and what it becomes.
 *
 * This is the entire per-source knowledge of stocker. Discovery, decoding,
 * partitioning and writing are generic and never name a venue, so adding a
 * series is one entry in the map and adding an origin is one file under
 * `sources/`.
 */
export interface Series {
  /** Origin tree this belongs to — `trucker` today, REST and websocket later. */
  source:    string;
  venue:     string;
  table:     Table;
  market:    Market;

  /** Matches a raw path relative to the venue root; must capture `symbol`. */
  match:     RegExp;

  container: string;
  format:    string;

  /**
   * Whether the file carries a header row. When it does, columns are read as
   * published and mapped by name, so a venue adding a column shifts nothing.
   * When it does not, `columns` must name every column in order.
   */
  header:    boolean;
  columns?:  Column[];

  /**
   * Canonical field → expression over the source relation. Fields the venue
   * does not publish are simply absent and land as NULL, which is what keeps
   * one schema across venues that disagree about what a trade record contains.
   */
  project:   Record<string, string>;

  /**
   * Source column holding the event time.
   *
   * Only *which* column, never what unit it is in: the unit is read from the
   * value, because venues change precision mid-history and a declaration is
   * then silently wrong for one side of the change.
   */
  ts:        string;

  /**
   * Bar length, for a kline series whose files do not say what it is.
   *
   * Most venues put the interval in the path and it is captured by `match`.
   * OKX does not, at any level — so it is recorded here instead, read off the
   * spacing of the bars themselves (a uniform 60s).
   */
  interval?: string;

  /** Extra partition level below `symbol=`, for tables that need one. */
  variant?:  string;

  /**
   * What a series *is*, when a venue publishes two of the same table that mean
   * different things.
   *
   * Gate publishes funding twice: `funding_applies` is what was charged at the
   * end of an interval, 3 rows a day; `funding_updates` is the running estimate
   * for the next one, 1,440 a day. Different cadence, different meaning, and a
   * reader almost always wants one or the other rather than both interleaved.
   *
   * **It is a path level and never a column.** As a projected column the two
   * series computed the same partition id and silently overwrote each other on
   * every sweep, and a filter on a plain column prunes no files — reading
   * realised funding would scan 480x the rows it needs, for ever.
   */
  kind?:     string;

  /**
   * Where a bucket's rows can fall relative to the period its name denotes,
   * for a venue whose day does not cut at UTC midnight.
   *
   * Bitget cuts at 16:00 UTC — midnight UTC+8 — so a file named `20250101`
   * opens at 2024-12-31 16:00 UTC: its head belongs to December. That is
   * `back`. A venue cutting before UTC midnight would be `forward`, one that
   * drifts either way `both`. Unset means buckets match UTC cuts exactly.
   *
   * The rows themselves need no transformation — timestamps are correct as
   * published; only *which file holds them* is shifted. Stocker answers it by
   * reading one neighbouring bucket into each month's build and clipping the
   * output to the month, which assumes the offset is smaller than one bucket.
   * A venue shifted by more than a whole bucket would be data too messy to
   * collect from archives at all.
   */
  spill?:    Spill;

  /**
   * Whether one partition's files reach the walk from more than one place.
   *
   * **Grouping is normally streamed**, because a depth-first sorted walk hands a
   * partition's files over consecutively — so a partition is complete the moment
   * a different one begins, and nothing is held in memory. Every venue but one
   * satisfies that by construction: a partition lives in a single directory.
   *
   * Bitget does not. It published klines under two names and still serves both,
   * so one month arrives as `kline/BTCUSDT/BTCUSDT_UMCBL_1min_20200819.zip` and
   * as `kline/BTCUSDT/UMCBL/20200824.zip` — and in name order every flat file of
   * every month precedes the first nested one. The two halves are separated by
   * thousands of files belonging to other partitions.
   *
   * Set here, such a series is instead gathered across the whole symbol and
   * closed when the walk leaves it. That costs one symbol's files in memory —
   * a few thousand at worst — and is why it is opt-in rather than the rule.
   *
   * **The walk must be symbol-major for a series that sets this**, which is what
   * makes leaving the symbol a safe moment to close. It is, for the only venue
   * that needs it: everything for one symbol sits under `kline/<symbol>/`.
   */
  scattered?: boolean;
}

/** Which neighbouring period a venue's buckets can spill rows into. */
export type Spill = 'back' | 'forward' | 'both';

/** One complete partition's worth of raw files, as the walk assembles them. */
export interface Group {
  key:    PartitionKey;
  id:     string;
  inputs: RawFile[];

  /**
   * Set when this partition was assembled a second time in one walk, meaning its
   * inputs reached it from two places — a series whose files are not contiguous
   * and has not declared `scattered`, or a dataset collected in both the monthly
   * and daily renderings a venue publishes. It is never built: which inputs are
   * right is a question about what was collected, not one to settle by guessing.
   */
  contested?: boolean;
}

/** Assembles the walk's file stream into complete partitions — see group.ts. */
export interface Grouper {
  feed(file: RawFile): Group[];
  end(): Group[];
}

/**
 * A file discovered on disk and resolved against a `Series`, before it has been
 * stat-ed. Discovery yields these because walking a tree of millions of files
 * must not cost a syscall per file for a size most of them will never need —
 * the config filters throw away the majority before anything is read.
 */
export interface Candidate {
  path:      string;
  absolute:  string;
  series:    Series;
  rawSymbol: string;
  month:     string;
  interval?: string;
}

/** A candidate that survived the filters, with the size the ledger records. */
export interface RawFile extends Candidate {
  size: number;
}

/**
 * The unit of work, of rebuilding, and of the vault path: one
 * `(table, venue, market, symbol, [interval|variant|kind], month)`.
 *
 * On disk it is a directory holding exactly one Parquet file. Only closed
 * months are built, so a partition is written once and whole — nothing appends
 * to it, and nothing can change under it while it is being backed up.
 */
export interface PartitionKey {
  table:     Table;
  venue:     string;
  market:    Market;
  symbol:    string;
  month:     string;
  interval?: string;
  variant?:  string;
  kind?:     string;
}

/**
 * A partition that has been built.
 *
 * Recorded in the ledger under `@meta/` rather than beside the data, so the
 * fact survives the Parquet file being deleted to reclaim space. `inputs` is
 * what it was built from: a partition is rebuilt when one of those changes or a
 * new one appears, and **never** because one has gone missing.
 */
export interface Built {
  id:      string;
  key:     PartitionKey;
  inputs:  { path: string; size: number }[];
  rows:    number;
  builtAt: string;

  /**
   * When the collector closed the month this was built from, or null for a
   * record written before the closing time was published.
   *
   * A month can reopen — a symbol universe found to have been incomplete, a
   * dataset added — and is then closed again with a new time. Comparing it is
   * what makes a stale partition repair itself.
   */
  closedAt?: string | null;
}

export interface Summary {
  discovered: number;
  partitions: number;
  built:      number;
  skipped:    number;

  /** Complete on disk, but the collector has not called the month finished. */
  pending:    number;

  /**
   * Every input the venue published for the month decoded to nothing, so there
   * is no partition to write. Counted rather than silent: it is indistinguishable
   * from a build that did nothing, and the two want different answers.
   */
  empty:      number;

  /**
   * Partitions refused because their inputs arrived from two places, so which
   * ones are right is a question about what was collected. Never silent: a sweep
   * that refused something has not caught up, whatever the other counts say.
   */
  contested:  number;
  failed:     number;
  rows:       number;
}

export interface Config {
  /** Trucker's tree, read-only. Named for its owner, which is not stocker. */
  truckerDir:  string;

  /** Where the Parquet vault is written. */
  vaultDir:    string;

  /**
   * The `@shared`, read-only: which months a venue is complete through,
   * and where a venue has changed history it had already published. Produced
   * by trucker today, but named for the fact rather than the producer.
   */
  sharedDir:   string;

  /** Venues to process. Empty = all with a mapping. */
  venues:      readonly string[];

  /** Tables to process. Empty = all mapped. */
  tables:      readonly string[];

  /** Symbol tokens, case-insensitive substrings. Empty = all. */
  symbols:     readonly string[];

  /**
   * Inclusive month bounds, `YYYY-MM`. Null = unbounded on that side. The
   * running month is excluded regardless — see `wanted` in scan.ts.
   */
  from:        string | null;
  to:          string | null;

  /** Partitions built concurrently. */
  concurrency: number;

  /** Minutes between rescans of the raw tree. */
  scanMinutes: number;

  /** Hard caps, so a month-sized sort spills to disk rather than taking the box. */
  memoryLimit: string;
  threads:     number;

  [key: string]: unknown;
}
