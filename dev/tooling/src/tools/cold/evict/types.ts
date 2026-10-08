import type { CatalogPartition } from '../shared/types';
import type { ColdConfig, Origin } from '../types';

/** Why a partition of the archives stays on disk. */
export type HeldBack = 'not in cold storage' | 'not stocked' | 'a neighbouring month still needs it';

/** What a look at one venue's archives came to. */
export interface Evictable {
  venue:     string;

  /** Partitions that can go, each as the catalog counts it. */
  ready:     CatalogPartition[];

  /** Settled partitions that stay, by why. */
  held:      Record<HeldBack, number>;

  /** Partitions that could go and already have, at the version they have now. */
  gone:      number;

  /** Of `ready`, the ones that went already and have files on disk again. */
  returned:  number;
}

/** What one run of `evict` carries from one look to the next. */
export interface Run {
  config:   ColdConfig;
  origin:   Origin;
  venues:   readonly string[];
  archives: import('../shared/disk').Archives;
  options:  EvictOptions;

  /** Whether removing was agreed to: asked before the first removal of a run, and not again. */
  agreed:   boolean;

  /** Whether a watching run has said that it is waiting, since it last had something to do. */
  waiting:  boolean;
}

export interface EvictOptions {
  venues:  string[];

  /** Say what would go, and remove nothing. */
  dryRun?: boolean;

  /** Delete outright, where the default is the host's trash. */
  purge?:  boolean;

  /** Look on disk for files of partitions already evicted, and remove those too. */
  cleanup?: boolean;
}
