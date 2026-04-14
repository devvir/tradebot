/**
 * Converge algorithm — ported from services/executor.
 *
 * Given a desired order list and the current managed order list, computes the
 * minimum set of amend / create / cancel operations to make managed match desired.
 *
 * Matching is positional within each side (bids and asks independently):
 *   - Bids sorted descending by price (highest = closest to mid)
 *   - Asks sorted ascending by price  (lowest = closest to mid)
 *   - desired[i] is matched to live[i] within each side
 *
 * Amend condition: |price delta| > amendThreshold OR desired orderQty ≠ live leavesQty.
 * amendThreshold is an absolute price delta; 0 means any change triggers an amend.
 *
 * Execution order: amend first (keeps orders active), then create, then cancel.
 */

import type { Order } from '../types';
import type { OrderPlan } from '../planner/types';
import type { AmendOp, CancelOp, ConvergeResult } from './types';

/** clOrdID prefix used to scope managed orders per symbol */
export const clOrdPrefix = (symbol: string): string => `tb_${symbol}_`;

/**
 * Filter the full order list to active orders owned by this trader for the given symbol.
 *   Active = ordStatus is 'New' or 'PartiallyFilled'
 *   Owned  = clOrdID starts with tb_<symbol>_
 */
export function filterActiveOrders(allOrders: Order[], symbol: string): Order[] {
  const prefix = clOrdPrefix(symbol);

  return allOrders.filter(
    (o) =>
      o.symbol === symbol &&
      o.clOrdID !== undefined &&
      o.clOrdID.startsWith(prefix) &&
      (o.ordStatus === 'New' || o.ordStatus === 'PartiallyFilled'),
  );
}

/**
 * Compute the minimal converge plan between desired and live orders.
 *
 * Desired and live are matched positionally within each side after sorting.
 * Returns three lists: amends, creates, and cancels.
 */
export function converge(
  desired:        OrderPlan[],
  live:           Order[],
  amendThreshold: number,
): ConvergeResult {
  const desiredBuys  = sortBids(desired.filter((o) => o.side === 'Buy'));
  const desiredSells = sortAsks(desired.filter((o) => o.side === 'Sell'));
  const liveBuys     = sortBids(live.filter((o) => o.side === 'Buy'));
  const liveSells    = sortAsks(live.filter((o) => o.side === 'Sell'));

  const amends:  AmendOp[]                   = [];
  const creates: Array<{ order: OrderPlan }> = [];
  const cancels: CancelOp[]                  = [];

  processSide(desiredBuys,  liveBuys,  amendThreshold, amends, creates, cancels);
  processSide(desiredSells, liveSells, amendThreshold, amends, creates, cancels);

  return { amends, creates, cancels };
}

// ---- Private -----------------------------------------------------------

function processSide(
  desired:   OrderPlan[],
  live:      Order[],
  threshold: number,
  amends:    AmendOp[],
  creates:   Array<{ order: OrderPlan }>,
  cancels:   CancelOp[],
): void {
  const len = Math.max(desired.length, live.length);

  for (let i = 0; i < len; i++) {
    const d = desired[i];
    const l = live[i];

    if (d && l) {
      const leavesQty = l.leavesQty ?? l.orderQty;

      const priceChanged =
        d.price !== undefined &&
        l.price !== undefined &&
        Math.abs(d.price - l.price) > threshold;

      const qtyChanged =
        d.orderQty !== undefined &&
        d.orderQty !== leavesQty;

      if (priceChanged || qtyChanged) {
        const amend: AmendOp = { orderID: l.orderID };

        if (priceChanged) amend.price     = d.price;
        if (qtyChanged)   amend.leavesQty = d.orderQty;

        amends.push(amend);
      }
    } else if (d && ! l) {
      creates.push({ order: d });
    } else if (! d && l) {
      cancels.push({ orderID: l.orderID });
    }
  }
}

function sortBids<T extends { price?: number }>(orders: T[]): T[] {
  return [...orders].sort((a, b) => (b.price ?? 0) - (a.price ?? 0));
}

function sortAsks<T extends { price?: number }>(orders: T[]): T[] {
  return [...orders].sort((a, b) => (a.price ?? 0) - (b.price ?? 0));
}
