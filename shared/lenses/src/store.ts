import { writing } from './db';
import { misshapen } from './draft';
import { dropMembers } from './members';
import type { DatabaseSync } from 'node:sqlite';
import type { Lens, LensDefinition, LensRow, LensRule } from './types';

/**
 * A lens as a row: read, made, replaced and removed.
 *
 * One row per lens, definition as a JSON document, read whole and written whole.
 * Nothing queries across rules, so normalising them would buy filtering,
 * searching and indexing that nobody wants.
 *
 * **Making, replacing and removing write.** They are for whoever owns the
 * database.
 *
 * **Storing a lens answers at once, and is not the working out of what it lets
 * through.** A lens made or given new rules is marked to be worked out again
 * and returned as it was stored, `updating`; the walk that does the working out
 * is somebody else's to run — see `members.ts`.
 */

/** Every lens, newest first. */
export const lenses = (db: DatabaseSync): Lens[] =>
  (db.prepare('SELECT * FROM lens ORDER BY updated_at DESC').all() as unknown as LensRow[])
    .map(asLens);

/**
 * One lens by the slug a consumer is configured with, or null where there is
 * none.
 *
 * **Never by its `name`.** That is what a person calls it and is free to change;
 * addressing by it would mean renaming a lens reconfigures whoever reads through
 * it.
 */
export const lensNamed = (db: DatabaseSync, slug: string): Lens | null => {
  const row = db.prepare('SELECT * FROM lens WHERE slug = ?').get(slug) as LensRow | undefined;

  return row ? asLens(row) : null;
};

/**
 * Make one, or `null` because the slug is taken.
 *
 * The slug is the handle a consumer passes, so it is the thing that must be
 * unique — and a slug already in use comes back as `null` rather than an
 * exception, because it is an ordinary answer to give a form. `null` means that
 * and nothing else: any other failure to write is thrown.
 */
export const putLens = (
  db:         DatabaseSync,
  slug:       string,
  name:       string,
  note:       string,
  definition: LensDefinition = EMPTY,
): Lens | null => {
  const at = new Date().toISOString();

  try {
    db.prepare(
      `INSERT INTO lens (slug, name, note, definition, created_at, updated_at, rebuilding)
            VALUES (?, ?, ?, ?, ?, ?, 1)`,
    ).run(slug, name || slug, note, JSON.stringify(definition), at, at);
  } catch (err) {
    if (slugTaken(err)) return null;

    throw err;
  }

  return lensNamed(db, slug);
};

/**
 * Replace a lens, whole; `null` where there is no lens of that slug, or where
 * the slug it is given is another lens's. Any other failure to write is thrown.
 *
 * **There is no `PATCH` of one rule**, which is why rules need no stable ids and
 * their position in the array is identity enough. Editing one lens from two
 * places at once is a thing not to do rather than a thing to guard against, and
 * last write wins is the obvious outcome.
 *
 * **New rules are marked to be worked out from the start in the same write that
 * stores them**, so no lens holds rules its members are not being worked out
 * from. A rename or a new note changes nothing a lens lets through, and leaves
 * its working out where it stands.
 */
export const editLens = (
  db:    DatabaseSync,
  slug:  string,
  to:    { slug?: string; name?: string; note?: string; definition?: LensDefinition },
): Lens | null => {
  const had = lensNamed(db, slug);

  if (! had) return null;

  const next = {
    slug:       to.slug       ?? had.slug,
    name:       to.name       ?? had.name,
    note:       to.note       ?? had.note,
    definition: to.definition ?? had.definition,
  };

  const changed = JSON.stringify(next.definition) !== JSON.stringify(had.definition) ? 1 : 0;

  try {
    db.prepare(
      `UPDATE lens SET slug = ?, name = ?, note = ?, definition = ?, updated_at = ?,
                       partitions_through = CASE WHEN ? THEN 0 ELSE partitions_through END,
                       rebuilding         = CASE WHEN ? THEN 1 ELSE rebuilding END
        WHERE slug = ?`,
    ).run(next.slug, next.name, next.note, JSON.stringify(next.definition),
      new Date().toISOString(), changed, changed, slug);
  } catch (err) {
    if (slugTaken(err)) return null;

    throw err;
  }

  return lensNamed(db, next.slug);
};

/** Take one away, and what it let through, in one transaction. Says whether there was one. */
export const dropLens = (db: DatabaseSync, slug: string): boolean => {
  const had = lensNamed(db, slug);

  if (! had) return false;

  writing(db, () => {
    dropMembers(db, had.id!);
    db.prepare('DELETE FROM lens WHERE id = ?').run(had.id!);
  });

  return true;
};

// ── Internals ─────────────────────────────────────────────────────────────────

/** A lens that lets nothing through, which is what a new one starts as. */
const EMPTY: LensDefinition = { format: 1, venues: {} };

const asLens = (row: LensRow): Lens => ({
  id:         row.id,
  slug:       row.slug,
  name:       row.name,
  note:       row.note,
  createdAt:  row.created_at,
  updatedAt:  row.updated_at,
  definition: read(row),
  updating:   row.rebuilding === 1,
});

/** Whether a write failed only because another lens has the slug: SQLite's unique-constraint failure, on `lens.slug`. */
const slugTaken = (err: unknown): boolean => {
  const e = err as { errcode?: number; message?: string } | null;

  return e?.errcode === SQLITE_CONSTRAINT_UNIQUE && /lens\.slug/.test(e.message ?? '');
};

const SQLITE_CONSTRAINT_UNIQUE = 2067;

/**
 * A stored definition, as much of it as is a rule.
 *
 * **What cannot be read lets nothing through**, which is the safe direction: a
 * lens is an allow-list, so failing closed hands back nothing rather than the
 * whole archive. A document that does not parse, or is not a document of venues,
 * reads as empty; a venue whose rules are not a list reads as having none; a
 * rule that is not shaped as one (see `misshapen`) is left out on its own, and
 * the rules beside it stand. What is left out is reported once for each version
 * of a lens.
 */
const read = (row: LensRow): LensDefinition => {
  let had: unknown;

  try {
    had = JSON.parse(row.definition);
  } catch {
    return dropped(row, 'its definition is not JSON', { format: 1, venues: {} });
  }

  if (typeof had !== 'object' || had === null || Array.isArray(had))
    return dropped(row, 'its definition is not a document', { format: 1, venues: {} });

  const { format, venues } = had as { format?: unknown; venues?: unknown };

  if (venues !== undefined && (typeof venues !== 'object' || venues === null || Array.isArray(venues)))
    return dropped(row, 'its venues are not a document', { format: 1, venues: {} });

  const lost: string[] = [];
  const out:  LensDefinition['venues'] = {};

  for (const [venue, rules] of Object.entries(venues ?? {})) {
    if (! Array.isArray(rules)) {
      lost.push(`${venue}: not a list of rules`);

      continue;
    }

    out[venue] = rules.filter((rule: unknown, at) => {
      const faults = misshapen(rule);

      if (faults.length > 0) lost.push(`${venue} #${at}: ${faults.map(one => one.message).join(' ')}`);

      return faults.length === 0;
    }).map(month);
  }

  const definition = { format: typeof format === 'number' ? format : 1, venues: out };

  return lost.length > 0 ? dropped(row, `left out ${lost.join('; ')}`, definition) : definition;
};

/** Report once for each version of a lens what of its stored definition could not be read, and hand back what could. */
const dropped = (row: LensRow, what: string, definition: LensDefinition): LensDefinition => {
  const version = `${row.id}\u0000${row.updated_at}`;

  if (! REPORTED.has(version)) {
    REPORTED.add(version);
    console.warn(`Lens '${row.slug}' (as stored ${row.updated_at}) is read without what is not a rule: ${what}`);
  }

  return definition;
};

/** The versions of a lens already reported as stored with something that is not a rule. */
const REPORTED = new Set<string>();

/**
 * A rule's bounds as months: a stored bound longer than a month is read as its
 * month, which is how it was already compared everywhere.
 */
const month = (rule: LensRule): LensRule => ({
  ...rule,
  ...(rule.from !== undefined ? { from: rule.from.slice(0, 6) } : {}),
  ...(rule.to   !== undefined ? { to:   rule.to.slice(0, 6)   } : {}),
});
