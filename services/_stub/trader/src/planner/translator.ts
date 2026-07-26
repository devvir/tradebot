/**
 * Translator: convert pseudo-orders to BitMEX OrderPlans
 */

import type { PseudoOrder } from '../strategies/types';
import type { OrderPlan } from './types';
import type { Instrument } from '../types';
import { normalizePrice, normalizeQuantity } from './rounding';

const DEFAULT_QTY = 100;

export function translateOrder(
  pseudo:     PseudoOrder,
  symbol:     string,
  instrument: Instrument | null,
): OrderPlan {
  const price    = normalizePrice(pseudo.price, instrument);
  const orderQty = normalizeQuantity(pseudo.quantity ?? DEFAULT_QTY, instrument);

  return {
    symbol,
    side:     pseudo.side === 'buy' ? 'Buy' : 'Sell',
    ordType:  'Limit',
    price,
    orderQty,
  };
}

export function translateOrders(
  pseudo:     PseudoOrder[],
  symbol:     string,
  instrument: Instrument | null,
): OrderPlan[] {
  return pseudo.map((p) => translateOrder(p, symbol, instrument));
}
