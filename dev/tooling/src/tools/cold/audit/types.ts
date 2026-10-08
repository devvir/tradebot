import type { DatabaseSync } from 'node:sqlite';
import type { Archives } from '../shared/disk';
import type { Remote } from '../shared/types';
import type { ColdConfig, Origin } from '../types';

/** What a check is given to look at. */
export interface Looking {
  db:       DatabaseSync;
  config:   ColdConfig;
  origin:   Origin;

  /** Mega, or null where it is not answering: what needs it is then not checked. */
  remote:   Remote | null;
  archives: Archives;
}

/** One thing that can be done about a finding. */
export interface Solution {
  label:        string;

  /** Whether it removes something that is not written down anywhere else. Never the answer nobody gave. */
  destructive?: boolean;
  apply:        () => Promise<void> | void;
}

/**
 * One kind of thing found wrong, however many times it was found: what it is,
 * a few of the places, and what can be done about all of them at once.
 *
 * The first solution is the one taken where nobody is asked, unless it is
 * destructive — then nothing is done.
 */
export interface Finding {
  problem:   string;
  examples:  string[];

  /** What a person should know before choosing. */
  note?:     string;
  solutions: Solution[];
}

/** Something that looks for one family of problems. */
export type Check = (looking: Looking) => Promise<Finding[]>;

/** What an audit is told on the command line. */
export interface AuditOptions {
  /** Say what was found, and do nothing about it. */
  dryRun?: boolean;
}
