/**
 * Librarian HTTP surface — the API of the service. Routes only: each entry
 * binds a method+path to a handler factory from `./handlers/`. Logic, mongo
 * calls and query-param parsing live in their own files; this file exists so
 * the public surface is readable at a glance.
 *
 * Safety only at the edges:
 *   - 32 MB body cap (the express server kind's `json` limit → 413)
 *   - POST: 400 if the body is not a non-empty array
 *   - POST: duplicate-key (E11000) → success when `ignoreDuplicates` is set, else 409
 *   - GET: 400 if `from`/`limit`/`filter` query params are malformed
 *   - any other mongo failure → 500 with the error message
 */

import { Router } from 'express';
import type { Db } from 'mongodb';
import { makeWriteHandler } from './handlers/write';
import { makeReadHandler }  from './handlers/read';
import type { Config, InsertCounter, ReadCounter } from './types';

export const buildRouter = (db: Db, config: Config, writeCounter: InsertCounter, readCounter: ReadCounter): Router => {
  const router = Router();

  /** `/health` must be declared before `/:table` so the generic GET route
   *  doesn't swallow it as `table=health`. */
  router.get('/health', (_req, res) => { res.json({ ok: true }); });

  router.post('/:table', makeWriteHandler(db, config, writeCounter));
  router.get ('/:table', makeReadHandler (db, readCounter));

  return router;
};
