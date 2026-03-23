import express, { type Request, type Response, type NextFunction } from 'express';
import { logger } from '@devvir/service-kit';
import { Server } from 'node:http';
import { forwardRequest } from './proxy';
import type { Config } from '../types';

export function startServer(config: Config): Server {
  const app = express();

  app.use(express.raw({ type: '*/*' }));

  app.use((req: Request, _res: Response, next: NextFunction) => {
    logger.debug({ method: req.method, url: req.url }, 'Incoming request');
    next();
  });

  app.all('/{*path}', (req: Request, res: Response) => {
    forwardRequest(req, res, config).catch((err) => {
      logger.error({ err }, 'Unhandled proxy error');
      if (! res.headersSent) res.status(500).json({ error: 'Internal error' });
    });
  });

  const server = app.listen(config.httpPort, () => {
    logger.info({ port: config.httpPort }, 'Proxy server listening');
  });

  return server;
}
