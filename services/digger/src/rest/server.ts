import { Router } from 'express';
import type { Request, Response, RequestHandler } from 'express';
import type { BitmexTable } from '@tradebot/types';
import { parseParams } from './params';
import type { Provider } from '../provider';

/**
 * The BitMEX-compatible REST surface (mounted at `/api/v1`) — a **pure
 * pass-through to the provider**. Digger resolves "now" (the clock, as a ceiling)
 * in `parseParams`, forwards the params, and returns the record list. It holds no
 * REST state and never touches the WS accumulator; the provider owns every
 * per-table record strategy (historical / recent / state-reconstruction).
 */
export const buildRestRouter = (provider: Provider): Router => {
  const router = Router();

  const forward = (table: BitmexTable): RequestHandler => async (req: Request, res: Response) => {
    try {
      res.json(await provider.records(table, parseParams(req.query as Record<string, unknown>)));
    } catch (err) {
      fail(res, err);
    }
  };

  /** Bucketed routes before the bare ones. */
  router.get('/trade/bucketed', bucketed(provider, 'tradeBin'));
  router.get('/quote/bucketed', bucketed(provider, 'quoteBin'));

  router.get('/trade',      forward('trade'));
  router.get('/quote',      forward('quote'));
  router.get('/funding',    forward('funding'));
  router.get('/settlement', forward('settlement'));
  router.get('/insurance',  forward('insurance'));
  router.get('/instrument', forward('instrument'));
  router.get('/liquidation', forward('liquidation'));
  router.get('/announcement', forward('announcement'));
  router.get('/chat',         forward('chat'));

  /** orderBook/L2 requires `symbol` (per BitMEX). */
  router.get('/orderBook/L2', async (req: Request, res: Response) => {
    const params = parseParams(req.query as Record<string, unknown>);

    if (! params.symbol) {
      res.status(400).json({ error: 'orderBook/L2 requires a symbol' });

      return;
    }

    try {
      res.json(await provider.records('orderBookL2', params));
    } catch (err) {
      fail(res, err);
    }
  });

  return router;
};

// ── Internal ──────────────────────────────────────────────────────────────────

const bucketed = (provider: Provider, prefix: string): RequestHandler =>
  async (req: Request, res: Response) => {
    const binSize = String(req.query.binSize ?? '1m');

    if (! BIN_SIZES.has(binSize)) {
      res.status(400).json({ error: `invalid binSize: ${binSize}` });

      return;
    }

    try {
      const table = `${prefix}${binSize}` as BitmexTable;

      res.json(await provider.records(table, parseParams(req.query as Record<string, unknown>)));
    } catch (err) {
      fail(res, err);
    }
  };

const BIN_SIZES = new Set([ '1m', '5m', '1h', '1d' ]);

const fail = (res: Response, err: unknown): void => {
  res.status(500).json({ error: err instanceof Error ? err.message : 'internal error' });
};
