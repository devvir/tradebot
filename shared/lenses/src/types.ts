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

/** How many instruments one file holds: one, or all of a market's. */
export type Bundle = 'instrument' | 'market';

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

  /**
   * Whether what it lets through is still being worked out from its rules as
   * they were last saved. Until it is not, its partitions are partly those of
   * the rules before.
   */
  updating:   boolean;
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
  rebuilding: number;
}

/** A lens as a create or a replace sends it; every field optional. */
export interface LensWrite {
  slug?:       string;
  name?:       string;
  note?:       string;
  definition?: LensDefinition;
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
   * length, `incremental,full` is a book shape, and trades have variants of their
   * own — so a flat list of variants beside a flat list of datasets cannot say
   * which belongs to which, and `klines` at `1m` together with every `trades`
   * becomes unsayable. A pair says it exactly.
   */
  datasets?:    LensDataset[];

  /** Which grain: only one, or any with one preferred. Absent is any. See `Choice`. */
  grain?:       Choice<Grain>;

  /**
   * How many instruments one file holds: `instrument` is the files of one
   * each, `market` the venue-wide files carrying every instrument at once.
   * Only one, or either with one preferred; absent is either. See `Choice`.
   *
   * **A rule never names an instrument**, so what it selects is always whole:
   * every instrument a market publishes in that form, or none of them.
   */
  bundle?:      Choice<Bundle>;

  /** Inclusive `yyyymmdd` bounds on the period a file covers; absent is open. */
  from?:        string;
  to?:          string;
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

/** What a rule is matched against: a slice's traits, wherever they were read from. */
export interface SliceTraits {
  market:  string;
  dataset: string;
  variant: string;
  grain:   Grain;
  bundle:  Bundle;
}

/** A partition as a lens is evaluated against it: where it is, and which month. */
export interface PartitionMember extends SliceTraits {
  /** The slice it is a month of. */
  id:          number;
  venue:       string;
  partitionId: number;
  month:       string;
}

/**
 * How a rule takes a trait a month can be published in more than one form of —
 * its grain, its bundle.
 *
 * **`only` narrows**: the rule matches that form and no other, and where a
 * month is not published in it the rule matches nothing of that month.
 *
 * **`prefer` never narrows**: the rule matches every form, and of the forms one
 * month of one dataset is published in it keeps the preferred where that is
 * among them, and whatever there is where it is not. So one rule covers a venue
 * whose datasets are monthly here and daily there, without anybody having to
 * find out which.
 */
export type Choice<T> = { only: T } | { prefer: T };

/** A partition a definition lets through, with what it holds. */
export interface LensPartition extends PartitionMember {
  files:        number;
  bytes:        number;
  pending:      number;
  pendingBytes: number;
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

/** A slice a definition lets through, and the months it lets it through for. */
export interface LensSlice {
  slice: Slice;
  spans: LensSpan[];
}

/**
 * One combination a venue publishes, as a rule is written against, and the venue it is of.
 *
 * **The strings a filter matches**, not the shape a reader is shown: `Shape`
 * reports a variant taken apart into its levels, and a rule stores the variant
 * whole. Two projections of the same rows, for two different jobs.
 */
export interface LensOption {
  venue:   string;
  market:  string;
  dataset: string;
  variant: string;
  grain:   Grain;
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

/** What a definition selects at one venue. */
export interface LensResolved {
  slices:     number;
  partitions: number;
  spans:      string[];
}
