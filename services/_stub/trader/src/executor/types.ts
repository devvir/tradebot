/**
 * Executor module types
 */

import type { OrderPlan } from '../planner/types';

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

export interface ApplyResult {
  created:      import('../types').Order[];
  amended:      import('../types').Order[];
  cancelledIds: string[];
  summary:      ApplySummary;
}

export interface ApplySummary {
  amends:        number;
  creates:       number;
  cancels:       number;
  staleFallback: number;
}
