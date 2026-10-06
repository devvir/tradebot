import { lensNamed, union } from '@tradebot/lenses';
import type { DatabaseSync, StatementSync } from 'node:sqlite';
import type { HeldScope, LensScope, LensSpan, LensWindow, Series } from '../types';

/**
 * A lens as the contents read it: for each venue, the slices it lets through
 * and the months of each, as spans. Null where no lens has that slug.
 *
 * **Read off `lens_member`**, so it is the same answer the listing and the
 * sizes read — and nothing here evaluates a rule.
 *
 * **Held until the lens changes**: until it is saved again, or partitions are
 * added to it. Either moves what is compared below, so a held scope is never
 * stale and never thrown away while it is still true.
 */
export const lensScope = (db: DatabaseSync, slug: string): LensScope | null => {
  const lens = lensNamed(db, slug);

  if (! lens) return null;

  const through = (db.prepare('SELECT partitions_through AS at FROM lens WHERE id = ?').get(lens.id!) as { at: number }).at;
  const held    = SCOPES.get(slug);

  if (held && held.updatedAt === lens.updatedAt && held.through === through) return held.scope;

  const scope = new Map<string, Map<number, LensSpan[]>>();

  for (const row of db.prepare(
    `SELECT c.venue, q.slice_id AS sliceId, q.month
       FROM lens_member l
       JOIN partition q ON q.id = l.partition_id
       JOIN slice c     ON c.id = q.slice_id
      WHERE l.lens_id = ?
      ORDER BY q.slice_id, q.month`,
  ).all(lens.id!) as { venue: string; sliceId: number; month: string }[]) {
    const venue = scope.get(row.venue) ?? new Map<number, LensSpan[]>();

    venue.set(row.sliceId, union(venue.get(row.sliceId) ?? [], { from: row.month, to: row.month }));
    scope.set(row.venue, venue);
  }

  SCOPES.set(slug, { updatedAt: lens.updatedAt, through, scope });

  return scope;
};

/**
 * Series as a lens sees them: only those of a slice it lets through, each with
 * its first and last file **inside the lens's months**, and none with no file
 * inside them.
 *
 * **Exact where it is asked to be.** A series the lens cuts then reports the
 * oldest and newest file it actually holds within the lens — one indexed read
 * per such series — rather than the lens's own edge, which would claim data up
 * to a date nothing was published for. Without `exact` the dates are clamped to
 * the lens instead, which costs nothing and is what a whole venue's summary
 * can afford: tens of thousands of series, where the edges only move a month.
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
  const read = bounds(db);

  for (const row of rows) {
    const held = spans.get(row.sliceId);

    if (! held || row.first === null) continue;

    const { from, to } = windowOf(held);
    const first = row.first, last = row.last;

    const cut = first !== null && last !== null && (
      (from !== null && first < startAt(from, first.length))
      || (to !== null && last > endAt(to, last.length)));

    if (! cut) {
      out.push(row);

      continue;
    }

    if (! exact) {
      const lo = from === null || first! >= startAt(from, first!.length) ? first! : startAt(from, first!.length);
      const hi = to === null || last! <= endAt(to, last!.length) ? last! : endAt(to, last!.length);

      if (lo <= hi) out.push({ ...row, first: lo, last: hi });

      continue;
    }

    const found = read.get(row.id!,
      from === null ? '' : startAt(from, first!.length),
      to === null ? '99999999999999' : endAt(to, last!.length)) as { first: string | null; last: string | null };

    if (found.first === null) continue;

    out.push({ ...row, first: found.first, last: found.last });
  }

  return out;
};

// ── Internals ─────────────────────────────────────────────────────────────────

/** The oldest and newest file of a series between two stamps, read off its index. */
const bounds = (db: DatabaseSync): StatementSync => {
  let held = BOUNDS.get(db);

  if (! held) {
    held = db.prepare(`SELECT MIN(date) AS first, MAX(date) AS last FROM file
                        WHERE series_id = ? AND date >= ? AND date <= ? AND existence = 'confirmed'`);
    BOUNDS.set(db, held);
  }

  return held;
};

const BOUNDS = new WeakMap<DatabaseSync, StatementSync>();

/** The outermost dates of a slice's spans; null where any of them is open that way. */
const windowOf = (spans: readonly LensSpan[]): LensWindow => ({
  from: spans.some(one => one.from === null) ? null : spans.reduce((min, one) => (one.from! < min ? one.from! : min), spans[0]!.from!),
  to:   spans.some(one => one.to === null) ? null : spans.reduce((max, one) => (one.to! > max ? one.to! : max), spans[0]!.to!),
});

/** The first period of a month, at a stamp's width: `202001`, `20200101`, `2020010100`… */
const startAt = (month: string, width: number): string =>
  width <= 6 ? month : `${month}01`.padEnd(width, '0');

/** The last period of a month, at a stamp's width: `202001`, `20200131`, `2020013123`… */
const endAt = (month: string, width: number): string => {
  if (width <= 6) return month;

  const days = new Date(Date.UTC(Number(month.slice(0, 4)), Number(month.slice(4, 6)), 0)).getUTCDate();

  return `${month}${String(days).padStart(2, '0')}${'2359'.slice(0, width - 8)}`;
};



const SCOPES = new Map<string, HeldScope>();

// ── Test access ───────────────────────────────────────────────────────────────

export const _test_scopes = SCOPES;
