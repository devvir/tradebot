/**
 * Boundary: receives raw RabbitMQ trade messages, runs the price guard check,
 * finds crossed orders, and calls executeFill for each result.
 *
 * No business logic lives here — only extraction, dispatch, and error handling.
 */
import { logger } from '@devvir/service-kit';
import { getState, getBroker } from '../store';
import { guardAllows, findCrossings } from './engine';
import { executeFill } from './execute';
import type { Broker } from '@devvir/service-kit';

interface TradeItem {
  symbol:    string;
  price:     number;
  size:      number;
  timestamp: string;
}

export async function startTradeConsumer(service: { emit: (e: string, ...a: unknown[]) => boolean }): Promise<void> {
  const broker = getBroker() as Broker;
  const queue  = broker.getQueue('teller.trade');

  if (! queue) throw new Error('Queue teller.trade not found — check topology');

  await queue.consume(async (message, { ack }) => {
    try {
      const trades = extractTrades(message);

      for (const trade of trades) {
        await handleTrade(trade);
      }

      service.emit('message');
    } catch (err) {
      logger.error({ err }, 'Trade consumer: unhandled error — message dropped');
    } finally {
      ack();
    }
  }, { prefetch: 10 });
}

async function handleTrade(trade: TradeItem): Promise<void> {
  const { store, guards } = getState();
  const guard = guards.get(trade.symbol);

  if (! guard || ! guardAllows(guard, trade.price)) return;

  // Collect all open limit orders for this symbol across all accounts
  const symbolOrders = [...store.values()].flatMap(s =>
    [...s.orders.values()].filter(o => o.symbol === trade.symbol),
  );

  const crossed = findCrossings(symbolOrders, trade.price);

  if (crossed.length === 0) return;

  // Process fills concurrently across accounts; each fill is internally sequential
  await Promise.all(
    crossed.map(order => executeFill(order, order.price!, order.leavesQty, trade.timestamp)
      .catch(err => logger.error({ err, orderID: order.orderID }, 'executeFill failed')),
    ),
  );
}

function extractTrades(message: unknown): TradeItem[] {
  if (
    typeof message !== 'object' || message === null ||
    (message as any).table !== 'trade' ||
    ! Array.isArray((message as any).data)
  ) {
    return [];
  }

  return (message as any).data.filter((t: any) =>
    typeof t.symbol === 'string' &&
    typeof t.price  === 'number' &&
    typeof t.timestamp === 'string',
  ) as TradeItem[];
}
