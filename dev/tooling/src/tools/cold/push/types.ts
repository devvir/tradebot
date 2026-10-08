import type { DatabaseSync } from 'node:sqlite';
import type { CatalogPartition, Remote } from '../shared/types';
import type { ColdConfig } from '../types';

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

/** A partition of the catalog, as its copy names and versions it. */
export interface CatalogPartitionRow {
  id:      number;

  /** `venue|market|dataset[,variant]|grain|bundle|YYYYMM`. */
  name:    string;
  venue:   string;
  market:  string;
  dataset: string;
  variant: string;
  grain:   string;
  bundle:  string;
  month:   string;

  /** The catalog's own version of it: what changes when a file of it does. */
  version: string;
}

/** What a push of the catalog is told on the command line. */
export interface CatalogOptions {
  /** Take a new snapshot: send the whole database again, and drop the files sent since the one before. */
  rebase?: boolean;

  /**
   * What becomes of the snapshot on disk. On a run that takes one it is removed
   * once sent, unless kept; on a run that takes none, one found there is left
   * alone, unless dropped.
   */
  snapshot?: 'keep' | 'drop';

  /** Say what would be sent, and send nothing. */
  dryRun?: boolean;
}

/** What every step of a push of the catalog works with. */
export interface Sending {
  /** The record. */
  db:      DatabaseSync;
  config:  ColdConfig;

  /** The catalog's own database, open read-only. */
  catalog: DatabaseSync;
  remote:  Remote;

  /** Where files wait on disk until Mega has them. */
  staging: string;

  /** Whether the catalog's writer is running. */
  writing: () => Promise<boolean>;
}
