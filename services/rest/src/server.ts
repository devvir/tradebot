import express, { type Request, type Response, type NextFunction } from 'express';
import { logger, type Service } from '@devvir/service-kit';
import { createProxyMiddleware } from 'http-proxy-middleware';
import { Server } from 'node:http';
import type { Config } from './types';

export const createServer = (service: Service): express.Application => {
  const config = service.config() as Config;
  const app    = express();

  // Promote ?accountId query param to x-account-id header (handy for browser testing)
  app.use((req: Request, _res: Response, next: NextFunction) => {
    const accountId = req.query['accountId'];
    if (typeof accountId === 'string' && ! req.headers['x-account-id']) {
      req.headers['x-account-id'] = accountId;
    }
    next();
  });

  app.use((req: Request, _res: Response, next: NextFunction) => {
    logger.debug({ method: req.method, url: req.url }, 'Incoming request');
    next();
  });

  app.get('/', (_req: Request, res: Response) => {
    res.json({ message: "These aren't the endpoints you're looking for" });
  });

  app.use('/api/v1', createProxyMiddleware({
    target:       config.dataUrl,
    changeOrigin: true,
    pathRewrite:  { '^/api/v1': '' },
    on: {
      error: (err, _req, res) => {
        logger.error({ err }, 'Proxy error');
        if ('headersSent' in res && ! res.headersSent) {
          (res as express.Response).status(502).json({ error: 'Upstream unavailable' });
        }
      },
    },
  }));

  return app;
};

export const startServer = (app: express.Application, port: number): Server => {
  const server = app.listen(port, () => logger.info({ port }, 'REST server listening'));
  server.on('error', (err: Error) => logger.error({ err }, 'Server error'));

  return server;
};
