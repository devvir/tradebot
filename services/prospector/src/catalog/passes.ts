import type { DatabaseSync } from 'node:sqlite';
import { openPartitions } from './jobs';
import type { FinishedRun, LastRun, Phase, RunKind } from '../types';

/**
 * What a venue's runs say about its passes: how far it has got, whether it has
 * ever finished one, when a prefix was last established, and what it last did.
 *
 * Read entirely off the `run` rows `jobs.ts` writes: nothing here is recorded
 * separately, so nothing here can disagree with them.
 */

/**
 * How far a venue has got, in one word, read entirely off its rows.
 *
 * **Nothing records this separately.** Two places to keep a state is two places
 * to disagree, and every question the phase answers is already answered by which
 * runs exist and which have finished:
 *
 * - no runs at all, so nothing has ever started
 * - runs exist, none has turned a page: the brief moment after they are created
 * - something still has keyspace ahead of its cursor
 * - everything is exhausted, and a job has closed over it before, so what is
 *   left is finding what has appeared since
 *
 * **Having been complete once is permanent**, and a closed job is what records
 * it: from then on a venue reads `updating` wherever it would read `complete`.
 * That is the venue's standing, not a promise about its next pass. A scope once
 * exhausted is never walked again, while a later walk plans scopes of its own
 * and reads `running` while they have keyspace ahead.
 *
 * **Read off whichever kind of run the venue actually does.** A venue with a
 * keyspace to read walks it; okx and bitget have none and only ever generate
 * keys from their series, so they have `update` rows and never a single
 * `walk` — and asking only about walks reports them as `not run` however many
 * millions of files they have established. Nothing here names a venue: the rows
 * say which kind it is.
 */
export const phaseOf = (db: DatabaseSync, venueId: number): Phase => {
  const kind: RunKind = ranAny(db, venueId, 'walk') ? 'walk' : 'update';

  const working = openPartitions(db, venueId, kind).filter(run => run.scope !== '');

  if (working.length > 0)
    return working.some(run => run.requests > 0) ? 'running' : 'planned';

  if (! ranAny(db, venueId, kind)) return 'not run';

  return everCompleted(db, venueId) ? 'updating' : 'complete';
};

/**
 * Whether this venue has ever finished a pass of the kind it is surveyed by.
 *
 * **A query of its own rather than a reading of `phaseOf`.** A venue paused
 * halfway through an update has open partitions, so its phase is `running` —
 * which says where it is now and cannot say whether it has ever been complete.
 *
 * Read off whichever kind the venue actually runs, so a venue with no keyspace
 * to walk — okx, bitget — answers about its updates instead of about walks it
 * will never have.
 */
export const everCompleted = (db: DatabaseSync, venueId: number): boolean => {
  const kind: RunKind = ranAny(db, venueId, 'walk') ? 'walk' : 'update';

  return db.prepare(
    `SELECT 1 FROM run
      WHERE venue_id = ? AND kind = ? AND scope = '' AND completed IS NOT NULL LIMIT 1`,
  ).get(venueId, kind) !== undefined;
};

/**
 * When a prefix was last established, or null if it never was.
 *
 * **Returns the walk's `started`, not its `completed`.** That is the honest
 * claim: a walk guarantees the archive as it was when it began, and anything it
 * picked up later is incidental. Reporting the finish time would claim hours or
 * days the walk never looked at.
 *
 * Completion propagates **downward**: a walk of `spot/` settles everything
 * beneath it, so a question about `spot/monthly/klines/` is answered by any
 * ancestor that has been walked. Asking is therefore one indexed lookup over a
 * handful of keys rather than a scan.
 *
 * Where several ancestors qualify, the answer is the **latest** of them. Each is
 * a true statement about this prefix — an ancestor's walk covered it — so the
 * strongest true statement is the most recent one. Taking the shortest ancestor
 * instead would let a venue-wide pass from last month shadow a walk of this very
 * prefix from an hour ago, and understate what is known.
 */
export const establishedAt = (
  db:      DatabaseSync,
  venueId: number,
  prefix:  string,
): string | null => {
  const kind: RunKind = ranAny(db, venueId, 'walk') ? 'walk' : 'update';
  const chain = ancestorsOf(prefix);
  const holes = chain.map(() => '?').join(', ');

  /**
   * **Only the kind that establishes a venue counts.** A venue that has ever
   * been walked is established by walks; an update reads only the newest
   * stretch of each series, so its completed run says nothing about the rest
   * of the tree. A venue that is never walked is established by its updates.
   *
   * **A completed ancestor does not count while anything below it is still
   * being walked.**
   *
   * Splitting a partition closes the parent and creates children carrying the
   * rest of its keyspace — so the parent's `completed` says "this run stopped",
   * not "this prefix is established". Read without the guard, a venue would
   * claim a whole tree the moment it was divided, and close the venue over
   * keyspace nobody had read.
   *
   * The descendant test is a prefix comparison rather than `LIKE`, so a scope
   * containing `%` or `_` cannot quietly match more than itself.
   */
  const row = db.prepare(
    `SELECT MAX(r.started) AS started FROM run r
      WHERE r.venue_id = ? AND r.kind = ? AND r.scope IN (${holes}) AND r.completed IS NOT NULL
        AND NOT EXISTS (
          SELECT 1 FROM run o
           WHERE o.venue_id = r.venue_id AND o.kind = r.kind
             AND o.completed IS NULL AND o.scope != ''
             AND substr(o.scope, 1, length(r.scope)) = r.scope
        )`,
  ).get(venueId, kind, ...chain) as { started: string | null };

  return row.started;
};

/**
 * Every prefix that contains this one, longest last, including it and the empty
 * prefix that means the whole venue.
 *
 * `spot/monthly/klines/` → `['', 'spot/', 'spot/monthly/', 'spot/monthly/klines/']`
 */
export const ancestorsOf = (prefix: string): string[] => {
  const parts = prefix.split('/').filter(Boolean);
  const chain = [''];

  let walked = '';

  for (const part of parts) {
    walked += `${part}/`;
    chain.push(walked);
  }

  return chain;
};

/** The newest pass across every host of a venue — see `LastRun`. */
export const lastRun = (db: DatabaseSync, venueIds: readonly number[]): LastRun => {
  const rows = venueIds
    .map(id => newestRun(db, id))
    .filter((one): one is NonNullable<typeof one> => one !== undefined)
    .sort((a, b) => b.started.localeCompare(a.started));

  /**
   * **Backfilling until every host has read itself through once**, which is the
   * same test `everCompleted` answers with — one fact, asked from two places,
   * rather than two rules that can disagree about the same venue.
   */
  const first = ! venueIds.every(id => everCompleted(db, id));

  const open = rows.find(one => one.completed === null);

  if (open)
    return { kind: open.kind, at: null, startedAt: open.started, ongoing: true, first, previous: previousRun(db, venueIds) };

  const done = rows[0];

  return done
    ? { kind: done.kind, at: done.completed, startedAt: done.started, ongoing: false, first, previous: null }
    : { kind: null, at: null, startedAt: null, ongoing: false, first: false, previous: null };
};

/**
 * When this venue's newest walk began, or undefined where it has never walked.
 *
 * **Its start, because that is what a cadence counts from**: a walk that ran for
 * thirty hours was still this venue's reading of the archive as it stood when it
 * opened.
 *
 * **Whether it completed is not asked, because it cannot differ.** The only
 * caller is the recurrence decision, and that is reached solely from the
 * `updating` phase — a venue whose walk has not finished keeps walking by the
 * phase rule in `passFor` and never gets there. So the newest walk row here is
 * always a finished one.
 */
export const walkedAt = (db: DatabaseSync, venueId: number): string | undefined =>
  (db.prepare(
    `SELECT MAX(started) AS started FROM run
      WHERE venue_id = ? AND scope = '' AND kind = 'walk'`,
  ).get(venueId) as { started: string | null }).started ?? undefined;

/** One host's newest whole pass of either kind, however it ended. */
export const newestRun = (db: DatabaseSync, venueId: number) =>
  db.prepare(
    `SELECT kind, started, completed FROM run
      WHERE venue_id = ? AND scope = '' AND kind IN ('walk', 'update')
      ORDER BY started DESC
      LIMIT 1`,
  ).get(venueId) as { kind: RunKind; started: string; completed: string | null } | undefined;

// ── Internals ─────────────────────────────────────────────────────────────────

/**
 * The newest pass that finished, across every host, and whether it was the
 * backfill — what a venue last *achieved*, for while another pass runs.
 *
 * **The backfill ends when the last host first finishes**, the moment
 * `everCompleted` turns true, so a pass that finished by then was part of it.
 * Where some host has never finished one, the venue is still backfilling and
 * every finished pass belongs to that.
 */
const previousRun = (db: DatabaseSync, venueIds: readonly number[]): FinishedRun | null => {
  const done = db.prepare(
    `SELECT started, completed FROM run
      WHERE venue_id = ? AND scope = '' AND kind IN ('walk', 'update') AND completed IS NOT NULL
      ORDER BY completed DESC
      LIMIT 1`,
  );
  const firstDone = db.prepare(
    `SELECT MIN(completed) AS at FROM run
      WHERE venue_id = ? AND scope = '' AND kind IN ('walk', 'update') AND completed IS NOT NULL`,
  );

  const newest = venueIds
    .map(id => done.get(id) as { started: string; completed: string } | undefined)
    .filter((one): one is { started: string; completed: string } => one !== undefined)
    .sort((a, b) => b.completed.localeCompare(a.completed))[0];

  if (! newest) return null;

  const firsts = venueIds.map(id => (firstDone.get(id) as { at: string | null }).at);
  const backfilled = firsts.includes(null) ? null : firsts.sort().at(-1)!;

  return {
    at:        newest.completed,
    startedAt: newest.started,
    first:     backfilled === null || newest.completed <= backfilled,
  };
};

/**
 * Whether a venue has ever opened a run of this kind.
 *
 * **Asks whether one exists, never how many there are.** A count reads every
 * matching row — htx and bitget carry tens of thousands each — to answer a
 * question the first row already settles.
 */
const ranAny = (db: DatabaseSync, venueId: number, kind: RunKind): boolean =>
  db.prepare('SELECT 1 FROM run WHERE venue_id = ? AND kind = ? LIMIT 1')
    .get(venueId, kind) !== undefined;
