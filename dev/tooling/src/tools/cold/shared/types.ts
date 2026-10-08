
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

/** The one upload Mega is working on, since it sends them one at a time. */
export interface ActiveTransfer {
  name:    string;
  percent: number;
  bytes:   number;
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
