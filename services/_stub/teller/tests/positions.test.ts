import { describe, it, expect } from 'vitest';
import { newPosition, applyFill, recomputeUnrealisedPnl } from '../src/positions/index';
import type { PositionDoc, InstrumentCache } from '../src/types';

const TS = '2024-01-01T00:00:00.000Z';

const INSTRUMENT: InstrumentCache = {
  symbol:         'XBTUSD',
  multiplier:     -1e8,        // inverse perpetual
  initMarginReq:  0.01,
  maintMarginReq: 0.005,
  tickSize:       0.5,
  lotSize:        1,
  markPrice:      null,
};

function flatPosition(): PositionDoc {
  return newPosition('acc1', 'XBTUSD', TS);
}

// ── newPosition ───────────────────────────────────────────────────────────────

describe('newPosition', () => {
  it('returns a zeroed position for the given account and symbol', () => {
    const pos = newPosition('acc1', 'XBTUSD', TS);

    expect(pos.accountId).toBe('acc1');
    expect(pos.symbol).toBe('XBTUSD');
    expect(pos.currentQty).toBe(0);
    expect(pos.avgEntryPx).toBeNull();
    expect(pos.realisedPnl).toBe(0);
    expect(pos.unrealisedPnl).toBe(0);
    expect(pos.markPrice).toBeNull();
    expect(pos.liquidationPrice).toBeNull();
    expect(pos.bankruptcyPrice).toBeNull();
    expect(pos.crossMargin).toBe(true);
    expect(pos.timestamp).toBe(TS);
  });
});

// ── applyFill — opening ───────────────────────────────────────────────────────

describe('applyFill — opening a position', () => {
  it('opens a long from flat', () => {
    const pos = applyFill(flatPosition(), { side: 'Buy', qty: 100, price: 50_000 }, INSTRUMENT);

    expect(pos.currentQty).toBe(100);
    expect(pos.avgEntryPx).toBeCloseTo(50_000);
    expect(pos.realisedPnl).toBe(0);
  });

  it('opens a short from flat', () => {
    const pos = applyFill(flatPosition(), { side: 'Sell', qty: 100, price: 50_000 }, INSTRUMENT);

    expect(pos.currentQty).toBe(-100);
    expect(pos.avgEntryPx).toBeCloseTo(50_000);
    expect(pos.realisedPnl).toBe(0);
  });

  it('uses harmonic average when adding to a long', () => {
    // Buy 100 @ 50_000, then buy 100 @ 60_000
    // harmonic avg = 200 / (100/50000 + 100/60000) ≈ 54545.45
    const p1 = applyFill(flatPosition(), { side: 'Buy', qty: 100, price: 50_000 }, INSTRUMENT);
    const p2 = applyFill(p1, { side: 'Buy', qty: 100, price: 60_000 }, INSTRUMENT);

    expect(p2.currentQty).toBe(200);
    expect(p2.avgEntryPx).toBeCloseTo(54_545.45, 0);
    expect(p2.realisedPnl).toBe(0);
  });

  it('uses harmonic average when adding to a short', () => {
    const p1 = applyFill(flatPosition(), { side: 'Sell', qty: 100, price: 50_000 }, INSTRUMENT);
    const p2 = applyFill(p1, { side: 'Sell', qty: 100, price: 60_000 }, INSTRUMENT);

    expect(p2.currentQty).toBe(-200);
    expect(p2.avgEntryPx).toBeCloseTo(54_545.45, 0);
  });
});

// ── applyFill — closing ───────────────────────────────────────────────────────

describe('applyFill — reducing a position', () => {
  it('books realised PnL when closing a profitable long', () => {
    // Long 100 @ 50_000, close @ 60_000
    // realisedPnl = 100 × (1/50000 − 1/60000) × 1e8 ≈ 33_333 satoshis
    const p1 = applyFill(flatPosition(), { side: 'Buy', qty: 100, price: 50_000 }, INSTRUMENT);
    const p2 = applyFill(p1, { side: 'Sell', qty: 100, price: 60_000 }, INSTRUMENT);

    expect(p2.currentQty).toBe(0);
    expect(p2.avgEntryPx).toBeNull();
    expect(p2.realisedPnl).toBeCloseTo(33_333, -1);
  });

  it('books negative realised PnL when closing a losing long', () => {
    const p1 = applyFill(flatPosition(), { side: 'Buy', qty: 100, price: 60_000 }, INSTRUMENT);
    const p2 = applyFill(p1, { side: 'Sell', qty: 100, price: 50_000 }, INSTRUMENT);

    expect(p2.realisedPnl).toBeLessThan(0);
  });

  it('books realised PnL when closing a profitable short', () => {
    // Short 100 @ 60_000, close @ 50_000
    const p1 = applyFill(flatPosition(), { side: 'Sell', qty: 100, price: 60_000 }, INSTRUMENT);
    const p2 = applyFill(p1, { side: 'Buy', qty: 100, price: 50_000 }, INSTRUMENT);

    expect(p2.currentQty).toBe(0);
    expect(p2.realisedPnl).toBeGreaterThan(0);
  });

  it('partial close leaves avgEntryPx unchanged (BitMEX behaviour)', () => {
    const p1 = applyFill(flatPosition(), { side: 'Buy', qty: 100, price: 50_000 }, INSTRUMENT);
    const p2 = applyFill(p1, { side: 'Sell', qty: 50, price: 60_000 }, INSTRUMENT);

    expect(p2.currentQty).toBe(50);
    expect(p2.avgEntryPx).toBeCloseTo(50_000);
  });

  it('resets avgEntryPx to fill price when position flips', () => {
    // Long 100 @ 50_000, then sell 200 → flips to short 100
    const p1 = applyFill(flatPosition(), { side: 'Buy', qty: 100, price: 50_000 }, INSTRUMENT);
    const p2 = applyFill(p1, { side: 'Sell', qty: 200, price: 60_000 }, INSTRUMENT);

    expect(p2.currentQty).toBe(-100);
    expect(p2.avgEntryPx).toBeCloseTo(60_000);
  });

  it('does not mutate the input position', () => {
    const p1 = applyFill(flatPosition(), { side: 'Buy', qty: 100, price: 50_000 }, INSTRUMENT);
    const qtyBefore = p1.currentQty;
    applyFill(p1, { side: 'Sell', qty: 100, price: 60_000 }, INSTRUMENT);

    expect(p1.currentQty).toBe(qtyBefore);
  });
});

// ── recomputeUnrealisedPnl ────────────────────────────────────────────────────

describe('recomputeUnrealisedPnl', () => {
  it('returns zero unrealisedPnl for a flat position', () => {
    const pos = recomputeUnrealisedPnl(flatPosition(), 55_000, INSTRUMENT);

    expect(pos.unrealisedPnl).toBe(0);
    expect(pos.markPrice).toBe(55_000);
  });

  it('computes positive unrealisedPnl for a profitable long', () => {
    // Long 100 @ 50_000, mark @ 60_000
    // unrealised = 100 × (1/50000 − 1/60000) × 1e8 ≈ 33_333 satoshis
    const p1 = applyFill(flatPosition(), { side: 'Buy', qty: 100, price: 50_000 }, INSTRUMENT);
    const p2 = recomputeUnrealisedPnl(p1, 60_000, INSTRUMENT);

    expect(p2.unrealisedPnl).toBeCloseTo(33_333, -1);
    expect(p2.markPrice).toBe(60_000);
  });

  it('computes negative unrealisedPnl for a losing long', () => {
    const p1 = applyFill(flatPosition(), { side: 'Buy', qty: 100, price: 60_000 }, INSTRUMENT);
    const p2 = recomputeUnrealisedPnl(p1, 50_000, INSTRUMENT);

    expect(p2.unrealisedPnl).toBeLessThan(0);
  });

  it('computes positive unrealisedPnl for a profitable short', () => {
    // Short 100 @ 60_000, mark @ 50_000 → price dropped, short profits
    const p1 = applyFill(flatPosition(), { side: 'Sell', qty: 100, price: 60_000 }, INSTRUMENT);
    const p2 = recomputeUnrealisedPnl(p1, 50_000, INSTRUMENT);

    expect(p2.unrealisedPnl).toBeGreaterThan(0);
  });

  it('updates markPrice on the returned position', () => {
    const p1 = applyFill(flatPosition(), { side: 'Buy', qty: 100, price: 50_000 }, INSTRUMENT);
    const p2 = recomputeUnrealisedPnl(p1, 55_000, INSTRUMENT);

    expect(p2.markPrice).toBe(55_000);
  });

  it('does not mutate the input position', () => {
    const p1 = applyFill(flatPosition(), { side: 'Buy', qty: 100, price: 50_000 }, INSTRUMENT);
    recomputeUnrealisedPnl(p1, 55_000, INSTRUMENT);

    expect(p1.markPrice).toBeNull();
  });
});
