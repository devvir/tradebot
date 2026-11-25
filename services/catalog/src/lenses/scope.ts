import { union } from '@tradebot/lenses';
import type { Lens } from '@tradebot/lenses';
import type { DatabaseSync, StatementSync } from 'node:sqlite';
import type { HeldScope, LensScope, LensSpan, Series } from '../types';

/**
 * A lens as the contents read it: for each venue, the slices it lets through
 * and the months of each, as spans. Null where the lens is no longer stored.
 *
 * **Read off `lens_member`**, so it is the same answer the listing and the
 * sizes read — and nothing here evaluates a rule.
 *
 * **Held per database until the lens changes**: until it is saved again, or
 * partitions are added to it. Either moves what is compared below, so a held
 * scope is never stale and never thrown away while it is still true.
 */
export const lensScope = (db: DatabaseSync, lens: Lens): LensScope | null => {
  const state = statementsOf(db).state.get(lens.id) as { updatedAt: string; through: number } | undefined;
  const held  = scopesOf(db);

  if (! state) {
    held.delete(lens.id);

    return null;
  }

  const kept = held.get(lens.id);

  if (kept && kept.updatedAt === state.updatedAt && kept.through === state.through) return kept.scope;

  const scope = new Map<string, Map<number, LensSpan[]>>();

  for (const row of statementsOf(db).members.all(lens.id) as { venue: string; sliceId: number; month: string }[]) {
    const venue = scope.get(row.venue) ?? new Map<number, LensSpan[]>();

    venue.set(row.sliceId, union(venue.get(row.sliceId) ?? [], { from: row.month, to: row.month }));
    scope.set(row.venue, venue);
  }

  held.set(lens.id, { updatedAt: state.updatedAt, through: state.through, scope });

  return scope;
};

/**
 * Series as a lens sees them: only those of a slice it lets through, each with
 * its first and last file **inside the lens's months**, and none with no file
 * inside them.
 *
 * **Tested against each span of its slice**, never against their outer edges: a
 * lens that carves a hole leaves a slice two spans, and a series whose dates
 * fall wholly inside the hole is not in the lens.
 *
 * **Exact where it is asked to be.** A series the lens cuts then reports the
 * oldest and newest file it actually holds within the lens, rather than the
 * lens's own edge, which would claim data up to a date nothing was published
 * for. Its first file is looked for span by span from the front and its last
 * from the back, each stopping at the first span that holds one — two indexed
 * reads, more only where a span it reaches holds nothing of it.
 *
 * **Without `exact`, only the dates are read**: the series is kept where its
 * first..last range meets a span, and its dates are clamped to the first and
 * last span it meets. That costs no read and is what a whole venue's summary
 * can afford — tens of thousands of series — but it cannot tell a series whose
 * files all sit in a hole while its range still reaches a span, and it is kept.
 *
 * **A series with no file at all is not in the lens**, whatever its pattern
 * says: a lens is what is on offer, and a seeded series nothing has been found
 * for offers nothing. The rows are copies; the registry's own are never touched.
 */
export const throughLens = (
  db:    DatabaseSync,
  rows:  readonly Series[],
  spans: ReadonlyMap<number, readonly LensSpan[]>,
  exact = true,
): Series[] => {
  const out: Series[] = [];

  for (const row of rows) {
    const held = spans.get(row.sliceId);

    if (! held || row.first === null) continue;

    const first = row.first, last = row.last ?? row.first;
    const start = (span: LensSpan): string => (span.from === null ? '' : startAt(span.from, first.length));
    const end   = (span: LensSpan): string => (span.to === null ? OPEN_END : endAt(span.to, last.length));
    const hit   = held.filter(span => start(span) <= last && first <= end(span));

    if (hit.length === 0) continue;

    if (hit.length === 1 && start(hit[0]!) <= first && last <= end(hit[0]!)) {
      out.push(row);

      continue;
    }

    if (! exact) {
      const lo = start(hit[0]!), hi = end(hit.at(-1)!);

      out.push({ ...row, first: first > lo ? first : lo, last: last < hi ? last : hi });

      continue;
    }

    const { oldest, newest } = statementsOf(db);
    const from = firstOf(hit, span => (oldest.get(row.id, start(span), end(span)) as { at: string | null }).at);

    if (from === null) continue;

    const to = firstOf([...hit].reverse(), span => (newest.get(row.id, start(span), end(span)) as { at: string | null }).at);

    out.push({ ...row, first: from, last: to ?? from });
  }

  return out;
};

// ── Internals ─────────────────────────────────────────────────────────────────

/** Above every stamp at any width: the end of a span open that way. */
const OPEN_END = '99999999999999';

/** The first answer that is not null, asking each span in turn. */
const firstOf = (spans: readonly LensSpan[], ask: (span: LensSpan) => string | null): string | null => {
  for (const span of spans) {
    const at = ask(span);

    if (at !== null) return at;
  }

  return null;
};

/** The reads prepared once per database. */
interface ScopeStatements {
  /** A lens's `updated_at` and `partitions_through`, together. */
  state:   StatementSync;
  /** The months of every partition a lens lets through, by slice. */
  members: StatementSync;
  /** The oldest, and the newest, file of a series between two stamps, read off its index. */
  oldest:  StatementSync;
  newest:  StatementSync;
}

const statementsOf = (db: DatabaseSync): ScopeStatements => {
  let held = STATEMENTS.get(db);

  if (! held) {
    held = {
      state: db.prepare('SELECT updated_at AS updatedAt, partitions_through AS through FROM lens WHERE id = ?'),
      members: db.prepare(
        `SELECT c.venue, q.slice_id AS sliceId, q.month
           FROM lens_member l
           JOIN partition q ON q.id = l.partition_id
           JOIN slice c     ON c.id = q.slice_id
          WHERE l.lens_id = ?
          ORDER BY q.slice_id, q.month`),
      oldest: db.prepare(`SELECT MIN(date) AS at FROM file
                           WHERE series_id = ? AND date >= ? AND date <= ? AND existence = 'confirmed'`),
      newest: db.prepare(`SELECT MAX(date) AS at FROM file
                           WHERE series_id = ? AND date >= ? AND date <= ? AND existence = 'confirmed'`),
    };
    STATEMENTS.set(db, held);
  }

  return held;
};

const STATEMENTS = new WeakMap<DatabaseSync, ScopeStatements>();

/** The scopes held for one database, by lens id. */
const scopesOf = (db: DatabaseSync): Map<number, HeldScope> => {
  let held = SCOPES.get(db);

  if (! held) {
    held = new Map();
    SCOPES.set(db, held);
  }

  return held;
};

const SCOPES = new WeakMap<DatabaseSync, Map<number, HeldScope>>();

/** The first period of a month, at a stamp's width: `202001`, `20200101`, `2020010100`… */
const startAt = (month: string, width: number): string =>
  width <= 6 ? month : `${month}01`.padEnd(width, '0');

/** The last period of a month, at a stamp's width: `202001`, `20200131`, `2020013123`… */
const endAt = (month: string, width: number): string => {
  if (width <= 6) return month;

  const days = new Date(Date.UTC(Number(month.slice(0, 4)), Number(month.slice(4, 6)), 0)).getUTCDate();

  return `${month}${String(days).padStart(2, '0')}${'2359'.slice(0, width - 8)}`;
};
