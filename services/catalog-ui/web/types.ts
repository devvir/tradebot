/**
 * What the services answer with, as the page receives it.
 *
 * **Mirrors of prospector's and hauler's own types, not a second opinion.** The
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
  established: string | null;
  lastRun:     LastRun;
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
   * and nothing else. Whether more is expected is `open`.
   */
  last:    string | null;

  /**
   * Whether the catalog still expects files for this shape.
   *
   * The same question it asks before generating a key, so an open shape is one
   * requests are still going out for.
   */
  open:    boolean;
}

/**
 * Where a venue stands, as `GET /status` reports it.
 *
 * **One word, plus the facts behind it.** `state` is the whole answer; the rest
 * is what a reader needs to act on it — when a pause started, what it
 * interrupted, when the next update is due.
 */
export type SurveyState = 'not started' | 'walking' | 'updating' | 'waiting' | 'paused';

export interface Status extends Venue {
  state:      SurveyState;

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
   * Whether the venue has a keyspace to walk. False where its bucket refuses a
   * listing and its series are declared instead — nothing to re-read, so nothing
   * for a refresh to do.
   */
  listable:   boolean;

  wip:        number;
}

/** One line of hauler's shopping list. Not rendered yet; the client already reads it. */
export interface Want {
  venue:   string;
  market:  string;
  dataset: string;
  from?:   string;
  to?:     string;
  fixed?:  Record<string, string>;
  prefer?: Record<string, string>;
}

/** Where this deployment's page is pointed, so nothing is baked into the bundle. */
export interface Where {
  catalog: string;
  hauler:  string | null;
}
