import type { DatabaseSync } from 'node:sqlite';

/**
 * Where a set of tars comes from.
 *
 * The tree, not the producer that fills it. `archives` is the raw venue tree
 * trucker writes, and is named for what it *is* — the producer's name may
 * change, and nothing downstream should have to change with it. `vault` is
 * stocker's normalised output.
 */
export type Origin = 'vault' | 'archives';

/** Everything `cold` needs from the environment, resolved once. */
export interface ColdConfig {
  /** Root of the tree being backed up, on the host. */
  sourceRoot: string;

  /**
   * The collector's published state, which says what is final.
   *
   * Only `archives` reads it: a venue-month is a candidate once trucker has
   * published it as collected through. The vault has no such signal and does
   * not need one — stocker's partitions are packed as they appear.
   */
  sharedRoot: string;

  /**
   * Largest a tar may get before a new one is started.
   *
   * Per origin because it is a restore cost, and a restore means different
   * things in each tree — see `CAPS`.
   */
  capBytes:   number;

  /**
   * Stocker's vault, whatever origin is being worked on.
   *
   * `evict archives` needs it even though it is deleting raw: the ledger under
   * `@meta/built` is the only record of which raw file became which partition,
   * and nothing in cold storage connects the two.
   */
  vaultRoot:  string;

  /** Local staging area for tars, `<coldRoot>/<origin>/…`. */
  coldRoot:   string;

  /** Mega path the cold root mirrors. */
  megaRoot:   string;

  /** Where `cold.sqlite` lives. */
  dbPath:     string;

  /**
   * Gigabytes still to upload before packing pauses.
   *
   * The link is what limits this whole exercise, so tars are made just far
   * enough ahead to keep it busy. Held in the environment because it depends on
   * the link rather than on the data — a host with real bandwidth wants to run
   * further ahead — and carried in GB because that is the unit it is set and
   * read in.
   */
  queueTargetGb: number;
}

/**
 * One file to be packed, with whatever its path could be made to say.
 *
 * **`venue` and `month` are all that is ever known.** They are what the tars
 * are organised by, so every origin must yield them. Everything below is the
 * vault's hive partitioning, which the raw archives simply do not have — seven
 * venues, seven tree shapes, and no level that reliably names a symbol. Rather
 * than guess one per venue, archives leave them null and let the path stand for
 * itself.
 *
 * `variant` holds the vault's extra levels below `dataset=` verbatim —
 * `interval=1m` for klines, nothing for most. Keeping it as the raw `key=value`
 * text means a new kind of extra costs no schema change and no branch.
 */
export interface SourceFile {
  /** Relative to `sourceRoot`, which is what goes into the tar. */
  path:    string;
  bytes:   number;
  mtime:   number;

  venue:   string;
  month:   string;

  market:  string | null;
  symbol:  string | null;
  dataset: string | null;
  variant: string | null;
}

/** A `(market, symbol)` within one venue-month, and everything it holds there. */
export interface SymbolGroup {
  market: string;
  symbol: string;
  bytes:  number;
  files:  SourceFile[];
}

/**
 * One venue-month with everything in it that cold storage does not hold yet.
 *
 * `closedAt` is the producer's own statement that the month is finished, and is
 * carried so the next run can skip the month without walking it. Null where the
 * origin has no such signal, which is what stops a month row being written for
 * a tree that would never consult one.
 */
export interface PendingGroup {
  venue:    string;
  month:    string;
  closedAt: string | null;
  files:    SourceFile[];
}

/**
 * What a planner found, and what it deliberately held back.
 *
 * **Withholding is not the same as having nothing to do**, and the closing line
 * of a run is where that difference matters: "everything is in cold storage"
 * over a venue whose months were just refused is the one sentence that would
 * undo the refusal's whole purpose. So the count crosses the seam rather than
 * living only in the planner's own log line.
 *
 * Zero for the archives, whose months beyond the collector's tip are not
 * candidates yet rather than candidates turned away.
 */
export interface PendingPlan {
  groups:   PendingGroup[];
  withheld: number;
}

/**
 * What differs between one tree and the next.
 *
 * **Everything after planning is shared**: writing the part rows, packing,
 * verifying, queueing, confirming, reclaiming, pacing and the resume rules are
 * the same operation whatever produced the files. So the seam is here and
 * nowhere else — an origin contributes a way to find what is missing and a way
 * to divide it, and inherits the rest untouched.
 */
export interface Planner {
  /**
   * Everything not in cold storage yet, grouped by venue-month.
   *
   * Reports its own scan to the log, because what is worth counting differs:
   * the vault counts partitions, archives count months against their tips.
   *
   * **The venue filter is honoured here, and an empty list means all of them.**
   * Filtering afterwards is too late twice over: the work of scanning a venue
   * nobody asked about is already done, and the planner has already said things
   * about it — a `push vault bitget` that warns about bybit's incomplete months
   * is reporting on a tree that run cannot touch.
   */
  pending(handle: DatabaseSync, config: ColdConfig, venues: string[]): Promise<PendingPlan>;

  /** Divide one venue-month's files into the tars that should hold them. */
  pack(files: SourceFile[], capBytes: number): SourceFile[][];
}

/** A tar that should exist, before it does. */
export interface PlannedPart {
  id:      number;
  origin:  Origin;
  venue:   string;
  month:   string;
  seq:     number;

  /** `202405.p01.tar` — carries no meaning; the database says what is inside. */
  name:    string;

  /** Full Mega path, `<megaRoot>/<origin>/<venue>/<year>/<name>`. */
  remote:  string;

  /** Where the tar is staged locally while it waits for its turn to upload. */
  local:   string;

  bytes:   number;
  files:   number;
}

/** What a part looks like in the database, including where it has got to. */
export interface PartRow extends PlannedPart {
  uploadedAt: string | null;
  handle:     string | null;

  /**
   * Whether this part came from replanning a whole month that was already
   * packed, in which case the comparison guarding its replacement was made
   * across the month and must not be made again per part — bin packing moves a
   * member between parts, and one part alone reads that move as a loss.
   */
  replan:     number;
}

/** A file already recorded as packed, for deciding what still needs packing. */
export interface MemberRow {
  path:  string;
  bytes: number;
  mtime: number;
}

/** What the whole upload queue has left to send, across every origin. */
export interface QueueState {
  /** Bytes remaining — the queue's total minus what has gone. */
  remaining: number;
  total:     number;
  uploaded:  number;
  transfers: number;
}

/** The one upload Mega is working on, since it sends them one at a time. */
export interface ActiveTransfer {
  name:    string;
  percent: number;
  bytes:   number;
}

/**
 * One venue-month, and whether its raw can go.
 *
 * `files` is empty for a blocked month — nothing is deleted from it, and
 * carrying the list would invite a caller to act on a set that was refused.
 */
export interface EvictMonth {
  venue:   string;
  month:   string;
  verdict: 'clear' | 'risky' | 'blocked' | 'reclaimed';

  /** Paths relative to the raw root, as the record names them. */
  files:   string[];
  bytes:   number;

  /** Why it is blocked, or what the caveat is. Empty when it is simply clear. */
  reasons: string[];

  /**
   * The same answer as a vocabulary rather than a sentence, so blocked months
   * can be summarised by cause without printing one line each.
   *
   * "Nothing is reclaimable" and "nothing is reclaimable because the vault is
   * behind" are different situations, and a bare count cannot tell them apart.
   */
  causes:  EvictCause[];
}

/** Why a month is not open for eviction. */
export type EvictCause = 'unsent' | 'extra' | 'changed' | 'unbuilt' | 'stale';

/** What each cause means to somebody reading a summary. */
export const EVICT_CAUSES: Record<EvictCause, string> = {
  unsent:  'part of the month is not in Mega yet',
  extra:   'raw on disk that Mega has never seen',
  changed: 'raw that changed since it was packed',
  unbuilt: 'raw that reached no vault partition',
  stale:   'a vault partition that is not in Mega yet',
};

/**
 * What a partition's id is built from.
 *
 * **Both sides of the comparison already carry these.** A `SourceFile` read off
 * the tree and a `member` row read out of cold storage name the same six things,
 * so one function turns either into stocker's id and the two become comparable
 * without either learning the other's shape.
 */
export interface PartitionKey {
  dataset: string | null;
  venue:   string;
  market:  string | null;
  symbol:  string | null;

  /** The extra levels as the path wrote them, `interval=1m`, or null. */
  variant: string | null;

  /** `YYYYMM`, as the tree and the record hold it — not the id's `YYYY-MM`. */
  month:   string;
}

/**
 * A venue-month stocker built more of than the vault currently holds.
 *
 * Carried rather than logged on the spot so the planner can report every one of
 * them together, by venue: one month short is a note, forty is a disk that went
 * missing, and the difference is only visible in aggregate.
 */
export interface IncompleteMonth {
  venue:   string;
  month:   string;

  /** How many partitions the ledger records for the month. */
  built:   number;

  /** How many of those are neither on disk nor already in cold storage. */
  missing: number;
}

/**
 * A named set of files to remove together.
 *
 * The unit of the *report* and of the confirmation, not of the decision — which
 * is taken per file in both trees. Archives label a group by its venue-month
 * because that is what they judge as a whole; the vault labels one by venue and
 * dataset because that is what somebody asks to reclaim.
 */
export interface EvictGroup {
  label: string;

  /** Paths relative to the tree's root, as the record names them. */
  files: string[];
  bytes: number;

  /**
   * Where this belongs, for the eviction record.
   *
   * Carried alongside `label` rather than parsed back out of it: the label is
   * for a person to read and is free to change, and a record of what is no
   * longer on disk should not depend on the formatting of a log line.
   */
  venue?: string;
  month?: string;
}

/**
 * Which partitions a vault eviction is about.
 *
 * **Every list empty means everything**, and that is the only way to say
 * "everything" — there is no wildcard to mistype. Values are lowercased when
 * parsed and compared lowercased, so a filter matches the attribute rather than
 * the operator's shift key.
 *
 * `periods` hold `YYYY` or `YYYYMM` interchangeably: a month is stored as
 * `YYYYMM`, so one prefix test covers both and neither needs its own branch.
 */
export interface VaultFilter {
  venues:   string[];
  markets:  string[];
  datasets: string[];
  symbols:  string[];
  periods:  string[];
}

/**
 * A partition that matched the filter and cannot go.
 *
 * Kept apart from what is going rather than folded into a count, because the
 * whole point of naming it is that the operator asked for it and will not get
 * it. There is no override: a partition Mega does not hold is the only copy.
 */
export interface HeldPartition {
  path:   string;
  reason: HeldReason;
}

/** Why a matching partition is not in Mega. */
export type HeldReason = 'unpacked' | 'changed';

/** What each reason means to somebody reading the list. */
export const HELD_REASONS: Record<HeldReason, string> = {
  unpacked: 'never packed — not in cold storage at all',
  changed:  'changed since it was packed — Mega holds an older build',
};

/**
 * What one venue holds in one tree, as the audit's dashboard states it.
 *
 * Three numbers about the same thing, because a cell answers three questions in
 * the order they are asked: how far does this go, how big is it, and how much of
 * it would survive this disk dying.
 */
export interface Holding {
  /** The months themselves, for the range. Unioned when holdings are added. */
  months: Set<string>;

  /**
   * How many months this covers, held apart from the set on purpose.
   *
   * **Across venues these add up; the sets do not.** Seven venues each holding
   * 2020-03 are seven venue-months of data and one calendar month, and a totals
   * row built by unioning the sets said `108 mo` where the column above it added
   * to 252.
   */
  monthCount: number;

  parts:  number;
  bytes:  number;
  files:  number;

  sent:      number;
  sentBytes: number;

  /**
   * Backed-up months, counted fractionally.
   *
   * **A partially uploaded month is neither in nor out**, and rounding it either
   * way is a lie in a table whose whole job is saying where things stand. Each
   * month contributes the share of its parts that have landed, so `16.3` reads
   * as "sixteen months and a bit of another" — a signal that something is
   * mid-flight, never a measurement to act on.
   */
  sentMonths: number;

  /**
   * What the producer says it has, where it says anything.
   *
   * **Cold storage cannot answer "what is there", only "what did I pack".** A
   * venue with nothing backed up has no parts to fold, so a cell built from
   * parts alone renders empty — and "there is nothing here" then looks exactly
   * like "none of this is backed up", on the one screen that exists to tell
   * those apart.
   */
  known?: Known;

  /** What the origin counts in: partitions for the vault, files for the rest. */
  unit?: string;
}

/**
 * What a venue actually holds, wherever it currently sits.
 *
 * **On disk plus evicted, and the two never overlap.** Something reclaimed is
 * gone from disk by definition, and the `evicted` table is what makes that
 * knowable without a `stat` per file — so the sum is the venue's true size
 * rather than either half of it.
 *
 * Months come from the producer, which is the only thing that knows what it
 * finished as opposed to what happened to be packed.
 */
/**
 * What stocker says it built, against what actually exists — the pair every
 * check of one against the other needs, taken in the one order that is safe.
 *
 * `files` and `uploaded` are handed back rather than folded away because a
 * caller comparing sizes and mtimes needs the rows themselves, and re-walking
 * the tree to get them would undo the point.
 */
export interface Presence {
  /** Built partitions, by venue then month. */
  claimed:  Map<string, Map<string, Set<string>>>;

  /** Every partition that exists somewhere: on disk now, or already in cold storage. */
  present:  Set<string>;

  files:    SourceFile[];
  uploaded: PartitionKey[];
}

/**
 * How a tree's month count stands against the tree it is built from.
 *
 * `null` is "they agree". The two ways of disagreeing are worth telling apart
 * because only one of them is anybody's problem: `behind` is work outstanding,
 * `excused` is the shortfall a spilling venue always shows at its tip.
 */
export type Lag = 'behind' | 'excused' | null;

export interface Known {
  months: Set<string>;

  /**
   * Whether this venue's newest closed month cannot be normalised yet.
   *
   * Stated by the producer rather than worked out here: it follows from every
   * one of the venue's series keeping a month's tail in the next month's first
   * bucket, and what a series is has no business being known at this end. Where
   * it is true, a vault one month short of the archives is finished rather than
   * behind.
   */
  spills?: boolean;

  /** Files present locally right now. */
  files:  number;
  bytes:  number;

  /** Files that are only in Mega, from the eviction record. */
  gone:      number;
  goneBytes: number;

  /**
   * Whether the local tree has actually been counted yet.
   *
   * The archives take 21 seconds to walk — 3.7 million files, seven venues —
   * and holding the whole report back for a number that fills in venue by venue
   * is the difference between a table you can start reading and a blank screen.
   * Until this is true the cell shows the count it is sure of and `…` for the
   * rest, rather than a zero that reads as an answer.
   */
  measured: boolean;
}

/**
 * One thing the audit noticed.
 *
 * The weight is the point. A **problem** is cold storage disagreeing with the
 * record and needs an answer; a **check** has an innocent explanation and a
 * guilty one. Flattening them is how a real problem hides among thirty routine
 * ones.
 *
 * Ordinary progress is not a finding. What is planned and what is in Mega are
 * two of the three lines of every cell in the coverage table, so a backlog needs
 * no line of its own.
 */
export interface AuditFinding {
  severity: 'problem' | 'check';

  /** The class of thing, repeated across findings so they group and align. */
  kind:     string;

  /** What it is about — a part, a venue, a count. */
  what:     string;

  /** The specifics, shown dimmed beneath. */
  detail:   string;
}

/** What one `push` run did, for the closing report. */
export interface PushSummary {
  planned:  number;
  packed:   number;
  uploaded: number;
  bytes:    number;
  skipped:  number;
}
