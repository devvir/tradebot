import { logger } from '@devvir/service-kit';
import { mountContents } from './contents';
import { mountLenses } from './lenses';
import { mountListings } from './listings';
import { mountReports } from './reports';
import type { Application, NextFunction, Request, Response } from 'express';
import type { DatabaseSync } from 'node:sqlite';

/**
 * The catalog's public API: the listings a downloader walks, the contents a
 * person browses, the lenses a consumer reads through, and the reports a
 * downloader sends back — forwarded to prospector, which settles them.
 */
export const mount = (app: Application, db: DatabaseSync, token: string): void => {
  app.use(requireToken(token));

  mountListings(app, db);
  mountReports(app);
  mountContents(app, db);
  mountLenses(app, db);

  app.use(onError);
};

// ── Internals ─────────────────────────────────────────────────────────────────

/**
 * One shared secret, checked on the way in — a closed door rather than
 * authentication. An empty token takes the door off, which config warns about.
 */
const requireToken = (token: string) =>
  (req: Request, res: Response, next: NextFunction): void => {
    if (token && req.headers['x-catalog-token'] !== token) {
      res.status(401).json({ error: 'Unauthorized' });

      return;
    }

    next();
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
