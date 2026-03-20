import type { DesiredOrder, LiveOrder, AmendOp, CreateOp, CancelOp, ConvergeResult } from './types';

/**
 * Converge algorithm: given a desired order list and the current live order list,
 * compute the minimum set of amend / create / cancel operations to make live match desired.
 *
 * Matching is positional within each side (bids and asks independently):
 *   - Bids sorted descending by price (highest = closest to mid)
 *   - Asks sorted ascending by price  (lowest = closest to mid)
 *   - desired[i] is matched to live[i] within each side
 *
 * Amend condition: price delta > amendThreshold OR desired qty differs from live leavesQty.
 * amendThreshold is an absolute price delta; 0 means any change triggers an amend.
 *
 * Execution order: amend first (keeps orders active), then create, then cancel.
 */
export function converge(
  desired:         DesiredOrder[],
  live:            LiveOrder[],
  amendThreshold:  number,
): ConvergeResult {
  const desiredBuys  = sortBids(desired.filter((o) => o.side === 'Buy'));
  const desiredSells = sortAsks(desired.filter((o) => o.side === 'Sell'));
  const liveBuys     = sortBids(live.filter((o) => o.side === 'Buy'));
  const liveSells    = sortAsks(live.filter((o) => o.side === 'Sell'));

  const amends:  AmendOp[]  = [];
  const creates: CreateOp[] = [];
  const cancels: CancelOp[] = [];

  processSide(desiredBuys,  liveBuys,  amendThreshold, amends, creates, cancels);
  processSide(desiredSells, liveSells, amendThreshold, amends, creates, cancels);

  return { amends, creates, cancels };
}

/**
 * Filters the full order snapshot to active orders owned by this executor for the given symbol.
 * Active   = ordStatus is 'New' or 'PartiallyFilled'.
 * Owned    = clOrdID starts with tb_<symbol>_.
 */
export function filterActiveOrders(allOrders: LiveOrder[], symbol: string): LiveOrder[] {
  const prefix = `tb_${symbol}_`;

  return allOrders.filter(
    (o) =>
      o.symbol === symbol &&
      o.clOrdID.startsWith(prefix) &&
      (o.ordStatus === 'New' || o.ordStatus === 'PartiallyFilled'),
  );
}

function processSide(
  desired:  DesiredOrder[],
  live:     LiveOrder[],
  threshold: number,
  amends:   AmendOp[],
  creates:  CreateOp[],
  cancels:  CancelOp[],
): void {
  const len = Math.max(desired.length, live.length);

  for (let i = 0; i < len; i++) {
    const d = desired[i];
    const l = live[i];

    if (d && l) {
      const priceChanged =
        d.price !== undefined &&
        l.price !== undefined &&
        Math.abs(d.price - l.price) > threshold;

      const qtyChanged =
        d.orderQty !== undefined &&
        d.orderQty !== l.leavesQty;

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
