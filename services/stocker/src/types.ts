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

/** One month of a slice, as the catalog's partitions endpoint answers it. */
export interface ListedPartition {
  month:        string;
  files:        number;
  bytes:        number;
  pending:      number;
  pendingBytes: number;
  withdrawn:    number;
  version:      string;
  updatedAt:    string;
}

/** One slice of a venue with its partitions, as the catalog answers it. */
export interface ListedSlice {
  market:     Market;
  dataset:    string;
  variant:    string;
  grain:      Grain;
  bundle:     Bundle;
  partitions: ListedPartition[];
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

/** A partition and what the catalog says it holds. */
export interface Partition {
  key:       PartitionKey;
  id:        string;

  /** Files the venue serves of it, and their total size. */
  files:     number;
  bytes:     number;

  /** Of those, the files not yet downloaded. */
  pending:   number;

  /** The catalog's version of it: it changes whenever a file of it does. */
  version:   string;

  /** When that version last changed. */
  updatedAt: string;
}

/** Where a partition lands in the vault: its slice there, and its month. */
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

/** One task's archives, as extraction ahead of the builds keeps track of them. */
export interface PrepareSlot {
  inputs:   { absolute: string; container: string }[];

  /** Whether anything of it has to be extracted; a task read natively costs nothing to prepare. */
  extracts: boolean;

  /** What it is expected to write to scratch, before it has. */
  estimate: number;

  /** What it is counted as holding of scratch right now. */
  charged:  number;

  /** Whether it is being extracted on a thread of the pool. */
  flying:   boolean;

  promise:  Promise<import('./containers').UnpackedAll> | null;

  /** Whether a build has asked for it, or it has been given up. */
  taken:    boolean;
}

/** A partition decided on and about to be stocked: what it is built from, and its extraction under way. */
export interface Job {
  key:       VaultKey;
  partition: Partition;
  revision:  string;
  held:      Map<string, Stocked>;
  tasks:     Task[];
  files:     number;
  prefetch:  import('./prepare').Prefetch;
}

/** A neighbouring month a spilling partition reads the edge of. */
export interface Edge {
  partition: Partition;
  side:      'first' | 'last';
}

/**
 * What the vault holds of one slice, read once: for each month, the revisions
 * present and how each is stored.
 */
export type SliceIndex = Map<string, Map<string, Stocked>>;

/** One revision of one month in the vault. */
export interface Stocked {
  /** Whether it is one file for every instrument. */
  bundle:     boolean;

  /** The instruments it has a file for, where it is one file per instrument. */
  symbols:    string[];

  /** Whether it was still being put in place when something stopped it. */
  publishing: boolean;
}

/** The instrument directories of each dataset in the archives, read once. */
export interface InstrumentDirs {
  of: (root: string) => Promise<string[]>;
}

/** What one sweep carries from partition to partition. */
export interface Sweeping {
  instruments:   InstrumentDirs;

  /** What the vault holds of each slice, read once. */
  slices:        { of: (key: VaultKey) => Promise<SliceIndex>; forget: (key: VaultKey) => void };
}

/** One sweep's outcome. */
export interface Summary {
  /** Vault partitions the catalog had something ready for, inside the configured scope. */
  considered: number;

  /** Already in the vault at their current revision. */
  current:    number;

  /** Stocked this sweep. */
  built:      number;

  /** Stocked, and every input decoded to nothing. */
  empty:      number;

  /** Ready themselves, but reading the edge of a neighbouring month that is not. */
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

  /** Memory the engine may use before it spills to disk, in GB. */
  memoryGb:     number;

  /** A partition whose archive files weigh more than this is stored one file per instrument, in GB. */
  splitGb:      number;

  /**
   * Hours a settled partition must also have gone unchanged in the catalog
   * before it is stocked; `null` asks for settled alone.
   */
  coolHours:    number | null;

  /** Threads that extract archives beside the builds; zero extracts on the main thread. */
  unpackWorkers: number;

  [key: string]: unknown;
}
