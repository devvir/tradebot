import { Router } from 'express';
import type { Db } from '@devvir/service-kit';
import { z } from 'zod';
import { register, list } from '../store.js';
import { validateBody, RegisterSymbolSchema, RegisterCurrencySchema } from './middleware.js';

/** Build the registry's route table as an express Router. */
export const buildRouter = (db: Db): Router => {
  const router = Router();

  router.get('/symbols', async (_req, res) => {
    const entries = await list(db, 'symbols');

    res.json(entries.map((e) => ({ id: e._id, symbol: e.value })));
  });

  router.post('/symbols', validateBody(RegisterSymbolSchema), async (_req, res) => {
    const { symbol } = res.locals['body'] as z.infer<typeof RegisterSymbolSchema>;
    const entry = await register(db, 'symbols', symbol);

    res.json({ id: entry._id, symbol: entry.value });
  });

  router.get('/currencies', async (_req, res) => {
    const entries = await list(db, 'currencies');

    res.json(entries.map((e) => ({ id: e._id, currency: e.value })));
  });

  router.post('/currencies', validateBody(RegisterCurrencySchema), async (_req, res) => {
    const { currency } = res.locals['body'] as z.infer<typeof RegisterCurrencySchema>;
    const entry = await register(db, 'currencies', currency);

    res.json({ id: entry._id, currency: entry.value });
  });

  return router;
};
