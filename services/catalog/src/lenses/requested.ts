import { lensNamed } from './lens';
import { lensScope } from './scope';
import type { Request } from 'express';
import type { DatabaseSync } from 'node:sqlite';
import type { RequestedLens } from '../types';

/**
 * The lens a request names in `x-catalog-lens`, resolved.
 *
 * Null where it names none — the whole catalog. `undefined` where it names one
 * that does not exist, which every caller answers with a `404`: an unknown lens
 * is never the unfiltered catalog in its place.
 */
export const lensRequested = (db: DatabaseSync, req: Request): RequestedLens | null | undefined => {
  const slug = req.headers['x-catalog-lens'];

  if (typeof slug !== 'string' || slug.trim() === '') return null;

  const lens  = lensNamed(db, slug.trim());
  const scope = lens ? lensScope(db, lens.slug) : null;

  return lens && scope ? { lens, scope } : undefined;
};
