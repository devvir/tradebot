import http from 'node:http';
import express, { type Request, type Response, type NextFunction } from 'express';
import { ZodError } from 'zod';
import { logger } from '@devvir/service-kit';
import type { Db } from '@devvir/service-kit';
import { setupRoutes } from './routes.js';
import type { Config } from '../types.js';

export const startServer = (db: Db, config: Config): http.Server => {
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

  const server = http.createServer(app);

  server.listen(config.httpPort, () => {
    logger.info({ port: config.httpPort }, 'Registry HTTP server listening');
  });

  return server;
};
