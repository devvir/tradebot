/**
 * Applier: executes a ConvergeResult against the exchange REST API.
 *
 * Execution order follows the executor's convention:
 *   1. Amend  — keeps existing orders active during transition
 *   2. Create — fills gaps
 *   3. Cancel — never leaves the book unhedged
 *
 * Stale amend fallback: if an amend returns null (order filled/not-found between
 * the snapshot and the REST call), a replacement order is created immediately at
 * the desired price/qty using positional matching on the desired list.
 */

import { logger } from '@devvir/service-kit';
import type { Order } from '../types';
import type { OrderPlan } from '../planner/types';
import type { AmendOp, ConvergeResult, ApplyResult, RestClient } from './types';

export interface ApplyContext {
  /** The full desired order list passed to converge (for stale fallback) */
  desired:     OrderPlan[];
  /** The live order list passed to converge (for stale fallback positional matching) */
  live:        Order[];
  /** Generates a unique clOrdID for each new order (stale fallback + normal creates) */
  nextClOrdID: () => string;
}

export async function applyConvergeResult(
  result:  ConvergeResult,
  creates: Array<{ order: OrderPlan; clOrdID: string }>,
  client:  RestClient,
  ctx:     ApplyContext,
): Promise<ApplyResult> {
  const applied: ApplyResult = {
    created:      [],
    amended:      [],
    cancelledIds: [],
    summary: { amends: 0, creates: 0, cancels: 0, staleFallback: 0 },
  };

  // 1. Amend first — keeps existing orders active
  for (const op of result.amends) {
    await applyAmend(op, client, ctx, applied);
  }

  // 2. Create — fills gaps
  for (const { order, clOrdID } of creates) {
    try {
      const created = await client.createOrder(order, clOrdID);
      applied.created.push(created);
      applied.summary.creates += 1;
    } catch (err) {
      logger.error({ err, order, clOrdID }, 'Create order failed');
    }
  }

  // 3. Cancel last — avoids momentary unhedged state
  if (result.cancels.length > 0) {
    const orderIDs = result.cancels.map((c) => c.orderID);

    try {
      await client.cancelOrders(orderIDs);
      applied.cancelledIds.push(...orderIDs);
      applied.summary.cancels += orderIDs.length;
    } catch (err) {
      logger.error({ err, orderIDs }, 'Batch cancel failed');
    }
  }

  return applied;
}

// ---- Private -----------------------------------------------------------

async function applyAmend(
  op:      AmendOp,
  client:  RestClient,
  ctx:     ApplyContext,
  applied: ApplyResult,
): Promise<void> {
  try {
    const order = await client.amendOrder(op.orderID, { price: op.price, leavesQty: op.leavesQty });

    if (order === null) {
      // Stale: order filled or not-found between snapshot and REST call.
      // Find the desired order at the same positional slot and re-create it.
      const desired = findDesiredForAmend(op.orderID, ctx.live, ctx.desired);

      if (desired) {
        const clOrdID = ctx.nextClOrdID();

        try {
          const created = await client.createOrder(desired, clOrdID);
          applied.created.push(created);
          applied.summary.creates      += 1;
          applied.summary.staleFallback += 1;
          logger.info({ orderID: op.orderID, clOrdID }, 'Stale amend — replaced with new order');
        } catch (err) {
          logger.error({ err, op, clOrdID }, 'Stale amend fallback create failed');
        }
      } else {
        // Couldn't find desired counterpart — just remove from managed on next tick
        logger.warn({ orderID: op.orderID }, 'Stale amend — no desired counterpart found, order will be removed from managed');
        applied.cancelledIds.push(op.orderID);
      }
    } else {
      applied.amended.push(order);
      applied.summary.amends += 1;
    }
  } catch (err) {
    logger.error({ err, op }, 'Amend failed');
  }
}

/**
 * Finds the desired OrderPlan corresponding to a stale live order.
 *
 * Uses the same positional matching as the converge algorithm:
 * sort each side by price, then match by index.
 */
function findDesiredForAmend(
  orderID: string,
  live:    Order[],
  desired: OrderPlan[],
): OrderPlan | null {
  const liveOrder = live.find((o) => o.orderID === orderID);

  if (! liveOrder) {
    return null;
  }

  const sameSideLive    = sortBySide(live.filter((o) => o.side === liveOrder.side),    liveOrder.side);
  const sameSideDesired = sortBySide(desired.filter((o) => o.side === liveOrder.side), liveOrder.side);
  const liveIdx         = sameSideLive.findIndex((o) => o.orderID === orderID);

  return sameSideDesired[liveIdx] ?? null;
}

function sortBySide<T extends { price?: number }>(orders: T[], side: 'Buy' | 'Sell'): T[] {
  return side === 'Buy'
    ? [...orders].sort((a, b) => (b.price ?? 0) - (a.price ?? 0))  // bids: highest first
    : [...orders].sort((a, b) => (a.price ?? 0) - (b.price ?? 0)); // asks: lowest first
}
