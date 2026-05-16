import { describe, it, expect } from 'vitest';
import { createRolling, addTrade, computeMinuteBlock } from '../../../src/distillers/instrument/rolling';

/* ------------------------------------------------------------------ */
/*  Helpers                                                            */
/* ------------------------------------------------------------------ */

const DAY_MS = 86_400_000;

/** Call addTrade with sensible defaults for fields not under test. */
function trade(
  state:     ReturnType<typeof createRolling>,
  ms:        number,
  size:      number,
  price:     number,
  overrides: Partial<{
    grossValue:      number;
    homeNotional:    number;
    foreignNotional: number;
    tickDirection:   string;
  }> = {},
) {
  const grossValue      = overrides.grossValue      ?? Math.round(size / price * 1e8);
  const homeNotional    = overrides.homeNotional    ?? size / price;
  const foreignNotional = overrides.foreignNotional ?? size;
  const tickDirection   = overrides.tickDirection   ?? 'PlusTick';

  return addTrade(state, ms, size, price, grossValue, homeNotional, foreignNotional, tickDirection);
}

/* ------------------------------------------------------------------ */
/*  Tests                                                              */
/* ------------------------------------------------------------------ */

describe('createRolling', () => {
  it('returns empty state', () => {
    const s = createRolling();

    expect(s.window).toEqual([]);
    expect(s.priceHistory).toEqual([]);
    expect(s.totalVolume).toBe(0);
    expect(s.totalTurnover).toBe(0);
    expect(s.volume24h).toBe(0);
    expect(s.turnover24h).toBe(0);
    expect(s.homeNotional24h).toBe(0);
    expect(s.foreignNotional24h).toBe(0);
    expect(s.lastVwap).toBeUndefined();
  });
});

describe('addTrade — trade-event return fields', () => {
  it('returns lastPrice and lastTickDirection', () => {
    const s   = createRolling();
    const res = trade(s, 1000, 10, 100, { tickDirection: 'MinusTick' });

    expect(res.lastPrice).toBe(100);
    expect(res.lastTickDirection).toBe('MinusTick');
  });

  it('does not return 24h-block fields (those belong to the minute cron)', () => {
    const s   = createRolling();
    const res = trade(s, 1000, 10, 100);

    expect(res.volume24h).toBeUndefined();
    expect(res.turnover24h).toBeUndefined();
    expect(res.homeNotional24h).toBeUndefined();
    expect(res.foreignNotional24h).toBeUndefined();
    expect(res.vwap).toBeUndefined();
    expect(res.prevPrice24h).toBeUndefined();
  });
});

describe('addTrade — running state sums', () => {
  it('accumulates totalVolume and totalTurnover on state', () => {
    const s = createRolling();

    trade(s, 1000, 10, 100, { grossValue: 500 });
    trade(s, 2000, 20, 200, { grossValue: 300 });

    expect(s.totalVolume).toBe(30);
    expect(s.totalTurnover).toBe(800);
  });

  it('accumulates 24h running sums on state incrementally', () => {
    const s = createRolling();

    trade(s, 0,    100, 50_000, { grossValue: 200_000, homeNotional: 0.002, foreignNotional: 100 });
    trade(s, 1000, 200, 51_000, { grossValue: 400_000, homeNotional: 0.004, foreignNotional: 200 });

    expect(s.volume24h).toBe(300);
    expect(s.turnover24h).toBe(600_000);
    expect(s.homeNotional24h).toBeCloseTo(0.006);
    expect(s.foreignNotional24h).toBe(300);
  });
});

describe('addTrade — 24h rolling window eviction', () => {
  it('evicts entries older than 24h from the window and subtracts them from running sums', () => {
    const s = createRolling();

    trade(s, 1000, 100, 50_000, { grossValue: 200_000, homeNotional: 0.002, foreignNotional: 100 });

    // New trade at exactly t+24h+1ms — old entry should be evicted
    const newMs = 1000 + DAY_MS + 1;

    trade(s, newMs, 50, 51_000, { grossValue: 100_000, homeNotional: 0.001, foreignNotional: 50 });

    expect(s.window.length).toBe(1);
    expect(s.volume24h).toBe(50);
    expect(s.homeNotional24h).toBeCloseTo(0.001);
    expect(s.foreignNotional24h).toBe(50);
  });

  it('keeps entries exactly at the 24h boundary in the window', () => {
    const s = createRolling();

    trade(s, 1000, 100, 50_000);
    trade(s, 1000 + DAY_MS, 50, 51_000);

    expect(s.window.length).toBe(2);
    expect(s.volume24h).toBe(150);
  });
});

describe('addTrade — lastChangePcnt', () => {
  it('omits lastChangePcnt when no trade precedes 24h ago', () => {
    const s   = createRolling();
    const res = trade(s, 1000, 10, 50_000);

    expect(res.lastChangePcnt).toBeUndefined();
  });

  it('computes lastChangePcnt from the most recent trade price at or before the 24h cutoff', () => {
    const s  = createRolling();
    const t0 = 0;

    trade(s, t0,        10, 100);   // price 100 at t0
    trade(s, t0 + 1000, 10, 110);   // price 110 at t0+1s

    const newMs = t0 + DAY_MS + 2000;  // cutoff = t0+2000 → t0+1s is before
    const res   = trade(s, newMs, 10, 120);

    expect(res.lastChangePcnt).toBeCloseTo((120 - 110) / 110);
  });

  it('uses older price when only one trade precedes the cutoff', () => {
    const s  = createRolling();
    const t0 = 0;

    trade(s, t0, 10, 100);

    const newMs = t0 + DAY_MS + 500;
    const res   = trade(s, newMs, 10, 150);

    expect(res.lastChangePcnt).toBeCloseTo(0.5);
  });
});

describe('computeMinuteBlock', () => {
  it('returns the 24h stats block using running sums', () => {
    const s = createRolling();

    trade(s, 0,    100, 50_000, { grossValue: 200_000, homeNotional: 0.002, foreignNotional: 100 });
    trade(s, 1000, 200, 51_000, { grossValue: 400_000, homeNotional: 0.004, foreignNotional: 200 });

    const block = computeMinuteBlock(s, 15_000);

    expect(block.volume24h).toBe(300);
    expect(block.turnover24h).toBe(600_000);
    expect(block.homeNotional24h).toBeCloseTo(0.006);
    expect(block.foreignNotional24h).toBe(300);
  });

  it('computes vwap as foreignNotional24h / homeNotional24h', () => {
    const s = createRolling();

    trade(s, 1000, 100, 50_000, { homeNotional: 0.002, foreignNotional: 100 });
    trade(s, 2000, 150, 50_000, { homeNotional: 0.003, foreignNotional: 150 });

    const block = computeMinuteBlock(s, 15_000);

    expect(block.vwap).toBeCloseTo(250 / 0.005);
  });

  it('omits vwap when it has not changed since the previous emission', () => {
    const s = createRolling();

    trade(s, 1000, 100, 50_000, { homeNotional: 0.002, foreignNotional: 100 });

    const first  = computeMinuteBlock(s, 15_000);
    const second = computeMinuteBlock(s, 75_000);

    expect(first.vwap).toBeDefined();
    expect(second.vwap).toBeUndefined();
  });

  it('omits vwap when homeNotional24h is zero', () => {
    const s = createRolling();

    trade(s, 1000, 100, 50_000, { homeNotional: 0, foreignNotional: 100 });

    const block = computeMinuteBlock(s, 15_000);

    expect(block.vwap).toBeUndefined();
  });

  it('includes prevPrice24h when a trade exists at or before the cutoff', () => {
    const s  = createRolling();
    const t0 = 0;

    trade(s, t0,        10, 100);
    trade(s, t0 + 1000, 10, 110);

    const block = computeMinuteBlock(s, t0 + DAY_MS + 2000);

    expect(block.prevPrice24h).toBe(110);
  });

  it('omits prevPrice24h when no trade precedes the cutoff', () => {
    const s = createRolling();

    trade(s, 1000, 10, 50_000);

    const block = computeMinuteBlock(s, 15_000);

    expect(block.prevPrice24h).toBeUndefined();
  });

  it('evicts stale window entries even when called with no new trades', () => {
    const s = createRolling();

    trade(s, 1000, 100, 50_000, { grossValue: 200_000, homeNotional: 0.002, foreignNotional: 100 });

    const block = computeMinuteBlock(s, 1000 + DAY_MS + 1);

    expect(s.window.length).toBe(0);
    expect(block.volume24h).toBe(0);
    expect(block.turnover24h).toBe(0);
  });
});
