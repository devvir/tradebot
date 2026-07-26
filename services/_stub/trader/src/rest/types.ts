/**
 * REST module types
 */

import type { Order } from '../types';
import type { OrderPlan } from '../planner/types';

export interface AmendArgs {
  price?:     number;
  /** Target remaining quantity (leavesQty), already accounting for any partial fills */
  leavesQty?: number;
}

/**
 * The exchange REST surface the orchestrator and applier depend on.
 *
 * Implemented by HttpRestClient against the configured BitMEX-compatible
 * endpoint (our `rest` service or BitMEX directly — the same client works
 * against both because every request is signed BitMEX-compatible).
 */
export interface RestClient {
  /** Create a new order. clOrdID is tagged with tb_<symbol>_ prefix. */
  createOrder(order: OrderPlan, clOrdID: string): Promise<Order>;

  /** Amend price and/or leavesQty. Returns null when the order is stale (404 / not-found). */
  amendOrder(orderID: string, amend: AmendArgs): Promise<Order | null>;

  /** Batch cancel one or more orders by ID. */
  cancelOrders(orderIDs: string[]): Promise<void>;

  /** Fetch all open orders for the symbol (used to seed managed orders on startup). */
  getOrders(symbol: string): Promise<Order[]>;
}
