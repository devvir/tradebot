import express, { type Request, type Response, type NextFunction } from 'express';
import { ZodError } from 'zod';
import { logger, type Service } from '@devvir/service-kit';
import { setupPublicRoutes } from './routes/public';
import { setupAccountRoutes } from './routes/account';
import { setupOrderRoutes } from './routes/order';
import { Server } from 'node:http';

/**
 * Setup Express app with all REST endpoints
 *
 * Responsibilities:
 *   - Create HTTP server
 *   - Setup request/response middleware
 *   - Register all route handlers (public, account, order)
 *   - Handle errors and validation failures
 *   - Return mocked responses until real handlers are implemented
 */
export const createServer = (service: Service): express.Application => {
  const app = express();

  // ── Middleware ──────────────────────────────────────────────────────
  app.use(express.json());

  // Log incoming requests
  app.use((req: Request, _res: Response, next: NextFunction) => {
    logger.debug(
      { method: req.method, path: req.path, query: req.query, body: req.body },
      'Incoming request'
    );
    next();
  });

  // ── Route handlers ──────────────────────────────────────────────────
  setupPublicRoutes(app, service);
  setupAccountRoutes(app, service);
  setupOrderRoutes(app, service);

  // ── Error handling ──────────────────────────────────────────────────
  app.use((err: unknown, req: Request, res: Response, _next: NextFunction) => {
    if (err instanceof ZodError) {
      logger.warn({ path: req.path, issues: err.issues }, 'Validation error');
      return res.status(400).json({ error: 'Invalid request', issues: err.issues });
    }

    if (err instanceof Error) {
      logger.error({ path: req.path, error: err.message }, 'Request error');
      return res.status(500).json({ error: 'Internal server error' });
    }

    logger.error({ path: req.path, err }, 'Unknown error');
    return res.status(500).json({ error: 'Internal server error' });
  });

  // ── 404 handler ─────────────────────────────────────────────────────
  app.use((_req: Request, res: Response) => {
    res.status(404).json({ error: 'Endpoint not found' });
  });

  return app;
};

/**
 * Start the HTTP server
 */
export const startServer = (app: express.Application, port: number): Server => {
  const server = app.listen(port, () => {
    logger.info({ port }, 'REST server listening');
  });

  server.on('error', (err: Error) => {
    logger.error({ err }, 'Server error');
  });

  return server;
};
