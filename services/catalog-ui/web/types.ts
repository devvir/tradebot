/**
 * What the services answer with, as the page receives it.
 *
 * **Mirrors of the catalog's and prospector's own types, not a second opinion.** The
 * page renders what it is given and reshapes nothing, so a field added upstream
 * shows up here by being added to one of these — never by this service learning
 * to compute it.
 */

export interface Venue {
  venue:       string;
  firstMonth:  string | null;
  lastMonth:   string | null;
  files:       number;

  /**
   * How far the venue has got, per series: how many a file has been seen for,
   * out of how many there are. Summed across every server it publishes from.
   */
  series:      { withFiles: number; total: number };
  bytes:       number;
  pending:     number;
  pendingBytes: number;
  withdrawn:   number;
}

/**
 * The venue's most recent pass, whether or not it ended.
 *
 * **`established` cannot answer this.** It is a completion time, so a venue
 * three hours into its first walk has none — and reads exactly like a venue
 * nobody has ever surveyed.
 */
export interface LastRun {
  /** What that pass is, or was. Null where the venue has never had one. */
  kind:    'walk' | 'update' | null;

  /** When it finished. Null while it is still running, and where none has run. */
  at:      string | null;

  /**
   * When it began, running or not — the only start a pass in progress has.
   * `Status.since` cannot serve: where a venue is paused it holds when it was
   * stopped, not when its job began.
   */
  startedAt: string | null;

  /** Whether it is still going, on any of the venue's hosts. */
  ongoing: boolean;

  /**
   * Whether this is the venue's **first** pass: the backfill rather than a later
   * top-up. Not the same question as `kind`, which says by what means.
   *
   * Optional only because a page is served before the catalog behind it is
   * restarted; a reader falls back to `completedEver`, which answers the same
   * thing for a venue that has never finished one.
   */
  first?:  boolean;

  /**
   * The newest pass that finished, while this one is still going. Null where
   * nothing is running or nothing has finished; optional for the same reason
   * as `first`.
   */
  previous?: FinishedRun | null;
}

/** A pass that finished: when, and whether it was the venue's backfill. */
export interface FinishedRun {
  at:        string;
  startedAt: string;
  first:     boolean;
}

export interface MarketContents {
  market:   string;
  datasets: DatasetContents[];
  symbols:  number;
}

/**
 * One dataset of one market, counted.
 *
 * **`shapes` means nothing on its own**, which is why the levels behind it come
 * with it: thirty candlestick shapes is fifteen bar lengths filed two ways, not
 * thirty of anything.
 */
export interface DatasetContents {
  dataset:  string;
  shapes:   number;
  variants: string[];
  grains:   string[];
  symbols:  number;
}

export interface Shape {
  market:  string;
  dataset: string;
  variant: Record<string, string>;
  grain:   string;
  symbols: number;
  buckets: number;
  first:   string | null;

  /**
   * The newest file anybody has seen of this shape.
   *
   * **A measurement, not a verdict** — `null` means nothing has ever been seen,
   * and nothing else.
   */
  last:    string | null;
}

/**
 * Where a venue stands, as `GET /status` reports it.
 *
 * **One word, plus the facts behind it.** `state` is the whole answer; the rest
 * is what a reader needs to act on it — when a pause started, what it
 * interrupted, when the next update is due.
 */
export type SurveyState = 'not started' | 'starting' | 'walking' | 'updating' | 'waiting' | 'paused';

/**
 * An order given from this page that the catalog has not yet been seen to act on.
 *
 * **Held here, not on the server**, because the server has nothing to report
 * until it acts: between the click and the next poll the row would otherwise
 * read exactly as it did before, and a venue that had been told to go looked
 * like one that had been ignored.
 */
export interface Order {
  /** `go` for Start, Update, Resume and Refresh; `pause` for Pause. */
  kind: 'go' | 'pause';

  /** When it was given — so one that never takes effect is let go of, and said so. */
  at:   number;

  /** The venue's state when it was given, since what counts as done depends on it. */
  from: string | null;
}

export interface Status extends Venue {
  state:      SurveyState;

  /** When the venue was last established end to end. Null where it never was. */
  established: string | null;

  /** The venue's most recent pass, whether or not it ended. */
  lastRun:     LastRun;

  /** When somebody first asked for this venue. Null where nobody has. */
  enrolledAt: string | null;

  /** When the open job began — or, where paused, when it was stopped. */
  since:      string | null;

  /** What a pause interrupted, and therefore what resuming returns to. */
  during:     Exclude<SurveyState, 'not started' | 'paused'> | null;

  /** When the next update is due, where the venue is waiting for one. */
  nextRun:    string | null;

  /** Whether the service has a loop alive for it — not the same as work being owed. */
  surveying:  boolean;

  /** Asked to stop and still finishing the page it is on. */
  stopping:   boolean;

  /**
   * Whether a pass has ever finished here — the whole of what separates starting
   * a venue from updating one. Whether either happens by walking or by
   * generating keys is the catalog's business and never shown.
   */
  completedEver: boolean;

  /**
   * Whether this venue parks candidate keys at all, which is what makes an empty
   * backlog mean something: zero is *nothing outstanding* where a venue probes,
   * and *not applicable* where its listing states everything.
   */
  probing?:      boolean;

  /**
   * Whether the venue has a keyspace to walk. False where its bucket refuses a
   * listing and its series are declared instead — nothing to re-read, so nothing
   * for a refresh to do.
   */
  listable:   boolean;

  wip:        number;
}

/** Where this deployment's page is pointed, so nothing is baked into the bundle. */
export interface Where {
  catalog: string;
}

/**
 * A named way of looking at the catalog — where one is in force, what it lets
 * through *is* the catalog as far as that consumer is concerned.
 */
/**
 * One rule as the editor holds it: what is saved of it, if anything, and what
 * is on the page. Saved and unchanged, it can be dropped; new or changed, it is
 * a draft until it is confirmed.
 */
export interface RuleEntry {
  /** Who this rule is while it is edited — never sent anywhere. */
  key:    string;

  /** The rule as the catalog stores it; absent for a rule never confirmed. */
  saved?: LensRule;

  /** The rule as it stands on the page. */
  now:    LensRule;
}

/** What is unsaved of one lens, kept in this browser so a reload loses nothing. */
export interface LensDraft {
  name:  string;
  note:  string;

  /** Each venue's rules, drafts among the saved ones. */
  rules: Record<string, RuleEntry[]>;

  /** The lens's `updatedAt` it was written against; empty for a lens not yet saved. */
  from:  string;
}

export interface Lens {
  id?:        number;

  /** What a consumer is configured with, and what every path addresses. */
  slug:       string;

  /** What a person calls it. Free text, and free to change. */
  name:       string;

  note:       string;
  createdAt:  string;
  updatedAt:  string;
  definition: LensDefinition;

  /** Whether what it lets through is still being worked out from its rules as last saved. */
  updating?:  boolean;
}

/**
 * How a rule takes a grain or a bundle: only that form, or any form with that
 * one kept where a month is published in it.
 */
export type Choice<T extends string> = { only: T } | { prefer: T };

/** What a lens lets through, keyed by venue name. */
export interface LensDefinition {
  format: number;
  venues: Record<string, LensRule[]>;
}

/**
 * One rule, applied in order to what the rules before it left. An absent
 * dimension means all of it.
 */
export interface LensRule {
  effect:       'include' | 'exclude';
  markets?:     string[];

  /** Each kind of data, optionally narrowed to one of its own variants. */
  datasets?:    LensDataset[];

  /** Absent is any grain. */
  grain?:       Choice<string>;

  /** Files of one instrument each, or the venue-wide ones; absent is either. */
  bundle?:      Choice<'instrument' | 'market'>;
  from?:        string;
  to?:          string;
}

/**
 * One kind of data, whole or at one variant.
 *
 * **A variant belongs to its dataset and to nothing else** — `1m` is a kline
 * length, `incremental,full` a book shape — so the two travel together.
 */
export interface LensDataset {
  dataset:  string;
  variant?: string;
}

/** One combination a venue publishes, as a rule is written against, and the venue it is of. */
export interface LensOption {
  venue:   string;
  market:  string;
  dataset: string;
  variant: string;
  grain:   string;
}

/** Why a lens cannot be stored, located at the rule it belongs to. */
export interface LensProblem {
  venue:   string;
  rule:    number;
  field?:  keyof LensRule;
  message: string;
}

/** How much a lens would put on a disk, and how much of it is still to download. */
export interface LensSize {
  partitions:   number;
  files:        number;
  bytes:        number;
  pending:      number;
  pendingBytes: number;

  /** Whether the lens is still being worked out, so these are of a part of it. */
  updating?:    boolean;
}

