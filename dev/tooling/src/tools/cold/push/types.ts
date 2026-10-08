import type { CatalogPartition, QueueState } from '../shared/types';

/** What storing the vault asks of Mega: the part of it a run can be given a stand-in for. */
export interface Remote {
  queuedPaths: () => Promise<Set<string>>;
  queue:       () => Promise<QueueState>;
  listing:     (root: string) => Promise<Map<string, { bytes: number; handle: string | null }>>;
  queueUpload: (local: string, remoteDir: string) => Promise<void>;
  remove:      (remotePath: string) => Promise<void>;
}

/** What a look at the vault's ledger found still to store, venue by venue. */
export interface VaultPlan {
  venues:  Map<string, { partitions: number; files: number; bytes: number }>;

  /** Partitions the vault does not hold as its ledger says: left out. */
  skipped: number;
}

/** A group of partitions that will travel in one tar. */
export interface Bin {
  partitions: CatalogPartition[];
  bytes:      number;
}

/** What a push was asked to narrow itself to. */
export interface PushOptions {
  venues: string[];

  /** A lens's slug, or `true` to be asked which. Absent reads the whole catalog. */
  lens?:  string | true;
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
