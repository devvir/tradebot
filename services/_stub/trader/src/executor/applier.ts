/**
 * Apply a ConvergeResult against the exchange via the REST client.
 *
 * Order of operations (amend → create → cancel) keeps existing orders active
 * during the transition and avoids momentary unhedged windows:
 *
 *   1. Amend  — keeps existing orders live while their parameters update
 *   2. Create — fills any gaps the converge plan identified
 *   3. Cancel — removes orders no longer wanted, last so the book is never
 *               briefly unhedged
 *
 * Stale-amend fallback: if amend returns null (the order filled or vanished
 * between the snapshot and the REST call), the same desired-side slot is
 * re-filled by issuing a new create at the desired price/qty.
 */

import { logger } from '@devvir/service-kit';
import type { Order } from '../types';
import type { OrderPlan } from '../planner/types';
import type { RestClient } from '../rest';
import type { AmendOp, ConvergeResult, ApplyResult } from './types';

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
    summary:      { amends: 0, creates: 0, cancels: 0, staleFallback: 0 },
  };

  // 1. Amend first — keeps existing orders active during the transition
  for (const op of result.amends) {
    await applyAmend(op, client, ctx, applied);
  }

  // 2. Create — fills gaps
  for (const { order, clOrdID } of creates) {
    await applyCreate(order, clOrdID, client, applied);
  }

  // 3. Cancel last — book is never briefly unhedged
  if (result.cancels.length > 0) {
    await applyCancels(result.cancels.map((c) => c.orderID), client, applied);
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
  let order: Order | null;

  try {
    order = await client.amendOrder(op.orderID, { price: op.price, leavesQty: op.leavesQty });
  } catch (err) {
    logger.error({ err, op }, 'Amend failed');
    return;
  }

  if (order !== null) {
    applied.amended.push(order);
    applied.summary.amends += 1;
    return;
  }

  // Stale: order filled or not-found. Replace at the same desired-side slot.
  const desired = findDesiredForAmend(op.orderID, ctx.live, ctx.desired);

  if (! desired) {
    logger.warn({ orderID: op.orderID }, 'Stale amend — no desired counterpart, removing from managed');
    applied.cancelledIds.push(op.orderID);
    return;
  }

  const clOrdID = ctx.nextClOrdID();

  try {
    const created = await client.createOrder(desired, clOrdID);

    applied.created.push(created);
    applied.summary.creates       += 1;
    applied.summary.staleFallback += 1;
    logger.info({ orderID: op.orderID, clOrdID }, 'Stale amend — replaced with new order');
  } catch (err) {
    logger.error({ err, op, clOrdID }, 'Stale amend fallback create failed');
  }
}

async function applyCreate(
  order:   OrderPlan,
  clOrdID: string,
  client:  RestClient,
  applied: ApplyResult,
): Promise<void> {
  try {
    const created = await client.createOrder(order, clOrdID);

    applied.created.push(created);
    applied.summary.creates += 1;
  } catch (err) {
    logger.error({ err, order, clOrdID }, 'Create order failed');
  }
}

async function applyCancels(
  orderIDs: string[],
  client:   RestClient,
  applied:  ApplyResult,
): Promise<void> {
  try {
    await client.cancelOrders(orderIDs);

    applied.cancelledIds.push(...orderIDs);
    applied.summary.cancels += orderIDs.length;
  } catch (err) {
    logger.error({ err, orderIDs }, 'Batch cancel failed');
  }
}

/**
 * Find the desired OrderPlan corresponding to a stale live order.
 *
 * Uses the same positional matching as the converge algorithm: sort each side
 * by price, then match by index.
 */
function findDesiredForAmend(
  orderID: string,
  live:    Order[],
  desired: OrderPlan[],
): OrderPlan | null {
  const liveOrder = live.find((o) => o.orderID === orderID);

  if (! liveOrder) return null;

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

// ---- Test exports ------------------------------------------------------

export const _test_findDesiredForAmend = findDesiredForAmend;
