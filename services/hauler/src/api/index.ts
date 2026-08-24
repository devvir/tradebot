import { logger } from '@devvir/service-kit';
import { setupRoutes } from './routes';
import type { Application, NextFunction, Request, Response } from 'express';

/**
 * Hauler's API, mounted on the server service-kit already runs.
 *
 * Body parsing, request logging, `/ping` and rate limiting come with that
 * server, so what is added here is the two things it cannot know: who is allowed
 * in, and what the routes are.
 */

/**
 * One shared secret, checked on the way in.
 *
 * **Not authentication so much as a closed door**, and the same door the catalog
 * uses — one token for the pair, since anything trusted to read the catalog is
 * trusted to say what should be fetched from it. There are no users and no
 * sessions; what this protects against is the port being reachable by something
 * with no business writing here.
 *
 * A wrong token and a missing one answer identically.
 *
 * **An empty token takes the door off**, and every request is let through — the
 * same rule the catalog applies, for the same reason and from the same variable.
 * Config warns on startup, so an open service is a decision somebody took rather
 * than one nobody noticed.
 */
export const requireToken = (token: string) =>
  (req: Request, res: Response, next: NextFunction): void => {
    if (token && req.headers['x-catalog-token'] !== token) {
      res.status(401).json({ error: 'Unauthorized' });

      return;
    }

    next();
  };

/** Anything that escapes a route is a fault here, not something a caller can act on. */
export const onError = (err: unknown, _req: Request, res: Response, _next: NextFunction): void => {
  logger.error({ err }, 'Unhandled error in the hauler API');

  res.status(500).json({ error: 'Internal error' });
};

export const mount = (app: Application, token: string): void => {
  app.use(requireToken(token));

  setupRoutes(app);

  app.use(onError);
};
