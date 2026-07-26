/**
 * Boundary: receives instrument.partial and instrument.update messages.
 *
 * Maintains an in-memory cache of markPrice and contract metadata used by:
 *   - fills/execute.ts  (multiplier, initMarginReq)
 *   - positions/index.ts (multiplier for PnL)
 *   - rest/routes.ts    (market order fill price)
 *
 * On each new markPrice, emits 'markPrice' on the service so the orchestrator
 * (index.ts) can dispatch PnL recomputation and liquidation checks without
 * knowing this module exists. Decoupling via events here is correct: the
 * instrument consumer does not need to know what happens downstream.
 */
import { logger } from '@devvir/service-kit';
import { getState, getBroker } from '../store';
import type { InstrumentCache } from '../types';
import type { Broker, Service } from '@devvir/service-kit';

interface InstrumentItem {
  symbol:         string;
  multiplier?:    number;
  initMarginReq?: number;
  maintMarginReq?: number;
  tickSize?:      number;
  lotSize?:       number;
  markPrice?:     number;
  timestamp?:     string;
}

export async function startInstrumentConsumer(service: Service): Promise<void> {
  const broker = getBroker() as Broker;
  const queue  = broker.getQueue('teller.instrument');

  if (! queue) throw new Error('Queue teller.instrument not found — check topology');

  await queue.consume(async (message, { ack }) => {
    try {
      handleInstrumentMessage(message, service);
    } catch (err) {
      logger.error({ err }, 'Instrument consumer: unhandled error');
    } finally {
      ack();
    }
  }, { prefetch: 20 });
}

function handleInstrumentMessage(message: unknown, service: Service): void {
  if (
    typeof message !== 'object' || message === null ||
    (message as any).table !== 'instrument' ||
    ! Array.isArray((message as any).data)
  ) {
    return;
  }

  const action = (message as any).action as string;
  const { instruments } = getState();

  for (const item of (message as any).data as InstrumentItem[]) {
    if (! item.symbol) continue;

    if (action === 'partial') {
      instruments.set(item.symbol, buildCache(item));
    } else {
      const existing = instruments.get(item.symbol);
      const merged   = existing ? mergeCache(existing, item) : buildCache(item);
      instruments.set(item.symbol, merged);
    }

    // Emit markPrice event only when the field is present in this update.
    // Listeners (index.ts) handle PnL recomputation and liquidation checks.
    if (item.markPrice !== undefined) {
      const timestamp = item.timestamp ?? new Date().toISOString();
      service.emit('markPrice', item.symbol, item.markPrice, timestamp);
    }
  }
}

function buildCache(item: InstrumentItem): InstrumentCache {
  return {
    symbol:        item.symbol,
    multiplier:    item.multiplier    ?? -1e8,   // XBTUSD default; overwritten on partial
    initMarginReq: item.initMarginReq ?? 0.01,
    maintMarginReq: item.maintMarginReq ?? 0.005,
    tickSize:      item.tickSize      ?? 0.5,
    lotSize:       item.lotSize       ?? 1,
    markPrice:     item.markPrice     ?? null,
  };
}

function mergeCache(existing: InstrumentCache, item: InstrumentItem): InstrumentCache {
  return {
    ...existing,
    ...(item.multiplier    !== undefined && { multiplier:    item.multiplier }),
    ...(item.initMarginReq !== undefined && { initMarginReq: item.initMarginReq }),
    ...(item.maintMarginReq !== undefined && { maintMarginReq: item.maintMarginReq }),
    ...(item.tickSize      !== undefined && { tickSize:      item.tickSize }),
    ...(item.lotSize       !== undefined && { lotSize:       item.lotSize }),
    ...(item.markPrice     !== undefined && { markPrice:     item.markPrice }),
  };
}
