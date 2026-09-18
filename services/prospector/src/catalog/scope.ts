import { lensNamed, resolve } from './lens';
import type { DatabaseSync } from 'node:sqlite';
import type { HeldScope, LensScope } from '../types';

/**
 * A lens as every query applies it: for each venue, the series it lets through
 * and the date spans of each. Null where no lens has that slug.
 *
 * **The one place a lens turns into something a query can use**, so a listing,
 * a count or a size all read the same answer — resolved by the same three steps
 * the editor shows (patterns, then series, then dates; see `resolve`) and
 * applied per file with `holds`. Nothing downstream re-reads rules.
 *
 * **Held for `KEEP_MS`, and dropped the moment the lens is edited.** Resolving
 * folds the whole series registry, which a listing would otherwise do for every
 * page; the registry grows as surveys find instruments, so the hold is short
 * enough that a new series is in the lens within a minute.
 */
export const lensScope = (db: DatabaseSync, slug: string): LensScope | null => {
  const lens = lensNamed(db, slug);

  if (! lens) return null;

  const held = SCOPES.get(slug);

  if (held && held.updatedAt === lens.updatedAt && Date.now() - held.at < KEEP_MS) return held.scope;

  const scope: LensScope = new Map([...resolve(db, lens.definition)].map(([venue, slices]) =>
    [venue, new Map(slices.map(slice => [slice.seriesId, slice.spans]))]));

  SCOPES.set(slug, { at: Date.now(), updatedAt: lens.updatedAt, scope });

  return scope;
};

// ── Internals ─────────────────────────────────────────────────────────────────

const KEEP_MS = 60_000;

const SCOPES = new Map<string, HeldScope>();

// ── Test access ───────────────────────────────────────────────────────────────

export const _test_scopes = SCOPES;
