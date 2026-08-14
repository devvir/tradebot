/**
 * The trees the pipeline moves data through.
 *
 * A topic is the *tree* a fact is about, never the service that produced it —
 * `archives` rather than `trucker`, because a collector can be replaced and the
 * tree it fills means the same thing afterwards.
 */
export type BaseTopic = 'archives' | 'vault' | 'rest' | 'websocket';

/**
 * A tree, or a **second layer** below one.
 *
 * `archives` is the contract: the handful of facts another service acts on.
 * `archives:bookkeeping` is everything the owner wants kept but nobody routinely
 * asks for — every file trucker downloaded, with its size and mtime — which is
 * worth having for an audit, a migration or a tool, and is noise in any normal
 * query.
 *
 * **The namespace does the filtering**, so no marker column is needed and no
 * consumer has to know which facts are the important ones: asking for `archives`
 * cannot accidentally return bookkeeping, because they are not the same topic
 * and not even the same database. It is the same instinct as a verbose log — kept
 * in case, scanned by something specialised, never in the way.
 *
 * `logs:archives` is the same idea written the other way round, and both work:
 * **the tree is whichever segment names one**, wherever it sits. `logs:` first
 * makes every second layer one namespace a tool can sweep or exclude in one
 * glob; the tree first makes everything one producer writes share a prefix.
 * Neither changes what anything means, and the convention is settled in
 * [README.md](../README.md) rather than here.
 *
 * A subtopic is owned by whoever owns its tree, since it is the same producer
 * saying more about the same thing.
 */
export type Topic =
  | BaseTopic
  | `${BaseTopic}:${string}`
  | `logs:${BaseTopic}`;

/** Services that may write. Named for themselves, since a service is itself. */
export type Owner = 'trucker' | 'stocker' | 'tooling';

/**
 * What identifies one fact.
 *
 * **Columns are for what the whole pipeline shares and filters on equality.**
 * venue, market, symbol and dataset are that vocabulary, even though no topic
 * populates all of them — the archives leave three blank, because trucker does
 * not track the shape of each venue's tree and should not have to.
 *
 * **`subject` is for what only the owner knows the shape of.** `interval=1m`
 * means something to klines in the vault and nothing to anybody else, and a
 * column per such thing is how a shared schema becomes one service's schema with
 * everyone else's fields left blank.
 *
 * Every optional field defaults to the empty string and **never to null**:
 * SQLite treats nulls as distinct in a unique index, so two archive facts both
 * leaving `market` unset would both insert and the key would protect nothing.
 */
export interface FactKey {
  topic:    Topic;
  venue:    string;

  /**
   * `2020`, `202008` or `20200815`.
   *
   * **Not called `month`**, because everything being monthly is a fact about
   * today rather than about the model. Prefix-comparable, so a month is a prefix
   * of its days and a year of its months. Which grain a topic uses is the
   * topic's business.
   */
  period:   string;

  market?:  string;
  symbol?:  string;
  dataset?: string;
  subject?: string;

  /** What is being asserted — `complete`, `built`. Free text by design. */
  fact:     string;

  /**
   * What makes one occurrence distinct from another, when a fact is additive.
   *
   * **Blank for almost everything, and that is the point.** A fact describes
   * state: there is one answer at a time and re-stating it replaces the old
   * one. Some things are not state though — a partition drifting from its
   * inputs happens, and can happen again, and every time it did is worth
   * keeping. `seq` is what lets those share a key without colliding.
   *
   * A timestamp is the useful value, because it also orders them.
   */
  seq?:     string;
}

/** A fact as it is written. */
export interface FactInput extends FactKey {
  /**
   * When or what, never merely `true`.
   *
   * A fact's existence is its truth, so a boolean would waste the field — and
   * the thing consumers actually need is usually the time. `complete` carries
   * its closing time precisely because re-closure detection depends on it.
   */
  value?: string;

  /**
   * The owner's private state, in whatever shape the owner wants.
   *
   * Nobody outside needs to interpret it, and the owner may change it freely.
   * Tooling reads it anyway — that is what tooling is for — and the obligation
   * that leaves on the owner is a design one rather than a compatibility one.
   */
  meta?:  unknown;
}

/**
 * A fact as it is read. `meta` is absent unless it was asked for.
 *
 * **`createdAt` and `updatedAt` are always there and always free.** Nothing
 * needs them today, which is exactly why they are worth keeping: the questions
 * they answer — when did we first know this, has it moved since — are the ones
 * that get asked in the middle of an incident, when it is far too late to start
 * recording them.
 */
export interface Fact extends Required<FactKey> {
  value:     string;

  /** First time this key was ever stated. Never moves again. */
  createdAt: string;

  /** Last time it was re-stated, whether or not the value changed. */
  updatedAt: string;

  meta?: unknown;
}

/**
 * A partial key to match on.
 *
 * Every field is optional and an absent one matches anything, so `{ topic,
 * venue, fact }` asks "every period this venue has this fact for" — which is the
 * shape of nearly every real question.
 */
export interface FactQuery {
  topic:    Topic;
  venue?:   string;
  period?:  string;
  market?:  string;
  symbol?:  string;
  dataset?: string;
  subject?: string;
  fact?:    string;
  seq?:     string;
  value?:   string;

  /**
   * Fields to match by prefix instead of exactly.
   *
   * `{ prefix: { period: '2026' } }` is every period in 2026, whatever grain
   * they are. Translated to a range rather than a `LIKE`, because SQLite's
   * `LIKE` optimisation is too narrow to rely on — measured against this
   * schema it did not fire even for an all-digit prefix, and the query fell
   * back to scanning and filtering.
   */
  prefix?: Partial<Record<'period' | 'subject' | 'fact' | 'venue', string>>;
}

/** How a service gets its own handle on the facts. */
export interface FactManagerOptions {
  /**
   * Taken at construction because a service does not stop being itself while it
   * runs, which makes the ownership check automatic rather than something every
   * call site has to remember.
   */
  owner: Owner;

  /** Directory the per-topic databases live in — `<DATA_DIR>/@shared/facts`. */
  root:  string;
}
