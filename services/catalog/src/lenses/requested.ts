import { lensNamed } from '@tradebot/lenses';
import { lensScope } from './scope';
import type { Lens } from '@tradebot/lenses';
import type { Request } from 'express';
import type { DatabaseSync } from 'node:sqlite';
import type { RequestedLens } from '../types';

/**
 * The lens a request names — see `lensSlug` for where it is named.
 *
 * Null where it names none — the whole catalog. `undefined` where it names one
 * that does not exist, which every caller answers with a `422`: an unknown lens
 * is never the unfiltered catalog in its place.
 */
export const lensOf = (db: DatabaseSync, req: Request): Lens | null | undefined => {
  const slug = lensSlug(req);

  return slug === null ? null : lensNamed(db, slug) ?? undefined;
};

/**
 * The lens a request names with its scope resolved — see `lensScope` — for
 * callers that read the contents through it. Null and `undefined` as `lensOf`.
 */
export const lensRequested = (db: DatabaseSync, req: Request): RequestedLens | null | undefined => {
  const lens = lensOf(db, req);

  if (! lens) return lens;

  const scope = lensScope(db, lens);

  return scope ? { lens, scope } : undefined;
};

/**
 * The slug a request names: the `x-catalog-lens` header, or a `lens` query
 * parameter where there is no header — the header for clients, the parameter
 * so a browser's address bar can look through a lens too. Null where neither
 * names one.
 */
export const lensSlug = (req: Request): string | null => {
  const header = req.headers['x-catalog-lens'];
  const query  = req.query['lens'];
  const slug   = typeof header === 'string' && header.trim() !== '' ? header : typeof query === 'string' ? query : '';

  return slug.trim() === '' ? null : slug.trim();
};
