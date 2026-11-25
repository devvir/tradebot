import type { StatementSync } from 'node:sqlite';
import type { Bundle, Grain, Lens, LensSpan, Slice } from '@tradebot/lenses';

export type { Bundle, Grain, Lens, LensDefinition, LensProblem, LensSize, LensSpan, LensWrite } from '@tradebot/lenses';


/**
 * Everything the catalog serves: what a series is as it reads one, the lens a
 * caller looks through, and the pages of a venue's listing.
 */

/** What this deployment serves, and where its collector answers. */
export type Config = {
  port:          number;

  /** The catalog database prospector keeps, opened here read-only. */
  dbPath:        string;

  /** Checked on every request to this API, and sent to prospector with every forwarded write. Empty turns both off. */
  token:         string;

  /** Where prospector answers: lens writes and reports are forwarded there. */
  prospectorApi: string;

  /** How long a call to prospector waits for its answer before it is given up. */
  prospectorMs:  number;

  /** How long a report's settlement waits for prospector's answer before it is given up. */
  settleMs:      number;

  /** The wait before a call to prospector is tried again, doubled each time. */
  retryMs:       number;
};

/**
 * One series, as the catalog reads it: the instrument, the shape it is
 * published under, and the first and last file anybody has seen of it.
 */
export interface Series {
  id:        number;
  venueId:   number;

  /** The slice its pattern publishes into, which is where a lens looks it up. */
  sliceId:   number;
  symbol:    string;
  market:    string;
  dataset:   string;
  variant:   string;
  pattern:   string;
  grain:     Grain;
  first:     string | null;
  last:      string | null;
}

/** What a partition holds, and the version that says so. */
export interface PartitionFigures {
  month:        string;
  files:        number;
  bytes:        number;

  /** Of those, the files not yet downloaded, and what they weigh. */
  pending:      number;
  pendingBytes: number;
  withdrawn:    number;

  /** Sixteen hex digits that move whenever a file is added, withdrawn or changed. */
  version:      string;

  /** When the version last moved. */
  updatedAt:    string;
}

/** One month of a slice, as the `partition` table joined to its slice reads. */
export interface Partition extends PartitionFigures, Omit<Slice, 'id'> {
  id:      number;
  sliceId: number;
}

/** A slice with the partitions it holds, as the contents serve it. */
export interface SliceContents extends Omit<Slice, 'id' | 'venue'> {
  partitions: PartitionFigures[];
}

/**
 * Which partitions a caller means. Every field is optional and absent means
 * "any".
 */
export interface PartitionFilter {
  market?:   string;

  /** Any of these datasets, case-blind. */
  datasets?: readonly string[];
  variant?:  string;
  grain?:    Grain;
  bundle?:   Bundle;

  /** Only partitions with nothing left to download. */
  downloaded?: boolean;

  /** Only settled partitions — see `settledEdge` in `partitions.ts`. */
  settled?: boolean;

  /**
   * Only settled partitions whose version last moved before this instant — an
   * ISO 8601 instant in UTC, as `toISOString` writes one, compared as text. It
   * implies `settled`.
   */
  settledBefore?: string;
}

/**
 * Where settled ends for one venue, at one moment: a partition is settled when
 * its month is below `month` and its version last moved before `before`.
 */
export interface SettledEdge {
  month:  string;
  before: string;
}

/** The partition reads, prepared once per database. */
export interface PartitionStatements {
  all:     StatementSync;
  through: StatementSync;
  running: StatementSync;
}

/** The reads prepared once per database. */
export interface QueryStatements {
  series: StatementSync;
}

/** A venue's totals, summed over its partitions. */
export interface VenueTotals {
  venue:        string;
  firstMonth:   string | null;
  lastMonth:    string | null;
  files:        number;
  bytes:        number;
  pending:      number;
  pendingBytes: number;
  withdrawn:    number;
}

/** What a saved lens holds of one venue — see `lensFigures`. */
export interface LensVenueFigures {
  /** Partitions the lens lets through. */
  partitions:   number;
  files:        number;
  bytes:        number;
  pending:      number;
  pendingBytes: number;
  withdrawn:    number;

  /** The first and last month it holds a file in. */
  first:        string | null;
  last:         string | null;
}

/**
 * A lens as the contents apply it: for each venue, the slices it lets through
 * and the months of each, as spans. A slice absent from a venue's map is not in
 * the lens.
 */
export type LensScope = ReadonlyMap<string, ReadonlyMap<number, readonly LensSpan[]>>;

/** A resolved lens, and what it was resolved from. */
export interface HeldScope {
  /** The lens's `updatedAt` and `partitions_through` when it was read: a change to either replaces it. */
  updatedAt: string;
  through:   number;
  scope:     LensScope;
}

/** One file of a venue's bucket, as a listing reads it. */
export interface ListingFile {
  /** The file row's `rowid`, which is how prospector names a file — the `FileId` a report is settled by. */
  id:       number;
  venueId:  number;
  path:     string;
  date:     string;
  size:     number | null;
  etag:     string | null;
  modified: string | null;
  seriesId: number;
}

/** A file as the listing query returns it, with the key prefix it files under. */
export interface ListingRow extends ListingFile {
  prefix:  string;

  /** The series' pattern, which says where a part sits in the name. */
  pattern: string;
}

/** The file a key names: enough to settle it, and to check it against a lens. */
export interface KeyedFile {
  id:       number;
  seriesId: number;
  date:     string;
  path:     string;
}

/** The file a key names, or why there is none. */
export type Keyed = KeyedFile | 'NoSuchKey' | 'AccessDenied';

/** A report as a client sends it, by Key. */
export interface ReportedByKey {
  downloaded: string[];
  failed:     string[];
  mismatched: { Key: string; Size?: number; ETag?: string }[];
}

/** The same report as prospector settles it, by file id. */
export interface ReportedById {
  downloaded: number[];
  failed:     number[];
  mismatched: { FileId: number; Size?: number; ETag?: string }[];
}

/** A key a report named that could not be settled, in S3's words. */
export interface ReportError {
  Key:     string;
  Code:    'NoSuchKey' | 'AccessDenied';
  Message: string;
}

/** One object of a bucket listing: its canonical key, and the file it names. */
export interface ListingObject {
  key:  string;
  file: ListingFile;
}

/** One page of a bucket, and whether there is more after it. */
export interface ListingPage {
  objects:   ListingObject[];
  truncated: boolean;
}

/** What a bucket listing is asked for. */
/** What a listing is narrowed to before it is walked: nothing, a lens's partitions, or one partition. */
export type Within = 'all' | 'lens' | 'partition';

export interface ListingQuery {
  /** List only keys after this one; null from the start. */
  after:   string | null;

  /** List only keys starting with this; empty for every key. */
  prefix:  string;
  maxKeys: number;

  /** Only files not yet downloaded. */
  pending: boolean;

  /** The lens it is read through, or null for every file. */
  lens:    Lens | null;

  /** The one partition whose files are listed — its id — or null for every partition. */
  partition?: number | null;
}


/**
 * One shape a venue publishes, in canonical terms — what the catalog holds, said
 * the way a caller asks for it.
 *
 * **The answer to "what is in here?", which nothing else could ask.** Every other
 * listing is about files; this is about what kinds of thing exist at all, so a
 * caller can decide what to want before fetching anything. What bar lengths
 * does this venue publish? Does it file trades monthly or daily, or both? Does it
 * have books, at what depths, snapshot or incremental? Is there a venue-wide file
 * or only per-instrument ones?
 *
 * Read from the patterns and their series, which are thousands of rows where
 * files are millions.
 */
export interface Shape {
  market:   string;
  dataset:  string;

  /**
   * The levels below the dataset, named — `{ interval: '1m' }`,
   * `{ kind: 'incremental', depth: '400' }`. Empty where the dataset has none.
   */
  variant:  Record<string, string>;

  /** How often it publishes — which rendering of the data this is. */
  grain:    Grain;

  /**
   * How many of its series name an instrument. A count of series, not of
   * instruments: one held under two patterns of this shape counts twice.
   */
  symbols:  number;

  /**
   * How many of its series are venue-wide, each file carrying every instrument
   * at once. None where it has only per-instrument files.
   *
   * **The question a caller asks first**, because one bucket file is cheaper
   * than a file per instrument for the same data — see the `@` symbol.
   */
  buckets:  number;

  /** The earliest date anything here starts. */
  first:    string | null;

  /**
   * The newest file anybody has seen of this shape.
   *
   * **A measurement, not a verdict.** It says where the shape has got to, and it
   * says so whether or not more is coming — `null` means nothing has ever been
   * seen of it.
   */
  last:     string | null;
}

/**
 * What one market of a venue holds, for a caller deciding where to look.
 *
 * **The datasets are named rather than counted.** "This market has four
 * datasets" answers nothing anyone can act on; the names are what they came for.
 * The two counts beside them are for sizing the next request, not for reading as
 * facts about the venue.
 */
export interface MarketContents {
  market:   string;

  /** What it publishes, each with its own size. Sorted by name. */
  datasets: DatasetContents[];

  /** Named instruments, not counting the venue-wide file. */
  symbols:  number;
}

/**
 * One dataset of one market, counted.
 *
 * **`shapes` is not a number anyone can read on its own**, which is why the
 * levels behind it are named beside it: binance's perpetual candlesticks are 30
 * shapes, and that is fifteen bar lengths filed two ways rather than thirty of
 * anything. A caller wanting the rows themselves asks for the market.
 */
export interface DatasetContents {
  dataset:  string;

  /** Distinct `(variant, grain)` pairs — the rows `/markets/:market` returns. */
  shapes:   number;

  /** The variants it publishes, named. Empty where the dataset has no levels. */
  variants: string[];

  /** How it is filed: `daily`, `monthly`, or both. */
  grains:   string[];

  /** Named instruments carrying it, not counting the venue-wide file. */
  symbols:  number;
}

/**
 * Which series a caller means, in the catalog's own vocabulary.
 *
 * **Every field is optional and absent means "any".** `market`, `dataset` and
 * `variant` are matched case-blind, because the case is a spelling convention
 * rather than a fact about the data.
 */
export interface SeriesFilter {
  market?:  string;
  dataset?: string;

  /** The level below the dataset: a bar length, a book depth, a funding kind. */
  variant?: string;

  /**
   * How often the shape publishes.
   *
   * **The filter that separates two renderings of the same data.** A venue that
   * files its trades both monthly and daily offers the same month twice, and
   * this names the one that is meant.
   */
  grain?:   Grain;
}

/** A listing request, as `requestOf` reads it from the query. */
export interface ListingRequest {
  v2:      boolean;
  maxKeys: number;
  token?:  string;
  start?:  string;

  /** The key to resume after; null from the start. */
  after:   string | null;

  /** Only keys starting with this; empty for every key. */
  prefix:  string;

  /** Only files not yet downloaded. */
  pending: boolean;

  /** Only the files of this partition, by name — see `partitionNamed`. */
  partition?: string;
}

/** Why a listing request cannot be answered: a status, and S3's `Code` and `Message`. */
export interface ListingRefusal {
  status:  number;
  code:    string;
  message: string;
}

/** A body in S3's field names, before it is written as XML or JSON. */
export type S3Body = Record<string, unknown>;

/** A lens named in a request, and what it resolved to. */
export interface RequestedLens {
  lens:  Lens;
  scope: LensScope;
}

/** How many of a venue's series hold a file, of how many there are. */
export interface SeriesCount {
  withFiles: number;
  total:     number;
}

/** One venue's row in the contents: its totals, and its series. */
export interface VenueContents extends VenueTotals {
  series: SeriesCount;

  /**
   * Where its files are served from, by server: the address that is listed
   * first, then any other that serves the same files. A file's address is one
   * of these and the file's `Path`. Keyed by the server's name — `''` where the
   * venue has one, `primary` and `secondary` where it has two.
   */
  hosts:  Record<string, string[]>;
}

/** What one venue's contents request asks for. */
export interface ContentsAsked {
  give:   'shapes' | 'markets' | 'symbols';
  filter: SeriesFilter;
}

/** One host's series counts, as the query returns them. */
export interface SeriesCountRow extends SeriesCount {
  venueId: number;
}

