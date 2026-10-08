
/**
 * Everything `tools cold` names, in one place.
 *
 * Cold storage keeps **partitions**: one month of one slice of a venue's data,
 * as the catalog counts it. Partitions travel in tars, a venue-month at a time,
 * and the record says which partitions each tar holds and at which version.
 */

/** A tree that is backed up, named for the tree rather than for what fills it. */
export type Origin = 'archives' | 'vault';

/** What one run of a command works from. */
export interface ColdConfig {
  /** The tree being backed up. */
  sourceRoot:    string;

  /** The vault, whichever tree is being worked on: its ledger says what is stocked. */
  vaultRoot:     string;

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

/**
 * Which of the vault is meant, for moving it out and for bringing it back.
 * Every field narrows; one left out means any.
 */
export interface Selection {
  venues:      string[];
  market?:     string;
  dataset?:    string;

  /** A dataset's flavour as the vault's path names it: a kline's interval, funding's kind. */
  variant?:    string;

  /** Months, `YYYYMM`, both ends included. */
  from?:       string;
  to?:         string;

  /** Instruments, by name. Empty means all of them. */
  instruments: string[];
}

/** The options `evict` and `pull` take, as they are written on the command line. */
export interface Chosen {
  dryRun?:      boolean;
  purge?:       boolean;

  /** Archives only: also remove what is on disk again of partitions already evicted. */
  cleanup?:     boolean;
  market?:      string;
  dataset?:     string;
  variant?:     string;
  from?:        string;
  to?:          string;

  /** Comma-separated. */
  instruments?: string;

  /** `pull`: what is asked for, as it is written — see `pull/filter.ts`. */
  partition?:   string;
  date?:        string;
  force?:       boolean;

  /** `pull`, archives: which rendering of the same data — see `Preference`. */
  preferMonthly?:    boolean;
  preferDaily?:      boolean;
  preferBundled?:    boolean;
  preferNotBundled?: boolean;
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
