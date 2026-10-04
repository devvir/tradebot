import type { Hash } from 'node:crypto';

/** A canonical table. One table is one schema and one queryable dataset root. */
export type Table =
  | 'trades' | 'quotes' | 'orderBook' | 'depthBands' | 'klines'
  | 'markPrice' | 'indexPrice' | 'premiumIndex'
  | 'funding' | 'borrowing' | 'openInterest' | 'liquidations' | 'settlement';

/**
 * The catalog's markets, taken as given. Margining is not part of a market —
 * linear and inverse perpetuals are both `perp` — so it travels as a column of
 * its own (`Margin`).
 */
export type Market = 'spot' | 'perp' | 'future' | 'option' | 'tradfi';

/** Which leg a contract settles in: USD-like quote (linear) or the coin (inverse). */
export type Margin = 'linear' | 'inverse';

/** How much time one archive file covers, read off the length of its date. */
export type Grain = 'monthly' | 'daily' | 'hourly' | 'minutely';

/** How many instruments one archive file holds. */
export type Bundle = 'instrument' | 'market';

/** Which neighbouring period a venue's buckets can spill rows into. */
export type Spill = 'back' | 'forward' | 'both';

/** One column of a canonical table. */
export interface Field {
  name: string;
  type: 'BIGINT' | 'DOUBLE' | 'VARCHAR' | 'BOOLEAN';
}

/** One object of a catalog listing page, as the catalog answers it in JSON. */
export interface ListedObject {
  Key:   string;
  ETag?: string;
  Size?: number;
}

/** One page of the catalog's bucket. */
export interface BucketPage {
  Contents?:   ListedObject[];
  IsTruncated: boolean;
  NextMarker?: string;
}

/** One column of a headerless file, in published order. */
export interface Column {
  /** Canonical name, or null for a column that exists and is dropped. */
  as: string | null;
}

/**
 * How to read one format of one dataset, and what it becomes.
 *
 * Keyed by the catalog's attributes — venue, market, dataset, variant — and
 * never by where a file came from. Where one dataset holds more than one format,
 * `margin` and `from`/`until` say which files each entry reads.
 */
export interface Series {
  venue:    string;
  market:   Market;

  /** The catalog's dataset name (`trades`, `klines`, `funding`, …). */
  dataset:  string;

  /**
   * The catalog's variant: an exact value (`default`, `realised`), `*` for any
   * (a kline's interval), or absent where the dataset has none.
   */
  variant?: string;

  /** The canonical table the rows become. */
  table:    Table;

  /** Only the files of instruments with this margining. */
  margin?:  Margin;

  /** First month (`YYYY-MM`, inclusive) this format holds for. */
  from?:    string;

  /** First month (`YYYY-MM`) it no longer holds for. */
  until?:   string;

  /** How rows are read once the container is undone: `csv` or `xlsx`. */
  format:   string;

  /**
   * Whether the file carries a header row that can be trusted for its whole
   * history. When it does, columns are mapped by name; when it does not,
   * `columns` names every column in published order.
   */
  header:   boolean;
  columns?: Column[];

  /** Canonical field → expression over the source relation. Absent fields are NULL. */
  project:  Record<string, string>;

  /** Source column holding the event time. Its unit is inferred from the value. */
  ts:       string;

  /**
   * The zone a text timestamp is written in, in whole hours east of UTC — for a
   * venue that writes local datetimes. Absent means UTC (and is irrelevant to an
   * epoch, which has no zone).
   */
  utcOffsetHours?: number;

  /**
   * The column naming each row's instrument, where a file can hold more than one
   * — a market bundle, or a futures chain. Rows are split by it, one vault file
   * per instrument. Absent means the file is the catalog symbol's alone.
   */
  instrument?: string;

  /** Where a bucket's rows fall relative to the period its name denotes. */
  spill?:   Spill;

  /**
   * Whether the venue's files can repeat whole rows, byte for byte — and so
   * whether exact repeats are dropped. Only exact ones: two rows differing in
   * any column are both kept.
   */
  repeatsRows?: boolean;
}

/** One file of the catalog's bucket, read off its key. */
export interface ArchiveFile {
  key:      string;
  venue:    string;
  market:   Market;
  dataset:  string;

  /** Everything after the dataset's comma, or '' where it has none. */
  variant:  string;
  bundle:   Bundle;

  /** The venue's own name for the instrument, or `@` for a market bundle. */
  symbol:   string;

  /** `YYYY-MM`. */
  month:    string;

  /** The period, as the name writes it: 6, 8, 10 or 12 digits. */
  date:     string;
  grain:    Grain;
  part:     string | null;

  /** `zip`, `gzip`, `tar.gz`, `plain`. */
  container: string;
}

/** A partition's stats while its listing is still being read. */
export interface Building {
  key:     PartitionKey;
  id:      string;
  files:   number;
  bytes:   number | null;
  digest:  Hash;
  pending: number;
  first:   BuildingEdge;
  last:    BuildingEdge;
}

export interface BuildingEdge {
  files:   number;
  bytes:   number | null;
  digest:  Hash;
  pending: number;
}

/** What identifies a partition: everything but the files. */
export interface PartitionKey {
  venue:   string;
  market:  Market;
  dataset: string;
  variant: string;
  bundle:  Bundle;
  grain:   Grain;
  month:   string;
}

/** What the catalog says about one partition's files, gathered from a listing. */
export interface PartitionStats {
  files:   number;

  /** Total size, or null where the catalog lacks a size for any file. */
  bytes:   number | null;

  /** Digest of every key, ETag and size, in listing order. */
  digest:  string;

  /** Files not yet downloaded. */
  pending: number;

  /** The files of the month's first and last period, for a neighbour that spills into it. */
  first:   EdgeStats;
  last:    EdgeStats;
}

export interface EdgeStats {
  files:   number;
  bytes:   number | null;
  digest:  string;
  pending: number;
}

/** A partition and what the catalog says about it. */
export interface Partition {
  key:   PartitionKey;
  id:    string;
  stats: PartitionStats;
}

/** Where a partition lands in the vault: everything but the symbol. */
export interface VaultKey {
  table:     Table;
  venue:     string;
  market:    Market;
  interval?: string;
  kind?:     string;
  month:     string;
}

/** A file of the archives on disk, belonging to a partition. */
export interface DiskFile {
  absolute: string;
  file:     ArchiveFile;
  size:     number;
  mtimeMs:  number;
}

/** A partition of the vault and every rendering of the archives that lands in it. */
export interface Target {
  key:        VaultKey;
  series:     Series[];
  candidates: Partition[];
}

/** One catalog symbol's files for a partition, with whatever a neighbour donates. */
export interface Group {
  symbol: string;
  inputs: DiskFile[];
}

/** What one connection builds at a time: one big instrument, or a batch of small ones. */
export type Task = Group[];

/** A neighbouring month's edge a spilling partition reads. */
export interface Edge {
  partition: Partition;
  side:      'first' | 'last';
  digest:    string;
}

/** One sweep's outcome. */
export interface Summary {
  /** Partitions inside the configured scope. */
  considered: number;

  /** Already in the vault at their current version. */
  current:    number;

  /** Stocked this sweep. */
  built:      number;

  /** Stocked, and every input decoded to nothing. */
  empty:      number;

  /** Not yet fully downloaded, per the catalog. */
  waiting:    number;

  /** Downloaded per the catalog, but not on disk as it says. */
  missing:    number;

  /** A dataset or format stocker cannot read. */
  unmapped:   number;

  failed:     number;
  rows:       number;
  files:      number;

  /** The sweep stopped because the vault volume ran low. */
  stopped:    boolean;
}

export interface Config {
  /** The archives, read-only: hauler's tree of canonical keys. */
  archivesDir:  string;

  /** Where the Parquet vault is written. */
  vaultDir:     string;

  catalogApi:   string;
  catalogToken: string;

  /** The lens the catalog is read through, or '' for the whole catalog. */
  lens:         string;

  /** Venues to process. Empty = all with a mapping. */
  venues:       readonly string[];

  /** Tables to process. Empty = all mapped. */
  tables:       readonly string[];

  /** Symbol tokens, case-insensitive substrings. Empty = all. */
  symbols:      readonly string[];

  /** Inclusive month bounds, `YYYY-MM`, or null for none. */
  startMonth:   string | null;
  endMonth:     string | null;

  /** Builds run at once, one DuckDB connection each. */
  concurrency:  number;

  /** Minutes between sweeps. */
  scanMinutes:  number;

  /** Cores a build may use, so it cannot take every one on the box. */
  threads:      number;

  /** Free space below which no partition is started, in GB. */
  minFreeGb:    number;

  [key: string]: unknown;
}
