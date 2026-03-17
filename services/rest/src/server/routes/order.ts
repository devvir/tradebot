import { type Application, type Request, type Response } from 'express';
import { logger, type Service } from '@devvir/service-kit';
import { z } from 'zod';
import { validateQuery } from '../middleware';
import { OrderGetOrdersQueryParams } from '../../types';

/**
 * Setup order routes
 *
 * Authenticated endpoints for order management:
 * - POST /order — place order
 * - PUT /order — amend order
 * - DELETE /order — cancel order
 * - etc.
 *
 * Will forward requests to `orders` exchange via RabbitMQ RPC when implemented.
 * Currently returns mocked responses.
 * Authentication is not yet implemented.
 */
export const setupOrderRoutes = (app: Application, _service: Service): void => {
  // ── Order (CRUD) ───────────────────────────────────────────────────

  app.get('/order', validateQuery(OrderGetOrdersQueryParams), (_req: Request, res: Response) => {
    logger.debug({ query: res.locals.query }, 'GET /order (not yet implemented)');
    return res.json([]);
  });

  app.post('/order', (req: Request, res: Response) => {
    const body = z.object({
      symbol: z.string(),
      side: z.string(),
      simpleOrderQty: z.number().optional(),
      orderQty: z.number().optional(),
      price: z.number().optional(),
      displayQty: z.number().optional(),
      stopPx: z.number().optional(),
      pegOffsetValue: z.number().optional(),
      pegPriceType: z.string().optional(),
      currency: z.string().optional(),
      settlCurrency: z.string().optional(),
      ordType: z.string().optional(),
      timeInForce: z.string().optional(),
      execInst: z.string().optional(),
      clientOrderID: z.string().optional(),
      contingencyType: z.string().optional(),
      trailingAmount: z.number().optional(),
      trailingPercent: z.number().optional(),
      triggerPrice: z.number().optional(),
      reference: z.string().optional(),
      referenceID: z.string().optional(),
    }).safeParse(req.body);

    if (! body.success) throw body.error;

    logger.debug({ body: body.data }, 'POST /order (not yet implemented)');
    return res.status(200).json({});
  });

  app.put('/order', (req: Request, res: Response) => {
    const body = z.object({
      orderID: z.string().optional(),
      clOrdID: z.string().optional(),
      origClOrdID: z.string().optional(),
      simpleOrderQty: z.number().optional(),
      orderQty: z.number().optional(),
      simpleLeavesQty: z.number().optional(),
      leavesQty: z.number().optional(),
      price: z.number().optional(),
      stopPx: z.number().optional(),
      pegOffsetValue: z.number().optional(),
      pegPriceType: z.string().optional(),
      ordType: z.string().optional(),
      timeInForce: z.string().optional(),
      execInst: z.string().optional(),
      contingencyType: z.string().optional(),
      trailingAmount: z.number().optional(),
      trailingPercent: z.number().optional(),
      triggerPrice: z.number().optional(),
      reference: z.string().optional(),
      referenceID: z.string().optional(),
    }).safeParse(req.body);

    if (! body.success) throw body.error;

    logger.debug({ body: body.data }, 'PUT /order (not yet implemented)');
    return res.status(200).json({});
  });

  app.delete('/order', (req: Request, res: Response) => {
    const body = z.object({
      orderID: z.string().optional(),
      clOrdID: z.string().optional(),
      origClOrdID: z.string().optional(),
      text: z.string().optional(),
    }).safeParse(req.body);

    if (! body.success) throw body.error;

    logger.debug({ body: body.data }, 'DELETE /order (not yet implemented)');
    return res.json([]);
  });

  // ── Order bulk operations ──────────────────────────────────────────

  app.post('/order/bulk', (req: Request, res: Response) => {
    logger.debug({ body: req.body }, 'POST /order/bulk (not yet implemented)');
    return res.json([]);
  });

  // ── Order all (cancel all) ─────────────────────────────────────────

  app.delete('/order/all', (req: Request, res: Response) => {
    const query = z.object({
      symbol: z.string().optional(),
      filter: z.string().optional(),
      text: z.string().optional(),
    }).safeParse(req.query);

    if (! query.success) throw query.error;

    logger.debug({ query: query.data }, 'DELETE /order/all (not yet implemented)');
    return res.json([]);
  });

  // ── Close Position ─────────────────────────────────────────────────

  app.post('/order/closePosition', (req: Request, res: Response) => {
    const body = z.object({
      symbol: z.string(),
      price: z.number().optional(),
    }).safeParse(req.body);

    if (! body.success) throw body.error;

    logger.debug({ body: body.data }, 'POST /order/closePosition (not yet implemented)');
    return res.json([]);
  });

  // ── Cancel After ───────────────────────────────────────────────────

  app.post('/order/cancelAllAfter', (req: Request, res: Response) => {
    const body = z.object({
      timeout: z.number(),
    }).safeParse(req.body);

    if (! body.success) throw body.error;

    logger.debug({ body: body.data }, 'POST /order/cancelAllAfter (not yet implemented)');
    return res.json({});
  });
};
