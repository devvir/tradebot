import type { OrderDoc, PriceGuard } from '../types';

// ── Price guard ────────────────────────────────────────────────────────────────

/**
 * Recompute the price guard for a symbol from the current live order set.
 * Called after any order create, fill, cancel, or amend.
 *
 * highestBid = most aggressive buy limit price resting (crosses a trade T when T ≤ highestBid).
 * lowestAsk  = most aggressive sell limit price resting (crosses a trade T when T ≥ lowestAsk).
 *
 * Pure: takes a flat list of orders, returns the new guard. No I/O.
 */
export function computeGuard(orders: OrderDoc[]): PriceGuard {
  let highestBid: number | null = null;
  let lowestAsk:  number | null = null;

  for (const order of orders) {
    if (order.ordType !== 'Limit' || order.leavesQty <= 0) continue;

    if (order.side === 'Buy') {
      if (order.price !== null && (highestBid === null || order.price > highestBid)) {
        highestBid = order.price;
      }
    } else {
      if (order.price !== null && (lowestAsk === null || order.price < lowestAsk)) {
        lowestAsk = order.price;
      }
    }
  }

  return { highestBid, lowestAsk };
}

// ── Crossing scan ─────────────────────────────────────────────────────────────

/**
 * O(1) guard check — returns true if a trade at price T could cross any order for
 * this symbol. If the guard says no crossing is possible, no looping occurs.
 */
export function guardAllows(guard: PriceGuard, tradePrice: number): boolean {
  return (guard.highestBid !== null && tradePrice <= guard.highestBid)
      || (guard.lowestAsk  !== null && tradePrice >= guard.lowestAsk);
}

/**
 * Pure: find all open limit orders crossed by a trade at tradePrice.
 *
 * Buy limits are sorted descending (most aggressive first); scan stops at the first
 * price below tradePrice (early exit preserves correct fill order at each level).
 * Sell limits are sorted ascending; scan stops at the first price above tradePrice.
 *
 * Returns the list of crossed orders. No I/O.
 *
 * v1 note: fills the entire leavesQty in one execution.
 * See TELLER.md §Fill quantity for the partial-fill upgrade path.
 */
export function findCrossings(orders: OrderDoc[], tradePrice: number): OrderDoc[] {
  const crossed: OrderDoc[] = [];

  // Buy limits crossed when trade price drops to or below the limit price
  const bids = orders
    .filter(o => o.side === 'Buy' && o.ordType === 'Limit' && o.leavesQty > 0 && o.price !== null)
    .sort((a, b) => b.price! - a.price!);

  for (const order of bids) {
    if (order.price! < tradePrice) break;
    crossed.push(order);
  }

  // Sell limits crossed when trade price rises to or above the limit price
  const asks = orders
    .filter(o => o.side === 'Sell' && o.ordType === 'Limit' && o.leavesQty > 0 && o.price !== null)
    .sort((a, b) => a.price! - b.price!);

  for (const order of asks) {
    if (order.price! > tradePrice) break;
    crossed.push(order);
  }

  return crossed;
}
