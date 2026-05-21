import { Router, type Request, type Response, type NextFunction } from 'express';
import { createProxyMiddleware } from 'http-proxy-middleware';
import { logger } from '@devvir/service-kit';
import type { Config } from './types';

/**
 * Build the REST gateway's route table as an express Router: promotes the
 * `accountId` query param to a header, answers `GET /`, and proxies everything
 * under `/api/v1` to the upstream data service, stripping the prefix.
 */
export const buildRouter = (config: Config): Router => {
  const router = Router();

  // Promote ?accountId query param to x-account-id header (handy for browser testing)
  router.use((req: Request, _res: Response, next: NextFunction) => {
    const accountId = req.query['accountId'];

    if (typeof accountId === 'string' && ! req.headers['x-account-id']) {
      req.headers['x-account-id'] = accountId;
    }

    next();
  });

  router.get('/', (_req: Request, res: Response) => {
    res.json({ message: "These aren't the endpoints you're looking for" });
  });

  router.use('/api/v1', createProxyMiddleware({
    target:       config.dataUrl,
    changeOrigin: true,
    pathRewrite:  { '^/api/v1': '' },
    on: {
      error: (err, _req, res) => {
        logger.error({ err }, 'Proxy error');

        if ('headersSent' in res && ! res.headersSent) {
          (res as Response).status(502).json({ error: 'Upstream unavailable' });
        }
      },
    },
  }));

  return router;
};
