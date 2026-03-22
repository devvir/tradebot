import http from 'node:http';
import express, { type Request, type Response, type NextFunction } from 'express';
import { ZodError, z } from 'zod';
import { logger } from '@devvir/service-kit';
import { converge, filterActiveOrders } from './converge';
import type { Config, DesiredState, DesiredOrder } from './types';
import type { WsPool } from './ws';
import type { RestClient } from './rest';

const PlanSchema = z.object({
  accountId:      z.string().min(1),
  symbol:         z.string().min(1),
  orders:         z.array(z.object({
    side:           z.enum(['Buy', 'Sell']),
    ordType:        z.enum(['Limit', 'Market', 'Stop', 'StopLimit', 'MarketIfTouched', 'LimitIfTouched', 'Pegged']),
    orderQty:       z.number().positive().optional(),
    price:          z.number().positive().optional(),
    stopPx:         z.number().positive().optional(),
    pegOffsetValue: z.number().optional(),
    pegPriceType:   z.enum(['TrailingStopPeg', 'PrimaryPeg', 'MarketPeg']).optional(),
    timeInForce:    z.enum(['GoodTillCancel', 'ImmediateOrCancel', 'FillOrKill', 'Day']).optional(),
    execInst:       z.string().optional(),
    displayQty:     z.number().optional(),
  })),
  timestamp:      z.string(),
  amendThreshold: z.number().min(0).optional(),
});

export function startServer(ws: WsPool, rest: RestClient, config: Config): http.Server {
  const app = express();

  app.use(express.json());

  app.post('/plan', async (req, res, next) => {
    const result = PlanSchema.safeParse(req.body);

    if (! result.success) {
      next(result.error);
      return;
    }

    const plan = result.data as DesiredState;

    let conn: Awaited<ReturnType<WsPool['getOrCreate']>>;

    try {
      conn = await ws.getOrCreate(plan.accountId);
    } catch (err) {
      const msg = err instanceof Error ? err.message : '';

      if (msg.includes('WS not ready after') || msg.includes('WS connection error')) {
        res.status(503).json({ error: 'Exchange WS unavailable — try again shortly' });
      } else {
        next(err);
      }

      return;
    }

    const live = filterActiveOrders(conn.getOrders(), plan.symbol);
    const { amends, creates, cancels } = converge(plan.orders, live, plan.amendThreshold ?? 0);

    logger.debug(
      { accountId: plan.accountId, symbol: plan.symbol, desired: plan.orders.length, live: live.length, amends: amends.length, creates: creates.length, cancels: cancels.length },
      'Converge result',
    );

    let amendedCount  = 0;
    let createdCount  = 0;
    let staleFallback = 0;

    for (const op of amends) {
      const r = await rest.amendOrder(plan.accountId, op) as { stale?: boolean } | null;

      if (r?.stale) {
        const desired = findDesiredForAmend(op.orderID, live, plan.orders);

        if (desired) {
          await rest.createOrder(plan.accountId, { ...desired, symbol: plan.symbol }, nextClOrdID(plan.symbol));
          staleFallback++;
        }
      } else if (r) {
        amendedCount++;
      }
    }

    for (const op of creates) {
      await rest.createOrder(plan.accountId, { ...op.order, symbol: plan.symbol }, nextClOrdID(plan.symbol));
      createdCount++;
    }

    if (cancels.length > 0) {
      await rest.cancelOrders(plan.accountId, cancels);
    }

    res.json({
      accountId:    plan.accountId,
      symbol:       plan.symbol,
      amends:       amendedCount,
      creates:      createdCount + staleFallback,
      cancels:      cancels.length,
      staleFallback,
      timestamp:    plan.timestamp,
    });
  });

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
    logger.info({ port: config.httpPort }, 'Executor HTTP server listening');
  });

  return server;
}

let orderSeq = 0;

function nextClOrdID(symbol: string): string {
  orderSeq = (orderSeq + 1) % 1_000_000;
  return `tb_${symbol}_${orderSeq.toString().padStart(6, '0')}`;
}

function findDesiredForAmend(
  orderID: string,
  live:    import('./types').LiveOrder[],
  desired: DesiredOrder[],
): DesiredOrder | null {
  const liveOrder = live.find((o) => o.orderID === orderID);

  if (! liveOrder) return null;

  const sameSide = desired.filter((o) => o.side === liveOrder.side);
  const liveIdx  = live.filter((o) => o.side === liveOrder.side).findIndex((o) => o.orderID === orderID);

  return sameSide[liveIdx] ?? null;
}
