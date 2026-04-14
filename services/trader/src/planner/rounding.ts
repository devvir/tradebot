/**
 * Tick and lot size rounding utilities
 */

import type { Instrument } from '../types';

export function roundToTick(price: number, tickSize: number | undefined): number {
  if (! tickSize || tickSize <= 0) {
    return price;
  }

  return Math.round(price / tickSize) * tickSize;
}

export function roundToLot(quantity: number, lotSize: number | undefined): number {
  if (! lotSize || lotSize <= 0) {
    return quantity;
  }

  return Math.floor(quantity / lotSize) * lotSize;
}

export function normalizePrice(price: number, instrument: Instrument | null): number {
  if (! instrument) {
    return price;
  }

  return roundToTick(price, instrument.tickSize);
}

export function normalizeQuantity(qty: number, instrument: Instrument | null): number {
  if (! instrument) {
    return Math.floor(qty);
  }

  return roundToLot(qty, instrument.lotSize);
}
