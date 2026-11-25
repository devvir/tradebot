import { createHash, timingSafeEqual } from 'node:crypto';
import { logger } from '@devvir/service-kit';
import express from 'express';
import { mountContents } from './contents';
import { mountLenses } from './lenses';
import { failed, mountListings } from './listings';
import { mountReports } from './reports';
import type { Application, NextFunction, Request, Response } from 'express';
import type { DatabaseSync } from 'node:sqlite';

/**
 * The catalog's public API: the listings a downloader walks, the contents a
 * person browses, the lenses a consumer reads through, and the reports a
 * downloader sends back — forwarded to prospector, which settles them.
 *
 * **The token is checked before anything else is done**, a body read included:
 * a request without it costs a header comparison. A JSON body is read after
 * that, up to `BODY_LIMIT`, or `REPORT_LIMIT` for a report. A path no route
 * answers is a `404` in the shape of its family — S3's `NoSuchKey` under
 * `/listings`, `{ error }` everywhere else.
 */
export const mount = (app: Application, db: DatabaseSync, token: string): void => {
  app.use(requireToken(token));
  app.use(stillWanted);

  // A body already read, as a report's is by the route's own parser, is left as it is by the one after it.
  app.post('/listings/report', express.json({ limit: REPORT_LIMIT }));
  app.use(express.json({ limit: BODY_LIMIT }));

  mountListings(app, db);
  mountReports(app, db);
  mountContents(app, db);
  mountLenses(app, db);

  app.use(notFound);
  app.use(onError);
};

// ── Internals ─────────────────────────────────────────────────────────────────

/** The largest JSON body taken: a lens definition, or a lens write, with room to spare. */
const BODY_LIMIT = '256kb';

/**
 * The largest report taken. A report may name up to `MAX_REPORT` (10,000) keys,
 * each some hundred bytes, and more as a mismatch with its size and ETag.
 */
const REPORT_LIMIT = '5mb';

/**
 * One shared secret, checked on the way in — a closed door rather than
 * authentication. An empty token takes the door off, which config warns about.
 *
 * **Compared as digests, in constant time**, so how long a refusal takes says
 * nothing about how much of a guess was right, its length included.
 */
const requireToken = (token: string) => {
  const expected = digestOf(token);

  return (req: Request, res: Response, next: NextFunction): void => {
    const given = req.headers['x-catalog-token'];

    if (token && (typeof given !== 'string' || ! timingSafeEqual(digestOf(given), expected))) {
      res.status(401).json({ error: 'Unauthorized' });

      return;
    }

    next();
  };
};

const digestOf = (text: string): Buffer => createHash('sha256').update(text).digest();

/**
 * Drop a request whose client has gone before doing any of its work.
 *
 * **One request runs at a time**, so a slow one queues the rest — and an editor
 * that has since moved on cancels the ones it no longer wants. A yield first
 * lets any disconnect already received be noticed; a request whose connection
 * is closed by then is answered by nobody and costs nothing. A request already
 * running cannot be stopped: its work is synchronous.
 */
const stillWanted = (req: Request, _res: Response, next: NextFunction): void => {
  setImmediate(() => {
    // The connection, not the request: a request read to its end is
    // "destroyed" as a stream while its client still waits for the answer.
    if (req.socket.destroyed) return;

    next();
  });
};

/** A path, or a method on a path, that no route answers. */
const notFound = (req: Request, res: Response): void => {
  if (req.path === '/listings' || req.path.startsWith('/listings/')) return failed(req, res, 404, 'NoSuchKey', 'No such resource');

  res.status(404).json({ error: 'Not found' });
};

/**
 * Anything that escapes a route is a fault in this service: `500`, with the
 * whole of it in the log. A request the body parser refused — too large, not
 * JSON — carries its own `4xx` and a message meant for the caller, and is
 * answered as it is.
 */
const onError = (err: unknown, _req: Request, res: Response, _next: NextFunction): void => {
  const refused = err as { status?: unknown; expose?: unknown; message?: unknown };

  if (typeof refused.status === 'number' && refused.status >= 400 && refused.status < 500 && refused.expose === true) {
    res.status(refused.status).json({ error: String(refused.message) });

    return;
  }

  logger.error({ err }, 'Unhandled error in the catalog API');

  res.status(500).json({ error: 'Internal error' });
};
