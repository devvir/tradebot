/** A canonical table. One table is one schema and one queryable dataset root. */
export type Table =
  | 'trades' | 'quotes' | 'orderBook' | 'orderBookSnapshot' | 'orderBookBands' | 'klines'
  | 'markPrice' | 'indexPrice' | 'premiumIndex' | 'volatilityIndex'
  | 'optionMarkPrice' | 'optionTicker'
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
  type: 'BIGINT' | 'DOUBLE' | 'VARCHAR' | 'BOOLEAN' | 'DOUBLE[][]';
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

  /**
   * How rows are read once the container is undone: a table (`csv` or `xlsx` —
   * which of the two is read off each file), `ndjson`, `lines` or `words`.
   */
  format:   string;

  /**
   * Whether the file carries a header row that can be trusted for its whole
   * history. When it does, columns are mapped by name; when it does not,
   * `columns` names every column in published order.
   */
  header:   boolean;
  columns?: Column[];

  /**
   * The fields read from each record and their types, where the format reads
   * records that name their own fields (`ndjson`) and their types must not be
   * left to sampling.
   */
  fields?:  Record<string, string>;

  /**
   * A query that turns what the format reads into the rows the projection
   * reads, where a record is not yet a row — a book message holds a list of
   * levels a side, and a row is one level. `{src}` stands for the format's
   * relation. It keeps every column it does not consume, since the build
   * carries some of its own through.
   */
  rows?:    string;

  /** Canonical field → expression over the source relation. Absent fields are NULL. */
  project:  Record<string, string>;

  /** Source column holding the event time. Its unit is inferred from the value. */
  ts:       string;

  /**
   * The stocker version in which what this entry writes last changed. Absent
   * where it never has. Part of the revision of every partition it reads —
   * see `versions.ts`.
   */
  version?: string;

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

  /** Which of a dataset's kinds: funding `realised` or `predicted`, a book `incremental`, `snapshot` or `bands`. */
  kind?:     string;

  /** Order books only: how far the book goes — levels a side (`400`, `full`), or the widest band (`5pct`). */
  depth?:    string;

  /** Trades only: `false` for every trade as it happened, `true` for a venue's aggregation of them. */
  aggregated?: string;
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

  /**
   * Where these are only some of the symbol's files — it is built a piece at a
   * time: which symbol's pieces these belong to, and which of them this is.
   */
  piece?: { of: number; at: number };
}

/** What extracting some archives needs and what the vault's volume has free, in bytes, where the first does not fit. */
export interface Short {
  needs: number;
  free:  number;
}

/** What one connection builds at a time: one big instrument, or a batch of small ones. */
export type Task = Group[];

/** One task's archives, as extraction ahead of the builds keeps track of them. */
export interface PrepareSlot {
  inputs:   import('./containers').Wrapped[];

  /** The shapes its small files may be gathered under — see `Packer`. */
  shapes:   import('./containers').Pack[];

  /** Whether anything of it has to be extracted; a task read natively costs nothing to prepare. */
  extracts: boolean;

  /** What its archives weigh on disk. */
  weight:   number;

  /** What it is expected to write to scratch, before it has. */
  estimate: number;

  /** Whether there was no room to extract it ahead: it is extracted when its build asks, if there is room then. */
  waits:    boolean;

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
  edges:     Edge[];

  /** The sides a neighbouring month holds of it that are not there to be read. */
  missing:   Side[];

  tasks:     Task[];

  /** What each task builds: the month's own rows, or what a neighbour holds of it. */
  passes:    Pass[];

  files:     number;
  prefetch:  import('./prepare').Prefetch;

  /**
   * Where the month is already in the vault with a side missing, and this is
   * that side arriving: the revision it is stocked at, and the sides that
   * arrive. Only they are built; the month's own rows are not read again.
   */
  completes: { revision: string; sides: Side[] } | null;
}

/** What a build writes: a month's own rows, or one side of what its neighbours hold of it. */
export type Pass = 'own' | Side;

/**
 * Which end of a month a neighbouring month holds: `pre` its first hours, in a
 * file of the month before, `post` its last, in a file of the month after.
 */
export type Side = 'pre' | 'post';

/** A neighbouring month a spilling partition reads the edge of. */
export interface Edge {
  partition: Partition;

  /** Which of the neighbour's files are read: those of its first period, or of its last. */
  side:      'first' | 'last';

  /** Which end of this month they hold. */
  end:       Side;
}

/** What the vault holds of one slice, read once: for each month, how it is stored. */
export type SliceIndex = Map<string, Stocked>;

/** One month of a slice in the vault. */
export interface Stocked {
  /** Whether it is one file for every instrument. */
  bundle:     boolean;

  /** The instruments it has a file for, where it is one file per instrument. */
  symbols:    string[];

  /** The files of what neighbouring months held of it, each by where it sits and which side it is. */
  sides:      { symbol: string; side: Side }[];
}

/** The instrument directories of each dataset in the archives, read once. */
export interface InstrumentDirs {
  of: (root: string) => Promise<string[]>;
}

/** One line of the vault's ledger: a partition stocked, what from, and what it weighed. */
export interface Entry {
  /** The vault partition: its slice's directory below the vault, then its month as `YYYYMM`. */
  partition:   string;

  /** The partition of the archives it was stocked from, as the catalog names it — its month as `YYYYMM`. */
  venue:       string;
  market:      string;
  dataset:     string;
  variant:     string;
  grain:       string;
  bundle:      string;
  month:       string;

  /** How it is stored: one file for every instrument, or a file per instrument. */
  mode:        'bundle' | 'split';

  /** The catalog's version of what it was stocked from, and of a neighbouring month it read the edge of. */
  version:     string;
  preVersion:  string;
  postVersion: string;

  revision:    string;

  /** What its files weigh, and how many there are. */
  size:        number;
  count:       number;

  stockedAt:   string;

  /**
   * Whether the ledger says its files are no longer what would be stocked from
   * the same archives today. Read off the ledger's last line for it, never
   * written as a column.
   */
  outdated?:   boolean;
}

/** What one sweep carries from partition to partition. */
export interface Sweeping {
  instruments:   InstrumentDirs;

  /** The vault's ledger as the sweep found it, added to as partitions are stocked. */
  ledger:        Map<string, Entry>;

  /** What the vault holds of each slice, read once. */
  slices:        { of: (key: VaultKey) => Promise<SliceIndex>; forget: (key: VaultKey) => void };

  /** The partitions that have a safe copy elsewhere, by revision — read the first time a sweep asks. */
  backedUp?:     Map<string, Set<string>>;
}

/** One sweep's outcome. */
/**
 * Where a partition's time went, in milliseconds: waiting for its archives to
 * be extracted, looking at what was extracted, the engine reading it, the
 * engine writing it, the join into one file, waiting for the vault, and putting
 * it in place.
 */
export interface Spent {
  extract: number;
  inspect: number;
  read:    number;
  write:   number;
  join:    number;
  queued:  number;
  place:   number;
}

export interface Summary {
  /** Vault partitions the catalog had something ready for, inside the configured scope. */
  considered: number;

  /** Already in the vault at their current revision. */
  current:    number;

  /** In the vault at a revision that is no longer theirs, and not stocked again this sweep. */
  outdated:   number;

  /** Stocked this sweep. */
  built:      number;

  /** Stocked, and every input decoded to nothing. */
  empty:      number;

  /** In the catalog's answer with no file to stock from. */
  waiting:    number;

  /** Stocked, or already in the vault, without the hours a neighbouring month holds of them. */
  partial:    number;

  /** Stocked partial before, and given the hours a neighbouring month held of them. */
  completed:  number;

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

  /** Builds run at once, one DuckDB connection each. */
  concurrency:  number;

  /** Cores a build may use, so it cannot take every one on the box. */
  threads:      number;

  /** Free space below which no partition is started, in GB. */
  minFreeGb:    number;

  /** Memory the engine may use before it spills to disk, in GB. */
  memoryGb:     number;

  [key: string]: unknown;
}
