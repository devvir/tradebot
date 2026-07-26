import { describe, it, expect, beforeEach } from 'vitest';
import * as clock from '../src/core/clock';
import * as snapshot from '../src/core/snapshot';
import { Reader } from '../src/reader';
import type { Provider } from '../src/provider';
import type { StreamPage, PartialResult } from '../src/provider/types';
import type { Config } from '../src/types';
import type { WsMessage, StreamItem } from '../src/core/types';
import type { BitmexTable } from '@tradebot/types';

const cfg = { batchSize: 1000, lowWatermark: 5000 } as unknown as Config;

const makeProvider = (opts: {
  partials?: Record<string, PartialResult>;
  streams?:  Record<string, StreamPage[]>;
}): Provider => {
  const streams = opts.streams ?? {};

  return {
    async partial(t: string): Promise<PartialResult> { return opts.partials?.[t] ?? { partial: null, cursor: null }; },
    async stream(t: string): Promise<StreamPage> { return (streams[t] ?? []).shift() ?? { messages: [], cursor: null, exhausted: true }; },
    async records(): Promise<unknown[]> { return []; },
  } as unknown as Provider;
};

const item = (table: BitmexTable, ts: number): StreamItem =>
  ({ ts, msg: { table, action: 'insert', data: [{ symbol: 'XBTUSD' }] } });

const instPartial = (data: unknown[]): WsMessage =>
  ({ table: 'instrument', action: 'partial', keys: ['symbol'], types: { symbol: 'symbol' }, filter: {}, data: data as never });

beforeEach(() => {
  clock._test_reset();
  snapshot._test_reset();
});

// ── flat cold activate (staging) ──────────────────────────────────────────────

describe('Reader — flat activation', () => {
  it('returns the provider partial; buffer is invisible until promote', async () => {
    clock.set(1000);
    const staticP: WsMessage = { table: 'trade', action: 'partial', keys: [], types: {}, filter: {}, data: [] };

    const reader = new Reader(makeProvider({
      partials: { trade: { partial: staticP, cursor: 50 } },
      streams:  { trade: [{ messages: [item('trade', 1000), item('trade', 1001)], cursor: 60, exhausted: true }] },
    }), cfg);

    const partial = await reader.activate('trade', 1000);

    // partial comes from the accumulator (created by feeding the provider's
    // partial); empty here since the priming cursor starts at the clock.
    expect(partial!.action).toBe('partial');
    expect(partial!.data).toEqual([]);
    expect(reader.next()).toBeNull();        // staged, not live yet

    reader.promote('trade');

    expect(reader.next()!.ts).toBe(1000);
    expect(reader.next()!.ts).toBe(1001);
    expect(reader.next()).toBeNull();
  });
});

// ── message cold activate (fold + catch-up) ───────────────────────────────────

describe('Reader — message activation', () => {
  it('folds the stored partial + pre-clock deltas, buffers only ts >= clock', async () => {
    clock.set(1000);

    const reader = new Reader(makeProvider({
      partials: { instrument: { partial: instPartial([{ symbol: 'XBTUSD', lastPrice: 50 }]), cursor: 10 } },
      streams:  { instrument: [{
        messages: [
          { ts: 900,  msg: { table: 'instrument', action: 'update', data: [{ symbol: 'XBTUSD', lastPrice: 60 }] } },
          { ts: 1000, msg: { table: 'instrument', action: 'update', data: [{ symbol: 'XBTUSD', lastPrice: 70 }] } },
          { ts: 1001, msg: { table: 'instrument', action: 'update', data: [{ symbol: 'XBTUSD', lastPrice: 80 }] } },
        ],
        cursor: 20, exhausted: false,
      }] },
    }), cfg);

    const built = await reader.activate('instrument', 1000);

    // partial(50) + the ts=900 update folded → snapshot at the clock is lastPrice 60
    expect(built!.data).toEqual([{ symbol: 'XBTUSD', lastPrice: 60 }]);

    reader.promote('instrument');

    expect(reader.next()!.ts).toBe(1000);    // only the ts >= clock deltas are emitted
    expect(reader.next()!.ts).toBe(1001);
    expect(reader.next()).toBeNull();
  });
});

// ── order books (empty) ───────────────────────────────────────────────────────

describe('Reader — order books', () => {
  it('activates empty with no stream', async () => {
    clock.set(1000);
    const empty: WsMessage = { table: 'orderBook10', action: 'partial', keys: ['symbol'], types: {}, filter: {}, data: [] };

    const reader = new Reader(makeProvider({ partials: { orderBook10: { partial: empty, cursor: null } } }), cfg);

    const partial = await reader.activate('orderBook10', 1000);

    expect(partial!.action).toBe('partial');
    expect(partial!.data).toEqual([]);
    reader.promote('orderBook10');
    expect(reader.next()).toBeNull();
  });
});

// ── merge + lifecycle ─────────────────────────────────────────────────────────

describe('Reader — merge & lifecycle', () => {
  const twoTables = () => makeProvider({
    partials: { trade: { partial: null, cursor: 1 }, quote: { partial: null, cursor: 1 } },
    streams:  {
      trade: [{ messages: [item('trade', 1005)], cursor: 2, exhausted: true }],
      quote: [{ messages: [item('quote', 1002)], cursor: 2, exhausted: true }],
    },
  });

  it('picks the globally smallest timestamp across buffers', async () => {
    clock.set(1000);
    const reader = new Reader(twoTables(), cfg);

    await reader.activate('trade', 1000); reader.promote('trade');
    await reader.activate('quote', 1000); reader.promote('quote');

    expect(reader.next()!.msg.table).toBe('quote');   // ts 1002
    expect(reader.next()!.msg.table).toBe('trade');   // ts 1005
    expect(reader.next()).toBeNull();
  });

  it('deactivate drops the buffer', async () => {
    clock.set(1000);
    const reader = new Reader(twoTables(), cfg);

    await reader.activate('trade', 1000); reader.promote('trade');
    reader.deactivate('trade');

    expect(reader.anyActive()).toBe(false);
    expect(reader.next()).toBeNull();
  });
});
