import type { StatementSync } from 'node:sqlite';

/**
 * Everything the catalog serves: what a series is as it reads one, the lens a
 * consumer looks through, and the pages of a venue's listing.
 */

/** What this deployment serves, and where its collector answers. */
export type Config = {
  port:          number;

  /** The catalog database prospector keeps, opened here to read and to store lenses. */
  dbPath:        string;

  /** Sent to the catalog on every request, and checked on this API. Empty turns both off. */
  token:         string;

  /** Where prospector answers, for the reports this service forwards. */
  prospectorApi: string;
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
  urlSymbol: string | null;
  market:    string;
  dataset:   string;
  variant:   string;
  pattern:   string;
  grain:     Grain;
  first:     string | null;
  last:      string | null;
  retiredAt: string | null;
}

/**
 * One lengthwise cut of a venue's data: a dataset of a market, narrowed by its
 * variant, its grain and its bundle. A lens's rules are matched against these.
 */
export interface Slice {
  id:      number;
  venue:   string;
  market:  string;
  dataset: string;
  variant: string;
  grain:   Grain;
  bundle:  Bundle;
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

  /**
   * Only partitions whose version last moved before this instant — an ISO
   * timestamp, compared as text. What a consumer waiting for a partition to go
   * quiet asks with.
   */
  settledBefore?: string;
}

/** A partition as a lens is evaluated against it: where it is, and which month. */
export interface PartitionMember extends Slice {
  partitionId: number;
  month:       string;
}

/** The partition reads, prepared once per database. */
export interface PartitionStatements {
  all:     StatementSync;
  through: StatementSync;
  slices:  StatementSync;
}

/** One host of a venue, as the `venue` table holds it. */
export interface VenueRow {
  name:    string;
  host:    string;
  base:    string;
  keyRoot: string;
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

/**
 * A named way of looking at the catalog.
 *
 * **Where a lens is in force, what it lets through *is* the catalog.** A consumer asks what
 * exists and gets the lens's answer; the database stays complete and unfiltered
 * underneath. That is the whole idea, and the reason it is not called a
 * selection: nothing is being gathered, something is being looked through.
 *
 * **Three names, and they do different jobs.** `slug` is what a consumer is
 * configured with and what every path addresses, so it is stable and spelled
 * plainly; `name` is what a person calls it; `note` is what it is for. Collapsing
 * the first two costs either a handle nobody can read or a title nobody can
 * change.
 */
export interface Lens {
  id?:        number;
  slug:       string;
  name:       string;
  note:       string;
  createdAt:  string;
  updatedAt:  string;
  definition: LensDefinition;
}

/**
 * What a lens lets through, as one document.
 *
 * **Keyed by venue name, never by id.** An id names a *host* — bybit publishes
 * its books from a second server and has two rows in `venue` — and a lens has no
 * opinion about which server a file came from. The name is also what the API
 * speaks in everywhere else, and what the seeds are keyed by.
 *
 * `format` is what lets a document written under one set of rules be read under
 * another. Nothing migrates it today; it exists so that something can.
 */
export interface LensDefinition {
  format: number;
  venues: Record<string, LensRule[]>;
}

/** How many instruments one file holds: one, or all of a market's. */
export type Bundle = 'instrument' | 'market';

/**
 * One rule, applied in order to what the rules before it left.
 *
 * **Evaluation starts from nothing.** `include` adds what it matches and
 * `exclude` takes it away, so a venue's rules read top to bottom like a sentence:
 * everything up to a date, except books, except recent trades. A list that opens
 * with `exclude` therefore sees nothing — subtracting from the empty set — which
 * is legal, almost never meant, and worth saying out loud in an editor.
 *
 * **A rule states only what it constrains.** An absent dimension means all of it,
 * so `{ effect: 'include', datasets: ['trades'] }` is every market, variant,
 * grain and bundle, for all time.
 *
 * Writing `markets: 'all'` everywhere was considered and rejected: it is not more
 * explicit, only longer, and it ages in the wrong direction. Datasets, variants
 * and grains are *added* over time, and a rule that names what it constrains
 * absorbs an addition, where one enumerating every value silently stops covering
 * the archive.
 */
export interface LensRule {
  effect:       'include' | 'exclude';

  /** Matched against `pattern.market`. */
  markets?:     string[];

  /**
   * Which kinds of data, each optionally narrowed to one of its variants.
   *
   * **A variant belongs to its dataset and to nothing else.** `1m` is a kline
   * length, `full,incremental` is a book shape, and trades have variants of their
   * own — so a flat list of variants beside a flat list of datasets cannot say
   * which belongs to which, and `klines` at `1m` together with every `trades`
   * becomes unsayable. A pair says it exactly.
   */
  datasets?:    LensDataset[];

  grains?:      Grain[];

  /**
   * How many instruments one file holds: `instrument` is the files of one
   * each, `market` the venue-wide files carrying every instrument at once.
   *
   * **A rule never names an instrument**, so what it selects is always whole:
   * every instrument a market publishes in that form, or none of them.
   */
  bundle?:      Bundle;

  /** Inclusive `yyyymmdd` bounds on the period a file covers; absent is open. */
  from?:        string;
  to?:          string;
}

/**
 * One combination a venue publishes, as a rule is written against.
 *
 * **The strings a filter matches**, not the shape a reader is shown: `Shape`
 * reports a variant taken apart into its levels, and a rule stores the variant
 * whole. Two projections of the same rows, for two different jobs.
 */
export interface LensOption {
  market:  string;
  dataset: string;
  variant: string;
  grain:   Grain;
  series:  number;

  /** Of those, the venue-wide files — the series the `market` bundle selects. */
  buckets: number;
}

/**
 * Why a lens was refused, in a person's words.
 *
 * **Named by where the fault is**, so an editor can put it against the rule it
 * belongs to rather than at the bottom of the page. `venue` and `rule` locate it;
 * `field` says which part of that rule, where one part is at fault.
 */
export interface LensProblem {
  venue:    string;
  rule:     number;
  field?:   keyof LensRule;
  message:  string;
}

/** A `lens` row as the table holds it. */
export interface LensRow {
  id:         number;
  slug:       string;
  name:       string;
  note:       string;
  definition: string;
  created_at: string;
  updated_at: string;
}

/** What a saved lens holds of one venue — see `lensFigures`. */
export interface LensVenueFigures {
  /** Partitions the lens lets through. */
  partitions:   number;
  files:        number;
  bytes:        number;
  pending:      number;
  pendingBytes: number;

  /** The first and last month it holds a file in. */
  first:        string | null;
  last:         string | null;
}

/**
 * How much a lens would put on a disk.
 *
 * **Sizing is what makes a lens decidable.** Nobody fetches everything, because
 * everything is measured in tens of terabytes, so the number that settles what a
 * lens should let through is this one — and it has to answer while somebody is
 * still choosing.
 *
 * Always exact: summed off the partitions, never off the files themselves.
 */
export interface LensSize {
  /** Partitions the lens selects. */
  partitions:   number;
  files:        number;
  bytes:        number;

  /**
   * Of those, the files not yet downloaded, and what they weigh — the lens's
   * progress, and from the same road as the totals, so the two never disagree.
   */
  pending:      number;
  pendingBytes: number;
}

/** A slice a definition lets through, and the months it lets it through for. */
export interface LensSlice {
  slice: Slice;
  spans: LensSpan[];
}

/**
 * A stretch of time a lens lets through for one slice.
 *
 * **A list of them, because a rule can carve a hole.** Including 2019 to 2021 and
 * then excluding 2020 leaves two spans, and collapsing that to one range would
 * quietly hand back a year nobody asked for. Both bounds are inclusive, and null
 * is open at that end.
 */
export interface LensSpan {
  from: string | null;
  to:   string | null;
}

/** The outermost dates of a slice's spans under a lens — null where open that way. */
export interface LensWindow {
  from: string | null;
  to:   string | null;
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
  /**
   * The row's `rowid`, handed out as `FileId`. Stable because nothing renumbers
   * it: rows are never moved between tables, and the catalog never runs a full
   * `VACUUM` — `auto_vacuum = INCREMENTAL` moves pages, never rowids. Running one
   * would invalidate every id a client holds.
   */
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

/** A report as a downloader sends it, by Key. */
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
}


/**
 * One shape a venue publishes, in canonical terms — what the catalog holds, said
 * the way a consumer asks for it.
 *
 * **The answer to "what is in here?", which nothing else could ask.** Every other
 * listing is about files; this is about what kinds of thing exist at all, so a
 * consumer can decide what to want before fetching anything. What bar lengths
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
   * `{ depth: '400', mode: 'incremental' }`. Empty where the dataset has none.
   */
  variant:  Record<string, string>;

  /** How often it publishes — which rendering of the data this is. */
  grain:    Grain;

  /** Named instruments carrying it. */
  symbols:  number;

  /**
   * Venue-wide files carrying every instrument at once, if any.
   *
   * **The question a consumer asks first**, because one bucket file is cheaper
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
 * How often a series publishes a file.
 *
 * **Read off the pattern, never stored.** The finest slot a pattern carries is
 * its grain, and two fields that can disagree about that are worse than one that
 * cannot.
 *
 * Four, because four is what these venues publish: a month, a day, an hour —
 * gate's order books are 24 files a day — and a minute, which is gate's options
 * ticker and nothing else so far.
 */
export type Grain = 'monthly' | 'daily' | 'hourly' | 'minutely';

/**
 * Which series a caller means, in the catalog's own vocabulary.
 *
 * **Every field is optional and absent means "any".** A filter nobody set is not
 * a filter that matched nothing — that distinction only applies to a set handed
 * over explicitly, such as an empty `symbols`, which asks for exactly no
 * instruments and is answered with no files.
 *
 * `market`, `dataset` and `variant` are matched case-blind, because the case is
 * a spelling convention rather than a fact about the data. `symbol` is exact and
 * `symbols` is not: the first is what a reconciliation matches against a venue's
 * own listing, where being exact is the safe side of a destructive decision,
 * while the second is what a person or a downstream service asks with.
 */
export interface SeriesFilter {
  /** Narrows to series whose **pattern** is still live — a retired shape is excluded. */
  live?:    boolean;

  /** One instrument, exactly as the venue's listing spells it. */
  symbol?:  string;

  /** Any of these instruments, case-blind. Empty asks for none. */
  symbols?: readonly string[];

  market?:  string;
  dataset?: string;

  /** The level below the dataset: a bar length, a book depth, a funding kind. */
  variant?: string;

  /**
   * How often the shape publishes.
   *
   * **The filter that separates two renderings of the same data.** A venue that
   * files its trades both monthly and daily offers one caller's month twice, and
   * a consumer that already knows which it wants should not have to fetch both
   * and discard one.
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

/** A lens as a create or a replace sends it; every field optional. */
export interface LensWrite {
  slug?:       string;
  name?:       string;
  note?:       string;
  definition?: LensDefinition;
}

/** What a definition selects at one venue. */
export interface LensResolved {
  slices:     number;
  partitions: number;
  spans:      string[];
}

/**
 * One kind of data a lens lets through, whole or at one variant.
 *
 * **An absent `variant` is every variant of that dataset**, which is the ordinary
 * case: most datasets have only one, and a rule about `trades` rarely means a
 * particular shape of them.
 */
export interface LensDataset {
  dataset:  string;
  variant?: string;
}
