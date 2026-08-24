/**
 * Everything hauler names, fetches and reports, in one place.
 */

// ── What the catalog hands over ───────────────────────────────────────────────

/**
 * One file the catalog is offering, as hauler receives it.
 *
 * **These are facts about the data, never about the URL.** The path a venue
 * serves this at is prospector's business and appears here only as an opaque
 * `url` that hauler passes back to `fetch` without reading. Everything hauler
 * decides — where the file lands, which partition it completes — is decided
 * from the fields beside it.
 */
export interface Offered {
  /** Opaque handle the catalog identifies this file by, echoed in reports. */
  key:      string;
  url:      string;

  venue:    string;

  /**
   * **Canonical, and taken at its word.** The catalog does the translating —
   * that gate keeps perpetuals in `futures_usdt` and okx shouts `SWAP` stops
   * inside prospector's adapters — so what arrives here is already the
   * vocabulary the archives are arranged by. Hauler holds no table of venue
   * habits and needs none.
   *
   * Typed as strings rather than as `Market` and `Dataset` because they arrive
   * over the wire: they are checked once, when the file is named, and a value
   * outside the vocabulary is a file hauler refuses rather than one it coerces.
   */
  market:   string;
  dataset:  string;

  /**
   * The levels below the dataset, named — `{ interval: '1m' }`,
   * `{ depth: '400', mode: 'incremental' }`.
   *
   * **Named by the catalog rather than split here**, so choosing between depths
   * or bar lengths never means counting positions in a string. Absent where the
   * dataset has no level below it.
   *
   * The order is the order the levels belong in, and it is what the archive path
   * is built from — see `datasetOf`.
   */
  variant?: Record<string, string>;

  /**
   * The venue's own name for the instrument, or `@` where one file carries every
   * instrument of a market.
   *
   * **Empty is neither of those.** It means the catalog could not place the file
   * in a series at all, and a file whose identity is unknown must not be given a
   * name — see `nameOf`.
   */
  symbol:   string;

  /** `yyyymm`, `yyyymmdd` or finer. Its length is its grain. */
  date:     string;

  /** Only where a venue splits one period across several files. */
  part?:    string;

  /** The venue's own extension, carried through — `.zip`, `.csv.gz`. */
  ext:      string;

  /** What the file should weigh, and what it should hash to. */
  size?:    number;
  etag?:    string;
}

// ── What hauler turns that into ───────────────────────────────────────────────

/**
 * A market as the archives name it, whatever the venue calls it.
 *
 * **Margining is not a market.** Bybit's `linear` and `inverse`, htx's `swap`
 * and `linear-swap`, binance's `futures-um` and `futures-cm` are all perpetual
 * swaps differing in what collateralises them — which is a property of the
 * instrument, readable from the symbol, and not a reason for a reader to look
 * in two places for the same kind of series.
 *
 * `tradfi` is gate's equities and metals feed. It is not crypto and does not
 * pretend to be one of the others.
 */
export const MARKETS = ['spot', 'perp', 'future', 'option', 'tradfi'] as const;

export type Market = typeof MARKETS[number];

/**
 * A dataset as the archives name it — the canonical table, without its variants.
 *
 * Deliberately the same vocabulary stocker already reads into the vault, since
 * a second set of names for the same series would have to be reconciled by
 * every consumer of both.
 */
export const DATASETS = [
  'trades', 'klines', 'markPrice', 'indexPrice',
  'premiumIndex', 'funding', 'borrowing', 'quotes', 'depthBands',
  'openInterest', 'liquidations', 'books', 'volatilityIndex',
  'optionSummary', 'optionTicker',
] as const;

export type Dataset = typeof DATASETS[number];

/**
 * Every market, or every dataset — whatever the venue turns out to publish.
 *
 * **It is for fetching without prior knowledge.** Naming a dataset is a claim
 * that you know which ones a venue has; this asks the catalog instead, so a
 * venue that starts publishing something new is covered without the list being
 * touched.
 */
export const ANY = '*';

/**
 * A file's canonical identity: everything its name and its place are built
 * from, and nothing else.
 */
export interface Named {
  venue:   string;
  market:  Market;

  /** The dataset with its variants, comma-separated — `klines,1m`. */
  dataset: string;

  /** The instrument, or `@` where the file carries every instrument. */
  symbol:  string;

  /** The date covered, at the grain it covers. */
  period:  string;

  part?:   string;
  ext:     string;
}

/** The partition a file belongs to: the unit everything downstream works in. */
export interface Partition {
  venue:   string;
  market:  Market;
  dataset: string;
  month:   string;
}

// ── Configuration ─────────────────────────────────────────────────────────────

export interface Config {
  /** Where the archives are rooted. Every canonical path is built below it. */
  archivesDir:  string;

  /** Holds the facts database, which hauler writes exactly one kind of fact to. */
  sharedDir:    string;

  catalogUrl:   string;

  /** One secret for the pair: it opens the catalog, and it opens this service. */
  catalogToken: string;

  /** Where the shopping-list API listens inside the container. */
  port:         number;

  /** Which venues this deployment hauls; empty means every one on offer. */
  venues:       string[];

  /**
   * Which markets and datasets this deployment hauls, and the span it hauls
   * within — each empty or absent means no further narrowing.
   *
   * **These constrain the shopping list; they never add to it.** The list
   * itself is the standing intention, seldom changed and shared by every
   * deployment that reads it; these are how one deployment takes a slice of it
   * — to prioritise part of the list first, or to split it across several
   * deployments hauling concurrently. A want for `klines` at a venue this
   * deployment does not haul is still narrowed to nothing by `venues`, exactly
   * as a want for `books` is narrowed to nothing by `datasets` here — same
   * rule, same shape, applied to every field a want has.
   */
  markets:      string[];
  datasets:     string[];

  /** Narrows every want's span to no earlier than this, `yyyymm`. */
  from?:        string;

  /** Narrows every want's span to no later than this, `yyyymm`. */
  to?:          string;

  /** Concurrent fetches within one venue. Venues never wait on each other. */
  concurrency:  number;

  /** What service-kit's factory expects of any config it is handed. */
  [key: string]: unknown;
}

// ── Talking to the catalog ────────────────────────────────────────────────────

/**
 * One line of the shopping list: **what we want**, not what a venue turned out
 * to offer.
 *
 * **Fetching everything is not on the table.** The raw archives plus the vault
 * were estimated at 70 TB before two of the largest venues were indexed, so what
 * gets fetched is a choice — and this is the shape that choice takes.
 *
 * **It says the requirement and never the answer.** *The smallest bar length,
 * monthly if there is a choice, the venue-wide file if there is one* is a
 * sentence that stays true when a venue drops an interval or starts publishing
 * daily. Its resolution — which shapes that actually selects, at which venue —
 * is worked out per pass against the catalog, in `plan.ts`. Writing the answer
 * down instead means a want that silently fetches nothing the day a venue moves.
 */
export interface Want {
  venue:    string;

  /**
   * **Canonical**, not the venue's own — `perp`, never `futures_usdt`.
   *
   * `*` is every market the venue publishes, which is how a want covers one
   * without having to know what they are.
   */
  market:   Market | typeof ANY;

  /**
   * Canonical and bare: `klines`, with the variant beside it rather than in it.
   *
   * `*` is every dataset, and it is the one place a wildcard constrains what
   * else a want may say — see `fixed` and `prefer` below.
   */
  dataset:  Dataset | typeof ANY;

  /**
   * What the files must be, or nothing is fetched at all.
   *
   * Keyed by the level it constrains — `grain`, `scope`, or any level of the
   * dataset's own variant (`interval`, `depth`, `mode`, `aggregation`, `kind`).
   * A venue that publishes none of it yields no files, which is the point: a
   * fixed requirement is *this or nothing*, never *this or something like it*.
   */
  fixed?:   Record<string, string>;

  /**
   * What the files should be where there is a choice.
   *
   * Same keys as `fixed`, and the values are either a literal or `min` / `max`
   * where the level has a size — bar lengths and book depths do, modes and
   * aggregations do not.
   *
   * **Each one applies only if it leaves something.** A venue that stops
   * publishing monthly falls through to daily on its own, and a want for the
   * smallest interval keeps working when the smallest disappears. That is the
   * whole reason a preference is not a filter.
   *
   * **Key order is priority order**, so `{ interval: 'min', grain: 'monthly' }`
   * takes the smallest interval even where that means giving up the monthly
   * rendering.
   */
  prefer?:  Record<string, string>;

  /** The earliest month wanted, `yyyymm`. Absent means as far back as there is. */
  from?:    string;

  /** The last month wanted. Absent means up to whatever the catalog holds. */
  to?:      string;
}

/**
 * One shape a venue publishes, as `GET /venues/:venue/shapes` reports it.
 *
 * The catalog's answer to *what is in here*, which is what a want is resolved
 * against.
 */
export interface Shape {
  market:   string;
  dataset:  string;

  /** The levels below the dataset, named — `{ interval: '1m' }`. */
  variant:  Record<string, string>;

  grain:    Grain;

  /** Named instruments carrying it. */
  symbols:  number;

  /** Venue-wide files carrying every instrument at once. */
  buckets:  number;

  first:    string | null;

  /**
   * The newest file the catalog has seen of this shape.
   *
   * **A measurement, not a verdict** — `null` means nothing has ever been seen.
   * Whether more is expected is `open`.
   */
  last:     string | null;

  /** Whether the catalog still expects files for this shape. */
  open:     boolean;
}

/** How often a shape publishes — the size of the period each file covers. */
export type Grain = 'monthly' | 'daily' | 'hourly' | 'minutely';

/**
 * One want, resolved against one venue: a concrete listing to work through.
 *
 * **A want can produce several.** Asking for klines without naming an interval
 * is asking for every interval the venue has, and each is its own series, its own
 * partition and its own listing.
 */
export interface Plan {
  venue:    string;
  market:   string;
  dataset:  string;

  /** The canonical string the listing filters by — `1m`, `400,incremental`. */
  variant:  string;

  grain:    Grain;

  /**
   * Whether to ask only for the venue-wide file.
   *
   * Set where `scope: bucket` was asked for and the venue has one. The listing
   * then names `@` as its symbol, so the per-instrument files of the same shape
   * are never offered.
   */
  buckets:  boolean;

  from?:    string;
  to?:      string;
}

/** One page of a listing, with wherever it left off. */
export interface Page {
  items: Offered[];
  next:  string | null;
}

/**
 * What became of a page.
 *
 * Three lists rather than two, because "did not arrive" and "arrived wrong" are
 * different claims and prospector acts on them differently: the first asks
 * whether the key is really there, the second says the metadata beside it
 * disagrees with the bytes the venue served.
 */
export interface Report {
  /** Keys now on disk and matching what the catalog said they would be. */
  downloaded: string[];

  /** Keys that would not come, after every attempt. */
  failed:     string[];

  /** Keys whose bytes disagree with the catalog, with what was actually seen. */
  mismatched: { key: string; size?: number; etag?: string }[];
}

/** What happened to one file. */
export type Outcome = 'downloaded' | 'present' | 'failed' | 'mismatched';
