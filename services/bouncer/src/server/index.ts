import http from 'node:http';
import express, { type Request, type Response, type NextFunction } from 'express';
import { ZodError } from 'zod';
import { logger } from '@devvir/service-kit';
import { requireAuth } from './middleware';
import { setupRoutes } from './routes';
import type { Config } from '../types';

export function startServer(config: Config): http.Server {
  const app = express();

  app.use(express.json());
  app.use(requireAuth(config.token));

  setupRoutes(app, config);

  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    if (err instanceof ZodError) {
      res.status(400).json({ error: err.issues[0]?.message ?? 'Invalid request' });
      return;
    }

    logger.error({ err }, 'Unhandled error');
    res.status(500).json({ error: 'Internal server error' });
  });

  const server = http.createServer(app);

  server.listen(config.httpPort, () => {
    logger.info({ port: config.httpPort }, 'Bouncer HTTP server listening');
  });

  return server;
}
