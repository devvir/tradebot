import { lensNamed } from '@tradebot/lenses';
import { INVALID, queryText, xmlCarries } from '../api/query';
import { lensScope } from './scope';
import type { Lens } from '@tradebot/lenses';
import type { Request } from 'express';
import type { DatabaseSync } from 'node:sqlite';
import type { RequestedLens } from '../types';

/**
 * The lens a request names — see `lensSlug` for where it is named.
 *
 * Null where it names none — the whole catalog. `undefined` where it names one
 * that does not exist, or gives the `lens` parameter more than once, which every
 * caller answers with a `422` — see `noSuchLens`: an unknown lens is never the
 * unfiltered catalog in its place.
 */
export const lensOf = (db: DatabaseSync, req: Request): Lens | null | undefined => {
  const slug = lensSlug(req);

  if (slug === INVALID) return undefined;

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
 * names one; `INVALID` where the parameter, read for want of a header, is given
 * more than once.
 */
export const lensSlug = (req: Request): string | null | typeof INVALID => {
  const header = req.headers['x-catalog-lens'];

  if (typeof header === 'string' && header.trim() !== '') return header.trim();

  const query = queryText(req.query['lens']);

  if (query === INVALID) return INVALID;

  return query === undefined || query.trim() === '' ? null : query.trim();
};

/**
 * Why a request's lens was not found, in words fit to answer it with: the slug
 * it names, unless XML could not carry that slug back.
 */
export const noSuchLens = (req: Request): string => {
  const slug = lensSlug(req);

  if (slug === INVALID) return 'The lens parameter may be given once';

  return slug !== null && xmlCarries(slug) ? `No such lens: ${slug}` : 'No such lens';
};
