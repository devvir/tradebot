export interface Config {
  /** Where archives land. Fixed path inside the container, host dir mounted onto it. */
  dataDir:     string;

  /**
   * Where the facts other services act on are published — complete months, and
   * warnings that a venue changed history it had already published. A separate
   * mount, so what trucker owns and what it shares are not the same directory.
   */
  sharedDir:   string;

  /** Venues to fetch, from `TRUCKER_VENUES`. Empty env = all known venues. */
  venues:      readonly string[];

  /**
   * Oldest month to fetch, `yyyymm`, **inclusive**. Null = each venue's own
   * beginning.
   */
  startMonth:  string | null;

  /**
   * Newest month to fetch, `yyyymm`, **inclusive**. Null = no ceiling: whatever
   * each venue has published is fetched as it appears.
   *
   * Purely a filter on what is offered for download — it touches no cursor and
   * no ledger, so moving it forward later resumes from where each symbol
   * stopped rather than re-listing or re-fetching. That is what makes walking
   * the backfill an era at a time safe.
   */
  endMonth:    string | null;

  /** Concurrent downloads **per venue**; venues themselves run concurrently. */
  concurrency: number;

  /** Hours between rescans for newly published files. */
  rescanHours: number;

  /** Symbol tokens to keep, matched as case-insensitive substrings. Empty = all. */
  symbols:     readonly string[];

  /** Stop fetching when the volume drops below this many GB free. */
  minFreeGb:   number;

  [key: string]: unknown;
}

/** What a series holds. Only used where a venue's URLs depend on it. */
export type Kind =
  | 'trades' | 'klines' | 'book' | 'funding' | 'borrow'
  | 'mark' | 'index' | 'metrics' | 'liquidations' | 'volatility';

/**
 * One publishable series from a venue: a market and a data kind. `id` is the
 * progress-key segment and must be stable — changing it re-downloads history.
 *
 * `path` is the venue's own name for the series within its layout, which is
 * routinely not the id (`funding-rates` on HTX, `depth/orderbooklv50` on
 * KuCoin). Keeping them separate is what lets an id stay stable while a venue
 * names its directories however it likes.
 */
export interface Dataset {
  id:     string;
  kind:   Kind;
  market: string;
  path:   string;
}

/** Granularity a venue publishes a period at. */
export type Period = 'daily' | 'monthly';

/**
 * A single downloadable archive file, exactly as the venue publishes it.
 *
 * `path` is relative to the venue's root directory and mirrors the venue's own
 * layout, so a URL maps to one path mechanically and "already downloaded?" is a
 * filesystem question rather than a bookkeeping one.
 */
export interface ArchiveFile {
  url:          string;
  path:         string;
  /**
   * The last day the file covers, always `yyyymmdd` — a monthly file is keyed
   * by the last day of its month. Progress is tracked in days regardless of how
   * a venue partitions its files, so periods of any length compare directly.
   */
  date:         string;
  symbol:       string;
  /** Companion checksum URL, where the venue publishes one. */
  checksumUrl?: string;
  /** How long a span the file covers. Decides how long absence stays plausible. */
  period:       Period;
}

/**
 * How a date is written into a venue's keys. Derived from the keys themselves
 * at enumeration, never declared — every venue dates its filenames differently
 * and several date them differently within one dataset.
 */
export type DateStyle = 'ymd' | 'y-m-d' | 'ym' | 'y-m';

/**
 * One shape of file a symbol publishes, and every date it published it at.
 *
 * A shape is a URL and a storage path with the date lifted out (`{d}`), so a
 * whole history collapses to two strings and a list of ranges. Symbols with
 * several shapes — an interval directory, a naming change part-way through —
 * simply have several rows.
 *
 * `runs` are in the key's own units: `yyyymmdd` for daily shapes, `yyyymm` for
 * monthly ones, since that is what has to be rendered back into a URL.
 */
export interface InventoryShape {
  symbol: string;
  period: Period;

  /**
   * Null for a key that could not be reduced to a template. Those are kept
   * verbatim — one row, one date — rather than being dropped or guessed at.
   */
  style:  DateStyle | null;
  url:    string;
  path:   string;

  /** Inclusive `[from, to]` pairs, ascending, non-overlapping. */
  runs:   [string, string][];

  /** When the venue was last asked, ISO. */
  asOf:   string;
}

/**
 * A venue answering differently than it did before, about history it had
 * already reported.
 *
 * Everything trucker does rests on one assumption: the archive below the tip
 * does not change. That assumption is load-bearing — a closed month is
 * published as final, tarred to cold storage and built into partitions — so the
 * cheapest possible insurance is to notice out loud when a venue contradicts
 * it, and leave the decision to a human.
 */
export interface InventoryChange {
  symbol: string;

  /**
   * `removed`    — dates it used to list and no longer does.
   * `backfilled` — dates older than anything it had listed for this shape.
   * `infilled`   — dates inside a gap it had previously reported as empty.
   * `reshaped`   — a new filename shape covering history already collected.
   */
  kind:   'removed' | 'backfilled' | 'infilled' | 'reshaped';
  from:   string;
  to:     string;
}

/** How a non-2xx status should be treated — see `classify` in download.ts. */
export type Verdict = 'absent' | 'backoff' | 'retry';

export interface DownloadResult {
  status: 'downloaded' | 'skipped' | 'absent' | 'failed';
  bytes:  number;
}

/** A period a venue reported missing, kept for later re-checking. */
export interface Absence {
  venue:      string;
  dataset:    string;
  symbol:     string;
  date:       string;
  period:     Period;
  url:        string;
  path:       string;
  firstSeen:  string;
  lastTried:  string;
  attempts:   number;
}

/**
 * A venue's remembered symbol lists, keyed by dataset: every symbol ever seen,
 * and when the venue was last asked. Expiry is per dataset, so one dataset's
 * refresh does not re-list the rest.
 */
export interface SymbolCache {
  ever:    Map<string, Set<string>>;
  fetched: Map<string, string>;
}

/** Per-venue limiter state — minimum-interval slot plus the current cooldown. */
export interface VenueState {
  nextSlot:   number;
  cooldownMs: number;
  until:      number;
}

export interface SyncStats {
  discovered: number;

  /**
   * Symbols answered from disk without asking the venue — already collected
   * through the ceiling, or publishing nothing below it. The listing is the
   * expensive part of a pass, so this is the number that says how much of one
   * was avoided.
   */
  settled:    number;
  downloaded: number;
  skipped:    number;
  absent:     number;
  failed:     number;
  bytes:      number;
}
