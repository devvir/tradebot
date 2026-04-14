/**
 * Executor module types
 */

import type { Order } from '../types';
import type { OrderPlan } from '../planner/types';

// ---- REST client interface --------------------------------------------

export interface RestClient {
  /** Create a new order; clOrdID tags it with tb_<symbol>_ prefix */
  createOrder(order: OrderPlan, clOrdID: string): Promise<Order>;
  /** Amend price and/or leavesQty. Returns null when the order is stale (404/not-found). */
  amendOrder(orderID: string, amend: Omit<AmendOp, 'orderID'>): Promise<Order | null>;
  /** Batch cancel one or more orders by ID */
  cancelOrders(orderIDs: string[]): Promise<void>;
  /** Fetch all open orders for the symbol (used to seed managed orders on startup) */
  getOrders(symbol: string): Promise<Order[]>;
}

// ---- Converge types ---------------------------------------------------

export interface AmendOp {
  orderID:    string;
  price?:     number;
  /** Target remaining quantity (leavesQty), already accounting for any partial fills */
  leavesQty?: number;
}

export interface CancelOp {
  orderID: string;
}

export interface ConvergeResult {
  amends:  AmendOp[];
  creates: Array<{ order: OrderPlan }>;
  cancels: CancelOp[];
}

// ---- Apply result -----------------------------------------------------

export interface ApplyResult {
  created:      Order[];
  amended:      Order[];
  cancelledIds: string[];
  summary: {
    amends:       number;
    creates:      number;
    cancels:      number;
    staleFallback: number;
  };
}
