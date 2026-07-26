import type { PositionDoc, Fill, InstrumentCache } from '../types';

const STRATEGY_DEFAULT = '';  // one-way mode

/** Construct a zeroed position document for a new account/symbol pair. */
export function newPosition(accountId: string, symbol: string, timestamp: string): PositionDoc {
  return {
    accountId,
    symbol,
    strategy:         STRATEGY_DEFAULT,
    crossMargin:      true,
    currentQty:       0,
    avgEntryPx:       null,
    realisedPnl:      0,
    unrealisedPnl:    0,
    markPrice:        null,
    liquidationPrice: null,
    bankruptcyPrice:  null,
    timestamp,
  };
}

/**
 * Pure: apply a fill to a position and return the updated document.
 *
 * For inverse perpetuals (e.g. XBTUSD), PnL uses multiplier from the instrument
 * stream. The multiplier is negative for inverse contracts (e.g. -1e8 for XBTUSD),
 * so we take the absolute value and apply direction via the position's side.
 *
 * avgEntryPx uses the inverse-weighted average (harmonic) for correct XBT cost basis:
 *   new_avg = (currentQty + qty) / (currentQty/avgEntryPx + qty/fillPx)
 * This differs from a simple linear average and correctly reflects the XBT
 * spent per contract at each price level.
 *
 * TODO: non-inverse (quanto, linear) contracts require a different formula.
 * The multiplier sign and settlement currency identify which branch to take.
 */
export function applyFill(
  position:   PositionDoc,
  fill:       Fill,
  instrument: InstrumentCache,
): PositionDoc {
  const { side, qty, price: fillPx } = fill;
  const absMultiplier = Math.abs(instrument.multiplier);

  let { currentQty, avgEntryPx, realisedPnl } = position;

  const isBuy  = side === 'Buy';
  const isLong = currentQty > 0;
  const isFlat = currentQty === 0;

  // Is this fill increasing or decreasing the position?
  const increases = isFlat || (isBuy ? isLong : ! isLong);

  if (increases) {
    const prevQty = Math.abs(currentQty);
    const newQty  = prevQty + qty;
    const prevPx  = avgEntryPx ?? fillPx;

    // Harmonic average for inverse contracts (correct XBT cost basis)
    avgEntryPx = newQty / (prevQty / prevPx + qty / fillPx);
    currentQty = currentQty + (isBuy ? qty : -qty);

  } else {
    const absCurrentQty = Math.abs(currentQty);
    const reduceQty     = Math.min(qty, absCurrentQty);
    const prevPx        = avgEntryPx ?? fillPx;

    // Realised PnL for the reducing portion
    // Sell from long: realisedPnl += qty × (1/avgEntryPx - 1/fillPx) × |multiplier|
    // Buy from short: realisedPnl += qty × (1/fillPx - 1/avgEntryPx) × |multiplier|
    if (isLong) {
      realisedPnl += reduceQty * (1 / prevPx - 1 / fillPx) * absMultiplier;
    } else {
      realisedPnl += reduceQty * (1 / fillPx - 1 / prevPx) * absMultiplier;
    }

    currentQty = currentQty + (isBuy ? qty : -qty);

    if (Math.abs(currentQty) < 0.5) {
      // Position fully closed
      currentQty = 0;
      avgEntryPx = null;
    } else if (qty > absCurrentQty) {
      // Position flipped sides — reset avgEntryPx to the fill price
      avgEntryPx = fillPx;
    }
    // If just reduced without flip, avgEntryPx stays unchanged (BitMEX behaviour)
  }

  return { ...position, currentQty, avgEntryPx, realisedPnl, timestamp: new Date().toISOString() };
}

/**
 * Pure: recompute unrealisedPnl from the current markPrice.
 * Called on every instrument.update that carries a new markPrice.
 */
export function recomputeUnrealisedPnl(
  position:   PositionDoc,
  markPrice:  number,
  instrument: InstrumentCache,
): PositionDoc {
  if (position.currentQty === 0 || ! position.avgEntryPx) {
    return { ...position, unrealisedPnl: 0, markPrice, timestamp: new Date().toISOString() };
  }

  const absMultiplier = Math.abs(instrument.multiplier);
  const absQty        = Math.abs(position.currentQty);
  const isLong        = position.currentQty > 0;

  const unrealisedPnl = isLong
    ? absQty * (1 / position.avgEntryPx - 1 / markPrice) * absMultiplier
    : absQty * (1 / markPrice - 1 / position.avgEntryPx) * absMultiplier;

  return { ...position, unrealisedPnl, markPrice, timestamp: new Date().toISOString() };
}
