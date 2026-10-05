/**
 * Everything `tools cold` names, in one place.
 *
 * Cold storage keeps **partitions**: one month of one slice of a venue's data,
 * as the catalog counts it. Partitions travel in tars, a venue-month at a time,
 * and the record says which partitions each tar holds and at which version.
 */

/** A tree that is backed up, named for the tree rather than for what fills it. */
export type Origin = 'archives' | 'vault';

/** How much time one archive file covers. */
export type Grain = 'monthly' | 'daily' | 'hourly' | 'minutely';

/** How many instruments one archive file holds. */
export type Bundle = 'instrument' | 'market';

/** What one run of a command works from. */
export interface ColdConfig {
  /** The tree being backed up. */
  sourceRoot:    string;

  /** Cold's own directory: staging tars, locks and the record. */
  coldRoot:      string;

  /** Where the origin's tars live in Mega. */
  megaRoot:      string;
  dbPath:        string;

  /** What a tar is filled to before another is started. */
  capBytes:      number;

  /** GB still queued for upload before packing pauses. */
  queueTargetGb: number;

  /**
   * Hours a settled partition must also have gone unchanged in the catalog
   * before it is stored; `null` asks for settled alone.
   */
  settledHours:  number | null;

  catalogUrl:    string;
  catalogToken:  string;
}

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

/**
 * Where a tar is on its way into cold storage.
 *
 * `planned` — the record says what it will hold, and no tar exists.
 * `packed`  — the tar is on disk, proved against the files it was made from.
 * `queued`  — handed to Mega, which has not confirmed it yet.
 * `stored`  — Mega holds it, at the size and under the handle recorded.
 *
 * And for a stored tar holding a partition that has since changed:
 *
 * `stale`    — it has to be brought back, corrected and stored again.
 * `fetching` — Mega is bringing it back.
 * `fetched`  — it is on disk again, waiting to be corrected.
 *
 * A corrected tar is `packed` again and goes the ordinary way from there.
 */
export type TarState = 'planned' | 'packed' | 'queued' | 'stored' | 'stale' | 'fetching' | 'fetched';

/** One tar, as the record holds it. */
export interface Tar {
  id:       number;
  origin:   Origin;
  venue:    string;

  /** `YYYYMM`. */
  month:    string;
  seq:      number;

  /** Below the origin's root in Mega: `bybit/2020/bybit-202003.001.tar`. */
  remote:   string;

  /** Below the origin's staging directory: `bybit/bybit-202003.001.tar`. */
  local:    string;

  /** The tar's size, known once it is packed. */
  bytes:    number | null;
  state:    TarState;

  /** Mega's own identifier for the stored object. */
  handle:   string | null;
  storedAt: string | null;
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

/** A group of partitions that will travel in one tar. */
export interface Bin {
  partitions: CatalogPartition[];
  bytes:      number;
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

/** What a push was asked to narrow itself to. */
export interface PushOptions {
  venues: string[];

  /** A lens's slug, or `true` to be asked which. Absent reads the whole catalog. */
  lens?:  string | true;

  /** Keep running once everything is pushed, and ask the catalog again at intervals. */
  watch?: boolean;
}

/** What one planning pass found. */
export interface Planned {
  /** Tars newly planned. */
  tars:      number;

  /** Partitions they will hold. */
  added:     number;

  /** Partitions already stored whose version has since changed. */
  changed:   number;

  /** Stored tars that have to be brought back and corrected for them. */
  stale:     number;
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

/** What Mega says for the length of one round over the tars, asked once. */
export interface Round {
  /** Whether the upload queue has room for another tar to be made. */
  room:      () => Promise<boolean>;

  /** A tar was made this round: the queue is asked again before another is. */
  packed:    () => void;

  /** The local paths Mega is sending, and those it is bringing back. */
  uploads:   () => Promise<Set<string>>;
  downloads: () => Promise<Set<string>>;
}
