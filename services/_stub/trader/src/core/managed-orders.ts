/**
 * Local bookkeeping of orders this trader instance owns.
 *
 * The orchestrator manages orders locally rather than via a private WS stream:
 *   - Seed from REST on startup so we don't orphan existing orders on restart
 *   - Update the list as each apply result comes back from the exchange
 *   - The next converge tick reads the updated list as the "live" snapshot
 *
 * Ownership is identified by clOrdID prefix (`tb_<symbol>_NNNNNN`). The numeric
 * sequence keeps clOrdIDs unique within one trader run; on restart we resume
 * past the highest seen sequence so a quick restart can't collide with orders
 * that are still resting on the book.
 */

import type { Order } from '../types';
import type { ApplyResult } from '../executor';
import { clOrdPrefix } from '../executor';

/** Width of the zero-padded sequence in clOrdID. 6 → 1M orders before wrap. */
const SEQ_WIDTH = 6;

/**
 * Build the next clOrdID for `symbol` given the current sequence value.
 * Returns the new ID and the new sequence to store.
 */
export function buildClOrdID(symbol: string, currentSeq: number): { id: string; seq: number } {
  const seq = currentSeq + 1;
  const id  = `${clOrdPrefix(symbol)}${String(seq).padStart(SEQ_WIDTH, '0')}`;

  return { id, seq };
}

/**
 * Inspect existing orders and return the highest sequence number found.
 * Returns 0 when no managed orders exist yet, so the next clOrdID is _000001.
 */
export function seedSequence(orders: Order[], symbol: string): number {
  const prefix = clOrdPrefix(symbol);
  let   max    = 0;

  for (const o of orders) {
    if (! o.clOrdID || ! o.clOrdID.startsWith(prefix)) continue;

    const tail = o.clOrdID.slice(prefix.length);
    const num  = parseInt(tail, 10);

    if (Number.isFinite(num) && num > max) max = num;
  }

  return max;
}

/**
 * Apply the result of one execution tick to the managed-orders list.
 * Pure function: returns a new array, doesn't mutate the input.
 */
export function applyToOrderList(current: Order[], applied: ApplyResult): Order[] {
  const cancelled = new Set(applied.cancelledIds);
  const amended   = new Map(applied.amended.map((o) => [o.orderID, o]));

  // Replace amended in place; drop cancelled
  let next = current
    .filter((o) => ! cancelled.has(o.orderID))
    .map((o) => amended.get(o.orderID) ?? o);

  // Append newly created
  next = next.concat(applied.created);

  return next;
}
