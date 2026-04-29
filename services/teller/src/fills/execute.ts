/**
 * executeFill — the fill pipeline for a single order crossing.
 *
 * Orchestrates the pure core functions (orders, positions, margin) and the
 * thin boundaries (db, publisher). This function can be called directly from
 * tests using hand-crafted order documents — no RabbitMQ required.
 *
 * Write ordering: memory → MongoDB → WS events.
 * A crash after memory but before DB leaves DB in a pre-event consistent state
 * that is fully recovered on restart. WS events are only published after DB
 * writes succeed, so clients never see state that wasn't persisted.
 */
import { v4 as uuid } from 'uuid';
import { logger } from '@devvir/service-kit';
import { getState } from '../store';
import * as positions from '../positions';
import * as margin from '../margin';
import * as db from '../db';
import * as publisher from '../publisher';
import { computeGuard } from './engine';
import { newPosition } from '../positions';
import type { OrderDoc, ExecutionDoc, Fill } from '../types';

export async function executeFill(
  order:            OrderDoc,
  fillPx:           number,
  fillQty:          number,
  triggerTimestamp: string,   // replay clock from the trade that triggered this fill
): Promise<void> {
  const { store, guards, instruments } = getState();
  const { accountId, symbol } = order;
  const accountState = store.get(accountId);

  if (! accountState) {
    logger.warn({ accountId, orderID: order.orderID }, 'executeFill: account not in store — skipping');
    return;
  }

  const instrument = instruments.get(symbol);

  if (! instrument) {
    logger.warn({ symbol }, 'executeFill: no instrument cache for symbol — skipping');
    return;
  }

  // 1. Compute fill results
  const newCumQty    = order.cumQty + fillQty;
  const newLeavesQty = order.leavesQty - fillQty;
  const newAvgPx     = (order.cumQty * (order.avgPx ?? fillPx) + fillQty * fillPx) / newCumQty;
  const isFilled     = newLeavesQty <= 0;

  const updatedOrder: OrderDoc = {
    ...order,
    cumQty:    newCumQty,
    leavesQty: Math.max(0, newLeavesQty),
    avgPx:     newAvgPx,
    ordStatus: isFilled ? 'Filled' : 'PartiallyFilled',
    text:      isFilled ? 'Filled' : 'PartiallyFilled',
  };

  const execution: ExecutionDoc = {
    execID:        uuid(),
    orderID:       order.orderID,
    clOrdID:       order.clOrdID,
    accountId,
    symbol,
    side:          order.side,
    price:         order.price ?? fillPx,
    lastQty:       fillQty,
    lastPx:        fillPx,
    cumQty:        newCumQty,
    leavesQty:     Math.max(0, newLeavesQty),
    ordStatus:     updatedOrder.ordStatus,
    execType:      'Trade',
    timestamp:     triggerTimestamp,
    wallTimestamp: new Date().toISOString(),
  };

  // 2. Update in-memory order state — other concurrent operations see the new
  //    state immediately, preventing double-fills on the same order.
  if (isFilled) {
    accountState.orders.delete(order.orderID);
  } else {
    accountState.orders.set(order.orderID, updatedOrder);
  }

  // 3. Update position
  const fill: Fill = { side: order.side, qty: fillQty, price: fillPx };
  const prevPosition = accountState.positions.get(symbol) ?? newPosition(accountId, symbol, triggerTimestamp);
  const nextPosition = positions.applyFill(prevPosition, fill, instrument);
  accountState.positions.set(symbol, nextPosition);

  // 4. Update margin
  const nextMargin = margin.applyFill(accountState.margin, fill, prevPosition, nextPosition, instrument);
  accountState.margin = nextMargin;

  // 5. Recompute liquidation price (stub in v1 — returns unchanged position)
  const finalPosition = margin.recomputeLiquidation(nextPosition, nextMargin, instrument);
  accountState.positions.set(symbol, finalPosition);

  // 6. Update price guard for this symbol
  const allSymbolOrders = [...store.values()].flatMap(s => [...s.orders.values()]).filter(o => o.symbol === symbol);
  guards.set(symbol, computeGuard(allSymbolOrders));

  // 7. Write to MongoDB — awaited before publishing WS events
  await Promise.all([
    db.order.upsert(updatedOrder),
    db.execution.insert(execution),
    db.position.upsert(finalPosition),
    db.margin.upsert(nextMargin),
  ]);

  // 8. Liquidation check (v1 stub — no-op)
  checkLiquidation(finalPosition, nextMargin);

  // 9. Publish WS events to topic:replay
  await publisher.publishFill(accountId, updatedOrder, execution, finalPosition, nextMargin, triggerTimestamp);
}

// ── Market order fill (called synchronously from the REST create handler) ─────

/**
 * Fill a market order immediately at the last known trade price.
 * Used only by POST /api/v1/order when ordType is 'Market'.
 */
export async function executeMarketFill(
  order:     OrderDoc,
  timestamp: string,
): Promise<void> {
  const { instruments } = getState();
  const instrument = instruments.get(order.symbol);

  const lastPrice = instrument?.markPrice;

  if (! lastPrice) {
    throw Object.assign(new Error('No market price available for ' + order.symbol), { statusCode: 400 });
  }

  await executeFill(order, lastPrice, order.leavesQty, timestamp);
}

// ── Private helpers ────────────────────────────────────────────────────────────

/**
 * v1 stub: liquidation check is a no-op. Both phases of the two-phase liquidation
 * model (recomputeLiquidation in margin/ + this crossing check) are already wired
 * into the fill pipeline so the implementation path requires no structural changes.
 * See TELLER.md §Liquidation for the full implementation plan.
 */
function checkLiquidation(_position: import('../types').PositionDoc, _margin: import('../types').MarginDoc): void {
  // TODO: compare position.liquidationPrice against instrument markPrice; if crossed,
  // cancel all open orders, close position at bankruptcyPrice, publish Liquidation exec.
}
