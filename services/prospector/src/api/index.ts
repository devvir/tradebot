import { logger } from '@devvir/service-kit';
import { fault } from '../faults';
import { mountCollector } from './collector';
import { mountReports } from './reports';
import type { Application, Request, Response, NextFunction } from 'express';
import type { DatabaseSync } from 'node:sqlite';
import type { Surveys } from '../types';

/**
 * Prospector's private API — the collector and the reports — mounted on the
 * server service-kit already runs. Nothing outside the module reaches it: the
 * catalog service is the public face, and forwards reports here.
 *
 * Body parsing, request logging, `/ping` and rate limiting come with that
 * server, so what is added here is the two things it cannot know about: who is
 * allowed in, and what the routes are.
 */

/**
 * One shared secret, checked on the way in.
 *
 * **Not authentication so much as a closed door.** There are no users and no
 * sessions — what this protects against is the port being reachable by
 * something that has no business writing here, which matters because the
 * service is meant to run wherever the link to the venues is best rather than
 * wherever the firewall is.
 *
 * The header is compared whole and nothing about the failure is disclosed: a
 * wrong token and a missing one answer identically.
 *
 * **An empty token takes the door off.** Every request is let through, which is
 * what makes the read endpoints answerable from a browser — no header to set,
 * no extension to fight. It is a deployment's decision and a deliberate one:
 * config warns on startup, because "nobody set it" and "anyone is welcome" must
 * not look the same from outside.
 */
export const requireToken = (token: string) =>
  (req: Request, res: Response, next: NextFunction): void => {
    if (token && req.headers['x-catalog-token'] !== token) {
      res.status(401).json({ error: 'Unauthorized' });

      return;
    }

    next();
  };

/**
 * Anything that escapes a route.
 *
 * A handler throwing is a fault in this service, not something the caller can
 * act on, so it answers `500` and says nothing about paths or queries — while
 * the log keeps the whole of it.
 *
 * **Except a request refused before any route ran**: the body parser marks what
 * it refuses — too large, not JSON — with a `4xx` status and a message meant for
 * the caller, and that is answered as it is.
 */
export const onError = (err: unknown, _req: Request, res: Response, _next: NextFunction): void => {
  const refused = err as { status?: unknown; expose?: unknown; message?: unknown };

  if (typeof refused.status === 'number' && refused.status >= 400 && refused.status < 500 && refused.expose === true) {
    logger.warn({ status: refused.status, error: String(refused.message) }, 'Request refused');

    res.status(refused.status).json({ error: String(refused.message) });

    return;
  }

  logger.error({ ...fault(err) }, 'Unhandled error in the prospector API');

  res.status(500).json({ error: 'Internal error' });
};

export const mount = (
  app:     Application,
  db:      DatabaseSync,
  token:   string,
  surveys: Surveys,
): void => {
  app.use(requireToken(token));

  mountCollector(app, db, surveys);
  mountReports(app, db);

  app.use(onError);
};
