import { existsSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { AT_CREATION, FACT_SCHEMA, ON_OPEN, SCHEMA_VERSION } from './schema';
import { assertOwns } from './owners';
import type { Fact, FactInput, FactKey, FactManagerOptions, FactQuery, Owner, Topic } from './types';

/**
 * A service's handle on what every other service knows.
 *
 * **Writing is owned, reading is not.** A service states facts about its own
 * tree and asks freely about anyone else's, which is the shape the pipeline
 * already has: stocker needs to know what trucker has finished, and trucker
 * needs to know nothing at all.
 *
 * **One database per topic**, which follows from one owner per topic — exactly
 * one writer per file, and readers are whoever turns up. It also keeps the
 * volumes apart: `archives` is hundreds of rows about months and `vault` is
 * hundreds of thousands about partitions, and one should not pay for the
 * other's indexes.
 *
 * Databases open lazily, so a service that only reads `archives` never creates
 * `vault.sqlite` by asking a question.
 *
 * Everything here is synchronous, because `node:sqlite` is. Wrapping it in
 * promises would suggest a concurrency that does not exist.
 */
export class FactManager {
  private readonly owner: Owner;
  private readonly root:  string;
  private readonly open = new Map<Topic, DatabaseSync>();

  private last = '';
  private tick = 0;

  constructor(options: FactManagerOptions) {
    this.owner = options.owner;
    this.root  = options.root;
  }

  /** State one fact, replacing whatever was said about the same key before. */
  record(fact: FactInput): void {
    this.recordAll([fact]);
  }

  /**
   * State many facts at once, in one transaction.
   *
   * **The transaction is the point, not the convenience.** Writing 250,000
   * partition facts one statement at a time is one fsync each; in a single
   * transaction it is one fsync. It is also the only way a caller can make a set
   * of facts appear together, which matters when two of them are only true
   * about each other.
   *
   * Every fact must belong to the same topic — a batch spanning two topics
   * spans two databases, and there is no transaction across those.
   */
  recordAll(facts: FactInput[]): void {
    if (facts.length === 0) return;

    const topic = facts[0]!.topic;

    assertOwns(this.owner, topic);

    for (const fact of facts)
      if (fact.topic !== topic)
        throw new Error(`recordAll takes one topic at a time — got '${topic}' and '${fact.topic}'`);

    const db  = this.database(topic);
    const now = new Date().toISOString();

    /**
     * **`created_at` survives the conflict; `updated_at` does not.** A fact
     * re-stated is the same fact — when we first knew it does not become
     * untrue because we heard it again — and the two together are what tell
     * "this has been steady for a month" from "this only just appeared".
     */
    const insert = db.prepare(
      `INSERT INTO fact (topic, venue, period, market, symbol, dataset, subject, fact, seq,
                         value, meta, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (topic, venue, period, market, symbol, dataset, subject, fact, seq)
       DO UPDATE SET value = excluded.value, meta = excluded.meta,
                     updated_at = excluded.updated_at`);

    db.exec('BEGIN');

    try {
      for (const fact of facts)
        insert.run(
          fact.topic, fact.venue, fact.period,
          fact.market ?? '', fact.symbol ?? '', fact.dataset ?? '', fact.subject ?? '',
          fact.fact, fact.seq ?? '', fact.value ?? '',
          fact.meta === undefined ? '' : JSON.stringify(fact.meta),
          now, now,
        );

      db.exec('COMMIT');
    } catch (err) {
      db.exec('ROLLBACK');

      throw err;
    }
  }

  /**
   * State something that **happened**, rather than something that is.
   *
   * A partition drifting from its inputs is not a condition to be replaced next
   * time it drifts — it occurred, it can occur again, and every time it did is
   * worth keeping. `seq` is filled with the moment it happened, which makes the
   * occurrences distinct and orders them at the same time.
   *
   * **Container logs do not survive the container**, which is the whole reason
   * this exists: something that goes wrong months from now is diagnosed from
   * what was recorded when it happened, and by then the log line is long gone.
   * When one of these does grow past being worth keeping, that is the moment it
   * has earned a real log with a mount and a rotation — not before.
   */
  append(fact: FactInput): void {
    this.record({ ...fact, seq: fact.seq ?? this.moment() });
  }

  /**
   * Every fact matching a partial key.
   *
   * **An absent field matches anything**, so `{ topic, venue, fact }` asks "every
   * period this venue has this fact for" — which is nearly every real question,
   * and is why the query is a partial key rather than a set of named methods.
   *
   * `meta` is left out unless asked for. It is the owner's private state, it is
   * the largest column by far, and a consumer that did not ask for it does not
   * want to pay to carry it.
   */
  find(query: FactQuery, options: { meta?: boolean } = {}): Fact[] {
    const rows = this.select(query, options).all() as unknown as (Fact & { meta?: string })[];

    if (! options.meta) return rows;

    return rows.map(row => ({ ...row, meta: row.meta ? JSON.parse(row.meta) : undefined }));
  }

  /**
   * The same question as `find`, one row at a time.
   *
   * **For queries whose answer does not fit in memory.** `find` materialises
   * every row before its caller sees the first one, which is what almost every
   * caller wants — a bounded question, and an array is easier to hold than a
   * cursor. But `vault:details` is one fact per partition *input*: 2.4 million
   * rows and 394 MB of text across the selected columns, which becomes upwards
   * of a gigabyte of objects and strings the moment it is an array. Stocker
   * reads all of them on every sweep and folds them into a map twenty times
   * smaller, so the array is pure peak with nothing to show for it.
   *
   * **The rows must not be written to while this is stepping.** SQLite will let
   * a statement step while the same connection rewrites the rows underneath it,
   * and what happens then depends on which index the planner chose — rows
   * visited twice, or skipped, with nothing said. `find` is immune because it
   * has read everything before it returns; this is not. Read first, then write,
   * or use a keyset cursor over `find`.
   */
  *stream(query: FactQuery, options: { meta?: boolean } = {}): IterableIterator<Fact> {
    for (const row of this.select(query, options).iterate() as unknown as Iterable<Fact & { meta?: string }>)
      yield options.meta ? { ...row, meta: row.meta ? JSON.parse(row.meta) : undefined } : row;
  }

  /**
   * The distinct values one column takes, for a partial key.
   *
   * **Asking "which venues are there" should not mean reading every row.**
   * `find` would answer it by returning 169,000 facts for the caller to fold
   * down to seven strings, which is the shape of question a store should
   * answer itself — and the same one `cold` asks first, before it knows what
   * to ask about.
   */
  distinct(field: 'venue' | 'period' | 'dataset' | 'symbol' | 'market' | 'fact',
    query: FactQuery): string[] {
    const where:  string[] = [];
    const values: string[] = [];

    for (const name of FIELDS) {
      const value = query[name];

      if (value === undefined) continue;

      where.push(`${name} = ?`);
      values.push(value);
    }

    return (this.database(query.topic).prepare(
      `SELECT DISTINCT ${field} AS v FROM fact WHERE ${where.join(' AND ')} ORDER BY v`,
    ).all(...values) as unknown as { v: string }[]).map(row => row.v);
  }

  /**
   * The value of one fact, or null when it was never stated.
   *
   * Null and empty are different answers: a fact can exist with no value, which
   * says the thing is true and there was nothing to add.
   */
  value(key: FactKey): string | null {
    const found = this.find({ ...key, ...blanks(key) });

    return found.length > 0 ? found[0]!.value : null;
  }

  /**
   * Take back every fact matching a partial key, and say how many went.
   *
   * **For the owner replacing a set, not for tidying up.** Some facts are only
   * true together: the members a partition was built from are the whole truth
   * about that partition, so a rebuild's set replaces the previous one rather
   * than joining it. Removing them one at a time would mean knowing the old set
   * in order to forget it, which is exactly what the new set has made unknowable.
   *
   * The query is the same partial key `find` takes, so what it deletes is what
   * `find` would have returned — which is the only safe way to offer this.
   */
  forgetAll(query: FactQuery): number {
    assertOwns(this.owner, query.topic);

    const where:  string[] = [];
    const values: string[] = [];

    for (const field of FIELDS) {
      const value = query[field];

      if (value === undefined) continue;

      where.push(`${field} = ?`);
      values.push(value);
    }

    for (const [field, start] of Object.entries(query.prefix ?? {})) {
      if (! start) continue;

      where.push(`${field} >= ? AND ${field} < ?`);
      values.push(start, ceiling(start));
    }

    return this.database(query.topic)
      .prepare(`DELETE FROM fact WHERE ${where.join(' AND ')}`).run(...values).changes as number;
  }

  /** Take a fact back. Rare, and meant to be — retraction should feel awkward. */
  forget(key: FactKey): boolean {
    assertOwns(this.owner, key.topic);

    const full = { ...key, ...blanks(key) };
    const done = this.database(key.topic).prepare(
      `DELETE FROM fact WHERE topic = ? AND venue = ? AND period = ? AND market = ?
         AND symbol = ? AND dataset = ? AND subject = ? AND fact = ? AND seq = ?`,
    ).run(full.topic, full.venue, full.period, full.market, full.symbol,
      full.dataset, full.subject, full.fact, full.seq);

    return done.changes > 0;
  }

  close(): void {
    for (const db of this.open.values()) db.close();

    this.open.clear();
  }

  // ── Internals ───────────────────────────────────────────────────────────────

  /**
   * The statement behind a query, shared by `find` and `stream`.
   *
   * Shared rather than duplicated because the two differ only in how they
   * consume the result: one question answered two ways cannot be allowed to
   * become two questions that drift, and the prefix handling below is the part
   * that would drift first.
   */
  private select(query: FactQuery, options: { meta?: boolean }) {
    const where:  string[] = [];
    const values: string[] = [];

    for (const field of FIELDS) {
      const value = query[field];

      if (value === undefined) continue;

      where.push(`${field} = ?`);
      values.push(value);
    }

    /**
     * **Prefixes are ranges, never `LIKE`.**
     *
     * SQLite's `LIKE` optimisation is narrow enough that it is not worth
     * relying on: measured against this schema it did not fire even for an
     * all-digit prefix, and `period LIKE '2026%'` fell back to scanning every
     * row of the venue and filtering. The same question as `>= '2026' AND
     * < '2027'` seeks the index directly.
     *
     * The upper bound is the prefix with its last character incremented, which
     * is why the fields meant to be searched this way should be composed with
     * that in mind — a separator that leaves room above it costs nothing to
     * choose and makes every prefix query an index seek.
     */
    for (const [field, start] of Object.entries(query.prefix ?? {})) {
      if (! start) continue;

      where.push(`${field} >= ? AND ${field} < ?`);
      values.push(start, ceiling(start));
    }

    const statement = this.database(query.topic).prepare(
      `SELECT topic, venue, period, market, symbol, dataset, subject, fact, seq, value,
              created_at AS createdAt, updated_at AS updatedAt
              ${options.meta ? ', meta' : ''}
         FROM fact WHERE ${where.join(' AND ')}
        ORDER BY venue, period, market, symbol, dataset, subject, fact, seq`,
    );

    return { all: () => statement.all(...values), iterate: () => statement.iterate(...values) };
  }

  /**
   * A sortable, unique moment.
   *
   * The clock alone is not enough: two occurrences within the same millisecond
   * would collide on the key and the second would silently replace the first,
   * which is exactly the loss `seq` exists to prevent. A counter breaks the tie
   * and keeps the ordering.
   */
  private moment(): string {
    const now = new Date().toISOString();

    this.tick = now === this.last ? this.tick + 1 : 0;
    this.last = now;

    return this.tick === 0 ? now : `${now}#${String(this.tick).padStart(4, '0')}`;
  }

  /**
   * The database for one topic, created on first use.
   *
   * Creation is the only moment `auto_vacuum` can be set and the only moment the
   * schema is written whole, so both happen here and nowhere else.
   */
  private database(topic: Topic): DatabaseSync {
    const already = this.open.get(topic);

    if (already) return already;

    // A colon is legal in a filename and awkward everywhere else — in a shell,
    // in a URL, in half the tools that will ever look at this directory. The
    // topic keeps its colon; the file it lives in does not.
    const file  = path.join(this.root, `${topic.replace(/:/g, '.')}.sqlite`);
    const fresh = ! existsSync(file);

    if (fresh) mkdirSync(this.root, { recursive: true });

    const db = new DatabaseSync(file);

    if (fresh) for (const pragma of AT_CREATION) db.exec(pragma);

    for (const pragma of ON_OPEN) db.exec(pragma);

    db.exec(FACT_SCHEMA);

    if (fresh) db.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);

    this.open.set(topic, db);

    return db;
  }
}

// ── Internals ─────────────────────────────────────────────────────────────────

/** The queryable columns, in the order the primary key holds them. */
const FIELDS = ['topic', 'venue', 'period', 'market', 'symbol', 'dataset',
  'subject', 'fact', 'seq', 'value'] as const;

/**
 * A key names one row, so its unstated discriminants are empty rather than
 * unconstrained — which is what separates "the fact about this venue-month" from
 * "every fact about every symbol in it".
 */
const blanks = (key: FactKey) => ({
  market:  key.market  ?? '',
  symbol:  key.symbol  ?? '',
  dataset: key.dataset ?? '',
  subject: key.subject ?? '',
  seq:     key.seq     ?? '',
});

/**
 * The exclusive upper bound of a prefix: the prefix with its last character
 * incremented, so `2026` becomes `2027` and `kline/` becomes `kline0`.
 *
 * Everything beginning with the prefix sorts below it and nothing else does,
 * which is what turns a prefix match into a range the index can seek.
 */
const ceiling = (prefix: string): string =>
  prefix.slice(0, -1) + String.fromCharCode(prefix.charCodeAt(prefix.length - 1) + 1);
