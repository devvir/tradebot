import type { Bundle, Held } from '../shared/types';

/** What bringing vault files back asks of Mega. */
export interface Fetching {
  downloadingPaths: () => Promise<Set<string>>;
  queueDownload:    (remotePath: string, localDir: string) => Promise<void>;
}

/** What narrows a pull, as the catalog names things: a market, a dataset and its variant, and months. */
export interface PullFilter {
  market?:  string;
  dataset?: string;
  variant?: string;

  /** Months, `YYYYMM`, both ends included. */
  from?:    string;
  to?:      string;
}

/**
 * Which rendering of the same data a pull takes, where cold storage holds more
 * than one: a month published monthly and daily, or as one file for a market
 * and a file per instrument. Each is a preference and not a filter — where the
 * one preferred is not stored, what is stored is taken.
 */
export interface Preference {
  grain?:  'monthly' | 'daily';
  bundle?: Bundle;
}

/** What a pull is told on the command line. */
export interface PullOptions {
  venues:  string[];
  filter:  PullFilter;

  /** Archives only. */
  prefer?: Preference;

  /** Pull what is on disk already too, over what is there, without asking. */
  force?:  boolean;

  /** Say what would be done, and do nothing. */
  dryRun?: boolean;
}

/**
 * How a stored partition of the archives stands against the disk and the catalog:
 *
 * - `old`     — cold storage holds a version the catalog has moved on from
 * - `away`    — nothing of it is on disk
 * - `same`    — on disk, at the count and the size that was stored
 * - `differs` — on disk, at another count or size
 */
export type PullState = 'old' | 'away' | 'same' | 'differs';

/** A stored partition a pull means, and how it stands. */
export interface Pullable {
  held:  Held;
  state: PullState;
}
