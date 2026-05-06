import http from 'node:http';
import express, { type Request, type Response, type NextFunction } from 'express';
import { ZodError } from 'zod';
import { logger } from '@devvir/service-kit';
import { requireAuth } from './middleware';
import { setupRoutes } from './routes';
import type { Config } from '../types';

const HTTP_PORT = 80;

export function createApp(config: Config): express.Application {
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

  return app;
}

export function startServer(config: Config): http.Server {
  const server = http.createServer(createApp(config));

  server.listen(HTTP_PORT, () => {
    logger.info({ port: HTTP_PORT }, 'Bouncer HTTP server listening');
  });

  return server;
}
