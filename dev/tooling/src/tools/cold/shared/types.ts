
/** How much time one archive file covers. */
export type Grain = 'monthly' | 'daily' | 'hourly' | 'minutely';

/** How many instruments one archive file holds. */
export type Bundle = 'instrument' | 'market';

/** What identifies a partition. `month` is `YYYYMM`; `variant` is `''` where the dataset has none. */
export interface PartitionKey {
  venue:   string;
  market:  string;
  dataset: string;
  variant: string;
  grain:   Grain;
  bundle:  Bundle;
  month:   string;
}

/** A partition as the catalog answers it: what it holds, and the version that says so. */
export interface CatalogPartition extends PartitionKey {
  files:   number;
  bytes:   number;

  /** Changes whenever a file of the partition is added, withdrawn or changed. */
  version: string;
}

/** One line of the vault's ledger, as far as cold reads it: a vault partition, and what it was stocked from. */
export interface Stocked {
  /** The vault partition: its slice's directory below the vault, then its month. */
  partition:   string;

  /** The partition of the archives it was stocked from. */
  source:      PartitionKey;

  /** The catalog's version of that partition when it was stocked, and of a neighbouring month it read the edge of. */
  version:     string;
  preVersion:  string;
  postVersion: string;

  revision:    string;

  /** How it is stored: one file for every instrument, or a file per instrument. */
  mode:        'bundle' | 'split';

  /** What its files weigh, and how many there are. */
  size:        number;
  count:       number;
}

/**
 * One file of the vault: a partition stored whole, or one instrument of a
 * partition stored per instrument. The unit that is moved out of the vault and
 * brought back — where a partition is the unit that is stored.
 */
export interface VaultFile {
  partition:  string;
  revision:   string;

  /** The instrument the file is of; `@` for the one file of a partition stored whole. */
  instrument: string;

  /**
   * Which rows of the month it holds: its own (`''`), or the hours a neighbouring
   * month's files held of it — `pre` the first, `post` the last.
   */
  side:       '' | 'pre' | 'post';

  /** Below the vault. */
  path:       string;
  bytes:      number;
}

/** A vault file as the record holds it: on its way to cold storage, or in it. */
export interface StoredFile extends VaultFile {
  state:     'planned' | 'queued' | 'stored';
  handle:    string | null;

  /** When it was taken off the local disk, where it has been and is not back. */
  evictedAt: string | null;
}

/**
 * What the vault waits for that cold storage holds: files without which a
 * partition cannot be finished with.
 */
export interface Needed {
  /** Vault partitions that wait, however many files each waits for. */
  partitions: number;

  /** Partitions of the archives to stock an outdated partition again from, that are not on disk as the catalog has them. */
  archives:   import('../pull/types').Pullable[];

  /** Vault files a neighbouring month's hours are added beside, that have been taken off the disk. */
  vault:      StoredFile[];

  /** Partitions of the archives that are needed and are not in cold storage at the catalog's version: not this tool's to bring. */
  unstored:   string[];
}

export interface VaultOptions {
  /** Say what would be done, and do nothing. */
  dryRun?: boolean;

  /** Delete outright, where the default is the host's trash. */
  purge?:  boolean;
}

/** One slice of a venue with its partitions, as the catalog's endpoint answers it. */
export interface ListedSlice {
  market:     string;
  dataset:    string;
  variant:    string;
  grain:      Grain;
  bundle:     Bundle;
  partitions: { month: string; files: number; bytes: number; version: string }[];
}

/** A lens as the catalog lists it. */
export interface ListedLens {
  slug: string;
  name: string;
  note: string;
}

/** A partition inside a tar, at the version it was packed at. */
export interface Held extends PartitionKey {
  tarId:   number;
  version: string;
  files:   number;
  bytes:   number;

  /** What the catalog says now, where that is no longer what the tar holds. */
  next:    { version: string; files: number; bytes: number } | null;
}

/** A file of the tree being backed up, relative to its root. */
export interface SourceFile {
  path:  string;
  bytes: number;
}

/** What Mega's upload queue still has to send. */
export interface QueueState {
  /** Bytes remaining — the queue's total minus what has gone. */
  remaining: number;
  total:     number;
  uploaded:  number;
  transfers: number;
}

/** Which of Mega's two queues: what is on its way there, or on its way back. */
export type Queue = 'uploads' | 'downloads';

/** One file in a queue of Mega's: where it is on disk, how far it has come, and whether it is the one moving. */
export interface Transfer {
  /** Where it is read from, for an upload; where it is written to, for a download. */
  path:    string;
  percent: number;
  bytes:   number;
  active:  boolean;
}

/** One line of the progress block: something under way, and how far along it is. */
export interface Bar {
  label: string;
  done:  number;
  total: number;

  /** What `done` and `total` count: bytes, or things — named by `of` (`files`, `partitions`). */
  unit:  'bytes' | 'count';
  of?:   string;

  /** Said after the label in place of the bar: something under way that cannot be measured. */
  note?: string;

  /** What the line opens with; a small square where nothing is said. */
  mark?: string;

  /** Written faint, bar and all: a line that says nothing is happening. */
  quiet?: boolean;

  /** Where in the block: a line of a lower rank is above one of a higher. Lines of one rank stay in the order they came. */
  rank?:  number;
}

/** What following a queue of Mega's is told — see `progress-mega.ts`. */
export interface Following {
  /** The line of the block it keeps. */
  id:     string;
  queue:  Queue;

  /** Which transfers are meant, by their path on disk; every one where nothing is said. */
  mine?:  (path: string) => boolean;

  /**
   * What all of them come to. Given, the line is of all of them together;
   * left out, it is of the one Mega is moving right now.
   */
  total?: { files: number; bytes: number };

  /** With `total`: what is counted. Bytes where nothing is said. */
  count?: 'bytes' | 'files';

  /** What the line is called: one name, or one made from the transfer being moved. */
  label:  string | ((transfer: Transfer) => string);

  /** What the line says while nothing of it is moving; no line where nothing is said. */
  idle?:  string;
  mark?:  string;
  rank?:  number;

  /** How the queue is read; Mega's own where nothing is said. */
  read?:  (queue: Queue) => Promise<Transfer[]>;
}

/** What the record holds of one origin, added up. */
export interface Totals {
  tars:       number;
  stored:     number;
  partitions: number;
  bytes:      number;
  storedBytes: number;
}

/** A `held` row as the record reads it back, before what comes next is folded into one field. */
export interface HeldRow extends Omit<Held, 'next'> {
  nextVersion: string | null;
  nextFiles:   number | null;
  nextBytes:   number | null;
}

/** What storing the vault asks of Mega: the part of it a run can be given a stand-in for. */
export interface Remote {
  queuedPaths: () => Promise<Set<string>>;
  queue:       () => Promise<QueueState>;
  listing:     (root: string) => Promise<Map<string, { bytes: number; handle: string | null }>>;
  queueUpload: (local: string, remoteDir: string) => Promise<void>;
  remove:      (remotePath: string) => Promise<void>;

  /** Take second transfers of the same file out of the queue, below these directories. Not every stand-in has one. */
  dropDuplicateUploads?: (under: readonly string[]) => Promise<number>;

  /** Hand several files over for one remote directory at once. */
  queueUploads?: (locals: readonly string[], remoteDir: string) => Promise<void>;

  /** Whether Mega answers at all. */
  available?:    () => Promise<boolean>;

  /** Remove a directory and everything in it. */
  removeTree?:   (remotePath: string) => Promise<void>;
}

/** One of the files cold storage cannot be read without, as it was last sent to Mega. */
export interface Sent {
  /** A digest of what was sent. */
  digest: string;
  bytes:  number;
  at:     string;
}

/** A file kept beside what it describes: what it is called, where it is, and where its copy goes in Mega. */
export interface Kept {
  name:   string;

  /** A consistent copy of it as it is now, written to this path — or false where there is nothing to copy. */
  copy:   (to: string) => boolean;

  /** Below `backupRoot`. */
  remote: string;

  /** How much smaller than its copy it may be without that being a loss, as a share of the copy. Nothing, unless said. */
  shrink?: number;
}

/** What bringing vault files back asks of Mega. */
export interface Fetching {
  downloadingPaths: () => Promise<Set<string>>;
  queueDownload:    (remotePath: string, localDir: string) => Promise<void>;

  /** What is in a queue of Mega's, for a line of progress. Not every stand-in has one. */
  transfers?: (queue: Queue) => Promise<Transfer[]>;
}

/** One file of the catalog's copy in cold storage, as the record holds it. */
export interface CatalogCopy {
  /** The partition it holds the files of, or the database's own name for the base. */
  name:     string;
  kind:     'base' | 'partition';

  /** Below the catalog's place in Mega; empty where it is as the base has it, and has no file of its own. */
  remote:   string;

  /** The catalog's version of the partition, or what the base weighed and when it was last written. */
  version:  string;
  bytes:    number;
  state:    'queued' | 'stored';
  handle:   string | null;
  storedAt: string | null;

  /** The base: how the catalog's table of files was declared as it was taken. Null for anything else. */
  schema:   string | null;
}

/** What a pull of the catalog is told on the command line. */
export interface CatalogPull {
  /** Where the database is left: a directory, or the file itself. Cold's own directory where nothing is said. */
  output?: string;

  /** Say what would be brought back and where to, and bring nothing. */
  dryRun?: boolean;

  /** What becomes of the snapshot on disk afterwards. As it was before the run where nothing is said: there if it was. */
  snapshot?: 'keep' | 'drop';
}
