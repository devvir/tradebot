import { metadataOf } from '../etag';
import type { ProbedContext, Scanner } from '../types';

/**
 * A venue whose keys are **constructed and confirmed one at a time**, because it
 * publishes no listing at any layer.
 *
 * There is nothing to walk, so `scopes` is empty and `page` is never reached:
 * what such a venue publishes is declared in its series, and generating the
 * dates each is missing is what an update does — for every venue. See
 * `update.ts`.
 *
 * What is left is the one question a caller can ask about a single key, which is
 * a `HEAD` and nothing more. That is not scanning, and this is not a scanner
 * that scans: it is the description of a venue that can only be asked, never
 * read.
 */
export const probed: Scanner<ProbedContext> = {
  name: 'probed',

  scopes: async () => [],

  page: async () => ({ listed: [], cursor: null }),

  confirm: async (context, path) => {
    const seen = await context.head(`${context.base}/${context.keyRoot}${path}`);

    if (seen.status < 200 || seen.status > 299) return seen;

    return { key: path, ...metadataOf(seen.headers) };
  },
};
