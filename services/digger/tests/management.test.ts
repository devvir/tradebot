import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as clock from '../src/core/clock';
import * as snapshot from '../src/core/snapshot';
import { setClock } from '../src/management/seek';
import type { Reader } from '../src/reader';
import type { WsRuntime } from '../src/ws';
import type { WsMessage } from '../src/core/types';

beforeEach(() => {
  clock._test_reset();
  snapshot._test_reset();
});

const instPartial = (data: unknown[]): WsMessage =>
  ({ table: 'instrument', action: 'partial', keys: ['symbol'], types: { symbol: 'symbol' }, filter: {}, data: data as never });

describe('setClock — idempotent seek', () => {
  it('pauses, clears, resets, sets the clock, re-primes, resumes', async () => {
    clock.set(1000);
    snapshot.feed(instPartial([{ symbol: 'XBTUSD', lastPrice: 1 }]));

    const loop   = { paused: false };
    const hub    = { reprime: vi.fn(async () => {}) };
    const reader = { clear: vi.fn() };

    const order: string[] = [];
    reader.clear      = vi.fn(() => order.push('clear'));
    hub.reprime       = vi.fn(async () => { order.push('reprime'); });

    await setClock(5000, { loop, hub } as unknown as WsRuntime, reader as unknown as Reader);

    expect(clock.fetch()).toBe(5000);
    expect(reader.clear).toHaveBeenCalled();
    expect(hub.reprime).toHaveBeenCalled();
    expect(snapshot.buildPartial('instrument')).toBeNull();   // accumulator reset
    expect(loop.paused).toBe(false);                          // resumed
    expect(order).toEqual(['clear', 'reprime']);              // clear before reprime
  });

  it('is a no-op-safe sequence with nothing running', async () => {
    const loop   = { paused: false };
    const hub    = { reprime: vi.fn(async () => {}) };
    const reader = { clear: vi.fn() };

    await setClock(3000, { loop, hub } as unknown as WsRuntime, reader as unknown as Reader);

    expect(clock.fetch()).toBe(3000);
    expect(loop.paused).toBe(false);
  });
});
