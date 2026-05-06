import { describe, it, expect } from 'vitest';
import { initAccount } from '../src/accounts/index';

const TS = '2024-01-01T00:00:00.000Z';

describe('initAccount', () => {
  it('sets walletBalance and marginBalance to the initial satoshis', () => {
    const state = initAccount('acc1', 1_000_000, TS);

    expect(state.margin.walletBalance).toBe(1_000_000);
    expect(state.margin.marginBalance).toBe(1_000_000);
  });

  it('sets availableMargin equal to walletBalance on a fresh account', () => {
    const state = initAccount('acc1', 500_000, TS);

    expect(state.margin.availableMargin).toBe(500_000);
  });

  it('zeros all PnL and margin fields', () => {
    const state = initAccount('acc1', 1_000_000, TS);
    const m = state.margin;

    expect(m.realisedPnl).toBe(0);
    expect(m.unrealisedPnl).toBe(0);
    expect(m.initMargin).toBe(0);
    expect(m.maintMargin).toBe(0);
  });

  it('sets currency to XBt', () => {
    const state = initAccount('acc1', 1_000_000, TS);

    expect(state.margin.currency).toBe('XBt');
  });

  it('sets timestamp from argument', () => {
    const state = initAccount('acc1', 1_000_000, TS);

    expect(state.margin.timestamp).toBe(TS);
  });

  it('starts with empty positions and orders maps', () => {
    const state = initAccount('acc1', 1_000_000, TS);

    expect(state.positions.size).toBe(0);
    expect(state.orders.size).toBe(0);
  });

  it('stores the accountId in the margin doc', () => {
    const state = initAccount('my-account', 1_000_000, TS);

    expect(state.margin.accountId).toBe('my-account');
  });
});
