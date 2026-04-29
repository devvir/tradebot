import { v4 as uuid } from 'uuid';
import type { AccountState, OrderDoc, CreateRequest, AmendFields } from '../types';
import { TellerError } from '../types';

// ── Create ────────────────────────────────────────────────────────────────────

/**
 * Pure: validate and create a new order document.
 * Returns updated state and the new order. No I/O.
 */
export function createOrder(
  accountState: AccountState,
  req:          CreateRequest,
): { state: AccountState; order: OrderDoc } {
  if (req.ordType !== 'Limit' && req.ordType !== 'Market') {
    throw new TellerError(`Unsupported ordType: ${req.ordType}`);
  }

  if (req.ordType === 'Limit' && (req.price === undefined || req.price <= 0)) {
    throw new TellerError('price is required and must be > 0 for Limit orders');
  }

  if (req.orderQty <= 0) {
    throw new TellerError('orderQty must be > 0');
  }

  const clOrdID = req.clOrdID ?? uuid();

  for (const o of accountState.orders.values()) {
    if (o.clOrdID === clOrdID) {
      throw new TellerError(`Duplicate clOrdID: ${clOrdID}`);
    }
  }

  const order: OrderDoc = {
    orderID:   uuid(),
    clOrdID,
    accountId: accountState.margin.accountId,
    symbol:    req.symbol,
    side:      req.side,
    ordType:   req.ordType,
    price:     req.price ?? null,
    orderQty:  req.orderQty,
    leavesQty: req.orderQty,
    cumQty:    0,
    avgPx:     null,
    ordStatus: 'New',
    timestamp: req.timestamp,
    text:      'Submitted',
  };

  const orders = new Map(accountState.orders);
  orders.set(order.orderID, order);

  return { state: { ...accountState, orders }, order };
}

// ── Amend ─────────────────────────────────────────────────────────────────────

/**
 * Pure: apply price/orderQty amendment.
 * Amending orderQty ≤ cumQty cancels the order (BitMEX behaviour).
 */
export function amendOrder(
  accountState: AccountState,
  orderId:      string,
  fields:       AmendFields,
): { state: AccountState; order: OrderDoc } {
  const existing = accountState.orders.get(orderId);

  if (! existing) throw new TellerError(`Order not found: ${orderId}`, 404);

  if (existing.ordStatus === 'Filled' || existing.ordStatus === 'Canceled') {
    throw new TellerError(`Cannot amend a ${existing.ordStatus} order`);
  }

  let amended: OrderDoc = { ...existing };

  if (fields.price !== undefined) amended.price = fields.price;

  if (fields.orderQty !== undefined) {
    if (fields.orderQty <= amended.cumQty) {
      amended = { ...amended, ordStatus: 'Canceled', leavesQty: 0, text: 'Canceled by amend' };
    } else {
      amended.orderQty  = fields.orderQty;
      amended.leavesQty = fields.orderQty - amended.cumQty;
    }
  }

  const orders = new Map(accountState.orders);

  if (amended.ordStatus === 'Canceled') {
    orders.delete(orderId);
  } else {
    orders.set(orderId, amended);
  }

  return { state: { ...accountState, orders }, order: amended };
}

// ── Cancel ────────────────────────────────────────────────────────────────────

/** Pure: cancel a single open order. */
export function cancelOrder(
  accountState: AccountState,
  orderId:      string,
  text:         string = 'Canceled',
): { state: AccountState; order: OrderDoc } {
  const existing = accountState.orders.get(orderId);

  if (! existing) throw new TellerError(`Order not found: ${orderId}`, 404);

  if (existing.ordStatus === 'Filled' || existing.ordStatus === 'Canceled') {
    throw new TellerError(`Order is already ${existing.ordStatus}`);
  }

  const canceled: OrderDoc = { ...existing, ordStatus: 'Canceled', leavesQty: 0, text };

  const orders = new Map(accountState.orders);
  orders.delete(orderId);

  return { state: { ...accountState, orders }, order: canceled };
}

/** Pure: cancel all open orders for a symbol (or all symbols if undefined). */
export function cancelAllOrders(
  accountState: AccountState,
  symbol?:      string,
): { state: AccountState; orders: OrderDoc[] } {
  const canceled: OrderDoc[] = [];
  const orders = new Map(accountState.orders);

  for (const [id, order] of orders) {
    if (symbol === undefined || order.symbol === symbol) {
      canceled.push({ ...order, ordStatus: 'Canceled', leavesQty: 0, text: 'Canceled' });
      orders.delete(id);
    }
  }

  return { state: { ...accountState, orders }, orders: canceled };
}
