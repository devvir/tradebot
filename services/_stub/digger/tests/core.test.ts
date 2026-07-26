import { describe, it, expect, beforeEach } from 'vitest';
import * as clock from '../src/core/clock';
import * as snapshot from '../src/core/snapshot';
import type { WsMessage } from '../src/core/types';

beforeEach(() => {
  clock._test_reset();
  snapshot._test_reset();
});

// ── clock ─────────────────────────────────────────────────────────────────────

describe('clock', () => {
  it('starts null and reads back what is set', () => {
    expect(clock.fetch()).toBeNull();
    clock.set(1000);
    expect(clock.fetch()).toBe(1000);
  });

  it('update advances forward-only', () => {
    clock.set(1000);
    clock.update(2000);
    expect(clock.fetch()).toBe(2000);
    clock.update(1500);          // backward → ignored
    expect(clock.fetch()).toBe(2000);
  });

  it('set jumps anywhere (seek)', () => {
    clock.set(5000);
    clock.set(1000);
    expect(clock.fetch()).toBe(1000);
  });
});

// ── snapshot accumulator ───────────────────────────────────────────────────────

const partial = (data: unknown[]): WsMessage => ({
  table: 'instrument', action: 'partial', keys: ['symbol'], types: { symbol: 'symbol' }, filter: {}, data: data as never,
});

describe('snapshot', () => {
  it('is cold until fed a partial', () => {
    expect(snapshot.buildPartial('instrument')).toBeNull();
  });

  it('builds the current-state partial, reflecting updates', () => {
    snapshot.feed(partial([{ symbol: 'XBTUSD', lastPrice: 100 }]));
    snapshot.feed({ table: 'instrument', action: 'update', data: [{ symbol: 'XBTUSD', lastPrice: 200 }] });

    const built = snapshot.buildPartial('instrument');

    expect(built!.action).toBe('partial');
    expect(built!.data).toEqual([{ symbol: 'XBTUSD', lastPrice: 200 }]);
  });

  it('adds chat filterKey', () => {
    snapshot.feed({ table: 'chat', action: 'partial', keys: ['id'], types: { id: 'integer' }, filter: {}, data: [{ id: 1, message: 'hi' }] });

    expect(snapshot.buildPartial('chat')!.filterKey).toBe('channelID');
  });

  it('reset drops all state', () => {
    snapshot.feed(partial([{ symbol: 'XBTUSD', lastPrice: 100 }]));
    snapshot.reset();
    expect(snapshot.buildPartial('instrument')).toBeNull();
  });
});
