import { Router, type Request, type Response } from 'express';
import { logger } from '@devvir/service-kit';
import { forwardRequest } from './proxy';
import type { Config } from '../types';

/**
 * Build the proxy's route table: a single catch-all that signs every request
 * via Bouncer and forwards it to the matching BitMEX environment.
 */
export const buildRouter = (config: Config): Router => {
  const router = Router();

  router.all('/{*path}', (req: Request, res: Response) => {
    forwardRequest(req, res, config).catch((err) => {
      logger.error({ err }, 'Unhandled proxy error');

      if (! res.headersSent) res.status(500).json({ error: 'Internal error' });
    });
  });

  return router;
};
