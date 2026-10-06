import { dropMembers, rebuild } from './members';
import type { DatabaseSync } from 'node:sqlite';
import type { Lens, LensDefinition, LensRow } from './types';

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
 * Make one, or fail because the name is taken.
 *
 * The name is the handle a consumer passes, so it is the thing that must be
 * unique — and the caller gets `null` rather than an exception, because a name
 * already in use is an ordinary answer to give a form.
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
  } catch {
    return null;
  }

  return lensNamed(db, slug);
};

/**
 * Replace a lens, whole.
 *
 * **There is no `PATCH` of one rule**, which is why rules need no stable ids and
 * their position in the array is identity enough. Editing one lens from two
 * places at once is a thing not to do rather than a thing to guard against, and
 * last write wins is the obvious outcome.
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

  try {
    db.prepare(
      `UPDATE lens SET slug = ?, name = ?, note = ?, definition = ?, updated_at = ?
        WHERE slug = ?`,
    ).run(next.slug, next.name, next.note, JSON.stringify(next.definition),
      new Date().toISOString(), slug);
  } catch {
    return null;
  }

  // New rules are worked out from the start; a rename or a new note changes nothing a lens lets through.
  if (JSON.stringify(next.definition) !== JSON.stringify(had.definition)) rebuild(db, had.id!);

  return lensNamed(db, next.slug);
};

/** Take one away, and what it let through. Says whether there was one. */
export const dropLens = (db: DatabaseSync, slug: string): boolean => {
  const had = lensNamed(db, slug);

  if (! had) return false;

  dropMembers(db, had.id!);
  db.prepare('DELETE FROM lens WHERE id = ?').run(had.id!);

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
  definition: read(row.definition),
  updating:   row.rebuilding === 1,
});

/**
 * A stored definition, or an empty one.
 *
 * **A document that cannot be parsed lets nothing through**, which is the safe
 * direction: a lens is an allow-list, so failing closed hands back nothing rather
 * than the whole archive.
 */
const read = (text: string): LensDefinition => {
  try {
    const had = JSON.parse(text) as LensDefinition;

    return { format: had.format ?? 1, venues: months(had.venues ?? {}) };
  } catch {
    return { format: 1, venues: {} };
  }
};

/**
 * Bounds as months, whatever was stored.
 *
 * **Lenses written before a bound was a month carry a day.** Truncating on the
 * way out costs nothing, keeps them valid, and means the first save writes the
 * month — rather than an editor refusing to store a lens it did not write.
 *
 * Truncation is right in both directions: a day bound was already being read as
 * its month everywhere it was compared.
 */
const months = (venues: LensDefinition['venues']): LensDefinition['venues'] =>
  Object.fromEntries(Object.entries(venues).map(([venue, rules]) => [venue, rules.map(rule => ({
    ...rule,
    ...(rule.from ? { from: rule.from.slice(0, 6) } : {}),
    ...(rule.to   ? { to:   rule.to.slice(0, 6)   } : {}),
  }))]));
