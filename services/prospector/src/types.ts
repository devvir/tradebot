import type { DatabaseSync } from 'node:sqlite';

/**
 * A type alias rather than an interface on purpose: service-kit's `config` is
 * `Record<string, unknown>`, and TypeScript grants an implicit index signature
 * to type aliases but not to interfaces.
 */
export type Config = {
  /** Where the catalog database lives. */
  catalogDir:  string;

  /**
   * The shared secret every request must carry, in `x-catalog-token`.
   *
   * Not a user, a session or a role — one string, checked on the way in. What
   * it protects against is the port being reachable by something that should
   * not be writing here, which matters because this service is meant to run
   * wherever the link to the venues is best.
   */
  token:       string;

  /** Where the API listens. */
  port:        number;

  /** Which venues this run covers; empty means every registered one. */
  venues:      readonly string[];

  /**
   * How many requests this machine will hold open at once, across every venue.
   *
   * **The only limit here that is about us rather than about a venue.** What a
   * venue tolerates is a fact about that venue and lives in its adapter, where
   * the evidence for it is. Every one of those figures can be right while their
   * sum is not: the hosts surveyed today permit several hundred requests in
   * flight between them, none of which is unreasonable on its own, and what came
   * back was connect timeouts on venues that had done nothing unusual. No adapter
   * can see that number, so it is set here.
   *
   * Venues draw from it first come, first served. Nothing is reserved and nothing
   * is divided up — a venue asking for its tenth request waits behind one asking
   * for its first, and a venue surveying alone is bounded only by its own figure.
   */
  concurrency: number;

};

/**
 * A key exactly as a venue's listing names it, with whatever metadata came
 * alongside. The scanner's output; not yet anything the catalog would store.
 */
export interface Listed {
  key:      string;
  size:     number | null;
  etag:     string | null;
  modified: string | null;

  /**
   * The series this key was built from, where it was built rather than read.
   *
   * **A generated key came from a series, so which series it is was a fact
   * before the request was made.** Reading it back off the path asks a parser to
   * recover what the generator had in hand — work that can only agree or be
   * wrong, and being wrong is silent: it files a file under a neighbouring
   * instrument. It once turned one instrument into two series, when `keyFor` and
   * `inspectUrl` drifted.
   *
   * Absent on anything a scanner listed, since an index offers a name and
   * nothing else. Present or absent is the whole question — the reader runs only
   * where this does not answer it.
   *
   * **The period is deliberately not carried alongside.** `dateOf` is the one
   * authority on what date a path carries, and it costs a regex — where a second
   * source for the same fact costs a way for the two to disagree.
   */
  seriesId?: number;
}

/** One page of a survey, and where to resume. `cursor` is null when exhausted. */
export interface Page {
  listed: readonly Listed[];
  cursor: string | null;
}

/**
 * How a family of archives is navigated.
 *
 * **One per platform, not per venue.** Binance, HTX and KuCoin are three venues
 * and one scanner, because all three publish a standard S3 listing that honours
 * `prefix` and `marker`; bybit publishes browsable HTML indexes and answers no
 * listing API at all, so it brings a second. A scanner is named after the shape
 * of the thing rather than after the venue that arrived with it, because the next
 * venue of that shape shares it and no adapter changes.
 *
 * A scanner knows a wire format and nothing else. It does not know what a
 * symbol is, when one was listed, or what a date means — and where descent stops
 * is not a wire format either, so that rule is shared rather than reimplemented.
 */
export interface Scanner<C> {
  name: string;


  /**
   * The scopes worth surveying independently — for a listing venue, the prefixes
   * to walk in parallel.
   *
   * Discovered from the venue rather than declared by the adapter: a list kept in
   * code is only ever as complete as the last person to look, and the dataset
   * nobody knew about is exactly the one a catalog is for.
   */
  scopes(context: C, limits: Limits): Promise<string[]>;

  /** One request's worth of a scope, resuming from `cursor`. */
  page(context: C, scope: string, cursor: string | null): Promise<Page>;

  /**
   * What sits immediately inside a prefix — the child directories, and whether
   * any key here would be catalogued.
   *
   * Descent has always needed this; it is exposed because **splitting a
   * partition needs it too**. A walk that turns out to be carrying a
   * disproportionate share of the archive is refined into its children, and
   * that decision is the same question descent asks on the way down.
   *
   * A scanner that cannot answer it is never refined, which is the honest
   * outcome for one whose scopes are not prefixes at all.
   */
  level?(context: C, prefix: string): Promise<Level>;

  /**
   * What the venue says about one key, right now.
   *
   * **The cheapest question each platform can answer about a single file.** A
   * listing venue asks for that one key and reads the row back; an index venue
   * has no listing to ask, so it sends a `HEAD`. Same answer either way, and
   * neither caller needs to know which happened.
   *
   * It exists for one job: checking a claim from outside before the catalog
   * believes it. A downloader reporting bytes that differ from what was recorded
   * is almost always right — an archive is insert-only unless somebody erred —
   * but "almost always" is not a thing to write into a database on, and the
   * alternative to asking is finding out at the next full survey, days away.
   *
   * Null means the venue does not serve that key at all.
   */
  confirm(context: C, path: string): Promise<Listed | null>;
}

/**
 * What bounds a descent, passed in rather than read from config by the scanner.
 *
 * One number, and it is the one the mapping is actually for: split until there
 * is work for every lane. A fanout width would be the other candidate, and it is
 * deliberately absent — it is a guess about where the symbol level sits, which
 * nothing about a tree's shape supports.
 */
export interface Limits {
  concurrency: number;
}

/**
 * What one level of a venue's tree holds, as descent needs to see it.
 *
 * The one shape every scanner can answer in, whatever its wire format: the child
 * directories worth descending into — already filtered, so a prefix is judged on
 * the children that count — and whether any key sitting directly here is one this
 * venue would catalogue.
 */
export interface Level {
  children: string[];
  files:    boolean;
}

/**
 * How a scanner reads one level. The only thing descent needs from a wire
 * format, and therefore the whole seam between the two.
 */
export type ReadLevel = (context: ListingContext, prefix: string) => Promise<Level>;

/**
 * What a scanner of a **listed** archive needs, and the whole of it.
 *
 * Built by the adapter and handed over by the core, so the scanner never holds
 * the adapter itself. That distinction is not cosmetic: an adapter carries the
 * venue's whole configuration, and a scanner reaching into it can quietly come
 * to depend on anything there — while a scanner given a context can only use
 * what it was promised.
 *
 * `text` and `head` arrive **already paced, retried and labelled**. Rate is a
 * fact about a host and belongs to the core's limiter, not to a scanner that
 * happens to be pointed at it, so a scanner cannot exceed a cadence or forget to
 * observe one.
 */
export interface ListingContext {
  /** Names the venue in logs and in exclusion lookups. */
  name:    string;

  /** Where a listing is served — the endpoint the scanner queries. */
  list:    string;

  /** Where files are served, and the prefix every key shares. */
  base:    string;
  root:    string;

  /** The adapter's own rules, which descent applies while deciding where to go. */
  accepts?(path: string): boolean;
  dateOf(path: string): string | null;

  text(url: string): Promise<string>;
  head(url: string): Promise<Probed>;
}


export interface OkxContext {
  ranges: readonly Publishing[];
  base:   string;
  root:   string;
  head(url: string): Promise<Probed>;
}

/**
 * Why a context is being built, and therefore how much an adapter may do to
 * build it.
 *
 * - `'full'` — walk the venue's whole keyspace. The adapter goes back to the
 *   venue and brings its own knowledge up to date, however long that takes.
 * - `'partial'` — find what has appeared since. It still reconciles, because
 *   that is the only way a new symbol is ever discovered: probing can only ask
 *   about series it already knows.
 * - `'lookup'` — **reach no venue at all.** This is what an HTTP handler passes
 *   to confirm a single key inside a request; an adapter that fetched here would
 *   turn one confirmation into an unbounded call in a request handler. It is not
 *   a kind of survey and never starts one.
 *
 * **Decided by the request, not by the state.** An earlier version inferred it
 * from whether a job happened to be open, which made "continue where you left
 * off" mean "re-establish everything" for any venue whose job had closed.
 */
export type Occasion = 'full' | 'partial' | 'lookup';

/**
 * Where a venue's one run has got to.
 *
 * **Read entirely off the run rows** — nothing records this separately, because
 * two places to keep it is two places to disagree.
 *
 * - `'not run'` — nothing exists yet
 * - `'planned'` — scopes created, none with progress. A brief phase
 * - `'running'` — at least one scope still has keyspace ahead of its cursor
 * - `'complete'` — every scope exhausted, and nothing has been added since.
 *   Transient: new data makes it incomplete again within a day
 * - `'updating'` — every scope exhausted and the venue has been complete before,
 *   so what is left is finding what has appeared since
 *
 * Reaching `complete` once changes the venue permanently: it never goes back to
 * walking scopes it has already exhausted.
 */
export type Phase = 'not run' | 'planned' | 'running' | 'complete' | 'updating';

/**
 * The context type a scanner requires, read off the scanner itself.
 *
 * Lets an adapter be declared against **its scanner** rather than against a
 * shape it would otherwise restate — `Adapter<typeof s3>` — so the two cannot
 * drift apart. A venue wired to a scanner it cannot supply is a compile error
 * instead of one that surveys to nothing.
 */
export type ContextOf<S> = S extends Scanner<infer C> ? C : never;

/**
 * What one directory of a browsable index holds, split the only way an index
 * splits: the child directories, and the keys.
 *
 * Unlike `Level` this is the raw reading rather than the answer descent wants —
 * a walk needs the keys themselves, not merely whether any of them counts.
 */
export interface Entries {
  children: string[];
  keys:     string[];
}

/**
 * One server, and exactly one row of the catalog's `venue` table.
 *
 * **Not one per venue.** A venue is the name somebody asks for; a server is an
 * address with its own shape and its own limiter, and bybit is one venue on two
 * of them. The pair `(name, host)` identifies an adapter and is what the catalog
 * stores, so the rule that actually holds is one adapter per row — whatever
 * splitting a venue turns out to need. If one host ever served two trees that had
 * to be navigated differently, that would be another row and another adapter, and
 * this stays one to one.
 *
 * An adapter declares *where* an archive is and how to read a date out of a
 * path, and delegates *how to navigate it* to a scanner. That split is what
 * makes three S3 venues cost three small files rather than three copies of a
 * paging loop, and a venue on another platform cost one file and one scanner.
 *
 * Nothing here may contain control flow. If an adapter grows a loop, the loop
 * belongs in a scanner.
 *
 * `Scanner<any>` rather than a narrower bound: adapters of different scanners
 * live in one registry, and any stricter parameter makes that array's element
 * type collapse to `never` at every call site. Nothing is lost — the core only
 * ever hands a context straight back to the scanner it came from.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export interface Adapter<S extends Scanner<any> = Scanner<any>> {
  /** Venue id: the config token, and the venue's name in the catalog. */
  name: string;

  /**
   * Which of the venue's servers this adapter surveys.
   *
   * **A venue is not always one address.** Bybit publishes its order books on a
   * different host from everything else, with a different shape and a different
   * limiter — so the pair `(name, host)` is what identifies a server, and it is
   * what `paceFor` keys on. A stand-down on one host must not stop the other,
   * and neither should spend the other's budget.
   *
   * Empty means the venue has one server, which is the ordinary case. The label
   * is deliberately arbitrary: it names neither the technology nor the contents,
   * because both move — both bybit hosts are CloudFront today and either could
   * serve what the other does — so a label carrying no fact cannot go stale.
   */
  host?: string;

  /** How this venue's archive is navigated. */
  scanner: S;

  /**
   * Everything this venue's scanner needs, assembled once before the walk.
   *
   * **The seam between a venue and the code that reads it.** A scanner is shared
   * by every venue of its shape and must not know which one it is serving; an
   * adapter knows its venue and nothing about how the catalog is stored. This is
   * where the two meet: the adapter builds what its scanner asked for, and the
   * core carries it without looking inside.
   *
   * The database handle is here for the one case that needs it. A venue with no
   * listing has to know its own bounds before it can construct a single key, and
   * those bounds are expensive to establish and belong to the venues that share
   * them — a private table, not something the core should model or the scanner
   * should reach for. Whatever is done with it is the adapter's business.
   *
   * Called wherever work on a venue begins, including a resume, because a
   * context is held in memory and a restart has none.
   */
  getContext(db: DatabaseSync, occasion: Occasion): Promise<ContextOf<S>>;


  /**
   * What this venue tolerates, where it differs from the default.
   *
   * A venue's own property, like everything else in an adapter: bybit bans an
   * address that asks too fast and says so only in a CloudFront error page,
   * while a bucket nobody else reads may take far more. Left out means the
   * caller's default, which is deliberately timid.
   */
  pacing?: Partial<Pacing>;

  /**
   * Whether this venue's files need a probe to establish their metadata.
   *
   * **The venue's property, not the scanner's.** A listing carries size and
   * checksum, so a venue that publishes one is settled by the walk alone and
   * probing it would be a request per file to learn what we already have. A
   * venue that publishes indexes carries neither, and its catalog stays a list
   * of paths until something asks.
   */
  probes?: boolean;

  /** Where the listing is served — the endpoint the scanner queries. */
  list: string;

  /** Where files are served, without a trailing slash. */
  /**
   * **Read from the `venue` row at startup, never declared here.**
   *
   * Where a venue is and what prefix it is rooted at are constants of the
   * application that live in the database so everything can join against them —
   * see the `venues` migration. An adapter restating them would keep one unit of
   * information in two places.
   */
  base: string;

  /**
   * The prefix every key shares, and where descent starts.
   *
   * Removed from the stored path, because it is how the bucket is addressed
   * rather than a meaningful level of organisation. A URL is rebuilt as
   * `base` + `/` + `root` + `path`.
   */
  root: string;

  /**
   * What to make of a probe that did not settle, given how often it has failed.
   *
   * Called for every non-settling answer, including a refusal, so an adapter can
   * distinguish "not there" from "not now" using headers the core deliberately
   * does not interpret. It may decline — see `Verdict` for the rule that applies
   * when it does, which is what every venue uses today.
   */
  ruleOnFailure?(status: number, headers: Headers, tries: number): Verdict;

  /**
   * Whether a refusal is aimed at **us** rather than at one key.
   *
   * The core's own reading is that a 403 or 429 which does not name an object is
   * the venue turning the address away — see `blocked` in `http.ts` — and it is
   * the safe reading, because standing a venue down costs minutes where being
   * banned costs the venue.
   *
   * **It is wrong wherever a bucket refuses to admit what it does not have.**
   * bitget's grants `GetObject` and not `ListBucket`, so every key it has never
   * held answers `403 AccessDenied` from S3, exactly as a real refusal would.
   * A venue in that position has to say which is which, and it can: its own
   * origin answering is a statement about the object, where its CDN answering
   * for the origin is a statement about us.
   */
  refusesUs?(status: number, headers: Headers): boolean;

  /**
   * The statuses this venue answers with when a key is not there.
   *
   * **Defaults to `404`, and most archives need nothing else.** A bucket that
   * grants `GetObject` without `ListBucket` cannot say `404` without admitting
   * what it does not have, so it says `403` instead — S3 does this, and so do
   * several CDNs, deliberately, so that absence cannot be probed for.
   *
   * **Only for venues where the status alone settles it.** Where the same status
   * also means *we* are being turned away, the two are separable by headers
   * rather than by code, and that is `refusesUs` and `ruleOnFailure` — listing
   * the status here would read a genuine refusal as a missing file and record
   * absence while being blocked.
   */
  notFoundCodes?: readonly number[];

  /**
   * What to make of a probe that **did** settle — and what it implies about keys
   * nobody has generated.
   *
   * **Because one key can name only part of a period.** bitget splits a day's
   * trades every hundred thousand rows, into `…_001`, `…_002`, and on past a
   * hundred; nothing in the path says how many there are, and the only way to
   * learn is that the last one 404s. Generation cannot know that — it builds a
   * key from a pattern and a date — so the venue says it here, as each part
   * arrives.
   *
   * - `action: 'accept'` — settle the file as usual.
   * - `action: 'replace'` — discard it; it never reaches `file`. For an archive
   *   whose published key is a manifest rather than the data.
   * - `next` — keys to park in `wip`, inheriting this row's series and date.
   *
   * Returning nothing is the ordinary case and behaves exactly as before.
   *
   * **It is handed the whole row, not just the path.** What a venue makes of an
   * answer can depend on which series the key belongs to and which period it
   * covers, and both are already known — the key was generated from them. A hook
   * given only the string would have to parse back out what the caller already
   * holds.
   */
  ruleOnSuccess?(row: Unsettled, size: number | null): Succession | null | void;

  /**
   * The date a path carries, as `yyyymmdd`, or null when it carries none.
   *
   * The one thing that cannot be recovered generically, and therefore the whole
   * reason an adapter exists for venues that would otherwise need no code.
   *
   * Returning null also means "not a file worth cataloguing", which is how
   * checksum sidecars fall out for free: `…-2025-01.zip.CHECKSUM` matches no
   * date pattern, so it is never stored, and every S3 page yields half as many
   * rows as it does keys.
   */
  dateOf(path: string): string | null;

  /**
   * What a path **is** — which series it belongs to and what date it carries.
   *
   * Where `dateOf` reads one field out of a key, this reads the whole of it, and
   * it is what keeps the series table filled as a walk discovers things. It is
   * venue knowledge and always will be: pulling a market, a symbol and a dataset
   * out of a path is a handful of expressions nobody can write generically.
   *
   * **Reading, never enumerating.** An adapter does not need to know that
   * `BTC-USDT` is a symbol — only *where a symbol sits* in each of its patterns.
   * It takes the substring out by position; nothing holds a list of instruments
   * to match against.
   *
   * **Optional, and the venues without one behave exactly as before.** A venue
   * whose patterns have not been read out of its archive yet simply records no
   * series, which is a gap rather than a lie.
   */
  inspectUrl?(path: string): Inspection;

  /**
   * Every instrument this venue lists, for the preamble that runs before an
   * update generates anything.
   *
   * **Optional, and a venue without it discovers nothing.** Its series then come
   * only from a walk or a seed, which is correct but leaves a symbol listed
   * since the last full pass unreachable until the next one.
   *
   * Returns everything, across every market the venue serves, already
   * canonicalised — see `Instrument`. How many calls that takes is the adapter's
   * business: binance needs four hosts and htx four endpoints, and none of that
   * reaches the core.
   */
  instruments?(db: DatabaseSync): Promise<Instrument[]>;

  /**
   * How the archive spells an instrument under one shape, where that differs
   * from the venue's own name for it.
   *
   * **The other direction of `inspectUrl`.** Reading a path, an adapter says
   * which instrument a key belongs to and records the archive's spelling beside
   * it — that is `Found.urlSymbol`, and it is how a walk gets this right. But a
   * newly listed instrument arrives from a *listing*, with no path to read, and
   * the preamble creates a series for it under every shape of its market. This
   * is what it asks so those series generate working URLs before any walk has
   * seen one.
   *
   * **Per shape, not per instrument**, which is the whole reason it takes the
   * `Found` rather than a symbol: kucoin writes one spot pair as `0G-USDT`
   * under books and `0GUSDT` under klines and trades, so the answer depends on
   * the dataset as much as on the name.
   *
   * Undefined — for a shape, or by an adapter not implementing it at all —
   * means the archive spells it exactly as the venue does, which is the ordinary
   * case and every other venue here.
   */
  urlSymbolFor?(of: Found): string | undefined;

  /**
   * Which of the venue's listing categories a pattern's keyspace serves.
   *
   * **For a venue whose one canonical market is more than one archive.** Binance
   * files perpetual swaps under `futures/um` and `futures/cm` — two products,
   * two endpoints, two trees — and both are `perp` here, because both are
   * perpetual swaps and a consumer asking for `perp` wants both. That collapse
   * is right for answering questions and wrong for creating series: an
   * instrument is domiciled in exactly one of the two, so half the market's
   * patterns describe keys it can never have.
   *
   * So the adapter says which category each pattern writes to, the instrument
   * carries the category it was listed under, and the preamble refuses the pairs
   * that disagree — see `patternsFor`.
   *
   * **Null for a pattern that serves every category**, which is the answer for
   * every pattern of a venue with one archive per market. Omitting the hook says
   * the same thing for all of them, so nothing changes for a venue that does not
   * split — and a venue that splits without saying so behaves exactly as it does
   * today rather than losing series.
   */
  categoryOf?(pattern: string): string | null;

  /**
   * Slots this venue's patterns use that the shared vocabulary does not.
   *
   * **The core renders a calendar; a venue's oddities render themselves.**
   * `{YYYY}` `{MM}` `{DD}` `{HH}` `{MI}` are what every archive here is built
   * from, and generating a key is slicing a stamp into them. Two venues want
   * something else — bybit names a month by both its ends, gate names a file by
   * the instant it covers in Unix seconds — and neither is a shape worth
   * teaching every venue about.
   *
   * Given the stamp, returns the slots to fill and what to fill them with. A
   * slot's name ends in the grain it steps at, so `{EPOCH_HH}` is read as hourly
   * by the same rule that reads `{HH}` — which is how a venue can invent a slot
   * without the catalog having to be told its cadence separately.
   */
  slotsFor?(at: string): Record<string, string>;

    /**
   * Whether this venue's archive can be listed at all.
   *
   * **False means it starts where the others end.** A venue with no listing has
   * nothing to walk, so its series arrive by declaration rather than discovery
   * and its very first pass is an update — the same code path an indexed venue
   * reaches once its walk is behind it, doing more work the first time round.
   *
   * Default true, because most archives are listings.
   */
  listable?: boolean;


  /**
   * Whether a path belongs in the catalog at all. Defaults to accepting
   * everything the scanner offers.
   *
   * **Asked of directories as well as files, so a pattern must hold for both.**
   * A refused directory is not descended into — it is ignored as though it were
   * not there, rather than walked and discarded key by key. Write a pattern that
   * matches only whole keys and a scanner will walk the whole tree beneath it to
   * store nothing; write one that catches a directory it should not and the tree
   * disappears silently, which is the expensive direction. Note how binance's
   * `data3` rule uses the trailing slash to tell a directory from the stray key
   * it is aimed at.
   *
   * This is where a venue states **policy**, as distinct from `dateOf` stating
   * what a path *is*: a key with no date is not a file we can place, while a key
   * this rejects is one we can place and have decided not to keep.
   *
   * **Only things that are not proper historical data** belong here — a bucket
   * root's web assets, binance's `data2/` staging area littered with loose `.csv`
   * beside its own `.zip` and a `.DS_Store`, stray keys directly under `data3/`.
   * Surveying from the root is the only way to see `data3/liquidationSnapshot/`,
   * which exists nowhere else, and this filter is what makes that safe.
   *
   * **Unannounced is not the same as dead**, and only the second is refused.
   * Data nobody advertised is exactly what a catalog is for — bybit's option
   * trees are catalogued *because* nothing else names them, and whether an
   * unreliable or superseded rendering is worth using stays the consumer's call.
   *
   * **What settles it is reading the data, not comparing its bytes.** Binance's
   * `/data/spot/` tree was kept on exactly that reasoning until somebody opened
   * both renderings: same values under different decimal padding, and truncated
   * where the tree was abandoned mid-month. A rendering that holds strictly less
   * than another is not a second copy anybody could choose between, and it is
   * refused — see `docs/venues/BINANCE.md`.
   *
   * What does not belong is data nothing could ever be done with: a tree
   * abandoned after two months, or a venue that closed before we collected any
   * of it. Costing nothing to keep is not the test — a strategy cannot be
   * trained against a book that no longer trades, and establishing whether some
   * stub is useful costs days that its contents can never repay. BitMEX is where
   * the line falls: its history earns its place because it was collected while
   * the venue ran, not because the files happen to exist.
   *
   * This is the half of exclusion that can only be **described**. A list of
   * specific known-bad files — gate's 2021-07 futures trades, where 85 symbols
   * are truncated copies of the corresponding *spot* data — is an enumeration
   * that grows as more are found, so it belongs in the `exclusion` table, which
   * prospector reads and never writes. Finding one should cost a row, not a
   * rebuild.
   */
  accepts?(path: string): boolean;
}

/**
 * What one pass at one venue did.
 *
 * `failed` is the load-bearing one: a job closes only when it is zero, because a
 * partition that threw still has keyspace nobody has read, and closing the job
 * around it would claim the whole venue was established.
 */
export interface Survey {
  venue:      string;
  partitions: number;
  requests:   number;
  found:      number;
  failed:     number;

  /**
   * Whether every partition finished, so there is no keyspace left to read or
   * generate.
   *
   * **Not the same as the pass being over.** On an update the generated keys are
   * in `wip` and mostly unasked at this point; the pass ends when they have been
   * drained and the tips settled. The update's rows stay on record until then,
   * which is what lets a restart in between resume rather than re-plan.
   */
  generated?: boolean;

  /**
   * Whether the venue refused **us** rather than a prefix.
   *
   * Load-bearing for pace rather than for correctness: a job that failed because
   * a venue is blocking this address must not be retried in thirty seconds,
   * because a ban lapses only while nothing is asking. The partitions keep their
   * cursors either way.
   */
  blocked:    boolean;

  /** Whether it stopped because a stop was asked for, rather than finishing. */
  paused:     boolean;
}

/**
 * How hard to push a venue, and what to do when it pushes back.
 *
 * **Passed in rather than chosen, because no two venues agree.** One publishes a
 * budget, one publishes nothing and blocks the address that guesses wrong, one
 * is a bucket nobody else is reading. The same is true across use cases: a
 * backfill of millions of files and a re-check of one month want different
 * trades between speed and the risk of being turned away.
 *
 * The rate is the part that matters. A venue budgets requests per second, and
 * concurrency only sets a rate by accident — multiply it by whatever latency
 * happens to be that day.
 */
export interface Pacing {
  /**
   * Requests per second, across every caller.
   *
   * **The only real limit here.** A venue counts requests from an address, so
   * this is counted per venue and every request — a walk's listing, a probe's
   * HEAD, a retry of either — passes the same gate. See `pace.ts`.
   */
  perSecond:   number;

  /** How many requests may be waiting at once. A bound on the queue, not the rate. */
  concurrency: number;

  /** The longest a stand-down may grow to, however often a venue keeps refusing. */
  ceilingMs:   number;

  /**
   * Refusals tolerated while **nothing** has settled before a pass gives up.
   * A venue that has answered nothing is refusing us rather than throttling us.
   */
  giveUpAfter: number;

  /**
   * How long to leave a venue alone after it refused **us** rather than a key.
   *
   * A ban lapses only while nothing is asking, so this is a wait, not a
   * slowdown. The first stand-down is this long and each repeat doubles it up to
   * `ceilingMs`.
   *
   * **Short to start with, because most refusals are not bans.** A venue whose
   * edge served one bad minute is back within seconds, and waiting out ten of
   * them costs a survey far more than asking again does. The doubling is what
   * finds a real ban: a venue that keeps refusing walks up to `ceilingMs` in a
   * few rounds, and one that refused once is not punished for it. A venue that
   * needs longer says so in its adapter, as bybit does — its ban lifts on its
   * own after "at least 10 minutes", which is a measurement of that venue rather
   * than a default for everybody.
   */
  standDownMs: number;

  /** Rows per query: large enough to amortise, small enough to commit often. */
  batch:       number;
}

/**
 * What a venue is being sent right now.
 *
 * Reported when it turns us away, because **the rate at that moment is the only
 * measurement that says anything about where its limit is**. An average over a
 * pass answers a different question — it includes every second spent paused, so
 * it is guaranteed to understate exactly the number being looked for.
 */
export interface Rates {
  /** Requests in the last second. */
  lastSecond:    number;

  /** Requests per second, averaged over the last five and ten. */
  last5Seconds:  number;
  last10Seconds: number;

  /**
   * Requests per second, averaged over the last minute and the last hour.
   *
   * **What a pass actually runs at**, as against the windows above, which exist
   * to catch a burst. A steady survey is judged over minutes — a ten-second
   * figure on a venue that pauses reads as a collapse whenever a stand-down
   * happens to fall inside it, and as full speed whenever one does not.
   *
   * Averaged over the time actually elapsed until each window fills, so a
   * service two minutes old does not report an hourly rate a fiftieth of the
   * truth.
   */
  lastMinute:    number;
  lastHour:      number;

  /** The busiest second seen since the process started. */
  peakPerSecond: number;

  /** Requests sent and not yet answered. */
  inFlight:      number;

  /**
   * Every request sent to this venue since the process started, retries
   * included — the figure to compare against a venue that budgets a total over
   * a window rather than a rate, which is the other shape a limit comes in.
   */
  sentTotal:     number;

  /**
   * How many of those were another attempt at a request already made.
   *
   * **Counted where the ladder turns, not inferred by subtraction.** The obvious
   * arithmetic — sent minus answered — is wrong on both terms: what a caller
   * counts as answered is per pass and excludes what is still in flight, while
   * this counts per host since the process started. The difference between them
   * is mostly neither.
   */
  retries:       number;
}

/** What a HEAD came back with: a status the caller must weigh, and the headers. */
export interface Probed {
  status:  number;
  headers: Headers;
}

/**
 * Where a probe gets its work.
 *
 * Supplied rather than queried, so what is probed is the caller's business: the
 * files of one venue today, a table of constructed candidates for a venue that
 * cannot be listed at all, a re-check of one month.
 */
export interface Work {
  /** The next rows after this id, in the order they were parked. Zero starts. */
  next(after: number, limit: number): Unsettled[];

  /**
   * How many are outstanding, where the caller can say cheaply.
   *
   * Read once, at the start, and reported once. It cannot be the progress
   * figure: whichever half is producing keeps writing new rows the whole time,
   * so a total captured here is overtaken by the pass settling them.
   */
  remaining?(): number;

  /**
   * How many findings the producing half has written so far, where the caller
   * can say cheaply.
   *
   * **The number that makes progress readable**, and the reason it comes from
   * the producer rather than from a count of what is left: "settled 96,000"
   * says nothing about whether that is nearly all of it or a tenth of it, and
   * counting `wip` every heartbeat is a scan of millions of rows for one line.
   * Read on every heartbeat, so it moves.
   */
  produced?(): number | null;
}

/**
 * What one pass of a probe did.
 *
 * `missing` and `refused` are counted rather than acted on: a 404 may be a
 * withdrawal or a bad minute at a CDN, and a 403 may be a policy or a block.
 * Neither is a claim this service makes on its own.
 */
export interface Probe {
  venue:    string;
  settled:  number;
  missing:  number;
  refused:  number;
  failed:   number;
  requests: number;

  /**
   * Rows given up on and removed from the work list this pass.
   *
   * Separate from `missing`, which counts answers: a key can be missing on every
   * pass for a year without ever being dropped. This counts the decision, and it
   * is the number that says whether a backlog of constructed candidates is
   * actually shrinking.
   */
  dropped:  number;

  /**
   * Keys parked because an answer implied them, rather than because anything
   * generated them.
   *
   * The next part of a split file is the case — see `ruleOnSuccess`. Counted
   * apart from everything else because it is the one number that grows the work
   * list while a pass is draining it, which otherwise reads as a probe that
   * cannot finish.
   */
  implied:  number;

  /**
   * Rows the venue answered as *not there* — however this venue spells it.
   *
   * **A subset of `missing`, and the one that means something.** `missing`
   * counts every 404-shaped answer including the ones an adapter overruled;
   * this counts only those that took a step towards being confirmed absent. It
   * is what separates a venue working through a trailing edge from one that has
   * simply stopped answering, which nothing else in these counts can say.
   */
  absent: number;

  /**
   * Whether the pass stopped early rather than running out of work.
   *
   * **Stated, not inferred.** A caller reading the counts cannot tell the two
   * apart: a pass that settled thousands of rows and was then blocked has the
   * same shape as one that finished, so guessing from them reports a venue that
   * just turned us away as an idle one with nothing left to do.
   */
  abandoned: boolean;

  /**
   * Whether a person asked the venue to stop, and this pass did.
   *
   * Separate from `abandoned`, which is the venue's doing: one is a service
   * waiting out a refusal it expects to lapse, the other is somebody deciding
   * the venue should not be asked at all. They end the pass at the same place
   * and mean opposite things about whether it should resume on its own.
   */
  stopped: boolean;
}

// ── The catalog ───────────────────────────────────────────────────────────────
//
// Prospector is the only thing that opens the catalog, so these live here
// rather than in a package of their own — a boundary with one thing on each
// side costs without buying.
/**
 * What is known about a key being a file.
 *
 * **`confirmed` and `assumed` are the two ways a candidate gets into `wip`**, and
 * they differ in who said so: a listing named the key, or this service built it
 * from a pattern and a date. That decides how hard absence is worth confirming —
 * a venue withdrawing something it advertised is unusual and worth several
 * passes, while a guess that misses is simply a guess that missed.
 *
 * **It is a property of the row, not of the pass.** A restart between a walk and
 * the update that drains its backlog would otherwise judge walked candidates as
 * guesses.
 *
 * `absent` is a ruling and belongs to `file`: a key that was there and is not
 * any more.
 */
export type Existence = 'unknown' | 'confirmed' | 'assumed' | 'absent';

/**
 * One step from one schema version to the next.
 *
 * **Frozen once it has shipped.** Editing one changes nothing on a database that
 * already ran it and silently diverges the two — see `database/migrations/` for
 * the chain and what each step was for.
 */
export interface Migration {
  name: string;

  /** Plain SQL, for anything expressible as a statement or three. */
  sql?: string;

  /**
   * For a migration carrying **rows** rather than shape. Thousands of them are a
   * prepared statement in a loop, not a megabyte of generated `INSERT` text.
   *
   * `seedData` is passed so that a migration carrying *both* can apply its shape
   * and decline its rows. Only the first needs it: a catalog without tables is
   * not a catalog, while a fixture putting three files in one wants to own the
   * venue ids rather than inherit eight it did not ask for.
   */
  run?(db: DatabaseSync, seedData: boolean): void;

  /**
   * Whether this migration ships **findings** rather than structure.
   *
   * A catalog is not correct without it — okx's ranges are as much a part of
   * what this service knows as the tables holding them — but a test fixture
   * asking for an empty catalog to put three files in does not want twelve
   * thousand rows of another venue's history first. Marked, so it can be
   * declined deliberately rather than by guessing at the environment.
   */
  seedData?: boolean;
}

/**
 * One instrument a venue lists, as its adapter reports it.
 *
 * **`symbol` is spelled the way the archive spells it, not the way the API
 * answers.** The catalog's `symbol` is defined by the files: `inspectUrl` parses
 * it out of a path, and everything downstream matches against that. An API
 * answering `btcusdt` where the archive writes `BTC-USDT`, or `BTC/USDT` where
 * it writes `BTC_USDT`, is the adapter's to reconcile — the same job it already
 * does for markets and datasets, at the same boundary. The symbol-set comparison
 * in the preamble is what proves it was done.
 *
 * **`live` is false where the venue says so, and absence says it too.** Some
 * venues publish their dead — htx returns 1,547 offline spot symbols beside 609
 * online, bybit answers `status=Closed` on request — and taking "absent from the
 * list" as the only signal would read those as alive. Where a venue lists only
 * what it trades, everything omitted is not live, which the preamble works out
 * for itself.
 *
 * `category` is the venue's own word for the contract type, kept unparsed
 * because it decides things no other field can — bitget files a trades series
 * under a token that is the instrument's margin type, and only the category says
 * which. `launchedAt` is where a search for a first file would start: nothing was
 * published before the instrument existed. Both are optional, because most
 * venues need neither.
 */
export interface Instrument {
  /** Canonical, as `pattern.market` records it. */
  market:      string;

  /** As the archive spells it. */
  symbol:      string;

  /** Whether the venue still lists it for trading. */
  live:        boolean;

  category?:   string;
  launchedAt?: string | null;

  /**
   * What a venue says an instrument *is*, where it says more than its category.
   * Bitget lists equities and dated contracts beside its perpetual crypto, and
   * only these tell them apart - see its `marketOf`.
   */
  symbolType?: string;
  isRwa?:      string;
  type?:       string;

  /**
   * What this instrument substitutes into the `{TRANSFORM:kind:default}` slots
   * of its patterns, where the venue's default is not right for it.
   *
   * **Stated by the listing, because that is where it is known.** Which margin
   * line a bitget futures contract files its trades under is a property of the
   * endpoint that listed it and of nothing else - not of its symbol, not of its
   * market, and not of any path. Read at the moment the listing is, exactly as
   * `category` is, or it is not recoverable at all.
   *
   * The preamble writes these when it creates the instrument's series. Absent on
   * almost every instrument of almost every venue.
   */
  transforms?: readonly DeclaredTransform[];
}

/**
 * A transform an instrument declares about itself, before anything has placed it
 * in a catalog.
 *
 * **The venue, market and symbol are left out because the caller already holds
 * them.** An adapter states what its instrument substitutes; which venue row and
 * which canonical market that lands under is the preamble's to fill in, and a
 * second copy here would be free to disagree with the series it belongs to.
 */
export type DeclaredTransform = Omit<Transform, 'venueId' | 'market' | 'symbol'>;

/**
 * What bitget's own trading-platform search states about one instrument.
 *
 * **Two things no rule reliably derives.** `symbolCode` is the archive's
 * spelling, which matters because the venue re-issues tickers: a derived name
 * that happens to be the plain one belongs to whoever held it first. And
 * `symbolId` carries the margin line as its suffix — `…_SPBL`, `…_UMCBL`,
 * `…_DMCBL`, `…_CMCBL` — which is otherwise only inferable from the category the
 * instrument was listed under.
 */
export interface Searched {
  /** The archive's spelling of this instrument. */
  spelling: string;

  /** The margin line its keys sit under, or null where the reply did not say. */
  token:    string | null;
}

/**
 * A failure, reduced to what is worth logging.
 *
 * `cause` is the code behind it — `ETIMEDOUT`, `ECONNRESET`, `ENOTFOUND` — which
 * is what a reader acts on. `stack` appears only when there is no such code,
 * because a trace of a recognised network failure is the same frames every time.
 */
export interface Fault {
  error:  string;
  cause?: string;
  tried?: number;
  stack?: string;
}

/** All a probed venue needs to answer about one key: an address, and one request. */
export interface ProbedContext {
  base: string;
  root: string;
  head(url: string): Promise<Probed>;
}

/**
 * What one venue's preamble did, for the line that reports it.
 *
 * `refused` is the one worth watching: it means the venue's own names and the
 * archive's did not agree well enough to act on, so nothing was created and
 * nothing was retired.
 */
export interface Preambled {
  listed:   number;
  created:  number;
  revived:  number;
  delisted: number;

  found:    number;
  refused:  boolean;
}

/**
 * What one venue's reconciliation moved, for the line that reports it.
 *
 * `lifted` is nearly every series on an ordinary pass — a tip at the floor is
 * the resting state of anything not publishing daily — so it says the step ran
 * rather than that anything was learned. `started` and `ended` are the ones
 * worth watching: they are measurements, and they only ever happen once per
 * series.
 */
export interface Reconciled {
  lifted:  number;

  /**
   * Series whose `first` or `last` disagreed with their own files and were set
   * back to them.
   *
   * **Expected to be zero, and worth saying when it is not.** Bounds are written
   * as files are seen, so a correction here means some path moved one without
   * the archive backing it — a withdrawal, which lowers nothing when it happens,
   * or a defect. Either way the number is the count of rows that were claiming
   * something the files do not.
   */
  corrected: number;

  /**
   * Series deleted: a completed pass asked about every period they cover and the
   * archive held a file for none of them.
   *
   * There is no end to find because there was never a beginning, and a row that
   * records only an absence is not worth keeping — it would cost `OVERDUE_DAYS`
   * of keys a day for ever. Whether the venue still lists the instrument does not
   * enter into it: an empty series is empty either way.
   *
   * Deleting is safe because it is reversible by the venue. A listed symbol on a
   * live shape is created again by the next preamble and backfilled; one whose
   * symbol is gone, or whose shape is retired, stays gone.
   *
   * The only removal reconciliation does. An *end* for a series that did publish
   * is a different question, answered by `open` from the tip.
   */
  removed: number;
}

/** What kind of work a discovery run is doing, and therefore what `cursor` means. */
export type RunKind = 'walk' | 'probe' | 'update';

/**
 * A venue, as the catalog knows it: a name and enough to rebuild a URL from a
 * stored path.
 *
 * The two URL parts live here rather than in code so that a consumer can turn a
 * row into something fetchable without knowing anything about venues. `base` is
 * where files are served from, `root` the prefix every key shares and which the
 * stored path has had removed.
 */
export interface Venue {
  id:   number;
  name: string;
  base: string;
  root: string;
}

/**
 * One file a venue publishes.
 *
 * `path` is the key with `root` removed, and is unique per venue by
 * definition — a venue cannot serve two different files at one URL.
 *
 * `date` is the only field the catalog interprets, and it exists because
 * month-major ordering is a hard requirement downstream.
 */
export interface CatalogFile {
  /**
   * The series this file belongs to.
   *
   * Required: a row that cannot say what it is of answers none of the questions
   * the catalog is asked. A path no reader can place goes to `unreadable`
   * instead of arriving here without one.
   */
  seriesId:  number;

  venueId:   number;
  path:      string;
  date:      string;
  size:      number | null;
  etag:      string | null;
  modified:  string | null;
  existence: Existence;

  /** First discovery. Never moves once set. */
  seenAt:    string;
}

/**
 * A file whose metadata nobody has established, as a probe needs to see it.
 *
 * Deliberately the fields that identify a row and order the work, and nothing
 * else: a probe fetches by URL and walks by id, and carrying more would tie it
 * to what a walk happens to store.
 */
export interface Unsettled {
  /**
   * Where this row sits in the queue. The sweep advances by it rather than by
   * date, so a row parked behind a cursor that has already passed its date is
   * still reached — it was created later, and the sequence says so.
   */
  seq:     number;

  venueId: number;
  path:    string;
  date:    string;

  /** Probes spent on this row without settling it. Zero on a row never asked. */
  tries:   number;

  /**
   * Whether a listing named this key or this service built it, which is what
   * decides the retry budget absence gets — see `Existence`.
   */
  existence: Existence;

  /**
   * The series this key belongs to. Abandoning a key moves that series' tip, so
   * there is nothing a row without one could be remembered as.
   */
  seriesId: number;
}

/**
 * A row on its way into the backlog, which is an `Unsettled` without its id.
 *
 * The id is the queue position and the table assigns it, so a caller parking
 * work cannot have one to give — and must not be able to invent one.
 */
export type Parking = Omit<Unsettled, 'seq'>;

/**
 * What an adapter says about a probe that did not settle: **whether this was the
 * venue saying the key is not there.**
 *
 * **The core's own rule fits every venue but bitget**: a 404 is absence and
 * anything else is about us rather than about the file. Bitget's bucket grants
 * `GetObject` without `ListBucket`, so a key it has never held answers
 * `403 AccessDenied` — the same status as being turned away, separable only by
 * the headers. It reads an S3-served refusal as its own 404 and answers
 * `'drop'`, which is exactly what this exists for.
 *
 * - `null` — **as you were.** The default above applies. Every adapter that says
 *   nothing gets this.
 * - `'drop'` — **this is absence**, however this venue spells it.
 * - `'keep'` — **this is not absence**, whatever the status says.
 *
 * **It says what an answer means.** How many such answers settle a key is
 * `judge`'s in `probe.ts` — with the one exception `'drop'` names, which is a
 * venue saying its answer is already final.
 *
 * **And none of them ends a key for good.** Leaving `wip` ends this pass: the
 * next update generates the key again, because the tip has not moved past it.
 * What retires a period is reconciliation, over a pass that finished.
 */
export type Verdict = 'drop' | 'keep' | null;

/**
 * What a venue wants done with a key that answered, and what it implies next.
 *
 * `next` names keys of the **same series and the same period** — a period is not
 * answered until all of them are, which is what stops a tip moving over a day
 * whose second part is still outstanding.
 */
export interface Succession {
  action: 'accept' | 'replace';
  next?:  string | string[];
}

/**
 * What a probe learned about one file, ready to be written back.
 *
 * `existence` is optional because settling metadata and ruling on whether a file
 * is still there are different claims. A probe that gets a 404 has learned
 * something about *this attempt*, which may be a withdrawal or may be a bad
 * minute at a CDN, so it says nothing about existence unless its caller asked
 * it to.
 */
export interface Settlement {
  venueId:    number;
  path:       string;
  size:       number | null;
  etag:       string | null;
  modified:   string | null;
  existence?: Existence;
  seenAt:     string;
}

/**
 * One walk of one scope, targeting the archive as it was at `started`.
 *
 * Kept as history rather than overwritten, so a prefix carries every attempt
 * ever made at it. `completed` null means the walk is still under way — and
 * resuming it does not move its target, so `started` is never rewritten.
 */
export interface Run {
  id:        number;
  venueId:   number;
  kind:      RunKind;
  scope:     string;
  cursor:    string | null;
  requests:  number;
  found:     number;
  started:   string;
  completed: string | null;
}

/**
 * One specific file that is not historical data, and why.
 *
 * An enumeration rather than a rule: `path` is matched exactly. Anything that
 * can be *described* belongs in the adapter's own policy instead, where it also
 * covers keys nobody has published yet.
 */
export interface Exclusion {
  venueId: number;
  path:    string;
  reason:  string;
}

/**
 * A file still to download, as a downloader needs it.
 *
 * Deliberately thin. A downloader needs to know what to fetch and where to put
 * it; `size` and `etag` come along because they are free here and let it check
 * what it got, but nothing in this shape describes what the file *contains*.
 * The URL is not stored — it is the venue's `base` plus `root` plus this path,
 * and duplicating it per row would be a second thing to keep true.
 */
export interface Pending {
  venueId:  number;
  path:     string;
  date:     string;
  size:     number | null;
  etag:     string | null;

  /**
   * When this file was recorded as being on disk, or null while it is still
   * owed.
   *
   * **Carried because a listing is no longer only of owed files.** Asking for
   * every file of a series and being unable to tell which are held would make
   * the answer useless for the thing it is for — building a picture of what
   * exists against what we have.
   */
  downloadedAt: string | null;

  /**
   * Which series the file belongs to, so a listing can say what the file *is*
   * without its reader parsing the path.
   *
   * A file this catalog cannot place is not catalogued — its path goes to
   * `unreadable` instead, where it waits for a reader that can.
   */
  seriesId: number;

}

/**
 * A pending file with everything a downloader needs to place it.
 *
 * **Facts about the data, never about the URL.** A downloader that read paths
 * would have to learn every venue's tree and be taught again whenever one moved,
 * so the parts of a file's identity that only the shape knows are resolved here
 * and handed over as fields.
 */
export interface Offered extends Pending {
  key:      string;
  url:      string;
  market:   string;
  dataset:  string;
  symbol:   string;

  /**
   * How much time this file covers — a day, a month, an hour.
   *
   * **The one thing about a rendering a consumer genuinely needs.** A venue
   * publishing the same period twice offers a choice, and the difference that
   * matters is the span each file holds, not which prefix or host it came from.
   * Where a file sits in a venue's tree is exactly what this catalog exists to
   * absorb.
   *
   * Read off the pattern, where it is derived from the finest slot the shape
   * carries, so it cannot disagree with the URL it describes.
   */
  grain:    Grain | '';

  /**
   * The levels below the dataset, named, where the series has any.
   *
   * **An object rather than the stored string**, because `400,incremental` is
   * two facts about a book and a consumer choosing between depths should not
   * have to split commas and count positions. Written in the order the levels
   * belong in, so anything rebuilding a path can join the values as they come.
   */
  variant?: Record<string, string>;

  /** Which piece of a period, where a venue splits one. bitget's trades. */
  part?:    string;

  ext:      string;
}

/**
 * What a downloader saw when it worked a page.
 *
 * Three lists, because "did not arrive" and "arrived wrong" are different claims
 * that this service acts on differently: the first asks whether the key is
 * really there, the second says the metadata beside it disagrees with the bytes
 * the venue served.
 */
export interface Reported {
  downloaded: string[];
  failed:     string[];
  mismatched: { key: string; size?: number; etag?: string }[];
}

/**
 * Where a page of pending files left off.
 *
 * The venue is part of it because two hosts of one venue are two id ranges under
 * one name: without it a cursor would jump between them and drop rows that sort
 * identically on `(date, path)`.
 */
export interface Cursor {
  date:     string;
  path:     string;
  venueId:  number;

  /**
   * Which series the page stopped in, for a listing narrowed to a set of them.
   *
   * A narrowed listing walks its series in turn and seeks inside each, so where
   * it left off is a series and a position within it — not a point on a single
   * ordering across the whole venue.
   */
  seriesId?: number;
}

/**
 * Where a venue stands, as one word.
 *
 * **Every state a person needs to tell apart, and no two that look alike.** A
 * venue between passes and a venue nobody has ever asked about are different
 * things, and a reader should not have to infer either from an open job.
 *
 *   not started  no row in `survey`. Nothing runs, ever
 *   walking      mapping the archive for the first time
 *   updating     a pass over what has changed since
 *   waiting      enrolled and current, next update due at a stated time
 *   paused       stopped by somebody, and staying stopped
 *
 * `paused` says nothing about what was interrupted, which matters — a pause
 * during a walk is a different thing to resume than a pause between updates. So
 * it is reported beside it rather than folded into it: see `Standing.during`.
 */
export type SurveyState = 'not started' | 'walking' | 'updating' | 'waiting' | 'paused';

/** A venue's position in the survey lifecycle, as `GET /status` reports it. */
export interface Standing {
  state:      SurveyState;

  /** When somebody first asked for this venue. Null where nobody has. */
  enrolledAt: string | null;

  /** When the open job began, where there is one. */
  since:      string | null;

  /**
   * What a pause interrupted — the state it would return to.
   *
   * Null unless `state` is `paused`. It is what separates "paused mid-walk",
   * which resumes a walk, from "paused between updates", which resumes a
   * schedule — and `force-update` answers differently to each.
   */
  during:     Exclude<SurveyState, 'not started' | 'paused'> | null;

  /** When the next update is due, where the venue is waiting for one. */
  nextRun:    string | null;

  /** Whether **this process** has a loop alive for it, which a restart clears. */
  surveying:  boolean;

  /** Asked to stop and still finishing the page it is on. */
  stopping:   boolean;
}

export interface Surveys {
  /**
   * Every venue that can be surveyed at all.
   *
   * **From the registry, not the catalog.** Which venues exist is a property of
   * the code; the catalog's `venue` table is written *by* a survey, so on a
   * fresh database it is empty — and validating a request against it would mean
   * no first survey could ever be started.
   */
  venues(): string[];

  /**
   * Start a venue's survey loop, or refresh it.
   *
   * **Only a refresh interrupts something already running**, because a venue is
   * surveyed by a loop that does not end on its own — so *already running* is the
   * ordinary state, and an ordinary request has nothing to add to it. A refresh
   * stops the loop, waits for it, discards the run rows and starts over; doing
   * that from outside would reset under a live walk.
   */
  start(venue: string, occasion: Occasion, refresh: boolean): void;

  /**
   * Ask a venue's survey to stop where it is.
   *
   * **A pause is not a cancellation.** Every partition keeps its cursor and the
   * job stays open, so starting the venue again continues from exactly where it
   * stopped — the same state a killed container leaves behind, reached
   * deliberately.
   *
   * Returns whether anything was actually asked to stop, which is how a caller
   * tells "paused it" from "it was not running".
   */
  pause(venue: string): boolean;

  /**
   * Whether **this process** is walking the venue right now.
   *
   * Distinct from the catalog having an open job, and the distinction is the
   * point: a job is open whenever work is outstanding, including after a
   * container died mid-survey. That reads identically to a survey in progress
   * from the rows alone, and the two want opposite responses — one needs
   * resuming, the other needs leaving alone.
   *
   * Held in memory on purpose. It is a fact about this process, and a process
   * that is gone should not be able to leave a claim behind saying it is busy.
   */
  running(venue: string): boolean;

  /** Whether a stop has been asked for and this process has not acted on it yet. */
  stopping(venue: string): boolean;

  /** The interval between passes, so a status can say when the next one is due. */
  everyMs(): number;
}

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

/**
 * Which files a listing is asking for, beyond the series they belong to.
 *
 * The bounds are dates in each series' own grain, which is why `until` exists
 * alongside `to` — see its own note.
 */
export interface FileQuery {
  from?:   string;
  to?:     string;

  /**
   * An **exclusive** upper bound, which is the only way to name a whole month.
   *
   * `date` holds whatever grain a series publishes at — `202506` for a monthly
   * file, `20250601` for a daily one — so an inclusive `to` of `202506` sorts
   * below every daily file of that month. The next month, exclusive, catches
   * both.
   */
  until?:  string;

  /**
   * Whether the file is already on disk.
   *
   * **Three states, not two.** `false` is what a downloader asks for, `true` is
   * what an audit asks for, and leaving it out asks for the catalog's whole
   * answer regardless — which is the question nothing could ask before.
   */
  downloaded?: boolean;

  after?:  Cursor | null;
  limit:   number;

  /** Narrow to these series. Absent means every series of the venue. */
  series?: readonly number[];
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
   * seen of it, and nothing else. Whether the shape is finished is `open`.
   */
  last:     string | null;

  /**
   * Whether this catalog still expects files for the shape.
   *
   * **True while any one of its series is still open**, which is the same
   * question generation asks before building a key — so a shape reported open is
   * one requests are still going out for, and a closed one is not.
   */
  open:     boolean;
}

/** A month either has something left to download or it does not. */
export type MonthState = 'open' | 'closed';

/** What a venue holds, summed from its months. */
/**
 * How much of a venue's catalogue has anything in it, by series.
 *
 * A file count says how much was collected but not how much of the venue it
 * covers; this says how many instruments have been answered for at all, which is
 * what an update walking series one at a time is actually working through.
 */
export interface SeriesCount {
  /** Series with both bounds, which is what holding a file records. */
  withFiles: number;

  /** Every series of the venue, whatever its shape is doing. */
  total:     number;
}

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

/** One month of one venue, with the state it is in. */
export interface MonthTotals {
  month:        string;
  state:        MonthState;
  files:        number;
  bytes:        number;
  pending:      number;
  pendingBytes: number;
  withdrawn:    number;
}

// ── The rollup ────────────────────────────────────────────────────────────────

/**
 * What one file counts as, at the moment a write observes it.
 *
 * The month is carried rather than derived here so that a file whose date moved
 * between versions subtracts from where it was and adds to where it now is,
 * which are simply two keys.
 */
export interface FileState {
  month:      string;
  confirmed:  boolean;
  downloaded: boolean;
  bytes:      number;
}

/**
 * One file's before and after, as a write leaves it.
 *
 * `was` is null for a file nobody had seen. There is no null `now`, because
 * nothing is ever deleted — a file a venue withdrew stops being `confirmed` and
 * keeps its row.
 */
export interface FileEffect {
  venueId: number;
  was:     FileState | null;
  now:     FileState;
}

/** How much a batch moves one venue-month's counters. Signed. */
export interface MonthDelta {
  venueId:      number;
  month:        string;
  files:        number;
  bytes:        number;
  pending:      number;
  pendingBytes: number;
  withdrawn:    number;
}

/** One venue-month as the rollup holds it. */
export interface MonthRow {
  venueId:      number;
  month:        string;
  files:        number;
  bytes:        number;
  pending:      number;
  pendingBytes: number;
  withdrawn:    number;
}

/**
 * A venue-month where the rollup and the rows disagree, with both figures.
 *
 * Both sides are reported rather than only the difference: which one is wrong is
 * the question, and a delta alone cannot say.
 */
export interface MonthDrift {
  venueId:         number;
  month:           string;
  files:           number;
  cachedFiles:     number;
  bytes:           number;
  cachedBytes:     number;
  pending:            number;
  cachedPending:      number;
  pendingBytes:       number;
  cachedPendingBytes: number;
  withdrawn:          number;
  cachedWithdrawn:    number;
}

/**
 * What an adapter made of one path.
 *
 * Two answers, because what is *not* a file has already been settled by the time
 * a path arrives here: the global rules and the adapter's `accepts` have both
 * had their say. What is left is a path that ought to be a file, so either it is
 * placed or nothing here knows what it is.
 *
 * The reason strictness is worth the trouble: a forgiving expression fails
 * *silently and permanently*, leaving plausible rows nobody will question, while
 * a strict one fails *loudly and recoverably* — a stopped run and a code change.
 * When in doubt, refuse.
 */
export type Inspection =
  /**
   * Recognised: the pattern, the instrument occupying it, and the date.
   *
   * Bounds are deliberately absent — a sighting says a file exists, not where
   * the series begins or ends. Those are the catalog's to keep.
   */
  | { of: 'series'; found: Found; date: string }

  /**
   * Nothing here knows what this is, and guessing would be worse than stopping.
   *
   * `date` is present and null rather than absent: a path nobody recognised has
   * no date by definition, and saying so on both arms lets a caller read
   * `seen.date` without first proving which arm it holds.
   */
  | { of: 'unknown'; date: null };

/**
 * One shape a venue serves that no adapter reads.
 *
 * `seen` counts the times it has been met, which is what separates a stray key
 * from a dataset nobody parses.
 */
export interface Unreadable {
  venue:     string;
  host:      string;
  path:      string;
  reason:    'unread';
  seen:      number;
  firstSeen: string;
  lastSeen:  string;
}

/** What a path says about itself: which shape it is, and whose file it is. */
/**
 * A path taken apart, in canonical terms, ready to become a series.
 *
 * **The adapter's whole output.** Everything venue-specific — which tree means
 * which market, what a venue calls a bar, how it decorates an instrument in a
 * key — has been resolved by the time one of these exists, which is what keeps
 * that knowledge from reaching anybody else.
 */
export interface Reading {
  market:     string;
  dataset:    string;
  variant?:   string;

  /** The venue's own name for the instrument. */
  symbol:     string;

  /** How the path spells it, where that differs. Defaults to `symbol`. */
  urlSymbol?: string;

  date:       string;
}

export interface Found {
  /**
   * **Canonical**, never the venue's own word for it. Translating is the
   * adapter's job and the whole reason it sees the path at all — a consumer
   * asking for perpetual klines should never learn that gate writes
   * `futures_usdt/candlesticks_1m`.
   */
  market:    string;
  dataset:   string;

  /** The level below the dataset: an interval, a book depth, a funding kind. */
  variant?:  string;

  pattern:   string;

  /** The venue's own name for it, which is what a listing will be matched against. */
  symbol:    string;

  /**
   * How the archive spells that instrument, where it differs from the venue's
   * own name **inside the name itself**.
   *
   * Absent is the ordinary case, and the only one any venue here needs: a
   * constant written around the symbol is part of the shape and belongs in the
   * pattern, where every series of that pattern gets it for free.
   */
  urlSymbol?: string;
}

// ── Series ────────────────────────────────────────────────────────────────────

/**
 * One URL shape a venue publishes to, with slots where the parts that vary go.
 *
 * **Patterns change almost never; instruments change constantly**, which is why
 * this is separate from the series that use it. A symbol arriving must not mean
 * writing a pattern — that is what forced an adapter to know how to build every
 * URL of its venue, for ever.
 *
 * **The slots, in full.** `{YYYY}` `{MM}` `{DD}` `{HH}` `{MI}` take a date, at
 * whatever grain the shape publishes; `{SYMBOL}` takes the archive's spelling of
 * an instrument, which the series stores rather than anything computing per key.
 * A venue whose paths a calendar cannot spell adds its own through `slotsFor`,
 * naming each so it ends in the grain it steps at. Everything else is literal,
 * because a different value of it is a different pattern — so building a key is
 * substitution, whoever does it.
 */
export interface Pattern {
  /** Assigned by the catalog. Absent on one being reported for the first time. */
  id?:      number;

  venueId:  number;

  /** The venue's own instrument type. Stored, never parsed. */
  market:   string;

  /** Whatever the venue calls this kind of data. Stored, never parsed. */
  dataset:  string;

  /** The path below the venue root, literal but for its slots. */
  pattern:  string;

  /**
   * Whether this shape is still served.
   *
   * A venue that moves a URL retires the old pattern and opens a new one, and
   * everything measured under the old one stays true — okx putting `pro/` into
   * its order-book paths is exactly this.
   */
  state:    'active' | 'retired';
}

/**
 * One instrument's occupancy of one pattern: where its files start, where they
 * stop, and how far we have read.
 *
 * **"Instrument" is not quite the word.** A venue-wide bucket is a series here
 * with no symbol at all — okx publishes one file a day carrying every instrument
 * of a market — and borrowing rates are keyed by a currency. What every one of
 * them has is a lifetime and a tip.
 */
export interface Series {
  /** Assigned by the catalog. Absent on one being reported for the first time. */
  id?:        number;

  patternId:  number;

  /**
   * What the venue's instrument listing calls it — what a reconciliation matches
   * against, and what a person searches for.
   *
   * **`@` where one file carries every instrument of a market**, so that the
   * bucket is a symbol like any other rather than an absence every reader has to
   * test for. Never empty: a series always has one or the other, and a blank
   * reaching a consumer means the *file* had no series, not that the series had
   * no symbol.
   */
  symbol:     string;

  /** `yyyymm` or `yyyymmdd`, inclusive. Null where no start is established yet. */
  first:      string | null;

  /**
   * The newest date a file has been seen at, and nothing more.
   *
   * A measurement rather than a verdict: it is not a claim that the archive
   * stopped there, and it is null where no file is known of at all. It only
   * moves forward, except where reconciliation reads it back off `file`.
   */
  last:       string | null;

  /**
   * How far the venue has actually been asked: everything at or below this is
   * settled, and generation starts at the period after it.
   *
   * **It only ever moves forward.** Too low costs extra probes and finds
   * everything; too high loses files silently — which is what makes a lost flush
   * or an interrupted run safe rather than damaging.
   *
   * **Null is not a starting point, it is the absence of one**, so a row
   * carrying none is not generated for at all until something states one.
   */
  tip:        string | null;

  /**
   * Where the instrument is in its life, which is what decides whether either
   * bound can still move.
   *
   * - `'active'` — the venue lists it today. The archive runs on, so there is no
   *   end to look for; a start may still be missing, because a symbol can list
   *   before it publishes anything.
   * - `'delisted'` — listed once, not now. The start is settled. The end may not
   *   be: an archive can outlive the listing, and okx keeps writing candlesticks
   *   after a listing stops.
   *
   * **There is no state for "delisted and never published".** Such a row records
   * an absence rather than a measurement, so reconciliation deletes it instead —
   * see `reconcile`. A series that exists has published something, or is still
   * expected to.
   */
  state:      'active' | 'delisted';

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
 * An adapter's extra slots, given the stamp being generated: what to replace,
 * and what to replace it with.
 *
 * The escape hatch for a venue whose paths are not simply a calendar — see
 * `Adapter.slotsFor`, which is where the two that need it are explained.
 */
export type Slots = (at: string) => Record<string, string>;

/**
 * A series with the pattern it belongs to, which is what anything generating or
 * reading a key actually needs.
 */
/**
 * One instrument's answer to a `{TRANSFORM:kind:default}` slot, over a span of
 * dates.
 *
 * **Exceptions, not shapes.** What a whole market does is a pattern; this is one
 * instrument departing from it in a way no template reaches - a directory the
 * venue reassigned, a token that belongs to the instrument rather than to its
 * market. See the `transform` table.
 */
export interface Transform {
  venueId:   number;

  /** Canonical, as `pattern` and `series` name them: the instrument. */
  market:    string;
  symbol:    string;

  /** '' for every dataset whose pattern asks for this kind. */
  dataset:   string;

  /** Which placeholder this answers. */
  kind:      string;

  /** What goes in, before the slots are filled - so it may itself carry slots. */
  transform: string;

  /** Inclusive, at whatever width the series stamps its dates. */
  from_:     string;
  to_:       string | null;
}

export interface Publishing extends Series {
  venueId:      number;


  /**
   * How the archive spells the instrument, which is not always the venue's own
   * name: okx serves a futures family as `<name>-futureschain`, and the plain
   * name is a different market's file entirely.
   *
   * **NULL means the archive spells it exactly as the venue does**, which is
   * every series of every venue here today. What it is for is a transformation
   * a pattern cannot express because it happens inside the name — `BTC/USDT`
   * written `BTC_USDT` — rather than a constant around it, which belongs in the
   * pattern.
   */
  urlSymbol:    string | null;

  /**
   * What this instrument puts where its pattern says `{TRANSFORM:kind:default}`.
   *
   * Attached when the series is loaded and absent on almost every row, so
   * building a key stays a pure function of the series and its date.
   */
  transforms?:  readonly Transform[];

  /** Canonical, all three — see the `pattern` table. */
  market:       string;
  dataset:      string;
  variant:      string;

  pattern:      string;
  grain:        Grain;

  /**
   * The last date this shape ever served, or NULL while it is still served.
   *
   * A ceiling on generation rather than a verdict on the series: keys are built
   * up to it instead of up to yesterday, and the series closes by the ordinary
   * rule once its tip arrives there.
   */
  retiredAt:    string | null;
}

