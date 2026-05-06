import http from 'node:http';
import express, { type Request, type Response, type NextFunction } from 'express';
import { ZodError } from 'zod';
import { logger } from '@devvir/service-kit';
import type { Db } from '@devvir/service-kit';
import { setupRoutes } from './routes.js';

const HTTP_PORT = 80;

export const createApp = (db: Db): express.Application => {
  const app = express().use(express.json());

  setupRoutes(app, db);

  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    if (err instanceof ZodError) {
      res.status(400).json({ error: err.issues[0]?.message ?? 'Invalid request' });
      return;
    }

    logger.error({ err }, 'Unhandled error');
    res.status(500).json({ error: 'Internal server error' });
  });

  return app;
};

export const startServer = (db: Db): http.Server => {
  const server = http.createServer(createApp(db));

  server.listen(HTTP_PORT, () => {
    logger.info({ port: HTTP_PORT }, 'Registry HTTP server listening');
  });

  return server;
};
