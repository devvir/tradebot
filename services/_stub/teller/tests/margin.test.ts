import { describe, it, expect } from 'vitest';
import { applyFill, applyOrderMargin, applyDeposit, applyUnrealisedUpdate } from '../src/margin/index';
import type { MarginDoc, PositionDoc, InstrumentCache } from '../src/types';
import { TellerError } from '../src/types';

const TS = '2024-01-01T00:00:00.000Z';

const INSTRUMENT: InstrumentCache = {
  symbol:         'XBTUSD',
  multiplier:     -1e8,
  initMarginReq:  0.01,
  maintMarginReq: 0.005,
  tickSize:       0.5,
  lotSize:        1,
  markPrice:      null,
};

function freshMargin(walletBalance = 10_000_000): MarginDoc {
  return {
    accountId:       'acc1',
    currency:        'XBt',
    walletBalance,
    realisedPnl:     0,
    unrealisedPnl:   0,
    marginBalance:   walletBalance,
    availableMargin: walletBalance,
    initMargin:      0,
    maintMargin:     0,
    timestamp:       TS,
  };
}

function pos(realisedPnl: number, unrealisedPnl = 0): PositionDoc {
  return {
    accountId:        'acc1',
    symbol:           'XBTUSD',
    strategy:         '',
    crossMargin:      true,
    currentQty:       100,
    avgEntryPx:       50_000,
    realisedPnl,
    unrealisedPnl,
    markPrice:        null,
    liquidationPrice: null,
    bankruptcyPrice:  null,
    timestamp:        TS,
  };
}

// ── applyFill ─────────────────────────────────────────────────────────────────

describe('applyFill (margin)', () => {
  it('credits realised PnL delta to walletBalance', () => {
    const margin = freshMargin();
    const prev = pos(0);
    const next = pos(50_000);   // 50_000 sat gain

    const result = applyFill(margin, { side: 'Sell', qty: 100, price: 60_000 }, prev, next, INSTRUMENT);

    expect(result.walletBalance).toBe(10_000_000 + 50_000);
    expect(result.realisedPnl).toBe(50_000);
  });

  it('debits walletBalance on a loss', () => {
    const margin = freshMargin();
    const prev = pos(0);
    const next = pos(-50_000);

    const result = applyFill(margin, { side: 'Sell', qty: 100, price: 40_000 }, prev, next, INSTRUMENT);

    expect(result.walletBalance).toBe(10_000_000 - 50_000);
  });

  it('releases initMargin held for the filled portion', () => {
    // initMargin = qty × price × initMarginReq = 100 × 60000 × 0.01 = 60_000
    const margin = { ...freshMargin(), initMargin: 60_000 };
    const prev = pos(0);
    const next = pos(50_000);

    const result = applyFill(margin, { side: 'Sell', qty: 100, price: 60_000 }, prev, next, INSTRUMENT);

    expect(result.initMargin).toBe(0);
  });

  it('recomputes marginBalance = walletBalance + unrealisedPnl', () => {
    const margin = freshMargin();
    const prev = pos(0);
    const next = pos(50_000, 10_000);

    const result = applyFill(margin, { side: 'Sell', qty: 100, price: 60_000 }, prev, next, INSTRUMENT);

    expect(result.marginBalance).toBe(result.walletBalance + result.unrealisedPnl);
  });

  it('recomputes availableMargin = marginBalance - initMargin', () => {
    const margin = freshMargin();
    const prev = pos(0);
    const next = pos(50_000);

    const result = applyFill(margin, { side: 'Sell', qty: 100, price: 60_000 }, prev, next, INSTRUMENT);

    expect(result.availableMargin).toBe(result.marginBalance - result.initMargin);
  });

  it('does not mutate the input margin', () => {
    const margin = freshMargin();
    applyFill(margin, { side: 'Sell', qty: 100, price: 60_000 }, pos(0), pos(50_000), INSTRUMENT);

    expect(margin.walletBalance).toBe(10_000_000);
  });
});

// ── applyOrderMargin ─────────────────────────────────────────────────────────

describe('applyOrderMargin', () => {
  it('debits initMargin when placing a limit order', () => {
    // delta = 100 × 50_000 × 0.01 = 50_000
    const margin = freshMargin();
    const result = applyOrderMargin(margin, 100, 50_000, 0.01, 'debit');

    expect(result.initMargin).toBe(50_000);
  });

  it('credits initMargin when canceling a limit order', () => {
    const margin = { ...freshMargin(), initMargin: 50_000 };
    const result = applyOrderMargin(margin, 100, 50_000, 0.01, 'credit');

    expect(result.initMargin).toBe(0);
  });

  it('floors initMargin at 0 on credit (no negative margin)', () => {
    const margin = freshMargin();   // initMargin = 0
    const result = applyOrderMargin(margin, 100, 50_000, 0.01, 'credit');

    expect(result.initMargin).toBe(0);
  });

  it('reduces availableMargin after debit', () => {
    const margin = freshMargin(10_000_000);
    const result = applyOrderMargin(margin, 100, 50_000, 0.01, 'debit');

    expect(result.availableMargin).toBe(result.marginBalance - result.initMargin);
  });

  it('does not mutate the input margin', () => {
    const margin = freshMargin();
    applyOrderMargin(margin, 100, 50_000, 0.01, 'debit');

    expect(margin.initMargin).toBe(0);
  });
});

// ── applyDeposit ──────────────────────────────────────────────────────────────

describe('applyDeposit', () => {
  it('increases walletBalance on deposit', () => {
    const margin = freshMargin(1_000_000);
    const result = applyDeposit(margin, 500_000);

    expect(result.walletBalance).toBe(1_500_000);
  });

  it('decreases walletBalance on withdrawal', () => {
    const margin = freshMargin(1_000_000);
    const result = applyDeposit(margin, -200_000);

    expect(result.walletBalance).toBe(800_000);
  });

  it('allows withdrawing the exact balance (walletBalance → 0)', () => {
    const margin = freshMargin(1_000_000);
    const result = applyDeposit(margin, -1_000_000);

    expect(result.walletBalance).toBe(0);
  });

  it('throws TellerError when withdrawal exceeds balance', () => {
    const margin = freshMargin(500_000);

    expect(() => applyDeposit(margin, -600_000)).toThrow(TellerError);
  });

  it('recomputes derived fields after deposit', () => {
    const margin = freshMargin(1_000_000);
    const result = applyDeposit(margin, 500_000);

    expect(result.marginBalance).toBe(result.walletBalance + result.unrealisedPnl);
    expect(result.availableMargin).toBe(result.marginBalance - result.initMargin);
  });

  it('does not mutate the input margin', () => {
    const margin = freshMargin(1_000_000);
    applyDeposit(margin, 500_000);

    expect(margin.walletBalance).toBe(1_000_000);
  });
});

// ── applyUnrealisedUpdate ─────────────────────────────────────────────────────

describe('applyUnrealisedUpdate', () => {
  it('sums unrealisedPnl across all positions', () => {
    const margin = freshMargin();
    const positions = new Map<string, PositionDoc>([
      ['XBTUSD', pos(0, 10_000)],
      ['ETHUSD', pos(0, 20_000)],
    ]);

    const result = applyUnrealisedUpdate(margin, positions);

    expect(result.unrealisedPnl).toBe(30_000);
  });

  it('sets unrealisedPnl to 0 for an empty positions map', () => {
    const margin = { ...freshMargin(), unrealisedPnl: 5_000 };
    const result = applyUnrealisedUpdate(margin, new Map());

    expect(result.unrealisedPnl).toBe(0);
  });

  it('recomputes marginBalance after update', () => {
    const margin = freshMargin(1_000_000);
    const positions = new Map([['XBTUSD', pos(0, 50_000)]]);
    const result = applyUnrealisedUpdate(margin, positions);

    expect(result.marginBalance).toBe(1_000_000 + 50_000);
  });

  it('does not mutate the input margin', () => {
    const margin = freshMargin();
    applyUnrealisedUpdate(margin, new Map([['XBTUSD', pos(0, 10_000)]]));

    expect(margin.unrealisedPnl).toBe(0);
  });
});
