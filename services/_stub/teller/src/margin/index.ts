import type { MarginDoc, PositionDoc, Fill, InstrumentCache } from '../types';
import { TellerError } from '../types';

// ── Fill ──────────────────────────────────────────────────────────────────────

/**
 * Pure: update margin after a fill.
 *
 * Credits the realised PnL delta (nextPosition.realisedPnl - prevPosition.realisedPnl)
 * to walletBalance, releases the initial margin held for the filled portion, and
 * recomputes marginBalance and availableMargin.
 */
export function applyFill(
  margin:       MarginDoc,
  fill:         Fill,
  prevPosition: PositionDoc,
  nextPosition: PositionDoc,
  instrument:   InstrumentCache,
): MarginDoc {
  const realisedDelta = nextPosition.realisedPnl - prevPosition.realisedPnl;

  // Release initial margin held for the filled portion
  const initMarginReleased = Math.round(fill.qty * fill.price * instrument.initMarginReq);

  const walletBalance = margin.walletBalance + Math.round(realisedDelta);
  const realisedPnl   = margin.realisedPnl + Math.round(realisedDelta);
  const initMargin    = Math.max(0, margin.initMargin - initMarginReleased);
  const unrealisedPnl = nextPosition.unrealisedPnl;

  return recompute({ ...margin, walletBalance, realisedPnl, unrealisedPnl, initMargin });
}

// ── Order margin (debit/credit on create/cancel) ──────────────────────────────

/**
 * Pure: debit or credit initial margin when an order is created or canceled.
 *
 * For Limit orders: initMarginHeld = orderQty × price × initMarginReq.
 * Market orders have no up-front margin reservation (they fill immediately).
 */
export function applyOrderMargin(
  margin:     MarginDoc,
  orderQty:   number,
  price:      number,
  initMarginReq: number,
  direction:  'debit' | 'credit',
): MarginDoc {
  const delta = Math.round(orderQty * price * initMarginReq);

  const initMargin = direction === 'debit'
    ? margin.initMargin + delta
    : Math.max(0, margin.initMargin - delta);

  return recompute({ ...margin, initMargin });
}

// ── Deposit / withdrawal ──────────────────────────────────────────────────────

/**
 * Pure: apply a simulated deposit or withdrawal.
 * amount is in satoshis; positive = deposit, negative = withdrawal.
 * Throws TellerError if a withdrawal would take walletBalance below zero.
 */
export function applyDeposit(margin: MarginDoc, amount: number): MarginDoc {
  const newBalance = margin.walletBalance + amount;

  if (newBalance < 0) {
    throw new TellerError('Insufficient wallet balance for withdrawal');
  }

  return recompute({ ...margin, walletBalance: newBalance });
}

// ── Unrealised PnL update (mark price change) ─────────────────────────────────

/**
 * Pure: recompute margin after unrealised PnL changes across all positions.
 * positions is the new map of positions for this account (already updated).
 */
export function applyUnrealisedUpdate(
  margin:    MarginDoc,
  positions: Map<string, PositionDoc>,
): MarginDoc {
  const unrealisedPnl = [...positions.values()].reduce((sum, p) => sum + p.unrealisedPnl, 0);

  return recompute({ ...margin, unrealisedPnl });
}

// ── Liquidation ───────────────────────────────────────────────────────────────

/**
 * Pure: recompute liquidationPrice and bankruptcyPrice for a position.
 *
 * v1 stub — returns the position unchanged with both fields as null.
 *
 * The real formulas vary by contract type (inverse, quanto, linear) and margin
 * mode (isolated vs cross). They must be taken verbatim from the BitMEX API docs
 * at https://www.bitmex.com/app/liquidation. Cross-reference against real
 * position data from Bouncer accounts to validate before shipping.
 */
export function recomputeLiquidation(
  position:   PositionDoc,
  _margin:    MarginDoc,
  _instrument: InstrumentCache,
): PositionDoc {
  // TODO: implement BitMEX liquidation and bankruptcy price formulas
  return { ...position, liquidationPrice: null, bankruptcyPrice: null };
}

// ── Private helpers ────────────────────────────────────────────────────────────

/** Recompute derived margin fields from the base values. */
function recompute(m: MarginDoc): MarginDoc {
  const marginBalance   = m.walletBalance + m.unrealisedPnl;
  const availableMargin = marginBalance - m.initMargin;

  return { ...m, marginBalance, availableMargin, timestamp: new Date().toISOString() };
}
